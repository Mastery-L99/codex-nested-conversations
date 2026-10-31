(() => {
  'use strict';
  // Runtime-only enhancement. Selectors are grounded in sidebar-rows.json.
  // No application state, conversation body, authentication, or storage is read.
  const previousExpansion = window.__codexNestedRuntime?.getExpansionState?.() ?? window.__codexNestedExpansionState;
  const previousAliases = window.__codexNestedRuntime?.getIdentityAliases?.() ?? window.__codexNestedIdentityAliases;
  window.__codexNestedRuntime?.dispose();
  const ROOT = '#app-shell-sidebar';
  const ROW = '[data-app-action-sidebar-thread-row]';
  const OWNER = 'data-codex-nested-owned';
  const HIDDEN = 'data-codex-nested-flat-hidden';
  const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const expanded = new Map(Array.isArray(previousExpansion) ? previousExpansion.filter(entry =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' &&
    entry[0].startsWith('local:') && UUID.test(entry[0].slice(6)) && typeof entry[1] === 'boolean')
    .map(([ident, value]) => [ident.toLowerCase(), value]) : []);
  const changed = new Map();
  const TEMP_ID = /^local:client-new-thread:[0-9a-f-]{36}$/i;
  const aliases = new Map(Array.isArray(previousAliases) ? previousAliases.filter(entry =>
    Array.isArray(entry) && TEMP_ID.test(entry[0]) && UUID.test(entry[1])).map(([a,b])=>[a.toLowerCase(),b.toLowerCase()]) : []);
  let aliasCandidate=null, aliasTimer=null;
  const hiddenNativeDisplay = new WeakMap();
  const nodes = new Set();
  let observer, timer, disposed = false, reconciling = false;
  let treeEnabled = window.__codexNestedUiOptions?.enabled !== false;
  let menuLease = null, menuContext = null, observedMenuTrigger = null, menuDirty = false;
  let last = { installed: true, groups: 0, childItems: 0, hiddenFlatRows: 0, errors: [] };

  function validChat(value) {
    return value && UUID.test(value.id) && typeof value.title === 'string' &&
      value.kind === 'codex' && (value.hostId ?? 'local') === 'local';
  }
  function key(chat) { return `local:${chat.id.toLowerCase()}`; }
  function normalize(data) {
    const out = [], seenParents = new Set();
    for (const group of data?.groups ?? []) {
      if (!validChat(group?.parent) || seenParents.has(key(group.parent))) continue;
      const seen = new Set([key(group.parent)]);
      const children = [];
      for (const child of group.children ?? []) {
        if (validChat(child) && !seen.has(key(child))) {
          seen.add(key(child)); children.push(child);
        }
      }
      if (children.length) { seenParents.add(key(group.parent)); out.push({ parent: group.parent, children }); }
    }
    return out;
  }
  function own(node) {
    node.setAttribute(OWNER, ''); nodes.add(node); return node;
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function changeAttribute(element, name, value) {
    let values = changed.get(element);
    if (!values) { values = new Map(); changed.set(element, values); }
    if (!values.has(name)) values.set(name, element.getAttribute(name));
    if (name === HIDDEN && value === 'true' && !hiddenNativeDisplay.has(element)) {
      hiddenNativeDisplay.set(element, getComputedStyle(element).display);
    }
    if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
  }
  function restore() {
    for (const element of nodes) element.remove();
    nodes.clear();
    for (const [element, attrs] of changed) {
      for (const [name, value] of attrs) {
        if (value === null) element.removeAttribute(name); else element.setAttribute(name, value);
      }
      hiddenNativeDisplay.delete(element);
    }
    changed.clear();
  }
  function identity(row) {
    if (row.getAttribute('data-app-action-sidebar-thread-kind') !== 'local' ||
        row.getAttribute('data-app-action-sidebar-thread-host-id') !== 'local') return null;
    const id = row.getAttribute('data-app-action-sidebar-thread-id');
    if(id?.startsWith('local:') && UUID.test(id.slice(6))) return id.toLowerCase();
    return TEMP_ID.test(id??'') && aliases.has(id.toLowerCase()) ? `local:${aliases.get(id.toLowerCase())}` : null;
  }
  function learnVisibleIdentity(root) {
    // Read only the canonical ID on the visible response carrier, never its text.
    const canonical = new Set([...document.querySelectorAll('[data-response-annotation-conversation]')]
      .filter(e=>e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}))
      .map(e=>e.getAttribute('data-response-annotation-conversation')).filter(id=>UUID.test(id??'')));
    const selected = [...root.querySelectorAll(`${ROW}[data-app-action-sidebar-thread-selected="true"]`)]
      .filter(row=>nativeVisible(row,root));
    const ids = new Set(selected.map(row=>row.getAttribute('data-app-action-sidebar-thread-id')));
    if(canonical.size!==1 || ids.size!==1) {aliasCandidate=null;return;}
    const real=[...canonical][0].toLowerCase(), temporary=[...ids][0];
    if(!TEMP_ID.test(temporary??'')) {aliasCandidate=null;return;}
    const chat=knownChat({id:real,title:'',kind:'codex',hostId:'local'});
    if(!chat || selected.some(row=>row.getAttribute('data-app-action-sidebar-thread-title')!==chat.title)) {aliasCandidate=null;return;}
    const temporaryKey=temporary.toLowerCase();
    if(aliases.get(temporaryKey)===real)return;
    const signature=temporaryKey+'|'+real;
    if(aliasCandidate?.signature!==signature) {
      aliasCandidate={signature,since:performance.now()};
      clearTimeout(aliasTimer);aliasTimer=setTimeout(schedule,220);return;
    }
    if(performance.now()-aliasCandidate.since<200)return;
    aliases.set(temporaryKey,real);aliasCandidate=null;
    document.dispatchEvent(new CustomEvent('codex-nested:identity-mapped'));
  }
  function indexRows(root) {
    learnVisibleIdentity(root);
    const result = new Map();
    for (const row of root.querySelectorAll(ROW)) {
      if (!nativeVisible(row, root)) continue;
      const id = identity(row);
      if (!id) continue;
      if (!result.has(id)) result.set(id, []);
      result.get(id).push(row);
    }
    return result;
  }
  function nativeVisible(row, root) {
    if (!row.isConnected || !root.contains(row)) return false;
    for (let element = row; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (style.display === 'none') {
        // Preserve source rows hidden only by this enhancement. Native cached
        // mode containers still fail this test anywhere along the ancestor path.
        const ownFlatHide = element.getAttribute(HIDDEN) === 'true' &&
          changed.get(element)?.has(HIDDEN) && hiddenNativeDisplay.get(element) !== 'none' &&
          !element.hidden && element.style.display !== 'none';
        if (!ownFlatHide) return false;
      }
      if (element === root) return true;
    }
    return false;
  }
  function wrapper(row) {
    const parent = row.closest('[data-codex-tab-conversation-drop-target]');
    // Do not hide a section or an ancestor containing multiple native rows.
    return parent && parent.querySelectorAll(ROW).length === 1 ? parent : row;
  }
  function nativeSelected(rows) {
    for (const row of rows) if (row.getAttribute('data-app-action-sidebar-thread-selected') === 'true') return true;
    return false;
  }
  function setStatus(host, message) {
    let status = host.querySelector('.cnv-status');
    if (!status) { status = node('div', 'cnv-status'); status.setAttribute('role', 'status'); host.append(status); }
    status.textContent = message;
  }
  function knownChat(value) {
    if (!validChat(value)) return null;
    for (const chat of window.__codexNestedRelations?.catalog ?? []) {
      if (validChat(chat) && key(chat) === key(value)) return chat;
    }
    if (Array.isArray(window.__codexNestedRelations?.catalog)) return null;
    for (const group of normalize(window.__codexNestedRelations)) {
      for (const chat of [group.parent, ...group.children]) if (key(chat) === key(value)) return chat;
    }
    return null;
  }
  function visibleMenu(trigger) {
    if (!trigger?.isConnected) return null;
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    });
    const uniqueId = value => value && document.querySelectorAll(`#${CSS.escape(value)}`).length === 1;
    const controls = (trigger.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean);
    const matched = menus.filter(element =>
      (uniqueId(trigger.id) && (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).includes(trigger.id)) ||
      (uniqueId(element.id) && controls.includes(element.id)));
    // A single open menu is not evidence of ownership. Both missing and
    // ambiguous ARIA linkage must fail closed before any cascading operation.
    return matched.length === 1 ? matched[0] : null;
  }
  function currentMenuContext() {
    if (!menuContext || !observedMenuTrigger) return null;
    const menu = visibleMenu(observedMenuTrigger);
    return menu ? { ...menuContext, menuElement: menu } : null;
  }
  function releaseMenuLease() {
    const lease = menuLease;
    menuLease = null;
    if (lease) {
      clearInterval(lease.poll);
      for (const [element, name, descriptor] of lease.methods.reverse()) {
        if (descriptor) Object.defineProperty(element, name, descriptor); else delete element[name];
      }
    }
    if (!lease || observedMenuTrigger === lease.trigger) {
      menuContext = null; observedMenuTrigger = null;
    }
    if (menuDirty && !disposed) { menuDirty = false; schedule(); }
  }
  async function closeNativeMenu() {
    const trigger = observedMenuTrigger || menuLease?.trigger;
    const menu = visibleMenu(trigger);
    if (menu?.isConnected) menu.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', bubbles: true, cancelable: true
    }));
    for (let index = 0; index < 15 && visibleMenu(trigger); index++) {
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const closed = !visibleMenu(trigger);
    releaseMenuLease();
    menuContext = null; observedMenuTrigger = null;
    return { closed };
  }
  function menuAnchor(anchor) {
    const rect = anchor?.getBoundingClientRect?.() || anchor;
    if (!rect) return null;
    const left = Number(rect.left ?? rect.x ?? rect.clientX), top = Number(rect.top ?? rect.y ?? rect.clientY);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    const width = Math.max(1, Number(rect.width) || 1), height = Math.max(1, Number(rect.height) || 1);
    return new DOMRect(Math.max(0, Math.min(left, innerWidth - 1)),
      Math.max(0, Math.min(top, innerHeight - 1)), width, height);
  }
  async function openNativeMenu(value, anchor) {
    const chat = knownChat(value), rect = menuAnchor(anchor);
    if (disposed || !chat || !rect) throw new Error('Native menu requires a known local chat and visible anchor');
    await closeNativeMenu();
    const lease = { methods: [], pending: true, trigger: null, poll: null };
    menuLease = lease; menuContext = { ...chat };
    try {
      let root = document.querySelector(ROOT), source = root && indexRows(root).get(key(chat))?.[0];
      if (!source && typeof window.__codexNestedOpen === 'function') {
        await window.__codexNestedOpen({ id: chat.id, kind: 'codex', hostId: 'local' });
        for (let index = 0; index < 80 && !source && !disposed; index++) {
          await new Promise(resolve => setTimeout(resolve, 50));
          root = document.querySelector(ROOT); source = root && indexRows(root).get(key(chat))?.[0];
        }
      }
      if (disposed || menuLease !== lease || !source) throw new Error('Native chat row is not available');
      const trigger = source.querySelector('button[aria-haspopup="menu"][aria-label="聊天操作"]') ||
        source.querySelector('button[aria-haspopup="menu"]');
      if (!trigger || trigger.getAttribute('aria-disabled') === 'true' || trigger.disabled) throw new Error('Native menu trigger is not available');
      lease.trigger = trigger; observedMenuTrigger = trigger;
      // Keep the original React-owned row and native event handlers in place.
      // Only its temporary menu reference geometry points at the nested control.
      for (const element of [trigger, source]) {
        for (const [name, method] of [['getBoundingClientRect', () => rect], ['getClientRects', () => [rect]]]) {
          lease.methods.push([element, name, Object.getOwnPropertyDescriptor(element, name)]);
          Object.defineProperty(element, name, { configurable: true, value: method });
        }
      }
      trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, buttons: 1, pointerId: 1,
        pointerType: 'mouse', isPrimary: true, clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new PointerEvent('pointerup', { button: 0, buttons: 0, pointerId: 1,
        pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true }));
      let menu;
      for (let index = 0; index < 4 && !(menu = visibleMenu(trigger)); index++) await new Promise(resolve => setTimeout(resolve, 35));
      if (!menu) trigger.click();
      for (let index = 0; index < 30 && !(menu = visibleMenu(trigger)); index++) await new Promise(resolve => setTimeout(resolve, 40));
      if (!menu || disposed || menuLease !== lease) throw new Error('Native menu did not open');
      lease.pending = false; menuContext = { ...chat, menuElement: menu };
      lease.poll = setInterval(() => {
        if (!source.isConnected || !visibleMenu(trigger)) releaseMenuLease();
      }, 100);
      return { opened: true, chat: { ...chat }, menuElement: menu };
    } catch (error) { if (menuLease === lease) releaseMenuLease(); throw error; }
  }
  function rememberNativeContext(event) {
    const target = event.target?.closest?.(ROW), root = document.querySelector(ROOT);
    if (!target || !root?.contains(target) || !nativeVisible(target, root)) return;
    if (event.type !== 'contextmenu' && !event.target.closest?.('button[aria-haspopup="menu"]')) return;
    // Every native chat menu activation replaces the old owner, including
    // chats outside the manifest and rows whose identity cannot be established.
    menuContext = null;
    observedMenuTrigger = event.target.closest?.('button[aria-haspopup="menu"]') ||
      target.querySelector('button[aria-haspopup="menu"][aria-label="聊天操作"]') ||
      target.querySelector('button[aria-haspopup="menu"]');
    const ident = identity(target);
    if (!ident) return;
    const chat = knownChat({ id: ident.slice(6), title: target.getAttribute('data-app-action-sidebar-thread-title') || '', kind: 'codex', hostId: 'local' });
    if (chat) menuContext = { ...chat };
  }
  function parentContextMenu(event) {
    const root = document.querySelector(ROOT), row = event.target?.closest?.(ROW);
    if (!root || !row || !root.contains(row) || !nativeVisible(row, root)) return;
    const ident = identity(row);
    if (!ident) return;
    const group = normalize(window.__codexNestedRelations).find(candidate =>
      key(candidate.parent) === ident && candidate.children.length > 0);
    if (!group) return;
    // A parent right-click must use the same identity-bound native dropdown as
    // its nested children. A host context menu may have no DOM/ARIA owner and
    // cannot safely participate in a cascading action.
    event.preventDefault(); event.stopImmediatePropagation();
    openNativeMenu(group.parent, { clientX: event.clientX, clientY: event.clientY, width: 1, height: 1 })
      .catch(error => {
        last.lastMenuError = String(error?.message ?? error).slice(0, 160);
        if (disposed || !row.isConnected) return;
        const status = own(node('div', 'cnv-status', '暂时无法打开这个主对话的操作菜单，请重试。'));
        status.setAttribute('role', 'status'); wrapper(row).insertAdjacentElement('afterend', status);
      });
  }
  async function openChat(chat, host) {
    if (!validChat(chat)) return;
    const root = document.querySelector(ROOT);
    const source = root && (indexRows(root).get(key(chat)) ?? [])[0];
    try {
      if (source?.isConnected) source.click();
      else if (typeof window.__codexNestedOpen === 'function') await window.__codexNestedOpen({ id: chat.id, kind: 'codex', hostId: 'local' });
      else setStatus(host, '此聊天尚未载入，请先从原列表打开。');
    } catch (error) {
      setStatus(host, '暂时无法打开此聊天，请从原列表重试。');
      last.lastOpenError = String(error?.message ?? error).slice(0, 160);
    }
  }
  function toggleButton(parent, count, onToggle) {
    const button = node('button', 'cnv-toggle');
    button.type = 'button';
    const isExpanded = expanded.get(key(parent)) !== false;
    button.textContent = isExpanded ? '▾' : '▸';
    button.setAttribute('aria-expanded', String(isExpanded));
    button.setAttribute('aria-label', `${isExpanded ? '收起' : '展开'} ${parent.title} 的 ${count} 个子对话`);
    button.title = `${count} 个子对话`;
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      expanded.set(key(parent), !isExpanded); onToggle();
    });
    button.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    });
    return button;
  }
  function appendChildren(list, group, groupsByParent, rowsById, ancestry, host) {
    if (ancestry.has(key(group.parent))) { last.errors.push('Relation cycle skipped'); return; }
    const nextAncestry = new Set(ancestry).add(key(group.parent));
    for (const child of group.children) {
      const childRows = rowsById.get(key(child)) ?? [];
      const item = node('div', 'cnv-child-item');
      const line = node('div', 'cnv-child-line');
      const subgroup = groupsByParent.get(key(child));
      if (subgroup && !nextAncestry.has(key(child))) {
        line.append(toggleButton(child, subgroup.children.length, schedule));
      } else line.append(node('span', 'cnv-leaf-mark', '·'));
      const button = node('button', 'cnv-open');
      button.type = 'button';
      button.setAttribute('data-codex-nested-chat-id', child.id);
      button.setAttribute('aria-label', `打开子对话：${child.title}`);
      button.title = child.title;
      if (nativeSelected(childRows)) { button.setAttribute('aria-current', 'page'); line.classList.add('cnv-selected'); }
      const title = node('span', 'cnv-title', child.title);
      button.append(title);
      const indicator = childRows.map(row => row.getAttribute('data-sidebar-indicator')).find(Boolean);
      if (indicator) {
        const dot = node('span', `cnv-indicator cnv-${indicator}`);
        dot.title = indicator === 'working' ? '处理中' : indicator === 'unread' ? '未读' : '';
        button.append(dot);
      }
      if (!childRows.length && typeof window.__codexNestedOpen !== 'function') {
        button.disabled = true; button.title = `${child.title}（尚未载入）`;
      }
      button.addEventListener('click', event => { event.stopPropagation(); openChat(child, host); });
      const more = node('button', 'cnv-more', '⋯');
      more.type = 'button'; more.setAttribute('aria-label', `子对话更多操作：${child.title}`);
      more.setAttribute('aria-haspopup', 'menu'); more.title = '更多操作';
      const showMenu = async anchor => {
        try { await openNativeMenu(child, anchor); }
        catch (error) { setStatus(host, '此聊天的原生菜单暂时无法打开，请从原聊天重试。'); last.lastMenuError = String(error?.message ?? error).slice(0, 160); }
      };
      more.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); showMenu(more); });
      line.addEventListener('contextmenu', event => {
        event.preventDefault(); event.stopPropagation(); showMenu({ clientX: event.clientX, clientY: event.clientY, width: 1, height: 1 });
      });
      line.append(button, more); item.append(line); list.append(item); last.childItems++;
      if (subgroup && expanded.get(key(child)) !== false && !nextAncestry.has(key(child))) {
        const nested = node('div', 'cnv-children cnv-deeper');
        item.append(nested); appendChildren(nested, subgroup, groupsByParent, rowsById, nextAncestry, host);
      }
    }
  }
  function installStyle() {
    const style = own(node('style'));
    style.textContent = `
      [${HIDDEN}="true"] { display:none !important; }
      .cnv-toggle { display:inline-flex;align-items:center;justify-content:center;flex:0 0 16px;width:16px;height:22px;margin:0 3px 0 0;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;opacity:.68;font:12px system-ui;cursor:pointer; }
      .cnv-toggle:hover,.cnv-toggle:focus-visible { opacity:1;background:rgba(127,127,127,.15); }
      .cnv-children { margin:0 5px 3px 18px;padding:1px 0 1px 6px;border-left:1px solid rgba(127,127,127,.24);font:inherit;color:inherit; }
      .cnv-deeper { margin-left:11px; }
      .cnv-child-line { display:flex;align-items:center;min-width:0;min-height:27px;border-radius:6px; }
      .cnv-child-line:hover,.cnv-selected { background:var(--color-primary-ghost-hover,rgba(127,127,127,.12)); }
      .cnv-leaf-mark { flex:0 0 14px;text-align:center;opacity:.45; }
      .cnv-open { display:flex;align-items:center;gap:6px;flex:1;min-width:0;text-align:left;padding:5px 7px 5px 0;border:0;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:17px;cursor:pointer; }
      .cnv-open:focus-visible,.cnv-toggle:focus-visible { outline:2px solid currentColor;outline-offset:-2px; }
      .cnv-open:disabled { opacity:.45;cursor:default; }
      .cnv-more { flex:0 0 24px;width:24px;height:24px;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;font:18px/20px system-ui;cursor:pointer;opacity:0; }
      .cnv-child-line:hover .cnv-more,.cnv-child-line:focus-within .cnv-more { opacity:.8; }
      .cnv-more:hover,.cnv-more:focus-visible { opacity:1;background:rgba(127,127,127,.15);outline:1px solid currentColor; }
      @media (hover:none) { .cnv-more { opacity:.8; } }
      .cnv-title { display:block;min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis; }
      .cnv-indicator { flex:0 0 5px;width:5px;height:5px;margin-right:5px;border-radius:50%;background:#8ba9c5; }
      .cnv-working { background:currentColor;opacity:.65; }
      .cnv-status { padding:4px 8px;font-size:11px;line-height:15px;opacity:.7; }
    `;
    document.head.append(style);
  }
  function observe() {
    if (disposed || !document.body) return;
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-app-action-sidebar-thread-selected', 'data-app-action-sidebar-thread-title',
        'data-app-action-sidebar-thread-id', 'data-sidebar-indicator', 'data-app-action-sidebar-thread-kind',
        'data-app-action-sidebar-thread-host-id', 'data-response-annotation-conversation', 'style', 'hidden'] });
  }
  function reconcile() {
    if (disposed || reconciling) return;
    if (menuLease) { menuDirty = true; return; }
    reconciling = true; observer.disconnect();
    try {
      restore();
      last = { installed: true, groups: 0, childItems: 0, hiddenFlatRows: 0, errors: [] };
      const root = document.querySelector(ROOT);
      if (!root) { last.state = 'sidebar_not_available'; return; }
      // Identity and native-menu APIs remain available when tree rendering is
      // disabled. Bulk archive does not need the folder-like representation.
      learnVisibleIdentity(root);
      if (!treeEnabled) { last.state = 'bridge_only'; return; }
      const groups = normalize(window.__codexNestedRelations);
      if (!groups.length) { last.state = 'no_verified_local_relations'; return; }
      const rowsById = indexRows(root), byParent = new Map(groups.map(group => [key(group.parent), group]));
      const childKeys = new Set(groups.flatMap(group => group.children.map(key)));
      const renderable = groups.filter(group => !childKeys.has(key(group.parent)) && rowsById.has(key(group.parent)));
      if (!renderable.length) { last.state = 'parent_rows_not_loaded'; return; }
      installStyle();
      const renderedChildren = new Set();
      function collect(group, seen = new Set()) {
        if (seen.has(key(group.parent))) return;
        const next = new Set(seen).add(key(group.parent));
        for (const child of group.children) { renderedChildren.add(key(child)); const sub = byParent.get(key(child)); if (sub) collect(sub, next); }
      }
      for (const group of renderable) {
        for (const parentRow of rowsById.get(key(group.parent))) {
          const parentWrapper = wrapper(parentRow);
          const trigger = parentRow.querySelector('[data-thread-title-trigger]');
          if (!trigger || !parentWrapper.parentNode) { last.errors.push('Verified parent has no supported title trigger'); continue; }
          const toggle = own(toggleButton(group.parent, group.children.length, schedule));
          trigger.prepend(toggle);
          const host = own(node('div', 'cnv-children'));
          host.setAttribute('role', 'group');
          host.setAttribute('aria-label', `${group.parent.title} 的子对话`);
          host.setAttribute('data-codex-nested-parent-id', group.parent.id);
          parentWrapper.insertAdjacentElement('afterend', host);
          collect(group);
          if (expanded.get(key(group.parent)) !== false) appendChildren(host, group, byParent, rowsById, new Set(), host);
          else host.hidden = true;
          last.groups++;
        }
      }
      if (last.groups) {
        for (const childKey of renderedChildren) {
          for (const row of rowsById.get(childKey) ?? []) {
            changeAttribute(wrapper(row), HIDDEN, 'true'); last.hiddenFlatRows++;
          }
        }
      }
      last.state = 'active';
    } catch (error) {
      restore(); last.state = 'restored_after_error'; last.errors.push(String(error?.message ?? error).slice(0, 160));
    } finally { reconciling = false; observe(); }
  }
  function schedule() {
    if (disposed || timer) return;
    timer = window.setTimeout(() => { timer = null; reconcile(); }, 80);
  }
  observer = new MutationObserver(records => {
    const root = document.querySelector(ROOT);
    const relevant = records.some(record => {
      if(record.type==='attributes' && record.attributeName==='data-response-annotation-conversation')return true;
      if (record.target.nodeType === 1 && record.target.closest?.(`[${OWNER}]`)) return false;
      if (root && (record.target === root || root.contains(record.target))) return true;
      return [...record.addedNodes, ...record.removedNodes].some(item => item.nodeType === 1 &&
        (item.matches?.(ROOT) || item.querySelector?.(ROOT) || item.matches?.('[data-response-annotation-conversation]') || item.querySelector?.('[data-response-annotation-conversation]')));
    });
    if (relevant) schedule();
  });
  const api = {
    apply(data) { if (data !== undefined) window.__codexNestedRelations = data; if (!disposed) reconcile(); return api.inspect(); },
    setEnabled(value) { treeEnabled = value === true; if (!disposed) reconcile(); return api.inspect(); },
    dispose() {
      if (disposed) return;
      disposed = true; observer.disconnect(); window.clearTimeout(timer); window.clearTimeout(aliasTimer); timer = null;
      if (menuLease) {
        const menu = currentMenuContext()?.menuElement;
        menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        releaseMenuLease();
      }
      menuContext = null; observedMenuTrigger = null;
      for (const type of ['pointerdown', 'click', 'contextmenu']) document.removeEventListener(type, rememberNativeContext, true);
      document.removeEventListener('contextmenu', parentContextMenu, true);
      restore();
      last = { installed: false, state: 'disposed', groups: 0, childItems: 0, hiddenFlatRows: 0, errors: [] };
    },
    inspect() { return { ...last, enabled:treeEnabled, errors: [...last.errors], nativeMenuOpen: !!currentMenuContext() }; },
    openNativeMenu,
    closeNativeMenu,
    getMenuContext: currentMenuContext,
    getExpansionState() { return [...expanded].map(([ident, value]) => [ident, value]); },
    getIdentityAliases() { return [...aliases]; },
    getCanonicalChatId(row) {return row?.matches?.(ROW) ? identity(row)?.slice(6)??null : null;}
  };
  document.addEventListener('contextmenu', parentContextMenu, true);
  for (const type of ['pointerdown', 'click', 'contextmenu']) document.addEventListener(type, rememberNativeContext, true);
  window.__codexNestedRuntime = api;
  return api.apply();
})();
