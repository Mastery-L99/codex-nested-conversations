'use strict';
// Synthetic MCP host and fake tools only. No official app, endpoint, account,
// model request, or real archive action is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const makeId = value => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const chat = (value, title, extra = {}) => ({ id: makeId(value), title, createdAtMs: Date.UTC(2026, 9, 30, 0, 0, value), ...extra });
const catalog = [chat(1, 'Alpha parent', { projectName: '项目甲' }), chat(2, 'Alpha child', { projectName: '项目甲', parentId: makeId(1) }),
  chat(3, 'Beta', { projectName: '项目乙' }), chat(4, '同名聊天'), chat(5, '同名聊天'),
  chat(6, '<img src=x onerror=alert(1)>'), chat(1, 'Duplicate'), chat(7, 'Archived', { archived: true }), { id: '', title: 'Invalid' }];

(async () => {
  const html = await fs.readFile(path.join(__dirname, '../src/archive-panel.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+src\s*=/i);
  assert.doesNotMatch(html, /<link[^>]+href\s*=/i);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /Bundled third-party notices/);
  assert.match(html, /@modelcontextprotocol\/ext-apps@1\.7\.5/);
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = ['self_contained_csp_and_sdk_notices'];
  const requests = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('request', request => { if (/^https?:/i.test(request.url())) requests.push(request.url()); });

  async function open(options = {}) {
    await page.setContent('<!doctype html><html><body style="margin:0"><iframe id="archive-app" title="Archive fixture" style="width:100vw;height:100vh;border:0"></iframe><iframe id="attacker" hidden></iframe></body></html>');
    await page.evaluate(({ html, catalog, options }) => {
      const frame = document.getElementById('archive-app');
      const fixture = window.fixture = { chats: catalog, calls: [], initialized: false,
        module: { state: 'ready', archiveEnabled: true, nestingEnabled: false, independentArchive: true },
        plans: {}, sequence: 0, job: null, jobReads: 0, holdJob: false, ...options };
      const send = data => frame.contentWindow.postMessage(data, '*');
      const response = (id, data) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data } });
      const currentCatalog = () => ({ chats: fixture.chats, catalogRevision: 'fixture-v1', module: fixture.module,
        relationsAvailable: fixture.relationsAvailable !== false });
      const publicJob = () => {
        const value = { ...fixture.job, ...fixture.jobPatch };
        if (fixture.legacyJob) for (const key of ['implicitTotal', 'verifiedImplicit', 'pendingImplicit']) delete value[key];
        if (fixture.omitJobField) delete value[fixture.omitJobField];
        return value;
      };
      window.addEventListener('message', async event => {
        if (event.source !== frame.contentWindow || event.data?.jsonrpc !== '2.0') return;
        const message = event.data;
        if (message.method === 'ui/initialize') {
          fixture.initialized = true;
          fixture.appInfo = message.params.appInfo;
          send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion,
            hostInfo: { name: 'ChatGPT', version: fixture.hostVersion || '26.1027.3384' }, hostCapabilities: { serverTools: {} },
            hostContext: { theme: 'light', displayMode: 'fullscreen', safeAreaInsets: { top: 5, right: 3, bottom: 7, left: 2 } } } });
          return;
        }
        if (message.method !== 'tools/call') return;
        const { name, arguments: args = {} } = message.params;
        fixture.calls.push({ name, args });
        try {
          if (name === 'get_module_status') return response(message.id, { module: fixture.module, activeJob: fixture.activeJob || null });
          if (name === 'set_module_state') {
            if (fixture.holdSetting) await new Promise(resolve => { fixture.releaseSetting = resolve; });
            if (fixture.commitBeforeFailure) Object.assign(fixture.module, args);
            if (fixture.failSetting) throw new Error('设置保存失败');
            Object.assign(fixture.module, args); return response(message.id, { module: fixture.module });
          }
          if (name === 'list_chats') {
            if (fixture.failList) throw new Error('本地归档服务尚未连接');
            return response(message.id, currentCatalog());
          }
          if (name === 'plan_archive') {
            if (fixture.failPlan) throw new Error('聊天列表有变化，请重新检查');
            const ids = new Set(args.chatIds);
            if (args.includeDescendants) {
              for (let i = 0; i < fixture.chats.length; i++) fixture.chats.forEach(chat => { if (ids.has(chat.parentId)) ids.add(chat.id); });
            }
            const unique = new Map(); fixture.chats.filter(chat => ids.has(chat.id)).forEach(chat => { if (!unique.has(chat.id)) unique.set(chat.id, chat); });
            const items = [...unique.values()];
            if (fixture.reversePlan) items.reverse();
            const planToken = `opaque-fixture-plan-${++fixture.sequence}`;
            const plan = { planToken, expiresAt: new Date(Date.now() + (fixture.planLifetime || 60000)).toISOString(),
              rootCount: args.chatIds.length, totalCount: items.length + (fixture.badPlanCount ? 1 : 0), items,
              warnings: fixture.warnings || [], implicitItems: fixture.implicitItems === undefined ? [] : fixture.implicitItems,
              implicitCount: fixture.implicitCount ?? (Array.isArray(fixture.implicitItems) ? fixture.implicitItems.length : 0) };
            if (plan.implicitCount > 0) plan.backgroundReviewToken = `00000000-0000-0000-0000-${String(900000 + fixture.sequence).padStart(12, '0')}`;
            if (fixture.legacyPlan) { delete plan.implicitCount; delete plan.implicitItems; }
            if (fixture.omitImplicitList) delete plan.implicitItems;
            if (fixture.omitImplicitCount) delete plan.implicitCount;
            Object.assign(plan, fixture.planPatch);
            if (fixture.omitBackgroundToken) delete plan.backgroundReviewToken;
            fixture.plans[planToken] = plan;
            return response(message.id, plan);
          }
          if (name === 'confirm_archive') {
            const preview = fixture.plans[args.planToken];
            const expectedKeys = preview?.implicitCount > 0 ? 'backgroundReviewToken,planToken' : 'planToken';
            if (Object.keys(args).sort().join(',') !== expectedKeys || !preview || (preview.implicitCount > 0 && args.backgroundReviewToken !== preview.backgroundReviewToken)) throw new Error('必须使用已展示的聊天与后台清单计划');
            const plan = fixture.plans[args.planToken]; delete fixture.plans[args.planToken];
            fixture.job = { jobId: 'fixture-job', status: 'running', total: plan.totalCount, completed: 0, verified: [], failed: 0, items: plan.items, currentTitle: plan.items[0].title,
              implicitTotal: plan.implicitCount, implicitIds: plan.implicitItems.map(item => item.id), verifiedImplicit: [], pendingImplicit: plan.implicitItems.map(item => item.id) };
            fixture.jobReads = 0;
            return response(message.id, { job: publicJob() });
          }
          if (name === 'get_job') {
            if (fixture.failJob) throw new Error('暂时无法读取进度');
            if (!fixture.holdJob && ++fixture.jobReads >= 1) {
              fixture.job = { ...fixture.job, status: 'completed', completed: fixture.job.items.map(chat => chat.id),
                verified: fixture.incompleteVerification ? [] : fixture.job.items.map(chat => chat.id),
                verifiedImplicit: fixture.incompleteImplicitVerification ? [] : fixture.job.implicitIds,
                pendingImplicit: fixture.incompleteImplicitVerification ? fixture.job.implicitIds : [] };
            }
            return response(message.id, { job: publicJob() });
          }
          if (name === 'stop_job') { fixture.job = { ...fixture.job, status: 'stopped' }; return response(message.id, { job: publicJob() }); }
          throw new Error(`Unknown fake tool ${name}`);
        } catch (error) {
          send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } });
        }
      });
      frame.srcdoc = html;
    }, { html, catalog, options });
    const frame = page.frameLocator('#archive-app');
    await frame.getByRole('heading', { name: '批量归档', exact: true }).waitFor();
    await page.waitForFunction(() => window.fixture.initialized);
    return frame;
  }

  const calls = name => page.evaluate(name => window.fixture.calls.filter(call => call.name === name), name);
  const selected = async frame => {
    const search = frame.getByRole('searchbox');
    const previous = await search.inputValue();
    const project = frame.getByRole('combobox', { name: '按项目筛选' });
    const previousProject = await project.inputValue();
    await search.fill('');
    if (previousProject) await project.selectOption('');
    const ids = await frame.locator('[data-chat-id]:checked').evaluateAll(inputs => inputs.map(input => input.dataset.chatId).sort());
    if (previousProject) await project.selectOption(previousProject);
    await search.fill(previous);
    return ids;
  };
  const row = (frame, value) => frame.locator(`[data-chat-id="${makeId(value)}"]`);
  const ready = async frame => { await frame.getByText('共 6 条，当前筛选 6 条，已选 0 条', { exact: true }).waitFor(); };

  try {
    let frame = await open(); await ready(frame);
    assert.equal(await page.evaluate(() => window.fixture.appInfo.name), 'Codex Archive Panel');
    assert.equal(await page.evaluate(() => window.fixture.appInfo.version), '0.3.0-preview.6');
    assert.equal(await frame.locator('[data-chat-id]').count(), 6);
    assert.equal(await frame.locator('.chat-list img').count(), 0);
    assert.equal(await frame.getByText('<img src=x onerror=alert(1)>', { exact: true }).count(), 1);
    assert.equal(await frame.locator('#include-descendants').isChecked(), true);
    assert.deepEqual(await calls('confirm_archive'), []);
    assert.match(await frame.locator('.chat-row').filter({ has: row(frame, 2) }).textContent(), /上级：Alpha parent/);
    checks.push('official_sdk_initialize_handshake', 'catalog_deduplication', 'titles_render_as_text', 'parent_metadata', 'read_only_open');

    // Only the immediate host parent is trusted by the SDK transport.
    const forged = { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: { chats: [chat(99, 'FORGED')], module: { archiveEnabled: false } } } };
    await page.evaluate(forged => {
      const attacker = document.getElementById('attacker').contentWindow;
      attacker.eval(`parent.document.getElementById('archive-app').contentWindow.postMessage(${JSON.stringify(forged)}, '*')`);
    }, forged);
    await page.locator('#archive-app').contentFrame().locator('body').evaluate((body, forged) => window.postMessage(forged, '*'), forged);
    await page.waitForTimeout(70);
    assert.equal(await frame.locator('[data-chat-id]').count(), 6);
    assert.equal(await frame.locator('#archive-enabled').isChecked(), true);
    checks.push('sibling_and_self_forged_host_messages_rejected');

    await frame.getByRole('searchbox', { name: '按标题或项目筛选' }).fill('Alpha');
    await frame.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(frame), [makeId(1), makeId(2)]);
    await frame.getByRole('searchbox').fill('Beta');
    await frame.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(frame), [makeId(1), makeId(2), makeId(3)]);
    await frame.getByRole('button', { name: '反选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(frame), [makeId(1), makeId(2)]);
    await frame.getByRole('searchbox').fill('同名');
    await frame.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(frame), [makeId(1), makeId(2), makeId(4), makeId(5)]);
    checks.push('filtered_select_all_preserves_other_selections', 'filtered_invert', 'duplicate_names_keep_distinct_ids');

    await frame.getByRole('button', { name: /检查归档范围/ }).click();
    await frame.getByRole('dialog', { name: '确认归档范围', exact: true }).waitFor();
    assert.equal(await frame.locator('#scope-items li').count(), 4);
    assert.deepEqual(await calls('confirm_archive'), []);
    await frame.getByRole('button', { name: '返回修改', exact: true }).click();
    assert.deepEqual(await selected(frame), [makeId(1), makeId(2), makeId(4), makeId(5)]);
    checks.push('complete_scope_before_mutation', 'cancel_scope_preserves_selection');

    await frame.getByRole('button', { name: '清空选择', exact: true }).click();
    await frame.getByRole('searchbox').fill('Alpha parent'); await row(frame, 1).check();
    await frame.getByLabel('包含所选聊天的已发现下级', { exact: true }).uncheck();
    await frame.getByRole('button', { name: /检查归档范围/ }).click();
    await frame.getByRole('dialog').waitFor(); assert.equal(await frame.locator('#scope-items li').count(), 1);
    assert.equal((await calls('plan_archive')).at(-1).args.includeDescendants, false);
    await frame.getByRole('dialog').press('Escape');
    assert.equal(await frame.getByRole('dialog').isVisible(), false);
    await frame.getByLabel('包含所选聊天的已发现下级', { exact: true }).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click();
    await frame.getByRole('dialog').waitFor(); assert.equal(await frame.locator('#scope-items li').count(), 2);
    await frame.getByRole('button', { name: '归档聊天 2 条 · 后台 0 项', exact: true }).click();
    await frame.getByText('归档完成', { exact: true }).waitFor();
    assert.deepEqual(Object.keys((await calls('confirm_archive'))[0].args), ['planToken']);
    assert.equal(await frame.getByText('已处理 2 / 2 条，已确认归档 2 条，失败 0 条。', { exact: true }).count(), 1);
    await page.waitForTimeout(1200);
    const terminalReads = (await calls('get_job')).length;
    await page.waitForTimeout(1100);
    assert.equal((await calls('get_job')).length, terminalReads);
    checks.push('explicit_selected_only', 'escape_without_mutation', 'descendants_reviewed', 'confirmation_uses_token_only', 'array_progress_normalized', 'polling_only_during_active_job');

    frame = await open({ holdJob: true }); await ready(frame); await row(frame, 3).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
    await frame.getByRole('button', { name: '归档聊天 1 条 · 后台 0 项', exact: true }).click();
    await frame.getByText('正在归档', { exact: true }).waitFor();
    assert.equal(await frame.getByRole('searchbox').isDisabled(), true);
    await frame.getByRole('switch', { name: '启用嵌套显示' }).check();
    await page.waitForFunction(() => window.fixture.module.nestingEnabled === true);
    assert.equal((await calls('set_module_state')).at(-1).args.nestingEnabled, true);
    await frame.getByRole('button', { name: '停止后续归档', exact: true }).click();
    await frame.getByText('已停止', { exact: true }).waitFor();
    assert.equal((await calls('stop_job')).length, 1);
    await frame.getByRole('switch', { name: '启用批量归档' }).uncheck();
    await page.waitForFunction(() => window.fixture.module.archiveEnabled === false);
    assert.equal(await frame.getByRole('button', { name: /检查归档范围/ }).isDisabled(), true);
    assert.equal(await frame.getByRole('switch', { name: '启用嵌套显示' }).isChecked(), true);
    checks.push('job_freezes_selection', 'nesting_toggle_independent_during_archive', 'stop_targets_job', 'module_switches_are_independent');

    frame = await open({ failList: true });
    await frame.getByRole('alert').filter({ hasText: '本地归档服务尚未连接' }).waitFor();
    assert.equal(await frame.getByRole('button', { name: /检查归档范围/ }).isDisabled(), true);
    assert.deepEqual(await calls('confirm_archive'), []);
    checks.push('backend_unavailable_disables_archive');

    for (const [failSetting, commitBeforeFailure] of [[false, false], [true, false], [true, true]]) {
      frame = await open({ holdSetting: true, failSetting, commitBeforeFailure }); await ready(frame);
      const toggle = frame.getByRole('switch', { name: '启用嵌套显示' });
      await toggle.check(); await page.waitForFunction(() => typeof window.fixture.releaseSetting === 'function');
      assert.equal(await toggle.isChecked(), true); assert.equal(await toggle.isDisabled(), true);
      await frame.getByText('正在保存…', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.fixture.module.nestingEnabled), false);
      await page.evaluate(() => window.fixture.releaseSetting());
      await page.waitForFunction(() => !document.querySelector('iframe').contentDocument.querySelector('#nesting-enabled').disabled);
      const saved = !failSetting || commitBeforeFailure;
      assert.equal(await toggle.isChecked(), saved);
      assert.equal(await page.evaluate(() => window.fixture.module.nestingEnabled), saved);
      if (failSetting) {
        await frame.getByRole('alert').filter({ hasText: '设置保存失败' }).waitFor();
        assert.ok((await calls('get_module_status')).length >= 2);
      }
      assert.equal((await calls('set_module_state')).length, 1);
    }
    checks.push('module_switch_holds_pending_value', 'failed_switch_restores_service_state', 'lost_save_reply_reads_committed_state');

    frame = await open({ badPlanCount: true }); await ready(frame); await row(frame, 3).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click();
    await frame.getByRole('alert').filter({ hasText: '归档范围不完整' }).waitFor();
    assert.equal(await frame.getByRole('dialog').isVisible(), false);
    assert.deepEqual(await calls('confirm_archive'), []);
    checks.push('incomplete_scope_cannot_submit');

    const warning = `官方归档可能同时影响关联子任务。${'并发新建的聊天不在当前快照内；'.repeat(170)}<img src=x onerror=alert(1)>`;
    frame = await open({ warnings: [warning, '确认后仅处理已经展示的范围；执行中发现变化会停止后续。'] });
    await ready(frame); await row(frame, 1).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
    assert.equal(await frame.locator('#scope-warnings li').count(), 2);
    assert.equal(await frame.locator('#scope-warnings li').first().textContent(), warning);
    assert.equal(await frame.locator('#scope-warnings img').count(), 0);
    assert.equal(await frame.locator('#scope-mode').textContent(), '范围：包含已发现下级');
    assert.deepEqual(await calls('confirm_archive'), []);
    await frame.getByRole('button', { name: '归档聊天 2 条 · 后台 0 项', exact: true }).click();
    await frame.getByText('归档完成', { exact: true }).waitFor();
    assert.deepEqual(Object.keys((await calls('confirm_archive'))[0].args), ['planToken']);
    checks.push('scope_warnings_complete_without_truncation', 'scope_warnings_are_safe_text', 'descendant_scope_mode_displayed', 'warnings_share_same_confirmation_token');

    frame = await open({ relationsAvailable: false, module: { state: 'ready', archiveEnabled: true, nestingEnabled: true,
      nativeState: 'unavailable', independentArchive: true, message: '本地层级暂未读取成功。' } });
    await ready(frame); await row(frame, 3).check();
    await frame.getByText('层级读取暂不可用，可取消包含下级，仅归档勾选聊天。 本地层级暂未读取成功。', { exact: true }).waitFor();
    assert.equal(await frame.locator('#include-descendants').isChecked(), true);
    assert.equal(await frame.getByRole('button', { name: /检查归档范围/ }).isDisabled(), true);
    assert.deepEqual(await calls('plan_archive'), []);
    await frame.getByLabel('包含所选聊天的已发现下级', { exact: true }).uncheck();
    await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
    assert.equal(await frame.locator('#scope-mode').textContent(), '范围：仅所选');
    assert.equal((await calls('plan_archive'))[0].args.includeDescendants, false);
    await frame.getByRole('button', { name: '返回修改', exact: true }).click();
    assert.equal(await frame.locator('#include-descendants').isChecked(), false);
    assert.equal(await frame.getByRole('switch', { name: '启用嵌套显示' }).isEnabled(), true);
    checks.push('relation_failure_explicit_notice', 'relation_failure_never_silently_changes_scope', 'manual_selected_only_allowed_without_native_bridge', 'selected_only_scope_mode_displayed');

    frame = await open({ planLifetime: 200 }); await ready(frame); await row(frame, 3).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
    await frame.getByText('这份范围已过期，请返回后重新检查。', { exact: true }).waitFor();
    assert.equal(await frame.getByRole('button', { name: '归档聊天 1 条 · 后台 0 项', exact: true }).isDisabled(), true);
    assert.deepEqual(await calls('confirm_archive'), []);
    checks.push('expired_plan_requires_new_review');

    frame = await open({ incompleteVerification: true }); await ready(frame); await row(frame, 3).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
    await frame.getByRole('button', { name: '归档聊天 1 条 · 后台 0 项', exact: true }).click();
    await frame.getByText('处理已结束，请检查结果', { exact: true }).waitFor();
    assert.equal(await frame.getByText('归档完成', { exact: true }).count(), 0);
    checks.push('unverified_completion_not_reported_as_success');

    const implicitItems = [
      { id: makeId(101), title: '后台资料整理', parentId: makeId(1), parentTitle: 'Alpha parent' },
      { id: makeId(102), title: '<img src=x onerror=alert(1)>', parentId: makeId(2), parentTitle: 'Alpha child' },
      { id: makeId(103), title: makeId(103), parentId: makeId(1), parentTitle: 'Alpha parent' }
    ];
    frame = await open({ implicitItems, holdJob: true }); await ready(frame); await row(frame, 1).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
    assert.equal(await frame.locator('#scope-items li').count(), 2);
    assert.equal(await frame.locator('#scope-implicit-items li').count(), 3);
    assert.equal(await frame.locator('#scope-implicit-items input').count(), 0);
    assert.equal(await frame.locator('#scope-implicit-items img').count(), 0);
    assert.equal(await frame.locator('#scope-implicit-items').getByText('未命名后台子任务', { exact: true }).count(), 1);
    assert.match(await frame.locator('#scope-implicit-items li').nth(1).textContent(), /所属聊天：Alpha child/);
    assert.match(await frame.locator('#scope-summary').textContent(), /2 条聊天、3 项后台子任务/);
    if (process.env.CNCC_PANEL_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.CNCC_PANEL_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.CNCC_PANEL_SCREENSHOT_DIR, 'archive-background-scope.png') });
    }
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await frame.locator('#scope-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
    assert.equal(await frame.locator('#scope-implicit-items li').count(), 3);
    if (process.env.CNCC_PANEL_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CNCC_PANEL_SCREENSHOT_DIR, 'archive-background-scope-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    const reviewed = await page.evaluate(() => Object.values(window.fixture.plans)[0]);
    await frame.getByRole('button', { name: '归档聊天 2 条 · 后台 3 项', exact: true }).click();
    await frame.getByText('后台子任务：已确认 0 / 3 项，尚未确认 3 项。', { exact: true }).waitFor();
    assert.equal(await frame.getByRole('progressbar', { name: '后台子任务核对进度' }).getAttribute('max'), '3');
    assert.deepEqual((await calls('confirm_archive'))[0].args, { planToken: reviewed.planToken, backgroundReviewToken: reviewed.backgroundReviewToken });
    assert.equal(await page.evaluate(() => window.fixture.job.total), 2);
    await page.evaluate(() => { window.fixture.holdJob = false; });
    await frame.getByRole('button', { name: '刷新进度', exact: true }).click();
    await frame.getByText('归档完成', { exact: true }).waitFor();
    assert.equal(await frame.getByText('后台子任务：已确认 3 / 3 项，尚未确认 0 项。', { exact: true }).count(), 1);
    checks.push('background_scope_separate_complete_and_nonselectable', 'background_scope_safe_titles_and_owner',
      'background_scope_mobile_without_overflow', 'background_counts_do_not_change_chat_total', 'background_review_token_binds_same_confirmation', 'background_progress_verifies_ids');

    const badScopes = [
      { omitImplicitList: true }, { omitImplicitCount: true }, { implicitCount: 4 }, { implicitCount: 0 },
      { implicitItems: [implicitItems[0], implicitItems[0], implicitItems[2]] },
      { implicitItems: [{ ...implicitItems[0], id: makeId(1) }] },
      { implicitItems: [{ ...implicitItems[0], parentId: makeId(999) }] },
      { implicitItems: [{ ...implicitItems[0], title: '' }] }, { implicitItems: [{ ...implicitItems[0], parentTitle: '' }] },
      { implicitItems: [{ ...implicitItems[0], title: { malformed: true } }] },
      { implicitItems: [{ ...implicitItems[0], parentTitle: '错误所属聊天' }] },
      { omitBackgroundToken: true }, { planPatch: { backgroundReviewToken: 'not-a-uuid' } },
      { planPatch: { implicitCount: '3' } }, { implicitItems: { invalid: true } },
      { planPatch: { items: [chat(3, '错误聊天')], totalCount: 1 } },
      { planPatch: { items: [{ id: makeId(1), title: { invalid: true } }], totalCount: 1 } }
    ];
    for (const malformed of badScopes) {
      frame = await open({ implicitItems, ...malformed }); await ready(frame); await row(frame, 1).check();
      await frame.getByRole('button', { name: /检查归档范围/ }).click();
      await frame.getByRole('alert').filter({ hasText: /后台子任务|清单|范围/ }).waitFor();
      assert.equal(await frame.getByRole('dialog').isVisible(), false);
      assert.deepEqual(await calls('confirm_archive'), []);
    }
    frame = await open({ legacyPlan: true }); await ready(frame); await row(frame, 3).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click();
    await frame.getByRole('alert').filter({ hasText: '请更新插件后重试' }).waitFor();
    assert.deepEqual(await calls('confirm_archive'), []);
    checks.push('damaged_or_missing_background_scope_blocks_confirmation', 'background_scope_rejects_empty_titles', 'legacy_plan_requires_explicit_upgrade');

    frame = await open({ implicitItems, incompleteImplicitVerification: true }); await ready(frame); await row(frame, 1).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
    await frame.getByRole('button', { name: '归档聊天 2 条 · 后台 3 项', exact: true }).click();
    await frame.getByText('处理已结束，请检查后台子任务', { exact: true }).waitFor();
    assert.equal(await frame.getByText('归档完成', { exact: true }).count(), 0);
    assert.equal(await frame.getByText('后台子任务：已确认 0 / 3 项，尚未确认 3 项。', { exact: true }).count(), 1);
    const badProgress = [
      { jobPatch: { implicitTotal: 3, verifiedImplicit: [makeId(101), makeId(102), makeId(999)], pendingImplicit: [] } },
      { jobPatch: { implicitTotal: 2, verifiedImplicit: [makeId(101), makeId(102)], pendingImplicit: [] } },
      { jobPatch: { implicitTotal: 3, verifiedImplicit: [makeId(101), makeId(101), makeId(102)], pendingImplicit: [] } },
      { jobPatch: { implicitTotal: 3, verifiedImplicit: [makeId(101), makeId(102), makeId(103)], pendingImplicit: [makeId(103)] } },
      { jobPatch: { implicitTotal: 3, verifiedImplicit: 3, pendingImplicit: [] } },
      { jobPatch: { implicitTotal: 0, verifiedImplicit: [], pendingImplicit: [] } },
      { omitJobField: 'pendingImplicit' }, { legacyJob: true }
    ];
    for (const malformed of badProgress) {
      frame = await open({ implicitItems, ...malformed }); await ready(frame); await row(frame, 1).check();
      await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
      await frame.getByRole('button', { name: '归档聊天 2 条 · 后台 3 项', exact: true }).click();
      await frame.getByText('处理已结束，请检查后台子任务', { exact: true }).waitFor();
      assert.equal(await frame.getByText('归档完成', { exact: true }).count(), 0);
      assert.match(await frame.locator('#job-implicit-summary').textContent(), /状态不完整/);
    }
    frame = await open({ legacyJob: true }); await ready(frame); await row(frame, 3).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
    await frame.getByRole('button', { name: '归档聊天 1 条 · 后台 0 项', exact: true }).click();
    await frame.getByText('归档完成', { exact: true }).waitFor();
    assert.match(await frame.locator('#job-implicit-summary').textContent(), /当前确认范围不含后台子任务；旧服务/);
    frame = await open({ activeJob: { jobId: 'legacy-restored-job', status: 'completed', total: 1, completed: 1, verified: [makeId(3)], failed: 0 } });
    await frame.getByText('处理已结束，请检查后台子任务', { exact: true }).waitFor();
    assert.equal(await frame.getByText('归档完成', { exact: true }).count(), 0);
    checks.push('pending_background_never_reports_complete', 'malformed_background_progress_never_reports_complete',
      'legacy_job_only_compatible_with_reviewed_zero_background', 'restored_legacy_job_does_not_assume_zero_background');

    frame = await open({ hostVersion: '26.900.10000' });
    await frame.getByRole('alert').filter({ hasText: '当前桌面版本较旧' }).waitFor();
    assert.deepEqual(await calls('list_chats'), []);
    checks.push('known_old_host_update_message');

    const treeCatalog = [chat(10, '大型项目主控', { projectName: '项目甲' }),
      chat(11, '调研任务', { projectName: '项目甲', parentId: makeId(10) }),
      chat(12, '唯一命中：药学数据', { projectName: '项目甲', parentId: makeId(11) }),
      chat(13, '第四层任务', { projectName: '项目甲', parentId: makeId(12) }),
      chat(14, '报告任务', { projectName: '项目乙', parentId: makeId(10) }),
      chat(15, '独立工作', { parentId: makeId(999) }), chat(16, makeId(16), { parentId: makeId(10) })];
    const item = (frame, value) => frame.locator(`[data-tree-id="${makeId(value)}"]`);
    const ownRow = (frame, value) => item(frame, value).locator(':scope > .chat-row');
    const branch = (frame, value) => ownRow(frame, value).locator('.tree-toggle');
    const focused = frame => frame.locator('[data-tree-id]:focus').getAttribute('data-tree-id');
    frame = await open({ chats: treeCatalog });
    await frame.getByText('共 7 条，当前筛选 7 条，已选 0 条', { exact: true }).waitFor();
    assert.equal(await frame.getByRole('tree', { name: '可归档聊天树' }).count(), 1);
    assert.equal(await item(frame, 11).locator(`[data-tree-id="${makeId(12)}"] [data-tree-id="${makeId(13)}"]`).count(), 1);
    for (const [value, level] of [[10, 1], [11, 2], [12, 3], [13, 4], [15, 1]]) assert.equal(await item(frame, value).getAttribute('aria-level'), String(level));
    await branch(frame, 11).click(); assert.equal(await row(frame, 12).isVisible(), false); assert.equal(await row(frame, 13).isVisible(), false);
    await branch(frame, 10).click(); assert.equal(await row(frame, 11).isVisible(), false);
    await branch(frame, 10).click(); assert.equal(await row(frame, 11).isVisible(), true); assert.equal(await row(frame, 12).isVisible(), false);
    assert.equal(await frame.locator('#include-descendants').isChecked(), true);
    checks.push('true_four_level_tree_structure', 'independent_multilevel_collapse');

    await frame.getByRole('searchbox').fill('唯一命中');
    assert.equal(await frame.locator('[data-chat-id]').count(), 3);
    assert.equal(await row(frame, 12).isVisible(), true);
    assert.equal(await ownRow(frame, 10).getAttribute('data-context'), 'true');
    assert.equal(await ownRow(frame, 11).getAttribute('data-context'), 'true');
    assert.match(await frame.locator('#tree-hint').textContent(), /另显示 2 条上级路径/);
    await frame.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(frame), [makeId(12)]);
    assert.equal(await row(frame, 10).isChecked(), false);
    await frame.getByRole('searchbox').fill(''); assert.equal(await row(frame, 12).isVisible(), false);
    await frame.getByRole('searchbox').fill('报告任务');
    await frame.getByRole('button', { name: '全选当前筛选', exact: true }).click(); assert.deepEqual(await selected(frame), [makeId(12), makeId(14)]);
    await frame.getByRole('button', { name: '反选当前筛选', exact: true }).click(); assert.deepEqual(await selected(frame), [makeId(12)]);
    await frame.getByRole('searchbox').fill(''); await frame.getByRole('combobox', { name: '按项目筛选' }).selectOption('项目乙');
    assert.equal(await frame.locator('[data-chat-id]').count(), 2); assert.equal(await ownRow(frame, 10).getAttribute('data-context'), 'true');
    await frame.getByRole('button', { name: '全选当前筛选', exact: true }).click(); assert.deepEqual(await selected(frame), [makeId(12), makeId(14)]);
    await frame.getByRole('button', { name: '反选当前筛选', exact: true }).click(); assert.deepEqual(await selected(frame), [makeId(12)]);
    await frame.getByRole('combobox', { name: '按项目筛选' }).selectOption(''); await branch(frame, 11).click();
    assert.equal(await ownRow(frame, 13).getAttribute('data-inherited'), 'true'); assert.equal(await row(frame, 13).isChecked(), false);
    assert.equal(await ownRow(frame, 13).getByText('随上级归档', { exact: true }).isVisible(), true);
    await frame.getByLabel('包含所选聊天的已发现下级', { exact: true }).uncheck();
    assert.equal(await ownRow(frame, 13).getAttribute('data-inherited'), 'false');
    assert.equal(await ownRow(frame, 13).getByText('随上级归档', { exact: true }).isVisible(), false);
    assert.deepEqual(await selected(frame), [makeId(12)]);
    await frame.getByLabel('包含所选聊天的已发现下级', { exact: true }).check();
    await frame.getByRole('button', { name: '清空选择', exact: true }).click(); await row(frame, 10).check();
    assert.deepEqual(await selected(frame), [makeId(10)]);
    assert.equal(await frame.locator('.chat-row[data-inherited="true"]').count(), 5);
    assert.equal(await row(frame, 11).isChecked(), false);
    await row(frame, 12).check(); assert.equal(await ownRow(frame, 12).getAttribute('data-inherited'), 'false'); assert.equal(await ownRow(frame, 12).getAttribute('data-selected'), 'true');
    assert.equal(await row(frame, 12).evaluate(input => getComputedStyle(input).appearance), 'none');
    assert.equal(await row(frame, 12).evaluate(input => parseFloat(getComputedStyle(input, '::after').borderRightWidth) > 0), true);
    assert.notEqual(await ownRow(frame, 12).evaluate(row => getComputedStyle(row).backgroundColor), await ownRow(frame, 15).evaluate(row => getComputedStyle(row).backgroundColor));
    assert.equal(await item(frame, 12).getAttribute('aria-selected'), 'true');
    checks.push('search_preserves_ancestor_context', 'search_bulk_selection_excludes_context', 'project_filter_preserves_context_without_bulk_selecting_it', 'filter_preserves_collapse_preferences',
      'cross_filter_tree_selection', 'implicit_descendants_are_visually_distinct', 'include_descendants_does_not_change_explicit_selection', 'custom_checkbox_and_selected_row_highlight');
    if (process.env.CNCC_PANEL_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.CNCC_PANEL_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.CNCC_PANEL_SCREENSHOT_DIR, 'archive-tree.png') });
    }
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      const contrast = await row(frame, 12).evaluate(input => {
        const luminance = color => {
          const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(channel => channel / 255);
          const linear = rgb.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
          return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
        };
        const fill = luminance(getComputedStyle(input).backgroundColor), mark = luminance(getComputedStyle(input, '::after').borderRightColor);
        return (Math.max(fill, mark) + .05) / (Math.min(fill, mark) + .05);
      });
      assert(contrast >= 3, `${colorScheme} checkbox contrast ${contrast}`);
      if (colorScheme === 'dark' && process.env.CNCC_PANEL_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CNCC_PANEL_SCREENSHOT_DIR, 'archive-tree-dark.png') });
    }
    checks.push('checkbox_mark_contrast_in_light_and_dark');
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await frame.locator('html').evaluate(element => element.scrollWidth <= innerWidth + 1), true);
    assert.equal(await row(frame, 13).evaluate(input => input.getBoundingClientRect().width >= 20), true);
    if (process.env.CNCC_PANEL_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CNCC_PANEL_SCREENSHOT_DIR, 'archive-tree-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    checks.push('nested_tree_mobile_width_and_checkbox_size');

    await item(frame, 10).focus(); await item(frame, 10).press('ArrowRight'); assert.equal(await focused(frame), makeId(11));
    await item(frame, 11).press('ArrowRight'); assert.equal(await focused(frame), makeId(12));
    await item(frame, 12).press('ArrowRight'); assert.equal(await focused(frame), makeId(13));
    await item(frame, 13).press('ArrowLeft'); assert.equal(await focused(frame), makeId(12));
    await item(frame, 12).press('ArrowLeft'); assert.equal(await item(frame, 12).getAttribute('aria-expanded'), 'false'); assert.equal(await row(frame, 13).isVisible(), false);
    await item(frame, 12).press('Space'); assert.deepEqual(await selected(frame), [makeId(10)]); assert.equal(await ownRow(frame, 12).getAttribute('data-inherited'), 'true');
    await item(frame, 12).press('Enter'); assert.equal(await row(frame, 12).isChecked(), true);
    await item(frame, 12).press('ArrowLeft'); assert.equal(await focused(frame), makeId(11));
    await item(frame, 11).press('Home'); assert.equal(await focused(frame), makeId(10));
    await item(frame, 10).press('End'); assert.equal(await focused(frame), makeId(15));
    await item(frame, 15).press('ArrowUp'); assert.equal(await focused(frame), makeId(16));
    assert.equal(await frame.locator('[data-tree-id][tabindex="0"]').count(), 1);
    checks.push('tree_keyboard_navigation_and_selection', 'tree_aria_levels_and_roving_focus');

    await frame.getByRole('button', { name: '清空选择', exact: true }).click();
    await frame.getByRole('searchbox').fill(makeId(16));
    assert.equal(await row(frame, 16).isVisible(), true); assert.equal(await ownRow(frame, 16).getByText('未命名聊天', { exact: true }).count(), 1);
    assert.match(await ownRow(frame, 16).textContent(), /#00000016/);
    await frame.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
    assert.deepEqual((await calls('plan_archive')).at(-1).args.chatIds, [makeId(16)]);
    await frame.getByRole('button', { name: '返回修改', exact: true }).click();
    checks.push('id_titles_use_readable_fallback', 'full_id_search_keeps_backend_identity');

    frame = await open({ chats: treeCatalog, reversePlan: true });
    await frame.getByText('共 7 条，当前筛选 7 条，已选 0 条', { exact: true }).waitFor(); await row(frame, 10).check();
    await frame.getByRole('button', { name: /检查归档范围/ }).click(); await frame.getByRole('dialog').waitFor();
    const scope = await frame.locator('#scope-items li').evaluateAll(items => items.map(item => ({ id: item.dataset.scopeChatId, depth: Number(item.dataset.depth), hidden: item.hidden })));
    assert.equal(scope.length, 6); assert.equal(scope.every(item => !item.hidden), true);
    const position = id => scope.findIndex(item => item.id === makeId(id));
    assert(position(10) < position(11)); assert(position(11) < position(12)); assert(position(12) < position(13));
    assert.equal(scope[position(13)].depth, 3); assert.equal(await frame.getByRole('button', { name: '归档聊天 6 条 · 后台 0 项', exact: true }).count(), 1);
    assert.deepEqual(await calls('confirm_archive'), []); await frame.getByRole('button', { name: '返回修改', exact: true }).click();
    checks.push('confirmation_hierarchy_parent_before_child', 'confirmation_keeps_every_item_visible');

    frame = await open({ chats: [chat(20, '环一', { parentId: makeId(21) }), chat(21, '环二', { parentId: makeId(20) }),
      chat(22, '缺失上级', { parentId: makeId(999) }), chat(23, '自指向', { parentId: makeId(23) }), chat(24, '普通聊天')] });
    await frame.getByText('共 5 条，当前筛选 5 条，已选 0 条', { exact: true }).waitFor();
    assert.equal(await frame.locator('[data-tree-id]').count(), 5); assert.equal(await frame.locator('[data-chat-id]').count(), 5);
    assert.equal(await item(frame, 22).getAttribute('aria-level'), '1'); assert.equal(await item(frame, 23).getAttribute('aria-level'), '1');
    checks.push('cyclic_and_orphan_relations_do_not_lose_chats');

    frame = await open(); await ready(frame);
    for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      assert.equal(await frame.locator('html').evaluate(element => element.scrollWidth <= innerWidth + 1), true);
    }
    const effects = await page.evaluate(() => window.fixture.calls.map(call => call.name));
    assert.equal(effects.some(name => /prompt|sampling|message/i.test(name)), false);
    assert.deepEqual(requests, []);
    checks.push('responsive_without_horizontal_overflow', 'no_model_prompts', 'no_external_network_requests');
    console.log(JSON.stringify({ passed: true, checks }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
