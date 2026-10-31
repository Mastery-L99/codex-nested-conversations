'use strict';
// This calls the real batch planner, preview, and executor against a synthetic
// page. Only the native-menu boundary and read-only commit reader are stubs.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const chat = (n, title) => ({ id: uuid(n), title, kind: 'codex', hostId: 'local' });
const [parent, child, grandchild, otherParent, solo] = [
  chat(1, 'Parent A'), chat(2, 'Shared child'), chat(3, 'Grandchild'), chat(4, 'Parent B'), chat(5, 'Standalone')
];
const relations = { schemaVersion: 1, catalog: [parent, child, grandchild, otherParent, solo], groups: [
  { parent, children: [child] }, { parent: child, children: [grandchild] }, { parent: otherParent, children: [child] }
] };

(async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/cascade-actions.js'), 'utf8');
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  const checks = [];
  try {
    const page = await browser.newPage();
    await page.setContent('<html><head></head><body><aside id="app-shell-sidebar"></aside></body></html>');
    await page.evaluate(() => {
      window.fixture = { submitted: [], verifiedReads: [], begin: [], end: 0, owner: null,
        wrongOwner: false, failOn: null, statusError: false, validationCalls: 0, validationMode: 'normal', snapshot: null };
      window.__codexNestedCascadeOptions = { enableArchiveExecution: true };
      window.__codexNestedRuntime = {
        async openNativeMenu(chat, anchor) {
          document.querySelector('[data-fixture-menu]')?.remove();
          if (window.fixture.failOn === chat.id) throw new Error('Synthetic native menu failed');
          const menu = document.createElement('div'); menu.role = 'menu'; menu.dataset.fixtureMenu = 'true';
          const command = document.createElement('button'); command.role = 'menuitem'; command.textContent = '归档 Ctrl+Shift+A';
          command.onclick = () => { window.fixture.submitted.push(chat.id); menu.remove(); };
          menu.append(command); document.body.append(menu);
          window.fixture.owner = { ...chat, anchor, menuElement: menu };
          if (window.fixture.wrongOwner) window.fixture.owner.id = '00000000-0000-0000-0000-999999999999';
          return { opened: true };
        },
        getMenuContext() { return window.fixture.owner; },
        inspect() { return { nativeMenuOpen: !!document.querySelector('[data-fixture-menu]') }; },
        async closeNativeMenu() { document.querySelector('[data-fixture-menu]')?.remove(); window.fixture.owner = null; }
      };
      window.__codexNestedArchiveStatus = async chat => {
        window.fixture.verifiedReads.push(chat.id);
        if (window.fixture.statusError) throw new Error('Synthetic commit read failed');
        return { archived: window.fixture.submitted.includes(chat.id) };
      };
      window.__codexNestedBeginArchive = async plan => { window.fixture.begin.push(plan); return { frozen: true }; };
      window.__codexNestedEndArchive = async () => { window.fixture.end++; return { released: true }; };
      window.__codexNestedValidateArchive = async () => {
        window.fixture.validationCalls++;
        if (window.fixture.validationMode === 'throw') throw new Error('Synthetic fresh snapshot failed');
        if (window.fixture.validationMode === 'hang') return new Promise(() => {});
        if (window.fixture.validationMode === 'invalid') return { schemaVersion: 99, groups: [] };
        return structuredClone(window.fixture.snapshot ?? window.__codexNestedRelations);
      };
      window.fixture.validator = window.__codexNestedValidateArchive;
    });
    const reset = async () => {
      await page.evaluate(relations => {
        window.__codexNestedCascade?.dispose();
        window.__codexNestedRelations = structuredClone(relations);
        Object.assign(window.fixture, { submitted: [], verifiedReads: [], begin: [], end: 0, owner: null,
          wrongOwner: false, failOn: null, statusError: false, validationCalls: 0, validationMode: 'normal', snapshot: null });
        window.__codexNestedCascadeOptions = { enableArchiveExecution: true, requireFreshValidation: true };
        window.__codexNestedValidateArchive = window.fixture.validator;
        document.querySelector('[data-fixture-menu]')?.remove();
      }, relations);
      await page.evaluate(source);
    };
    const plan = chats => page.evaluate(chats => window.__codexNestedCascade.planMany(chats), chats);
    const preview = (chats, includeDescendants = true) => page.evaluate(({ chats, includeDescendants }) =>
      window.__codexNestedCascade.previewMany(chats, { includeDescendants }), { chats, includeDescendants });
    const inspect = () => page.evaluate(() => window.__codexNestedCascade.inspect());
    const submitted = () => page.evaluate(() => window.fixture.submitted);
    const submit = count => page.getByRole('button', { name: `归档全部 ${count} 个`, exact: true }).click();
    const waitState = value => page.waitForFunction(value => window.__codexNestedCascade.inspect().state === value, value);
    const rejects = chats => page.evaluate(chats => {
      try { window.__codexNestedCascade.planMany(chats); return false; } catch { return true; }
    }, chats);
    await reset();
    const combined = await plan([parent, otherParent, child, parent]);
    assert.deepEqual(combined.items.map(chat => chat.id), [grandchild.id, child.id, parent.id, otherParent.id]);
    assert.deepEqual(combined.parents.map(chat => chat.id), [parent.id, otherParent.id, child.id]);
    assert.equal(new Set(combined.items.map(chat => chat.id)).size, 4);
    checks.push('overlapping_roots_deduplicated', 'shared_descendants_before_both_parents');
    assert.deepEqual((await plan([grandchild, parent])).items.map(chat => chat.id), [grandchild.id, child.id, parent.id]);
    checks.push('selected_leaf_before_ancestor_remains_leaf_first');
    const only = await page.evaluate(chats => window.__codexNestedCascade.planMany(chats, 'archive', false), [parent, child, parent]);
    assert.deepEqual(only.items.map(chat => chat.id), [child.id, parent.id]);
    checks.push('selected_only_exact_unique_roots_still_descendants_first');
    for (const unsupported of [chat(99, 'Unknown'), { ...parent, kind: 'chatgpt' }, { ...parent, hostId: 'remote' }, { ...parent, id: 'bad' }]) {
      assert.equal(await rejects([unsupported]), true);
    }
    checks.push('unknown_cloud_remote_invalid_rejected');
    await page.evaluate(({ parent, grandchild }) => window.__codexNestedRelations.groups.push({ parent: grandchild, children: [parent] }), { parent, grandchild });
    assert.equal(await rejects([parent]), true);
    checks.push('cycle_rejected_before_submission');
    await reset();
    await page.evaluate(() => {
      const many = Array.from({ length: 257 }, (_, n) => ({
        id: `00000000-0000-0000-0000-${String(n + 100).padStart(12, '0')}`, title: `Many ${n}`, kind: 'codex', hostId: 'local'
      }));
      window.__codexNestedRelations = { schemaVersion: 1, catalog: many, groups: [{ parent: many[0], children: many.slice(1) }] };
    });
    assert.equal(await rejects([chat(100, 'Many 0')]), true);
    await page.evaluate(() => {
      window.__codexNestedRelations.groups[0].children.pop();
      window.__codexNestedRelations.catalog.pop();
    });
    assert.equal((await plan([chat(100, 'Many 0')])).items.length, 256);
    checks.push('max_scope_257_rejected_256_allowed');

    await reset();
    await preview([parent, otherParent, child]);
    assert.deepEqual(await submitted(), []);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await inspect()).state, 'cancelled');
    assert.deepEqual(await submitted(), []);
    assert.deepEqual(await page.evaluate(() => window.fixture.begin), []);
    checks.push('batch_cancel_zero_submissions_and_no_archive_lease');

    await preview([parent, otherParent, child]);
    await submit(4); await waitState('completed');
    assert.deepEqual(await submitted(), [grandchild.id, child.id, parent.id, otherParent.id]);
    assert.deepEqual((await inspect()).verified, [grandchild.id, child.id, parent.id, otherParent.id]);
    assert.deepEqual(await page.evaluate(() => window.fixture.begin[0].ids), [grandchild.id, child.id, parent.id, otherParent.id]);
    assert.equal(await page.evaluate(() => window.fixture.end), 1);
    checks.push('real_executor_submits_native_menus_in_plan_order', 'each_native_commit_verified', 'batch_archive_lease_released');

    await reset(); await preview([solo]);
    assert.equal((await inspect()).previewOpen, true);
    await submit(1); await waitState('completed');
    assert.deepEqual(await submitted(), [solo.id]);
    checks.push('standalone_single_chat_supported');

    await reset(); await preview([solo]);
    await page.evaluate(id => { window.__codexNestedRelations.catalog = window.__codexNestedRelations.catalog.filter(chat => chat.id !== id); }, solo.id);
    await submit(1); await waitState('plan_changed');
    assert.deepEqual(await submitted(), []);
    checks.push('removed_catalog_root_blocks_confirmation');

    await reset(); await preview([parent]);
    await page.evaluate(id => { window.__codexNestedRelations.catalog.find(chat => chat.id === id).title = 'Renamed after preview'; }, parent.id);
    await submit(3); await waitState('plan_changed');
    assert.deepEqual(await submitted(), []);
    checks.push('renamed_catalog_root_blocks_confirmation');

    await reset(); await preview([parent]);
    await page.evaluate(() => { window.__codexNestedRelations.groups[0].children = []; });
    await submit(3); await waitState('plan_changed');
    assert.deepEqual(await submitted(), []);
    checks.push('changed_relationship_scope_blocks_confirmation');

    await reset(); await preview([parent]);
    await page.evaluate(id => { window.__codexNestedRelations.catalog = window.__codexNestedRelations.catalog.filter(chat => chat.id !== id); }, child.id);
    await submit(3); await waitState('plan_changed');
    assert.deepEqual(await submitted(), []);
    checks.push('catalog_removed_descendant_cannot_reenter_through_stale_group');

    // Keep the displayed manifest frozen, as production does during review.
    // Only the separate action-time reader sees these concurrent DB changes.
    await reset(); await preview([parent]);
    await page.evaluate(parentId => {
      const fresh = structuredClone(window.__codexNestedRelations);
      const newChild = { id: '00000000-0000-0000-0000-000000000006', title: 'New concurrent child', kind: 'codex', hostId: 'local' };
      fresh.catalog.push(newChild); fresh.groups.find(group => group.parent.id === parentId).children.push(newChild);
      window.fixture.snapshot = fresh;
    }, parent.id);
    await submit(3); await waitState('stopped_after_error');
    assert.deepEqual(await submitted(), []);
    assert.equal(await page.evaluate(() => window.fixture.validationCalls), 1);
    assert.equal(await page.evaluate(() => window.fixture.end), 1);
    assert.equal(await page.evaluate(() => window.__codexNestedRelations.catalog.length), 5);
    checks.push('fresh_db_new_descendant_blocks_frozen_page_scope');

    await reset(); await preview([parent]);
    await page.evaluate(parentId => {
      const fresh = structuredClone(window.__codexNestedRelations);
      fresh.catalog.find(chat => chat.id === parentId).title = 'Concurrent DB rename'; window.fixture.snapshot = fresh;
    }, parent.id);
    await submit(3); await waitState('stopped_after_error'); assert.deepEqual(await submitted(), []);
    checks.push('fresh_db_rename_blocks_frozen_page_scope');

    await reset(); await preview([parent]);
    await page.evaluate(childId => {
      const fresh = structuredClone(window.__codexNestedRelations);
      fresh.catalog = fresh.catalog.filter(chat => chat.id !== childId); window.fixture.snapshot = fresh;
    }, child.id);
    await submit(3); await waitState('stopped_after_error'); assert.deepEqual(await submitted(), []);
    checks.push('fresh_db_removed_descendant_blocks_frozen_page_scope');

    await reset(); await preview([parent]);
    await page.evaluate(() => window.fixture.validationMode = 'throw');
    await submit(3); await waitState('stopped_after_error'); assert.deepEqual(await submitted(), []);
    assert.equal(await page.evaluate(() => window.fixture.end), 1);
    checks.push('fresh_reader_error_stops_before_native_mutation');

    await reset(); await preview([parent]);
    await page.evaluate(() => window.fixture.validationMode = 'invalid');
    await submit(3); await waitState('stopped_after_error'); assert.deepEqual(await submitted(), []);
    checks.push('invalid_fresh_snapshot_stops_before_native_mutation');

    await reset();
    await page.evaluate(() => { delete window.__codexNestedValidateArchive; });
    await preview([parent]);
    assert.equal(await page.getByRole('button', { name: '归档全部 3 个', exact: true }).isDisabled(), true);
    assert.deepEqual(await submitted(), []);
    assert.deepEqual(await page.evaluate(() => window.fixture.begin), []);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    checks.push('required_fresh_reader_missing_disables_archive');

    await reset(); await preview([parent]);
    await page.evaluate(() => {
      window.fixture.validationMode = 'hang';
      window.fixture.originalTimeout = window.setTimeout;
      window.setTimeout = function (callback, milliseconds, ...args) {
        return Reflect.apply(window.fixture.originalTimeout, window, [callback, milliseconds === 17000 ? 30 : milliseconds, ...args]);
      };
    });
    const hangStarted = Date.now();
    await submit(3); await waitState('stopped_after_error');
    await page.evaluate(() => { window.setTimeout = window.fixture.originalTimeout; });
    assert.ok(Date.now() - hangStarted < 3000, 'The synthetic clock should shorten only the 17-second action watchdog');
    assert.deepEqual(await submitted(), []);
    assert.equal(await page.evaluate(() => window.fixture.end), 1);
    assert.match((await inspect()).error, /timed out/);
    checks.push('hung_fresh_reader_bounded_before_native_mutation_and_lease_released');

    await reset(); await preview([parent, otherParent, solo]);
    await page.evaluate(() => window.fixture.wrongOwner = true);
    await submit(5); await waitState('stopped_after_error');
    assert.deepEqual(await submitted(), []);
    assert.deepEqual((await inspect()).verified, []);
    assert.equal(await page.evaluate(() => window.fixture.end), 1);
    checks.push('wrong_menu_owner_stops_without_any_submission');

    await reset(); await preview([parent, otherParent, solo]);
    await page.evaluate(id => window.fixture.failOn = id, child.id);
    await submit(5); await waitState('stopped_after_error');
    assert.deepEqual(await submitted(), [grandchild.id]);
    assert.deepEqual((await inspect()).verified, [grandchild.id]);
    checks.push('partial_native_failure_preserves_remaining_parents_and_solo');

    await reset(); await preview([parent, otherParent, solo]);
    await page.evaluate(() => window.fixture.statusError = true);
    await submit(5); await waitState('stopped_after_error');
    assert.deepEqual(await submitted(), [grandchild.id]);
    assert.deepEqual((await inspect()).verified, []);
    checks.push('commit_reader_failure_stops_before_next_chat');
    await page.evaluate(() => window.__codexNestedCascade.dispose());
    assert.equal(await page.locator('[data-codex-nested-cascade-owned]').count(), 0);
    checks.push('dispose_removes_batch_ui');

    // Actual bulk -> scope UI handoff must keep the host interaction lease
    // while the native close-menu bridge is asynchronous.
    await reset();
    const bulkSource = await fs.readFile(path.join(__dirname, '../src/bulk-archive.js'), 'utf8');
    const eventSource = await fs.readFile(path.join(__dirname, '../src/host-events.js'), 'utf8');
    await page.evaluate(() => {
      window.fixture.notifications = [];
      window.__codexNestedNotify = async payload => { window.fixture.notifications.push(payload); };
      const original = window.__codexNestedRuntime.closeNativeMenu;
      window.__codexNestedRuntime.closeNativeMenu = async () => {
        if (window.fixture.holdClose) await new Promise(resolve => { window.fixture.releaseClose = resolve; });
        return original();
      };
    });
    await page.evaluate(bulkSource); await page.evaluate(eventSource);
    await page.getByRole('button', { name: '批量归档聊天', exact: true }).click();
    await page.locator(`[data-codex-bulk-chat-id="${parent.id}"]`).check();
    await page.evaluate(() => { window.fixture.notifications = []; window.fixture.holdClose = true; });
    await page.getByRole('button', { name: '归档所选 1 个', exact: true }).click();
    await page.waitForFunction(() => window.fixture.releaseClose);
    assert.equal(await page.evaluate(() => window.__codexNestedBulk.inspect().previewPending), true);
    const pendingDialog=page.getByRole('dialog',{name:'批量归档聊天',exact:true});
    assert.equal(await pendingDialog.isVisible(),true);
    assert.equal(await pendingDialog.getByRole('button',{name:'正在核对归档范围…'}).isDisabled(),true);
    const duringHandoff = await page.evaluate(() => window.fixture.notifications.filter(event => event.reason === 'interaction'));
    assert.ok(duringHandoff.length > 0, 'Host must publish the pending interaction lease');
    assert.ok(duringHandoff.every(event => event.busy || event.dialogOpen || event.previewOpen || event.menuOpen),
      'Bulk-to-cascade handoff must never announce an idle UI');
    await page.evaluate(() => { window.fixture.holdClose = false; window.fixture.releaseClose(); });
    await page.getByRole('dialog', { name: '批量归档范围', exact: true }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.deepEqual(await submitted(), []);
    await page.getByRole('button', { name: '批量归档聊天', exact: true }).click();
    assert.equal(await page.locator(`[data-codex-bulk-chat-id="${parent.id}"]`).isChecked(), true);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(() => { window.__codexNestedHostEvents.dispose(); window.__codexNestedBulk.dispose(); window.__codexNestedCascade.dispose(); });
    checks.push('asynchronous_bulk_to_scope_handoff_preserves_host_lease', 'actual_scope_cancel_preserves_bulk_selection');
    console.log(JSON.stringify({ passed: true, checks }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
