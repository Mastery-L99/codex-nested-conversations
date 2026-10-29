# Codex Nested Conversations

Keep a complex piece of work together in the official Codex desktop app. Codex Nested Conversations adds a hierarchy to related chats, so a main conversation and its descendants remain easy to find and follow when your sidebar grows crowded.

**Version 0.2.0-preview.1** · Windows · [MIT license](LICENSE) · [中文说明](README.zh-CN.md)

This is an independent runtime enhancement for the official Windows app. It uses the same installed client and account; it does not create a second profile. It is not an officially supported sidebar plugin, and changes to the app's interface or local data structures may require an update to this project.

## What you can do

- **Follow a conversation tree.** Related local Codex chats appear beneath their parent across Recents and project lists, in both Codex and ChatGPT modes. Expand a branch to return to the work you need.
- **Let relationships update as you work.** Successful `create_thread` and `fork_thread` relationships are discovered automatically. Native events trigger updates, with file changes as a fallback; there is no fixed 20-second polling loop.
- **Archive a branch together.** Use the chat menu or `Ctrl+Shift+A`, review the full scope, then choose whether to archive the parent and its descendants or only the parent. Collapsed descendants are included in the full branch. The enhancement archives descendants first, checks each result, and stops if an operation fails.

The tree represents relationships between local Codex chats. Codex subagents are a separate concept and are not added to the tree as child chats. Cascade archive applies to eligible local Codex chats with discovered descendants; it does not cascade through native ChatGPT conversations. Cascading delete is not implemented: the tested native interface does not provide a usable Delete action.

```text
Launch plan
├─ Research
│  └─ Competitor review
├─ Implementation
└─ Validation
```

See [loading and update compatibility](docs/architecture.md) for the current adapter and future plugin options.

## Requirements

- Windows 10 or 11 and the official Codex desktop app. The tested app package version is `26.1023.6621.0`.
- Node.js 22 or later, npm, and Python 3.10 or later.
- The project's public Playwright dependency, pinned to `1.64.1` in the lockfile. The enhancement connects to the installed app and does not require a Playwright browser download.

## Get started

Download the [0.2.0-preview.1 source ZIP](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.2.0-preview.1/codex-nested-conversations-0.2.0-preview.1-source.zip) from the [preview release](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.2.0-preview.1), or clone the [repository](https://github.com/Mastery-L99/codex-nested-conversations). Extract the entire archive and open PowerShell in the project directory. Install the public dependencies, check your environment, preview the installation, and install:

```powershell
npm ci --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The installer creates a separate **Codex Nested Conversations** desktop shortcut. It does not start the app automatically or replace the official entry. If Codex is already running normally, quit it through its menu first, then launch from the enhancement shortcut. Launching from the normal official entry does not currently load the enhancement.

To make your usual pinned icon open the enhancement, replace the old official pin once with the enhancement launch entry and move the new pin to your preferred position. A matching name or icon does not redirect the old pin. After replacement, clicking that pin uses the enhancement entry; launches from official All apps entries, protocol links or automatic startup may still use ordinary mode. See the [user guide](docs/user-guide.md).

The installer uses separate program and data directories under `%LOCALAPPDATA%`. It stops rather than overwrite an existing installation or shortcut. For a reinstall after uninstalling, add `-ReuseData` to reuse the retained data directory if it has this project's identity marker.

## Use the tree

Create or fork a related local Codex chat using Codex's normal workflow. Once the relationship is discovered, find it beneath its parent and expand or collapse the branch. When you are ready to archive a parent with discovered descendants, open its archive menu or press `Ctrl+Shift+A`. The shortcut also works from the conversation body and composer when the current chat can be identified. Review the list in the confirmation dialog before choosing the scope.

Other applications can capture the same keyboard shortcut. If it does not reach Codex, check for a conflicting shortcut. `Ctrl+Alt+Shift+A` is not supported.

For detailed steps and troubleshooting, see the [user guide](docs/user-guide.md).

## Stop or uninstall

To remove the enhancement from the current window and stop its companion process:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Stop.ps1"
```

From the project source directory, preview and run the uninstaller:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

The uninstaller stops the companion and sends the project program directory and its shortcut to the Windows Recycle Bin, retaining separate project data. It recognizes both the current generated shortcut and the project's former entry. If the shortcut's target or arguments were actually changed, uninstall stops and preserves it for review. After uninstalling, quit and reopen the official app normally to close the temporary local debugging endpoint used by the enhancement. The uninstaller does not force the official window to close.

## How it works

The launcher starts the installed official app with a temporary debugging endpoint bound to the local loopback address. A separate companion verifies the endpoint's owning process and loads the interface modules into the running window. The project does not distribute or modify the official installation or its update mechanism. Relationship discovery reads the relevant local data with read-only database connections; generated relationship and preference data stays in the project's separate local data directory.

This approach depends on implementation details of the official app. A future app update can change the UI or local data format and require adaptation. See [runtime integration](docs/runtime-integration.md) and [testing](docs/testing.md) for implementation details and recorded checks.

## Contributing

Issues, reproducible reports and pull requests are welcome. Please include the app and project versions, the steps taken and the observed result. Remove chat titles, IDs, account information, local data and other private material before sharing logs or screenshots. Run the applicable checks before submitting changes:

```powershell
npm run test:runtime
npm test
npm run audit:release
```

`npm test` uses temporary installation directories and does not start the official app. The release audit helps catch common sensitive files and paths; review contributions as well. See [testing](docs/testing.md) and [publishing](docs/publishing.md) for details.
