# 运行模块

独立批量归档和侧栏嵌套界面共用本仓库。安装器通过运行清单选择文件。清单中的 `archiveFiles` 是独立插件运行所需的子集，`files` 列出完整桌面增强包使用的文件。[运行清单](../runtime-manifest.json)

- **独立归档页面。** `archive-server.cjs` 提供插件工具和页面资源，`archive-core.cjs` 负责确认范围和执行次序，`archive-app-server.cjs` 通过本机官方程序发起归档并回读结果。`archive-panel-source.js` 是页面的可编辑源码，`archive-panel.html` 是包含上游 SDK 许可声明的构建产物。
- **侧栏嵌套与工具栏。** `runtime-main.cjs` 连接当前官方窗口，`nested-ui.js` 将父子聊天显示在最近列表和项目内。`toolbar-archive.cjs` 将工具栏操作交给同一归档服务，`desktop-archive.cjs` 通过该窗口持有的连接提交请求。侧栏适配器使用项目的增强入口加载。

安装后的程序文件与项目运行数据分别保存。通过 `CNCC_DATA_DIR` 可指定工作数据目录。更多说明见[运行约定](../docs/runtime-integration.md)和[第三方许可](../NOTICE.md)。
