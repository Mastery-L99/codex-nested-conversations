'use strict';
// Local DOM fixture only: never connects to or launches the installed Codex.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const ids = {
  parent:'00000000-0000-0000-0000-000000000001',
  child:'00000000-0000-0000-0000-000000000002',
  unloaded:'00000000-0000-0000-0000-000000000003',
  duplicate:'00000000-0000-0000-0000-000000000004',
  unsupportedParent:'00000000-0000-0000-0000-000000000005',
  untouched:'00000000-0000-0000-0000-000000000006'
};
const chat = (id,title) => ({id,title,kind:'codex',hostId:'local'});
function row(id,title,trigger=true,extra='') {
  return `<div data-codex-tab-conversation-drop-target id="wrap-${id}"><div role="button" tabindex="0"
    data-app-action-sidebar-thread-row data-app-action-sidebar-thread-id="local:${id}"
    data-app-action-sidebar-thread-kind="local" data-app-action-sidebar-thread-host-id="local"
    data-app-action-sidebar-thread-title="${title}" data-app-action-sidebar-thread-selected="false" ${extra}>
    <div ${trigger?'data-thread-title-trigger="true"':''}><span>${title}</span></div>
    <button type="button" id="menu-${id}" aria-haspopup="menu" aria-label="聊天操作">More</button></div></div>`;
}
async function testIdentityAliases(browser, code) {
  const aliasIds={root:'00000000-0000-0000-0000-000000000101',
    child:'00000000-0000-0000-0000-000000000102',
    grandchild:'00000000-0000-0000-0000-000000000103',
    temporaryRoot:'client-new-thread:00000000-0000-0000-0000-000000000201',
    temporaryChild:'client-new-thread:00000000-0000-0000-0000-000000000202'};
  const aliasesManifest={schemaVersion:1,groups:[
    {parent:chat(aliasIds.root,'Alias root'),children:[chat(aliasIds.child,'Alias child')]},
    {parent:chat(aliasIds.child,'Alias child'),children:[chat(aliasIds.grandchild,'Alias grandchild')]}
  ]};
  const selectedRow=(id,title)=>row(id,title).replace('selected="false"','selected="true"');
  const carrier=(id,name='canonical-carrier',style='')=>
    `<div id="${name}" data-response-annotation-conversation="${id}" style="width:40px;height:20px;${style}"></div>`;
  async function createAliasPage({carriers='',extraRows=''}={}) {
    const aliasPage=await browser.newPage();
    await aliasPage.setContent(`<html><head></head><body><div id="app-shell-sidebar">
      ${selectedRow(aliasIds.temporaryRoot,'Alias root')}
      ${row(aliasIds.child,'Alias child')}${row(aliasIds.grandchild,'Alias grandchild')}${extraRows}
      </div><main>${carriers}</main></body></html>`);
    await aliasPage.evaluate(relations=>{
      window.__codexNestedRelations=relations;
      window.__codexNestedOpen=async()=>({requested:true});
      window.fixtureIdentityEvents=0;
      document.addEventListener('codex-nested:identity-mapped',()=>window.fixtureIdentityEvents++);
    },aliasesManifest);
    await aliasPage.evaluate(code);
    return aliasPage;
  }
  // The native temporary row is the root, with two descendants in the
  // manifest. No root title search may be used to invent its canonical ID.
  const mapped=await createAliasPage({carriers:carrier(aliasIds.root)});
  try {
    assert.equal((await mapped.evaluate(()=>window.__codexNestedRuntime.inspect())).groups,0);
    assert.deepEqual(await mapped.evaluate(()=>window.__codexNestedRuntime.getIdentityAliases()),[]);
    await mapped.waitForFunction(()=>window.__codexNestedRuntime.getIdentityAliases().length===1);
    const expectedAliases=[[`local:${aliasIds.temporaryRoot}`,aliasIds.root]];
    assert.deepEqual(await mapped.evaluate(()=>window.__codexNestedRuntime.getIdentityAliases()),expectedAliases);
    assert.equal(await mapped.evaluate(()=>window.fixtureIdentityEvents),1);
    assert.equal(await mapped.evaluate(id=>window.__codexNestedRuntime.getCanonicalChatId(
      document.querySelector(`[data-app-action-sidebar-thread-id="local:${id}"]`)),aliasIds.temporaryRoot),aliasIds.root);
    let state=await mapped.evaluate(()=>window.__codexNestedRuntime.inspect());
    assert.equal(state.groups,1); assert.equal(state.childItems,2); assert.equal(state.hiddenFlatRows,2);
    assert.equal(await mapped.locator(`[data-codex-nested-parent-id="${aliasIds.root}"]`).count(),1);
    assert.equal(await mapped.locator(`.cnv-deeper [data-codex-nested-chat-id="${aliasIds.grandchild}"]`).count(),1);
    assert.equal(await mapped.locator(`[data-app-action-sidebar-thread-id="local:${aliasIds.temporaryRoot}"]`).count(),1);
    // Native identity replacement must retain the complete three-level tree.
    await mapped.evaluate(({temporaryRoot,root})=>document.querySelector(
      `[data-app-action-sidebar-thread-id="local:${temporaryRoot}"]`).setAttribute('data-app-action-sidebar-thread-id',`local:${root}`),aliasIds);
    await mapped.waitForTimeout(130);
    state=await mapped.evaluate(()=>window.__codexNestedRuntime.inspect());
    assert.equal(state.groups,1); assert.equal(state.childItems,2);
    assert.equal(await mapped.evaluate(id=>window.__codexNestedRuntime.getCanonicalChatId(
      document.querySelector(`[data-app-action-sidebar-thread-id="local:${id}"]`)),aliasIds.root),aliasIds.root);
    // A hot reload retains the already established mapping without a carrier.
    await mapped.evaluate(({temporaryRoot,root})=>{
      document.querySelector('#canonical-carrier').remove();
      document.querySelector(`[data-app-action-sidebar-thread-id="local:${root}"]`)
        .setAttribute('data-app-action-sidebar-thread-id',`local:${temporaryRoot}`);
    },aliasIds);
    await mapped.evaluate(code);
    assert.deepEqual(await mapped.evaluate(()=>window.__codexNestedRuntime.getIdentityAliases()),expectedAliases);
    assert.equal((await mapped.evaluate(()=>window.__codexNestedRuntime.inspect())).childItems,2);
    // Explicit runtime restoration uses the same validated aliases as reload.
    await mapped.evaluate(()=>{
      window.__codexNestedIdentityAliases=window.__codexNestedRuntime.getIdentityAliases();
      window.__codexNestedRuntime.dispose(); delete window.__codexNestedRuntime;
    });
    await mapped.evaluate(code);
    assert.deepEqual(await mapped.evaluate(()=>window.__codexNestedRuntime.getIdentityAliases()),expectedAliases);
    assert.equal((await mapped.evaluate(()=>window.__codexNestedRuntime.inspect())).childItems,2);
  } finally {await mapped.close();}

  const noCarrier=await createAliasPage();
  try {
    await noCarrier.waitForTimeout(430);
    assert.deepEqual(await noCarrier.evaluate(()=>window.__codexNestedRuntime.getIdentityAliases()),[]);
    assert.equal(await noCarrier.evaluate(id=>window.__codexNestedRuntime.getCanonicalChatId(
      document.querySelector(`[data-app-action-sidebar-thread-id="local:${id}"]`)),aliasIds.temporaryRoot),null);
    assert.equal((await noCarrier.evaluate(()=>window.__codexNestedRuntime.inspect())).groups,0);
  } finally {await noCarrier.close();}

  const conflict=await createAliasPage({carriers:carrier(aliasIds.root)+carrier(aliasIds.child,'other-pane')});
  try {
    await conflict.waitForTimeout(430);
    assert.deepEqual(await conflict.evaluate(()=>window.__codexNestedRuntime.getIdentityAliases()),[]);
    assert.equal((await conflict.evaluate(()=>window.__codexNestedRuntime.inspect())).groups,0);
    assert.equal(await conflict.evaluate(()=>window.fixtureIdentityEvents),0);
  } finally {await conflict.close();}

  const hiddenCarrier=await createAliasPage({carriers:carrier(aliasIds.root,'canonical-carrier','display:none;')});
  try {
    await hiddenCarrier.waitForTimeout(430);
    assert.deepEqual(await hiddenCarrier.evaluate(()=>window.__codexNestedRuntime.getIdentityAliases()),[]);
  } finally {await hiddenCarrier.close();}

  const switching=await createAliasPage({carriers:carrier(aliasIds.root),
    extraRows:row(aliasIds.temporaryChild,'Alias child')});
  try {
    // Switch carrier and selected row through short-lived render states. Each
    // apparent match lasts less than 200ms and must never become an alias.
    await switching.waitForTimeout(70);
    await switching.evaluate(({root,child,temporaryRoot,temporaryChild})=>{
      document.querySelector('#canonical-carrier').setAttribute('data-response-annotation-conversation',child);
      document.querySelector(`[data-app-action-sidebar-thread-id="local:${temporaryRoot}"]`)
        .setAttribute('data-app-action-sidebar-thread-selected','false');
      document.querySelector(`[data-app-action-sidebar-thread-id="local:${temporaryChild}"]`)
        .setAttribute('data-app-action-sidebar-thread-selected','true');
    },aliasIds);
    await switching.waitForTimeout(100);
    await switching.evaluate(({temporaryChild})=>{
      document.querySelector('#canonical-carrier').remove();
      document.querySelector(`[data-app-action-sidebar-thread-id="local:${temporaryChild}"]`)
        .setAttribute('data-app-action-sidebar-thread-selected','false');
    },aliasIds);
    await switching.waitForTimeout(360);
    assert.deepEqual(await switching.evaluate(()=>window.__codexNestedRuntime.getIdentityAliases()),[]);
    assert.equal(await switching.evaluate(()=>window.fixtureIdentityEvents),0);
    // Returning to a genuinely stable match still learns normally.
    await switching.evaluate(({root,temporaryRoot})=>{
      const element=document.createElement('div'); element.id='canonical-carrier';
      element.setAttribute('data-response-annotation-conversation',root);
      element.style.cssText='width:40px;height:20px'; document.querySelector('main').append(element);
      document.querySelector(`[data-app-action-sidebar-thread-id="local:${temporaryRoot}"]`)
        .setAttribute('data-app-action-sidebar-thread-selected','true');
    },aliasIds);
    await switching.waitForFunction(()=>window.__codexNestedRuntime.getIdentityAliases().length===1);
    assert.deepEqual(await switching.evaluate(()=>window.__codexNestedRuntime.getIdentityAliases()),
      [[`local:${aliasIds.temporaryRoot}`,aliasIds.root]]);
    assert.equal((await switching.evaluate(()=>window.__codexNestedRuntime.inspect())).childItems,2);
  } finally {await switching.close();}
  return ['temporary_root_maps_after_stable_canonical_carrier','temporary_root_shows_three_levels',
    'native_canonical_identity_replacement_keeps_tree','same_title_without_carrier_never_guesses',
    'conflicting_visible_panes_never_learn','hidden_carrier_not_identity_evidence',
    'transient_selection_switch_never_learns','hot_reload_retains_identity_aliases',
    'validated_boot_identity_aliases_restore_tree'];
}
(async()=>{
  const browser = await chromium.launch({headless:true,channel:'msedge'});
  try {
    const page = await browser.newPage();
    await page.setContent(`<html><head></head><body><div id="app-shell-sidebar">
      <section id="active-mode">
      ${row(ids.parent,'Parent')}${row(ids.child,'Child')}${row(ids.duplicate,'Child')}
      ${row(ids.unsupportedParent,'Unsupported',false)}${row(ids.untouched,'Untouched')}
      </section><section id="cached-mode" style="display:none!important">
      ${row(ids.parent,'Parent').replace('id="wrap-','id="cached-wrap-').replace('id="menu-','id="cached-menu-')}
      ${row(ids.child,'Child',true).replace('id="wrap-','id="cached-wrap-').replace('id="menu-','id="cached-menu-').replace('selected="false"','selected="true"')}
      </section>
      </div><main id="unrelated"></main></body></html>`);
    const relations = {schemaVersion:1,groups:[
      {parent:chat(ids.parent,'Parent'),children:[chat(ids.child,'Child'),chat(ids.unloaded,'Unloaded')]},
      {parent:chat(ids.unsupportedParent,'Unsupported'),children:[chat(ids.untouched,'Untouched')]}
    ]};
    await page.evaluate(({relations,ids})=>{
      window.__codexNestedRelations=relations;
      window.fixtureClicks=[]; window.fixtureBridge=[];
      for(const row of document.querySelectorAll('[data-app-action-sidebar-thread-row]')) {
        row.addEventListener('click',()=>window.fixtureClicks.push((row.closest('#cached-mode')?'cached:':'')+row.getAttribute('data-app-action-sidebar-thread-id')));
        row.querySelector('[aria-haspopup="menu"]').addEventListener('pointerdown',event=>{
          event.preventDefault(); event.stopPropagation();
          const trigger=event.currentTarget, rect=trigger.getBoundingClientRect();
          const menu=document.createElement('div'); menu.setAttribute('role','menu'); menu.setAttribute('aria-labelledby',trigger.id);
          menu.style.cssText=`position:fixed;left:${rect.left}px;top:${rect.bottom}px;width:180px;height:70px`;
          const item=document.createElement('button'); item.setAttribute('role','menuitem'); item.textContent='重命名';
          item.onclick=()=>{window.fixtureRenamed=row.getAttribute('data-app-action-sidebar-thread-id');menu.remove()};
          const archive=document.createElement('button'); archive.setAttribute('role','menuitem'); archive.textContent='归档';
          archive.onclick=()=>{window.fixtureArchived=row.getAttribute('data-app-action-sidebar-thread-id');menu.remove()};
          menu.append(item,archive); menu.addEventListener('keydown',event=>{if(event.key==='Escape')menu.remove()});document.body.append(menu);
          window.fixtureMenu={id:row.getAttribute('data-app-action-sidebar-thread-id'),left:rect.left,top:rect.top};
        });
      }
      window.__codexNestedOpen=async row=>{window.fixtureBridge.push(row);return {requested:true}};
    },{relations,ids});
    const code = await fs.readFile(path.join(__dirname,'../src/nested-ui.js'),'utf8');
    const initial = await page.evaluate(code);
    const cascadeCode=await fs.readFile(path.join(__dirname,'../src/cascade-actions.js'),'utf8');
    await page.evaluate(cascadeCode);
    assert.equal(initial.state,'active'); assert.equal(initial.groups,1); assert.equal(initial.childItems,2);
    assert.equal(await page.locator('.cnv-selected').count(),0);
    assert.equal(initial.hiddenFlatRows,1);
    assert.equal(await page.locator(`[id="wrap-${ids.child}"]`).getAttribute('data-codex-nested-flat-hidden'),'true');
    assert.equal(await page.locator(`[id="wrap-${ids.duplicate}"]`).getAttribute('data-codex-nested-flat-hidden'),null);
    assert.equal(await page.locator(`[id="wrap-${ids.untouched}"]`).getAttribute('data-codex-nested-flat-hidden'),null);
    await page.locator(`[data-codex-nested-chat-id="${ids.child}"]`).click();
    assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[`local:${ids.child}`]);
    await page.locator(`[data-codex-nested-chat-id="${ids.unloaded}"]`).click();
    assert.deepEqual(await page.evaluate(()=>window.fixtureBridge),[chat(ids.unloaded,undefined)].map(({id,kind,hostId})=>({id,kind,hostId})));
    const originalDescriptor=await page.evaluate(id=>Object.hasOwn(document.querySelector(`[data-app-action-sidebar-thread-id="local:${id}"] button`),'getBoundingClientRect'),ids.child);
    await page.locator('.cnv-child-line').first().hover();
    const moreRect=await page.locator('.cnv-more').first().boundingBox();
    await page.locator('.cnv-more').first().click();
    await page.waitForSelector('[role="menu"]');
    assert.equal((await page.evaluate(()=>window.fixtureMenu)).id,`local:${ids.child}`);
    assert.equal(Math.round((await page.evaluate(()=>window.fixtureMenu)).left),Math.round(moreRect.x));
    assert.equal((await page.evaluate(()=>window.__codexNestedRuntime.getMenuContext())).id,ids.child);
    await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
    await page.waitForTimeout(140);
    assert.equal(await page.evaluate(()=>window.fixtureRenamed),`local:${ids.child}`);
    assert.equal(await page.evaluate(id=>Object.hasOwn(document.querySelector(`[data-app-action-sidebar-thread-id="local:${id}"] button`),'getBoundingClientRect'),ids.child),originalDescriptor);
    await page.locator('.cnv-child-line').first().click({button:'right'});
    await page.waitForSelector('[role="menu"]');
    assert.equal((await page.evaluate(()=>window.__codexNestedRuntime.getMenuContext())).id,ids.child);
    await page.evaluate(()=>window.__codexNestedRuntime.closeNativeMenu());
    assert.equal(await page.locator('[role="menu"]').count(),0);
    // Keep a stale known-parent context by closing its native menu through a
    // normal native action (not the enhancement's explicit close operation).
    await page.locator(`#active-mode [data-app-action-sidebar-thread-id="local:${ids.parent}"] button[aria-haspopup="menu"]`).click();
    assert.equal((await page.evaluate(()=>window.__codexNestedRuntime.getMenuContext())).id,ids.parent);
    await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.__codexNestedRuntime.getMenuContext()),null);
    // An unrelated menu with no ARIA relationship must never inherit that
    // parent's scope, even when it is the only open menu in the document.
    await page.evaluate(()=>{
      const menu=document.createElement('div');menu.setAttribute('role','menu');menu.style.cssText='position:fixed;left:20px;top:20px;width:180px;height:40px';
      const archive=document.createElement('button');archive.setAttribute('role','menuitem');archive.textContent='归档';
      archive.onclick=()=>{window.fixtureArchived='unrelated';menu.remove()};menu.append(archive);document.body.append(menu);
    });
    assert.equal(await page.evaluate(()=>window.__codexNestedRuntime.getMenuContext()),null);
    await page.getByRole('menuitem',{name:'归档',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.fixtureArchived),'unrelated');
    assert.equal((await page.evaluate(()=>window.__codexNestedCascade.inspect())).dialogOpen,false);
    // Re-establish a known parent, then open a real native row that is outside
    // the relations manifest. Its archive action must remain entirely native.
    await page.locator(`#active-mode [data-app-action-sidebar-thread-id="local:${ids.parent}"] button[aria-haspopup="menu"]`).click();
    await page.getByRole('menuitem',{name:'重命名',exact:true}).click();
    await page.locator(`#active-mode [data-app-action-sidebar-thread-id="local:${ids.duplicate}"] button[aria-haspopup="menu"]`).click();
    assert.equal(await page.evaluate(()=>window.__codexNestedRuntime.getMenuContext()),null);
    await page.getByRole('menuitem',{name:'归档',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.fixtureArchived),`local:${ids.duplicate}`);
    assert.equal((await page.evaluate(()=>window.__codexNestedCascade.inspect())).dialogOpen,false);
    assert.deepEqual((await page.evaluate(()=>window.__codexNestedCascade.inspect())).submitted,[]);
    await page.locator(`#active-mode [data-app-action-sidebar-thread-id="local:${ids.parent}"] [data-thread-title-trigger]`).click({button:'right'});
    await page.waitForSelector('[role="menu"]');
    assert.equal((await page.evaluate(()=>window.__codexNestedRuntime.getMenuContext())).id,ids.parent);
    await page.getByRole('menuitem',{name:'归档',exact:true}).click();
    await page.waitForSelector('[data-codex-cascade-dialog="scope"]');
    const parentRightClickScope=await page.evaluate(()=>window.__codexNestedCascade.inspect());
    assert.equal(parentRightClickScope.parentId,ids.parent);
    assert.deepEqual(parentRightClickScope.planned,[ids.child,ids.unloaded,ids.parent]);
    assert.deepEqual(parentRightClickScope.submitted,[]);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal((await page.evaluate(()=>window.__codexNestedCascade.inspect())).dialogOpen,false);
    assert.deepEqual((await page.evaluate(()=>window.__codexNestedCascade.inspect())).submitted,[]);
    // An ordinary row outside the graph retains its original contextmenu event.
    await page.evaluate(id=>document.querySelector(`#active-mode [data-app-action-sidebar-thread-id="local:${id}"]`).addEventListener('contextmenu',event=>{
      window.fixtureUnknownRightClickPrevented=event.defaultPrevented; event.preventDefault();
    }),ids.duplicate);
    await page.locator(`#active-mode [data-app-action-sidebar-thread-id="local:${ids.duplicate}"] [data-thread-title-trigger]`).click({button:'right'});
    assert.equal(await page.evaluate(()=>window.fixtureUnknownRightClickPrevented),false);
    assert.equal(await page.evaluate(()=>window.__codexNestedRuntime.getMenuContext()),null);
    const clicksBeforeModeSwitch=await page.evaluate(()=>window.fixtureClicks);
    await page.evaluate(()=>{
      document.querySelector('#active-mode').style.display='none';
      document.querySelector('#cached-mode').style.display='';
    });
    await page.waitForTimeout(160);
    assert.equal((await page.evaluate(()=>window.__codexNestedRuntime.inspect())).groups,1);
    assert.equal(await page.locator('.cnv-selected').count(),1);
    await page.locator(`[data-codex-nested-chat-id="${ids.child}"]`).click();
    assert.deepEqual(await page.evaluate(()=>window.fixtureClicks),[...clicksBeforeModeSwitch,`cached:local:${ids.child}`]);
    // visibility:hidden also excludes a cached container and cannot leak selected state.
    await page.evaluate(()=>{
      document.querySelector('#active-mode').style.display='';
      document.querySelector('#cached-mode').style.visibility='hidden';
    });
    await page.waitForTimeout(160);
    assert.equal((await page.evaluate(()=>window.__codexNestedRuntime.inspect())).groups,1);
    assert.equal(await page.locator('.cnv-selected').count(),0);
    // Irrelevant document changes must not continually rebuild the sidebar.
    const stable=await page.evaluate(async()=>{
      const before=document.querySelector('[data-codex-nested-parent-id]');
      document.querySelector('#unrelated').append(document.createElement('div'));
      await new Promise(resolve=>setTimeout(resolve,160));
      return document.querySelector('[data-codex-nested-parent-id]')===before;
    });
    assert.equal(stable,true);
    await page.locator('.cnv-toggle').first().click();
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.cnv-toggle').first().getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('[data-codex-nested-parent-id]').evaluate(el=>el.hidden),true);
    const expansion=await page.evaluate(()=>window.__codexNestedRuntime.getExpansionState());
    await page.evaluate(code);
    assert.equal(await page.locator('.cnv-toggle').first().getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('[data-codex-nested-parent-id]').evaluate(el=>el.hidden),true);
    assert.deepEqual(await page.evaluate(()=>window.__codexNestedRuntime.getExpansionState()),expansion);
    await page.evaluate(()=>window.__codexNestedRuntime.dispose());
    assert.equal(await page.locator('[data-codex-nested-owned]').count(),0);
    assert.equal(await page.locator('[data-codex-nested-flat-hidden]').count(),0);
    assert.equal(await page.locator('[data-app-action-sidebar-thread-row]').count(),7);
    await page.evaluate(id=>{
      delete window.__codexNestedRuntime;
      window.__codexNestedExpansionState=[[`local:${id}`,false],['invalid',true],[`local:${id}`,'false']];
    },ids.parent);
    await page.evaluate(code);
    assert.deepEqual(await page.evaluate(()=>window.__codexNestedRuntime.getExpansionState()),[[`local:${ids.parent}`,false]]);
    assert.equal(await page.locator('[data-codex-nested-parent-id]').evaluate(el=>el.hidden),true);
    await page.evaluate(()=>window.__codexNestedRuntime.dispose());
    assert.equal(await page.locator('[data-codex-nested-owned]').count(),0);
    assert.equal(await page.locator('[data-codex-nested-flat-hidden]').count(),0);
    const aliasChecks=await testIdentityAliases(browser,code);
    console.log(JSON.stringify({passed:true,checks:['exact_id_matching','native_click','bridge_fallback','native_more_menu','native_menu_anchor','native_menu_action_identity','native_geometry_restored','child_right_click','native_menu_close','closed_menu_context_unavailable','unrelated_unlabelled_menu_not_intercepted','unknown_native_row_clears_context_and_keeps_native_archive','parent_right_click_uses_identity_bound_native_menu','parent_right_click_archive_opens_scope_and_cancel_submits_nothing','unknown_right_click_keeps_original_event','unsupported_parent_keeps_child','cached_display_mode_excluded','mode_style_switch_reindexes','source_click_uses_current_mode','cached_visibility_mode_excluded','unrelated_dom_no_rebuild','collapse','hot_reload_keeps_expansion','validated_boot_expansion_seed','dispose_restores_original_rows',...aliasChecks]}));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
