// Readable source for the standalone official MCP App. Build with
// scripts/build-archive-panel.cjs; no CDP endpoint or model message is used.
import { App, PostMessageTransport, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

const MAX_SELECTION = 256;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ACTIVE_JOBS = new Set(['queued', 'running', 'stopping']);
const $ = id => document.getElementById(id);
const state = { connected: false, connecting: false, catalogReady: false, chats: [], selected: new Set(),
  query: '', project: '', revision: null, module: {}, relationsAvailable: null, includeDescendants: true, settingBusy: false,
  previewBusy: false, submitting: false, plan: null, job: null, pollingFailures: 0, stopping: false,
  error: '', oldHost: false, collapsed: new Set(), filterCollapsed: new Set(), focusedId: null, jobExpectations: new Map() };
let app;
let connectionGeneration = 0;
let jobTimer;
let expiryTimer;
let disposed = false;

document.body.innerHTML = `
<style>
.scope-section-heading{margin:17px 22px 8px;font-size:14px}.scope-explanation{margin:5px 22px 10px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}.implicit-scope-items{max-height:35dvh;padding-left:46px}.implicit-scope-items li{border-left:2px solid var(--border);padding-left:10px}.dialog-actions{flex-wrap:wrap}.dialog-actions .primary{white-space:normal}
.chat-tree-item{outline:none}.chat-tree-item:focus>.chat-row{box-shadow:inset 0 0 0 2px var(--focus);position:relative;z-index:1}.chat-tree-group{margin:0;padding:0}.chat-row{display:flex;gap:9px;min-width:0;user-select:none}.chat-row[data-selected=true]{background:color-mix(in srgb,var(--accent) 15%,var(--bg));box-shadow:inset 3px 0 var(--accent)}.chat-row[data-inherited=true]{background:color-mix(in srgb,var(--accent) 6%,var(--bg))}.chat-row[data-context=true] .chat-title{font-weight:450;color:var(--muted)}.tree-toggle,.tree-spacer{width:25px;min-width:25px;height:26px;flex:0 0 25px}.tree-toggle{display:grid;place-items:center;padding:0;border:0;background:transparent;border-radius:6px}.tree-toggle:hover{background:color-mix(in srgb,var(--text) 9%,transparent)}.tree-toggle::before{content:'';width:6px;height:6px;border-right:1.8px solid currentColor;border-bottom:1.8px solid currentColor;transform:rotate(-45deg);margin-left:-3px}.tree-toggle[aria-expanded=true]::before{transform:rotate(45deg);margin-top:-4px;margin-left:0}.chat-row input.chat-check{appearance:none;-webkit-appearance:none;display:grid;place-items:center;position:relative;width:22px;height:22px;min-width:22px;margin:0;border:2px solid color-mix(in srgb,var(--text) 48%,var(--bg));border-radius:6px;background:var(--bg);cursor:pointer;opacity:1}.chat-row input.chat-check:checked{background:var(--accent);border-color:var(--accent)}.chat-row input.chat-check:checked::after{content:'';width:6px;height:11px;border-right:2.5px solid var(--bg);border-bottom:2.5px solid var(--bg);transform:translateY(-1px) rotate(45deg)}.chat-row input.chat-check:disabled{opacity:.5;cursor:default}.chat-row input.chat-check:focus-visible{outline:2px solid var(--focus);outline-offset:3px}.chat-body{min-width:0}.tree-label-line{display:flex;gap:7px;align-items:baseline;flex-wrap:wrap}.tree-context,.tree-count{font-size:11px;color:var(--muted);font-weight:400}.inherited-badge{display:block;width:fit-content;margin-top:4px;padding:1px 7px;border:1px dashed var(--accent);border-radius:5px;color:var(--accent);font-size:11px;line-height:1.6}.tree-hint{margin:0;padding:0 16px 11px;font-size:12px;color:var(--muted)}.scope-items li.scope-child>strong::before{content:'↳ ';color:var(--muted)}
</style>
<main class="panel" aria-labelledby="panel-title">
  <header class="heading"><div><p class="eyebrow">聊天整理</p><h1 id="panel-title">批量归档</h1>
    <p class="intro">选好聊天，检查完整范围，再统一收起。</p></div>
    <span id="connection-state" class="badge" role="status">正在连接插件</span></header>
  <section class="module-grid" aria-label="独立功能开关">
    <label class="module-card"><span><strong>批量归档</strong><small id="archive-state">正在读取状态</small></span>
      <input type="checkbox" id="archive-enabled" role="switch" aria-label="启用批量归档" disabled></label>
    <label class="module-card"><span><strong>嵌套显示</strong><small id="nesting-state">正在读取状态</small></span>
      <input type="checkbox" id="nesting-enabled" role="switch" aria-label="启用嵌套显示" disabled></label>
  </section>
  <p class="independent-note">两个功能可以单独开关，关闭嵌套显示仍可使用本页归档。</p>
  <div id="message" class="message" role="alert" hidden></div>
  <section id="job-section" class="job-section" aria-labelledby="job-title" hidden>
    <div class="section-heading"><h2 id="job-title">归档进度</h2><span id="job-status" class="badge"></span></div>
    <progress id="job-progress" max="1" value="0" aria-label="聊天归档进度"></progress>
    <p id="job-summary" role="status" aria-live="polite"></p>
    <progress id="job-implicit-progress" max="1" value="0" aria-label="后台子任务核对进度" hidden></progress>
    <p id="job-implicit-summary" role="status" aria-live="polite"></p><p id="job-current" class="muted"></p>
    <div class="job-actions"><button id="refresh-job" type="button">刷新进度</button>
      <button id="stop-job" type="button">停止后续归档</button></div>
    <small class="muted">停止会保留已经完成的归档，尚未开始的聊天会留下。</small>
  </section>
  <section class="workspace" aria-label="选择聊天">
    <div class="filters"><label class="search-label"><span class="sr-only">按标题或项目筛选</span>
      <input id="chat-filter" type="search" placeholder="搜索聊天标题或项目" autocomplete="off"></label>
      <select id="project-filter" aria-label="按项目筛选"><option value="">全部项目</option></select>
      <button id="refresh-chats" type="button">刷新聊天</button></div>
    <div class="selection-bar"><p id="selection-summary" role="status" aria-live="polite">正在读取聊天列表</p>
      <div class="selection-actions"><button id="select-current" type="button">全选当前筛选</button>
        <button id="invert-current" type="button">反选当前筛选</button><button id="clear-selection" type="button">清空选择</button></div></div>
    <p id="tree-hint" class="tree-hint" role="status" hidden></p>
    <div id="chat-list" class="chat-list" role="tree" aria-multiselectable="true" aria-label="可归档聊天树"></div>
    <div id="relation-notice" class="relation-notice" role="status" hidden></div>
    <div class="archive-footer"><label class="descendants"><input type="checkbox" id="include-descendants" checked>
      包含所选聊天的已发现下级</label><button id="review-plan" class="primary" type="button" disabled>检查归档范围</button></div>
  </section>
  <p class="footer-note">聊天仍保留在归档中。最终范围由插件重新读取后生成。</p>
</main>
<dialog id="scope-dialog" aria-labelledby="scope-title"><div class="dialog-heading"><h2 id="scope-title">确认归档范围</h2>
  <p id="scope-summary"></p><p id="scope-mode" class="scope-mode"></p></div>
  <section id="scope-warning-section" class="scope-warning-section" aria-label="本次归档说明" hidden><strong>本次归档说明</strong>
  <ul id="scope-warnings"></ul></section><section aria-labelledby="scope-chat-title"><h3 id="scope-chat-title" class="scope-section-heading">明确归档的聊天</h3>
  <ol id="scope-items" class="scope-items"></ol></section>
  <section aria-labelledby="scope-implicit-title"><h3 id="scope-implicit-title" class="scope-section-heading">随聊天处理的后台子任务</h3>
  <p id="scope-implicit-summary" class="scope-explanation"></p><ol id="scope-implicit-items" class="scope-items implicit-scope-items"></ol></section>
  <p id="scope-expiry" class="muted" role="status"></p><div class="dialog-actions"><button id="cancel-plan" type="button">返回修改</button>
  <button id="confirm-plan" class="primary" type="button">确认归档</button></div></dialog>`;

const text = value => typeof value === 'string' ? value.slice(0, 2000) : '';
const number = value => Array.isArray(value) ? value.length : Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const hasActiveJob = () => !!state.job && ACTIVE_JOBS.has(state.job.status);
const locked = () => state.previewBusy || state.submitting || hasActiveJob() || !!state.plan;
const moduleReady = () => state.connected && !state.oldHost && state.catalogReady && state.module.archiveEnabled !== false &&
  !['unavailable', 'error', 'disabled'].includes(state.module.state) && state.module.archiveState !== 'unavailable';

function showError(error = '') {
  state.error = text(error instanceof Error ? error.message : String(error || ''));
  $('message').textContent = state.error;
  $('message').hidden = !state.error;
}

function resultData(result) {
  if (result?.isError) {
    throw new Error((result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n') || '插件服务暂时无法完成这个操作。');
  }
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const item of result?.content || []) {
    if (item.type !== 'text') continue;
    try { const value = JSON.parse(item.text); if (value && typeof value === 'object') return value; } catch { /* Plain text is not a data contract. */ }
  }
  throw new Error('插件没有返回可用的数据，请刷新后重试。');
}

async function call(name, args = {}) {
  if (!state.connected || !app) throw new Error('插件尚未连接，请先重新连接。');
  return resultData(await app.callServerTool({ name, arguments: args }, { timeout: 30000 }));
}

function cleanChats(chats) {
  const seen = new Set();
  return chats.filter(item => item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 256 && !item.archived && !seen.has(item.id) && seen.add(item.id))
    .map(item => ({ ...item, title: !text(item.title).trim() || text(item.title).trim() === item.id ? '未命名聊天' : text(item.title),
      projectName: text(item.projectName || item.project), parentId: text(item.parentId) }));
}

function acceptModule(data) {
  const value = data?.module || data?.modules || data;
  if (value && typeof value === 'object' && ('archiveEnabled' in value || 'nestingEnabled' in value || 'state' in value)) state.module = { ...state.module, ...value };
  if (typeof value?.relationsAvailable === 'boolean') state.relationsAvailable = value.relationsAvailable;
  if (data?.activeJob) acceptJob(data.activeJob);
  renderControls();
}

function acceptCatalog(data) {
  if (!Array.isArray(data?.chats)) return false;
  state.chats = cleanChats(data.chats);
  state.revision = data.catalogRevision ?? data.revision ?? null;
  if (typeof data.relationsAvailable === 'boolean') state.relationsAvailable = data.relationsAvailable;
  const currentIds = new Set(state.chats.map(item => item.id));
  state.selected = new Set([...state.selected].filter(id => currentIds.has(id)));
  state.collapsed = new Set([...state.collapsed].filter(id => currentIds.has(id)));
  state.filterCollapsed = new Set([...state.filterCollapsed].filter(id => currentIds.has(id)));
  state.catalogReady = true;
  acceptModule(data);
  renderProjects();
  renderList();
  return true;
}

function formatTime(chat) {
  const raw = chat.createdAtMs ?? chat.createdAt ?? chat.updatedAtMs ?? chat.updatedAt;
  if (raw === undefined || raw === null) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}

function metadata(chat, catalog = state.chats) {
  const parent = catalog.find(item => item.id === chat.parentId);
  return [chat.projectName, formatTime(chat), `#${chat.id.slice(-8)}`, parent ? `上级：${parent.title}` : ''].filter(Boolean).join(' · ');
}

function filteredChats() {
  const query = state.query.trim().toLocaleLowerCase();
  return state.chats.filter(chat => (!state.project || chat.projectName === state.project) &&
    (!query || `${chat.title} ${chat.projectName} ${chat.id}`.toLocaleLowerCase().includes(query)));
}

function treeModel(chats = state.chats) {
  const byId = new Map(chats.map(chat => [chat.id, chat]));
  const parents = new Map(chats.map(chat => [chat.id, chat.parentId !== chat.id && byId.has(chat.parentId) ? chat.parentId : null]));
  // Broken or cyclic metadata must never hide chats or recurse indefinitely.
  // Disconnect one edge of each cycle, then render every remaining item once.
  const done = new Set();
  for (const chat of chats) {
    const path = new Set(); let current = chat.id;
    while (current && !done.has(current)) {
      if (path.has(current)) { parents.set(current, null); break; }
      path.add(current); current = parents.get(current);
    }
    path.forEach(id => done.add(id));
  }
  const children = new Map(chats.map(chat => [chat.id, []]));
  const roots = [];
  for (const chat of chats) { const parent = parents.get(chat.id); if (parent) children.get(parent).push(chat.id); else roots.push(chat.id); }
  return { byId, parents, children, roots };
}

function treeOrder(model) {
  const result = [], stack = model.roots.slice().reverse().map(id => ({ id, depth: 0 }));
  while (stack.length) {
    const entry = stack.pop(); result.push({ ...entry, chat: model.byId.get(entry.id) });
    const children = model.children.get(entry.id);
    for (let index = children.length - 1; index >= 0; index--) stack.push({ id: children[index], depth: entry.depth + 1 });
  }
  return result;
}

const isFiltering = () => !!(state.query.trim() || state.project);
const collapsedSet = () => isFiltering() ? state.filterCollapsed : state.collapsed;

function implicitDescendants(model = treeModel()) {
  const result = new Set(); if (!state.includeDescendants) return result;
  const stack = model.roots.map(id => ({ id, inherited: false }));
  while (stack.length) {
    const { id, inherited } = stack.pop(), explicit = state.selected.has(id);
    if (inherited && !explicit) result.add(id);
    for (const child of model.children.get(id)) stack.push({ id: child, inherited: inherited || explicit });
  }
  return result;
}

function focusTree(id) {
  const items = Array.from($('chat-list').querySelectorAll('[data-tree-id]'));
  const target = items.find(item => item.dataset.treeId === id && !item.closest('[hidden]'));
  if (!target) return;
  state.focusedId = id; items.forEach(item => { item.tabIndex = item === target ? 0 : -1; }); target.focus({ preventScroll: true });
  target.querySelector('.chat-row')?.scrollIntoView({ block: 'nearest' });
}

function toggleBranch(id) {
  const collapsed = collapsedSet(); if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  state.focusedId = id; renderList(); focusTree(id);
}

function treeKey(event, item, model, visibleChildren) {
  if (event.target.closest('[data-tree-id]') !== item) return;
  const id = item.dataset.treeId, keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', ' ', 'Enter'];
  if (!keys.includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  const visible = Array.from($('chat-list').querySelectorAll('[data-tree-id]')).filter(value => !value.closest('[hidden]'));
  const index = visible.indexOf(item);
  if (event.key === 'ArrowDown') focusTree(visible[Math.min(visible.length - 1, index + 1)]?.dataset.treeId);
  else if (event.key === 'ArrowUp') focusTree(visible[Math.max(0, index - 1)]?.dataset.treeId);
  else if (event.key === 'Home') focusTree(visible[0]?.dataset.treeId);
  else if (event.key === 'End') focusTree(visible.at(-1)?.dataset.treeId);
  else if (event.key === 'ArrowRight' && visibleChildren.length) {
    if (collapsedSet().has(id)) toggleBranch(id); else focusTree(visibleChildren[0]);
  } else if (event.key === 'ArrowLeft') {
    if (visibleChildren.length && !collapsedSet().has(id)) toggleBranch(id); else focusTree(model.parents.get(id));
  } else if (event.key === ' ' || event.key === 'Enter') item.querySelector('[data-chat-id]')?.click();
}

function renderProjects() {
  const select = $('project-filter');
  select.replaceChildren(new Option('全部项目', ''));
  [...new Set(state.chats.map(item => item.projectName).filter(Boolean))].sort().forEach(name => select.add(new Option(name, name)));
  if (!Array.from(select.options).some(option => option.value === state.project)) state.project = '';
  select.value = state.project;
}

function renderList() {
  const list = $('chat-list');
  const restoreFocus = list.contains(document.activeElement);
  list.replaceChildren();
  const filtered = filteredChats(), model = treeModel(), matches = new Set(filtered.map(chat => chat.id)), included = new Set(matches);
  for (const chat of filtered) { let parent = model.parents.get(chat.id); while (parent && !included.has(parent)) { included.add(parent); parent = model.parents.get(parent); } }
  const contextCount = included.size - matches.size;
  $('tree-hint').hidden = !contextCount;
  $('tree-hint').textContent = contextCount ? `另显示 ${contextCount} 条上级路径；全选和反选只处理匹配项。` : '';
  if (!state.catalogReady || !filtered.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = !state.catalogReady ? '暂时无法读取聊天列表。' : !state.chats.length ? '当前没有可归档的聊天。' : '没有匹配的聊天。';
    list.append(empty);
  }
  const rootIds = model.roots.filter(id => included.has(id));
  const stack = rootIds.slice().reverse().map((id, index) => ({ id, depth: 0, group: list, position: rootIds.length - index, size: rootIds.length }));
  let sequence = 0;
  while (stack.length) {
    const { id, depth, group, position, size } = stack.pop(), chat = model.byId.get(id);
    const children = model.children.get(id).filter(child => included.has(child));
    const item = document.createElement('div'); item.className = 'chat-tree-item'; item.dataset.treeId = chat.id; item.setAttribute('role', 'treeitem');
    item.setAttribute('aria-level', depth + 1); item.setAttribute('aria-posinset', position); item.setAttribute('aria-setsize', size);
    item.tabIndex = -1; item.addEventListener('keydown', event => treeKey(event, item, model, children));
    item.addEventListener('focus', () => { state.focusedId = chat.id; list.querySelectorAll('[data-tree-id]').forEach(value => { value.tabIndex = value === item ? 0 : -1; }); });
    const row = document.createElement('div'); row.className = 'chat-row'; row.title = chat.id; row.dataset.context = String(!matches.has(chat.id));
    row.style.paddingInlineStart = `${12 + Math.min(depth, 12) * 18}px`;
    const toggle = document.createElement(children.length ? 'button' : 'span'); toggle.className = children.length ? 'tree-toggle' : 'tree-spacer';
    if (children.length) {
      toggle.type = 'button'; toggle.tabIndex = -1; toggle.setAttribute('aria-expanded', String(!collapsedSet().has(chat.id)));
      toggle.setAttribute('aria-label', `${collapsedSet().has(chat.id) ? '展开' : '收起'} ${chat.title} 的下级`);
      item.setAttribute('aria-expanded', String(!collapsedSet().has(chat.id)));
      toggle.addEventListener('click', event => { event.stopPropagation(); toggleBranch(chat.id); });
    } else toggle.setAttribute('aria-hidden', 'true');
    const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'chat-check'; input.dataset.chatId = chat.id; input.tabIndex = -1;
    input.checked = state.selected.has(chat.id); input.disabled = locked() || !moduleReady();
    input.setAttribute('aria-label', `选择 ${chat.title}（${chat.id.slice(-8)}）`);
    input.addEventListener('change', () => {
      if (input.checked && state.selected.size >= MAX_SELECTION) { input.checked = false; showError(`每次最多选择 ${MAX_SELECTION} 条聊天。`); return; }
      if (input.checked) state.selected.add(chat.id); else state.selected.delete(chat.id);
      showError(); renderControls(); focusTree(chat.id);
    });
    const body = document.createElement('span'); body.className = 'chat-body';
    const line = document.createElement('span'); line.className = 'tree-label-line';
    const title = document.createElement('strong'); title.className = 'chat-title'; title.textContent = chat.title; title.id = `chat-tree-title-${++sequence}`;
    item.setAttribute('aria-labelledby', title.id); line.append(title);
    if (!matches.has(chat.id)) { const context = document.createElement('span'); context.className = 'tree-context'; context.textContent = '上级路径'; line.append(context); }
    if (children.length) { const count = document.createElement('span'); count.className = 'tree-count'; count.textContent = `${model.children.get(chat.id).length} 个直接下级`; line.append(count); }
    const details = document.createElement('small'); details.className = 'muted'; details.textContent = metadata(chat);
    const inherited = document.createElement('span'); inherited.className = 'inherited-badge'; inherited.id = `chat-tree-inherited-${sequence}`; inherited.textContent = '随上级归档'; inherited.hidden = true;
    body.append(line, details, inherited); row.append(toggle, input, body); item.append(row); group.append(item);
    row.addEventListener('click', event => { if (event.target === input || event.target.closest('.tree-toggle')) return; input.click(); });
    if (children.length) {
      const childGroup = document.createElement('div'); childGroup.className = 'chat-tree-group'; childGroup.setAttribute('role', 'group'); childGroup.hidden = collapsedSet().has(chat.id); item.append(childGroup);
      for (let index = children.length - 1; index >= 0; index--) stack.push({ id: children[index], depth: depth + 1, group: childGroup, position: index + 1, size: children.length });
    }
  }
  const visible = Array.from(list.querySelectorAll('[data-tree-id]')).filter(item => !item.closest('[hidden]'));
  const target = visible.find(item => item.dataset.treeId === state.focusedId) || visible[0];
  if (target) { state.focusedId = target.dataset.treeId; target.tabIndex = 0; } list.tabIndex = target ? -1 : 0;
  if (restoreFocus && target) focusTree(target.dataset.treeId);
  renderControls();
}

function renderControls() {
  const active = hasActiveJob();
  const ready = moduleReady();
  $('connection-state').textContent = state.oldHost ? '请更新桌面应用' : state.connected ? '官方插件已连接' : state.connecting ? '正在连接插件' : '尚未连接';
  $('connection-state').dataset.tone = state.connected && !state.oldHost ? 'ready' : 'neutral';
  $('archive-enabled').checked = state.module.archiveEnabled !== false;
  $('nesting-enabled').checked = state.module.nestingEnabled === true;
  $('archive-enabled').disabled = !state.connected || state.settingBusy || active || state.submitting || state.previewBusy || !!state.plan;
  $('nesting-enabled').disabled = !state.connected || state.settingBusy;
  $('archive-state').textContent = state.module.archiveEnabled === false ? '已关闭' : ready ? '独立运行，可归档' : text(state.module.message) || '等待本地归档服务';
  $('nesting-state').textContent = state.module.nestingEnabled === true ? state.module.nativeState === 'ready' ? '已开启，原列表已连接' : '已开启，原列表需加载支持' : '已关闭，不影响本页归档';
  const relationUnavailable = state.relationsAvailable === false;
  $('relation-notice').hidden = !relationUnavailable;
  $('relation-notice').textContent = relationUnavailable ? `层级读取暂不可用，可取消包含下级，仅归档勾选聊天。${text(state.module.message) ? ` ${text(state.module.message)}` : ''}` : '';
  for (const id of ['chat-filter', 'project-filter', 'include-descendants']) $(id).disabled = locked();
  $('refresh-chats').textContent = state.connected ? '刷新聊天' : '重新连接';
  $('refresh-chats').disabled = state.connecting || locked();
  const none = !filteredChats().length;
  $('select-current').disabled = !ready || locked() || none;
  $('invert-current').disabled = !ready || locked() || none;
  $('clear-selection').disabled = locked() || !state.selected.size;
  $('review-plan').disabled = !ready || locked() || !state.selected.size || (relationUnavailable && state.includeDescendants);
  $('review-plan').textContent = state.previewBusy ? '正在生成范围…' : `检查归档范围${state.selected.size ? ` · ${state.selected.size}` : ''}`;
  $('selection-summary').textContent = state.catalogReady ? `共 ${state.chats.length} 条，当前筛选 ${filteredChats().length} 条，已选 ${state.selected.size} 条` : '聊天列表尚未就绪';
  $('stop-job').disabled = !active || state.stopping || state.job?.status === 'stopping';
  $('refresh-job').disabled = !state.job || state.stopping;
  if (state.plan) $('confirm-plan').disabled = state.submitting || isExpired(state.plan);
  const implicit = implicitDescendants();
  document.querySelectorAll('[data-chat-id]').forEach(input => {
    const selected = state.selected.has(input.dataset.chatId), inherited = implicit.has(input.dataset.chatId), row = input.closest('.chat-row'), item = input.closest('[data-tree-id]');
    input.disabled = locked() || !ready; input.checked = selected; row.dataset.selected = String(selected); row.dataset.inherited = String(inherited);
    item.setAttribute('aria-selected', String(selected));
    const badge = row.querySelector('.inherited-badge'); badge.hidden = !inherited;
    if (inherited) { input.setAttribute('aria-describedby', badge.id); item.setAttribute('aria-describedby', badge.id); }
    else { input.removeAttribute('aria-describedby'); item.removeAttribute('aria-describedby'); }
  });
}

async function refreshChats() {
  if (!state.connected) return connectHost();
  if (locked()) return;
  try { showError(); if (!acceptCatalog(await call('list_chats'))) throw new Error('插件没有返回聊天列表。'); }
  catch (error) { state.catalogReady = false; showError(error); renderList(); }
}

async function changeModule(key, enabled) {
  if (state.settingBusy || !state.connected) return;
  state.settingBusy = true; renderControls();
  try { showError(); acceptModule(await call('set_module_state', { [key]: enabled })); }
  catch (error) { showError(error); }
  finally { state.settingBusy = false; renderList(); }
}

function updateSelection(invert) {
  if (locked() || !moduleReady()) return;
  const next = new Set(state.selected);
  filteredChats().forEach(chat => { if (invert && next.has(chat.id)) next.delete(chat.id); else next.add(chat.id); });
  if (next.size > MAX_SELECTION) { showError(`每次最多选择 ${MAX_SELECTION} 条聊天，请缩小筛选范围。`); return; }
  state.selected = next; showError(); renderControls();
}

function selectionFingerprint() { return JSON.stringify([[...state.selected].sort(), state.includeDescendants, state.revision]); }
function planExpiry(plan) { const value = plan.expiresAtMs ?? plan.expiresAt; return typeof value === 'number' ? value : Date.parse(value); }
function isExpired(plan) { return !Number.isFinite(planExpiry(plan)) || planExpiry(plan) <= Date.now(); }

function cancelPlan() {
  clearTimeout(expiryTimer); state.plan = null;
  if ($('scope-dialog').open) $('scope-dialog').close();
  renderControls();
}

function validateImplicitScope(plan, chats) {
  if (plan.implicitCount === undefined && plan.implicitItems === undefined) throw new Error('当前归档服务尚未提供后台子任务清单，请更新插件后重试。未开始归档。');
  if (!Number.isSafeInteger(plan.implicitCount) || plan.implicitCount < 0 || !Array.isArray(plan.implicitItems) || plan.implicitItems.length !== plan.implicitCount) throw new Error('后台子任务清单不完整，未开始归档。');
  if (plan.implicitCount > 0 && (typeof plan.backgroundReviewToken !== 'string' || !UUID.test(plan.backgroundReviewToken))) throw new Error('后台子任务清单缺少有效确认凭证，未开始归档。');
  const parents = new Map(chats.map(chat => [chat.id.toLowerCase(), chat]));
  const seen = new Set();
  return plan.implicitItems.map(item => {
    if (!item || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.title !== 'string' || !item.title.trim() ||
        typeof item.parentId !== 'string' || typeof item.parentTitle !== 'string' || !item.parentTitle.trim()) throw new Error('后台子任务清单损坏，未开始归档。');
    const id = item.id.toLowerCase(), parent = parents.get(item.parentId.toLowerCase());
    if (seen.has(id) || parents.has(id) || !parent) throw new Error('后台子任务的归属或标识不完整，未开始归档。');
    const parentTitle = item.parentTitle.trim() === parent.id ? '未命名聊天' : text(item.parentTitle);
    if (parentTitle !== parent.title) throw new Error('后台子任务的所属聊天与确认清单不一致，请重新检查。');
    seen.add(id);
    return { id: item.id, title: !item.title.trim() || item.title.trim() === item.id ? '未命名后台子任务' : text(item.title), parentId: parent.id, parentTitle: parent.title };
  });
}

async function reviewPlan() {
  if (locked() || !moduleReady() || !state.selected.size) return;
  if (state.relationsAvailable === false && state.includeDescendants) { showError('层级读取暂不可用，请取消包含下级后重新检查。'); return; }
  state.previewBusy = true; const fingerprint = selectionFingerprint(); renderControls();
  try {
    showError();
    const data = await call('plan_archive', { chatIds: [...state.selected], includeDescendants: state.includeDescendants, catalogRevision: state.revision });
    const plan = data.plan || data;
    if (fingerprint !== selectionFingerprint()) throw new Error('选择或聊天列表已变化，请重新检查归档范围。');
    if (typeof plan.planToken !== 'string' || !plan.planToken || plan.planToken.length > 4096 || !Array.isArray(plan.items)) throw new Error('归档计划不完整，未开始归档。');
    if (plan.items.some(item => !item || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.title !== 'string')) throw new Error('聊天清单损坏，未开始归档。');
    const items = cleanChats(plan.items), count = plan.totalCount ?? plan.count;
    const chatIds = new Set(items.map(item => item.id.toLowerCase()));
    if (!Number.isSafeInteger(count) || count < 1 || items.length !== count || chatIds.size !== count || isExpired(plan) ||
        [...state.selected].some(id => !chatIds.has(id.toLowerCase())) || (!state.includeDescendants && count !== state.selected.size)) throw new Error('归档范围不完整或已经过期，请重新检查。');
    const implicitItems = validateImplicitScope(plan, items);
    if (plan.warnings !== undefined && (!Array.isArray(plan.warnings) || plan.warnings.some(warning => typeof warning !== 'string'))) throw new Error('归档说明不完整，未开始归档。');
    state.plan = { ...plan, items, implicitItems, totalCount: count };
    $('scope-summary').textContent = `已选择 ${state.selected.size} 条聊天；本次范围包含 ${count} 条聊天、${implicitItems.length} 项后台子任务。`;
    $('scope-mode').textContent = `范围：${state.includeDescendants ? '包含已发现下级' : '仅所选'}`;
    const warnings = plan.warnings || [];
    $('scope-warning-section').hidden = warnings.length === 0;
    $('scope-warnings').replaceChildren();
    for (const warning of warnings) {
      const item = document.createElement('li');
      // Scope and concurrency boundaries must remain complete, including long
      // warnings. Never truncate them or interpret server text as HTML.
      item.textContent = warning;
      $('scope-warnings').append(item);
    }
    const list = $('scope-items'); list.replaceChildren();
    for (const { chat, depth } of treeOrder(treeModel(items))) {
      const item = document.createElement('li'); item.title = chat.id; item.dataset.scopeChatId = chat.id; item.dataset.depth = depth;
      if (depth) { item.className = 'scope-child'; item.style.marginInlineStart = `${Math.min(depth, 12) * 18}px`; }
      const title = document.createElement('strong'); title.textContent = chat.title;
      const details = document.createElement('small'); details.className = 'muted'; details.textContent = metadata(chat, items);
      item.append(title, details); list.append(item);
    }
    $('scope-chat-title').textContent = `明确归档的聊天 · ${count} 条`;
    $('scope-implicit-title').textContent = `随聊天处理的后台子任务 · ${implicitItems.length} 项`;
    $('scope-implicit-summary').textContent = implicitItems.length ? '以下项目由官方随所属聊天处理，不作为可单独勾选的聊天。请连同上方聊天清单一起核对。' : '本次没有已发现的后台子任务。';
    $('scope-implicit-items').replaceChildren();
    for (const task of implicitItems) {
      const item = document.createElement('li'); item.title = task.id; item.dataset.implicitId = task.id;
      const title = document.createElement('strong'); title.textContent = task.title;
      const parent = document.createElement('small'); parent.className = 'muted'; parent.textContent = `所属聊天：${task.parentTitle} · #${task.parentId.slice(-8)}`;
      const identifier = document.createElement('small'); identifier.className = 'muted'; identifier.textContent = `后台子任务 #${task.id.slice(-8)}`;
      item.append(title, parent, identifier); $('scope-implicit-items').append(item);
    }
    $('scope-expiry').textContent = '确认后将按以上范围执行，操作过程仍受已展示说明的约束。';
    $('confirm-plan').textContent = `归档聊天 ${count} 条 · 后台 ${implicitItems.length} 项`;
    $('scope-dialog').showModal();
    expiryTimer = setTimeout(() => {
      if (!state.plan) return;
      $('scope-expiry').textContent = '这份范围已过期，请返回后重新检查。'; renderControls();
    }, Math.max(0, planExpiry(plan) - Date.now()) + 10);
  } catch (error) { cancelPlan(); showError(error); }
  finally { state.previewBusy = false; renderControls(); }
}

function normalizeJob(data) {
  const job = data?.job || data;
  if (!job || typeof job.jobId !== 'string' || !job.jobId || typeof job.status !== 'string') throw new Error('插件未返回可追踪的任务，不能判断归档结果。');
  const expected = state.jobExpectations.get(job.jobId);
  const fields = ['implicitTotal', 'verifiedImplicit', 'pendingImplicit'];
  const absent = fields.every(key => job[key] === undefined);
  const ids = value => Array.isArray(value) && value.every(id => typeof id === 'string' && UUID.test(id)) && new Set(value.map(id => id.toLowerCase())).size === value.length;
  const verified = ids(job.verifiedImplicit) ? job.verifiedImplicit.map(id => id.toLowerCase()) : [];
  const pending = ids(job.pendingImplicit) ? job.pendingImplicit.map(id => id.toLowerCase()) : [];
  const all = [...verified, ...pending], union = new Set(all);
  const legacyZero = absent && expected?.size === 0;
  const valid = legacyZero || (!absent && Number.isSafeInteger(job.implicitTotal) && job.implicitTotal >= 0 &&
    ids(job.verifiedImplicit) && ids(job.pendingImplicit) && union.size === all.length && all.length === job.implicitTotal &&
    (!expected || (expected.size === job.implicitTotal && all.every(id => expected.has(id)))));
  return { ...job, total: number(job.total), completed: number(job.completed), verified: number(job.verified), failed: number(job.failed),
    implicitValid: valid, implicitLegacyZero: legacyZero, implicitTotal: valid ? legacyZero ? 0 : job.implicitTotal : expected?.size ?? null,
    verifiedImplicitCount: valid ? verified.length : 0, pendingImplicitCount: valid ? pending.length : null };
}

function acceptJob(data, expectedImplicitIds) {
  const raw = data?.job || data;
  if (expectedImplicitIds && typeof raw?.jobId === 'string') state.jobExpectations.set(raw.jobId, new Set(expectedImplicitIds.map(id => id.toLowerCase())));
  const job = normalizeJob(data);
  if (state.job && state.job.jobId !== job.jobId && hasActiveJob()) return;
  state.job = job; $('job-section').hidden = false;
  $('job-progress').max = Math.max(1, job.total); $('job-progress').value = Math.min(job.total, job.completed);
  const labels = { queued: '准备中', running: '正在归档', stopping: '正在停止', stopped: '已停止', failed: '处理未完成', cancelled: '已取消' };
  const chatsComplete = job.verified === job.total && job.total > 0 && job.failed === 0;
  const implicitComplete = job.implicitValid && job.verifiedImplicitCount === job.implicitTotal && job.pendingImplicitCount === 0;
  const complete = job.status === 'completed' && chatsComplete && implicitComplete;
  $('job-status').textContent = complete ? '归档完成' : job.status === 'completed' ? chatsComplete && !implicitComplete ? '处理已结束，请检查后台子任务' : '处理已结束，请检查结果' : labels[job.status] || '状态待更新';
  $('job-status').dataset.tone = complete ? 'ready' : 'neutral';
  $('job-summary').textContent = `已处理 ${job.completed} / ${job.total} 条，已确认归档 ${job.verified} 条，失败 ${job.failed} 条。`;
  $('job-implicit-summary').textContent = !job.implicitValid ? '后台子任务状态不完整，不能确认全部归档结果；请刷新核对或更新归档服务。' : job.implicitLegacyZero ? '当前确认范围不含后台子任务；旧服务未提供单独进度。' : `后台子任务：已确认 ${job.verifiedImplicitCount} / ${job.implicitTotal} 项，尚未确认 ${job.pendingImplicitCount} 项。`;
  $('job-implicit-progress').hidden = !job.implicitValid || job.implicitTotal === 0;
  $('job-implicit-progress').max = Math.max(1, job.implicitTotal || 0); $('job-implicit-progress').value = job.verifiedImplicitCount;
  $('job-current').textContent = job.error ? text(job.error.message || job.error) : job.currentTitle ? `当前：${text(job.currentTitle)}` : '';
  renderControls();
  clearTimeout(jobTimer);
  if (ACTIVE_JOBS.has(job.status)) jobTimer = setTimeout(() => refreshJob(false), 850);
}

async function confirmPlan() {
  if (!state.plan || state.submitting || isExpired(state.plan)) return;
  const planToken = state.plan.planToken, implicitIds = state.plan.implicitItems.map(item => item.id);
  const confirmation = implicitIds.length ? { planToken, backgroundReviewToken: state.plan.backgroundReviewToken } : { planToken };
  state.submitting = true; cancelPlan(); renderControls();
  try { showError(); state.pollingFailures = 0; acceptJob(await call('confirm_archive', confirmation), implicitIds); }
  catch (error) { showError(error); }
  finally { state.submitting = false; renderControls(); }
}

async function refreshJob(manual) {
  if (!state.job || !state.connected || disposed) return;
  clearTimeout(jobTimer);
  try {
    if (manual) showError();
    const jobId = state.job.jobId;
    const data = await call('get_job', { jobId });
    if (state.job?.jobId !== jobId) return;
    state.pollingFailures = 0; acceptJob(data);
    if (!hasActiveJob()) { state.selected.clear(); await refreshChats(); }
  } catch (error) {
    state.pollingFailures += 1;
    showError(`暂时无法更新进度，归档任务可能仍在运行。${text(error.message || String(error))}`);
    if (hasActiveJob() && state.pollingFailures < 3) jobTimer = setTimeout(() => refreshJob(false), 1500);
  }
}

async function stopJob() {
  if (!hasActiveJob() || state.stopping) return;
  clearTimeout(jobTimer); state.stopping = true; renderControls();
  try { showError(); acceptJob(await call('stop_job', { jobId: state.job.jobId })); }
  catch (error) { showError(error); if (hasActiveJob()) jobTimer = setTimeout(() => refreshJob(false), 1500); }
  finally { state.stopping = false; renderControls(); }
}

function applyContext(context = {}) {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    const value = context.safeAreaInsets?.[edge];
    document.documentElement.style.setProperty(`--safe-${edge}`, `${Number.isFinite(value) ? Math.max(0, Math.min(200, value)) : 0}px`);
  }
}

function supportedVersion(version) {
  if (typeof version !== 'string' || !/^26\./.test(version)) return true;
  const actual = version.split('.').map(value => Number.parseInt(value, 10));
  const minimum = [26, 928, 20710];
  for (let i = 0; i < minimum.length; i++) { if (!Number.isFinite(actual[i])) return true; if (actual[i] !== minimum[i]) return actual[i] > minimum[i]; }
  return true;
}

async function connectHost() {
  if (state.connecting || disposed) return;
  const generation = ++connectionGeneration;
  state.connecting = true; state.connected = false; renderControls();
  try {
    if (app) await app.close();
    if (window.parent === window) throw new Error('请从 ChatGPT / Codex 的插件入口打开此页面。');
    const current = new App({ name: 'Codex Archive Panel', version: '0.3.0-preview.5' }, {}, { strict: true, autoResize: false });
    app = current;
    current.ontoolresult = result => {
      if (generation !== connectionGeneration) return;
      try { const data = resultData(result); acceptModule(data); if (Array.isArray(data.chats)) acceptCatalog(data); }
      catch (error) { showError(error); }
    };
    current.onhostcontextchanged = applyContext;
    current.onteardown = () => { disposed = true; clearTimeout(jobTimer); clearTimeout(expiryTimer); return {}; };
    // The official transport rejects messages from any window other than the
    // immediate host parent; a sibling or self-posted forged result is ignored.
    await current.connect(new PostMessageTransport(window.parent, window.parent), { timeout: 8000 });
    if (generation !== connectionGeneration) return;
    state.connected = true; state.oldHost = !supportedVersion(current.getHostVersion()?.version);
    applyContext(current.getHostContext());
    if (state.oldHost) { showError('当前桌面版本较旧，请更新后使用这个插件面板。'); return; }
    const outcomes = await Promise.allSettled([call('get_module_status').then(acceptModule), state.catalogReady ? Promise.resolve() : call('list_chats').then(data => { if (!acceptCatalog(data)) throw new Error('插件没有返回聊天列表。'); })]);
    const failure = outcomes.find(result => result.status === 'rejected');
    if (failure) showError(failure.reason);
    else showError();
  } catch (error) { showError(error); }
  finally { if (generation === connectionGeneration) { state.connecting = false; renderList(); } }
}

$('archive-enabled').addEventListener('change', event => changeModule('archiveEnabled', event.target.checked));
$('nesting-enabled').addEventListener('change', event => changeModule('nestingEnabled', event.target.checked));
$('chat-filter').addEventListener('input', event => { state.query = event.target.value; state.filterCollapsed.clear(); renderList(); });
$('project-filter').addEventListener('change', event => { state.project = event.target.value; state.filterCollapsed.clear(); renderList(); });
$('include-descendants').addEventListener('change', event => { state.includeDescendants = event.target.checked; renderControls(); });
$('refresh-chats').addEventListener('click', refreshChats);
$('select-current').addEventListener('click', () => updateSelection(false));
$('invert-current').addEventListener('click', () => updateSelection(true));
$('clear-selection').addEventListener('click', () => { if (!locked()) { state.selected.clear(); renderControls(); } });
$('review-plan').addEventListener('click', reviewPlan);
$('cancel-plan').addEventListener('click', cancelPlan);
$('scope-dialog').addEventListener('cancel', event => { event.preventDefault(); cancelPlan(); });
$('confirm-plan').addEventListener('click', confirmPlan);
$('refresh-job').addEventListener('click', () => refreshJob(true));
$('stop-job').addEventListener('click', stopJob);
window.addEventListener('pagehide', () => { disposed = true; clearTimeout(jobTimer); clearTimeout(expiryTimer); });
renderList();
connectHost();
