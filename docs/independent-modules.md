# One project, two modules

| Feature | Where it appears | How to install |
| --- | --- | --- |
| Bulk archive | A page in the official desktop plugin host for filtering chats, selecting a batch, reviewing the scope and checking results | Download the local marketplace ZIP. |
| Nested conversations | Expandable parent and child chats in the existing Recents and project lists | Download the source ZIP, install the sidebar adapter, and launch the existing desktop client through the enhanced entry. |

The archive page works independently of the sidebar adapter. The adapter displays supported local Codex chats in both the Codex and ChatGPT modes of the desktop client. The nesting switch controls the tree when the adapter is loaded. Automatic loading of the tree from the original app icon is still experimental.

## Install the archive plugin

You need the official Codex desktop app on Windows, Node.js 22 or later, and Python 3.10 or later. The desktop app must be able to find `node` and `python` on its PATH. Reopen it after changing PATH. Use `CNCC_PYTHON` if the interpreter has another name or location. The marketplace ZIP includes the prebuilt page and its SDK. No npm install or separate sidebar launcher is required for the archive page.

1. Download `codex-conversation-manager-0.3.0-preview.5-marketplace.zip` and its SHA-256 file. Extract the ZIP to a folder you can keep. [GitHub releases](https://github.com/Mastery-L99/codex-nested-conversations/releases)
2. Open PowerShell in the extracted folder containing `.agents/plugins/marketplace.json`. Run the commands below to register the local marketplace and install **Codex 对话管理**. Use the directory with the marketplace catalog as the source.
3. Open the desktop plugin manager and find **Codex 对话管理**. Follow any prompt to reopen the app, then open the archive page from a new chat. You can also choose the registered **Codex 对话管理 · 本地** source in the desktop manager to install the plugin.

```powershell
codex plugin marketplace add .
codex plugin marketplace list
codex plugin add codex-nested-conversations@codex-nested-local
```

These commands were exercised with `codex-cli 0.166.0-alpha.5.1`. If PowerShell cannot find the `codex` command, see the repository's [installation guide](../README.md). The official client copies the plugin source into its cache. Keep the extracted marketplace folder for later updates. Register a clean distribution folder to avoid copying personal files or development dependencies into the cache.

## Install nesting in the original sidebar

Download `codex-nested-conversations-0.3.0-preview.5-source.zip` and follow the [Windows installation steps](../README.md). The enhanced entry opens the existing official client with the adapter. Use that entry to see the tree. The archive plugin by itself contributes its own page to the official host. It has no host sidebar extension point for displaying the tree.

## Scope and controls

The page provides independent archive and nesting switches. Both modules share the settings location specified by `CNCC_SETTINGS_DIR`, which defaults to `%USERPROFILE%\.codex-nested-conversations\settings`. `CNCC_DATA_DIR` can select a separate working directory.

Select local chats and inspect the confirmation page. It shows the selected chats, any included descendants, and background tasks the official archive operation will also affect. The combined limit is 256 records. If relationships are unavailable, the page lets you cancel or explicitly choose selected chats only. Avoid creating descendants in the reviewed branch while the batch is running. A stop request prevents further submissions. The job reports verified results for chats and background tasks separately. [Bulk archive guide](bulk-archive.md)

The standalone plugin uses the official local `codex app-server`. If another window holds a chat, the plugin can report a writer conflict. The sidebar toolbar can send the operation through its owning desktop window. Cloud ChatGPT conversations, remote hosts and other accounts are outside the scope of both archive entry points.

## Remove or update

```powershell
codex plugin remove codex-nested-conversations@codex-nested-local
codex plugin marketplace remove codex-nested-local
```

These commands remove the installed plugin and its registered source. Chats and project settings stay on the computer. Install the next release from its extracted marketplace directory. The plugin does not add a Windows sign-in startup entry.

For development, edit `src/archive-panel-source.js`, run `npm ci`, then run `node scripts/build-archive-panel.cjs` to rebuild the page. Redistribute the bundled notices with the generated HTML. [Third-party notices](../NOTICE.md)
