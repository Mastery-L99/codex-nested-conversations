'use strict';
// Synthetic DOM only: no official process, profile, chat, or endpoint is used.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const sourcePath = path.join(__dirname, '../src/bulk-archive.js');
const makeId = value => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const chat = (value, title, extras = {}) => ({ id: makeId(value), title, kind: 'codex', hostId: 'local',
  createdAtMs: Date.UTC(2026, 9, 30, 2, 30, value), updatedAtMs: Date.UTC(2026, 9, 30, 3, 30, value), ...extras });
const initial = [chat(1, 'Alpha parent'), chat(2, 'Alpha child'), chat(3, 'Beta'),
  chat(4, 'Same title'), chat(5, 'Same title'), chat(6, '<img src=x onerror=alert(1)>'),
  chat(1, 'Alpha parent'), chat(7, 'Cloud', { kind: 'chatgpt' }),
  chat(8, 'Remote', { hostId: 'remote' }), chat(9, 'Archived', { archived: true }),
  chat(10, 'Bad', { id: 'not-a-uuid' })];

(async () => {
  const source = await fs.readFile(sourcePath, 'utf8');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = [];
  try {
    const page = await browser.newPage();
    await page.setContent('<html><head></head><body><aside id="app-shell-sidebar"></aside></body></html>');
    await page.evaluate(initial => {
      window.fixture = { catalog: initial, previews: [], submitted: [], busy: false, dialogOpen: false, failPreview: false };
      window.__codexNestedRelations = { schemaVersion: 1, groups: [{ parent: initial[0], children: [initial[1]] }] };
      window.__codexNestedCascade = {
        listChats() { return window.fixture.catalog; },
        inspect() { return { busy: window.fixture.busy, dialogOpen: window.fixture.dialogOpen }; },
        async previewMany(chats, options) {
          if (window.fixture.failPreview) throw new Error('Fixture preview unavailable');
          if (window.fixture.holdPreview) await new Promise((resolve, reject) => window.fixture.releasePreview = () =>
            window.fixture.rejectHeldPreview ? reject(new Error('Fixture delayed preview failed')) : resolve());
          window.fixture.previews.push({ chats, options });
          return { rootCount: chats.length, count: chats.length, operation: 'archive' };
        }
      };
    }, initial);
    await page.evaluate(source);
    assert.equal(await page.locator('[data-codex-nested-bulk-owned].cnb-entry').count(), 1);
    assert.equal(await page.locator('.cnb-overlay').count(), 0);
    checks.push('dormant_single_sidebar_entry');

    const open = async () => {
      await page.getByRole('button', { name: '批量归档聊天', exact: true }).click();
      await page.getByRole('dialog', { name: '批量归档聊天', exact: true }).waitFor();
    };
    const close = async () => page.getByRole('button', { name: '取消', exact: true }).click();
    const state = async () => page.evaluate(() => window.__codexNestedBulk.inspect());
    const selected = async () => (await state()).selected.sort();
    const search = () => page.getByRole('searchbox', { name: '按标题筛选聊天' });
    await open();
    assert.equal(await page.locator('[data-codex-bulk-chat-id]').count(), 6);
    assert.equal(await page.locator('.cnb-list img').count(), 0);
    assert.equal(await page.getByText('<img src=x onerror=alert(1)>', { exact: true }).count(), 1);
    checks.push('local_eligible_catalog_only', 'uuid_deduplicated', 'titles_are_plain_text');
    const sameFirst = page.locator('.cnb-item').filter({ has: page.locator(`[data-codex-bulk-chat-id="${makeId(4)}"]`) });
    const sameSecond = page.locator('.cnb-item').filter({ has: page.locator(`[data-codex-bulk-chat-id="${makeId(5)}"]`) });
    assert.match(await sameFirst.locator('.cnb-meta').textContent(), /\d{2}:\d{2}:\d{2}/);
    assert.notEqual(await sameFirst.locator('.cnb-meta').textContent(), await sameSecond.locator('.cnb-meta').textContent());
    assert.match(await sameFirst.getAttribute('title'), new RegExp(makeId(4)));
    assert.doesNotMatch(await sameFirst.textContent(), new RegExp(makeId(4)));
    const nested = page.locator('.cnb-item').filter({ has: page.locator(`[data-codex-bulk-chat-id="${makeId(2)}"]`) });
    assert.match(await nested.locator('.cnb-meta').textContent(), /上级：Alpha parent/);
    checks.push('duplicate_names_show_distinct_creation_seconds_and_uuid_tooltip', 'nested_rows_show_parent_title');
    await search().fill('Alpha');
    await page.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(), [makeId(1), makeId(2)]);
    await search().fill('Beta');
    await page.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(), [makeId(1), makeId(2), makeId(3)]);
    await page.getByRole('button', { name: '反选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(), [makeId(1), makeId(2)]);
    checks.push('select_all_filtered_only', 'selections_outside_filter_preserved', 'invert_filtered_only');
    await search().fill('Same title');
    await page.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(), [makeId(1), makeId(2), makeId(4), makeId(5)]);
    checks.push('same_title_distinct_uuid');
    await search().fill('does not exist');
    assert.equal(await page.getByText('没有匹配的聊天。', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '全选当前筛选', exact: true }).isDisabled(), true);
    checks.push('empty_filter_no_selectable_rows');
    await close();
    assert.deepEqual(await selected(), []);
    assert.deepEqual(await page.evaluate(() => window.fixture.previews), []);
    assert.deepEqual(await page.evaluate(() => window.fixture.submitted), []);
    checks.push('cancel_clears_without_archive');

    await open();
    await page.locator(`[data-codex-bulk-chat-id="${makeId(1)}"]`).check();
    await page.locator(`[data-codex-bulk-chat-id="${makeId(2)}"]`).check();
    await page.getByRole('button', { name: '归档所选 2 个', exact: true }).click();
    await page.waitForFunction(() => window.fixture.previews.length === 1);
    assert.equal(await page.locator('.cnb-overlay').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.fixture.previews[0].chats.map(chat => chat.id)), [makeId(1), makeId(2)]);
    assert.deepEqual(await page.evaluate(() => window.fixture.previews[0].options), { includeDescendants: true });
    assert.deepEqual(await page.evaluate(() => window.fixture.submitted), []);
    assert.deepEqual(await selected(), [makeId(1), makeId(2)]);
    checks.push('archive_opens_scope_only', 'default_descendants_option', 'scope_cancel_can_reopen_selection');
    await open();
    await page.getByLabel('同时归档所选主对话的全部下级', { exact: true }).uncheck();
    await page.getByRole('button', { name: '归档所选 2 个', exact: true }).click();
    await page.waitForFunction(() => window.fixture.previews.length === 2);
    assert.deepEqual(await page.evaluate(() => window.fixture.previews[1].options), { includeDescendants: false });
    checks.push('explicit_selected_only_option');

    await open();
    assert.equal(await page.getByLabel('同时归档所选主对话的全部下级', { exact: true }).isChecked(), false);
    checks.push('selected_only_option_survives_scope_cancel');
    // Remove the item and click in the same task to test a change discovered
    // by the submit guard, before the scheduled sidebar refresh can run.
    await page.getByRole('button', { name: '归档所选 2 个', exact: true }).evaluate((button, id) => {
      window.fixture.catalog = window.fixture.catalog.filter(chat => chat.id !== id);
      button.click();
    }, makeId(2));
    assert.equal(await page.evaluate(() => window.fixture.previews.length), 2);
    assert.equal((await state()).dialogOpen, true);
    assert.deepEqual(await selected(), [makeId(1)]);
    assert.match(await page.getByRole('alert').textContent(), /聊天列表有变化/);
    // On the other ordering the sidebar already shows the smaller selection;
    // its first click must still stop and ask for another review.
    await page.evaluate(chat => { window.fixture.catalog.push(chat); window.__codexNestedBulk.refresh(); }, initial[1]);
    await page.locator(`[data-codex-bulk-chat-id="${makeId(2)}"]`).check();
    await page.evaluate(id => {
      window.fixture.catalog = window.fixture.catalog.filter(chat => chat.id !== id);
      window.__codexNestedBulk.refresh();
    }, makeId(2));
    await page.getByRole('button', { name: '归档所选 1 个', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixture.previews.length), 2);
    assert.equal((await state()).dialogOpen, true);
    assert.deepEqual(await selected(), [makeId(1)]);
    assert.match(await page.getByRole('alert').textContent(), /聊天列表有变化/);
    checks.push('stale_selection_requires_new_review', 'refreshed_stale_selection_requires_new_review');
    await page.evaluate(id => { window.fixture.catalog.filter(chat => chat.id === id).forEach(chat => chat.title = 'Renamed parent'); }, makeId(1));
    await page.getByRole('button', { name: '归档所选 1 个', exact: true }).click();
    await page.waitForFunction(() => window.fixture.previews.length === 3);
    assert.equal(await page.evaluate(() => window.fixture.previews[2].chats[0].title), 'Renamed parent');
    checks.push('fresh_metadata_at_preview_boundary');

    await page.evaluate(() => window.fixture.failPreview = true);
    await open();
    await page.getByRole('button', { name: '归档所选 1 个', exact: true }).click();
    await page.getByRole('dialog', { name: '批量归档聊天', exact: true }).waitFor();
    assert.match(await page.getByRole('alert').textContent(), /Fixture preview unavailable/);
    assert.deepEqual(await selected(), [makeId(1)]);
    await close();
    await page.evaluate(() => window.fixture.failPreview = false);
    checks.push('failed_preview_retains_selection');

    await page.evaluate(() => window.fixture.busy = true);
    assert.equal(await page.evaluate(() => window.__codexNestedBulk.open()), false);
    await page.evaluate(() => { window.fixture.busy = false; window.fixture.dialogOpen = true; });
    assert.equal(await page.evaluate(() => window.__codexNestedBulk.open()), false);
    await page.evaluate(() => {
      window.fixture.dialogOpen = false;
      const node = document.createElement('div'); node.role = 'alertdialog'; document.body.append(node);
    });
    assert.equal(await page.evaluate(() => window.__codexNestedBulk.open()), false);
    await page.evaluate(() => document.querySelector('[role="alertdialog"]').remove());
    checks.push('native_and_cascade_modal_guards');

    await page.evaluate(() => window.fixture.catalog = Array.from({ length: 257 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i + 100).padStart(12, '0')}`, title: `Large ${i}`, kind: 'codex', hostId: 'local'
    })));
    await open();
    await page.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(), []);
    assert.match(await page.getByRole('alert').textContent(), /最多选择 256/);
    checks.push('selection_limit_is_atomic');
    await page.getByRole('dialog').press('Escape');
    assert.equal((await state()).dialogOpen, false);
    checks.push('escape_closes_without_archive');
    await open();
    await page.locator('[data-codex-bulk-chat-id]').first().check();
    await search().fill('Large 0');
    await page.getByRole('button', { name: '归档所选 1 个', exact: true }).click();
    await page.waitForFunction(() => window.fixture.previews.length === 4);
    const priorState = await page.evaluate(() => window.__codexNestedBulk.getSelectionState());
    await page.evaluate(source);
    assert.equal(await page.locator('[data-codex-nested-bulk-owned].cnb-entry').count(), 1);
    assert.equal(await page.locator('style[data-codex-nested-bulk-owned]').count(), 1);
    assert.deepEqual(await page.evaluate(() => window.__codexNestedBulk.getSelectionState()), priorState);
    checks.push('reinjection_has_one_entry_and_style');
    checks.push('reinjection_after_scope_cancel_preserves_selection_and_filter');
    await page.evaluate(() => window.__codexNestedBulk.dispose());
    assert.equal(await page.locator('[data-codex-nested-bulk-owned]').count(), 0);
    assert.equal((await state()).installed, false);
    assert.deepEqual(await page.evaluate(() => window.fixture.submitted), []);
    checks.push('dispose_restores_all_owned_ui');

    const treeChats = [chat(20, '项目总控'), chat(21, '方案设计'), chat(22, '报价复核'), chat(28, '最终交付'),
      chat(23, '其他工作'), chat(24, '独立资料', { parentId: makeId(99) }), chat(25, '环节点 A'), chat(26, '环节点 B'),
      chat(27, makeId(27)), chat(22, '重复记录不应显示')];
    await page.evaluate(treeChats => {
      delete window.__codexNestedBulk;
      window.fixture.catalog = treeChats; window.fixture.previews = []; window.fixture.failPreview = false;
      const get = n => treeChats.find(chat => chat.id.endsWith(String(n).padStart(12, '0')));
      window.__codexNestedRelations = { schemaVersion: 1, groups: [
        { parent: get(20), children: [get(21), get(21), get(20)] }, { parent: get(21), children: [get(22)] },
        { parent: get(22), children: [get(28)] }, { parent: get(23), children: [get(22)] },
        { parent: get(25), children: [get(26)] }, { parent: get(26), children: [get(25)] },
        { parent: { ...get(20), id: '00000000-0000-0000-0000-000000000099' }, children: [get(24)] }
      ] };
    }, treeChats);
    await page.evaluate(source); await open();
    const input = n => page.locator(`[data-codex-bulk-chat-id="${makeId(n)}"]`);
    const row = n => page.locator(`[data-cnb-row-id="${makeId(n)}"]`);
    const toggle = n => page.locator(`[data-codex-bulk-toggle-id="${makeId(n)}"]`);
    const descendants = () => page.getByLabel('同时归档所选主对话的全部下级', { exact: true });
    assert.equal(await page.getByRole('tree', { name: '可归档聊天' }).count(), 1);
    assert.equal(await page.getByRole('treeitem').count(), 9);
    assert.equal(await row(28).getAttribute('aria-level'), '4');
    assert.equal(await row(24).getAttribute('aria-level'), '1');
    assert.equal(await row(22).getAttribute('data-cnb-parent-id'), makeId(21));
    assert.equal(await page.getByText('重复记录不应显示', { exact: true }).count(), 0);
    assert.equal(await row(25).getAttribute('aria-level'), '1'); assert.equal(await row(26).getAttribute('aria-level'), '2');
    assert(await input(28).boundingBox().then(box => input(20).boundingBox().then(parent => box.x > parent.x)));
    checks.push('multilevel_tree_aria_and_visual_indentation', 'orphans_remain_roots', 'cycles_self_edges_and_shared_children_render_each_uuid_once');

    await search().fill('报价复核');
    assert.equal(await page.getByRole('treeitem').count(), 3);
    assert.equal(await page.locator('[data-path-only="true"]').count(), 2);
    assert.equal(await row(22).getAttribute('aria-level'), '3');
    await page.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(), [makeId(22)]);assert.equal(await input(20).isChecked(), false);
    await search().fill('其他工作');await page.getByRole('button', { name: '全选当前筛选', exact: true }).click();
    assert.deepEqual(await selected(), [makeId(22), makeId(23)]);
    await page.getByRole('button', { name: '反选当前筛选', exact: true }).click();assert.deepEqual(await selected(), [makeId(22)]);
    await search().fill('');await toggle(20).click();
    assert.equal(await input(22).count(), 0);assert.deepEqual(await selected(), [makeId(22)]);
    await search().fill('报价复核');assert.equal(await input(22).count(), 1);
    await search().fill('');assert.equal(await input(22).count(), 0);await toggle(20).click();
    assert.equal(await input(22).isChecked(), true);
    checks.push('search_keeps_ancestor_paths_without_selecting_ancestors', 'tree_filter_preserves_other_selections', 'collapse_preserves_selection_and_search_temporarily_reveals_path');

    await page.getByRole('button', { name: '清空选择', exact: true }).click();await input(23).check();
    assert.equal(await row(22).locator('.cnb-inherited-badge').count(), 1);assert.equal(await row(28).locator('.cnb-inherited-badge').count(), 1);
    assert.equal(await input(22).count(), 1);assert.match(await row(22).locator('.cnb-meta').textContent(), /方案设计、其他工作/);
    checks.push('shared_child_scope_hint_uses_all_edges_without_duplicate_rows');
    await page.getByRole('button', { name: '清空选择', exact: true }).click();await input(20).check();
    assert.equal(await page.locator('.cnb-inherited-badge').count(), 3);
    assert.equal(await input(21).isChecked(), false);assert.equal(await row(21).getAttribute('data-inherited'), 'true');
    await descendants().uncheck();assert.equal(await page.locator('.cnb-inherited-badge').count(), 0);
    assert.equal(await row(21).getAttribute('data-inherited'), 'false');await descendants().check();
    await input(22).check();assert.equal(await row(22).locator('.cnb-inherited-badge').count(), 0);
    assert.equal(await page.locator('.cnb-inherited-badge').count(), 2);
    checks.push('inherited_archive_hint_distinct_from_explicit_checks', 'descendants_switch_immediately_removes_inherited_scope_hint');

    await input(20).focus();await input(20).press('ArrowLeft');assert.equal(await input(21).count(), 0);
    await input(20).press('ArrowRight');assert.equal(await input(21).count(), 1);
    await input(20).press('ArrowRight');assert.equal(await page.evaluate(() => document.activeElement.dataset.codexBulkChatId), makeId(21));
    await input(21).press('ArrowDown');assert.equal(await page.evaluate(() => document.activeElement.dataset.codexBulkChatId), makeId(22));
    await input(22).press('End');assert.equal(await page.evaluate(() => document.activeElement.dataset.codexBulkChatId), makeId(27));
    await input(27).press('Home');assert.equal(await page.evaluate(() => document.activeElement.dataset.codexBulkChatId), makeId(20));
    await input(20).press(' ');assert.equal(await input(20).isChecked(), false);
    await input(20).press('Enter');assert.equal(await input(20).isChecked(), true);
    assert.equal(await input(20).evaluate(node => getComputedStyle(node.nextElementSibling).outlineStyle), 'solid');
    checks.push('tree_arrow_home_end_keyboard_navigation', 'space_enter_selection_and_visible_keyboard_focus');

    await search().fill(makeId(27));assert.equal(await input(27).count(), 1);
    assert.equal(await row(27).locator('.cnb-title').textContent(), '未命名聊天');
    assert.match(await row(27).locator('.cnb-meta').textContent(), /创建于.*ID …00000027/);
    assert.doesNotMatch(await row(27).textContent(), new RegExp(makeId(27)));
    assert.match(await row(27).getAttribute('title'), new RegExp(makeId(27)));
    await input(27).check();await descendants().uncheck();
    await page.getByRole('button', { name: /^归档所选/ }).click();await page.waitForFunction(() => window.fixture.previews.length === 1);
    assert.equal(await page.evaluate(id => window.fixture.previews[0].chats.find(chat => chat.id === id).title, makeId(27)), makeId(27));
    checks.push('uuid_title_becomes_unnamed_with_date_short_id_and_full_id_search', 'display_alias_never_changes_preview_metadata');

    await open();await search().fill('');await page.getByRole('button', { name: '清空选择', exact: true }).click();
    await input(20).check();await descendants().check();
    const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'cncc-bulk-tree-screens-'));
    const screenshots = [];
    async function visual(name, media) {
      await page.emulateMedia(media);
      const styles = await row(20).evaluate(node => {
        const checked = node.querySelector('.cnb-check'), empty = document.querySelector('[data-cnb-row-id$="000000000023"] .cnb-check');
        const cs = getComputedStyle(checked), es = getComputedStyle(empty), bg = getComputedStyle(document.querySelector('.cnb-box'));
        return { rowBg: getComputedStyle(node).backgroundColor, checkedBg: cs.backgroundColor, checkedFg: cs.color,
          mark: getComputedStyle(checked, '::after').content, border: es.borderTopWidth, borderStyle: es.borderTopStyle,
          emptyBg: es.backgroundColor, emptyFg: es.borderTopColor, surface: bg.backgroundColor, text: bg.color };
      });
      assert.equal(styles.border, '2px');assert.equal(styles.borderStyle, 'solid');assert.notEqual(styles.checkedBg, styles.emptyBg);
      assert.notEqual(styles.checkedFg, styles.checkedBg);assert.notEqual(styles.mark, 'none');assert.notEqual(styles.emptyFg, styles.emptyBg);
      assert.notEqual(styles.surface, styles.text);assert.notEqual(styles.rowBg, 'rgba(0, 0, 0, 0)');
      const target = path.join(artifacts, `${name}.png`);await page.locator('.cnb-box').screenshot({ path: target });screenshots.push(target);
      return styles;
    }
    const light = await visual('tree-light', { colorScheme: 'light', forcedColors: 'none' });
    const dark = await visual('tree-dark', { colorScheme: 'dark', forcedColors: 'none' });
    assert.notEqual(light.surface, dark.surface);assert.notEqual(light.text, dark.text);
    await visual('tree-high-contrast', { colorScheme: 'dark', forcedColors: 'active' });
    await page.emulateMedia({ colorScheme: 'light', forcedColors: 'none' });
    await page.setViewportSize({ width: 375, height: 760 });
    assert(await page.locator('.cnb-box').evaluate(node => node.scrollWidth <= node.clientWidth));
    const mobile = path.join(artifacts, 'tree-mobile.png');await page.locator('.cnb-box').screenshot({ path: mobile });screenshots.push(mobile);
    checks.push('real_computed_checkbox_and_selected_styles_light_dark_high_contrast', 'mobile_dialog_fits_viewport');

    await page.evaluate(() => window.fixture.holdPreview = true);
    await page.getByRole('button', { name: '归档所选 1 个', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '正在核对归档范围…', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('.cnb-overlay').count(), 1);assert.equal(await search().isDisabled(), true);
    assert.equal(await descendants().isDisabled(), true);assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.fixture.holdPreview = false; window.fixture.releasePreview(); });
    await page.waitForFunction(() => !document.querySelector('.cnb-overlay'));
    assert.deepEqual(await selected(), [makeId(20)]);assert.deepEqual(await page.evaluate(() => window.fixture.submitted), []);
    checks.push('pending_scope_keeps_disabled_selection_dialog_until_handoff');
    await open();await page.evaluate(() => { window.fixture.holdPreview = true; window.fixture.rejectHeldPreview = true; });
    await page.getByRole('button', { name: '归档所选 1 个', exact: true }).click();
    await page.getByRole('dialog').press('Escape');assert.equal(await page.locator('.cnb-overlay').count(), 1);
    assert.equal(await page.getByRole('dialog').getAttribute('aria-busy'), 'true');
    await page.evaluate(() => { window.fixture.holdPreview = false; window.fixture.releasePreview(); });
    await page.waitForFunction(() => window.__codexNestedBulk.inspect().previewPending === false);
    assert.match(await page.getByRole('alert').textContent(), /Fixture delayed preview failed/);
    assert.deepEqual(await selected(), [makeId(20)]);assert.equal(await search().isDisabled(), false);
    assert.equal(await page.getByRole('dialog').getAttribute('aria-busy'), 'false');
    checks.push('delayed_scope_failure_stays_in_original_dialog_and_unlocks_selection');
    await page.evaluate(() => window.__codexNestedBulk.dispose());
    assert.equal(await page.locator('[data-codex-nested-bulk-owned]').count(), 0);
    console.log(JSON.stringify({ passed: true, checkCount: checks.length, checks, screenshots }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
