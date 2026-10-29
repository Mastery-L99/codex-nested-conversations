'use strict';
// Isolated HTML fixture only. Never connects to or launches official Codex.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const ids = {p:'00000000-0000-0000-0000-000000000001',
  c:'00000000-0000-0000-0000-000000000002',
  g:'00000000-0000-0000-0000-000000000003',
  other:'00000000-0000-0000-0000-000000000004'};
const chat=(id,title)=>({id,title,kind:'codex',hostId:'local'});
const relations={schemaVersion:1,groups:[
  {parent:chat(ids.p,'Parent'),children:[chat(ids.c,'Child')]},
  {parent:chat(ids.c,'Child'),children:[chat(ids.g,'Grandchild')]}
]};
(async()=>{
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try{
    const page=await browser.newPage();
    await page.setContent('<html><head></head><body><div id="app-shell-sidebar"></div></body></html>');
    await page.evaluate(({relations,ids})=>{
      window.__codexNestedRelations=relations;
      window.fixture={submitted:[],owner:null,wrongOwner:null,failOn:null,statusMode:'normal',statusCalls:0,delayOpen:0,opening:false};
      window.__codexNestedRuntime={
        async openNativeMenu(chat,anchor){
          document.querySelector('[data-fixture-menu]')?.remove();
          window.fixture.opening=true;
          if(window.fixture.delayOpen)await new Promise(resolve=>setTimeout(resolve,window.fixture.delayOpen));
          window.fixture.opening=false;
          if(window.fixture.failOn===chat.id)throw new Error('Fixture native failure');
          const menu=document.createElement('div');menu.role='menu';menu.dataset.fixtureMenu='true';
          const item=document.createElement('button');item.role='menuitem';item.textContent='归档 Ctrl+Shift+A';
          item.onclick=()=>{window.fixture.submitted.push(chat.id);menu.remove()};menu.append(item);document.body.append(menu);
          window.fixture.owner={...chat,menuElement:menu,anchor};
          if(window.fixture.wrongOwner)window.fixture.owner.id=window.fixture.wrongOwner;
          return {opened:true,chat,menuElement:menu};
        },
        getMenuContext(){return window.fixture.owner},
        async closeNativeMenu(){document.querySelector('[data-fixture-menu]')?.remove();window.fixture.owner=null}
      };
    },{relations,ids});
    const source=await fs.readFile(path.join(__dirname,'../src/cascade-actions.js'),'utf8');
    await page.evaluate(source);
    const p=chat(ids.p,'Parent');
    assert.deepEqual(await page.evaluate(p=>window.__codexNestedCascade.plan(p).items.map(x=>x.id),p),[ids.g,ids.c,ids.p]);
    assert.deepEqual(await page.evaluate(p=>window.__codexNestedCascade.plan(p,'archive',false).items.map(x=>x.id),p),[ids.p]);
    assert.equal(await page.evaluate(p=>{try{window.__codexNestedCascade.plan({...p,id:'invalid'});return false}catch{return true}},p),true);
    await page.evaluate(p=>window.__codexNestedRuntime.openNativeMenu(p),p);
    await page.locator('[role=menuitem]').click();
    await page.getByRole('dialog',{name:'归档范围'}).waitFor();
    assert.equal((await page.evaluate(()=>window.__codexNestedCascade.inspect())).dialogOpen,true);
    assert.equal((await page.evaluate(()=>window.__codexNestedCascade.inspect())).previewOpen,true);
    assert.deepEqual(await page.evaluate(()=>window.fixture.submitted),[]);
    assert.equal(await page.getByRole('button',{name:'归档全部 3 个'}).isDisabled(),true);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    assert.equal(await page.locator('[data-codex-nested-cascade-owned][role=dialog]').count(),0);
    assert.equal((await page.evaluate(()=>window.__codexNestedCascade.inspect())).state,'cancelled');
    assert.equal((await page.evaluate(()=>window.__codexNestedCascade.inspect())).dialogOpen,false);
    assert.equal((await page.evaluate(()=>window.__codexNestedCascade.inspect())).previewOpen,false);
    await page.evaluate(()=>window.__codexNestedCascadeOptions={enableArchiveExecution:true});
    await page.evaluate(p=>window.__codexNestedCascade.preview(p),p);
    assert.equal(await page.getByRole('button',{name:'归档全部 3 个'}).isDisabled(),true);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.evaluate(()=>window.__codexNestedArchiveStatus=async chat=>{
      window.fixture.statusCalls++;
      if(window.fixture.statusMode==='false')return {archived:false};
      if(window.fixture.statusMode==='reject')throw new Error('Fixture status read rejected');
      if(window.fixture.statusMode==='hang')return new Promise(()=>{});
      return {archived:window.fixture.submitted.includes(chat.id)};
    });
    await page.evaluate(p=>window.__codexNestedCascade.preview(p),p);
    await page.getByRole('button',{name:'归档全部 3 个'}).click();
    await page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='completed');
    assert.deepEqual(await page.evaluate(()=>window.fixture.submitted),[ids.g,ids.c,ids.p]);
    assert.deepEqual(await page.evaluate(()=>window.__codexNestedCascade.inspect().verified),[ids.g,ids.c,ids.p]);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    // A single-parent choice must not touch descendants.
    await page.evaluate(()=>window.fixture.submitted=[]);
    await page.evaluate(p=>window.__codexNestedCascade.preview(p),p);
    await page.getByRole('button',{name:'只归档当前对话'}).click();
    await page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='completed');
    assert.deepEqual(await page.evaluate(()=>window.fixture.submitted),[ids.p]);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    // Stop while the native menu is still opening: no command may slip through.
    await page.evaluate(()=>{window.fixture.submitted=[];window.fixture.delayOpen=250});
    await page.evaluate(p=>window.__codexNestedCascade.preview(p),p);
    await page.getByRole('button',{name:'归档全部 3 个'}).click();
    await page.waitForFunction(()=>window.fixture.opening);
    await page.getByRole('button',{name:'停止后续操作'}).click();
    await page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='stopped');
    assert.deepEqual(await page.evaluate(()=>window.fixture.submitted),[]);
    assert.deepEqual(await page.evaluate(()=>window.__codexNestedCascade.inspect().verified),[]);
    assert.equal(await page.locator('[data-fixture-menu]').count(),0);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.evaluate(()=>window.fixture.delayOpen=0);
    // Any native failure stops before the parent is touched.
    await page.evaluate(id=>{window.fixture.submitted=[];window.fixture.failOn=id},ids.c);
    await page.evaluate(p=>window.__codexNestedCascade.preview(p),p);
    await page.getByRole('button',{name:'归档全部 3 个'}).click();
    await page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='stopped_after_error');
    assert.deepEqual(await page.evaluate(()=>window.fixture.submitted),[ids.g]);
    assert.deepEqual(await page.evaluate(()=>window.__codexNestedCascade.inspect().verified),[ids.g]);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    // A different menu owner is rejected before any action can be submitted.
    await page.evaluate(id=>{window.fixture.submitted=[];window.fixture.failOn=null;window.fixture.wrongOwner=id},ids.other);
    await page.evaluate(p=>window.__codexNestedCascade.preview(p),p);
    await page.getByRole('button',{name:'归档全部 3 个'}).click();
    await page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='stopped_after_error');
    assert.deepEqual(await page.evaluate(()=>window.fixture.submitted),[]);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.evaluate(()=>window.fixture.wrongOwner=null);
    // False status must time out before any later chat is submitted.
    await page.evaluate(()=>{window.fixture.submitted=[];window.fixture.statusMode='false';window.fixture.statusCalls=0});
    await page.evaluate(p=>window.__codexNestedCascade.preview(p),p);
    await page.getByRole('button',{name:'归档全部 3 个'}).click();
    await page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='stopped_after_error',null,{timeout:12000});
    assert.deepEqual(await page.evaluate(()=>window.fixture.submitted),[ids.g]);
    assert.deepEqual(await page.evaluate(()=>window.__codexNestedCascade.inspect().verified),[]);
    assert.ok((await page.evaluate(()=>window.fixture.statusCalls))>1);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    // A hung status reader is bounded by the same 8-second limit.
    await page.evaluate(()=>{window.fixture.submitted=[];window.fixture.statusMode='hang'});
    await page.evaluate(p=>window.__codexNestedCascade.preview(p),p);
    await page.getByRole('button',{name:'归档全部 3 个'}).click();
    await page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='stopped_after_error',null,{timeout:12000});
    assert.deepEqual(await page.evaluate(()=>window.fixture.submitted),[ids.g]);
    assert.deepEqual(await page.evaluate(()=>window.__codexNestedCascade.inspect().verified),[]);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    // Status read errors cannot be treated as successful archive completion.
    await page.evaluate(()=>{window.fixture.submitted=[];window.fixture.statusMode='reject'});
    await page.evaluate(p=>window.__codexNestedCascade.preview(p),p);
    await page.getByRole('button',{name:'归档全部 3 个'}).click();
    await page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='stopped_after_error');
    assert.deepEqual(await page.evaluate(()=>window.fixture.submitted),[ids.g]);
    assert.deepEqual(await page.evaluate(()=>window.__codexNestedCascade.inspect().verified),[]);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.evaluate(()=>{window.fixture.submitted=[];window.fixture.statusMode='normal'});
    // A changed relationship scope requires a new review, not stale execution.
    await page.evaluate(p=>window.__codexNestedCascade.preview(p),p);
    await page.evaluate(()=>window.__codexNestedRelations.groups[0].children=[]);
    await page.getByRole('button',{name:'归档全部 3 个'}).click();
    await page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='plan_changed');
    assert.deepEqual(await page.evaluate(()=>window.fixture.submitted),[]);
    // Cycles cannot silently turn into a partial destructive plan.
    await page.evaluate(({relations,ids})=>{
      window.__codexNestedRelations=structuredClone(relations);
      window.__codexNestedRelations.groups.push({parent:relations.groups[1].children[0],children:[relations.groups[0].parent]});
    },{relations,ids});
    assert.equal(await page.evaluate(p=>{try{window.__codexNestedCascade.plan(p);return false}catch{return true}},p),true);
    await page.evaluate(()=>window.__codexNestedCascade.dispose());
    assert.equal(await page.locator('[data-codex-nested-cascade-owned]').count(),0);
    assert.equal((await page.evaluate(()=>window.__codexNestedCascade.inspect())).installed,false);
    console.log(JSON.stringify({passed:true,checks:['descendants_first','single_parent_scope','invalid_identity_rejected','native_intercept_requires_review','execution_disabled_by_default','missing_status_hook_disables_execution','cancel_no_side_effect','cancel_updates_live_dialog_state','archive_native_requests','verified_archive_results','stop_during_menu_open_submits_nothing','stop_on_native_failure','menu_owner_guard','false_status_stops_after_timeout','hung_status_is_bounded','status_read_error_stops','scope_change_guard','cycle_guard','dispose_restores']}));
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
