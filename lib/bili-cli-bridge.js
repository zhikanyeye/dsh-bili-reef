// bili-cli-bridge.js
// Node.js → Python 子进程封装层（融合 bili-cli 全部运营能力到 dsh-bili-whale）
//
// 职责:
//   1. 检测 Python 环境与 bili-cli 安装状态
//   2. 执行 `bili <命令>` 并解析 JSON 输出（`bili` 在 PATH 优先，`python -m bili_cli.main` 兜底）
//   3. 错误映射与降级提示
//   4. 语义化方法：把 bili-cli 的 109 个命令封装成可调用方法
//   5. 流式执行（dm watch 等长任务）
//
// 设计原则:
//   - 非侵入式: bili-cli 作为独立 Python 包安装，不改动 whale 现有逻辑
//   - 优雅降级: Python 调用失败时返回 fallback 提示，不抛出阻塞流程
//   - 统一限流: 写操作优先走 whale 的 quota-gate，Python 层限流仅作补充
//   - 与现有限流器 (quota-gate.mjs) 协调

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// bili-cli 模块入口（无 __main__.py，需显式 -m bili_cli.main）
const MODULE_ENTRY = ['-m', 'bili_cli.main']

/**
 * 文件后备执行（复用 capture.mjs 的模式）
 * Windows 沙箱禁止匿名管道，必须用文件承载 stdout/stderr
 */
function execFileSyncSafe(file, args = [], options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-bridge-'))
  const out = path.join(dir, 'stdout'), err = path.join(dir, 'stderr')
  const fds = []
  try {
    fds.push(fs.openSync(out, 'wx', 0o600), fs.openSync(err, 'wx', 0o600))
    const result = spawnSync(file, args, {
      ...options,
      timeout: options.timeout ?? 120000,
      windowsHide: true,
      stdio: ['ignore', ...fds]
    })
    for (const fd of fds.splice(0)) fs.closeSync(fd)
    const stdout = fs.readFileSync(out), stderr = fs.readFileSync(err)
    if (result.error || result.status !== 0) {
      const e = result.error ?? new Error(`子进程失败 (${result.status}): ${stderr.toString('utf8').slice(0, 1000)}`)
      Object.assign(e, { status: result.status, stdout, stderr })
      throw e
    }
    return options.encoding ? stdout.toString(options.encoding) : stdout
  } finally {
    for (const fd of fds) fs.closeSync(fd)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * bili-cli 桥接器配置
 * @typedef {Object} BridgeConfig
 * @property {string} [pythonPath] - Python 可执行文件路径，默认 'python' / 'python3'
 * @property {string} [biliCliPath] - bili 命令路径，默认 'bili'
 * @property {boolean} [preferSystemBili] - 优先使用系统 PATH 中的 bili，默认 true
 */

/**
 * bili-cli 执行结果
 * @typedef {Object} BridgeResult
 * @property {boolean} ok - 是否成功
 * @property {any} [data] - 成功时的数据
 * @property {Object} [error] - 失败时的错误信息
 * @property {string} error.code - 错误码 (见 bili-cli errors.py)
 * @property {string} error.message - 错误消息
 * @property {string} [error.hint] - 给 agent 的提示
 * @property {Object} [error.detail] - 额外详情
 * @property {boolean} [fallback] - 是否触发了降级
 */

/**
 * bili-cli 桥接器
 */
export class BiliCliBridge {
  /**
   * @param {BridgeConfig} [config]
   */
  constructor(config = {}) {
    this.pythonPath = config.pythonPath || this._detectPython()
    this.biliCliPath = config.biliCliPath || 'bili'
    this.preferSystemBili = config.preferSystemBili !== false
    this._availabilityCache = null
    this._availabilityCacheTime = 0
    this.CACHE_TTL = 300000 // 5 分钟
    // 简单结果缓存（可选，按需开启）
    this._cache = new Map()
    this._cacheEnabled = config.cache?.enabled !== false
    this._cacheTTL = config.cache?.ttl ?? 300000
  }

  /**
   * 检测系统可用的 Python 解释器
   * @returns {string}
   */
  _detectPython() {
    if (process.platform === 'win32') {
      return 'python'
    }
    return 'python3'
  }

  /**
   * 检测 bili-cli 是否可用
   * @returns {Promise<{available: boolean, version?: string, pythonPath?: string, biliPath?: string, error?: string, hint?: string}>}
   */
  async checkAvailability() {
    const now = Date.now()
    if (this._availabilityCache && (now - this._availabilityCacheTime) < this.CACHE_TTL) {
      return this._availabilityCache
    }

    const result = { available: false }

    try {
      // 1. 先尝试直接调用 bili (PATH 中) —— 已验证 Windows 下命中系统安装
      if (this.preferSystemBili) {
        const direct = this._tryBiliVersion(this.biliCliPath)
        if (direct.ok) {
          result.available = true
          result.version = direct.version
          result.pythonPath = 'system'
          result.biliPath = this.biliCliPath
          this._availabilityCache = result
          this._availabilityCacheTime = now
          return result
        }
      }

      // 2. 尝试通过 python -m bili_cli.main
      const moduleCheck = this._tryPythonModule()
      if (moduleCheck.ok) {
        result.available = true
        result.version = moduleCheck.version
        result.pythonPath = this.pythonPath
        result.biliPath = 'python-module'
        this._availabilityCache = result
        this._availabilityCacheTime = now
        return result
      }

      // 3. 尝试 pip show bili-agent
      const pipCheck = this._tryPipShow()
      if (pipCheck.ok) {
        result.available = false
        result.error = 'bili-cli 已安装但命令不可用，请检查 PATH 或重新安装'
        result.hint = '运行: pip install --upgrade bili-agent'
      } else {
        result.error = 'bili-cli 未安装'
        result.hint = '运行: pip install bili-agent'
      }
    } catch (e) {
      result.error = `检测失败: ${e.message}`
    }

    // 失败不缓存：让下次调用重试（避免一次冷启动超时污染 5 分钟）✓
    return result
  }

  /**
   * 尝试直接调用 bili --version（带重试，避免 Python 冷启动超时误判）
   * @param {string} cmd
   * @returns {{ok: boolean, version?: string}}
   */
  _tryBiliVersion(cmd) {
    // Python 冷启动（加载 bilibili-api 等）在 Windows 下偶发 >10s，重试一次 + 30s 超时
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const stdout = execFileSyncSafe(cmd, ['--version'], {
          encoding: 'utf8',
          timeout: 30000
        })
        if (stdout) {
          try {
            const parsed = JSON.parse(stdout.trim())
            if (parsed.ok && parsed.data?.version) {
              return { ok: true, version: parsed.data.version }
            }
          } catch {
            const match = stdout.match(/(\d+\.\d+\.\d+)/)
            if (match) return { ok: true, version: match[1] }
          }
        }
      } catch {}
    }
    return { ok: false }
  }

  /**
   * 尝试通过 python -m bili_cli.main --version（带重试）
   * @returns {{ok: boolean, version?: string}}
   */
  _tryPythonModule() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const stdout = execFileSyncSafe(this.pythonPath, [...MODULE_ENTRY, '--version'], {
          encoding: 'utf8',
          timeout: 30000
        })
        if (stdout) {
          try {
            const parsed = JSON.parse(stdout.trim())
            if (parsed.ok && parsed.data?.version) {
              return { ok: true, version: parsed.data.version }
            }
          } catch {}
        }
      } catch {}
    }
    return { ok: false }
  }

  /**
   * 尝试 pip show bili-agent
   * @returns {{ok: boolean}}
   */
  _tryPipShow() {
    try {
      const stdout = execFileSyncSafe(this.pythonPath, ['-m', 'pip', 'show', 'bili-agent'], {
        encoding: 'utf8',
        timeout: 10000
      })
      return { ok: stdout.length > 0 }
    } catch {
      return { ok: false }
    }
  }

  /**
   * 构建 bili 命令行参数
   * @param {string} command - 命令路径，如 'video watch' / 'comment post'
   * @param {Object} args - 参数对象
   * @returns {string[]}
   */
  _buildArgs(command, args = {}) {
    const parts = command.trim().split(/\s+/)
    const argv = [...parts]

    // 位置参数优先（如 BV 号、评论 ID）
    if (args._positional && args._positional.length) {
      argv.push(...args._positional.map(String))
    }

    for (const [k, v] of Object.entries(args)) {
      if (k === '_positional') continue
      if (v === undefined || v === null) continue

      const flag = k.length === 1 ? `-${k}` : `--${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}`

      if (typeof v === 'boolean') {
        if (v) argv.push(flag)
      } else if (Array.isArray(v)) {
        for (const item of v) {
          argv.push(flag, String(item))
        }
      } else {
        argv.push(flag, String(v))
      }
    }

    return argv
  }

  /**
   * 解析 bili-cli 输出（一个 JSON）
   * @param {string|Buffer} stdout
   * @returns {BridgeResult}
   */
  _parseOutput(stdout) {
    const text = stdout.toString('utf8')
    if (!text || !text.trim()) {
      return { ok: false, error: { code: 'empty_output', message: 'bili-cli 无输出' } }
    }
    let parsed
    try {
      parsed = JSON.parse(text.trim())
    } catch {
      return {
        ok: false,
        error: {
          code: 'invalid_json',
          message: 'bili-cli 输出不是有效 JSON',
          detail: { stdout: text.trim().slice(0, 500) }
        }
      }
    }
    if (parsed.ok === true) {
      return { ok: true, data: parsed.data }
    } else if (parsed.ok === false) {
      return { ok: false, error: parsed.error }
    } else {
      return { ok: true, data: parsed }
    }
  }

  /**
   * 执行 bili 命令
   * @param {string} command - 命令路径，如 'video watch'
   * @param {Object} [args] - 参数对象
   * @param {Object} [options]
   * @param {boolean} [options.dryRun] - 只返回将要执行的命令，不真正运行
   * @param {Function} [options.fallback] - 失败时的降级函数
   * @param {number} [options.timeout] - 超时毫秒，默认 120000
   * @param {boolean} [options.cache] - 命中缓存（默认按构造配置）
   * @returns {Promise<BridgeResult>}
   */
  async execute(command, args = {}, options = {}) {
    // 1. 缓存命中（只读命令默认缓存，写操作不缓存）
    const cacheKey = `${command}:${JSON.stringify(args)}`
    const useCache = options.cache !== undefined ? options.cache : (this._cacheEnabled && this._isReadOnly(command))
    if (useCache && this._cache.has(cacheKey)) {
      const c = this._cache.get(cacheKey)
      if (Date.now() - c.timestamp < this._cacheTTL) return c.result
    }

    // 2. 检测可用性
    const avail = await this.checkAvailability()
    if (!avail.available) {
      if (options.fallback) {
        try {
          const fb = await options.fallback()
          return { ...fb, fallback: true, reason: avail.error }
        } catch (e) {
          return {
            ok: false,
            error: { code: 'bridge_unavailable', message: avail.error },
            fallback: true
          }
        }
      }
      return {
        ok: false,
        error: { code: 'bridge_unavailable', message: avail.error, hint: avail.hint }
      }
    }

    // 3. 构建命令行
    const argv = this._buildArgs(command, args)

    if (options.dryRun) {
      return {
        ok: true,
        data: { dryRun: true, command: this.biliCliPath, args: argv }
      }
    }

    // 4. 执行子进程
    let cmd, cmdArgs
    if (avail.biliPath === 'system' || avail.biliPath === this.biliCliPath) {
      cmd = this.biliCliPath
      cmdArgs = argv
    } else {
      cmd = this.pythonPath
      cmdArgs = [...MODULE_ENTRY, ...argv]
    }

    try {
      const stdout = execFileSyncSafe(cmd, cmdArgs, {
        encoding: 'utf8',
        timeout: options.timeout || 120000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      })

      // 5. 解析并返回
      const result = this._parseOutput(stdout)
      if (useCache) {
        this._cache.set(cacheKey, { result, timestamp: Date.now() })
      }
      return result
    } catch (e) {
      if (options.fallback) {
        try {
          const fb = await options.fallback()
          return { ...fb, fallback: true, reason: e.message }
        } catch {}
      }
      return {
        ok: false,
        error: { code: 'execute_error', message: e.message }
      }
    }
  }

  /**
   * 流式执行（用于 dm watch 等长任务）
   * 使用 spawn 逐行读取 stdout，每行一个 JSON，yield 出去
   * @param {string} command
   * @param {Object} [args]
   * @param {Object} [options]
   * @param {number} [options.timeout] - 单次超时（0 = 无限）
   * @param {AbortSignal} [options.signal] - 终止信号
   * @returns {AsyncGenerator<BridgeResult>}
   */
  async *executeStream(command, args = {}, options = {}) {
    const avail = await this.checkAvailability()
    if (!avail.available) {
      yield {
        ok: false,
        error: { code: 'bridge_unavailable', message: avail.error, hint: avail.hint }
      }
      return
    }

    const argv = this._buildArgs(command, args)
    let cmd, cmdArgs
    if (avail.biliPath === 'system' || avail.biliPath === this.biliCliPath) {
      cmd = this.biliCliPath
      cmdArgs = argv
    } else {
      cmd = this.pythonPath
      cmdArgs = [...MODULE_ENTRY, ...argv]
    }

    // 文件后备（Windows 沙箱），逐行读
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-stream-'))
    const outPath = path.join(dir, 'stdout')
    const errPath = path.join(dir, 'stderr')
    const outFd = fs.openSync(outPath, 'wx', 0o600)
    const errFd = fs.openSync(errPath, 'wx', 0o600)

    const child = spawn(cmd, cmdArgs, {
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout: options.timeout || 0
    })
    fs.closeSync(outFd)
    fs.closeSync(errFd)

    let buffer = ''
    try {
      // 逐行读取 stdout 文件（轮询）
      const readLoop = async () => {
        while (true) {
          const fd = fs.openSync(outPath, 'r')
          try {
            const chunk = fs.readFileSync(fd, 'utf8')
            if (chunk && chunk !== buffer) {
              buffer = chunk
            }
          } finally {
            fs.closeSync(fd)
          }
          await new Promise(r => setTimeout(r, 200))
        }
      }

      // 这里简化：一次性读完所有行（bili dm watch --max-events 1 可一次退出）
      // 真正的增量流式读取由调用方决定；先按"读全部后按行切分"实现
      await new Promise(resolve => {
        child.on('close', resolve)
        child.on('error', resolve)
        if (options.signal) options.signal.addEventListener('abort', () => child.kill())
      })

      const stdout = fs.readFileSync(outPath, 'utf8')
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        yield this._parseOutput(line)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  /**
   * 判断命令是否只读（用于缓存）
   * @param {string} command
   * @returns {boolean}
   */
  _isReadOnly(command) {
    return /^(schema|auth status|auth login|video watch|video info|video subtitle|video summary|video danmaku|video frames|video relation|video stats|comment list|comment replies|comment emotes|comment check|comment images|dm list|dm read|dynamic list|dynamic show|upload list|upload stats|upload status|upload zones|upload chapters show|me stats|me show|me favs|data overview|data trend|data audience|data fans|data videos|data video|data diagnose|user info|user videos|user following|user blocked|feed inbox|feed replies|feed mentions|feed notifications|feed system|feed likes|feed recommend|feed timeline|hot popular|hot precious|hot rank|hot search|hot weekly|search video|search user|season list|asr status|skills show|skills status|owner show)/.test(command)
  }

  /**
   * 清除可用性缓存和结果缓存（测试用）
   */
  clearCache() {
    this._availabilityCache = null
    this._availabilityCacheTime = 0
    this._cache.clear()
  }

  // ──────────────────────────────────────────────────────────────
  // 语义化方法：bili-cli 109 命令的友好封装
  // ──────────────────────────────────────────────────────────────

  // —— 认证 ——
  /** @returns {Promise<BridgeResult>} */
  authStatus(args = {}, options = {}) { return this.execute('auth status', args, options) }
  /** @returns {Promise<BridgeResult>} */
  authLogin(args = {}, options = {}) { return this.execute('auth login', args, options) }
  /** @returns {Promise<BridgeResult>} */
  authLogout(args = {}, options = {}) { return this.execute('auth logout', args, options) }

  // —— 观看 ——
  /** @returns {Promise<BridgeResult>} */
  videoWatch(videoId, args = {}, options = {}) { return this.execute('video watch', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoInfo(videoId, args = {}, options = {}) { return this.execute('video info', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoSubtitle(videoId, args = {}, options = {}) { return this.execute('video subtitle', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoSummary(videoId, args = {}, options = {}) { return this.execute('video summary', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoDanmaku(videoId, args = {}, options = {}) { return this.execute('video danmaku', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoFrames(videoId, args = {}, options = {}) { return this.execute('video frames', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoTranscribe(videoId, args = {}, options = {}) { return this.execute('video transcribe', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoLike(videoId, args = {}, options = {}) { return this.execute('video like', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoFav(videoId, args = {}, options = {}) { return this.execute('video fav', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoCoin(videoId, args = {}, options = {}) { return this.execute('video coin', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoTriple(videoId, args = {}, options = {}) { return this.execute('video triple', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoRelation(videoId, args = {}, options = {}) { return this.execute('video relation', { _positional: [videoId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  videoChapters(videoId, args = {}, options = {}) { return this.execute('video chapters', { _positional: [videoId], ...args }, options) }

  // —— 评论 ——
  /** @returns {Promise<BridgeResult>} */
  commentPost(target, text, args = {}, options = {}) {
    const pos = []
    if (target !== undefined && target !== null && target !== '') pos.push(String(target))
    if (text !== undefined && text !== null && text !== '') pos.push(String(text))
    return this.execute('comment post', { _positional: pos, ...args }, options)
  }
  /** @returns {Promise<BridgeResult>} */
  commentList(target, args = {}, options = {}) { return this.execute('comment list', { _positional: [target], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  commentReplies(target, args = {}, options = {}) { return this.execute('comment replies', { _positional: [target], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  commentReply(target, args = {}, options = {}) { return this.execute('comment reply', { _positional: [target], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  commentDelete(target, args = {}, options = {}) { return this.execute('comment delete', { _positional: [target], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  commentPin(target, args = {}, options = {}) { return this.execute('comment pin', { _positional: [target], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  commentCheck(target, args = {}, options = {}) { return this.execute('comment check', { _positional: [target], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  commentEmotes(args = {}, options = {}) { return this.execute('comment emotes', args, options) }
  /** @returns {Promise<BridgeResult>} */
  commentImages(args = {}, options = {}) { return this.execute('comment images', args, options) }
  /** @returns {Promise<BridgeResult>} */
  commentLike(target, args = {}, options = {}) { return this.execute('comment like', { _positional: [target], ...args }, options) }

  // —— 私信 ——
  /** @returns {Promise<BridgeResult>} */
  dmSend(uid, text, args = {}, options = {}) {
    const pos = []
    if (uid !== undefined && uid !== null && uid !== '') pos.push(String(uid))
    if (text !== undefined && text !== null && text !== '') pos.push(String(text))
    return this.execute('dm send', { _positional: pos, ...args }, options)
  }
  /** @returns {Promise<BridgeResult>} */
  dmList(args = {}, options = {}) { return this.execute('dm list', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dmRead(uid, args = {}, options = {}) { return this.execute('dm read', { _positional: [uid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  dmWatch(args = {}, options = {}) { return this.executeStream('dm watch', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dmAutoreplyShow(args = {}, options = {}) { return this.execute('dm autoreply show', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dmAutoreplyOn(args = {}, options = {}) { return this.execute('dm autoreply on', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dmAutoreplyOff(args = {}, options = {}) { return this.execute('dm autoreply off', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dmAutoreplySet(args = {}, options = {}) { return this.execute('dm autoreply set', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dmAutoreplyShowAll(args = {}, options = {}) { return this.execute('dm autoreply show', args, options) }

  // —— 动态 ——
  /** @returns {Promise<BridgeResult>} */
  dynamicPost(text, args = {}, options = {}) {
    const pos = []
    if (text !== undefined && text !== null && text !== '') pos.push(String(text))
    return this.execute('dynamic post', { _positional: pos, ...args }, options)
  }
  /** @returns {Promise<BridgeResult>} */
  dynamicList(args = {}, options = {}) { return this.execute('dynamic list', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dynamicDelete(args = {}, options = {}) { return this.execute('dynamic delete', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dynamicShow(args = {}, options = {}) { return this.execute('dynamic show', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dynamicVote(args = {}, options = {}) { return this.execute('dynamic vote', args, options) }

  // —— 投稿 ——
  /** @returns {Promise<BridgeResult>} */
  uploadVideo(video, args = {}, options = {}) { return this.execute('upload video', { _positional: [video], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  uploadEdit(bvid, args = {}, options = {}) { return this.execute('upload edit', { _positional: [bvid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  uploadStats(bvid, args = {}, options = {}) { return this.execute('upload stats', { _positional: [bvid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  uploadList(args = {}, options = {}) { return this.execute('upload list', args, options) }
  /** @returns {Promise<BridgeResult>} */
  uploadStatus(bvid, args = {}, options = {}) { return this.execute('upload status', { _positional: [bvid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  uploadZones(args = {}, options = {}) { return this.execute('upload zones', args, options) }
  /** @returns {Promise<BridgeResult>} */
  uploadChaptersSet(bvid, args = {}, options = {}) { return this.execute('upload chapters set', { _positional: [bvid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  uploadChaptersShow(bvid, args = {}, options = {}) { return this.execute('upload chapters show', { _positional: [bvid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  uploadChaptersClear(bvid, args = {}, options = {}) { return this.execute('upload chapters clear', { _positional: [bvid], ...args }, options) }

  // —— 账号/数据 ——
  /** @returns {Promise<BridgeResult>} */
  meShow(args = {}, options = {}) { return this.execute('me show', args, options) }
  /** @returns {Promise<BridgeResult>} */
  meStats(args = {}, options = {}) { return this.execute('me stats', args, options) }
  /** @returns {Promise<BridgeResult>} */
  meFavs(args = {}, options = {}) { return this.execute('me favs', args, options) }
  /** @returns {Promise<BridgeResult>} */
  meSetName(args = {}, options = {}) { return this.execute('me set-name', args, options) }
  /** @returns {Promise<BridgeResult>} */
  meSetSign(args = {}, options = {}) { return this.execute('me set-sign', args, options) }
  /** @returns {Promise<BridgeResult>} */
  meSetAvatar(args = {}, options = {}) { return this.execute('me set-avatar', args, options) }

  // —— 数据中心 ——
  /** @returns {Promise<BridgeResult>} */
  dataOverview(args = {}, options = {}) { return this.execute('data overview', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dataTrend(args = {}, options = {}) { return this.execute('data trend', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dataAudience(args = {}, options = {}) { return this.execute('data audience', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dataFans(args = {}, options = {}) { return this.execute('data fans', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dataVideos(args = {}, options = {}) { return this.execute('data videos', args, options) }
  /** @returns {Promise<BridgeResult>} */
  dataVideo(bvid, args = {}, options = {}) { return this.execute('data video', { _positional: [bvid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  dataDiagnose(bvid, args = {}, options = {}) { return this.execute('data diagnose', { _positional: [bvid], ...args }, options) }

  // —— 用户/关注 ——
  /** @returns {Promise<BridgeResult>} */
  userInfo(uid, args = {}, options = {}) { return this.execute('user info', { _positional: [uid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  userVideos(uid, args = {}, options = {}) { return this.execute('user videos', { _positional: [uid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  userFollow(uid, args = {}, options = {}) { return this.execute('user follow', { _positional: [uid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  userUnfollow(uid, args = {}, options = {}) { return this.execute('user unfollow', { _positional: [uid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  userBlock(uid, args = {}, options = {}) { return this.execute('user block', { _positional: [uid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  userUnblock(uid, args = {}, options = {}) { return this.execute('user unblock', { _positional: [uid], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  userFollowing(args = {}, options = {}) { return this.execute('user following', args, options) }
  /** @returns {Promise<BridgeResult>} */
  userBlocked(args = {}, options = {}) { return this.execute('user blocked', args, options) }

  // —— 动态流/推荐/热搜 ——
  /** @returns {Promise<BridgeResult>} */
  feedInbox(args = {}, options = {}) { return this.execute('feed inbox', args, options) }
  /** @returns {Promise<BridgeResult>} */
  feedReplies(args = {}, options = {}) { return this.execute('feed replies', args, options) }
  /** @returns {Promise<BridgeResult>} */
  feedMentions(args = {}, options = {}) { return this.execute('feed mentions', args, options) }
  /** @returns {Promise<BridgeResult>} */
  feedNotifications(args = {}, options = {}) { return this.execute('feed notifications', args, options) }
  /** @returns {Promise<BridgeResult>} */
  feedSystem(args = {}, options = {}) { return this.execute('feed system', args, options) }
  /** @returns {Promise<BridgeResult>} */
  feedLikes(args = {}, options = {}) { return this.execute('feed likes', args, options) }
  /** @returns {Promise<BridgeResult>} */
  feedRecommend(args = {}, options = {}) { return this.execute('feed recommend', args, options) }
  /** @returns {Promise<BridgeResult>} */
  feedTimeline(args = {}, options = {}) { return this.execute('feed timeline', args, options) }
  /** @returns {Promise<BridgeResult>} */
  hotPopular(args = {}, options = {}) { return this.execute('hot popular', args, options) }
  /** @returns {Promise<BridgeResult>} */
  hotPrecious(args = {}, options = {}) { return this.execute('hot precious', args, options) }
  /** @returns {Promise<BridgeResult>} */
  hotRank(args = {}, options = {}) { return this.execute('hot rank', args, options) }
  /** @returns {Promise<BridgeResult>} */
  hotSearch(args = {}, options = {}) { return this.execute('hot search', args, options) }
  /** @returns {Promise<BridgeResult>} */
  hotWeekly(args = {}, options = {}) { return this.execute('hot weekly', args, options) }

  // —— 搜索 ——
  /** @returns {Promise<BridgeResult>} */
  searchVideo(keyword, args = {}, options = {}) { return this.execute('search video', { _positional: [keyword], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  searchUser(keyword, args = {}, options = {}) { return this.execute('search user', { _positional: [keyword], ...args }, options) }

  // —— 合集 ——
  /** @returns {Promise<BridgeResult>} */
  seasonList(args = {}, options = {}) { return this.execute('season list', args, options) }
  /** @returns {Promise<BridgeResult>} */
  seasonCreate(args = {}, options = {}) { return this.execute('season create', args, options) }
  /** @returns {Promise<BridgeResult>} */
  seasonAdd(seasonId, args = {}, options = {}) { return this.execute('season add', { _positional: [seasonId], ...args }, options) }
  /** @returns {Promise<BridgeResult>} */
  seasonRemove(args = {}, options = {}) { return this.execute('season remove', args, options) }
  /** @returns {Promise<BridgeResult>} */
  seasonDelete(seasonId, args = {}, options = {}) { return this.execute('season delete', { _positional: [seasonId], ...args }, options) }

  // —— ASR 转写 ——
  /** @returns {Promise<BridgeResult>} */
  asrStatus(args = {}, options = {}) { return this.execute('asr status', args, options) }
  /** @returns {Promise<BridgeResult>} */
  asrSetupLocal(args = {}, options = {}) { return this.execute('asr setup local', args, options) }
  /** @returns {Promise<BridgeResult>} */
  asrSetupCloud(args = {}, options = {}) { return this.execute('asr setup cloud', args, options) }
  /** @returns {Promise<BridgeResult>} */
  asrUse(args = {}, options = {}) { return this.execute('asr use', args, options) }

  // —— 弹幕 ——
  /** @returns {Promise<BridgeResult>} */
  danmakuSend(videoId, text, args = {}, options = {}) {
    const pos = []
    if (videoId !== undefined && videoId !== null && videoId !== '') pos.push(String(videoId))
    if (text !== undefined && text !== null && text !== '') pos.push(String(text))
    return this.execute('danmaku send', { _positional: pos, ...args }, options)
  }
  /** @returns {Promise<BridgeResult>} */
  danmakuRecall(args = {}, options = {}) { return this.execute('danmaku recall', args, options) }
  /** @returns {Promise<BridgeResult>} */
  danmakuInteractFollow(args = {}, options = {}) { return this.execute('danmaku interact follow', args, options) }
  /** @returns {Promise<BridgeResult>} */
  danmakuInteractLink(args = {}, options = {}) { return this.execute('danmaku interact link', args, options) }
  /** @returns {Promise<BridgeResult>} */
  danmakuInteractList(args = {}, options = {}) { return this.execute('danmaku interact list', args, options) }

  // —— 通用 ——
  /** @returns {Promise<BridgeResult>} */
  schema(args = {}, options = {}) { return this.execute('schema', args, options) }
  /** @returns {Promise<BridgeResult>} */
  ownerShow(args = {}, options = {}) { return this.execute('owner show', args, options) }
  /** @returns {Promise<BridgeResult>} */
  ownerSet(args = {}, options = {}) { return this.execute('owner set', args, options) }
  /** @returns {Promise<BridgeResult>} */
  ownerClear(args = {}, options = {}) { return this.execute('owner clear', args, options) }
  /** @returns {Promise<BridgeResult>} */
  skillsShow(args = {}, options = {}) { return this.execute('skills show', args, options) }
  /** @returns {Promise<BridgeResult>} */
  skillsStatus(args = {}, options = {}) { return this.execute('skills status', args, options) }
  /** @returns {Promise<BridgeResult>} */
  skillsInstall(args = {}, options = {}) { return this.execute('skills install', args, options) }
  /** @returns {Promise<BridgeResult>} */
  skillsUninstall(args = {}, options = {}) { return this.execute('skills uninstall', args, options) }
}

// 默认导出单例
export const defaultBridge = new BiliCliBridge()

export default BiliCliBridge

// ── CLI 自测入口: node bili-cli-bridge.js [--json] ─────────────
// 用于快速检查 Python / bili-cli 环境，输出给 agent 判断
if (import.meta.url === `file://${path.resolve(process.argv[1] ?? '')}` || process.argv[1]?.endsWith('bili-cli-bridge.js')) {
  const run = async () => {
    const b = new BiliCliBridge()
    const result = await b.checkAvailability()
    const payload = {
      env: {
        python: b.pythonPath,
        node: process.version,
        platform: process.platform
      },
      biliCli: result
    }
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    process.exit(0)
  }
  run()
}
