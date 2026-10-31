# 一条指令安装 / One-instruction install

适用于 Windows 上的 Codex 或其他有本机命令执行能力的 Agent。需要官方 Codex 桌面客户端、Node.js 22+ 和 Python 3.10+。在远程云端运行命令不会安装到用户的 Windows 电脑。

## 复制给 Agent

> 请在这台 Windows 电脑上，按 https://github.com/Mastery-L99/codex-nested-conversations/blob/v0.3.0-preview.6/docs/install-agent.md 安装默认的「嵌套对话 + 批量归档」插件，使用固定版本和校验值。装完回读版本与启用状态，告诉我从原 GPT 图标进去后怎样打开嵌套目录。保留现有账户和开机启动设置。

> Install the default Nested Conversations and Bulk Archive plugin on this Windows PC using https://github.com/Mastery-L99/codex-nested-conversations/blob/v0.3.0-preview.6/docs/install-agent.md. Verify the pinned checksum, report the installed version and enabled state, and tell me how to open the tree from the original app icon. Preserve my account and sign-in startup settings.

## Windows PowerShell

整行复制到 Windows PowerShell 5.1 或新版 PowerShell。它从固定标签下载脚本，比对 SHA-256，校验通过后调用本机 Python。脚本再验证下载的插件包和官方 CLI 的安装结果。官方应用由用户手动打开。若已有同名但来源不同的市场，安装器会给出说明，保留原安装。

```powershell
$ErrorActionPreference='Stop'; $b=Join-Path $env:TEMP ('cncc-'+[guid]::NewGuid()+'.py'); Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/Mastery-L99/codex-nested-conversations/v0.3.0-preview.6/scripts/install-preview.py' -OutFile $b; if ((Get-FileHash -LiteralPath $b -Algorithm SHA256).Hash -ne '4e5c08c882cfeff2e92fa33d83802ed2b3328a7205d349b80a3b6b01612e07af') {throw 'Installer checksum mismatch'}; python.exe $b
```

- **默认**：从正常的 GPT 图标启动，在支持扩展的宿主中打开插件的「嵌套对话」，或要求聊天「打开嵌套对话目录」。要整理聊天时另开「批量归档」。
- **还要在原左栏展开聊天**：把命令末尾的 `python.exe $b` 改为 `python.exe $b --full`，安装后从增强入口启动。此模式额外需要 npm。
- **只检查安装和官方版本**：改为 `python.exe $b --check`。输出展示本机官方包版本、测试过的官方包版本、插件版本及启用状态。若版本不同，先展开一组聊天并实际打开子项。检查登记状态本身无法确认页面已渲染。
- **已在使用旧版**：重复运行同一版本可回读现有安装。若已有另一个路径注册的同名市场，先用 `--check` 核对版本，再按原来源的升级说明更新。脚本会保留既有来源和禁用设置。

## What this installs

The default registers a versioned local marketplace with the official Codex CLI and installs the plugin into your existing client. Use the natural-language instruction above, or paste the PowerShell line on the target PC. Add `--full` only to install the optional original-sidebar adapter. Use `--check` to read the current desktop version and plugin registration. The official application keeps its normal Store update path.

[中文使用指南](independent-modules.zh-CN.md) · [English guide](independent-modules.md) · [Release downloads](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.3.0-preview.6)
