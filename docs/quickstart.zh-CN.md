# Windows 快速开始

本指南适用于 `0.2.0-preview.1`。这是独立的开源增强工具，在官方 Codex 桌面应用的同一窗口中显示嵌套聊天；它不安装第二个 Codex 客户端。当前实机适配的官方应用包版本是 `26.1023.6621.0`，其他版本可能需要适配。

## 1. 准备环境

需要 Windows 10/11、已安装的官方 Codex 桌面应用、Node.js 22 或更高版本（含 npm），以及 Python 3.10 或更高版本。安装这些工具后，重新打开 PowerShell，让命令路径生效。无需管理员权限。联网下载依赖时使用公开 npm 包 Playwright `1.64.1`，无需安装 Playwright 浏览器。

## 2. 下载并解压

项目公开发布后，从其 GitHub 仓库页面下载此版本源码：若有该版本的发布页面，选择对应的 Source code ZIP；也可以在仓库页面通过 **Code → Download ZIP** 下载当前源码。后者可能包含更新，使用时以其中 `package.json` 的版本为准。当前尚无可提供的公开下载地址。将 ZIP 完整解压到自己的普通文件夹，进入解压后的项目根目录——这里应能看到 `package.json`、`scripts` 和 `src`。

在该文件夹的地址栏输入 `powershell` 并回车，打开 PowerShell。以下依次运行：

```powershell
npm ci --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

等待每条命令结束并检查输出；doctor 显示 `Environment checks passed` 后继续。doctor 需要先安装依赖，负责检查 Node、Python、npm、Playwright、运行文件和官方应用包，不会启动应用，也不会判断发现的官方版本是否经过适配。遇到问题见 [常见问题](faq.zh-CN.md)。

## 3. 安装并启动

先预览，再安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

预览会显示程序目录、数据目录和桌面快捷方式等信息，不会执行安装。默认安装位置为 `%LOCALAPPDATA%\CodexNestedConversations`，独立数据位置为 `%LOCALAPPDATA%\CodexNestedConversationsData`。安装不会自动启动 Codex；如果目录或同名快捷方式已存在，安装器会停止，避免覆盖。

如果官方 Codex 正在普通模式运行，先在 Codex 的 **文件 → 退出** 中正常退出，然后双击桌面上的 **Codex Nested Conversations** 启动。也可以在 PowerShell 中运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Start.ps1"
```

首次启动会建立关系索引。普通官方入口和固定到开始菜单的官方图标可能绕过增强；要使用嵌套列表，请通过上面的增强入口启动。启动时只连接同一官方应用与账户，不新建 profile。运行期间会使用本机回环地址上的临时调试端点。

## 4. 使用和停止

通过创建子聊天或 fork 形成的真实关系会自动显示为多层树，覆盖最近聊天和项目视图。关系索引识别本机 Codex 用户聊天；Codex 和 ChatGPT 侧栏中可识别的本机关系可参与展示，云端聊天关系不在当前识别范围内。关系更新通过客户端事件触发，并以文件变更作为补充；没有固定 20 秒的全量轮询。

在父聊天菜单中选择归档，或选中父聊天后使用 `Ctrl+Shift+A`，先查看确认框中的范围。选择归档全部时，折叠的后代也在范围内，系统逐个先处理后代，再处理父聊天，并读取本地状态验证；出错时停止，已完成的归档不会自动撤销。也可选择只归档当前聊天。快捷键若被截图等软件占用，请调整冲突设置。当前没有备用快捷键，也没有级联删除功能。

停止增强而保留官方窗口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Stop.ps1"
```

## 5. 卸载与升级

在解压后的项目根目录，先运行预览，再运行卸载：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

卸载器检查安装标记，停止增强，并将项目程序目录和其专用快捷方式送入回收站；独立数据目录默认保留，官方聊天与账户不在卸载范围。卸载后正常退出并重新打开官方应用，临时调试端点才随原进程关闭。

**当前源码中的已知问题：**默认快捷方式的创建参数与卸载时的检查参数不一致，卸载预览可能提示快捷方式已被修改并停止。遇到此提示请保留现状，等待修正，不要手动覆盖或删除。见 [常见问题](faq.zh-CN.md)。

安装器不支持覆盖升级。取得新版本并完成依赖安装、doctor 后，先用旧版本卸载器预览并完成卸载；若遇到上述阻塞，先等待修正。然后在新版本目录运行安装命令并加 `-ReuseData`，复用有本项目身份标记的保留数据：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -ReuseData -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -ReuseData
```

若旧版使用自定义路径，卸载和新安装需使用相应的 `-InstallDir`、`-DataDir`；请先核对预览。保留旧版解压文件，直到升级完成。
