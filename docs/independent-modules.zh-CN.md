# 对话管理的三个入口

| 入口 | 使用方式 |
| --- | --- |
| 官方「嵌套对话」页面 / 聊天旁面板 | 从原 GPT 图标打开。安装本地插件后，在支持扩展的桌面宿主打开「嵌套对话」，或让 Codex 打开这个目录。展开父聊天找到子聊天，点击具体聊天打开。 |
| 官方「批量归档」插件页面 | 使用同一个插件，按标题筛选、勾选、核对归档范围和结果。选择或刷新嵌套目录不会提交归档。 |
| 原项目和最近聊天列表 | 需要完整增强，通过项目的桌面快捷方式启动同一个官方客户端，原侧栏里才能直接展开层级。 |

## 安装插件

Windows 上需要已安装并登录的官方 Codex、Node.js 22+ 和 Python 3.10+。默认插件包内已有构建好的交互页面，可直接使用官方 CLI 登记。把给 Agent 的那句话发给 Codex、Claude Code 或其他能执行 Windows 命令的助手，即可按同一流程安装。[给 Agent 的安装指令](install-agent.md)

手动安装时，下载市场 ZIP 和 SHA-256 文件，将 ZIP 完整解压到准备长期保留的目录。在含 `.agents` 和 `plugin` 的目录打开 PowerShell。[版本下载](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.3.0-preview.6)

```powershell
$cli = Join-Path (Get-AppxPackage OpenAI.Codex).InstallLocation 'app\resources\codex.exe'
& $cli plugin marketplace add .
& $cli plugin add codex-nested-conversations@codex-nested-local
```

在 Codex 的插件管理中查看 **Codex 对话管理**。若当前会话仍只看到旧工具，按宿主提示重新载入插件或打开新聊天。Node 和 Python 需要对桌面进程可见。插件从官方 CLI 注册的来源复制到缓存，保留解压目录以方便后续更新。

## 入口和数据

树优先读取本机 Codex 已登记的父聊天，再补充可识别的创建和分叉记录。如果创建历史读不到，目录提示只显示已知关系。缺失的下级不会被当作完整归档范围。后台智能体不作为普通子聊天列入目录。

插件侧面板显示本机目录，宿主没有提供当前聊天身份时可自行选择要看的父聊天。打开某个子聊天会请求 Windows 将该聊天带到官方 Codex。打开目录、展开层级、刷新都只读取数据。项目独立设置使用 `%USERPROFILE%\.codex-nested-conversations\settings`。

只在需要原侧栏树时安装完整源码包。确认页会分别列出聊天和后台任务，停止操作会保留已完成的结果，最多可处理 256 条。[Windows 安装](quickstart.zh-CN.md) · [批量归档](bulk-archive.zh-CN.md)

## 移除与更新

```powershell
& $cli plugin remove codex-nested-conversations@codex-nested-local
& $cli plugin marketplace remove codex-nested-local
```

官方客户端和聊天仍保留。Windows 应用继续走官方更新渠道，插件登记和目录在官方包之外。升级后先重新打开插件，展开一组已知聊天，使用原侧栏模式时再检查增强入口。[更新检查与兼容性](faq.zh-CN.md)
