'use strict';
// Isolated HTML fixture only. Never connects to or launches official Codex.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ids = { p:'00000000-0000-0000-0000-000000000001', c:'00000000-0000-0000-0000-000000000002',
  g:'00000000-0000-0000-0000-000000000003', other:'00000000-0000-0000-0000-000000000004' };
const chat = id => ({ id, title:'Repeated title', kind:'codex', hostId:'local' });
const row = (key, selected = false) => `<div id="row-${key}" tabindex="0" data-app-action-sidebar-thread-row
  data-app-action-sidebar-thread-id="local:${ids[key]}" data-app-action-sidebar-thread-kind="local"
  data-app-action-sidebar-thread-host-id="local" data-app-action-sidebar-thread-selected="${selected}">
  <span>Repeated title</span><button>More</button></div>`;
(async () => {
  const browser = await chromium.launch({ headless:true, channel:'msedge' });
  try {
    const page = await browser.newPage();
    await page.setContent(`<html><head></head><body tabindex="-1"><div id="app-shell-sidebar">
      <section id="visible-mode">${row('p', true)}${row('c')}${row('g')}${row('other')}
      <div class="cnv-child-line"><button id="proxy" data-codex-nested-chat-id="${ids.c}"><span>Repeated title</span></button><button id="proxy-more">More</button></div></section>
      <section id="cached-mode" style="display:none!important">${row('c', true).replace('id="row-c"','id="cached-c"')}</section>
      </div><input id="input"><textarea id="textarea"></textarea><div id="editor" contenteditable="true"><span id="editor-child">draft</span></div>
      <div class="monaco-editor"><div id="monaco" tabindex="0"></div></div><div class="cm-editor"><div id="codemirror" tabindex="0"></div></div>
      <section data-codex-composer><div id="composer" role="textbox" contenteditable="true" tabindex="0" style="min-height:24px"></div></section>
      <div id="current-pane" tabindex="0" style="min-height:24px"></div>
      <section id="annotation-carriers"></section></body></html>`);
    await page.evaluate(({ ids, parent, child, grandchild }) => {
      window.__codexNestedRelations = { groups:[{ parent, children:[child] }, { parent:child, children:[grandchild] }] };
      window.fixture = { nativeDelivered:0, keyDelivered:0, submitted:[], owner:null,
        originalDispatchEvent:window.dispatchEvent };
      // Deliberately registered first. Interception must happen before dispatch.
      window.addEventListener('message', event => {
        if (event.data?.type === 'archive-thread') window.fixture.nativeDelivered++;
      });
      window.addEventListener('keydown', event => {
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') window.fixture.keyDelivered++;
      });
      window.__codexNestedRuntime = {
        async closeNativeMenu() { document.querySelector('[data-fixture-menu]')?.remove(); window.fixture.owner = null; },
        async openNativeMenu(chat, anchor) {
          await new Promise(resolve => setTimeout(resolve, 80));
          const menu = document.createElement('div'); menu.role = 'menu'; menu.dataset.fixtureMenu = '';
          const item = document.createElement('button'); item.role = 'menuitem'; item.textContent = '归档 Ctrl+Shift+A';
          item.onclick = () => { window.fixture.submitted.push(chat.id); menu.remove(); };
          menu.append(item); document.body.append(menu); window.fixture.owner = { ...chat, anchor, menuElement:menu };
          return { opened:true };
        },
        getMenuContext() { return window.fixture.owner; }
      };
    }, { ids, parent:chat(ids.p), child:chat(ids.c), grandchild:chat(ids.g) });
    await page.evaluate(await fs.readFile(path.join(__dirname, '../src/cascade-actions.js'), 'utf8'));
    const inspect = () => page.evaluate(() => window.__codexNestedCascade.inspect());
    const native = (source = 'native_accelerator', origin = '', foreign = false) => page.evaluate(({ source, origin, foreign }) => {
      const event = new MessageEvent('message', { data:{ type:'archive-thread', source }, origin,
        source:foreign ? window : null, cancelable:true });
      window.dispatchEvent(event); return event.defaultPrevented;
    }, { source, origin, foreign });
    const cancel = async () => {
      await page.getByRole('button', { name:'取消', exact:true }).click();
      assert.equal((await inspect()).dialogOpen, false);
    };
    const preview = async (expectedId, count) => {
      await page.getByRole('dialog', { name:'归档范围', exact:true }).waitFor();
      assert.equal((await inspect()).parentId, expectedId);
      assert.equal((await inspect()).planned.length, count);
      assert.deepEqual(await page.evaluate(() => window.fixture.submitted), []);
    };
    const carriers = values => page.evaluate(values => {
      const host = document.querySelector('#annotation-carriers'); host.replaceChildren();
      for (const value of values) {
        const node = document.createElement('div');
        node.setAttribute('data-response-annotation-conversation', value.id);
        node.style.minHeight = '1px'; if (value.hidden) node.hidden = true;
        host.append(node);
      }
    }, values);
    // DOM keydown and the native host message may arrive in the same turn.
    await page.locator('#row-p').focus();
    await page.evaluate(() => {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key:'A', ctrlKey:true, shiftKey:true, bubbles:true, cancelable:true }));
      window.dispatchEvent(new MessageEvent('message', { data:{ type:'archive-thread', source:'native_accelerator' } }));
    });
    await preview(ids.p, 3);
    assert.equal((await inspect()).shortcut.intercepted, 1);
    assert.equal((await inspect()).shortcut.duplicates, 1);
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), 0);
    assert.equal(await page.evaluate(() => window.fixture.keyDelivered), 0);
    assert.equal(await page.getByRole('dialog', { name:'归档范围', exact:true }).count(), 1);
    await cancel();
    // Focused native child wins over a different selected parent; titles repeat.
    await page.locator('#row-c button').focus(); assert.equal(await native(), true);
    await preview(ids.c, 2); await cancel();
    // Both the nested open button and its adjacent More button identify the child.
    for (const selector of ['#proxy', '#proxy-more']) {
      await page.locator(selector).focus(); assert.equal(await native(), true);
      await preview(ids.c, 2); await cancel();
    }
    // Inputs, rich-text editors, Monaco, and CodeMirror never fall through to
    // the native accelerator; doing so would archive the current chat once.
    const beforeEditable = await page.evaluate(() => window.fixture.nativeDelivered);
    for (const selector of ['#input', '#textarea', '#editor', '#monaco', '#codemirror']) {
      await page.locator(selector).focus(); assert.equal(await native(), true);
      await page.keyboard.press('Control+Shift+A'); assert.equal((await inspect()).dialogOpen, false);
    }
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), beforeEditable);
    assert.equal((await inspect()).shortcut.blockedEditable, 10);
    // Opening a chat normally moves focus into the native composer. Its
    // response annotation identifies the current chat without reading text.
    await carriers([{ id:ids.p }]); await page.locator('#composer').focus();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'composer');
    assert.equal(await native(), true); await preview(ids.p, 3); await cancel();
    await carriers([{ id:ids.c }]); await page.locator('#composer').focus();
    assert.equal(await native(), true); await preview(ids.c, 2); await cancel();
    // Multiple visible response annotations may repeat the same chat ID.
    await carriers([{ id:ids.p }, { id:ids.p }, { id:ids.c, hidden:true }]);
    await page.locator('#composer').focus(); await page.keyboard.press('Control+Shift+A');
    await preview(ids.p, 3); await cancel();
    // Conflicting, missing, malformed, or out-of-graph carriers cannot fall
    // back to the selected sidebar parent while the composer owns focus.
    for (const values of [[{ id:ids.p }, { id:ids.c }], [], [{ id:'not-a-uuid' }], [{ id:ids.other }]]) {
      await carriers(values); await page.locator('#composer').focus();
      const before = await page.evaluate(() => window.fixture.nativeDelivered);
      assert.equal(await native(), true); await page.keyboard.press('Control+Shift+A');
      assert.equal((await inspect()).dialogOpen, false);
      assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), before);
    }
    // A valid carrier does not relax other editing surfaces or confirmations.
    await carriers([{ id:ids.p }]);
    for (const selector of ['#input', '#editor', '#monaco']) {
      await page.locator(selector).focus(); assert.equal(await native(), true);
      assert.equal((await inspect()).dialogOpen, false);
    }
    await page.evaluate(() => {
      const dialog = document.createElement('div'); dialog.id = 'native-confirmation';
      dialog.setAttribute('role', 'alertdialog'); dialog.textContent = 'Confirm'; document.body.append(dialog);
    });
    await page.locator('#composer').focus(); assert.equal(await native(), true);
    assert.equal((await inspect()).dialogOpen, false);
    await page.locator('#native-confirmation').evaluate(node => node.remove());
    // A safely identified current leaf preserves the native shortcut even
    // though the sidebar still selects a different parent with descendants.
    await carriers([{ id:ids.g }]); await page.locator('#composer').focus();
    const beforeComposerLeaf = await page.evaluate(() => ({ native:window.fixture.nativeDelivered, key:window.fixture.keyDelivered }));
    assert.equal(await native(), false); await page.keyboard.press('Control+Shift+A');
    assert.equal((await inspect()).dialogOpen, false);
    assert.deepEqual(await page.evaluate(() => ({ native:window.fixture.nativeDelivered, key:window.fixture.keyDelivered })),
      { native:beforeComposerLeaf.native + 1, key:beforeComposerLeaf.key + 1 });
    await carriers([]);
    // A single leaf keeps the original command, including its native delivery.
    await page.locator('#row-g').focus();
    let delivered = await page.evaluate(() => window.fixture.nativeDelivered);
    assert.equal(await native(), false); await page.keyboard.press('Control+Shift+A');
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered + 1);
    assert.equal((await inspect()).dialogOpen, false);
    // Fallback uses only a unique visible selected native identity. Cached
    // selected rows from an inactive mode cannot alter the scope.
    await page.locator('body').focus(); assert.equal(await native(), true);
    await preview(ids.p, 3); await cancel();
    await page.locator('#row-c').evaluate(node => node.setAttribute('data-app-action-sidebar-thread-selected', 'true'));
    await page.locator('body').focus(); assert.equal(await native(), false);
    assert.equal((await inspect()).dialogOpen, false);
    await page.locator('#row-c').evaluate(node => node.setAttribute('data-app-action-sidebar-thread-selected', 'false'));
    // Clicking the current pane often leaves focus on body while this extension
    // hides the selected native child row. Resolve only the current annotation.
    await page.locator('#row-p').evaluate(node => node.hidden = true);
    await carriers([{ id:ids.p }]); await page.locator('body').focus();
    assert.equal(await native(), true); await preview(ids.p, 3); await cancel();
    await carriers([{ id:ids.c }]); await page.locator('#current-pane').focus();
    assert.equal(await native(), true); await preview(ids.c, 2); await cancel();
    await carriers([{ id:ids.g }]); await page.locator('#current-pane').focus();
    delivered = await page.evaluate(() => window.fixture.nativeDelivered);
    assert.equal(await native(), false);
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered + 1);
    assert.equal((await inspect()).dialogOpen, false);
    await carriers([{ id:ids.p }, { id:ids.c }]); await page.locator('body').focus();
    delivered = await page.evaluate(() => window.fixture.nativeDelivered);
    assert.equal(await native(), true);
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered);
    assert.equal((await inspect()).dialogOpen, false);
    await page.locator('#row-p').evaluate(node => node.hidden = false);
    // A visible selection still takes precedence over the current-pane fallback.
    await carriers([{ id:ids.c }]); await page.locator('body').focus();
    assert.equal(await native(), true); await preview(ids.p, 3); await cancel();
    await carriers([{ id:ids.p }]);
    // Unsupported focused identities do not fall back to the selected parent.
    for (const [attribute, value, original] of [
      ['data-app-action-sidebar-thread-kind', 'remote', 'local'],
      ['data-app-action-sidebar-thread-host-id', 'remote-host', 'local'],
      ['data-app-action-sidebar-thread-id', 'local:invalid', `local:${ids.c}`]
    ]) {
      await page.locator('#row-c').evaluate((node, { attribute, value }) => node.setAttribute(attribute, value), { attribute, value });
      await page.locator('#row-c').focus(); assert.equal(await native(), false);
      assert.equal((await inspect()).dialogOpen, false);
      await page.locator('#row-c').evaluate((node, { attribute, original }) => node.setAttribute(attribute, original), { attribute, original });
    }
    await carriers([]);
    await page.locator('#visible-mode').evaluate(node => node.style.display = 'none');
    await page.locator('body').focus(); assert.equal(await native(), false);
    assert.equal((await inspect()).dialogOpen, false);
    await page.locator('#visible-mode').evaluate(node => node.style.display = '');
    // Only the inspected native accelerator message shape is consumed.
    await page.locator('#row-p').focus();
    assert.equal(await native('slash_command'), false);
    assert.equal(await native('native_accelerator', 'https://example.invalid'), false);
    assert.equal(await native('native_accelerator', '', true), false);
    assert.equal((await inspect()).dialogOpen, false);
    // The removed alternative must be untouched on every focus route, including
    // ordinary editors that the supported archive shortcut intentionally guards.
    for (const selector of ['#row-p', '#row-g', '#composer', '#input', 'body']) {
      await page.locator(selector).focus();
      const before = await page.evaluate(() => ({ delivered:window.fixture.keyDelivered,
        inspected:window.__codexNestedCascade.inspect().shortcut.keydowns }));
      assert.equal(await page.evaluate(() => {
        const event = new KeyboardEvent('keydown', { key:'A', ctrlKey:true, shiftKey:true,
          altKey:true, bubbles:true, cancelable:true });
        document.activeElement.dispatchEvent(event); return event.defaultPrevented;
      }), false);
      assert.equal(await page.evaluate(() => window.fixture.keyDelivered), before.delivered + 1);
      assert.equal((await inspect()).shortcut.keydowns, before.inspected);
      assert.equal((await inspect()).dialogOpen, false);
    }
    assert.equal((await inspect()).dialogOpen, false);
    assert.deepEqual(await page.evaluate(() => {
      const event = new Event('fixture-pass-through', { cancelable:true }); let same = false;
      window.addEventListener('fixture-pass-through', received => { same = received === event; received.preventDefault(); }, { once:true });
      return { result:window.dispatchEvent(event), same };
    }), { result:false, same:true });
    // Real browser isolated worlds have distinct dispatchEvent properties.
    // Exercise the preload relay through CDP instead of approximating it in
    // the default world. The fixture's original listener is still present.
    const cdp = await page.context().newCDPSession(page);
    const tree = await cdp.send('Page.getFrameTree');
    const isolated = await cdp.send('Page.createIsolatedWorld', {
      frameId:tree.frameTree.frame.id, worldName:'fixture-codex-preload'
    });
    const inPreload = async expression => {
      const result = await cdp.send('Runtime.evaluate', { contextId:isolated.executionContextId,
        expression, returnByValue:true });
      assert.equal(result.exceptionDetails, undefined);
      return result.result.value;
    };
    const isolatedNative = (source = 'native_accelerator') => inPreload(
      `window.dispatchEvent(new MessageEvent('message',{data:{type:'archive-thread',source:${JSON.stringify(source)}}}))`);
    delivered = await page.evaluate(() => window.fixture.nativeDelivered);
    const beforeRaw = (await inspect()).shortcut.nativeMessages;
    await isolatedNative();
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered + 1);
    assert.equal((await inspect()).shortcut.nativeMessages, beforeRaw);
    await inPreload(`(() => {
      const original = window.dispatchEvent;
      function relay(event, ...args) {
        if (this === window && event?.type === 'message' && event.data?.type === 'archive-thread' &&
            event.data?.source === 'native_accelerator' && event.source == null && event.origin === '') {
          const request = new CustomEvent('codex-nested:archive-request', {
            cancelable:true, detail:{version:1,source:'native_accelerator'}
          });
          if (!Reflect.apply(original, window, [request])) return !event.defaultPrevented;
        }
        return Reflect.apply(original, this, [event, ...args]);
      }
      window.dispatchEvent = relay;
      window.__fixtureRestoreRelay = () => {
        if (window.dispatchEvent === relay) window.dispatchEvent = original;
        return window.dispatchEvent === original;
      };
    })()`);
    await page.locator('#row-p').focus(); delivered = await page.evaluate(() => window.fixture.nativeDelivered);
    await isolatedNative(); await preview(ids.p, 3);
    assert.equal((await inspect()).shortcut.relaySignals, 1);
    assert.equal((await inspect()).shortcut.lastSource, 'native_accelerator_relay');
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered);
    await isolatedNative(); assert.equal(await page.getByRole('dialog', { name:'归档范围', exact:true }).count(), 1);
    await cancel();
    await carriers([{ id:ids.p }]); await page.locator('#composer').focus();
    await isolatedNative(); await preview(ids.p, 3); await cancel();
    await carriers([{ id:ids.g }]); await page.locator('#composer').focus();
    await isolatedNative();
    assert.equal((await inspect()).dialogOpen, false);
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered + 1);
    await carriers([{ id:ids.p }, { id:ids.c }]); await page.locator('#composer').focus();
    await isolatedNative();
    assert.equal((await inspect()).dialogOpen, false);
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered + 1);
    await carriers([]); delivered = await page.evaluate(() => window.fixture.nativeDelivered);
    await page.locator('#input').focus(); await isolatedNative();
    assert.equal((await inspect()).dialogOpen, false);
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered);
    await page.locator('#row-g').focus(); await isolatedNative();
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered + 1);
    const beforeNonTargetRelay = (await inspect()).shortcut.relaySignals;
    await isolatedNative('slash_command');
    assert.equal((await inspect()).shortcut.relaySignals, beforeNonTargetRelay);
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered + 2);
    await page.locator('#row-p').focus();
    await page.keyboard.press('Control+Shift+A'); await isolatedNative(); await preview(ids.p, 3); await cancel();
    // No plan is cached: a newly created nesting is picked up immediately.
    await page.locator('#row-other').focus(); assert.equal(await native(), false);
    await page.evaluate(({ parent, child }) => window.__codexNestedRelations.groups.push({ parent, children:[child] }),
      { parent:chat(ids.other), child:chat(ids.p) });
    assert.equal(await native(), true); await preview(ids.other, 4); await cancel();
    // While execution is in flight, a second native accelerator cannot escape
    // to the original current-chat handler or start another cascade.
    await page.evaluate(() => {
      window.__codexNestedCascadeOptions = { enableArchiveExecution:true };
      window.__codexNestedArchiveStatus = async chat => ({ archived:window.fixture.submitted.includes(chat.id) });
    });
    await page.locator('#row-c').focus(); assert.equal(await native(), true); await preview(ids.c, 2);
    await page.getByRole('button', { name:'归档全部 2 个', exact:true }).click();
    await page.waitForFunction(() => window.__codexNestedCascade.inspect().busy);
    delivered = await page.evaluate(() => window.fixture.nativeDelivered);
    assert.equal(await native(), true);
    await page.waitForFunction(() => window.__codexNestedCascade.inspect().state === 'completed');
    assert.deepEqual(await page.evaluate(() => window.fixture.submitted), [ids.g, ids.c]);
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered);
    await page.getByRole('button', { name:'关闭', exact:true }).click();
    // Re-installation disposes its own previous wrapper instead of layering it.
    await page.evaluate(() => window.fixture.submitted = []);
    await page.evaluate(await fs.readFile(path.join(__dirname, '../src/cascade-actions.js'), 'utf8'));
    await page.locator('#row-p').focus(); assert.equal(await native(), true); await preview(ids.p, 3);
    assert.equal((await inspect()).shortcut.nativeMessages, 1); await cancel();
    // Disposing restores both original host delivery and original DOM keydown.
    await page.evaluate(() => window.__codexNestedCascade.dispose());
    assert.equal(await page.evaluate(() => window.dispatchEvent === window.fixture.originalDispatchEvent), true);
    await page.locator('#row-p').focus(); delivered = await page.evaluate(() => window.fixture.nativeDelivered);
    assert.equal(await native(), false);
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered + 1);
    assert.equal(await page.locator('[data-codex-nested-cascade-owned]').count(), 0);
    await isolatedNative();
    assert.equal(await page.evaluate(() => window.fixture.nativeDelivered), delivered + 2);
    assert.equal(await inPreload('window.__fixtureRestoreRelay()'), true);
    console.log(JSON.stringify({ passed:true, checks:['native_intercept_precedes_existing_listener',
      'keydown_native_deduplication','focused_native_identity_priority','focused_nested_proxy_identity',
      'editable_native_guard','leaf_preserves_original_shortcut','visible_selected_fallback','ambiguous_selection_rejected',
      'kind_host_uuid_guards','inactive_mode_rejected','exact_native_message_shape','dynamic_new_nesting',
      'composer_parent_from_public_annotation','composer_current_identity_over_sidebar_selection',
      'composer_repeated_and_hidden_carriers','composer_conflicting_unknown_and_missing_carriers_blocked',
      'composer_does_not_relax_other_editors_or_confirmations','composer_leaf_native_passthrough',
      'body_current_pane_annotation_parent','body_current_pane_leaf_passthrough','body_current_pane_conflict_blocked',
      'removed_alternate_shortcut_passthrough',
      'isolated_composer_parent_leaf_and_conflict',
      'busy_shortcut_guard','non_target_event_identity_and_result_preserved','reinstall_does_not_layer_wrappers',
      'isolated_world_requires_relay','isolated_relay_scope_and_editable_guard','isolated_leaf_and_non_target_passthrough',
      'isolated_keydown_deduplication','dispose_restores_native_delivery'] }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
