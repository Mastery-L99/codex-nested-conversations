# Codex Nested Conversations

把一个项目里的调研、实施、验收聊天收在主对话下面，展开树就能回到具体分工。项目提供嵌套导航和批量归档，均使用本机已有的官方 Windows 客户端、账户和聊天。

**0.3.0-preview.6 · Windows 预览版** · [English](README.md) · [下载](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.3.0-preview.6) · [给 Agent 的一条安装指令](docs/install-agent.md)

## 选一个入口

| 希望得到的效果 | 使用方式 |
| --- | --- |
| 点原 GPT 图标进入官方客户端，在聊天旁或插件页面查看目录 | 安装默认插件。在支持扩展的桌面宿主打开「嵌套对话」，展开主聊天、查看子聊天。也可以在聊天中要求「打开嵌套对话目录」。 |
| 在「最近聊天」和项目原列表里直接展开主聊天 | 加装完整侧栏增强，通过 **Codex Nested Conversations** 桌面入口启动同一个官方客户端。原列表依赖客户端内部界面，更新后可能需要适配。 |
| 整理已完成的聊天 | 打开插件里的「批量归档」。筛选勾选后，确认页分别列出聊天以及会连带处理的后台任务。提交后逐项回读结果。 |

插件目录优先采用本机明确记录的父子关系，并补充可识别的创建和分叉记录。如果创建历史暂不可读，仍能显示有直接父子关系的聊天，并标注目录不完整。执行任务的后台智能体单独处理。范围限于当前用户、本机可识别的 Codex 聊天。

## 安装

需要官方 Windows Codex 桌面端、Node.js 22+ 和 Python 3.10+。默认插件包含构建好的页面，使用原图标即可打开官方客户端。完整安装还需要 npm。安装不会开启 GPT 的 Windows 登录自启动。

- **交给 Codex 或其他 Agent**。复制指南里的那一句，Agent 会校验固定版本、安装并回读插件登记状态。[一键安装指南](docs/install-agent.md)
- **手动安装插件**。下载市场 ZIP 并解压到长期保留的目录，在含 `.agents` 和 `plugin` 的目录打开 PowerShell。[插件包](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.6/codex-conversation-manager-0.3.0-preview.6-marketplace.zip) · [安装与卸载](docs/independent-modules.zh-CN.md)

```powershell
$cli = Join-Path (Get-AppxPackage OpenAI.Codex).InstallLocation 'app\resources\codex.exe'
& $cli plugin marketplace add .
& $cli plugin add codex-nested-conversations@codex-nested-local
```

- **手动安装原侧栏增强**。解压完整源码，在包含 `package.json` 的目录运行下列两条命令，然后打开增强入口。[完整源码](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.6/codex-nested-conversations-0.3.0-preview.6-source.zip) · [完整安装说明](docs/quickstart.zh-CN.md)

```powershell
npm.cmd ci --omit=dev --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

## 官方更新以后

安装文件和插件登记位于官方程序目录之外。Windows 商店仍负责更新应用。当前测试的官方包为 `26.1027.3384.0`。更新完先从原图标启动，打开插件目录并展开一组聊天；使用原侧栏增强的人再从增强入口检查列表。插件接口、聊天数据结构和原侧栏界面可以独立变化。[更新与排障](docs/faq.zh-CN.md) · [官方扩展说明](https://developers.openai.com/plugins/build/extensions)

## 开发与署名

Mastery-L99 定义使用流程并参与实机验收，使用 Codex 协作开发。项目自写代码采用 MIT 许可，插件页面保留打包组件的上游许可证。[署名与依赖](NOTICE.md) · [测试范围](docs/testing.md) · [批量归档说明](docs/bulk-archive.zh-CN.md)

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run test:runtime
npm.cmd test
npm.cmd run audit:release
```
