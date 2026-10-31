# Original-icon loading prototype / 原图标自动加载原型

The original-icon loader described here is experimental. The supported nested sidebar in `0.3.0-preview.6` uses the project's dedicated shortcut. A cold start from the original Windows app icon has not passed acceptance.

## 中文

这一方案保留同一份官方 GPT/Codex 安装、账号和聊天数据，分为两个模块：

1. 官方应用启动时，全局本地 MCP 引导模块启动本项目的界面增强。它没有模型工具，不注册 Windows 开机启动项。
2. Windhawk 在官方主进程启动早期加载一个小模块，通过 Win32 命令行接口提供本机调试参数。模块按当前包身份和实际安装路径核对目标，跳过子进程、已有调试参数、非官方同名程序和已经运行到较晚阶段的进程。它不修改官方可执行文件、安装目录或快捷方式。

Windhawk 是额外依赖。标准安装需要管理员授权，并新增随系统启动的后台服务。它的底层引擎会进入多个进程，以捕捉应用启动；本项目的模块只在上述官方主进程条件满足时登记自己的钩子。GPT 自身可以继续保持开机不启动。这一范围比普通插件更深，安装前需要用户选择。

目前已完成核心参数处理、官方 SDK 头文件编译、全局 MCP 引导和注册／移除的隔离检查。Windows 官方客户端的无参数动态调试后端也已单独实验：可以监听，但当前 Owl 拒绝实际连接，因此没有采用它作为成功方案。

下一次实机验收必须覆盖：安装稳定版 Windhawk、用其实际编译流程编译本项目模块、仅启用本项目模块、通过原始应用图标冷启动而不发送聊天、确认同一官方进程的本机连接和增强界面、协议激活、停止／移除，以及 GPT 开机启动仍关闭。研究目录中的 MSVC 链接验证 DLL 不能代替实际 Windhawk 模块。

当前稳定版 Windhawk 的本地模块应通过其开发界面导入和编译。2.0 alpha 才出现的 CLI 不能写成稳定版已有功能。退出时，先禁用并移除本项目模块，再移除本项目的 MCP 注册；是否卸载整个 Windhawk 由用户决定，其他模块不应随本项目一起删除。

本方案不阻止官方客户端更新，模块按当前包身份定位安装，避免绑定某个版本目录。官方侧栏、菜单、数据结构或底层加载流程变化后，仍可能需要适配；跨未来版本的兼容性不能用本次测试替代。

## English

This design keeps the same official installation, account, and chat data. A global local MCP bootstrap starts the interface adapter when the app discovers its server catalog. A separate Windhawk module provides loopback debugging switches through the Win32 command-line API during early startup. It verifies the current package identity and exact installed image, and skips child processes, existing debugging configurations, unrelated namesakes, and late attachment. It does not patch the official installation or replace shortcuts.

Windhawk is an additional dependency. Its standard installation requires administrator approval and adds a service that starts with Windows. The engine enters multiple processes to observe process creation; this project's module registers its hook only for the verified official main process. GPT itself can remain disabled at Windows sign-in. This is a deeper integration than a regular plugin and requires an informed installation choice.

Payload, official-header compilation, MCP bootstrap, and registration/removal checks have passed in isolated fixtures. This does not establish original-icon startup success. The alternative preference-driven Chromium backend can listen in the tested Owl build, but rejects the actual connection and is not treated as a working solution.

Acceptance still requires the real stable Windhawk compiler and engine, an original-icon cold start without a chat prompt, the original account/profile, a verified loopback owner, rendered nesting, protocol activation, removal, and startup remaining off. The research MSVC linkage DLL is not a distributable Windhawk module. Stable Windhawk uses its local development UI; CLI features introduced in 2.0 alpha must not be attributed to the stable release.

Disable and remove this project's mod before removing its MCP registration. Leave other mods intact; uninstalling the entire framework is a separate user choice. Normal official updates are not blocked and the module avoids a version-specific installation path, but future host changes can still require adapter maintenance.

## Sources

- [Windhawk early initialization](https://github.com/ramensoftware/windhawk/wiki/Creating-a-new-mod#wh_modinit)
- [Windhawk injection scope and timing](https://github.com/ramensoftware/windhawk/wiki/Injection-targets-and-critical-system-processes)
- [Windhawk releases](https://github.com/ramensoftware/windhawk/releases)
- [Official plugin packaging and local MCP servers](https://developers.openai.com/plugins/build/plugins)
