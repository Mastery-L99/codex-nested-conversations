(() => {
  'use strict';
  // Single-chat menu actions use the native menu. The toolbar uses the same
  // archive service as the plugin so it can operate on rows outside the sidebar.
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
  let enabled = true;
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
  function graph(manifest = window.__codexNestedRelations) {
    const byId = new Map(), children = new Map();
    const hasCatalog = Array.isArray(manifest?.catalog);
    for (const chat of manifest?.catalog ?? []) {
      if (valid(chat)) byId.set(id(chat), { ...chat, id: id(chat) });
    }
    for (const group of manifest?.groups ?? []) {
      if (!valid(group?.parent)) continue;
      if (hasCatalog && !byId.has(id(group.parent))) continue;
      if (!hasCatalog) byId.set(id(group.parent), { ...group.parent, id: id(group.parent) });
      if (!children.has(id(group.parent))) children.set(id(group.parent), new Set());
      for (const child of group.children ?? []) if (valid(child) && id(child) !== id(group.parent)) {
        if (hasCatalog && !byId.has(id(child))) continue;
        if (!hasCatalog) byId.set(id(child), { ...child, id: id(child) });
        children.get(id(group.parent)).add(id(child));
      }
    }
    return { byId, children };
  }
  function plan(chat, operation = 'archive', includeDescendants = true, manifest) {
    if (!valid(chat) || !['archive', 'delete'].includes(operation)) throw new Error('Unsupported chat or operation');
    const { byId, children } = graph(manifest);
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
      signature: JSON.stringify(ordered.map(item => [item.id, item.title])) };
  }
  function planMany(chats, operation = 'archive', includeDescendants = true, manifest) {
    if (!Array.isArray(chats) || !chats.length || chats.length > MAX_CHATS ||
        operation !== 'archive' || chats.some(chat => !valid(chat))) throw new Error('Unsupported batch scope');
    const { byId, children } = graph(manifest);
    const roots = [...new Set(chats.map(id))];
    if (roots.some(key => !byId.has(key))) throw new Error('Chat is outside the verified local catalog');
    const ordered = [], seen = new Set(), visiting = new Set();
    const rootSet = new Set(roots);
    function selectedSuccessors(key) {
      const found = new Set(), walked = new Set();
      function walk(parent) {
        if (walked.has(parent)) return;
        if (walked.size >= 16384) throw new Error('Relationship graph is too large to order safely');
        walked.add(parent);
        for (const child of children.get(parent) ?? []) {
          if (rootSet.has(child)) found.add(child); else walk(child);
        }
      }
      walk(key); return found;
    }
    function visit(key, depth) {
      if (visiting.has(key)) throw new Error('Relationship cycle detected; no operation was submitted');
      if (seen.has(key)) return;
      if (!byId.has(key) || seen.size + visiting.size >= MAX_CHATS) throw new Error('Batch scope is unavailable or too large');
      visiting.add(key);
      for (const child of (includeDescendants ? children.get(key) ?? [] : selectedSuccessors(key))) visit(child, depth + 1);
      visiting.delete(key); seen.add(key); ordered.push({ ...byId.get(key), depth });
    }
    for (const key of roots) visit(key, 0);
    const parents = roots.map(key => byId.get(key));
    return { operation, includeDescendants, parents, parent: parents[0], items: ordered,
      signature: JSON.stringify({roots, includeDescendants, items: ordered.map(chat => [chat.id, chat.title])}) };
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
    if (!enabled) return false;
    if (window.__codexNestedCascadeOptions?.enableShortcutInterception === false) return false;
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
  function appendScopeList(box, selected) {
    const counts = new Map();
    for (const chat of selected.items) counts.set(chat.title, (counts.get(chat.title) ?? 0) + 1);
    const list = element('ul', 'cnc-scope');
    const ordered=[...selected.items].reverse(),depths=new Map();
    if(selected.review)for(const chat of ordered)depths.set(chat.id,depths.has(chat.parentId)?depths.get(chat.parentId)+1:0);
    for (const chat of ordered) {
      const label=chat.title===chat.id?'未命名聊天 · '+chat.id.slice(-8):chat.title;
      const item = element('li', '', label);
      item.style.paddingInlineStart = `${Math.min(depths.get(chat.id)??chat.depth??0, 8) * 14}px`;
      if (counts.get(chat.title) > 1) {
        const created = Number.isFinite(chat.createdAtMs) && chat.createdAtMs > 0
          ? new Date(chat.createdAtMs).toLocaleString('zh-CN', {hour12:false}) + ' · ' : '';
        const hint = element('small', 'cnc-chat-hint', created + chat.id.slice(-8));
        hint.title = chat.id; item.append(hint);
      }
      list.append(item);
    }
    box.append(list);
  }
  function checkedReview(review) {
    const incomplete = () => { throw new Error('归档范围信息不完整，请返回重新核对。未提交任何归档。'); };
    if (!review || typeof review.planToken !== 'string' || !review.planToken || !Array.isArray(review.items) ||
        !review.items.length || review.items.length > MAX_CHATS || review.totalCount !== review.items.length) incomplete();
    const ordinary = new Map();
    for (const chat of review.items) {
      if (!UUID.test(chat?.id ?? '') || typeof chat.title !== 'string' || !chat.title.trim() || ordinary.has(chat.id.toLowerCase())) incomplete();
      ordinary.set(chat.id.toLowerCase(), chat);
    }
    const entries = review.implicitItems ?? [], count = review.implicitCount ?? 0;
    if (!Array.isArray(entries) || !Number.isSafeInteger(count) || count < 0 || count > 10000 || entries.length !== count) incomplete();
    if (count > 0 && !UUID.test(review.backgroundReviewToken ?? '')) incomplete();
    const implicitIds = new Set();
    for (const item of entries) {
      const key = typeof item?.id === 'string' ? item.id.toLowerCase() : '';
      const parent = typeof item?.parentId === 'string' ? item.parentId.toLowerCase() : '';
      if (!UUID.test(key) || implicitIds.has(key) || ordinary.has(key) || !ordinary.has(parent) ||
          typeof item.title !== 'string' || !item.title.trim() || typeof item.parentTitle !== 'string' ||
          !item.parentTitle.trim() || item.parentTitle !== ordinary.get(parent).title) incomplete();
      implicitIds.add(key);
    }
    return Object.freeze({ ...review, items: Object.freeze(review.items.map(chat => Object.freeze({ ...chat }))),
      implicitCount: count, implicitItems: Object.freeze(entries.map(item => Object.freeze({ id: item.id.toLowerCase(), title: item.title,
        parentId: item.parentId.toLowerCase(), parentTitle: item.parentTitle }))) });
  }
  function appendImplicitList(box, review) {
    if (!review?.implicitCount) return;
    const section = element('section', 'cnc-implicit-section'); section.setAttribute('aria-label', '同时归档的后台记录');
    section.append(element('h3', 'cnc-scope-heading', `后台记录（${review.implicitCount} 条）`));
    section.append(element('p', 'cnc-note', '以下后台记录会随所属聊天一起归档，请连同聊天清单核对后再确认。'));
    const list = element('ul', 'cnc-scope cnc-implicit-scope'), counts = new Map();
    for (const item of review.implicitItems) counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
    for (const item of review.implicitItems) {
      const label = item.title.toLowerCase() === item.id ? '未命名后台记录 · ' + item.id.slice(-8) : item.title;
      const row = element('li'); row.append(element('span', 'cnc-implicit-title', label)); row.setAttribute('data-codex-cascade-implicit-id', item.id);
      const parentLabel = item.parentTitle.toLowerCase() === item.parentId ? '未命名聊天 · ' + item.parentId.slice(-8) : item.parentTitle;
      const owner = element('small', 'cnc-chat-hint', `所属聊天：${parentLabel}`); owner.title = item.parentId; row.append(owner);
      if ((counts.get(item.title) ?? 0) > 1) row.append(element('small', 'cnc-chat-hint', `记录标识：…${item.id.slice(-8)}`));
      row.title = item.id; list.append(row);
    }
    section.append(list); box.append(section);
  }
  function readImplicitProgress(selected, job) {
    const total = selected.review?.implicitCount ?? 0, allowed = new Set((selected.review?.implicitItems ?? []).map(item => item.id));
    const invalid = () => { throw new Error('后台记录的归档进度与确认范围不一致，请先检查本次结果。'); };
    if (total === 0 && job.implicitTotal == null && job.verifiedImplicit == null && job.pendingImplicit == null) {
      return { total: 0, verified: 0, pending: 0, verifiedValue: [], pendingValue: [] };
    }
    if (!Number.isSafeInteger(job.implicitTotal) || job.implicitTotal !== total) invalid();
    function count(value) {
      if (Array.isArray(value)) {
        const seen = new Set();
        for (const item of value) {
          const ident = typeof item === 'string' ? item.toLowerCase() : '';
          if (!allowed.has(ident) || seen.has(ident)) invalid(); seen.add(ident);
        }
        return value.length;
      }
      if (!Number.isSafeInteger(value) || value < 0 || value > total) invalid();
      return value;
    }
    const verified = count(job.verifiedImplicit), pending = count(job.pendingImplicit);
    if (verified + pending !== total) invalid();
    if (Array.isArray(job.verifiedImplicit) && Array.isArray(job.pendingImplicit)) {
      const done = new Set(job.verifiedImplicit.map(value => value.toLowerCase()));
      if (job.pendingImplicit.some(value => done.has(value.toLowerCase()))) invalid();
    }
    return { total, verified, pending,
      verifiedValue: Array.isArray(job.verifiedImplicit) ? [...job.verifiedImplicit] : verified,
      pendingValue: Array.isArray(job.pendingImplicit) ? [...job.pendingImplicit] : pending };
  }
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
    const heading = element('h2', '', '正在归档对话'); box.append(heading);
    const progress = element('p', 'cnc-progress', `已归档 0 / ${selected.items.length} 个对话`);
    progress.setAttribute('role', 'status'); box.append(progress);
    let implicit = null;
    if (selected.review?.implicitCount) {
      implicit = element('p', 'cnc-implicit-progress', `后台记录：已确认 0 / ${selected.review.implicitCount} 条 · 待确认 ${selected.review.implicitCount} 条`);
      implicit.setAttribute('role', 'status'); box.append(implicit);
    }
    const detail = element('p', 'cnc-detail', ''); box.append(detail);
    const current = element('p', 'cnc-current', ''); box.append(current);
    const stop = element('button', 'cnc-button', '停止后续操作');
    stop.type = 'button'; stop.addEventListener('click', () => controller?.abort()); box.append(stop);
    modal.append(box); document.body.append(modal);
    return { heading, progress, implicit, detail, current, stop };
  }
  function archiveReady() {
    return enabled && window.__codexNestedCascadeOptions?.enableArchiveExecution === true &&
      typeof window.__codexNestedArchiveStatus === 'function' &&
      (!window.__codexNestedCascadeOptions?.requireFreshValidation || typeof window.__codexNestedValidateArchive === 'function') &&
      (!window.__codexNestedCascadeOptions?.requireNativeMenuBridge || typeof window.__codexNestedRuntime?.openNativeMenu === 'function');
  }
  function invalidatePreview() {
    state = { ...state, state: 'plan_changed', error: 'The selected scope changed; review it again' };
    if (modal?.isConnected) {
      for (const button of modal.querySelectorAll('button')) if (button.textContent !== '取消') button.disabled = true;
      let note = modal.querySelector('[data-codex-cascade-error]');
      if (!note) { note = element('p', 'cnc-note'); note.setAttribute('data-codex-cascade-error', ''); note.setAttribute('role', 'alert'); modal.querySelector('.cnc-box')?.append(note); }
      note.textContent = '聊天列表或下级关系有变化，请取消后重新选择归档范围。';
    }
    document.dispatchEvent(new CustomEvent('codex-nested:state-changed'));
  }
  async function execute(selected) {
    if (busy || disposed) return;
    if (selected.operation !== 'archive' || !archiveReady()) {
      state = { ...state, state: 'execution_not_enabled', error: 'Archive execution or status check is not enabled' }; return;
    }
    let fresh;
    try { fresh = selected.parents ? planMany(selected.parents, selected.operation, selected.includeDescendants)
      : plan(selected.parent, selected.operation, selected.includeDescendants); }
    catch {
      invalidatePreview(); return;
    }
    if (fresh.signature !== selected.signature) {
      invalidatePreview(); return;
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
      // The UI index pauses while a confirmation is open. Read a fresh snapshot
      // before the first mutation so a new child from another window cannot be
      // omitted merely because the displayed tree was intentionally frozen.
      if (typeof window.__codexNestedValidateArchive === 'function') {
        let validationTimer;
        let snapshot;
        try {
          snapshot = await Promise.race([
            Promise.resolve().then(() => window.__codexNestedValidateArchive()),
            new Promise((_, reject) => { validationTimer = setTimeout(() => reject(new Error('Fresh archive scope check timed out')), 17000); })
          ]);
        } finally { clearTimeout(validationTimer); }
        if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.groups)) throw new Error('Archive scope could not be checked');
        const checked = selected.parents ? planMany(selected.parents, selected.operation, selected.includeDescendants, snapshot)
          : plan(selected.parent, selected.operation, selected.includeDescendants, snapshot);
        if (checked.signature !== selected.signature) {
          const changed = new Error('Archive scope changed; close this dialog and review it again'); changed.name = 'ScopeChangedError'; throw changed;
        }
      }
      for (const chat of selected.items) {
        if (controller.signal.aborted || disposed) throw new Error('Stopped; remaining chats were preserved');
        if (nativeConfirmationVisible()) throw new Error('Complete the original application confirmation before continuing');
        ui.current.textContent = `当前对话：${chat.title}`;
        state.lastAttemptedId = chat.id;
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
      ui.current.textContent = '';
    } catch (error) {
      state.state = controller.signal.aborted ? 'stopped' : 'stopped_after_error';
      state.error = String(error?.message ?? error).slice(0, 240);
      ui.detail.textContent = controller.signal.aborted ? '已停止。尚未处理的对话保持原样。' :
        error?.name === 'ScopeChangedError' ? '归档范围有变化，请关闭窗口后重新核对。尚未归档任何对话。' : '已停止后续操作，请核对原应用提示。';
      const unconfirmed = state.submitted.length - state.verified.length;
      if (unconfirmed > 0) ui.detail.textContent += ` 有 ${unconfirmed} 个操作的结果尚未确认，请先检查当前对话。`;
    } finally {
      ui.heading.textContent = state.state === 'completed' ? '归档完成' : '归档已停止';
      busy = false; controller = null;
      await window.__codexNestedEndArchive?.().catch(()=>{});
      ui.stop.textContent = '关闭'; ui.stop.replaceWith(ui.stop.cloneNode(true));
      const close = modal?.querySelector('button'); close?.addEventListener('click', closeModal);
      document.dispatchEvent(new CustomEvent('codex-nested:state-changed'));
    }
  }
  async function preview(chat, operation = 'archive', anchor) {
    if (busy || disposed || !enabled) return null;
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
    appendScopeList(box, selected);
    const archiveEnabled = operation === 'archive' && archiveReady();
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
  async function previewMany(chats, options = {}, anchor) {
    if (busy || disposed || shortcutPending || !enabled) return null;
    const useService=window.__codexNestedCascadeOptions?.requireBatchService===true || typeof window.__codexNestedBatchArchive==='function';
    let selected;
    if(useService){
      const raw=await callBatch('plan',{chatIds:chats.map(id),includeDescendants:options.includeDescendants!==false});
      let review;
      try { review=checkedReview(raw); }
      catch (error) { if (typeof raw?.planToken === 'string') void callBatch('discard',{planToken:raw.planToken}).catch(()=>{}); throw error; }
      selected={parents:chats,parent:chats[0],items:review.items,includeDescendants:review.includeDescendants,review};
    }else {
      selected=planMany(chats,'archive',options.includeDescendants!==false);
      await window.__codexNestedRuntime?.closeNativeMenu?.();
    }
    if (busy || disposed || !enabled) return null;
    closeModal();
    modal = own(element('div', 'cnc-overlay'));
    modal.setAttribute('data-codex-cascade-dialog', 'scope');
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '批量归档范围');
    const box = element('div', 'cnc-box');
    box.append(element('h2', '', '确认批量归档'));
    box.append(element('p', '', `选中 ${selected.parents.length} 个对话${selected.includeDescendants ? '，包含它们的全部下级' : ''}，去重后共 ${selected.items.length} 个${selected.review?.implicitCount ? `聊天，另含 ${selected.review.implicitCount} 条后台记录` : ''}。`));
    if (selected.review?.implicitCount) box.append(element('h3', 'cnc-scope-heading', `聊天（${selected.items.length} 个）`));
    appendScopeList(box, selected);
    appendImplicitList(box, selected.review);
    for(const warning of selected.review?.warnings??[])box.append(element('p','cnc-note',warning));
    const controls = element('div', 'cnc-controls');
    const submit = element('button', 'cnc-button cnc-primary', selected.review?.implicitCount
      ? `按此范围归档 ${selected.items.length} 个聊天和 ${selected.review.implicitCount} 条后台记录` : `归档全部 ${selected.items.length} 个`);
    submit.type = 'button';
    submit.disabled = selected.review ? !enabled || window.__codexNestedCascadeOptions?.enableArchiveExecution!==true : !archiveReady();
    submit.addEventListener('click', () => selected.review?executeBatch(selected):execute(selected));
    const cancel = element('button', 'cnc-button', '取消'); cancel.type = 'button';
    cancel.addEventListener('click', () => {
      if(selected.review)void callBatch('discard',{planToken:selected.review.planToken}).catch(()=>{});
      closeModal();anchor?.focus?.();
    });
    controls.append(submit, cancel); box.append(controls); modal.append(box); document.body.append(modal);
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); cancel.click(); } });
    cancel.focus();
    state = { installed: true, state: 'scope_preview', operation: 'archive', parentId: selected.parent.id,
      rootIds: selected.parents.map(chat => chat.id), planned: selected.items.map(chat => chat.id),
      implicitTotal: selected.review?.implicitCount ?? 0, plannedImplicit: (selected.review?.implicitItems ?? []).map(item => item.id),
      submitted: [], verified: [], error: null };
    document.dispatchEvent(new CustomEvent('codex-nested:state-changed'));
    return { rootCount: selected.parents.length, count: selected.items.length,
      ...(selected.review?.implicitCount ? {implicitCount:selected.review.implicitCount} : {}), operation: 'archive' };
  }
  async function callBatch(action,input){
    if(typeof window.__codexNestedBatchArchive!=='function')throw Error('归档服务尚未连接，请重新打开对话管理。');
    const result=await window.__codexNestedBatchArchive(action,input);
    if(!result?.ok)throw Error(result?.message||'归档服务连接中断，请先检查本次结果。');
    return result.value;
  }
  async function executeBatch(selected){
    if(busy||disposed||!enabled)return;
    busy=true;controller=new AbortController();
    const signal=controller.signal, ui=progressDialog(selected);
    state={installed:true,state:'running',operation:'archive',planned:selected.items.map(row=>row.id),submitted:[],verified:[],
      implicitTotal:selected.review.implicitCount,verifiedImplicit:[],pendingImplicit:selected.review.implicitItems.map(item=>item.id),error:null};
    let job,requestedStop=false;
    try{
      job=await callBatch('confirm',{planToken:selected.review.planToken,
        ...(selected.review.implicitCount ? {backgroundReviewToken:selected.review.backgroundReviewToken} : {})});
      while(true){
        if(job.total!==selected.items.length)throw Error('聊天数量与已确认范围不一致，请先检查本次结果。');
        state.jobId=job.jobId;state.submitted=job.submitted||[];state.verified=job.verified||[];
        const implicit=readImplicitProgress(selected,job);
        state.implicitTotal=implicit.total;state.verifiedImplicit=implicit.verifiedValue;state.pendingImplicit=implicit.pendingValue;
        ui.progress.textContent=`已归档 ${state.verified.length} / ${job.total} 个对话`;
        if(ui.implicit)ui.implicit.textContent=`后台记录：已确认 ${implicit.verified} / ${implicit.total} 条 · 待确认 ${implicit.pending} 条`;
        ui.current.textContent=job.currentTitle?`当前对话：${job.currentTitle}`:'';
        if(!['queued','running','stopping'].includes(job.status))break;
        if(signal.aborted&&!requestedStop){requestedStop=true;job=await callBatch('stop',{jobId:job.jobId});continue;}
        await new Promise(resolve=>setTimeout(resolve,350));
        job=await callBatch('status',{jobId:job.jobId});
      }
      state.state=job.status;
      if(job.status==='completed'){
        const implicit=readImplicitProgress(selected,job);
        if(implicit.verified!==implicit.total||implicit.pending!==0)throw Error('后台记录尚未全部确认归档，请先检查本次结果。');
        ui.detail.textContent=`已归档全部 ${state.verified.length} 个对话${implicit.total?`，并确认 ${implicit.verified} 条后台记录归档`:''}。`;
      }
      else {
        state.error=job.error?.message||'后续归档已停止。';
        ui.detail.textContent=state.error+` 还有 ${job.pending?.length??0} 个对话未确认归档。`;
      }
    }catch(error){
      state.state='result_unavailable';state.error=String(error.message||error);
      ui.detail.textContent=state.error+' 请先检查当前归档结果，再决定是否重新提交。';
    }finally{
      ui.heading.textContent = state.state === 'completed' ? '归档完成' : '归档已停止';
      busy=false;controller=null;
      ui.stop.textContent='关闭';const close=ui.stop.cloneNode(true);ui.stop.replaceWith(close);close.addEventListener('click',closeModal);
      document.dispatchEvent(new CustomEvent('codex-nested:state-changed'));
    }
  }
  function intercept(event) {
    if (busy || disposed || !enabled || event.defaultPrevented) return;
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
    .cnc-box{box-sizing:border-box;width:min(570px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:22px;border:1px solid rgba(127,127,127,.35);border-radius:16px;background:var(--color-background-primary,#30302e);box-shadow:0 16px 70px rgba(0,0,0,.4)}
    .cnc-box h2{font-size:17px;margin:0 0 12px;font-weight:600}.cnc-box p{line-height:1.6;margin:8px 0}.cnc-scope{list-style:none;max-height:250px;overflow:auto;padding:10px 0;margin:12px 0;border-block:1px solid rgba(127,127,127,.2)}
    .cnc-scope li{padding-block:5px;overflow-wrap:anywhere}.cnc-chat-hint{display:block;opacity:.65;font-size:11px;margin-top:2px}.cnc-current{opacity:.8;overflow-wrap:anywhere}.cnc-note{opacity:.7;font-size:12px}.cnc-controls{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:18px}
    .cnc-scope-heading{font-size:14px;line-height:1.5;margin:14px 0 5px;font-weight:600}.cnc-implicit-section{border-top:1px solid rgba(127,127,127,.25)}.cnc-implicit-scope{max-height:190px;margin-top:6px}.cnc-implicit-progress{font-size:13px;line-height:1.6}
    .cnc-button{border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:7px 12px;color:inherit;background:transparent;font:inherit;cursor:pointer}.cnc-button:focus-visible{outline:2px solid currentColor;outline-offset:2px}.cnc-button:disabled{opacity:.4;cursor:default}.cnc-primary{background:rgba(127,127,127,.2)}`;
  document.head.append(style);
  document.addEventListener('click', intercept, true);
  document.addEventListener('keydown', intercept, true);
  window.addEventListener('keydown', archiveShortcutKeydown, true);
  window.addEventListener('codex-nested:archive-request', isolatedArchiveShortcut);
  Object.defineProperty(window, 'dispatchEvent', { configurable:true, writable:true,
    enumerable:dispatchDescriptor?.enumerable ?? false, value:dispatchEventWithArchiveShortcut });
  const api = {
    plan, preview, planMany, previewMany,
    setEnabled(value) { enabled=value===true; if(!enabled){controller?.abort();if(!busy)closeModal();}return api.inspect(); },
    listChats() { return [...graph().byId.values()].map(chat => ({ ...chat })); },
    inspect() { return { ...state, enabled, submitted: [...state.submitted], verified: [...(state.verified ?? [])], busy,
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
