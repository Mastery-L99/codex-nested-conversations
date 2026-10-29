# 运行模块整合约定

安装器与自写运行模块采用以下约定。每次修改这些约定后，应逐项做实际启动和卸载验证。

## 目录与依赖

- 安装器把 src/ 清单内的源文件复制到安装目录的 app/，公开 Playwright 依赖放到安装目录的 node_modules/。
- 运行模块通过 `require('playwright')` 引入公开 npm 包，禁止引用 Codex 自带依赖目录。
- `CNCC_NODE`、`CNCC_PYTHON` 为安装时检测到的可执行文件绝对路径。Python 应使用已检测的解释器，不依赖官方 bundled runtime。
- `CNCC_DATA_DIR` 指向独立运行数据目录。relations.json、runtime-status.json、stop-request.json、ui-preferences.json、运行选项、日志和临时文件均写到这里。
- 源文件通过 `__dirname` 或 `$PSScriptRoot` 定位；不得把源文件位置当作运行数据目录。
- 用 `$env:USERPROFILE`、`$env:LOCALAPPDATA` 和受支持的应用发现机制定位用户与应用，源代码中不写开发者的绝对路径。
- `runtime-main.cjs`、`event-index.cjs`、`preload-relay.cjs` 和 `host-events.js` 一同分发。模块间用相对源码路径加载，不通过生产安装目录引用。

## 启动、停止与端点

- `Start-NestedConversations.ps1` 支持 `-CheckOnly`，检查不能启动进程、改入口或写个人数据。
- 检查模式沿用 `CNCC_*` 环境变量。安装器的 Start.ps1 只透传这些变量和 `-CheckOnly`，不补造关系文件、不回退到另一个 profile。
- 启动仅连接官方安装对应的进程，调试端点仅允许回环地址。地址或所有者不匹配时停止。
- 官方应用处于普通运行模式时提示正常退出后重开；不强制结束应用，不创建另一个 profile。
- `Stop-NestedConversations.ps1` 只停止本项目旁路进程，移除注入样式、事件监听、菜单和全局绑定，成功状态为 `stopped_ui_restored`。停止失败应返回非零退出码。
- 停止不能调用 `browser.close()` 关闭官方应用；结束本项目的连接与进程即可。
- 节点、Python 或公开依赖缺失时直接说明，禁止静默下载或借用官方内部库。

## 数据与操作

- 关系发现使用只读数据库连接。首次运行自行生成关系文件，不分发开发者的关系或偏好。
- 不读取或复制账户凭据；不把聊天内容、标题与 ID 上传到外部服务。
- 归档等真实操作走最终选定的用户可见流程，所选项、后代范围和结果需要明确反馈。
- 事件驱动的关系更新要在退出时移除所有监听。不要为填充数据退回固定高频全量扫描。
- 快捷键应避免在输入框、组合输入、原生菜单或其他对话框中误触发，停止增强时完整解绑。

## 安装器门槛

runtime-manifest.json 是允许分发的源文件清单。增加模块时同步清单；每一项必须是 src/ 内的普通源码文件，不得包含路径跳转或重解析点。

将源码复制完毕并不代表与安装器兼容。只有环境变量、首次关系生成、只读数据访问、启动检查和停止恢复都接通后，才能把发行版称为可安装版本。
