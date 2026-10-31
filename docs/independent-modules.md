# Conversation management surfaces

| Surface | How to use it |
| --- | --- |
| Official **嵌套对话** app page or conversation panel | Open the original GPT icon. After installing the local plugin, open its nested directory in a supported desktop host, or ask Codex to open it. Expand a parent and select a chat. |
| Official bulk archive page | Use the same plugin to filter, select, review the affected scope and check results. Browsing the directory does not archive anything. |
| Original Recents and project lists | Install the full enhancement and launch the existing client through the project's dedicated shortcut to expand rows in the original sidebar. |

## Install the plugin

You need the signed-in official Windows Codex app, Node.js 22+ and Python 3.10+. The default marketplace package includes the built UI. Give Codex or another local Windows coding agent the [one-instruction installation guide](install-agent.md).

For manual installation, download the marketplace ZIP and its checksum file. Extract it to a permanent folder and open PowerShell in the directory containing `.agents` and `plugin`. [Release downloads](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.3.0-preview.6)

```powershell
$cli = Join-Path (Get-AppxPackage OpenAI.Codex).InstallLocation 'app\resources\codex.exe'
& $cli plugin marketplace add .
& $cli plugin add codex-nested-conversations@codex-nested-local
```

Find **Codex 对话管理** in the host's plugin manager. If an existing chat still lists the old tools, follow any host prompt to reload the plugin or open a fresh chat. Node.js and Python must be available to the desktop process. Keep the extracted source folder for future updates.

## Navigation and scope

The directory prefers explicit local parent IDs and supplements them with verified creation and fork history. If creation history is unavailable, the tree labels its coverage as partial. Bulk archive will not treat that partial view as a complete cascade scope. Background agent tasks are separate from user chats.

When the host does not supply the current thread ID, choose the parent you want to follow. Selecting a chat requests navigation through Windows to the official client. Opening or refreshing the directory only reads metadata. The shared settings directory defaults to `%USERPROFILE%\.codex-nested-conversations\settings`.

Install the full source package only if you need the tree inside the original sidebar. Bulk archive separately lists affected chats and background tasks. A confirmed scope can have up to 256 combined records. Stopping preserves completed changes. [Windows installation](quickstart.md) · [Bulk archive](bulk-archive.md)

## Remove and update

```powershell
& $cli plugin remove codex-nested-conversations@codex-nested-local
& $cli plugin marketplace remove codex-nested-local
```

These commands remove the plugin and its marketplace registration. Chats and the official client remain. Windows continues to manage official updates. After a desktop update, open the plugin, expand a known parent, and also check the enhanced shortcut if you use the original sidebar mode. [Updates and compatibility](faq.md)
