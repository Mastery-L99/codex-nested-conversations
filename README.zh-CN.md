# Codex Nested Conversations

让一件大型任务围绕主聊天展开：调研、实施、验证各自有独立聊天，也能在原来的列表中找到彼此，完成后再一起整理归档。

**0.3.0-preview.5 · Windows 公开预览** · [English](README.md) · [MIT 许可证](LICENSE)

[下载 Windows 预览版](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.3.0-preview.5) · [快速开始](docs/quickstart.zh-CN.md)

项目把**嵌套显示和批量归档放在同一个仓库，分别启停、分别维护**。继续使用本机官方客户端和当前账户，不安装另一份官方应用、不创建第二个 profile、不替换官方更新器，也不打开 ChatGPT 的开机自启动。

## 两个模块

| 模块 | 带来的体验 | 加载方式 |
| --- | --- | --- |
| 嵌套对话 | 最近聊天和项目列表中的父子层级，可折叠、展开 | 单独加载适配原侧栏的界面模块 |
| 独立批量归档 | 插件页面内筛选、多选、检查范围、确认归档、查看进度 | 官方插件宿主和本机 `codex app-server`；不依赖侧栏适配器、调试连接或 Windhawk |

支持的本地 Codex 聊天可以在 Codex、ChatGPT 两种模式的列表中显示层级。**实际归档仅覆盖符合条件的本机 Codex 聊天**，不包含云端 ChatGPT 聊天、其他账户或远程主机。执行子任务的 subagents 与这里的子聊天分别管理。

```text
项目主聊天
├─ 调研
│  └─ 同行案例
├─ 功能实现
└─ 测试验收
```

归档有自己的入口和开关，嵌套显示关闭或加载失败时，仍可以保留归档通路。页面中的嵌套开关保存显示偏好；原侧栏适配器已经加载时，它才会改变原列表。详见[独立模块说明](docs/independent-modules.zh-CN.md)。

## 当前进展

批量归档选择页按父子层级排列。展开主聊天就能看到下级，手动选中后整行高亮并显示勾号。开启“同时归档下级”时，受影响的子项会标注“随上级归档”。左上角按钮与独立插件页面共用同一套归档服务，聊天折叠或未出现在当前侧栏时也能提交。

确认页还会单列官方归档将连带处理的后台子任务，并显示各自所属的聊天。提交后，聊天和后台子任务分别核对结果。确认期间出现新任务或范围变化时，需要重新查看清单。

0.3 插件已经安装到日常环境，并在实际桌面宿主完成一条专用测试聊天的完整归档流程：打开 MCP App、筛选勾选、检查完整范围、返回修改后保留选择、再次确认、提交并查看结果。页面显示已处理和已确认各 1 条、失败 0 条，持久任务记录和独立状态读取也与之吻合。这次实机覆盖单项闭环，多级和故障场景仍按各自测试范围记录。

模块独立性也已实机跑通：关闭嵌套后归档桥接仍正常；关闭归档后目录树保留，增强归档计划被阻止。彻底停止侧栏伴随模块后，独立后端通过官方本机 app-server 归档了一条专用测试聊天；对执行前已存在聊天逐项比较归档状态，只有该测试项发生变化。随后恢复两个模块，整个过程没有重启官方应用。

原侧栏模块已经完成嵌套列表、原生菜单和归档的实机检查，仍然需要相应的加载入口。直接点击原官方图标，目前还不能保证自动出现嵌套。Windhawk 路线只是尚未安装的原型，本预览没有安装它的服务或 Windows 登录启动项。ChatGPT 开机自启动保持关闭。

这是独立开源项目。归档页面采用官方扩展机制，原侧栏的改动依赖客户端内部界面。官方更新保持正常；界面、接口或本地数据结构发生变化时，适配模块可能需要更新。当前开发验证使用的官方包版本为 `26.1027.3384.0`。

## 下载与准备

| 你想要的功能 | 下载和打开方式 |
| --- | --- |
| 只装批量归档 | 下载[归档插件包](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.5/codex-conversation-manager-0.3.0-preview.5-marketplace.zip)，解压到一个长期保留的目录，按下方两条命令安装。之后从官方插件页面打开。 |
| 嵌套侧栏和批量归档 | 下载[完整源码包](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.5/codex-nested-conversations-0.3.0-preview.5-source.zip)，解压后运行下方完整安装命令。打开桌面上的 **Codex Nested Conversations** 入口，最近聊天和项目列表即可显示层级。 |

两个版本均需要 Windows、已安装并登录的官方 Codex 桌面端、Node.js 22+ 和 Python 3.10+。归档插件包已包含构建好的页面。在解压后包含 `.agents` 和 `plugin` 的目录打开 PowerShell，运行：

```powershell
$cli = Join-Path (Get-AppxPackage OpenAI.Codex).InstallLocation 'app\resources\codex.exe'
& $cli plugin marketplace add .
& $cli plugin add codex-nested-conversations@codex-nested-local
```

打开 Codex 中的归档页面，或在聊天里说「打开批量归档面板」。插件启动的子进程需要能从 PATH 找到 Node.js 和 Python。下载校验文件随两种 ZIP 一起提供。[版本与校验文件](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.3.0-preview.5)

在源码目录打开 PowerShell，准备完整增强安装：

```powershell
npm.cmd ci --omit=dev --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安装器创建独立程序、数据目录，准备干净的 `plugin` 子目录，并生成只指向该子目录的本地插件来源。它不会自动注册插件或启动官方应用。添加本地来源时使用安装根目录，具体步骤见[模块安装说明](docs/independent-modules.zh-CN.md)。不要直接登记带有依赖、开发缓存和个人资料的工作目录；宿主可能把来源中的这些文件一并复制到插件缓存。

开发者可单独生成干净的插件目录：

```powershell
npm run build:plugin -- --output-dir .\dist\archive-plugin
```

该目录只包含插件本体，不含 marketplace 目录；它与完整安装目录、源码发行包分别使用。

## 使用与控制

在归档页面勾选聊天，检查确认页的完整清单，再提交。默认包含已发现的下级；层级读取失败时，页面会要求你手动取消该选项，才能只处理勾选项。归档逐项检查结果，失败后停止后续提交。停止会保留已完成部分，当前请求可能已经完成；目前没有批量撤销或批量删除。

官方归档可能连带后台子任务，接口也没有提供“只处理这份确认清单”的原子条件。模块在提交前再次检查范围，并反馈发现的异常影响。归档期间请避免同时在该范围内创建新下级。

原侧栏模块加载后，可从原生菜单或按 `Ctrl+Shift+A` 检查父聊天及已发现下级的归档范围。其他软件可能占用此快捷键，项目没有增加备用组合键。层级通过原生事件更新，并以文件变化补充触发，没有固定的 20 秒空闲扫描；归档页面只在任务执行期间查询进度。

页面顶部两个开关分别控制归档和嵌套。关闭整个插件会使其页面、服务不可用。停止原侧栏伴随模块、保留官方窗口，可运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Stop.ps1"
```

移除安装前，先解除本地插件登记，再卸载其来源。项目卸载器将带有身份标记的程序目录和专用快捷方式送入回收站，保留项目数据，不删除用户聊天，也不强制关闭官方应用。具体操作见[模块移除说明](docs/independent-modules.zh-CN.md#移除与分发)与[使用指南](docs/user-guide.zh-CN.md)。

## 开发与贡献

Mastery-L99 提出需求、设计使用流程并参与实机验收，使用 Codex 协作开发。自写部分采用 MIT 许可，归档页面内含的开源组件保留各自的许可证。[署名与依赖](NOTICE.md)

```powershell
npm run test:runtime
npm test
npm run audit:release
```

实现约定见 [runtime-integration.md](docs/runtime-integration.md)，验证范围见 [testing.md](docs/testing.md)，第三方许可见 [NOTICE.md](NOTICE.md)。报告问题时请说明版本、复现步骤和实际结果，并移除聊天正文、标题、标识、账户信息及个人路径。
