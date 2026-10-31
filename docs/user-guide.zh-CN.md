# 使用指南

Codex Nested Conversations 帮你在官方 Windows 桌面应用中按层级查看相关聊天。一个主聊天可以有多个下级聊天，下级聊天也可以继续展开；适合在主聊天里统筹拆分出去的工作，并随时回到某个分支。

这里的层级指独立聊天之间的关系。Codex 的 subagents 是另一种协作机制，不能与子聊天画等号。

## 准备环境

本指南适用于 `0.3.0-preview.6`。需要 Windows 10 或 11、已安装并登录的官方 Codex 桌面应用、Node.js 22 及以上版本（含 npm），以及 Python 3.10 及以上版本。项目在官方包 `26.1027.3384.0` 上测试过；客户端更新后，界面或本地数据结构的变化可能需要项目适配。

下载 [0.3.0-preview.6 源码 ZIP](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.6/codex-nested-conversations-0.3.0-preview.6-source.zip) 并完整解压，也可克隆[源码仓库](https://github.com/Mastery-L99/codex-nested-conversations)，在项目目录打开 PowerShell。以下相对路径均以项目根目录为起点。安装器不会替你下载 Node.js、Python 或 npm，请先自行安装。然后准备项目声明的公开依赖并检查环境：

```powershell
npm.cmd ci --omit=dev --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

项目使用公开的 Playwright `1.64.1`，连接已有桌面应用无需安装 Playwright 浏览器。`doctor.ps1` 检查依赖、运行文件和官方应用包，不启动 Codex。

## 安装和启动

先预览安装计划，查看程序目录、数据目录和桌面入口；确认后执行安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

默认程序目录是 `%LOCALAPPDATA%\CodexNestedConversations`，独立数据目录是 `%LOCALAPPDATA%\CodexNestedConversationsData`。上述命令不修改系统的 PowerShell 执行策略；安装也不会自动启动增强。安装器不会覆盖已有的同名程序目录或桌面入口。

安装完成后，双击桌面上的 **Codex Nested Conversations** 入口。若官方 Codex 已经以普通模式运行，请先在 Codex 的“文件”菜单选择“退出”，再打开增强入口。当前版本需要通过增强入口加载；直接从官方图标启动时不会自动加载增强。

也可以手动启动默认安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Start.ps1"
```

打开后仍使用同一个官方客户端和账户，不会创建第二套 profile。增强通过本机回环地址上的临时调试端点连接官方进程；官方安装和更新渠道保持原样。

### 继续使用习惯的固定图标

如果希望开始菜单或任务栏中习惯的位置默认打开增强，需要替换一次固定入口：取消旧官方入口的固定，固定增强启动入口，再把新固定项移到习惯的位置。沿用相同显示名称或图标时，仍需核对入口目标；外观相同不会让旧固定项改向。Windows 可能保留旧 MSIX 固定项，需要手动取消。

替换后，点击该固定项会使用增强入口。这个设置不会拦截 Codex 的所有启动方式：官方“所有应用”、协议链接和自启动仍可能普通启动。若已有普通实例运行，先从官方应用菜单退出，再打开增强入口。

## 查看和跟进聊天

在主聊天中请 Codex 创建子聊天，或从已有聊天 fork 出分支。项目会自动发现真实的 `create_thread` 和 `fork_thread` 关系，并在侧栏把下级聊天放到对应父聊天下面。关系更新由客户端事件触发，文件变更也会触发补充更新。

在 Recents 和项目列表，以及 Codex 和 ChatGPT 两种模式的侧栏中，可以展开或收起对应层级。点击下级聊天标题即可打开，悬停后可使用“⋯”菜单；父聊天也可从其聊天操作菜单进入相关操作。显示的是已识别的本机聊天关系，不会把每条平铺聊天自动归入某个主聊天。

子聊天可以继续拥有自己的下级聊天。收起层级只影响显示，需要查看进度时再展开；下级聊天的处理中和未读提示会在可用时显示。

## 归档一组聊天

级联归档适用于已识别关系中的本机 Codex 聊天，ChatGPT 原生聊天不在级联归档范围内。当某个聊天有已识别的下级聊天时，可从该聊天的操作菜单选择归档，也可在当前聊天的输入框或正文区域按 `Ctrl+Shift+A`。弹窗会列出当前聊天及其全部下级聊天；即使某些层级处于收起状态，也包含在列表中。没有已识别下级的聊天沿用官方归档行为。

1. 仔细查看弹窗中的聊天范围。
2. 选择“归档全部”，或选择“只归档当前对话”；暂不操作可选择“取消”。
3. 选择全部后，程序依次通过官方聊天菜单处理，先归档下级，再归档父聊天，并逐项检查结果。进度窗口会显示处理情况。

如果操作失败或结果无法确认，后续操作会停止，已经归档的聊天不会自动恢复，尚未处理的聊天保留原样。请查看进度窗口和官方应用中的状态，再决定是否继续。执行中也可以使用停止按钮；它不会撤销已经完成的归档。

快捷键可能被其他软件占用；如果没有出现范围窗口，请检查其他软件的快捷键设置，并尝试聊天操作菜单。本版本使用 `Ctrl+Shift+A`，没有备用组合键。官方界面当前没有可用的 Delete 操作，项目也未实现级联删除。

## 停止、卸载和重装

只想结束当前增强时，在 PowerShell 中运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Stop.ps1"
```

停止会移除当前窗口的增强并退出本项目的运行进程，不会关闭官方 Codex。之后需要时可再次通过增强入口启动。

从项目根目录预览并执行卸载：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

卸载器会检查安装身份，停止项目进程，将项目程序目录及其专用入口送入 Windows 回收站；独立数据目录默认保留。官方聊天、账户和配置不属于卸载范围。安装与卸载共用入口定义，并兼容本项目旧版生成的完整入口；若目标或参数确实被修改，卸载会停止并保留程序目录和快捷方式供检查。卸载后，从官方应用菜单退出并正常重启一次，临时调试端点会随原进程关闭。若使用了自定义程序目录，卸载时需用 `-InstallDir` 指向该目录。

卸载后重新安装并复用保留数据时，先检查安装计划，再加上 `-ReuseData`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -ReuseData -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -ReuseData
```

安装器只复用带本项目身份标记的数据目录。若安装中断并留下带标记的半成品，可用项目中的卸载脚本清理后重试。

## 遇到问题时

- **环境检查报告缺少依赖**：确认 Node.js、npm 和 Python 可在 PowerShell 中找到，再于项目根目录运行 `npm ci --ignore-scripts` 和 `doctor.ps1`。
- **提示 Codex 正在普通模式运行**：从官方应用的“文件”菜单退出，然后打开增强入口。
- **没有看到预期层级**：确认使用增强入口启动，相关聊天确实由 `create_thread` 或 `fork_thread` 建立，并在侧栏找到父聊天。等待关系更新后仍无显示，可检查官方应用版本和项目的运行记录。
- **归档中途停止**：先查看进度和官方应用中各聊天的状态；已经完成的操作不会自动撤销。确认剩余范围后，再决定是否继续。
- **客户端更新后显示异常**：先停止增强，恢复官方界面，再查看项目更新或反馈具体版本和复现步骤。

项目是独立运行时增强，并非官方支持的侧栏插件。运行数据保存在本机；提交问题或贡献代码前，请移除个人聊天标题、ID、账户资料、运行记录及其他敏感信息。更多项目说明见 [中文 README](../README.zh-CN.md)，许可见 [MIT License](../LICENSE)。
