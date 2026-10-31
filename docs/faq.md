# FAQ

## How does this differ from the built-in list of created chats?

Desktop package `26.1027.3384.0` can show a chat's created chats inside its summary. Codex also offers `/side` for ephemeral follow-up conversations. The plugin directory lets you search across roots and follow multiple levels of relationships, including in a conversation panel. The optional adapter adds folding directly to Recents and project lists. [Official command reference](https://learn.chatgpt.com/docs/developer-commands#start-a-side-chat-with-side)

## Can the official desktop app still receive updates?

Both modules keep their files outside the signed desktop package. Windows Store continues to manage that package. On the test machine, the Store successfully upgraded the client from `26.1023.6621.0` to `26.1027.3384.0` after an earlier sidebar enhancement was installed. The standalone archive plugin and the newer nesting panel were installed after that update.

## What should I check after updating the desktop app?

A desktop restart ends the current in-process sidebar adaptation. Open the original app icon and expand a known parent in the nested panel. If you use the original-list adapter, launch the enhanced shortcut and check the same pair there. Changes to the host API, local chat metadata or original sidebar can require a compatible plugin release. The installer’s `--check` reads the package version and plugin registration. Expand and open a chat in the UI to verify actual behavior. No archive operation is needed.

For `0.3.0-preview.6`. See the [Windows quick start](quickstart.md) for commands.

## Doctor reports missing dependencies or the official app

Run `npm ci --ignore-scripts` in the extracted project root first, then run doctor. Install Node.js 22+, npm, and Python 3.10+, reopen PowerShell, and check `node --version`, `npm --version`, and `python --version`. Python can also be found through the Windows `py` launcher. Doctor looks for the installed official Codex package; if it cannot uniquely locate it, check the official app installation. The scripts do not download these tools or start the app.

## The install directory or shortcut already exists

The installer refuses to overwrite an existing program directory or same-named desktop shortcut. Check for an existing installation. For an upgrade, follow the uninstall and `-ReuseData` steps in the quick start. An existing data directory can only be reused if it has this project's identity marker. A marked partial installation left after an error can be previewed and handled with the source uninstaller; do not remove files belonging to something else.

## The list is still flat after starting

The ordinary official entry may bypass the enhancement, including a pinned official Start-menu icon. Exit through Codex **File → Exit**, then use the dedicated desktop shortcut or the `Start.ps1` command in the quick start. The first start builds a relationship index; the tree uses actual create or fork relationships. Check that the parent is in Recents or the relevant project. Run `doctor.ps1` and check the official app version: this release was tested against package `26.1027.3384.0`; an official update can change the UI or local data structure.

To keep using your usual pinned position, replace the old official pin once with the enhancement entry and move it where you want it. The same name or icon does not redirect an existing pin. Official All apps entries, protocol links and automatic startup can still bypass the enhancement. See the [user guide](user-guide.md).

If the launcher reports ordinary mode is still running, exit from the app menu instead of forcibly terminating it. If it reports a busy port or another enhancement version, investigate the conflict or stop the old enhancement as indicated. Running Start from PowerShell normally exposes the specific error.

## The shortcut does not work

Select the parent chat and press `Ctrl+Shift+A`. A screenshot utility or another application may capture the combination; adjust that application's shortcut. You can also use the chat menu's archive action. There is no alternate shortcut in this version. Review the scope in the confirmation dialog; collapsed descendants remain included.

## Archiving stopped partway through

Read the progress and error message. The enhancement submits native archive actions one by one and reads local archive status to verify each result. It stops on an error; already completed archives are not automatically undone. Check the official app for which chats were archived before deciding what to do with the remainder. Do not assume the whole operation completed or resubmit completed items.

## Can it cascade delete?

This version does not implement cascade delete. The current native interface does not provide a usable Delete action for this feature. Archive and delete are different operations.

## How do Stop and uninstall differ?

`Stop.ps1` removes the enhancement from the current window and stops its companion process while leaving the official window open. After checking the installation identity, uninstall also sends the project's program folder and dedicated shortcut to the Recycle Bin and retains project data. Official chats and account data are outside its scope. Exit and reopen the official app normally after uninstall to close the temporary debugging endpoint with the original process.

## Uninstall says the shortcut was changed

Install and uninstall share the entry definition, including the hidden-window argument; the exact former project entry is also recognized. This message means the target or arguments differ from those project entries. Uninstall preserves the shortcut and program folder. Inspect the changed destination or arguments before retrying instead of bypassing the protection with an overwrite.

## Will an upgrade overwrite my data?

The installer refuses to overwrite an existing program directory. Use this release's uninstaller to preview and remove the existing project installation; its separate data is retained by default. Install the new version with `-ReuseData` to reuse data carrying the project's identity marker. Inspect the `-WhatIf` output for each step. Custom directories must be supplied to the applicable uninstall and install commands.

## What should I include in a report?

Include the project, Windows and official Codex package versions, the command, error text, and steps to reproduce. Screenshots and logs can contain chat titles, IDs, account details, or work information. Review and remove sensitive information before sharing; do not upload credentials, databases, or the entire personal data directory.
