# Windows quick start

This guide covers `0.3.0-preview.6`, an independent open-source enhancement that displays nested conversations in the same official Codex desktop window. It does not install a second Codex client. The tested official app package is `26.1027.3384.0`; other versions may need adaptation.

## 1. Prerequisites

Use Windows 10/11 with the official Codex desktop app installed, Node.js 22 or later with npm, and Python 3.10 or later. Reopen PowerShell after installing these tools so they are on the command path. Administrator access is not required. The project uses the public Playwright `1.64.1` npm dependency; no Playwright browser download is needed.

## 2. Download and extract

For the official plugin panel from the original icon, use the [one-instruction installation guide](install-agent.md). For the tree directly inside the native lists, download the [full source ZIP](https://github.com/Mastery-L99/codex-nested-conversations/releases/download/v0.3.0-preview.6/codex-nested-conversations-0.3.0-preview.6-source.zip), extract it, and open the directory containing `package.json`, `scripts`, and `src`. For bulk archive alone, use the [archive plugin package and two-step installation](independent-modules.md).

Type `powershell` in that folder's address bar and press Enter. Run these commands in order:

```powershell
npm.cmd ci --omit=dev --ignore-scripts
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

Wait for each command to finish. Continue when doctor reports `Environment checks passed`. Run it after installing dependencies: it checks Node, Python, npm, Playwright, runtime files, and the official app package without starting the app or determining whether that app version has been tested. See the [FAQ](faq.md) for troubleshooting.

## 3. Install and start

Preview the installation, then install:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The preview shows the program and data locations and desktop shortcut without installing. Defaults are `%LOCALAPPDATA%\CodexNestedConversations` for the program and `%LOCALAPPDATA%\CodexNestedConversationsData` for its separate data. Installation does not start Codex. An existing install directory or same-named shortcut causes it to stop rather than overwrite it.

If Codex is running normally, exit it through **File → Exit**, then double-click **Codex Nested Conversations** on the desktop. Alternatively run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Start.ps1"
```

The first start builds a relationship index. The ordinary official entry and a pinned official Start-menu icon may bypass the enhancement; use the dedicated entry above for the nested list. It connects to the same official app and account without creating another profile. A temporary debugging endpoint is bound to the local loopback address while running.

## 4. Use and stop

Real relationships created by creating or forking chats appear automatically as a multilevel tree in Recents and project views. The relationship index recognizes local Codex user chats; recognizable local relationships can be displayed in the Codex and ChatGPT sidebar views, while cloud chat relationships are outside its current scope. Client events trigger updates, with file changes as a fallback; there is no fixed 20-second full-scan loop.

Choose archive from a parent chat's menu, or select the parent and press `Ctrl+Shift+A`, then review the confirmation scope. When archiving all, collapsed descendants are included. Descendants are processed before the parent and local state is read to verify each result. Processing stops on failure; already archived chats are not automatically undone. You can also archive only the current chat. If a screenshot tool or another application captures the shortcut, adjust the conflicting setting. There is no alternate shortcut or cascade delete in this version.

To stop the enhancement while keeping the official window open:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\CodexNestedConversations\scripts\Stop.ps1"
```

## 5. Uninstall and upgrade

From the extracted project root, preview and then uninstall:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

The uninstaller checks the installation identity, stops the enhancement, and sends its program folder and dedicated shortcut to the Recycle Bin. Its separate data folder is retained by default; official chats and account data are outside the uninstall scope. Exit and reopen the official app normally afterward to close the temporary endpoint with the original process.

The uninstaller recognizes the project's current shortcut and its former launch format. If someone changes the target or arguments, it stops and preserves the shortcut for review. See the [FAQ](faq.md).

The installer does not upgrade in place. Obtain the new version, install its dependencies and run doctor. Then preview and complete uninstall with the old version's uninstaller; if the issue above blocks it, wait for a correction first. From the new version's folder, install with `-ReuseData` to reuse retained data bearing this project's identity marker:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -ReuseData -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -ReuseData
```

For custom locations, supply the corresponding `-InstallDir` and `-DataDir` to the applicable commands and inspect the preview. Keep the old extracted source until the upgrade is complete.
