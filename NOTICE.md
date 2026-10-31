# 发布与署名

本项目是独立开发的桌面增强工具，与 OpenAI 没有官方隶属关系。Codex、OpenAI 及其他产品名称和商标归各自权利人所有。

仓库只应包含项目作者有权发布的自写代码和说明。官方安装包、图标、网页资源、签名文件、用户会话、账户凭据与本地运行数据均不随项目分发。

本项目自写源码采用 MIT 许可，完整条款见 LICENSE。版权署名为 `Copyright (c) 2026 Codex Nested Conversations contributors`。

package.json 保留 `private: true`，用于避免误发到 npm；它不限制按 MIT 许可在 GitHub 公开源码。

Playwright 通过公开 npm 包提供，使用和分发时保留其随包提供的许可与通知。

## 归档面板内含的第三方代码

`src/archive-panel.html` 是由可读源码 `src/archive-panel-source.js` 和 `scripts/build-archive-panel.cjs` 构建的浏览器包。它包含以下依赖的代码，适用各自的上游许可；本项目的 MIT 许可不替代这些许可：

| 依赖 | 当前包版本 | 上游许可 |
| --- | --- | --- |
| `@modelcontextprotocol/ext-apps` | 1.7.5 | 上游正在由 MIT 转向 Apache-2.0；新代码采用 Apache-2.0，尚未取得重新许可同意的既有贡献保留 MIT。随包 LICENSE 另说明文档贡献的 CC-BY-4.0 条款。 |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT |
| `zod` | 4.6.7 | MIT |
| `zod-to-json-schema` | 3.25.2 | ISC |

构建脚本读取实际打包依赖的 LICENSE，并将原文保留在生成 HTML 的开头注释中。再分发该 HTML 时应保留此注释；升级依赖后重新构建，并同步检查本表。esbuild 是构建工具，其可执行文件不内嵌到面板 HTML。

The archive panel contains the third-party packages listed above. Their upstream license texts are preserved in the leading comment of the generated HTML. Keep those notices when redistributing the bundle. The project's MIT license covers its own source and does not relicense third-party code. The ext-apps package is undergoing an MIT-to-Apache-2.0 transition; its complete upstream LICENSE controls the individual contributions.
