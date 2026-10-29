# GitHub 发布范围

仓库用于分发自写增强代码，不包含官方 Codex 安装包或另一个客户端。建议先以源码仓库发布，待多版本验证后再提供签名安装包。

## 首次公开前

- 核对 src/ 与 runtime-manifest.json 的文件清单一致，不引入开发者绝对路径或官方 bundled runtime 依赖。
- 运行环境检查、源码语法检查、发布扫描，以及 docs/testing.md 的实际安装和卸载验证。
- 本项目采用 MIT 许可，发布时包含 LICENSE，并保留第三方依赖随包提供的许可与通知。
- 通读差异与 Git 暂存文件，只加入本仓库文件。截图使用新建演示数据，避免显示个人聊天标题、ID、账户和工作资料。
- 发行说明列明官方应用版本、Windows 版本、功能范围、安装与恢复方法，以及更新后可能需要适配的部位。

## 分发边界

公开仓库排除数据库、profile、auth、sessions、relations、运行状态、偏好、诊断快照、个人备份与官方图标。`.gitignore` 是便利工具；执行 `git add -f`、改变文件名或把个人信息写进源码仍可绕过它。

`npm run audit:release` 检查项目目录中的高风险文件名、用户绝对路径、官方 bundled runtime 引用与常见令牌格式。它不识别所有业务信息，不读取外部个人目录，也不代替作者对代码权属的判断。

## 官方插件边界

官方插件文档支持通过 manifest 组织技能、MCP、应用资源和手动安装场景的生命周期钩子。文档没有提供用于改造原生聊天侧边栏的公开 UI 扩展点。本项目的侧边栏增强依赖运行时页面结构，应在 README 和发行说明中称为独立增强工具。

官方文档还说明，包含生命周期钩子的插件不能提交到公共插件目录。因此 GitHub 分发、手动安装的插件与公共插件目录提交需要分别判断；本项目当前不生成官方插件 manifest，也不以插件 hook 作为页面注入的保证。

来源（2026-10-30 阅读）：[Package your plugin](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)、[Hooks](https://learn.chatgpt.com/docs/hooks)。
