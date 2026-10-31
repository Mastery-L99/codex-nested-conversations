# Codex Nested Conversations

Keep research, implementation and review chats under one project conversation. Expand the tree to return to a specific task, or review a group of completed chats for bulk archive. The project uses the existing official Windows desktop client, account and local chats.

**0.3.0-preview.6 · Windows preview** · [中文](README.zh-CN.md) · [Downloads](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.3.0-preview.6) · [One instruction for your agent](docs/install-agent.md)

## Choose a surface

| What you want | How to open it |
| --- | --- |
| A tree in a plugin page or beside a chat after opening the original GPT icon | Install the default plugin. In a desktop host that supports these entrypoints, open **嵌套对话**, or ask a chat to open the nested conversation directory. Expand a parent to find its children. |
| Expand chats directly inside Recents and project lists | Also install the full sidebar enhancement. Open the **Codex Nested Conversations** shortcut to launch the same official client. This adapter depends on the desktop interface and can need changes after an update. |
| Archive finished chats | Use the plugin's bulk archive page. Review the selected chats, descendants and affected background tasks before confirming. Progress is based on stored archive state. |

The tree prefers explicit parent links from local Codex metadata and supplements them with recognized creation and fork events. When creation history is unavailable, the directory labels the partial view and still shows directly attached chats. Background agent tasks are separate from user chats. The supported scope is the current user's local Codex history.

## Install

Install the official Codex desktop app for Windows, Node.js 22+ and Python 3.10+. The default plugin includes the built UI. The full sidebar installation also needs npm. These installers leave the application's Windows sign-in startup preference alone.

- **With Codex or another agent**, paste the instruction from the [agent installation guide](docs/install-agent.md). The installer checks the pinned version and reads back its plugin registration.
- **Manual plugin installation**. Download the marketplace ZIP and extract it to a folder you plan to keep. Open PowerShell in the folder containing `.agents` and `plugin`. [Plugin ZIP](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.6/codex-conversation-manager-0.3.0-preview.6-marketplace.zip) · [Plugin installation and removal](docs/independent-modules.md)

```powershell
$cli = Join-Path (Get-AppxPackage OpenAI.Codex).InstallLocation 'app\resources\codex.exe'
& $cli plugin marketplace add .
& $cli plugin add codex-nested-conversations@codex-nested-local
```

- **Manual sidebar installation**. Extract the source ZIP, run these commands in the folder containing `package.json`, then open the enhanced shortcut. [Full source](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.6/codex-nested-conversations-0.3.0-preview.6-source.zip) · [Windows quick start](docs/quickstart.md)

```powershell
npm.cmd ci --omit=dev --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

## After an official update

Windows Store keeps managing updates. The plugin and adapter live outside the official application package. The tested desktop package is `26.1027.3384.0`. After updating, open the original app icon, open the plugin tree and expand a known parent. If you also use the sidebar adapter, check it from the enhanced shortcut. The plugin API, local metadata schema and sidebar layout can change independently. [Update FAQ](docs/faq.md) · [Official plugin extensions](https://developers.openai.com/plugins/build/extensions)

## Development and attribution

Mastery-L99 defined and tested the workflow, with Codex assisting development. The project's own code uses the MIT license. The bundled UI components retain their upstream notices. [Licenses and dependencies](NOTICE.md) · [Testing](docs/testing.md) · [Archive guide](docs/bulk-archive.md)

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run test:runtime
npm.cmd test
npm.cmd run audit:release
```
