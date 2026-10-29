# Codex Nested Conversations

在官方 Windows 版 Codex 桌面客户端中，将主聊天和多级子聊天组织成可展开的层级。项目适合同时推进多个任务、聊天越来越多，希望从一个主聊天追踪相关工作的用户。

**[English](README.md) · [中文使用指南](docs/user-guide.zh-CN.md) · [English user guide](docs/user-guide.md)**

当前版本：**0.2.0-preview.1**，采用 [MIT 许可证](LICENSE)。

下载 [0.2.0-preview.1 源码 ZIP](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.2.0-preview.1/codex-nested-conversations-0.2.0-preview.1-source.zip)，或查看[预览版发行页](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.2.0-preview.1)与[源码仓库](https://github.com/Mastery-L99/codex-nested-conversations)。

## 能做什么

- 在最近聊天和项目列表中显示聊天层级，支持 Codex 与 ChatGPT 两种模式。通过 `create_thread` 和 `fork_thread` 产生的真实父子关系会自动发现。
- 保留同一个官方客户端和账户，不创建第二个 profile。聊天层级用于组织和跟进聊天；subagents 是执行子任务的协作机制，两者可以各自使用。
- 对已发现下级聊天的本地 Codex 聊天，从聊天菜单或按 **Ctrl+Shift+A** 发起归档，先查看并确认当前聊天及下级聊天的范围。选择全部归档后，系统先处理后代，逐项验证结果；发生失败时停止后续操作。快捷键在输入框和聊天正文中均可使用。
- 关系变化通过事件更新，并以文件变化作为补充触发。无需依赖固定的 20 秒轮询。

```text
项目主对话
├─ 调研
│  └─ 同行案例
├─ 功能实现
└─ 测试验收
```

当前适配器、默认入口和未来插件方案见[加载与更新兼容](docs/architecture.md)。

## 安装与启动

需要 Windows 10/11、官方 Codex 桌面客户端、Node.js 22 或更新版本、Python 3.10 或更新版本，以及 npm。项目使用公开的 Playwright 1.64.1；已测试的官方客户端包版本为 **26.1023.6621.0**。其他版本可能需要适配。

获取本项目源码或发行包并解压，在项目目录打开 PowerShell：

```powershell
npm ci --ignore-scripts
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安装器会检查依赖，创建独立程序目录、数据目录和桌面快捷方式；安装完成后不会自动启动。首次使用时，通过桌面的 **Codex Nested Conversations** 快捷方式启动。如果官方 Codex 已以普通方式运行，请先从其“文件”菜单退出，再使用增强入口启动。直接从官方入口重启时，当前版本不会自动加载增强。

希望以后从习惯的固定图标默认打开增强，需要先取消旧官方入口的固定，再固定增强入口并移到习惯的位置；名称或图标相同不会让旧固定项自动改向。替换后，点击这个固定项会使用增强入口。官方“所有应用”、协议链接和自启动仍可能普通启动，具体步骤见[中文使用指南](docs/user-guide.zh-CN.md)。

默认程序与数据分别位于 `%LOCALAPPDATA%\CodexNestedConversations` 和 `%LOCALAPPDATA%\CodexNestedConversationsData`。安装到已有程序目录会停止，避免覆盖；复用已有项目数据的方式见[中文使用指南](docs/user-guide.zh-CN.md)。

## 停止和卸载

要停止增强，可从安装目录运行 `scripts\Stop.ps1`，官方聊天窗口继续可用。卸载时，在原项目目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -WhatIf
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

卸载器将本项目程序目录和专用快捷方式送入回收站，保留独立数据目录，并识别本项目当前和旧版生成的入口。若入口目标或参数确实被修改，卸载会停止并保留现状供检查。卸载后正常退出并重新打开官方客户端，可关闭临时调试端点。自定义安装目录及重新安装步骤见[中文使用指南](docs/user-guide.zh-CN.md)。

## 使用边界

这是独立的运行时增强，并非官方支持的侧边栏插件。它不修改官方安装或更新程序，但依赖官方界面和本地数据结构；官方更新后，部分功能可能需要重新适配。它使用本机回环调试端点连接当前官方客户端；退出并按官方入口重新打开客户端后，临时端点关闭。

目前只提供 **Ctrl+Shift+A**，没有 `Ctrl+Alt+Shift+A` 备用组合键。若快捷键被其他软件占用，请先调整冲突设置。官方界面当前没有可用的原生 Delete 操作，项目也没有实现级联删除。

## 参与贡献

欢迎报告问题、提出改进和提交代码。提交问题时，请说明 Windows、Codex 与项目版本、复现步骤和实际结果，并移除聊天内容、标题、ID、账户信息及本机路径等敏感信息。开发和验证说明见 [testing.md](docs/testing.md) 与 [runtime-integration.md](docs/runtime-integration.md)。

使用与分发第三方依赖的说明见 [NOTICE.md](NOTICE.md)。
