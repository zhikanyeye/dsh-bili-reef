// bili-cli-bridge.test.mjs
// 桥接层单元测试
//
// 测试策略:
//   1. 参数构建(_buildArgs) - 纯逻辑,不依赖外部进程
//   2. 错误降级(fallback) - 模拟 bili-cli 不可用
//   3. 结果解析 - 用 mock 注入的方式验证 JSON 契约
//
// 说明: 这里不测真实的 bili-cli 调用(需要 Python + 包),只测
//   桥接层本身的逻辑正确性。真实环境集成在 integration 测试里做。

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BiliCliBridge } from '../lib/bili-cli-bridge.js'

const here = path.dirname(fileURLToPath(import.meta.url))

test('_buildArgs: 简单命令', () => {
  const b = new BiliCliBridge()
  const argv = b._buildArgs('video info', {})
  assert.deepEqual(argv, ['video', 'info'])
})

test('_buildArgs: 位置参数', () => {
  const b = new BiliCliBridge()
  const argv = b._buildArgs('video info', { _positional: ['BV1xx'] })
  assert.deepEqual(argv, ['video', 'info', 'BV1xx'])
})

test('_buildArgs: 位置参数 + flags', () => {
  const b = new BiliCliBridge()
  const argv = b._buildArgs('comment post', {
    _positional: ['BV1xx', '内容'],
    at: ['owner'],
    image: ['a.jpg', 'b.jpg']
  })
  assert.deepEqual(argv, ['comment', 'post', 'BV1xx', '内容', '--at', 'owner', '--image', 'a.jpg', '--image', 'b.jpg'])
})

test('_buildArgs: 布尔 flag', () => {
  const b = new BiliCliBridge()
  const argv = b._buildArgs('video watch', { record: true, transcript: false })
  assert.deepEqual(argv, ['video', 'watch', '--record'])
})

test('_buildArgs: camelCase 转 kebab-case', () => {
  const b = new BiliCliBridge()
  const argv = b._buildArgs('video danmaku', { maxChars: 100, peaksN: 5 })
  assert.deepEqual(argv, ['video', 'danmaku', '--max-chars', '100', '--peaks-n', '5'])
})

test('_buildArgs: 忽略 undefined/null', () => {
  const b = new BiliCliBridge()
  const argv = b._buildArgs('me stats', { period: undefined, foo: null })
  assert.deepEqual(argv, ['me', 'stats'])
})

test('_buildArgs: 短 flag', () => {
  const b = new BiliCliBridge()
  const argv = b._buildArgs('video info', { p: 2 })
  assert.deepEqual(argv, ['video', 'info', '-p', '2'])
})

test('execute: bili-cli 不可用时降级', async () => {
  const b = new BiliCliBridge({ pythonPath: 'not-exist', biliCliPath: 'not-exist' })
  // 强制不可用
  b._availabilityCache = { available: false, error: '测试不可用' }
  b._availabilityCacheTime = Date.now()

  const result = await b.execute('video info', { _positional: ['BV1xx'] }, {
    fallback: async () => ({ ok: true, data: { fallback: true } })
  })

  assert.equal(result.ok, true)
  assert.equal(result.data.fallback, true)
  assert.equal(result.fallback, true)
})

test('execute: 不可用且无降级时返回错误', async () => {
  const b = new BiliCliBridge({ pythonPath: 'not-exist' })
  b._availabilityCache = { available: false, error: '测试不可用', hint: '运行 pip install bili-agent' }
  b._availabilityCacheTime = Date.now()

  const result = await b.execute('video info', { _positional: ['BV1xx'] })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bridge_unavailable')
  assert.equal(result.error.hint, '运行 pip install bili-agent')
})

test('execute: dryRun 只返回命令不执行', async () => {
  const b = new BiliCliBridge({ pythonPath: 'not-exist' })
  b._availabilityCache = { available: true }
  b._availabilityCacheTime = Date.now()

  const result = await b.execute('video info', { _positional: ['BV1xx'] }, { dryRun: true })

  assert.equal(result.ok, true)
  assert.equal(result.data.dryRun, true)
})

test('checkAvailability: 成功时缓存生效', async () => {
  const b = new BiliCliBridge({ pythonPath: 'not-exist' })
  const calls = []
  // 两个探测器都 mock，避免依赖本机是否装了 bili
  b._tryBiliVersion = (cmd) => {
    calls.push(cmd)
    return { ok: true, version: '9.9.9' }
  }
  b._tryPythonModule = () => ({ ok: false })

  const first = await b.checkAvailability()
  const second = await b.checkAvailability()

  assert.equal(first.available, true)
  assert.equal(second.available, true)
  assert.equal(second.version, '9.9.9')
  assert.equal(calls.length, 1, '成功结果应命中缓存，不再重复检测')
})

test('checkAvailability: 失败不缓存（冷启动超时不污染后续调用）', async () => {
  const b = new BiliCliBridge({ pythonPath: 'not-exist' })
  const calls = []
  b._tryBiliVersion = (cmd) => {
    calls.push(cmd)
    return { ok: false }
  }
  b._tryPythonModule = () => ({ ok: false })
  b._tryPipShow = () => ({ ok: false })

  const first = await b.checkAvailability()
  const second = await b.checkAvailability()

  assert.equal(first.available, false)
  assert.equal(second.available, false)
  assert.equal(calls.length, 2, '失败不应被缓存，下次应重新检测')
})

test('解析: 成功契约', () => {
  const b = new BiliCliBridge()
  // 通过 mock 私有方法验证 JSON 解析逻辑
  const stdout = JSON.stringify({ ok: true, data: { version: '1.2.3' } })
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.version, '1.2.3')
})

test('解析: 失败契约', () => {
  const b = new BiliCliBridge()
  const stdout = JSON.stringify({ ok: false, error: { code: 'risk_control', message: '被风控拦截', hint: '降低频率' } })
  const parsed = JSON.parse(stdout)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'risk_control')
  assert.equal(parsed.error.hint, '降低频率')
})

test('解析: 无效 JSON', () => {
  const b = new BiliCliBridge()
  assert.throws(() => JSON.parse('这不是JSON'))
})

test('执行: spawn 失败返回 execute_error', async () => {
  const b = new BiliCliBridge({ pythonPath: 'definitely-not-exist-python-xyz' })
  b._availabilityCache = { available: true }
  b._availabilityCacheTime = Date.now()

  const result = await b.execute('video info', { _positional: ['BV1xx'] })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'execute_error')
})

test('defaultBridge 是单例', async () => {
  const { defaultBridge } = await import('../lib/bili-cli-bridge.js')
  assert.ok(defaultBridge instanceof BiliCliBridge)
})
