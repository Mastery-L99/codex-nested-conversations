'use strict';
// VM-owned window and synthetic local modules. Never connects to an app/browser.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/ui-modules.js'),'utf8');
function fixture(overrides={}){
  const win={calls:[],fail:{}};const context=vm.createContext({window:win});vm.runInContext(source,context);
  const sources={
    'nested-ui.js':`window.calls.push('nesting');window.__codexNestedRuntime={inspect(){if(window.fail.inspect)throw Error('inspect failed');return {installed:true,state:'ready',errors:[]}},openNativeMenu(){},dispose(){window.calls.push('tree-dispose');if(window.fail.treeDispose)throw Error('tree dispose failed')}};`,
    'cascade-actions.js':`window.calls.push('cascade');window.__codexNestedCascade={setEnabled(v){window.calls.push('cascade-'+v);if(window.fail.enable)throw Error('enable failed')},dispose(){window.calls.push('cascade-dispose');if(window.fail.cascadeDispose)throw Error('cascade dispose failed')}};`,
    'bulk-archive.js':`window.calls.push('bulk');window.__codexNestedBulk={dispose(){window.calls.push('bulk-dispose');if(window.fail.bulkDispose)throw Error('bulk dispose failed')}};`,
    'host-events.js':`window.calls.push('events');`
  };
  const payload={sources,relations:{schemaVersion:1,catalog:[],groups:[]},expanded:{},aliases:{},
    features:{nestingEnabled:true,archiveEnabled:true},archiveExecution:true,shortcutReady:true,...overrides};
  return {win,payload,install:()=>win.__codexInstallConversationModules(payload)};
}
test('normal initialization installs distinct native, archive and event modules',()=>{
  const f=fixture();const status=f.install();assert.deepEqual(f.win.calls,['nesting','cascade','cascade-true','bulk','events']);
  assert.equal(status.archive.state,'ready');assert.equal(status.nesting.state,'ready');assert.equal(status.events.state,'ready');
  assert.equal(f.win.__codexNestedCascadeOptions.requireNativeMenuBridge,true);assert.equal(f.win.__codexNestedCascadeOptions.requireFreshValidation,true);
});
test('nesting switch off still loads identity/menu bridge and keeps archive usable',()=>{
  const f=fixture({features:{nestingEnabled:false,archiveEnabled:true}});const status=f.install();
  assert.equal(status.nesting.state,'disabled');assert.equal(status.archive.state,'ready');
  assert.equal(f.win.__codexNestedUiOptions.enabled,false);assert.equal(typeof f.win.__codexNestedRuntime.openNativeMenu,'function');
});
test('archive switch off preserves nesting and disposes both archive pieces',()=>{
  const f=fixture();f.install();f.payload.features.archiveEnabled=false;const status=f.install();
  assert.equal(status.archive.state,'disabled');assert.equal(status.nesting.state,'ready');
  assert.equal(f.win.__codexNestedBulk,undefined);assert.equal(f.win.__codexNestedCascade,undefined);
  assert(f.win.calls.includes('bulk-dispose'));assert(f.win.calls.includes('cascade-dispose'));
});
test('archive can be reenabled and shortcut relay absence only disables its shortcut interception',()=>{
  const f=fixture({features:{nestingEnabled:true,archiveEnabled:false},shortcutReady:false});f.install();
  f.payload.features.archiveEnabled=true;assert.equal(f.install().archive.state,'ready');
  assert.equal(f.win.__codexNestedCascadeOptions.enableShortcutInterception,false);
});
test('missing tree source yields preview archive and does not suppress host events',()=>{
  const f=fixture();delete f.payload.sources['nested-ui.js'];const status=f.install();
  assert.equal(status.archive.state,'preview_only');assert.equal(status.nesting.errors.length,1);assert.equal(status.events.state,'ready');
  assert(f.win.calls.includes('bulk'));
});
test('tree syntax failure still installs archive independently',()=>{
  const f=fixture();f.payload.sources['nested-ui.js']='invalid syntax )';const status=f.install();
  assert.equal(status.archive.state,'preview_only');assert.equal(status.events.state,'ready');assert.equal(status.nesting.errors.length,1);
});
test('cascade failure does not remove native tree or stop event initialization',()=>{
  const f=fixture();f.payload.sources['cascade-actions.js']='throw Error("cascade broken")';const status=f.install();
  assert.equal(status.archive.errors.length,1);assert.equal(status.nesting.state,'ready');assert.equal(status.events.state,'ready');assert(!f.win.calls.includes('bulk'));
});
test('bulk failure retains tree and cascade while reporting archive error',()=>{
  const f=fixture();f.payload.sources['bulk-archive.js']='throw Error("bulk broken")';const status=f.install();
  assert.equal(status.archive.errors.length,1);assert.equal(status.nesting.state,'ready');assert.equal(status.events.state,'ready');
  assert.equal(typeof f.win.__codexNestedCascade.setEnabled,'function');
});
test('event-source failure is isolated from both feature modules',()=>{
  const f=fixture();f.payload.sources['host-events.js']='throw Error("events broken")';const status=f.install();
  assert.equal(status.events.errors.length,1);assert.equal(status.archive.state,'ready');assert.equal(status.nesting.state,'ready');
});
test('inspect failure cannot prevent independent archive and events initialization',()=>{
  const f=fixture();f.win.fail.inspect=true;const status=f.install();
  assert.equal(status.archive.state,'ready');assert.equal(status.events.state,'ready');assert(status.nesting.errors.length>0);
});
test('cascade enable failure cannot stop event initialization',()=>{
  const f=fixture();f.win.fail.enable=true;const status=f.install();
  assert(status.archive.errors.length>0);assert.equal(status.events.state,'ready');assert.equal(status.nesting.state,'ready');
});
test('one throwing archive disposer cannot skip the other disposer or events',()=>{
  const f=fixture();f.install();f.win.fail.bulkDispose=true;f.payload.features.archiveEnabled=false;const status=f.install();
  assert(f.win.calls.includes('cascade-dispose'));assert.equal(status.events.state,'ready');
  assert(status.archive.errors.length>0);assert.equal(f.win.__codexNestedBulk,undefined);assert.equal(f.win.__codexNestedCascade,undefined);
});
