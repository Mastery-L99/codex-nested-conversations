# Codex Nested Conversations

Keep a large piece of work easy to follow in the official Windows Codex app. Organize related chats beneath a main chat, then review and archive the work you have finished.

**0.3.0-preview.5 · Windows public preview** · [中文](README.zh-CN.md) · [MIT license](LICENSE)

[Download the Windows preview](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.3.0-preview.5) · [Quick start](docs/quickstart.md)

This project keeps **nested conversations and bulk archive together, with separate switches and separate loading paths**. It uses the installed official client and the current local account. It does not create another official client or profile, replace the updater, or enable ChatGPT at Windows sign-in.

## Two modules

| | What it adds | How it runs |
| --- | --- | --- |
| Nested conversations | Expandable parent/child chat lists in Recents and projects | A separately loaded adapter for the original sidebar |
| Independent bulk archive | A plugin page for filtering, selecting, reviewing scope, archiving, and checking progress | The official plugin host and local `codex app-server`; no sidebar adapter, debugging connection, or Windhawk required |

The nested view can display supported local Codex chats in both the Codex and ChatGPT modes. **Archive operations cover eligible local Codex chats only.** Cloud ChatGPT chats, remote hosts, and other accounts are outside the archive module's scope. Subagents remain a separate concept from child chats.

```text
Launch plan
├─ Research
│  └─ Competitor review
├─ Implementation
└─ Validation
```

The archive page has its own switch. A broken or disabled nested view does not have to remove archive access. The nesting switch affects the original lists only while the sidebar adapter is loaded. See [independent modules](docs/independent-modules.md).

## Current preview status

The bulk selector groups children under their parent chats. A check mark and a full-row highlight identify direct selections. Children covered by a selected parent have a separate “随上级归档” label. The toolbar and plugin page call the same archive service, including for chats absent from the current sidebar.

The review names any background tasks that the official archive will also affect and shows their owning chats. Progress counts verified chats and background tasks separately. A change to the reviewed scope requires a fresh review.

The 0.3 plugin is now installed in the daily environment. A dedicated single-chat archive has passed the complete flow in the actual desktop host: open the MCP App, filter and select, review the complete scope, return to edit without losing the selection, confirm, and view the result. The page reported one processed and verified item with no failures; the saved job and an independent local status read agreed. This live check covers that single-chat flow, rather than every multilevel or failure scenario.

Module independence has passed live checks: turning nesting off preserves the archive bridge; turning archive off preserves the tree and blocks enhanced archive plans. With the sidebar companion completely stopped, the independent backend archived a dedicated test chat through the official local app-server. Comparing archive flags for all chats that existed before the operation found only that test chat changed. Both modules were then restored without restarting the official app.

The original sidebar adapter has passed live nested-list and native archive checks. It still needs its loading path. Opening the original official icon does not yet guarantee that the tree loads. The Windhawk approach is an uninstalled prototype, with no Windows service or sign-in startup entry installed by this preview. The user's ChatGPT sign-in startup setting remains off.

This is an independent project. The plugin page uses the official extension mechanism; modifications to the original sidebar rely on app implementation details. Official updates remain enabled, and changes to UI, API, or local schemas may require adaptation. The current development checks use official package `26.1027.3384.0`.

## Downloads and setup

| What you want | Download and open |
| --- | --- |
| Bulk archive in the plugin page | Download the [archive plugin package](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.5/codex-conversation-manager-0.3.0-preview.5-marketplace.zip), extract it to a folder you plan to keep, then register it with the two plugin commands below. |
| Nested sidebar and bulk archive | Download the [full source package](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.5/codex-nested-conversations-0.3.0-preview.5-source.zip), extract it and run the full installer below. Open the **Codex Nested Conversations** desktop shortcut to see the hierarchy in Recents and projects. |

Both packages require Windows, a signed-in official Codex desktop app, Node.js 22+ and Python 3.10+. The archive-only ZIP includes the built page. Open PowerShell in the extracted directory containing `.agents` and `plugin`, then run:

```powershell
$cli = Join-Path (Get-AppxPackage OpenAI.Codex).InstallLocation 'app\resources\codex.exe'
& $cli plugin marketplace add .
& $cli plugin add codex-nested-conversations@codex-nested-local
```

Open the archive page in Codex, or ask a chat to open the bulk archive panel. Node.js and Python must be on the desktop app's PATH. SHA-256 files for both downloads are available on the [release page](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.3.0-preview.5).

To prepare a complete enhancement installation from the source directory:

```powershell
npm.cmd ci --omit=dev --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The installer creates separate program and data directories. It prepares a clean `plugin` subdirectory and a local marketplace pointing only to that directory. It does not automatically register the plugin or start the official app. Follow [independent module setup](docs/independent-modules.md) to add that local source; use the installation root as the marketplace source. Avoid registering a development checkout: the host can copy its dependencies and local files into its plugin cache.

Developers can build a clean plugin-only directory with:

```powershell
npm run build:plugin -- --output-dir .\dist\archive-plugin
```

This output contains the plugin itself, without a marketplace catalog. It is separate from the complete installer and the source-release archive.

## Use and control

Select chats in the archive page, review the full list, and confirm. Including discovered descendants is enabled by default. When relationship data is unavailable, the page requires you to turn that option off before archiving selected chats alone. Each operation is checked; a failure stops later submissions. Stop leaves completed work in place, and the current request may already have completed. There is no bulk undo or bulk delete.

The official archive API may include implicit background descendants and has no atomic condition limiting execution to the reviewed list. The module checks again before submission and reports unexpected effects. Avoid creating new descendants in the same scope while archiving.

When the sidebar adapter is loaded, the native menu and `Ctrl+Shift+A` can review an eligible parent's discovered descendants. Other applications may intercept that shortcut. No alternative archive hotkey is added. Relationships update from native events with file-change fallback; there is no fixed 20-second idle scan. The archive page checks progress while a job is active.

Use the page's separate switches to disable either module. Disabling the entire plugin removes its page and server. To stop the original-sidebar companion while leaving the official app open:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Stop.ps1"
```

For removal, unregister the local plugin before uninstalling its source installation. The project uninstaller sends its marked program directory and shortcut to the Recycle Bin and retains project data. It does not delete user chats or force the official app to close. See [module removal](docs/independent-modules.md#remove-and-distribute) and the [user guide](docs/user-guide.md).

## Development

Mastery-L99 defined the workflow and tested it on Windows, with Codex assisting development. The project’s own code is MIT-licensed. Bundled archive-page components retain their upstream licenses. [Attribution and dependencies](NOTICE.md)

```powershell
npm run test:runtime
npm test
npm run audit:release
```

See [runtime integration](docs/runtime-integration.md), [testing](docs/testing.md), and [third-party notices](NOTICE.md). Contributions should include versions, reproduction steps, and the observed result. Remove chat content, titles, identifiers, account information, and personal paths from shared logs and screenshots.
