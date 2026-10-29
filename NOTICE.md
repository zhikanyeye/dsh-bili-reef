# NOTICE · 致谢、原作者与免责

本项目（`dsh-bili-reef`）自身代码以 **MIT** 许可发布（见 `LICENSE`）。

## 原作者与上游项目

`dsh-bili-reef` 是以下两个开源项目的**融合产物**，在此向原作者致谢：

| 上游项目 | 作者 | 版权 | 在本项目中的角色 |
|---|---|---|---|
| [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) | **Alterssss** | MIT | 「养鱼」内核：生物钟调度、偏好学习、双日记、分享闸门、评论/私信/直播间监听、限流与风控护栏、DSH 设置页与插件运行时 |
| [bili-cli](https://github.com/kukemc/bili-cli) | **kukemc** | MIT | 「喂鱼」运营层：109 个 B 站账号命令、CLI 架构与 JSON 契约、错误码体系、`skills/bili-cli` 技能文档、`docs/` 与 `assets/` 中的部分资料 |

- 两个上游项目均以 **MIT** 许可发布，其版权声明随各自代码一并保留在融合后的源码中。
- 本仓库中属于 `dsh-bili-whale` 的部分著作权归 **Alterssss** 所有；属于 `bili-cli` 的部分著作权归 **kukemc** 所有。
- 融合与再分发由 [zhikanyeye](https://github.com/zhikanyeye) 完成，维护地址：<https://github.com/zhikanyeye/dsh-bili-reef>
- 上游项目独立存在并继续维护；本仓库不取代它们。修改本项目时请遵守 MIT 条款，保留原始版权与许可声明。

## 依赖 / 参考的第三方

| 名称 | 用途 | 许可 / 说明 |
|---|---|---|
| **Bilibili API** | 全部功能都调 B 站公开接口 | 非官方；本项目**不包含** B 站任何代码或数据 |
| **bilibili-API-collect** | `tools/docs/` 里的接口文档整理自该项目（社区维护的 B 站接口文档）| 遵循其原项目许可；**不随本项目分发**时请以原仓库为准 |
| **ffmpeg** | 抽帧 / 看画面（`tools/lib/ffmpeg.mjs` 只是**定位并调用**它）| **LGPL v2.1+**（若用 GPL 构建则为 GPL）。本项目**不打包** ffmpeg：请自行安装，或使用 LGPL 构建（附其 LICENSE 与源码链接：https://ffmpeg.org）|
| **Node.js** | 运行环境 | MIT |
| **qrcode** | 扫码登录二维码生成 | MIT |
| **bili-cli** | 账号运营层（以子进程方式调用，不内嵌其代码）| MIT；通过 `bili` 命令或 `python -m bili_cli.main` 外部调用 |

## 免责

- 本项目是**个人自用工具的公开版**：它用**你自己的账号**在 B 站做评论/回复/发动态/投稿等动作，**后果由使用者自负**。
- 不要用于批量刷量、水军、骚扰、绕过风控或任何违反 B 站用户协议的行为。
- 遵循平台规则，撞到风控（验证码 / 限流 / 判刷屏）就该停手，本项目内置了「撞到就停」的护栏。
- 本项目与 B 站、DeepSeek 官方均无隶属关系。
- `bili-cli` 上游项目同样附有独立免责声明，请一并阅读：<https://github.com/kukemc/bili-cli>
