'use strict';
// Read-only source checks against VM-owned globals only. No desktop, connection,
// file writes, process discovery, runtime start or official profile access.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const runtime=require('../src/runtime-main.cjs');
const {interaction}=runtime;
const source=fs.readFileSync(path.join(__dirname,'../src/runtime-main.cjs'),'utf8');
function featureCallback(){
  assert.equal(typeof runtime.applyFeatureFlags,'function','The live runtime exports its page feature callback for isolated testing');
  return runtime.applyFeatureFlags.toString();
}
function inspectCallback(){
  const first=source.indexOf('  function inspectPage(){'),last=source.indexOf('  async function paint(){',first);
  assert.ok(first>=0&&last>first,'Locate the real runtime page-inspection function');
  return '('+source.slice(first,last).trim()+')()';
}
const document={querySelectorAll:()=>[]};

test('interaction checks retain known busy states even when another module inspector throws',()=>{
  for(const [window,knownBusy]of [
    [{__codexNestedCascade:{inspect:()=>{throw Error('Broken cascade inspect');}},__codexNestedBulk:{inspect:()=>({dialogOpen:true})}},true],
    [{__codexNestedCascade:{inspect:()=>({busy:true})},__codexNestedBulk:{inspect:()=>{throw Error('Broken bulk inspect');}}},true],
    [{__codexNestedCascade:{inspect:()=>({})},__codexNestedBulk:{inspect:()=>({})},__codexNestedRuntime:{inspect:()=>{throw Error('Broken tree inspect');}}},undefined]
  ]){
    let result;assert.doesNotThrow(()=>{result=vm.runInNewContext('('+interaction.toString()+')()',{window,document});});
    if(knownBusy!==undefined)assert.equal(result,knownBusy);
  }
});

test('archive-off cancellation is not skipped when the tree setter throws',()=>{
  const calls=[],window={
    __codexNestedRuntime:{setEnabled:()=>{calls.push('tree');throw Error('Broken tree setter');}},
    __codexNestedCascade:{setEnabled:value=>{calls.push('cascade:'+value);}},
    __codexNestedBulk:{close:()=>calls.push('bulk-close')}
  };
  const callback=vm.runInNewContext('('+featureCallback()+')',{window});
  assert.doesNotThrow(()=>callback({nestingEnabled:false,archiveEnabled:false}));
  assert.ok(calls.includes('cascade:false'),'The running native archive must receive cancellation');
  assert.ok(calls.includes('bulk-close'),'The picker must close independently');
});

test('native page diagnostics preserve independent archive status when a tree inspector throws',()=>{
  const window={__codexNestedRuntime:{inspect:()=>{throw Error('Broken tree inspect');}},
    __codexConversationModuleStatus:{archive:{state:'ready'},nesting:{state:'display_error'}},
    __codexNestedCascade:{inspect:()=>({busy:false})},__codexNestedBulk:{inspect:()=>({dialogOpen:false})}};
  let result;assert.doesNotThrow(()=>{result=vm.runInNewContext(inspectCallback(),{window});});
  assert.equal(result.installed,true);assert.equal(result.modules.archive.state,'ready');
});

function bindingCallback(name){
  const marker="await page.exposeBinding('"+name+"',",first=source.indexOf(marker);
  const last=source.indexOf('\n    });',first);
  assert.ok(first>=0&&last>first,'Locate the real '+name+' binding');
  return source.slice(first+marker.length,last)+'\n    }';
}

test('archive-off rejects native archive begin before freezing the index',async()=>{
  let pauses=0;const archivePages=new Set();
  const callback=vm.runInNewContext('('+bindingCallback('__codexNestedBeginArchive')+')',{
    features:{archiveEnabled:false},fromPage(){},allowed:()=>true,archivePages,archiveFrozen:false,index:{pause:async()=>{pauses++;}}
  });
  await assert.rejects(callback({page:{}},{ids:['00000000-0000-0000-0000-000000000001']}));
  assert.equal(pauses,0);assert.equal(archivePages.size,0);
});

test('archive-off rejects native fresh validation before issuing any helper command',async()=>{
  let commands=0;const page={},archivePages=new Set([page]);
  const callback=vm.runInNewContext('('+bindingCallback('__codexNestedValidateArchive')+')',{
    features:{archiveEnabled:false},fromPage(){},archivePages,
    run:async()=>{commands++;return {stdout:JSON.stringify({schemaVersion:1,catalog:[],groups:[]})};},
    python:'synthetic-python',path,__dirname:'synthetic-source',codexHome:'synthetic-profile',env:{}
  });
  await assert.rejects(callback({page}));assert.equal(commands,0);
});
