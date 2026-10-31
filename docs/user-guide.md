# User guide

[中文使用指南](user-guide.zh-CN.md) · [Project overview](../README.md)

Codex Nested Conversations adds a hierarchy to related chats in the official Windows Codex desktop app. Use a main chat to coordinate work and open its child chats from the same sidebar. This is a relationship between chats; Codex subagents are a separate feature.

The enhancement runs alongside the official client using the same account and local environment. It is a preview and depends on the client's current interface and local data structures, so a future Codex update may require an adaptation.

## Requirements

- Windows 10 or 11 and the official Codex desktop app. The tested package version is `26.1027.3384.0`; other versions may behave differently.
- Node.js 22 or later, npm, and Python 3.10 or later, available on your `PATH`.
- A copy of this repository, including its `src`, `scripts`, and `docs` directories. Download the [0.3.0-preview.5 source ZIP](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.5/codex-nested-conversations-0.3.0-preview.5-source.zip) or clone the [repository](https://github.com/Mastery-L99/codex-nested-conversations), then open PowerShell in its root directory.

The installer needs the public Playwright `1.64.1` package from the lockfile. It connects to the existing desktop app and does not need a Playwright browser download. The execution-policy option used below applies only to that PowerShell process; it does not change the system execution policy.

```powershell
npm.cmd ci --omit=dev --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

The diagnostic checks the dependencies, runtime files and installed Codex package without starting the app. Install missing prerequisites yourself and rerun the check.

## Install and launch

Review the proposed installation first, then install:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The default program folder is `%LOCALAPPDATA%\CodexNestedConversations`; separate project data is stored in `%LOCALAPPDATA%\CodexNestedConversationsData`. Installation creates a **Codex Nested Conversations** desktop shortcut and does not start the app. It refuses to overwrite an existing installation or shortcut. To reuse project data left by an earlier uninstall, add `-ReuseData` to the install command; the installer checks the data folder's project marker first.

Start using the dedicated desktop shortcut. If Codex is already running normally, choose **File → Exit** in Codex, then open the dedicated shortcut. The enhancement uses the official app and account; it does not create a second profile. Launching from the ordinary official shortcut does not automatically load the enhancement in this version.

Alternatively, launch the default installation from PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Start.ps1"
```

The launcher uses a temporary debugging endpoint bound to the local loopback interface and checks the owning official process before connecting. If it reports a port conflict or another enhancement version, resolve that condition before retrying; it does not force-close the official app.

### Use your usual pinned icon

Replace the pinned launch entry once if you want your usual Start-menu or taskbar position to open the enhancement. Unpin the old official entry, pin the enhancement launch entry, and move the new pin to your preferred position. If you use the same display name or icon, check the entry's destination rather than its appearance. Windows may retain the old MSIX pin until you remove it manually.

After replacement, that pin opens the enhancement entry. This does not intercept every way of launching Codex: official All apps entries, protocol links and automatic startup may still open ordinary mode. If an ordinary instance is already running, exit it from the app menu before using the enhancement entry.

## Find and navigate related chats

Relations created through `create_thread` or `fork_thread` are discovered automatically. In the sidebar, expand or collapse a parent to see its descendants, and select a chat to open it. Nesting is available in Recents and project lists, in both Codex and ChatGPT modes. It reflects detected chat relationships, not the hierarchy of subagents.

Changes are picked up from client events, with local file changes as a fallback. There is no fixed 20-second polling cycle. If a relationship does not appear, allow the operation to finish and check that the enhancement was launched and the chats are available in the current view.

## Archive a chat and its descendants

1. Select a local Codex chat with discovered descendants, then choose **Archive** from its chat menu or press `Ctrl+Shift+A`. The shortcut works from the chat body and the composer when the current chat can be identified.
2. Review the full list in the confirmation dialog. Collapsing a branch does not remove its descendants from the scope.
3. Choose **Archive all**, **Archive only this chat**, or cancel. Archiving all proceeds from descendants toward the parent and verifies each result. If an operation fails, processing stops; review the displayed progress before deciding what to do next.

Cascade archive does not apply to native ChatGPT conversations. Other applications can intercept `Ctrl+Shift+A`; resolve a shortcut conflict if the confirmation does not appear. No `Ctrl+Alt+Shift+A` alternative is provided. Cascade delete is not implemented because the native interface does not provide an available Delete action.

## Stop or uninstall

To remove the enhancement from the current window and stop its companion process without closing Codex:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Stop.ps1"
```

From the source repository, preview and then run the uninstaller:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

The uninstaller checks the installation identity, stops the companion and sends the project shortcut and program folder to the Windows Recycle Bin. It retains the separate project data directory and leaves official chats, account and configuration outside its scope. After stopping or uninstalling, exit and restart Codex through its official entry to close the temporary debugging endpoint.

The installer and uninstaller share the shortcut definition, and uninstall also recognizes the project's former exact entry. If the target or arguments were actually changed, uninstall stops and preserves the shortcut and program folder. Inspect the changed entry before retrying; do not assume that a stopped run completed.

## Scope and privacy

This is an independent runtime enhancement, not an officially supported sidebar plugin. It does not replace the official installation or its update process. Relation discovery reads the local database through a read-only connection; archive actions use the visible native workflow. Project runtime data stays in its separate local folder. Review the source and [runtime integration notes](runtime-integration.md) for the implementation and [testing notes](testing.md) for the recorded verification scope.
