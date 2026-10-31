(() => {
  'use strict';
  // Own UI only. Archive commands and result checks remain in cascade-actions.
  const previousSelection = window.__codexNestedBulk?.getSelectionState?.();
  window.__codexNestedBulk?.dispose();
  const OWN = 'data-codex-nested-bulk-owned';
  const NESTED_OWN = 'data-codex-nested-owned';
  const SIDEBAR = '#app-shell-sidebar';
  const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const MAX_SELECTION = 256;
  const selected = new Set(Array.isArray(previousSelection?.selected) ? previousSelection.selected
    .filter(value => typeof value === 'string' && UUID.test(value)).slice(0, MAX_SELECTION).map(value => value.toLowerCase()) : []);
  const collapsed = new Set(Array.isArray(previousSelection?.collapsed) ? previousSelection.collapsed
    .filter(value => typeof value === 'string' && UUID.test(value)).map(value => value.toLowerCase()) : []);
  const owned = new Set();
  let disposed = false, modal = null, entry = null, entryHost = null, refreshTimer = null;
  let filter = typeof previousSelection?.filter === 'string' ? previousSelection.filter : '';
  let includeDescendants = previousSelection?.includeDescendants !== false;
  let previewPending = false, status = 'ready', error = null, view = null, selectionChanged = false;

  function own(node) {
    node.setAttribute(OWN, ''); node.setAttribute(NESTED_OWN, ''); owned.add(node); return node;
  }
  function element(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, action, cls = '') {
    const node = element('button', `cnb-button ${cls}`, text); node.type = 'button';
    node.addEventListener('click', action); return node;
  }
  function valid(chat) {
    return !!chat && UUID.test(chat.id ?? '') && chat.kind === 'codex' &&
      (chat.hostId ?? 'local') === 'local' && typeof chat.title === 'string' && chat.archived !== true;
  }
  function catalog() {
    const cascade = window.__codexNestedCascade;
    let candidates;
    if (typeof cascade?.listChats === 'function') candidates = cascade.listChats();
    else {
      candidates = [];
      for (const group of Array.isArray(window.__codexNestedRelations?.groups) ? window.__codexNestedRelations.groups : []) {
        candidates.push(group?.parent, ...(group?.children ?? []));
      }
    }
    if (!Array.isArray(candidates)) throw new Error('聊天列表暂时无法读取。');
    const result = new Map();
    for (const chat of candidates) if (valid(chat)) {
      const id = chat.id.toLowerCase();
      if (!result.has(id)) result.set(id, { ...chat, id, hostId: 'local' });
    }
    return result;
  }
  function visible(node) {
    return !!node?.isConnected && node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
  }
  function notify() { document.dispatchEvent(new CustomEvent('codex-nested:state-changed')); }
  function unnamed(chat) { return !chat.title.trim() || chat.title.trim().toLowerCase() === chat.id; }
  function chatTitle(chat) { return unnamed(chat) ? '未命名聊天' : chat.title; }
  function matching(chats) {
    const query = filter.trim().toLocaleLowerCase();
    return [...chats.values()].filter(chat => !query || chat.title.toLocaleLowerCase().includes(query) || chat.id.includes(query) || chatTitle(chat).toLocaleLowerCase().includes(query));
  }
  function hierarchy(chats) {
    const titles = new Map(), parents = new Map(), children = new Map(), scopeChildren = new Map(), allParents = new Map();
    for (const chat of chats.values()) {
      const title = chatTitle(chat); titles.set(title, (titles.get(title) ?? 0) + 1);
      children.set(chat.id, []); scopeChildren.set(chat.id, new Set()); allParents.set(chat.id, new Set());
    }
    function link(parent, child) {
      // Display a chat once. Ignore missing parents, duplicate ownership, self
      // links and any edge that would close a cycle; every chat remains reachable.
      if (!chats.has(parent) || !chats.has(child) || parent === child) return;
      scopeChildren.get(parent).add(child); allParents.get(child).add(parent);
      if (parents.has(child)) return;
      const seen = new Set([child]);
      for (let cursor = parent; cursor; cursor = parents.get(cursor)) {
        if (seen.has(cursor)) return;
        seen.add(cursor);
      }
      parents.set(child, parent); children.get(parent).push(child);
    }
    for (const group of Array.isArray(window.__codexNestedRelations?.groups) ? window.__codexNestedRelations.groups : []) {
      if (!valid(group?.parent)) continue;
      const parent = group.parent.id.toLowerCase();
      for (const child of Array.isArray(group.children) ? group.children : []) if (valid(child)) link(parent, child.id.toLowerCase());
    }
    for (const chat of chats.values()) if (UUID.test(chat.parentId ?? '')) link(chat.parentId.toLowerCase(), chat.id);
    return { titles, parents, children, scopeChildren, allParents, roots: [...chats.keys()].filter(id => !parents.has(id)) };
  }
  function createdLabel(chat, precise) {
    const timestamp = chat.createdAtMs;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return '';
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return '';
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
    if (precise) options.second = '2-digit';
    return `创建于 ${new Intl.DateTimeFormat('zh-CN', options).format(date)}`;
  }
  function prune(chats) {
    for (const id of selected) if (!chats.has(id)) {
      selected.delete(id); selectionChanged = true;
      error = '聊天列表有变化，请重新核对所选聊天。';
    }
  }
  function showError(message) {
    error = String(message?.message ?? message).slice(0, 240);
    if (view) { view.error.textContent = error; view.error.hidden = false; }
  }
  function render() {
    if (!view || !modal?.isConnected) return;
    const focusedChat = document.activeElement?.getAttribute('data-codex-bulk-chat-id');
    const focusedToggle = document.activeElement?.getAttribute('data-codex-bulk-toggle-id');
    const scrollTop = view.list.scrollTop;
    let chats;
    try { chats = catalog(); prune(chats); }
    catch (failure) { showError(failure); view.archive.disabled = true; return; }
    const rows = matching(chats);
    const context = hierarchy(chats), matches = new Set(rows.map(chat => chat.id));
    modal.setAttribute('aria-busy', String(previewPending));
    const inherited = new Set();
    if (includeDescendants) {
      const pending = [...selected], visited = new Set(selected);
      while (pending.length) {
        for (const child of context.scopeChildren.get(pending.pop()) ?? []) if (!visited.has(child)) {
          visited.add(child); if (!selected.has(child)) inherited.add(child); pending.push(child);
        }
      }
    }
    const searching = !!filter.trim(), shown = new Set(matches);
    if (searching) for (const id of matches) {
      for (let parent = context.parents.get(id); parent && !shown.has(parent); parent = context.parents.get(parent)) shown.add(parent);
    }
    view.list.replaceChildren();
    view.count.textContent = `${previewPending ? '正在核对归档范围… · ' : ''}匹配 ${rows.length} 个聊天 · 已选 ${selected.size} 个${inherited.size ? ` · ${inherited.size} 个下级随上级归档` : ''}`;
    view.archive.textContent = previewPending ? '正在核对归档范围…' : `归档所选 ${selected.size} 个`;
    view.archive.disabled = selected.size === 0 || previewPending;
    view.all.disabled = rows.length === 0 || previewPending;
    view.invert.disabled = rows.length === 0 || previewPending;
    view.clear.disabled = selected.size === 0 || previewPending;
    view.search.disabled = previewPending; view.descendants.disabled = previewPending;
    for (const control of modal.querySelectorAll('.cnb-heading button,.cnb-footer button')) control.disabled = previewPending || (control === view.archive && selected.size === 0);
    if (rows.length === 0) view.list.append(element('p', 'cnb-empty', '没有匹配的聊天。'));
    const stack = context.roots.slice().reverse().map(id => ({ id, level: 1 }));
    while (stack.length) {
      const { id, level } = stack.pop();
      if (searching && !shown.has(id)) continue;
      const chat = chats.get(id), childIds = context.children.get(id).filter(child => !searching || shown.has(child));
      const expanded = childIds.length > 0 && (searching || !collapsed.has(id));
      const row = element('div', 'cnb-item'); row.setAttribute('role', 'treeitem');
      row.dataset.cnbRowId = id; row.dataset.cnbParentId = context.parents.get(id) ?? '';
      row.dataset.selected = String(selected.has(id)); row.dataset.pathOnly = String(searching && !matches.has(id)); row.dataset.inherited = String(inherited.has(id));
      row.setAttribute('aria-level', String(level)); row.setAttribute('aria-selected', String(selected.has(id)));
      if (childIds.length) row.setAttribute('aria-expanded', String(expanded));
      row.style.setProperty('--cnb-depth', String(Math.min(level - 1, 8)));
      if (childIds.length) {
        const toggle = button('', () => {
          if (expanded) collapsed.add(id); else collapsed.delete(id);
          render(); view.list.querySelector(`[data-codex-bulk-toggle-id="${id}"]`)?.focus();
        }, 'cnb-toggle');
        toggle.setAttribute('data-codex-bulk-toggle-id', id); toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-label', `${expanded ? '折叠' : '展开'} ${chatTitle(chat)}`);
        toggle.disabled = searching || previewPending;
        toggle.append(element('span', expanded ? 'cnb-chevron cnb-expanded' : 'cnb-chevron')); row.append(toggle);
      } else row.append(element('span', 'cnb-toggle-space'));
      const label = element('label', 'cnb-choice');
      const checkbox = element('input'); checkbox.type = 'checkbox';
      checkbox.checked = selected.has(chat.id); checkbox.disabled = previewPending;
      checkbox.setAttribute('data-codex-bulk-chat-id', chat.id);
      checkbox.addEventListener('change', () => {
        // Re-read the UUID membership at the action boundary; titles are display only.
        const fresh = catalog();
        if (!fresh.has(chat.id)) { selected.delete(chat.id); render(); return; }
        if (checkbox.checked) {
          if (selected.size >= MAX_SELECTION) {
            checkbox.checked = false; showError(`一次最多选择 ${MAX_SELECTION} 个聊天。`); return;
          }
          selected.add(chat.id);
        } else selected.delete(chat.id);
        error = null; selectionChanged = false; render();
      });
      const displayTitle = chatTitle(chat);
      const duplicate = (context.titles.get(displayTitle) ?? 0) > 1;
      const date = createdLabel(chat, duplicate);
      const parentTitles = [...context.allParents.get(chat.id)].map(parent => chatTitle(chats.get(parent)));
      const details = [date, ...(unnamed(chat) ? [`ID …${chat.id.slice(-8)}`] : []), ...(parentTitles.length ? [`上级：${parentTitles.join('、')}`] : [])].filter(Boolean);
      const description = element('span', 'cnb-description');
      const title = element('span', 'cnb-title', displayTitle); description.append(title);
      if (inherited.has(id)) description.append(element('span', 'cnb-inherited-badge', '随上级归档'));
      if (searching && !matches.has(id)) description.append(element('span', 'cnb-path-hint', '上级路径'));
      if (details.length) description.append(element('span', 'cnb-meta', details.join(' · ')));
      // Dates and parent names help a person distinguish rows. Selection and
      // execution continue to use only the verified canonical UUID.
      row.title = [displayTitle, ...details, ...(duplicate || unnamed(chat) ? [`对话标识：${chat.id}`] : [])].join('\n');
      const mark = element('span', 'cnb-check'); mark.setAttribute('aria-hidden', 'true');
      label.append(checkbox, mark, description); row.append(label); view.list.append(row);
      if (expanded) for (let i = childIds.length - 1; i >= 0; i--) stack.push({ id: childIds[i], level: level + 1 });
    }
    view.error.hidden = !error;
    view.error.textContent = error ?? '';
    if (focusedChat) view.list.querySelector(`[data-codex-bulk-chat-id="${focusedChat}"]`)?.focus();
    else if (focusedToggle) view.list.querySelector(`[data-codex-bulk-toggle-id="${focusedToggle}"]`)?.focus();
    view.list.scrollTop = scrollTop;
  }
  function updateSelection(invert) {
    if (previewPending) return;
    try {
      const chats = catalog(); prune(chats);
      const next = new Set(selected);
      for (const chat of matching(chats)) {
        if (invert && next.has(chat.id)) next.delete(chat.id); else next.add(chat.id);
      }
      // Reject the whole selection change instead of silently selecting a subset.
      if (next.size > MAX_SELECTION) throw new Error(`一次最多选择 ${MAX_SELECTION} 个聊天，请缩小筛选范围。`);
      selected.clear(); for (const id of next) selected.add(id);
      error = null; selectionChanged = false; render();
    } catch (failure) { showError(failure); }
  }
  function close({ clear = true, restoreFocus = true } = {}) {
    if (previewPending && clear) return;
    if (modal) { modal.remove(); owned.delete(modal); }
    modal = null; view = null;
    if (clear) { selected.clear(); filter = ''; error = null; selectionChanged = false; includeDescendants = true; }
    if (!disposed) status = 'ready';
    notify();
    if (restoreFocus && visible(entry)) entry.focus();
  }
  async function preview() {
    if (previewPending || disposed) return;
    const cascade = window.__codexNestedCascade;
    if (typeof cascade?.previewMany !== 'function') {
      showError('批量归档入口尚未就绪。'); return;
    }
    let chats;
    try { chats = catalog(); }
    catch (failure) { showError(failure); return; }
    // A stale selection must be reviewed again, never silently submitted smaller.
    if (selectionChanged || [...selected].some(id => !chats.has(id))) {
      prune(chats); selectionChanged = false;
      showError('聊天列表有变化，请重新核对所选聊天。'); render(); return;
    }
    const roots = [...selected].map(id => chats.get(id));
    if (!roots.length) return;
    previewPending = true; status = 'opening_scope'; error = null;
    const includeDescendants = view?.descendants.checked !== false;
    render(); notify();
    let reopen = false;
    try {
      const previewed = await cascade.previewMany(roots, { includeDescendants }, entry);
      if (!previewed) throw new Error('归档范围暂时无法打开，请稍后重试。');
      close({ clear: false, restoreFocus: false });
      status = 'scope_preview';
    } catch (failure) {
      status = 'preview_error'; error = String(failure?.message ?? failure).slice(0, 240);
      reopen = true;
    } finally {
      previewPending = false;
      if (reopen && !disposed && !modal?.isConnected) open();
      if (view) render(); notify();
    }
  }
  function open() {
    if (disposed || modal?.isConnected || previewPending) return false;
    const cascade = window.__codexNestedCascade?.inspect?.();
    if (cascade?.busy || cascade?.dialogOpen ||
        [...document.querySelectorAll('[role="dialog"][aria-modal="true"],[role="alertdialog"]')].some(visible)) return false;
    try { prune(catalog()); } catch (failure) { error = String(failure?.message ?? failure).slice(0, 240); }
    modal = own(element('div', 'cnb-overlay'));
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', '批量归档聊天');
    const box = element('section', 'cnb-box');
    const heading = element('div', 'cnb-heading');
    heading.append(element('h2', '', '批量归档聊天'), button('关闭', () => close()));
    const note = element('p', 'cnb-note', '按父子层级查看本机 Codex 聊天。搜索会保留上级路径；全选和反选只作用于匹配项，其他选择会保留。');
    const search = element('input', 'cnb-search'); search.type = 'search';
    search.placeholder = '按标题或聊天标识筛选'; search.setAttribute('aria-label', '按标题筛选聊天'); search.value = filter;
    search.addEventListener('input', () => { filter = search.value; error = null; render(); });
    const count = element('p', 'cnb-count'); count.setAttribute('role', 'status');
    const tools = element('div', 'cnb-tools');
    const all = button('全选当前筛选', () => updateSelection(false));
    const invert = button('反选当前筛选', () => updateSelection(true));
    const clear = button('清空选择', () => { selected.clear(); error = null; selectionChanged = false; render(); });
    tools.append(all, invert, clear);
    const list = element('div', 'cnb-list'); list.setAttribute('role', 'tree'); list.setAttribute('aria-label', '可归档聊天'); list.setAttribute('aria-multiselectable', 'true');
    list.addEventListener('keydown', event => {
      const row = event.target.closest('.cnb-item'), id = row?.dataset.cnbRowId;
      if (!id || event.altKey || event.ctrlKey || event.metaKey) return;
      const rows = [...list.querySelectorAll('.cnb-item')], index = rows.indexOf(row);
      const focusRow = target => target?.querySelector('[data-codex-bulk-chat-id]')?.focus();
      const toggle = row.querySelector('[data-codex-bulk-toggle-id]');
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        focusRow(event.key === 'Home' ? rows[0] : event.key === 'End' ? rows.at(-1) : rows[index + (event.key === 'ArrowDown' ? 1 : -1)]);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault(); event.stopPropagation();
        if (toggle?.getAttribute('aria-expanded') === 'false' && !toggle.disabled) { toggle.click(); list.querySelector(`[data-codex-bulk-chat-id="${id}"]`)?.focus(); }
        else if (rows[index + 1]?.dataset.cnbParentId === id) focusRow(rows[index + 1]);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault(); event.stopPropagation();
        if (toggle?.getAttribute('aria-expanded') === 'true' && !toggle.disabled) { toggle.click(); list.querySelector(`[data-codex-bulk-chat-id="${id}"]`)?.focus(); }
        else focusRow(rows.find(candidate => candidate.dataset.cnbRowId === row.dataset.cnbParentId));
      } else if (event.key === 'Enter' && event.target.matches('[data-codex-bulk-chat-id]')) {
        event.preventDefault(); event.stopPropagation(); event.target.click();
      }
    });
    const descendantLabel = element('label', 'cnb-descendants');
    const descendants = element('input'); descendants.type = 'checkbox'; descendants.checked = includeDescendants;
    descendants.addEventListener('change', () => { includeDescendants = descendants.checked; render(); });
    const descendantMark = element('span', 'cnb-check'); descendantMark.setAttribute('aria-hidden', 'true');
    descendantLabel.append(descendants, descendantMark, element('span', '', '同时归档所选主对话的全部下级'));
    const descendantNote = element('p', 'cnb-descendant-note', '下一步会列出完整归档范围，确认后才会执行。');
    const errorNode = element('p', 'cnb-error'); errorNode.setAttribute('role', 'alert'); errorNode.hidden = true;
    const footer = element('div', 'cnb-footer');
    const archive = button('归档所选 0 个', preview, 'cnb-primary');
    footer.append(button('取消', () => close()), archive);
    box.append(heading, note, search, count, tools, list, descendantLabel, descendantNote, errorNode, footer);
    modal.append(box); document.body.append(modal);
    view = { search, count, all, invert, clear, list, descendants, error: errorNode, archive };
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...box.querySelectorAll('button,input')].filter(node => !node.disabled && visible(node));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    status = 'selecting'; render(); search.focus(); notify(); return true;
  }
  function attach() {
    if (disposed) return;
    const roots = [...document.querySelectorAll(SIDEBAR)].filter(visible);
    const root = roots.length === 1 ? roots[0] : null;
    if (entryHost !== root || !entry?.isConnected) {
      if (entry) { entry.remove(); owned.delete(entry); }
      entry = null; entryHost = root;
      if (root) {
        entry = own(button('批量归档', open, 'cnb-entry'));
        entry.setAttribute('aria-label', '批量归档聊天'); root.prepend(entry);
      }
    }
    if (modal?.isConnected && !previewPending) render();
  }
  function schedule() {
    if (disposed || refreshTimer != null) return;
    refreshTimer = window.setTimeout(() => { refreshTimer = null; attach(); }, 80);
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => {
      if (record.target.nodeType === 1 && record.target.closest?.(`[${OWN}]`)) return false;
      if (record.type === 'attributes') return record.target.matches?.(SIDEBAR);
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 &&
        !node.hasAttribute(OWN) && (node.matches?.(SIDEBAR) || node.querySelector?.(SIDEBAR)));
    })) schedule();
  });
  const style = own(element('style'));
  style.textContent = `.cnb-entry{margin:5px 12px 7px!important;align-self:flex-start;font-size:12px!important;opacity:.8}
    .cnb-overlay{position:fixed;inset:0;z-index:2147482900;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);font:14px system-ui;color:var(--color-text,#eee)}
    .cnb-box{box-sizing:border-box;width:min(600px,calc(100vw - 40px));max-height:calc(100vh - 40px);display:flex;flex-direction:column;padding:22px;border:1px solid rgba(127,127,127,.35);border-radius:16px;background:var(--color-background-primary,#30302e);box-shadow:0 16px 70px rgba(0,0,0,.4)}
    .cnb-heading,.cnb-tools,.cnb-footer{display:flex;align-items:center;gap:8px}.cnb-heading{justify-content:space-between}.cnb-heading h2{font-size:17px;font-weight:600;margin:0}.cnb-note{font-size:12px;opacity:.72;line-height:1.6;margin:12px 0}
    .cnb-search{box-sizing:border-box;width:100%;padding:9px 11px;border:1px solid rgba(127,127,127,.45);border-radius:8px;background:transparent;color:inherit;font:inherit}.cnb-count{font-size:12px;margin:10px 0}.cnb-tools{flex-wrap:wrap}
    .cnb-button{border:1px solid rgba(127,127,127,.35);border-radius:8px;padding:7px 10px;background:transparent;color:inherit;font:inherit;cursor:pointer}.cnb-button:disabled{opacity:.4;cursor:default}.cnb-primary{background:rgba(127,127,127,.2)}
    .cnb-list{overflow:auto;min-height:80px;max-height:340px;margin:12px 0;border-block:1px solid rgba(127,127,127,.2);padding:5px 0}.cnb-item{display:flex;align-items:center;gap:10px;min-height:34px;padding:6px 4px;border-radius:6px;cursor:pointer}.cnb-item:hover{background:rgba(127,127,127,.12)}.cnb-description{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0}.cnb-title{overflow-wrap:anywhere;min-width:0;line-height:1.5}.cnb-meta{font-size:11px;opacity:.65;line-height:1.5;overflow-wrap:anywhere}.cnb-item input,.cnb-descendants input{flex:none;width:16px;height:16px;margin:0;accent-color:currentColor}
    .cnb-descendants{display:flex;align-items:center;gap:9px;line-height:1.5}.cnb-footer{justify-content:flex-end;margin-top:15px}.cnb-error{color:var(--color-text-danger,#f3a39d);font-size:12px;line-height:1.5}.cnb-empty{opacity:.65}.cnb-button:focus-visible,.cnb-search:focus-visible{outline:2px solid currentColor;outline-offset:2px}
    .cnb-overlay{--cnb-bg:var(--color-background-primary,#fff);--cnb-fg:var(--color-text,#202124);--cnb-selected:rgba(42,109,222,.12);--cnb-line:rgba(127,127,127,.35);color:var(--cnb-fg)}
    .cnb-box{width:min(680px,calc(100vw - 32px));padding:22px;background:var(--cnb-bg);color:var(--cnb-fg)}
    .cnb-primary{background:var(--cnb-fg);color:var(--cnb-bg);border-color:var(--cnb-fg)}
    .cnb-list{padding:5px 2px;max-height:min(400px,45vh)}
    .cnb-item{position:relative;gap:3px;min-height:42px;padding:4px 7px 4px calc(4px + var(--cnb-depth,0)*17px);border:1px solid transparent;border-radius:8px}
    .cnb-item[data-selected="true"]{background:var(--cnb-selected);border-color:rgba(42,109,222,.4)}
    .cnb-inherited-badge{display:inline-flex;align-self:flex-start;font-size:10px;line-height:1.5;padding:0 5px;border:1px solid var(--cnb-line);border-radius:4px;color:var(--cnb-fg)}
    .cnb-item[data-path-only="true"] .cnb-title{font-weight:500}.cnb-path-hint{font-size:10px;opacity:.7;line-height:1.4}
    .cnb-choice{position:relative;display:flex;align-items:center;gap:10px;flex:1;min-width:0;min-height:34px;cursor:pointer}
    .cnb-toggle,.cnb-toggle-space{box-sizing:border-box;flex:none;width:27px;height:30px}
    .cnb-toggle{display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:5px;opacity:1!important}
    .cnb-toggle:hover{background:rgba(127,127,127,.2)}.cnb-toggle:disabled{cursor:default}
    .cnb-chevron{display:block;width:6px;height:6px;border-right:1.8px solid currentColor;border-bottom:1.8px solid currentColor;transform:rotate(-45deg);pointer-events:none}
    .cnb-chevron.cnb-expanded{transform:rotate(45deg) translate(-1px,-1px)}
    .cnb-check{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:19px;height:19px;border:2px solid currentColor;border-radius:4px;background:var(--cnb-bg);color:var(--cnb-fg);pointer-events:none}
    .cnb-choice input,.cnb-descendants input{position:absolute;left:0;top:50%;transform:translateY(-50%);width:21px;height:23px;margin:0;opacity:0;z-index:1;cursor:pointer}
    .cnb-choice input:checked+.cnb-check,.cnb-descendants input:checked+.cnb-check{background:var(--cnb-fg);color:var(--cnb-bg);border-color:var(--cnb-fg)}
    .cnb-choice input:checked+.cnb-check::after,.cnb-descendants input:checked+.cnb-check::after{content:'';width:8px;height:4px;border-left:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-1px) rotate(-45deg)}
    .cnb-choice input:focus-visible+.cnb-check,.cnb-descendants input:focus-visible+.cnb-check{outline:2px solid var(--cnb-fg);outline-offset:3px}
    .cnb-choice input:disabled+.cnb-check{opacity:.45}.cnb-descendants{position:relative;min-height:27px;font-weight:500}.cnb-descendant-note{font-size:11px;opacity:.7;margin:3px 0 0 28px;line-height:1.5}
    .cnb-description{gap:2px}.cnb-meta{opacity:.75}.cnb-title{line-height:1.45}
    @media(prefers-color-scheme:dark){.cnb-overlay{--cnb-bg:var(--color-background-primary,#292927);--cnb-fg:var(--color-text,#f1f1ef);--cnb-selected:rgba(122,169,255,.16)}}
    :is(.dark,[data-theme="dark"]) .cnb-overlay{--cnb-bg:var(--color-background-primary,#292927);--cnb-fg:var(--color-text,#f1f1ef);--cnb-selected:rgba(122,169,255,.16)}
    :is(.light,[data-theme="light"]) .cnb-overlay{--cnb-bg:var(--color-background-primary,#fff);--cnb-fg:var(--color-text,#202124);--cnb-selected:rgba(42,109,222,.12)}
    @media(max-width:480px){.cnb-box{padding:15px;max-height:calc(100vh - 24px)}.cnb-heading h2{font-size:16px}.cnb-tools .cnb-button{font-size:12px;padding:6px 8px}.cnb-item{padding-inline-start:calc(2px + var(--cnb-depth,0)*11px)}.cnb-toggle,.cnb-toggle-space{width:22px}.cnb-choice{gap:8px}.cnb-list{max-height:40vh}}
    @media(forced-colors:active){.cnb-overlay{--cnb-bg:Canvas;--cnb-fg:CanvasText;--cnb-selected:Canvas}.cnb-box,.cnb-search,.cnb-button{border:1px solid ButtonText}.cnb-item[data-selected="true"]{border-color:Highlight;outline:1px solid Highlight}.cnb-choice input:checked+.cnb-check,.cnb-descendants input:checked+.cnb-check{background:Highlight;color:HighlightText;border-color:Highlight}.cnb-check{forced-color-adjust:none}.cnb-choice input:focus-visible+.cnb-check,.cnb-descendants input:focus-visible+.cnb-check{outline-color:Highlight}.cnb-toggle{border:0}}`;
  document.head.append(style);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'aria-hidden'] });
  document.addEventListener('codex-nested:state-changed', schedule);
  document.addEventListener('codex-nested:relations-changed', schedule);
  const api = {
    open, close,
    refresh: attach,
    getSelectionState() { return { selected: [...selected], filter, includeDescendants, collapsed: [...collapsed] }; },
    inspect() { return { installed: !disposed, state: status, dialogOpen: !!modal?.isConnected,
      previewPending, selected: [...selected], filter, error, entryVisible: visible(entry) }; },
    dispose() {
      if (disposed) return;
      disposed = true; observer.disconnect(); window.clearTimeout(refreshTimer);
      document.removeEventListener('codex-nested:state-changed', schedule);
      document.removeEventListener('codex-nested:relations-changed', schedule);
      for (const node of owned) node.remove(); owned.clear(); modal = null; entry = null; view = null;
      selected.clear(); status = 'disposed'; notify();
    }
  };
  window.__codexNestedBulk = api; attach(); return api.inspect();
})();
