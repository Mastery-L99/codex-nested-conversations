# Bulk archive chats

Bulk archive helps organize local Codex chats. Open **批量归档** (Bulk archive) in the sidebar when you need it, filter by title, build a selection across filters, and review the full scope before submitting.

This guide covers [0.3.0-preview.5](https://github.com/Mastery-L99/codex-nested-conversations/releases/tag/v0.3.0-preview.5). Both the toolbar and plugin page use the same archive service. It can archive a chat inside a collapsed branch without opening a sidebar row or switching chats.

## Choose chats

The toolbar submits through the current desktop window, which can release its own idle chats. It stops before submitting if the chat or one of its background tasks is still running. The standalone plugin uses a separate official service and reports a conflict if another process owns the chat. Both entry points check the stored archive state and stop subsequent submissions on failure.

The catalog uses chat origin to distinguish desktop conversations from noninteractive runs. Records produced by `codex exec`, such as benchmark runs, are excluded from listing and archive scope. An actual desktop chat without a title stays visible with its creation time and short ID.

1. In a Codex window with the enhancement loaded, select **批量归档** in the sidebar.
2. Expand a parent to see its children. A selected row has a check mark and a highlighted background. Search shows matching chats with their ancestors for context. **全选当前筛选** (Select all matching) and **反选当前筛选** (Invert matching) affect only actual matches and keep selections made under other filters.
3. **清空选择** (Clear selection) clears every selected chat, including hidden ones. **取消** (Cancel) or **关闭** (Close) in the selection panel closes it and clears the selection without submitting an archive.
4. **同时归档所选主对话的全部下级** (Include descendants of selected chats) is checked by default. The scope follows relationships already discovered by the enhancement, including discovered descendants collapsed in the sidebar. Relationships not discovered are not added automatically. Clear the checkbox to include only explicitly selected chats.
5. Select **归档所选** (Archive selected) to open a second confirmation window. Review the listed chats and the deduplicated total. A chat covered more than once is counted once. The first panel counts directly selected chats; the confirmation total can be larger when descendants are included.

The review separates chats from background tasks. Selecting four chats with twelve additional descendants puts sixteen chats in the first list. A second list names each background task that the official archive can also affect and the chat it belongs to. Each task appears once.

The descendants switch applies to the chat tree. Archiving an individual chat can still include its background tasks. Review both lists before you confirm. The combined limit is 256 entries. The service checks the scope again before writing and reports verified results for chats and background tasks separately.

## Confirm, stop, and restore

Choosing **取消** in the confirmation window closes it without submitting an archive. Reopen the selection panel to review the retained selection. After **归档全部** (Archive all), the enhancement reads a fresh local relationship snapshot. A new descendant, renamed chat, or removed member stops submission and prompts another review. When the scope matches, archive actions are submitted one at a time through the official local archive interface and local archive status is checked for each result. Descendants within the selected scope are processed before their corresponding parent.

During execution, **停止后续操作** (Stop subsequent actions) stops further work. The current action may already have been submitted and may still complete; completed archives are not automatically undone. Later chats that have not been submitted remain unchanged. An error or an unverifiable result also stops subsequent actions. Check the original app for the status of the current chat and the chats already processed before deciding whether to retry the remainder.

Archiving organizes the sidebar and does not delete the chat. To restore one, check **Archived chats** in the original app's settings, find the chat, and use the available unarchive or restore control. The exact control and label depend on the official client version; this workflow still needs testing in the target version. The bulk panel has no bulk undo or bulk delete action.

## Scope and startup

The panel lists recognizable, unarchived local Codex chats. Cloud ChatGPT chats, remote hosts, and other accounts are outside its scope. It relies on the chats and relationships currently discovered; if the list or relationships change, review the selection and confirmation scope again.

Startup at sign-in remains off. Automatic loading from the original icon is separate work and is still being tested; follow the startup instructions for the installed version. This feature does not change how the official app updates, and future official versions may require adaptation.
