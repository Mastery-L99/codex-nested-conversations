'use strict';
// Isolated settings fixtures and an owned short-lived Windows mutex only.
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const {defaults,parse,readModuleState,createModuleStore}=require('../src/module-state.cjs');
const {withNamedMutex}=require('../src/windows-mutex.cjs');
const rootPromise=fs.mkdtemp(path.join(os.tmpdir(),'cncc-modules-fixture-'));
after(async()=>{
  const root=await rootPromise;
  assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('cncc-modules-fixture-'));
  await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CNCC_TEST_FOLDER,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)'],
    {windowsHide:true,env:{...process.env,CNCC_TEST_FOLDER:root}});
});
const immediate=async work=>work({assertHeld(){}});
async function fixture(name){const p=path.join(await rootPromise,name);await fs.mkdir(p);return p;}
async function save(root,value){await fs.writeFile(path.join(root,'module-state.json'),JSON.stringify(value));}

test('default settings are copied and missing reads do not create files',async()=>{
  const p=await fixture('missing');const result=await readModuleState(p);
  assert.deepEqual(result,defaults);result.archiveEnabled=false;
  assert.equal((await readModuleState(p)).archiveEnabled,true);assert.deepEqual(await fs.readdir(p),[]);
});
test('parse strips arbitrary fields and requires a supported valid state',()=>{
  assert.deepEqual(parse({...defaults,privateBody:'PRIVATE_SENTINEL'}),defaults);
  for(const value of [null,{},[],{...defaults,schemaVersion:2},{...defaults,revision:-1},{...defaults,revision:1.5},
    {...defaults,revision:Number.MAX_SAFE_INTEGER+1},{...defaults,nestingEnabled:1},{...defaults,archiveEnabled:'false'}]){
    assert.throws(()=>parse(value),{code:'INVALID_MODULE_STATE'});
  }
});
test('UTF8 BOM can be read but malformed files fail closed without being overwritten',async()=>{
  const p=await fixture('invalid');const file=path.join(p,'module-state.json');
  await fs.writeFile(file,'\uFEFF'+JSON.stringify(defaults));assert.deepEqual(await readModuleState(p),defaults);
  for(const text of ['{broken',JSON.stringify({...defaults,archiveEnabled:'false'})]){
    await fs.writeFile(file,text);await assert.rejects(readModuleState(p));
    await assert.rejects(createModuleStore({dataDir:p,withLock:immediate}).update({nestingEnabled:false}));
    assert.equal(await fs.readFile(file,'utf8'),text);
  }
});
test('updates merge a fresh state and preserve the other independent switch',async()=>{
  const p=await fixture('merge');const a=createModuleStore({dataDir:p,withLock:immediate});
  const b=createModuleStore({dataDir:p,withLock:immediate});
  assert.deepEqual(await a.update({nestingEnabled:false}),{...defaults,revision:1,nestingEnabled:false});
  assert.deepEqual(await b.update({archiveEnabled:false}),{...defaults,revision:2,nestingEnabled:false,archiveEnabled:false});
  assert.deepEqual(await a.update({nestingEnabled:true}),{...defaults,revision:3,archiveEnabled:false});
  assert.deepEqual(await fs.readdir(p),['module-state.json']);
});
test('idempotent default and saved updates do not write or bump revisions',async()=>{
  const p=await fixture('idempotent');const store=createModuleStore({dataDir:p,withLock:immediate});
  assert.deepEqual(await store.update({archiveEnabled:true}),defaults);assert.deepEqual(await fs.readdir(p),[]);
  await store.update({archiveEnabled:false});const before=await fs.stat(path.join(p,'module-state.json'));
  await store.update({archiveEnabled:false});const after=await fs.stat(path.join(p,'module-state.json'));
  assert.equal(after.mtimeMs,before.mtimeMs);assert.equal((await store.read()).revision,1);
});
test('patches reject unknown fields, empty input and nonboolean values before locking',async()=>{
  const p=await fixture('patch');let locks=0;const store=createModuleStore({dataDir:p,withLock:async work=>{locks++;return immediate(work);}});
  for(const patch of [null,{},[],{revision:1},{archiveEnabled:'false'},{nestingEnabled:0},{archiveEnabled:false,unexpected:true}]){
    await assert.rejects(store.update(patch),{code:'INVALID_MODULE_STATE'});
  }
  assert.equal(locks,0);assert.deepEqual(await fs.readdir(p),[]);
});
test('busy lock causes no state write',async()=>{
  const p=await fixture('busy');const store=createModuleStore({dataDir:p,withLock:async()=>({state:'mutex_busy'})});
  await assert.rejects(store.update({archiveEnabled:false}),{code:'MODULE_STATE_BUSY'});assert.deepEqual(await fs.readdir(p),[]);
});
test('lost mutex lease prevents replacement of the last committed state',async()=>{
  const p=await fixture('lost');await save(p,defaults);
  const store=createModuleStore({dataDir:p,withLock:work=>work({assertHeld(){throw Object.assign(Error('lost'),{code:'MUTEX_LOST'});}})});
  await assert.rejects(store.update({archiveEnabled:false}),{code:'MUTEX_LOST'});assert.deepEqual(await readModuleState(p),defaults);
});
test('revision overflow is rejected rather than committing unreadable state',async()=>{
  const p=await fixture('overflow');const state={...defaults,revision:Number.MAX_SAFE_INTEGER};await save(p,state);
  const store=createModuleStore({dataDir:p,withLock:immediate});
  await assert.rejects(store.update({archiveEnabled:false}));assert.deepEqual(await readModuleState(p),state);
});
test('real Windows mutex serializes the same settings path and releases its owned holder',async()=>{
  const p=await fixture('real-mutex');const name='Local\\CnccModules-'+crypto.createHash('sha256').update(path.resolve(p).toLowerCase()).digest('hex').slice(0,32);
  const store=createModuleStore({dataDir:p});
  const marker=await withNamedMutex(name,async lease=>{lease.assertHeld();
    await assert.rejects(store.update({archiveEnabled:false}),{code:'MODULE_STATE_BUSY'});return 'owned';});
  assert.equal(marker,'owned');
  // The helper exits asynchronously after stdin closes; retry only a safe settings operation.
  let changed;for(let i=0;i<20;i++){try{changed=await store.update({archiveEnabled:false});break;}catch(e){if(e.code!=='MODULE_STATE_BUSY')throw e;await new Promise(r=>setTimeout(r,50));}}
  assert.equal(changed?.archiveEnabled,false);assert.equal(changed.revision,1);
});
