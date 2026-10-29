# 部署指南 · dsh-bili-reef

本文覆盖：**发布到 npm** → **DSH 安装** → **首次配置** → **验证** → **排障** → **升级/回滚**。

---

## 一、发布到 npm（维护者）

### 1. 登录 npm

```bash
npm login          # 会打开浏览器，用你的 npm 账号授权
npm whoami         # 确认已登录
```

### 2. 发布

包名 `dsh-bili-reef` 已在 npm registry 上确认可用。发布前自检：

```bash
cd <插件目录>
npm pack --dry-run          # 预览将要打包的内容，确认没有凭据/日记
npm publish                 # 首次发布
npm publish --tags beta     # 预发布
```

> ⚠️ `npm publish` 会**打包 `files` 数组里列的文件**。发布前务必确认
> `credentials.json`、`quota.json`、`bili-whale.config.json`、`whale-diary*.md`
> 等运行期产物**没有**被打进去 —— 仓库的 `.gitignore` 已排除它们，`npm pack` 遵循 `.gitignore` 之外还要看 `files` 白名单，两者共同把关。

### 3. 发布后校验

```bash
npm view dsh-bili-reef version
npm view dsh-bili-reef dist.tarball
```

---

## 二、DSH 安装（三选一）

### ① npm 一键安装（推荐）

```bash
dsh plugin --profile desktop add dsh-bili-reef
```

DSH 会从 npm 拉取 tarball 安装到 `~/.dsh/profiles/desktop/vendor/`。

### ② GitHub 直装

```bash
dsh plugin --profile desktop add "github:zhikanyeye/dsh-bili-reef"
```

或者在 profile 的 `package.json` 里写依赖：

```json
{
  "dependencies": {
    "dsh-bili-reef": "github:zhikanyeye/dsh-bili-reef"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-bili-reef"]
    }
  }
}
```

> ⚠️ `bundles` 数组里必须**同时**列出包名，否则装上了也不加载。

### ③ 本地源码目录（开发/自用）

```bash
dsh plugin --profile desktop add "link:D:\bilibili-automaster\dsh-bili-reef"
```

`link:` 前缀让 DSH 直接引用源码目录，改代码后**不用重装**（仍需重启 DSH 让 bundle 重组）。

### 安装后

**重启一次 DSH**（bundle 层要重启才组装），然后打开「**设置 → 养鱼**」。

> ⚠️ 设置页 404 = 包名与 `cordis.patch.yml` 的 `name:` 不一致。本插件锁定 `dsh-bili-reef`，**不要改名**。

---

## 三、首次配置

### 1. 登录 B 站

「设置 → 养鱼 → B 站登录」→「扫码登录」→ 手机 App 扫一下。

或手动粘贴 Cookie（F12 → Application → Cookies → https://www.bilibili.com）：

| Cookie | 用途 |
|---|---|
| `SESSDATA` | 登录态（**HttpOnly**，脚本读不到，必须 F12 手动复制）|
| `bili_jct` | CSRF token，写操作必需 |
| `buvid3` | 设备标识 |

### 2. 填你的 mid + 昵称

分享评论要 @ 的人。

### 3. 点「依赖体检」

它会**真的请求一次** B 站验证登录态，并检查 ffmpeg / Node / 数据目录。

> ⚠️ **改完一定要点「保存」** —— 设置页输入框是「先改在本地、点保存才落盘」的。
> 作息窗口 / 评论监听 / 直播间开关 / 消息推送 / 分享闸门都是保存后立刻重算；只有换插件代码/版本才需要重启 DSH。

---

## 四、装 bili-cli（「喂鱼」层）

桥接层会优先用 PATH 里的 `bili`，找不到则回退 `python -m bili_cli.main`。

```bash
uv tool install bili-agent      # 或 pipx install bili-agent
bili --version                  # {"ok":true,"data":{"version":"..."}}
```

登录与 owner 设置：

```bash
bili auth login                 # 人类扫码，AI 不能代劳
bili auth status --wait 120
bili owner set <你的UID>
```

> **冷启动提示**：Windows 首次运行 `bili --version` 可能超过 10 秒（Defender 扫描 Python 文件）。
> 桥接层已做 30 秒超时重试；若仍失败，先手动跑一次 `bili --version` 预热。

---

## 五、验证

```bash
# 插件自检（配置/凭据/登录态/数据目录/依赖）
node <插件目录>/tools/bili.mjs selftest

# bili-cli 桥接自检
node <插件目录>/tools/bili.mjs bili-cli status
node <插件目录>/tools/bili.mjs bili-cli list
```

首次自检通过后：

1. 设置页 →「生物钟」→ 把作息窗口改成**现在之后 2 分钟**的一小段 → 保存 → 等她自己醒
2. 左侧「工作区」→ 展开「未分组」→ 找到她的会话 → 权限设为 **完全访问 / danger-full-access**
3. 观察是否产出日记、是否推送

---

## 六、排障

| 症状 | 真正原因 |
|---|---|
| 设置页 404 | 包名与 `cordis.patch.yml` 的 `name:` 不一致（必须是 `dsh-bili-reef`）|
| 插件一直 pending | headless 模式没有 `sessionController`/`webServer`/`connection`；必须挂在带网页界面的组件层 |
| 「装完了，但找不到她」 | 她的会话在 **工作区 → 未分组** 里，不点开那个文件夹看不见 |
| 「找到了，但她什么都不干」| 新会话默认没有完全权限，给她 `danger-full-access` |
| 「设置页保存了还是红的」| 没点「保存」（输入框先改在本地）|
| 「cookie 填了还是未登录」| 用了 `document.cookie` 取 SESSDATA，它是 HttpOnly，必须 F12 手动复制 |
| `找不到可用的 node 运行时` | 设置 `DSH_NODE` 环境变量指向真实 node 可执行文件 |
| bili-cli 报 `bridge_unavailable` | 先手动跑 `bili --version` 预热；或用 `BILI_CLI_PYTHON` / `BILI_CLI_BIN` 指定路径 |
| 撞 412 / 429 | 平台风控。暂停 5/10/20/30 分钟，不要连续重试；`rate_limited` 按 `detail.retry_after` 等待 |
| 视频接口 412 / 非 JSON | 网络或签名接口异常；暂停后重试，**不要**伪装成已完成抽帧 |

---

## 七、升级与回滚

```bash
# 升级（npm）
dsh plugin --profile desktop update dsh-bili-reef

# 或直接改 profile 的 package.json 版本号后重装
dsh plugin --profile desktop remove dsh-bili-reef
dsh plugin --profile desktop add dsh-bili-reef
```

回滚：把 profile `package.json` 里的版本号改回旧版（如 `0.5.0`），删掉 `node_modules/dsh-bili-reef`，重启 DSH。

> 配置与凭据**不在插件目录里**（分别在 `~/.dsh/bili-whale.config.json` 和 `~/.bili-ai/credentials.json`），
> 升级/重装不会丢数据。只有换号时才需要重新扫码。

---

## 八、数据与文件位置

| 内容 | 位置 |
|---|---|
| 插件设置 | `~/.dsh/bili-whale.config.json` |
| 凭据（Cookie）| `~/.bili-ai/credentials.json`（**永不回显**）|
| 人设 | `~/.bili-ai/persona.md` |
| 她的会话工作区 | `~/.dsh/whale-work` |
| 日记 | `~/.dsh/` 下（`whale-diary*.md`）|
| 额度账本 | `~/.dsh/quota.json` |
| 插件安装目录 | `~/.dsh/profiles/<profile>/vendor/` 或 `~/.dsh/plugins/` |
