// bili-cli.mjs
// bili-cli(Python)桥接命令入口 —— 融合 bili-cli 全部运营能力
//
// 用法:
//   node bili.mjs bili-cli status            → 检查 Python + bili-cli 环境
//   node bili.mjs bili-cli schema            → 列出 bili-cli 全部命令
//   node bili.mjs bili-cli list              → 列出全部命令名(紧凑)
//   node bili.mjs bili-cli help <命令>        → 查看单个命令的参数说明
//   node bili.mjs bili-cli run <命令> [参数...]  → 执行一条 bili 命令(透传参数)
//   node bili.mjs bili-cli watch [参数...]   → 流式私信监听(长任务,逐行 JSON)
//
// 设计:
//   - 非侵入式: 不改动 bili-cli 任何代码，只做子进程调用
//   - 优雅降级: bili-cli 不可用时明确提示，不阻塞 whale 现有功能
//   - JSON契约: bili-cli stdout 恒为 {"ok":true,"data":...} 或 {"ok":false,"error":{...}}

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BiliCliBridge } from '../../lib/bili-cli-bridge.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// 解析参数: 支持 --flag value / --flag / 位置参数
function parseArgs(argv) {
  const args = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = true
      }
    } else {
      args.push(a)
    }
  }
  return { args, flags }
}

async function main() {
  const argv = process.argv.slice(2)
  const { args, flags } = parseArgs(argv)
  const sub = args[0]

  const bridge = new BiliCliBridge({
    pythonPath: process.env.BILI_CLI_PYTHON || undefined,
    biliCliPath: process.env.BILI_CLI_BIN || undefined
  })

  // status: 环境检查
  if (sub === 'status' || sub === 'check' || sub === 'env') {
    const result = await bridge.checkAvailability()
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.available ? 0 : 3)
  }

  // schema: 完整命令清单(含参数)
  if (sub === 'schema') {
    const result = await bridge.schema()
    if (!result.ok) {
      console.error(`bili-cli schema 失败: ${result.error?.message || '未知错误'}`)
      process.exit(1)
    }
    // 完整输出: 全部命令+参数
    console.log(JSON.stringify(result.data, null, 2))
    process.exit(0)
  }

  // list: 紧凑命令名清单
  if (sub === 'list' || sub === 'commands') {
    const result = await bridge.schema()
    if (!result.ok) {
      console.error(`bili-cli schema 失败: ${result.error?.message || '未知错误'}`)
      process.exit(1)
    }
    const commands = (result.data?.commands || []).map(c => ({
      command: c.command,
      help: (c.help || '').split('\n')[0]
    }))
    console.log(JSON.stringify({ ok: true, count: commands.length, commands }, null, 2))
    process.exit(0)
  }

  // help <命令>: 单命令参数说明
  if (sub === 'help' || sub === 'cmd') {
    const target = args[1]
    if (!target) {
      console.error('用法: node bili.mjs bili-cli help <命令>')
      console.error('例如: node bili.mjs bili-cli help video watch')
      process.exit(2)
    }
    const result = await bridge.schema()
    if (!result.ok) {
      console.error(`bili-cli schema 失败: ${result.error?.message || '未知错误'}`)
      process.exit(1)
    }
    const cmd = (result.data?.commands || []).find(c => c.command === `bili ${target}`)
    if (!cmd) {
      console.error(`未找到命令: ${target}`)
      process.exit(1)
    }
    console.log(JSON.stringify(cmd, null, 2))
    process.exit(0)
  }

  // watch: 流式私信监听(长任务)
  if (sub === 'watch' || sub === 'dm-watch') {
    const rest = args.slice(1)
    const parsed = parseArgs(rest)
    const watchArgs = {
      ...Object.fromEntries(Object.entries(parsed.flags).filter(([, v]) => v !== false)),
      _positional: parsed.args
    }
    for await (const line of bridge.dmWatch(watchArgs)) {
      if (line.ok) {
        console.log(JSON.stringify(line.data))
      } else {
        console.error(JSON.stringify(line.error))
        process.exit(1)
      }
    }
    process.exit(0)
  }

  // run: 执行一条命令
  if (sub === 'run') {
    const cmdArgs = args.slice(1)
    if (!cmdArgs.length) {
      console.error('用法: node bili.mjs bili-cli run <命令> [参数...]')
      console.error('例如: node bili.mjs bili-cli run video info BV1xx')
      console.error('      node bili.mjs bili-cli run comment post BV1xx --at owner "内容"')
      process.exit(2)
    }

    // 拆出"命令路径"和"命令参数"
    // 命令路径 = 直到第一个位置参数前的单词(如 video / comment post)
    const command = cmdArgs[0]
    const rest = cmdArgs.slice(1)

    // 解析 rest 为 {args, flags}
    const parsed = parseArgs(rest)

    const result = await bridge.execute(command, {
      // 位置参数通过 _positional 传给 bili-cli(由桥接层拼接)
      ...Object.fromEntries(Object.entries(parsed.flags).filter(([, v]) => v !== false)),
      _positional: parsed.args
    }, {
      timeout: Number(flags.timeout || 0) || 120000
    })

    // 输出结果
    if (result.ok) {
      if (flags['compact']) {
        console.log(JSON.stringify(result.data))
      } else {
        console.log(JSON.stringify(result.data, null, 2))
      }
      process.exit(0)
    } else {
      console.error(JSON.stringify(result.error, null, 2))
      process.exit(result.error?.code === 'bridge_unavailable' ? 3 : 1)
    }
  }

  // help
  console.log(`用法: node bili.mjs bili-cli <子命令>

子命令:
  status    检查 Python + bili-cli 环境是否可用
  schema    列出 bili-cli 全部命令(含参数)
  list      紧凑列出全部命令名
  help <命令>   查看单个命令参数说明
  watch     流式私信监听(长任务,逐行 JSON)
  run <命令> [参数...]   执行一条 bili 命令

示例:
  node bili.mjs bili-cli run video info BV1xx
  node bili.mjs bili-cli run comment post BV1xx --at owner "不错"
  node bili.mjs bili-cli run me stats --period week`)
  process.exit(0)
}

main().catch((e) => {
  console.error(`bili-cli 桥接失败: ${e.message}`)
  process.exit(1)
})
