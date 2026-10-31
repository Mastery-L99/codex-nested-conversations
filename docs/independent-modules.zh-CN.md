# 同一项目，两个模块

| 功能 | 出现在哪里 | 安装入口 |
| --- | --- | --- |
| 批量归档 | 官方桌面插件中的独立页面，可筛选聊天、多选、核对范围和查看归档结果 | 下载本地插件市场 ZIP。 |
| 嵌套对话 | 最近聊天和项目聊天列表，可以在父聊下面直接展开子聊 | 下载源码 ZIP，安装侧栏适配器，再从增强入口打开现有桌面客户端。 |

归档页面可以独立运行。侧栏适配器可以在桌面客户端的 Codex 和 ChatGPT 两种模式中显示受支持的本机 Codex 聊天。页面中的“嵌套显示”开关只在适配器已经加载时影响这棵树。点击原有官方图标冷启动并自动显示嵌套，目前仍属实验路线。

## 安装归档插件

需要 Windows 上的官方 Codex 桌面客户端、Node.js 22 或更高版本、Python 3.10 或更高版本。桌面应用须能通过 PATH 找到 `node` 和 `python`。修改 PATH 后重新打开应用即可。解释器位置也可以通过 `CNCC_PYTHON` 指定。市场 ZIP 自带预构建页面和页面 SDK，单独使用归档无需安装 npm 依赖或配置侧栏启动器。

1. 下载 `codex-conversation-manager-0.3.0-preview.5-marketplace.zip` 和对应的 SHA-256 校验文件。将 ZIP 解压到准备长期保留的目录。[GitHub 下载页](https://github.com/Mastery-L99/codex-nested-conversations/releases)
2. 在解压后包含 `.agents/plugins/marketplace.json` 的目录中打开 PowerShell，运行下面三条命令来登记本地市场并安装 **Codex 对话管理**。登记时使用包含市场清单的目录路径。
3. 在桌面插件管理中找到 **Codex 对话管理**。按宿主提示重新打开客户端，在新聊天中打开批量归档页面。登记市场后，也可以在桌面端选择 **Codex 对话管理 · 本地** 来源来安装插件。

```powershell
codex plugin marketplace add .
codex plugin marketplace list
codex plugin add codex-nested-conversations@codex-nested-local
```

这些命令在 `codex-cli 0.166.0-alpha.5.1` 上运行通过。若 PowerShell 找不到 `codex` 命令，请参照[安装说明](../README.zh-CN.md)。客户端会把插件来源复制到自己的缓存，建议保留解压后的市场目录，供后续更新使用。登记干净的发行包目录可以避免把个人文件和开发依赖带入插件缓存。

## 在原侧栏安装嵌套显示

下载 `codex-nested-conversations-0.3.0-preview.5-source.zip`，按 [Windows 安装步骤](../README.zh-CN.md)安装。用项目创建的增强入口打开同一个官方桌面客户端，即可加载原列表里的嵌套树。单独安装归档插件只会增加它自己的页面，官方插件宿主没有用于替换原侧栏列表的公开接口。

## 开关和归档范围

页面分别提供归档和嵌套显示开关。两个模块通过 `CNCC_SETTINGS_DIR` 共用设置目录，默认位置为 `%USERPROFILE%\.codex-nested-conversations\settings`。工作数据目录可通过 `CNCC_DATA_DIR` 单独指定。

勾选聊天后，确认页会列出所选聊天、纳入的下级，以及官方操作会一起归档的后台子任务，合计最多 256 条。层级读取失败时，可取消操作，也可明确选择只处理勾选项。在归档期间暂缓给清单里的聊天创建新下级。点击停止会阻止后续提交。结果页分别显示普通聊天和后台任务已经确认的归档数量。[批量归档指南](bulk-archive.zh-CN.md)

独立插件使用本机官方 `codex app-server`。若其他窗口正在持有某条聊天，它会报告写入冲突。侧栏工具栏可通过持有聊天的桌面窗口提交。两种归档入口都只处理当前用户的本机 Codex 聊天，不涉及云端 ChatGPT 聊天、其他账户或远程主机。

## 卸载和更新

```powershell
codex plugin remove codex-nested-conversations@codex-nested-local
codex plugin marketplace remove codex-nested-local
```

以上命令分别移除已安装插件和登记的市场来源。聊天与项目设置保留在本机。升级时，可从新版市场包的解压目录重新安装。插件不会为 GPT 添加 Windows 登录启动项。

修改页面时，编辑 `src/archive-panel-source.js`，运行 `npm ci`，再运行 `node scripts/build-archive-panel.cjs` 重建页面。分发时保留生成 HTML 中的上游许可。[第三方许可说明](../NOTICE.md)
