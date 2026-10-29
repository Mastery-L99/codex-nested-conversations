(() => {
  'use strict';
  // Cascades are submitted only through the original, identity-bound native menu.
  // No database, application internals, conversation text, or credentials are read.
  window.__codexNestedCascade?.dispose();
  const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const OWN = 'data-codex-nested-cascade-owned';
  const SIDEBAR = '#app-shell-sidebar';
  const ROW = '[data-app-action-sidebar-thread-row]';
  const PROXY = '[data-codex-nested-chat-id]';
  const MAX_CHATS = 256;
  const timeout = 4000;
  let disposed = false, busy = false, modal = null, controller = null;
  let state = { installed: true, state: 'ready', submitted: [], verified: [], error: null };
  const owned = new Set();
  let shortcutPending = false;
  const dispatchDescriptor = Object.getOwnPropertyDescriptor(window, 'dispatchEvent');
  const originalDispatchEvent = window.dispatchEvent;
  const shortcut = { nativeMessages: 0, relaySignals: 0, keydowns: 0, intercepted: 0, duplicates: 0,
    blockedEditable: 0, blockedContext: 0, lastSource: null, lastParentId: null };

  function valid(chat) {
    return !!chat && UUID.test(chat.id) && chat.kind === 'codex' &&
      (chat.hostId ?? 'local') === 'local' && typeof chat.title === 'string';
  }
  function id(chat) { return chat.id.toLowerCase(); }
  function graph() {
    const byId = new Map(), children = new Map();
    for (const group of window.__codexNestedRelations?.groups ?? []) {
      if (!valid(group?.parent)) continue;
      byId.set(id(group.parent), { ...group.parent, id: id(group.parent) });
      if (!children.has(id(group.parent))) children.set(id(group.parent), new Set());
      for (const child of group.children ?? []) if (valid(child) && id(child) !== id(group.parent)) {
        byId.set(id(child), { ...child, id: id(child) });
        children.get(id(group.parent)).add(id(child));
      }
    }
    return { byId, children };
  }
  function plan(chat, operation = 'archive', includeDescendants = true) {
    if (!valid(chat) || !['archive', 'delete'].includes(operation)) throw new Error('Unsupported chat or operation');
    const { byId, children } = graph();
    if (!byId.has(id(chat))) throw new Error('Chat is outside verified relations');
    const ordered = [], seen = new Set(), visiting = new Set();
    function visit(key, depth) {
      if (visiting.has(key)) throw new Error('Relationship cycle detected; no operation was submitted');
      if (seen.has(key)) return;
      if (seen.size + visiting.size >= MAX_CHATS) throw new Error('Too many chats; no operation was submitted');
      visiting.add(key);
      if (includeDescendants) for (const child of children.get(key) ?? []) visit(child, depth + 1);
      visiting.delete(key); seen.add(key);
      ordered.push({ ...byId.get(key), depth });
    }
    visit(id(chat), 0);
    return { operation, includeDescendants, parent: byId.get(id(chat)), items: ordered,
      signature: ordered.map(item => item.id).join('|') };
  }
  function visible(element) {
    return !!element?.isConnected && element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
  }
  function editable(element) {
    return !!element?.closest?.('input,textarea,select,[role="textbox"],.monaco-editor,.cm-editor,.CodeMirror') ||
      element?.isContentEditable === true;
  }
  function currentConversationContext(anchor) {
    const currentIds = new Set();
    for (const carrier of document.querySelectorAll('[data-response-annotation-conversation]')) {
      if (!visible(carrier)) continue;
      const value = carrier.getAttribute('data-response-annotation-conversation');
      if (!UUID.test(value ?? '')) return null;
      currentIds.add(value.toLowerCase());
    }
    if (currentIds.size !== 1) return null;
    const chat = graph().byId.get(currentIds.values().next().value);
    return chat ? { chat, anchor } : null;
  }
  function composerContext(active) {
    const composer = active?.closest?.('[data-codex-composer]');
    const textbox = active?.matches?.('[role="textbox"],textarea');
    if (!composer || !visible(composer) || !visible(active) ||
        !(active.isContentEditable || textbox)) return null;
    return currentConversationContext(active);
  }
  function shortcutContext() {
    const roots = Array.from(document.querySelectorAll(SIDEBAR)).filter(visible);
    if (roots.length !== 1) return null;
    const root = roots[0], active = document.activeElement;
    const { byId } = graph();
    function native(row) {
      if (!row || !root.contains(row) || !visible(row) ||
          row.getAttribute('data-app-action-sidebar-thread-kind') !== 'local' ||
          row.getAttribute('data-app-action-sidebar-thread-host-id') !== 'local') return null;
      const raw = row.getAttribute('data-app-action-sidebar-thread-id');
      const resolved = window.__codexNestedRuntime?.getCanonicalChatId?.(row);
      const ident = resolved || (raw?.startsWith('local:') && UUID.test(raw.slice(6)) ? raw.slice(6) : null);
      if (!UUID.test(ident??'')) return null;
      const chat = byId.get(ident.toLowerCase());
      return chat ? { chat, anchor: row } : null;
    }
    // Focus chooses an exact sidebar identity; never substitute a selected chat
    // when the focused row is unsupported, hidden, or outside the relation graph.
    const focusedRow = active?.closest?.(ROW);
    if (focusedRow && root.contains(focusedRow)) return native(focusedRow);
    const focusedProxy = active?.closest?.(PROXY) ||
      active?.closest?.('.cnv-child-line')?.querySelector(PROXY);
    if (focusedProxy && root.contains(focusedProxy)) {
      const value = focusedProxy.getAttribute('data-codex-nested-chat-id');
      const chat = UUID.test(value ?? '') && byId.get(value.toLowerCase());
      return chat && visible(focusedProxy) && visible(active) ? { chat, anchor: active } : null;
    }
    // Cached sidebar modes may contain their own selected rows. Only connected,
    // visible native rows in the visible sidebar are eligible for the fallback.
    const selected = new Map();
    for (const row of root.querySelectorAll(`${ROW}[data-app-action-sidebar-thread-selected="true"]`)) {
      if (!visible(row)) continue;
      const context = native(row);
      if (!context) return null;
      selected.set(context.chat.id, context);
    }
    if (selected.size === 1) return selected.values().next().value;
    if (selected.size > 1) return null;
    // Nested chats can have their native source row hidden by this enhancement.
    // After a click in the current pane, the public current-chat annotation is
    // the remaining identity source. Never use it to replace a focused row or
    // an ambiguous visible sidebar selection.
    const current = currentConversationContext(active);
    if (current) return current;
    return Array.from(document.querySelectorAll('[data-response-annotation-conversation]')).some(visible)
      ? { blocked:true } : null;
  }
  function consumeShortcut(event) {
    event.preventDefault(); event.stopImmediatePropagation();
  }
  function requestShortcut(event, source) {
    if (disposed) return false;
    if (busy || shortcutPending || modal?.isConnected) {
      consumeShortcut(event); shortcut.duplicates++; return true;
    }
    const active = document.activeElement;
    // The native chat composer auto-receives focus when a chat opens. Its
    // current identity must come from public response annotations, never from
    // another focused/selected sidebar row or from the editor's text content.
    const inEditor = editable(active) || editable(event.target);
    const context = inEditor ? composerContext(active) : shortcutContext();
    // Other editors, ambiguous composer identities, and confirmation dialogs
    // consume the separately delivered native accelerator to avoid one archive.
    if (nativeConfirmationVisible() || (inEditor && !context)) {
      consumeShortcut(event); shortcut.blockedEditable++; return true;
    }
    if (context?.blocked) { consumeShortcut(event); shortcut.blockedContext++; return true; }
    if (!context) return false;
    let selected;
    try { selected = plan(context.chat, 'archive', true); } catch { return false; }
    if (selected.items.length < 2) return false;
    consumeShortcut(event);
    if (event.repeat) { shortcut.duplicates++; return true; }
    shortcutPending = true;
    shortcut.intercepted++; shortcut.lastSource = source; shortcut.lastParentId = context.chat.id;
    preview(context.chat, 'archive', context.anchor).catch(error => {
      state = { ...state, state: 'preview_error', error: String(error?.message ?? error).slice(0, 240) };
    }).finally(() => { shortcutPending = false; });
    return true;
  }
  function archiveShortcutKeydown(event) {
    if (event.defaultPrevented || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey ||
        event.isComposing || event.keyCode === 229 || event.key?.toLowerCase() !== 'a') return;
    shortcut.keydowns++; requestShortcut(event, 'keydown');
  }
  function nativeArchiveShortcut(event) {
    // In the inspected 26.1023.6621.0 package, the original menu accelerator
    // emits this exact host message. preload.js dispatches a window MessageEvent
    // (empty origin, null source). On a Window dispatch target, an already
    // registered application listener runs before a later capture listener.
    // Inspect the exact message before dispatch instead of racing that listener.
    if (event?.type !== 'message' || event.data?.type !== 'archive-thread' ||
        event.data?.source !== 'native_accelerator' || event.source != null || event.origin !== '') return false;
    shortcut.nativeMessages++; return requestShortcut(event, 'native_accelerator');
  }
  function dispatchEventWithArchiveShortcut(event, ...args) {
    if (this === window && nativeArchiveShortcut(event)) return !event.defaultPrevented;
    return Reflect.apply(originalDispatchEvent, this, [event, ...args]);
  }
  function isolatedArchiveShortcut(event) {
    // Public DOM relay contract for the inspected isolated preload world:
    // dispatch a cancelable CustomEvent('codex-nested:archive-request',
    // {detail:{version:1,source:'native_accelerator'}}) with its original
    // window.dispatchEvent. A false result means this module took ownership;
    // otherwise the preload adapter must dispatch the original message intact.
    if (!event.cancelable || event.target !== window || event.detail?.version !== 1 ||
        event.detail?.source !== 'native_accelerator') return;
    shortcut.relaySignals++; requestShortcut(event, 'native_accelerator_relay');
  }
  function actionOf(item) {
    if (!item) return null;
    const label = (item.getAttribute('aria-label') || item.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^(归档|Archive)(?=$|\s|Ctrl|⌘|⇧)/i.test(label)) return 'archive';
    if (/^(删除|Delete)(?=$|\s|Ctrl|⌘|⇧)/i.test(label)) return 'delete';
    return null;
  }
  function contextFor(item) {
    const context = window.__codexNestedRuntime?.getMenuContext?.();
    if (!valid(context)) return null;
    const menu = context.menuElement;
    // Never infer an owner from the last row title or a different open menu.
    if (!menu || !visible(menu) || !menu.contains(item) || !visible(item)) return null;
    return context;
  }
  function element(tag, cls, text) {
    const result = document.createElement(tag);
    if (cls) result.className = cls;
    if (text !== undefined) result.textContent = text;
    return result;
  }
  function own(element) { element.setAttribute(OWN, ''); owned.add(element); return element; }
  function closeModal() {
    modal?.remove(); if (modal) owned.delete(modal); modal = null;
    if (!busy && state.state === 'scope_preview') state = { ...state, state: 'cancelled' };
    document.dispatchEvent(new CustomEvent('codex-nested:state-changed'));
  }
  function nativeConfirmationVisible() {
    return Array.from(document.querySelectorAll('[role="alertdialog"], [role="dialog"][aria-modal="true"]'))
      .some(node => !node.hasAttribute(OWN) && !node.closest(`[${OWN}]`) && visible(node));
  }
  async function waitUntil(predicate, milliseconds = timeout) {
    const end = performance.now() + milliseconds;
    do {
      if (disposed || controller?.signal.aborted) throw new Error('Operation stopped');
      if (predicate()) return;
      await new Promise(resolve => window.setTimeout(resolve, 40));
    } while (performance.now() < end);
    throw new Error('The native menu did not respond; remaining chats were preserved');
  }
  async function waitArchived(chat) {
    const end = performance.now() + 8000;
    do {
      if (disposed || controller?.signal.aborted) throw new Error('Operation stopped');
      const readStatus = window.__codexNestedArchiveStatus;
      if (typeof readStatus !== 'function') throw new Error('Archive status check is unavailable; remaining chats were preserved');
      let timer;
      let result;
      try {
        result = await Promise.race([
          Promise.resolve().then(() => readStatus({ id: chat.id, kind: chat.kind, hostId: chat.hostId })),
          new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('Archive status check timed out; remaining chats were preserved')), Math.max(1, end - performance.now())); })
        ]);
      } finally { window.clearTimeout(timer); }
      if (!result || typeof result.archived !== 'boolean') throw new Error('Archive status could not be read; remaining chats were preserved');
      if (result.archived === true) return;
      if (performance.now() >= end) break;
      await new Promise(resolve => window.setTimeout(resolve, Math.min(200, Math.max(1, end - performance.now()))));
    } while (performance.now() < end);
    throw new Error('Archive was not confirmed within 8 seconds; remaining chats were preserved');
  }
  function progressDialog(selected) {
    closeModal();
    modal = own(element('div', 'cnc-overlay'));
    modal.setAttribute('data-codex-cascade-dialog', 'progress');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '归档子树进度');
    const box = element('div', 'cnc-box');
    box.append(element('h2', '', '正在归档对话'));
    const progress = element('p', 'cnc-progress', `已归档 0 / ${selected.items.length} 个对话`);
    progress.setAttribute('role', 'status'); box.append(progress);
    const detail = element('p', 'cnc-detail', ''); box.append(detail);
    const stop = element('button', 'cnc-button', '停止后续操作');
    stop.type = 'button'; stop.addEventListener('click', () => controller?.abort()); box.append(stop);
    modal.append(box); document.body.append(modal);
    return { progress, detail, stop };
  }
  async function execute(selected) {
    if (busy || disposed) return;
    if (selected.operation !== 'archive' || !window.__codexNestedCascadeOptions?.enableArchiveExecution || typeof window.__codexNestedArchiveStatus !== 'function') {
      state = { ...state, state: 'execution_not_enabled', error: 'Archive execution or status check is not enabled' }; return;
    }
    const fresh = plan(selected.parent, selected.operation, selected.includeDescendants);
    if (fresh.signature !== selected.signature) {
      state = { ...state, state: 'plan_changed', error: 'Relationships changed; review the scope again' };
      closeModal(); return;
    }
    const runtime = window.__codexNestedRuntime;
    if (typeof runtime?.openNativeMenu !== 'function' || typeof runtime?.getMenuContext !== 'function') {
      state = { ...state, state: 'native_menu_unavailable', error: 'Native menu bridge is unavailable' }; return;
    }
    busy = true; controller = new AbortController();
    state = { installed: true, state: 'running', operation: selected.operation,
      parentId: selected.parent.id, planned: selected.items.map(row => row.id), submitted: [], verified: [], error: null };
    const ui = progressDialog(selected);
    try {
      await window.__codexNestedBeginArchive?.({parentId:selected.parent.id,ids:selected.items.map(row=>row.id),includeDescendants:selected.includeDescendants});
      for (const chat of selected.items) {
        if (controller.signal.aborted || disposed) throw new Error('Stopped; remaining chats were preserved');
        if (nativeConfirmationVisible()) throw new Error('Complete the original application confirmation before continuing');
        ui.detail.textContent = chat.title;
        const opened = await runtime.openNativeMenu(chat, ui.detail);
        if (disposed || controller?.signal.aborted) {
          await runtime.closeNativeMenu?.();
          throw new Error('Stopped before submitting the native archive command');
        }
        if (!opened?.opened) throw new Error('The original chat menu could not be opened');
        const context = runtime.getMenuContext();
        if (!valid(context) || id(context) !== chat.id || !visible(context.menuElement)) {
          throw new Error('Native menu owner changed; no further action was submitted');
        }
        const item = Array.from(context.menuElement.querySelectorAll('[role="menuitem"]'))
          .find(candidate => visible(candidate) && actionOf(candidate) === 'archive');
        if (!item || item.getAttribute('aria-disabled') === 'true' || item.matches(':disabled')) {
          throw new Error('This original menu does not provide an enabled archive command');
        }
        if (disposed || controller?.signal.aborted) {
          await runtime.closeNativeMenu?.();
          throw new Error('Stopped before submitting the native archive command');
        }
        // `busy` bypasses only this module's interception, never the native handler.
        item.click();
        state.submitted.push(chat.id);
        await waitUntil(() => !visible(context.menuElement));
        if (nativeConfirmationVisible()) throw new Error('An original application confirmation is open; remaining chats were preserved');
        await waitArchived(chat);
        state.verified.push(chat.id);
        ui.progress.textContent = `已归档 ${state.verified.length} / ${selected.items.length} 个对话`;
        await new Promise(resolve => window.setTimeout(resolve, 120));
      }
      state.state = 'completed'; ui.detail.textContent = `已归档全部 ${state.verified.length} 个对话。`;
    } catch (error) {
      state.state = controller.signal.aborted ? 'stopped' : 'stopped_after_error';
      state.error = String(error?.message ?? error).slice(0, 240);
      ui.detail.textContent = controller.signal.aborted ? '已停止。尚未处理的对话保持原样。' : '已停止后续操作，请核对原应用提示。';
    } finally {
      busy = false; controller = null;
      await window.__codexNestedEndArchive?.().catch(()=>{});
      ui.stop.textContent = '关闭'; ui.stop.replaceWith(ui.stop.cloneNode(true));
      const close = modal?.querySelector('button'); close?.addEventListener('click', closeModal);
      document.dispatchEvent(new CustomEvent('codex-nested:state-changed'));
    }
  }
  async function preview(chat, operation = 'archive', anchor) {
    if (busy || disposed) return null;
    const selected = plan(chat, operation, true);
    if (selected.items.length < 2) return null;
    await window.__codexNestedRuntime?.closeNativeMenu?.();
    closeModal();
    modal = own(element('div', 'cnc-overlay'));
    modal.setAttribute('data-codex-cascade-dialog', 'scope');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', operation === 'archive' ? '归档范围' : '删除范围');
    const box = element('div', 'cnc-box');
    box.append(element('h2', '', operation === 'archive' ? '归档主对话和下级对话' : '删除对话范围'));
    box.append(element('p', '', `“${selected.parent.title}”及其 ${selected.items.length - 1} 个下级对话，共 ${selected.items.length} 个。`));
    const list = element('ul', 'cnc-scope');
    // Show the root first for readability; execution remains descendants first.
    for (const chat of [...selected.items].reverse()) {
      const item = element('li', '', chat.title); item.style.paddingInlineStart = `${Math.min(chat.depth, 8) * 14}px`; list.append(item);
    }
    box.append(list);
    const archiveEnabled = operation === 'archive' && window.__codexNestedCascadeOptions?.enableArchiveExecution === true && typeof window.__codexNestedArchiveStatus === 'function';
    if (operation === 'delete') box.append(element('p', 'cnc-note', '删除需逐个使用原应用的删除和确认入口。本版本不自动批量删除。'));
    else if (!archiveEnabled) box.append(element('p', 'cnc-note', '当前为范围预览，批量归档和结果检查尚未就绪。'));
    const controls = element('div', 'cnc-controls');
    const all = element('button', 'cnc-button cnc-primary', `归档全部 ${selected.items.length} 个`);
    all.type = 'button'; all.disabled = !archiveEnabled; all.addEventListener('click', () => execute(selected));
    const only = element('button', 'cnc-button', '只归档当前对话');
    only.type = 'button'; only.disabled = !archiveEnabled;
    only.addEventListener('click', () => execute(plan(chat, 'archive', false)));
    const cancel = element('button', 'cnc-button', '取消'); cancel.type = 'button';
    cancel.addEventListener('click', () => { closeModal(); anchor?.focus?.(); });
    if (operation === 'archive') controls.append(all, only);
    controls.append(cancel); box.append(controls); modal.append(box); document.body.append(modal);
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); cancel.click(); } });
    cancel.focus();
    state = { installed: true, state: 'scope_preview', operation, parentId: selected.parent.id,
      planned: selected.items.map(row => row.id), submitted: [], verified: [], error: null };
    document.dispatchEvent(new CustomEvent('codex-nested:state-changed'));
    return { parentId: selected.parent.id, count: selected.items.length, operation };
  }
  function intercept(event) {
    if (busy || disposed || event.defaultPrevented) return;
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    const item = event.target?.closest?.('[role="menuitem"]');
    const operation = actionOf(item);
    if (!operation) return;
    // The inspected app has no native deletion command. Preserve any future
    // original deletion flow until its confirmation/commit contract is tested.
    if (operation === 'delete') return;
    const context = contextFor(item);
    if (!context) return;
    let selected;
    try { selected = plan(context, operation, true); } catch { return; }
    if (selected.items.length < 2) return;
    event.preventDefault(); event.stopImmediatePropagation();
    preview(context, operation, context.anchor).catch(error => {
      state = { ...state, state: 'preview_error', error: String(error?.message ?? error).slice(0, 240) };
    });
  }
  const style = own(element('style'));
  style.textContent = `.cnc-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);font:14px system-ui;color:var(--color-text,#eee)}
    .cnc-box{width:min(530px,calc(100vw - 48px));padding:22px;border:1px solid rgba(127,127,127,.35);border-radius:16px;background:var(--color-background-primary,#30302e);box-shadow:0 16px 70px rgba(0,0,0,.4)}
    .cnc-box h2{font-size:17px;margin:0 0 12px;font-weight:600}.cnc-box p{line-height:1.6;margin:8px 0}.cnc-scope{list-style:none;max-height:250px;overflow:auto;padding:10px 0;margin:12px 0;border-block:1px solid rgba(127,127,127,.2)}
    .cnc-scope li{padding-block:5px;overflow-wrap:anywhere}.cnc-note{opacity:.7;font-size:12px}.cnc-controls{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:18px}
    .cnc-button{border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:7px 12px;color:inherit;background:transparent;font:inherit;cursor:pointer}.cnc-button:focus-visible{outline:2px solid currentColor;outline-offset:2px}.cnc-button:disabled{opacity:.4;cursor:default}.cnc-primary{background:rgba(127,127,127,.2)}`;
  document.head.append(style);
  document.addEventListener('click', intercept, true);
  document.addEventListener('keydown', intercept, true);
  window.addEventListener('keydown', archiveShortcutKeydown, true);
  window.addEventListener('codex-nested:archive-request', isolatedArchiveShortcut);
  Object.defineProperty(window, 'dispatchEvent', { configurable:true, writable:true,
    enumerable:dispatchDescriptor?.enumerable ?? false, value:dispatchEventWithArchiveShortcut });
  const api = {
    plan, preview,
    inspect() { return { ...state, submitted: [...state.submitted], verified: [...(state.verified ?? [])], busy,
      dialogOpen: !!modal?.isConnected,
      shortcut: { ...shortcut, pending: shortcutPending },
      previewOpen: !!modal?.isConnected && modal.getAttribute('data-codex-cascade-dialog') === 'scope' }; },
    dispose() {
      if (disposed) return;
      disposed = true; controller?.abort();
      document.removeEventListener('click', intercept, true); document.removeEventListener('keydown', intercept, true);
      window.removeEventListener('keydown', archiveShortcutKeydown, true);
      window.removeEventListener('codex-nested:archive-request', isolatedArchiveShortcut);
      if (window.dispatchEvent === dispatchEventWithArchiveShortcut) {
        if (dispatchDescriptor) Object.defineProperty(window, 'dispatchEvent', dispatchDescriptor);
        else delete window.dispatchEvent;
      }
      for (const node of owned) node.remove(); owned.clear(); modal = null;
      state = { installed: false, state: 'disposed', submitted: [], verified: [], error: null };
    }
  };
  window.__codexNestedCascade = api;
  return api.inspect();
})();
