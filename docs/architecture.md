# Loading and update compatibility / 加载与更新兼容

## English

The current native-list adapter keeps the official installation and account. An external launcher starts the installed package through its stable Windows application identity, adds a local debugging endpoint, and starts the companion. Package discovery happens on every launch, so a normal version-directory change does not require a new shortcut. The companion watches actual relationship events and local file changes.

Replacing an old Start pin once with this launcher lets the same familiar icon load the enhancement on subsequent launches. This has been cold-start tested. Other official activation paths can bypass the launcher. Changes to the sidebar, menu identity, preload context, local database schema or debugging support may require an adapter update.

| Approach | Native conversation list | Ordinary startup | Current position |
|---|---|---|---|
| External launcher and adapter | Yes, on the tested app version | Through the configured launch entry | Implemented and tested |
| Official sidebar extension | Its own tree view and panel | Uses the official plugin lifecycle | Supported alternative surface; does not expose a host-list replacement API |
| Startup-time injection framework | Potentially reuses this adapter | May cover more activation paths | Research only; a Codex-specific adapter has not been validated |

Official sidebar extensions open their own MCP App. Components run in an isolated iframe. The documented lifecycle hooks concern chat sessions and execution; starting a companion with a hook does not grant access to the host renderer or enable a debugging endpoint in an already-running app. These conclusions concern the current public contracts, rather than every possible future interface. See [Extensions](https://developers.openai.com/plugins/build/extensions), [Security and privacy](https://developers.openai.com/plugins/guides/security-privacy), and [Hooks](https://learn.chatgpt.com/docs/hooks).

Windhawk provides early process injection, which makes it a candidate for future research. Reliable early loading can require its engine in more processes than the target application. Neither this project's installer nor its runtime installs or enables Windhawk. See its [injection documentation](https://github.com/ramensoftware/windhawk/wiki/Injection-targets-and-critical-system-processes). A process watcher alone cannot retroactively add startup arguments to a running application.

## 中文

当前原生列表适配器保留官方安装和账户。外部启动器通过稳定的 Windows 应用标识启动已安装的官方包，附加本机调试参数，再启动伴随进程。每次启动都会动态定位官方安装，正常升级时安装目录变化不需要重新配置快捷方式。关系更新由真实事件和本地文件变更触发。

将旧开始菜单固定项替换为同名启动入口后，后续可以继续点习惯的图标加载增强；这一流程已完成冷启动验收。其他官方激活路径仍可能绕过启动器。侧栏、菜单身份、隔离上下文、本地数据库结构或调试能力发生变化时，需要更新适配器。

| 方案 | 原生聊天列表 | 默认启动方式 | 当前进展 |
|---|---|---|---|
| 外部启动器与适配器 | 已在适配版本实现 | 从配置好的入口启动 | 已实现并验收 |
| 官方侧栏扩展 | 自己的树视图和面板 | 使用官方插件生命周期 | 可用作独立界面，未提供接管原生列表的公开接口 |
| 启动期注入框架 | 有机会复用当前适配器 | 有机会覆盖更多激活路径 | 研究方向，尚未验证 Codex 专用适配 |

官方侧栏扩展打开自己的 MCP App，组件运行在隔离 iframe。公开生命周期钩子围绕聊天会话和执行过程；钩子启动工具后，也不会因此获得主界面权限，或为已运行的应用补上启动期调试通道。这些判断基于当前公开合同，未来接口可能扩展。来源见上方官方文档。

Windhawk 具备启动早期注入的基础能力，值得继续研究；可靠的早期加载可能需要引擎进入目标应用之外的更多进程。本项目安装器和运行模块均未安装或启用它。单纯监测应用进程的工具，也无法为已经运行的程序补上启动参数。
