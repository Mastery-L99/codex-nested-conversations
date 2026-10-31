# Release notes / 发行说明

## 0.3.0-preview.6

默认插件新增「嵌套对话」目录，可作为官方插件全屏页面或聊天侧面板使用。目录支持主聊天聚焦、搜索、展开子孙和打开本机聊天。持久父子记录优先于冲突的创建历史，历史不可用时显示部分目录。原项目列表的折叠树仍由可选的完整增强提供。

Windows 安装支持给 Codex 或其他本机 Agent 一句话。脚本校验发布包，通过官方 CLI 回读登记结果，也提供只读的 `--check`。Windows 商店仍负责官方客户端的更新。[一键安装指令](install-agent.md) · [更新与兼容性](faq.zh-CN.md)

The default plugin adds a nested chat browser on the official plugin and conversation panel surfaces. Search, focus a root, expand descendants, or request navigation to a local chat. The optional full install adds the original-list adapter. Windows agents can install the pinned release or check the registered version using the [agent installation guide](install-agent.md).

## 0.3.0-preview.5

本版提供完整源码包和可独立安装的归档插件包。原侧栏在增强入口启动后，按父子关系显示最近聊天和项目聊天。批量归档支持筛选、跨分支勾选，确认页分别列出聊天和受影响的后台任务。工具栏能通过当前窗口归档它自己持有的空闲聊天。已归档数量按本机回读结果显示。

The full source package adds the nested sidebar and toolbar archive. The smaller marketplace ZIP installs the standalone archive page using the official plugin CLI. The sidebar needs the project's desktop shortcut. Both packages use the user's existing Windows client and account. The tested official package is `26.1027.3384.0`. See the [English guide](quickstart.md) or [中文指南](quickstart.zh-CN.md).

## 0.2.0-preview.1

### English

An independent MIT-licensed Windows enhancement for the official Codex desktop app. Tested on Windows with official app package `26.1023.6621.0`; Windows 10/11, Node.js 22+, npm, and Python 3.10+ are required. It uses public Playwright `1.64.1`. Other official app versions may require adaptation.

- Automatically displays actual create/fork relationships among recognizable local Codex user chats as a multilevel tree in Recents and project views, including the Codex and ChatGPT sidebar views. Cloud chat relationships are outside the current index. Client events trigger updates, with file changes as fallback; no fixed 20-second full-scan loop.
- A parent chat's menu or `Ctrl+Shift+A` opens an archive scope confirmation. Archiving all includes collapsed descendants, processes descendants before the parent, and checks local archive state after each action. Processing stops on failure. Archiving only the current chat is also available.
- The native interface has no usable Delete action for this feature; cascade delete is not implemented. No alternative archive shortcut is provided. Other software can capture `Ctrl+Shift+A`.
- Install creates a launch entry for the same official client and account. Replacing the old Start pin once lets the familiar icon load the enhancement; this route has been cold-start tested. All apps, protocol links and automatic startup can still bypass it. A temporary loopback debugging endpoint is used while running. See [loading and compatibility](architecture.md).
- Stop removes the enhancement while keeping the official window open. Uninstall sends the program and its dedicated shortcut to the Recycle Bin while retaining project data. Shortcut creation and removal share the same identity definition, with compatibility for this project's former launch format. Actual shortcut modifications are preserved for review. Restart the official app normally afterward to close the temporary endpoint.

Validation includes 47 installation assertions and four runtime test groups, including 31 shortcut checks. A fresh installed copy was started and stopped against the same official window; after Stop, enhancement-owned nodes and hidden flat rows were both zero. A real uninstall recycled the program and retained its data. Archive execution used dedicated test chats and verified their local archived state. Separately, after a conflicting screenshot shortcut was disabled, the user physically pressed `Ctrl+Shift+A` and confirmed the complete scope, then cancelled. See the [testing record](testing.md). These observations do not establish compatibility with other official app versions.

[Quick start](quickstart.md) · [FAQ](faq.md)

### 中文

本版是采用 MIT 许可的独立 Windows 增强工具，连接官方 Codex 桌面应用。实机适配的官方应用包版本为 `26.1023.6621.0`；需要 Windows 10/11、Node.js 22+、npm 和 Python 3.10+，使用公开的 Playwright `1.64.1`。其他官方版本可能需要适配。

- 自动将可识别的本机 Codex 用户聊天中由创建或 fork 产生的真实关系展示为多层树，覆盖最近聊天和项目视图，包括 Codex 与 ChatGPT 侧栏视图；当前索引不识别云端聊天关系。客户端事件触发更新，文件变更提供兜底，没有固定 20 秒的全量轮询。
- 父聊天菜单或 `Ctrl+Shift+A` 打开归档范围确认。选择全部时包含折叠的后代，先处理后代、再处理父聊天，逐项读取本地归档状态验证；出错时停止。也可以只归档当前聊天。
- 当前原生界面没有可供此功能使用的 Delete 操作，未实现级联删除；没有备用归档快捷键。其他软件可能占用 `Ctrl+Shift+A`。
- 安装为同一官方客户端和账户创建启动入口。一次替换旧的开始菜单固定项后，可以继续点习惯的图标加载增强，已完成冷启动验收。“所有应用”、协议链接和自动启动仍可能绕过该入口。运行时使用本机回环调试端点，详见[加载与兼容](architecture.md)。
- Stop 移除增强并保留官方窗口。卸载将程序和专用快捷方式送入回收站，保留项目数据。创建与卸载共用入口身份定义，并兼容本项目旧版参数；实际被修改的快捷方式会被保留供检查。卸载后正常重启官方应用以关闭临时端点。

验证包括 47 项安装断言和 4 组运行回归，其中快捷键检查 31 项。全新安装副本已在同一官方窗口完成启动和停止；Stop 后增强节点与隐藏项均为 0。实际卸载将程序回收并保留数据。归档提交使用专门测试聊天，并读取本地状态验证。用户另外关闭截图键冲突、亲按 `Ctrl+Shift+A`，确认完整范围后取消。完整记录见[测试说明](testing.md)，适配范围仍限于已测试版本。

[快速开始](quickstart.zh-CN.md) · [常见问题](faq.zh-CN.md)
