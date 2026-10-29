# 安装 bili-cli（「喂鱼」层）

> 本插件已内嵌 bili-cli 的桥接层，但 **bili-cli 本身是独立程序**，需单独安装一次。
> 上游项目：<https://github.com/kukemc/bili-cli>（作者 kukemc，MIT）

---

## 一、装 `bili` 命令

按顺序试，第一种能用就用第一种：

```bash
uv tool install bili-agent     # 首选
pipx install bili-agent        # 没有 uv 时
```

两个都没有 → 先装 uv：

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
irm https://astral.sh/uv/install.ps1 | iex
```

### 验证

```bash
bili --version
```

应输出：`{"ok": true, "data": {"version": "..."}}`

找不到 `bili` → 跑 `uv tool update-shell`，然后**新开一个终端**（PATH 才会生效）。

> ⚠️ **Windows 冷启动**：首次运行可能超过 10 秒（Defender 扫描 Python 文件）。若超时，先手动跑一次预热。
> 桥接层已内置 30 秒超时重试，并提供环境变量兜底：
> - `BILI_CLI_BIN` —— 指定 `bili` 可执行文件的绝对路径
> - `BILI_CLI_PYTHON` —— 指定 Python 解释器路径（此时走 `python -m bili_cli.main`）

### 在插件里检查

```bash
node <插件目录>/tools/bili.mjs bili-cli status
```

输出 `{available, version, error?, hint?}`。`available: false` 时看 `hint`。

---

## 二、登录（需要人类操作）

```bash
bili auth login
```

1. 把返回的 `qr_image`（图片路径）或 `qr_url` 交给用户，请他用 B 站 App 扫码
2. 用户说扫好了之后：

```bash
bili auth status --wait 120
```

> ⚠️ **别扫成自己的私人号** —— 要扫「给插件用的那个号」。
> 新注册的小号最容易撞风控和验证码。

### 设置 owner（让 AI 能 @ 你 / 私信你）

```bash
bili owner set <你的UID>
```

---

## 三、装技能到各个 agent（可选）

bili-cli 自带一份通用技能，能教这台机器上的**其他** agent 安全使用它：

```bash
bili skills install          # 预览：会显示找到哪些 agent、文件装到哪
bili skills install --yes    # 确认写入
```

告诉用户哪些 agent 收到了技能（输出里的 `targets[].agent`）。

> 💡 **本插件已经内置了融合版技能**（`skills/bili-cli/SKILL.md`），
> 它比上游那份更贴合 dsh-bili-reef：优先走插件桥接命令，系统 `bili` 作为兜底。
> 装插件的用户**不需要**再跑 `bili skills install`。

---

## 四、可选依赖

| 命令 | 用途 | 缺失时 |
|---|---|---|
| `ffmpeg` | HD 抽帧、语音转写、无封面上传 | 降级运行，其余功能正常 |
| `bili asr setup local` | 给无字幕视频做本地语音转写 | 需下载模型：CPU 约 1 GB，NVIDIA GPU 约 4 GB —— **跑之前先问用户** |
| `bili owner set <UID>` | 让命令能 `@` 用户、私信用户 | 不设置则 `@ owner` 用不了 |

---

## 五、常用命令速查

```bash
bili feed inbox               # 每轮先看：有什么新消息
bili video watch <BV>         # 信息 + AI 总结 + 全文 + 热评 + 弹幕高能 + 画面总览
bili video danmaku <BV> --peaks 5
bili comment post <BV> "内容" --at owner --image a.png
bili dm send <UID> "内容"
bili dm watch --backlog       # 流式收私信，实时回
bili dynamic post "内容" --image a.png --at 昵称
bili upload video a.mp4 --title … --tag AI --desc …
bili me stats                 # 账号数据
bili upload stats <BV>        # 单稿互动率、完播率
bili data overview / trend / audience / diagnose
```

完整 109 个命令见 [`../skills/bili-cli/SKILL.md`](../skills/bili-cli/SKILL.md)，
或运行 `bili schema`。

---

## 六、故障排查

| 症状 | 处理 |
|---|---|
| `bridge_unavailable` | 手动跑 `bili --version` 预热；或设 `BILI_CLI_BIN` |
| `not_logged_in` | 重新 `bili auth login` |
| `auth_expired` | 重新扫码登录 |
| `risk_control` / `captcha_required` | **立刻停止所有写操作**，告诉用户，不要换方式重试 |
| `rate_limited` | 按 `detail.retry_after` 等待，不要硬顶 |
| 命令卡住不返回 | 普通命令超过 3 分钟会自己中止并返回 `network_error`；`detail.stalled_seconds` 有值说明运行环境整个停住了，让用户查机器 |

完整错误码见 [`../skills/bili-cli/references/errors.md`](../skills/bili-cli/references/errors.md)。
