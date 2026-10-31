'use strict';
// Synthetic service, transport and providers only. In-memory fixtures use paths
// that stay nonexistent; disk fixtures are owned temporary folders recycled by
// the shared helper. No desktop, account, database or loader access.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {randomUUID} = require('node:crypto');
const {PassThrough} = require('node:stream');
const {setImmediate: tick} = require('node:timers/promises');
const {createArchiveService, serveArchiveStdio, UI_URI, tools, publicError} = require('../src/archive-server.cjs');
const {createFixture,recycleFixture} = require('./recycle-fixture.cjs');
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const chat = n => ({id:uuid(n), title:`Synthetic chat ${n}`, kind:'codex', hostId:'local', threadSource:'user', createdAtMs:1700000000000+n});
const [parent, child, grandchild, solo] = [1,2,3,4].map(chat);
const baseManifest = () => ({schemaVersion:1, relationsAvailable:true, catalog:[parent,child,grandchild,solo].map(value=>({...value})), groups:[
  {parent:{...parent}, children:[{...child}]}, {parent:{...child}, children:[{...grandchild}]}
]});
const code = expected => error => error.code === expected;
function fixture(t, custom={}) {
  const dataDir=path.join(os.tmpdir(),'cncc-synthetic-no-files-'+randomUUID());
  let manifest=baseManifest(),clock=1700000000000;
  let state={schemaVersion:1,revision:0,nestingEnabled:true,archiveEnabled:true,...custom.state};
  const calls={loads:0,archive:[],status:[],scope:[],lock:0,leaseChecks:0,disposed:0,updates:[]}, archived=new Set();
  const store={read:async()=>({...state}),update:async patch=>{
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.entries(patch).some(([key,value])=>!['nestingEnabled','archiveEnabled'].includes(key)||typeof value!=='boolean'))throw Object.assign(new Error('Invalid settings'),{code:'INVALID_MODULE_STATE'});
    calls.updates.push({...patch}); state={...state,...patch,revision:state.revision+1};return {...state};
  }};
  const provider={
    capabilities:{archiveMayCascade:false,atomicConfirmedScope:true,reportsAffectedIds:true},
    readScope:async id=>{calls.scope.push(id);return {thread:{id,archived:false},spawnedDescendants:[]};},
    archive:async(id,args)=>{calls.archive.push({id,args});archived.add(id);return {submitted:true,affectedIds:[id]};},
    readStatus:async id=>{calls.status.push(id);return {id,archived:archived.has(id)};},
    dispose:()=>{calls.disposed++;},...custom.provider
  };
  const service=createArchiveService({dataDir,settingsDir:dataDir,codexHome:path.join(dataDir,'synthetic-home'),persist:false,store,provider,
    now:()=>clock,loadManifest:async()=>{calls.loads++;return structuredClone(manifest);},
    withExecutionLock:async work=>{calls.lock++;return work({assertHeld:()=>{calls.leaseChecks++;}});},...custom.options});
  t.after(async()=>{await service.dispose();await assert.rejects(fs.stat(dataDir),error=>error.code==='ENOENT');});
  return {service,calls,provider,store,dataDir,setManifest:value=>{manifest=value;},advance:milliseconds=>{clock+=milliseconds;},state:()=>({...state})};
}
async function submit(f,args={chatIds:[parent.id]}) {
  const plan=await f.service.planArchive(args),response=await f.service.confirmArchive({planToken:plan.planToken,backgroundReviewToken:plan.backgroundReviewToken});
  return {plan,job:await f.service.waitForJob(response.job.jobId)};
}

test('a refused desktop write keeps its safe reason in the progress view and saved job',async t=>{
  const root=await createFixture('cncc-refused-writer-');t.after(()=>recycleFixture(root));
  let writes=0;
  const f=fixture(t,{options:{persist:true,dataDir:root},provider:{archive:async()=>{
    writes++;
    const error=require('../src/archive-app-server.cjs').rpcFailure('thread/archive',{code:-32600,message:'thread private-id already has an active writer'});
    throw Object.assign(error,{submitted:true,affectedIds:[]});
  }}});
  const {job}=await submit(f);
  assert.equal(writes,1);assert.equal(job.status,'failed');assert.equal(job.completed,0);
  assert.deepEqual(job.error.details,{method:'thread/archive',reason:'active_writer',nativeCode:-32600,osCode:null});
  const saved=JSON.parse(await fs.readFile(path.join(root,'archive-jobs',job.jobId+'.json'),'utf8'));
  assert.deepEqual(saved.error,job.error);assert.doesNotMatch(JSON.stringify(saved),/private-id/);
});

test('flat listing and archive work with nesting disabled and without any native connection',async t=>{
  const f=fixture(t,{state:{nestingEnabled:false}}),listing=await f.service.listChats();
  assert.equal(listing.module.nestingEnabled,false);assert.equal(listing.module.archiveEnabled,true);
  assert.equal(listing.module.nativeState,'disabled');assert.equal(listing.module.independentArchive,true);
  assert.equal(listing.chats.find(value=>value.id===child.id).parentId,parent.id);
  const {plan,job}=await submit(f);
  assert.equal(plan.totalCount,3);assert.equal(job.status,'completed');assert.equal(job.completed,3);
  assert.deepEqual(f.calls.archive.map(value=>value.id),[grandchild.id,child.id,parent.id]);
  assert.deepEqual(f.calls.status,[grandchild.id,child.id,parent.id]);assert.equal(f.calls.lock,1);
  assert.ok(f.calls.leaseChecks>=4);assert.equal(f.state().nestingEnabled,false);
});

test('archive and nesting switches remain independent; archive-off blocks plans and confirmation',async t=>{
  const f=fixture(t),plan=await f.service.planArchive({chatIds:[solo.id]});
  await f.service.setModules({archiveEnabled:false});
  await assert.rejects(f.service.planArchive({chatIds:[solo.id]}),code('MODULE_DISABLED'));
  await assert.rejects(f.service.confirmArchive({planToken:plan.planToken}),code('MODULE_DISABLED'));
  let status=await f.service.moduleStatus();assert.equal(status.module.state,'disabled');assert.equal(status.module.nestingEnabled,true);
  await f.service.setModules({nestingEnabled:false});status=await f.service.setModules({archiveEnabled:true});
  assert.equal(status.module.archiveEnabled,true);assert.equal(status.module.nestingEnabled,false);
  const response=await f.service.confirmArchive({planToken:plan.planToken});
  assert.equal((await f.service.waitForJob(response.job.jobId)).status,'completed');
  await assert.rejects(f.service.setModules({autostart:true}),code('INVALID_MODULE_STATE'));
});

test('damaged relationship input preserves flat listing and explicit selected-only archive',async t=>{
  const f=fixture(t),data=baseManifest();data.groups=[];data.relationsAvailable=false;f.setManifest(data);
  const listing=await f.service.listChats();assert.equal(listing.relationsAvailable,false);assert.equal(listing.chats.length,4);
  await assert.rejects(f.service.planArchive({chatIds:[parent.id]}),code('RELATIONS_UNAVAILABLE'));
  const {plan,job}=await submit(f,{chatIds:[parent.id],includeDescendants:false});
  assert.equal(plan.totalCount,1);assert.equal(job.status,'completed');assert.deepEqual(job.verified,[parent.id]);
});

test('list_chats emits a narrow metadata projection even if an upstream manifest contains private fields',async t=>{
  const f=fixture(t),data=baseManifest();
  Object.assign(data.catalog[0],{preview:'PRIVATE_SENTINEL',firstUserMessage:'PRIVATE_SENTINEL',turns:[{text:'PRIVATE_SENTINEL'}],rolloutPath:'PRIVATE_SENTINEL',auth:'PRIVATE_SENTINEL'});
  f.setManifest(data);const result=await f.service.listChats();
  assert.equal(JSON.stringify(result).includes('PRIVATE_SENTINEL'),false);
  assert.equal(result.chats.find(value=>value.id===parent.id).title,parent.title);
  assert.deepEqual(Object.keys(result.chats[0]).sort(),['createdAtMs','eligibility','hostId','id','kind','parentId','threadSource','title','updatedAtMs'].sort());
});

test('review tokens are unique, single-use, time-limited and bind the original scope rather than caller IDs',async t=>{
  const f=fixture(t),one=await f.service.planArchive({chatIds:[solo.id]}),two=await f.service.planArchive({chatIds:[solo.id]});
  assert.notEqual(one.planToken,two.planToken);assert.equal(one.expiresAt,1700000300000);
  await assert.rejects(f.service.confirmArchive({planToken:'fabricated',chatIds:[parent.id]}),code('PLAN_NOT_FOUND'));
  const response=await f.service.confirmArchive({planToken:one.planToken,chatIds:[parent.id]});
  const job=await f.service.waitForJob(response.job.jobId);assert.deepEqual(job.verified,[solo.id]);
  await assert.rejects(f.service.confirmArchive({planToken:one.planToken}),code('PLAN_USED'));
  f.advance(5*60*1000);await assert.rejects(f.service.confirmArchive({planToken:two.planToken}),code('PLAN_EXPIRED'));
});

test('fresh manifest changes after review stop the job before any official archive request',async t=>{
  const f=fixture(t),plan=await f.service.planArchive({chatIds:[parent.id]}),changed=baseManifest();
  changed.catalog[0].title='Changed after review';f.setManifest(changed);
  const {job:queued}=await f.service.confirmArchive({planToken:plan.planToken}),job=await f.service.waitForJob(queued.jobId);
  assert.equal(job.status,'failed');assert.equal(job.error.code,'scope_changed');assert.deepEqual(f.calls.archive,[]);
});

test('a lost relation source cannot silently narrow a confirmed descendant scope',async t=>{
  const f=fixture(t),plan=await f.service.planArchive({chatIds:[solo.id],includeDescendants:true});
  f.setManifest({...baseManifest(),groups:[],relationsAvailable:false});
  const {job}=await f.service.confirmArchive({planToken:plan.planToken});
  assert.equal((await f.service.waitForJob(job.jobId)).error.code,'RELATIONS_UNAVAILABLE');
  assert.deepEqual(f.calls.archive,[]);
});

test('backend implicit descendants outside the displayed plan block planning before a token is issued',async t=>{
  const f=fixture(t,{provider:{readScope:async()=>({spawnedDescendants:[{id:uuid(88),archived:false}]})}});
  await assert.rejects(f.service.planArchive({chatIds:[parent.id]}),code('IMPLICIT_SCOPE_UNREVIEWED'));
  assert.deepEqual(f.calls.archive,[]);
  f.provider.readScope=async()=>({spawnedDescendants:[{id:uuid(88),archived:true}]});
  assert.equal((await f.service.planArchive({chatIds:[parent.id]})).totalCount,3);
});

test('nested background records have one displayed owner and never become direct archive targets',async t=>{
  const f=fixture(t), backgroundId=uuid(90),done=new Set();
  const scoped=(id)=>({spawnedDescendants:[parent.id,child.id].includes(id)?[
    {id:backgroundId,archived:done.has(backgroundId),threadSource:'subagent',label:'Research',depth:id===child.id?1:2}
  ]:[]});
  f.provider.readScope=async id=>scoped(id);
  f.provider.archive=async(id,args)=>{
    f.calls.archive.push({id,args});done.add(id);
    const affectedIds=[id];
    if(id===child.id){done.add(backgroundId);affectedIds.push(backgroundId);}
    return {submitted:true,affectedIds};
  };
  f.provider.readStatus=async id=>({id,archived:done.has(id)});
  const {plan,job}=await submit(f);
  assert.equal(plan.totalCount,3);assert.equal(plan.implicitCount,1);
  assert.deepEqual(plan.implicitItems,[{id:backgroundId,title:'Research',parentId:child.id,parentTitle:child.title}]);
  assert.deepEqual(f.calls.archive.map(c=>c.id),[grandchild.id,child.id,parent.id]);
  assert(!f.calls.archive[0].args.confirmedIds.includes(backgroundId));assert(f.calls.archive[1].args.confirmedIds.includes(backgroundId));
  assert.equal(job.status,'completed');assert.equal(job.completed,3);assert.deepEqual(job.verifiedImplicit,[backgroundId]);assert.deepEqual(job.pendingImplicit,[]);
});

test('new or renamed background runs invalidate a review before the first write',async t=>{
  for(const mutate of ['add','rename','remove']){
    const f=fixture(t),rows=[{id:uuid(81),archived:false,threadSource:'subagent',label:'First'}];
    f.provider.readScope=async()=>({spawnedDescendants:rows});
    const plan=await f.service.planArchive({chatIds:[solo.id]});
    if(mutate==='add')rows.push({...rows[0],id:uuid(82)});else if(mutate==='rename')rows[0].label='New';else rows.pop();
    await assert.rejects(f.service.confirmArchive({planToken:plan.planToken}),code('BACKGROUND_REVIEW_REQUIRED'));
    await assert.rejects(f.service.confirmArchive({planToken:plan.planToken,backgroundReviewToken:'wrong'}),code('BACKGROUND_REVIEW_REQUIRED'));
    const {job}=await f.service.confirmArchive({planToken:plan.planToken,backgroundReviewToken:plan.backgroundReviewToken});
    assert.equal((await f.service.waitForJob(job.jobId)).error.code,'BACKGROUND_SCOPE_CHANGED');assert.deepEqual(f.calls.archive,[]);
  }
});

test('a regular chat cannot be added as background, even when selected-only mode is active',async t=>{
  const f=fixture(t,{provider:{readScope:async()=>({spawnedDescendants:[{id:uuid(92),archived:false,threadSource:'user',source:'vscode'}]})}});
  await assert.rejects(f.service.planArchive({chatIds:[solo.id],includeDescendants:false}),code('UNSELECTED_CHAT_DESCENDANT'));
  assert.deepEqual(f.calls.archive,[]);
});

test('non-atomic official capabilities stay disclosed; exact user token confirmation consents to that risk',async t=>{
  const f=fixture(t,{provider:{capabilities:{archiveMayCascade:true,confirmedScopePreflight:true,atomicConfirmedScope:false,reportsAffectedIds:true}}});
  const plan=await f.service.planArchive({chatIds:[solo.id]});
  assert.equal(plan.capabilities.atomicConfirmedScope,false);assert.equal(plan.capabilities.nonAtomicScopeRisk,true);
  assert.equal(plan.warnings.length,1);assert.equal(f.calls.archive.length,0);
  const response=await f.service.confirmArchive({planToken:plan.planToken}),job=await f.service.waitForJob(response.job.jobId);
  assert.equal(job.status,'completed');assert.deepEqual(job.verified,[solo.id]);
});

test('one active job excludes further plans and confirmation; unused plans can run after it finishes',async t=>{
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const f=fixture(t,{provider:{archive:async id=>{entered();await gate;return {submitted:true,affectedIds:[id]};},readStatus:async()=>({archived:true})}});
  const one=await f.service.planArchive({chatIds:[solo.id]}),two=await f.service.planArchive({chatIds:[solo.id]});
  const first=await f.service.confirmArchive({planToken:one.planToken});await started;
  await assert.rejects(f.service.planArchive({chatIds:[parent.id]}),code('JOB_BUSY'));
  await assert.rejects(f.service.confirmArchive({planToken:two.planToken}),code('JOB_BUSY'));
  release();assert.equal((await f.service.waitForJob(first.job.jobId)).status,'completed');
  const second=await f.service.confirmArchive({planToken:two.planToken});assert.equal((await f.service.waitForJob(second.job.jobId)).status,'completed');
});

test('partial failures preserve verified results and stop later requests',async t=>{
  let attempts=0;
  const f=fixture(t,{provider:{archive:async id=>{
    if(++attempts===2)throw Object.assign(new Error('Synthetic rejection'),{code:'SYNTHETIC_FAILURE',submitted:false});
    return {submitted:true,affectedIds:[id]};
  },readStatus:async()=>({archived:true})}});
  const {job}=await submit(f);assert.equal(job.status,'failed');assert.deepEqual(job.verified,[grandchild.id]);
  assert.deepEqual(job.submitted,[grandchild.id]);assert.equal(job.completed,1);assert.equal(attempts,2);
  assert.ok(job.pending.includes(parent.id));assert.equal(job.error.code,'SYNTHETIC_FAILURE');
});

test('stop aborts an in-flight request, exposes uncertainty and never submits the remaining chats',async t=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});let count=0,archiveSignal;
  const f=fixture(t,{provider:{archive:(_id,{signal})=>{count++;archiveSignal=signal;entered();return new Promise(()=>{});}}});
  const plan=await f.service.planArchive({chatIds:[parent.id]}),response=await f.service.confirmArchive({planToken:plan.planToken});
  await started;await f.service.stopJob({jobId:response.job.jobId});const job=await f.service.waitForJob(response.job.jobId);
  assert.equal(job.status,'stopped');assert.equal(archiveSignal.aborted,true);assert.equal(count,1);
  assert.deepEqual(job.uncertain,[grandchild.id]);assert.deepEqual(job.verified,[]);
  assert.equal((await f.service.stopJob({jobId:job.jobId})).job.status,'stopped');
});

test('disabling archive cancels pending work without disabling nesting',async t=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});let count=0;
  const f=fixture(t,{provider:{archive:()=>{count++;entered();return new Promise(()=>{});}}});
  const plan=await f.service.planArchive({chatIds:[parent.id]}),response=await f.service.confirmArchive({planToken:plan.planToken});
  await started;await f.service.setModules({archiveEnabled:false});const job=await f.service.waitForJob(response.job.jobId);
  assert.equal(job.status,'stopped');assert.equal(count,1);assert.equal(f.state().nestingEnabled,true);
});

test('an external execution lock conflict fails without a write and job IDs cannot escape the fixture directory',async t=>{
  const f=fixture(t,{options:{withExecutionLock:async()=>({state:'mutex_busy'})}}),{job}=await submit(f,{chatIds:[solo.id]});
  assert.equal(job.status,'failed');assert.equal(job.error.code,'JOB_BUSY');assert.deepEqual(f.calls.archive,[]);
  for(const jobId of ['../state','C:\\private.json','bad',null])await assert.rejects(f.service.getJob({jobId}),code('JOB_NOT_FOUND'));
  await assert.rejects(f.service.stopJob({jobId:uuid(99)}),code('JOB_NOT_FOUND'));
  assert.equal(await f.service.waitForJob(uuid(99)),null);
});

test('plan cache is bounded to 64 live reviews and expiry reclaims it',async t=>{
  const f=fixture(t);
  for(let index=0;index<64;index++)await f.service.planArchive({chatIds:[solo.id]});
  await assert.rejects(f.service.planArchive({chatIds:[solo.id]}),code('TOO_MANY_PLANS'));
  f.advance(300001);assert.equal((await f.service.planArchive({chatIds:[solo.id]})).totalCount,1);
});

async function diskFixture(t){
  const root=await createFixture('cncc-archive-service-'),dataDir=path.join(root,'data'),settingsDir=path.join(root,'settings');
  await Promise.all([fs.mkdir(dataDir),fs.mkdir(settingsDir)]);
  const instances=[],calls={archive:[],status:[],scope:[],lock:0,loads:0,disposed:0},archived=new Set();
  const settings={schemaVersion:1,revision:0,nestingEnabled:true,archiveEnabled:true};
  const store={read:async()=>({...settings}),update:async patch=>Object.assign(settings,patch,{revision:settings.revision+1})};
  const provider={capabilities:{archiveMayCascade:false,atomicConfirmedScope:true,reportsAffectedIds:true},
    readScope:async id=>{calls.scope.push(id);return {spawnedDescendants:[]};},
    archive:async(id,args)=>{calls.archive.push({id,args});archived.add(id);return {submitted:true,affectedIds:[id]};},
    readStatus:async id=>{calls.status.push(id);return {id,archived:archived.has(id)};},dispose:()=>{calls.disposed++;}};
  function makeService(overrides={}){
    const service=createArchiveService({dataDir,settingsDir,codexHome:path.join(root,'synthetic-home'),store,provider,
      loadManifest:async()=>{calls.loads++;return baseManifest();},
      withExecutionLock:async work=>{calls.lock++;return work({assertHeld(){}});},...overrides});
    instances.push(service);return service;
  }
  t.after(async()=>{
    for(const service of instances){
      const job=(await service.moduleStatus()).activeJob;
      await service.dispose();if(job)await service.waitForJob(job.jobId);
    }
    await recycleFixture(root);
  });
  return {root,dataDir,settingsDir,calls,settings,store,provider,makeService};
}
const writeJSON=(file,value)=>fs.writeFile(file,JSON.stringify(value));

test('settings directory precedence is explicit option, environment, then archive data directory',async t=>{
  const f=await diskFixture(t),environmentDir=path.join(f.root,'environment-settings');await fs.mkdir(environmentDir);
  const saved=process.env.CNCC_SETTINGS_DIR;
  try{
    await writeJSON(path.join(f.dataDir,'module-state.json'),{...f.settings,revision:1});
    await writeJSON(path.join(environmentDir,'module-state.json'),{...f.settings,revision:2,archiveEnabled:false});
    await writeJSON(path.join(f.settingsDir,'module-state.json'),{...f.settings,revision:3,nestingEnabled:false});
    process.env.CNCC_SETTINGS_DIR=environmentDir;
    const explicit=await f.makeService({store:undefined}).moduleStatus();
    assert.equal(explicit.module.revision,3);assert.equal(explicit.module.archiveEnabled,true);assert.equal(explicit.module.nativeState,'disabled');
    const environment=await f.makeService({store:undefined,settingsDir:undefined}).moduleStatus();
    assert.equal(environment.module.revision,2);assert.equal(environment.module.archiveEnabled,false);
    delete process.env.CNCC_SETTINGS_DIR;
    const fallback=await f.makeService({store:undefined,settingsDir:undefined}).moduleStatus();
    assert.equal(fallback.module.revision,1);assert.equal(fallback.module.nestingEnabled,true);
  }finally{if(saved===undefined)delete process.env.CNCC_SETTINGS_DIR;else process.env.CNCC_SETTINGS_DIR=saved;}
  assert.deepEqual(f.calls.archive,[]);
});

test('canonical native status wins over legacy status and nesting-off remains disabled',async t=>{
  const f=await diskFixture(t);
  await writeJSON(path.join(f.settingsDir,'native-runtime-status.json'),{state:'running',processId:process.pid,nativeState:'ready'});
  await writeJSON(path.join(f.dataDir,'runtime-status.json'),{state:'running',processId:process.pid,nativeState:'unavailable'});
  const service=f.makeService();assert.equal((await service.moduleStatus()).module.nativeState,'ready');
  f.settings.nestingEnabled=false;assert.equal((await service.moduleStatus()).module.nativeState,'disabled');
  const {job}=await submit({service},{chatIds:[solo.id]});assert.equal(job.status,'completed');
  assert.deepEqual(f.calls.archive.map(row=>row.id),[solo.id]);
});

test('legacy native status and canonical diagnostics are readable without gating the archive module',async t=>{
  const f=await diskFixture(t);
  await writeJSON(path.join(f.dataDir,'runtime-status.json'),{state:'running',processId:process.pid,diagnostics:[{modules:{nesting:{state:'ready'}}}]});
  const service=f.makeService();assert.equal((await service.moduleStatus()).module.nativeState,'ready');
  await writeJSON(path.join(f.settingsDir,'native-runtime-status.json'),{state:'running',processId:process.pid,diagnostics:[{modules:{nesting:{state:'ready'}}}]});
  assert.equal((await service.moduleStatus()).module.nativeState,'ready');
  await fs.writeFile(path.join(f.settingsDir,'native-runtime-status.json'),'{corrupt fixture status');
  const status=await service.moduleStatus();assert.equal(status.module.nativeState,'unavailable');assert.equal(status.module.archiveState,'ready');
  const {job}=await submit({service},{chatIds:[solo.id]});assert.equal(job.status,'completed');
});

test('completed persisted jobs are read after service restart without replaying writes or reviving old tokens',async t=>{
  const f=await diskFixture(t),service=f.makeService(),{plan,job}=await submit({service},{chatIds:[parent.id]});
  const saved=JSON.parse(await fs.readFile(path.join(f.dataDir,'archive-jobs',job.jobId+'.json'),'utf8'));
  assert.equal(saved.schemaVersion,1);assert.equal(saved.status,'completed');assert.deepEqual(saved.verified,[grandchild.id,child.id,parent.id]);
  assert.equal(Object.hasOwn(saved,'planToken'),false);assert.equal(Object.hasOwn(saved,'scope'),false);
  await service.dispose();const writes=f.calls.archive.length,restarted=f.makeService();
  const restored=(await restarted.getJob({jobId:job.jobId})).job;
  assert.equal(restored.status,'completed');assert.deepEqual(restored.verified,saved.verified);
  assert.equal(await restarted.waitForJob(job.jobId),null);
  await assert.rejects(restarted.confirmArchive({planToken:plan.planToken}),code('PLAN_NOT_FOUND'));
  await assert.rejects(restarted.stopJob({jobId:job.jobId}),code('JOB_NOT_FOUND'));
  assert.equal(f.calls.archive.length,writes);assert.equal((await restarted.moduleStatus()).activeJob,null);
});

test('persisted queued, running and stopping jobs restore as interrupted, preserving results and never replaying',async t=>{
  const f=await diskFixture(t),jobsDir=path.join(f.dataDir,'archive-jobs');await fs.mkdir(jobsDir);
  const service=f.makeService();
  for(const [index,status]of ['queued','running','stopping'].entries()){
    const jobId=uuid(70+index),file=path.join(jobsDir,jobId+'.json');
    const saved={schemaVersion:1,jobId,status,total:3,completed:1,verified:[grandchild.id],submitted:[grandchild.id,child.id],
      pending:[child.id,parent.id],uncertain:[child.id],outsideScope:[],currentTitle:child.title,error:null,updatedAt:1700000000000};
    await writeJSON(file,saved);const bytes=await fs.readFile(file,'utf8');
    const restored=(await service.getJob({jobId})).job;
    assert.equal(restored.status,'interrupted');assert.deepEqual(restored.verified,[grandchild.id]);assert.deepEqual(restored.uncertain,[child.id]);
    assert.deepEqual(restored.pending,[child.id,parent.id]);assert.ok(restored.error.message);
    assert.equal(await fs.readFile(file,'utf8'),bytes);assert.equal(await service.waitForJob(jobId),null);
    await assert.rejects(service.stopJob({jobId}),code('JOB_NOT_FOUND'));
  }
  assert.deepEqual(f.calls.archive,[]);assert.equal(f.calls.lock,0);assert.equal(f.calls.loads,0);
});

test('a stopped in-flight persisted job remains stopped after restart and cannot resume its unsubmitted chats',async t=>{
  const f=await diskFixture(t);let entered;const started=new Promise(resolve=>{entered=resolve;});
  const service=f.makeService({provider:{...f.provider,archive:(id,args)=>{f.calls.archive.push({id,args});entered();return new Promise(()=>{});}}});
  const plan=await service.planArchive({chatIds:[parent.id]}),response=await service.confirmArchive({planToken:plan.planToken});
  await started;await service.stopJob({jobId:response.job.jobId});const stopped=await service.waitForJob(response.job.jobId);
  assert.equal(stopped.status,'stopped');assert.deepEqual(stopped.uncertain,[grandchild.id]);assert.equal(f.calls.archive.length,1);
  await service.dispose();const restarted=f.makeService(),restored=(await restarted.getJob({jobId:stopped.jobId})).job;
  assert.equal(restored.status,'stopped');assert.deepEqual(restored.uncertain,[grandchild.id]);assert.deepEqual(restored.verified,[]);
  await assert.rejects(restarted.confirmArchive({planToken:plan.planToken}),code('PLAN_NOT_FOUND'));
  assert.equal(await restarted.waitForJob(stopped.jobId),null);assert.equal(f.calls.archive.length,1);
});

test('initial job storage failure performs no archive and leaves the same review available for a safe retry',async t=>{
  const f=await diskFixture(t),jobsDir=path.join(f.dataDir,'archive-jobs');await fs.writeFile(jobsDir,'Owned fixture blocker');
  const service=f.makeService(),plan=await service.planArchive({chatIds:[solo.id]});
  await assert.rejects(service.confirmArchive({planToken:plan.planToken}),code('JOB_STORE_UNAVAILABLE'));
  assert.deepEqual(f.calls.archive,[]);assert.equal((await service.moduleStatus()).activeJob,null);
  // Preserve the blocker inside this owned fixture; no deletion is needed.
  await fs.rename(jobsDir,path.join(f.dataDir,'preserved-blocker.txt'));
  const response=await service.confirmArchive({planToken:plan.planToken}),job=await service.waitForJob(response.job.jobId);
  assert.equal(job.status,'completed');assert.deepEqual(f.calls.archive.map(row=>row.id),[solo.id]);
});

test('job storage failure after queuing prevents the first archive request',async t=>{
  const f=await diskFixture(t),jobsDir=path.join(f.dataDir,'archive-jobs');
  const service=f.makeService({withExecutionLock:async work=>{
    await fs.rename(jobsDir,path.join(f.dataDir,'preserved-queued-job'));await fs.writeFile(jobsDir,'Owned fixture blocker');
    return work({assertHeld(){}});
  }});
  const {job}=await submit({service},{chatIds:[parent.id]});
  assert.equal(job.status,'failed');assert.equal(job.error.code,'JOB_STORE_UNAVAILABLE');assert.deepEqual(f.calls.archive,[]);
});

test('storage failure after one confirmed commit preserves it in memory and stops later writes',async t=>{
  const f=await diskFixture(t),jobsDir=path.join(f.dataDir,'archive-jobs');let reads=0;
  const service=f.makeService({provider:{...f.provider,readStatus:async id=>{
    f.calls.status.push(id);
    if(++reads===1){await fs.rename(jobsDir,path.join(f.dataDir,'preserved-precommit-job'));await fs.writeFile(jobsDir,'Owned fixture blocker');}
    return {id,archived:true};
  }}});
  const {job}=await submit({service},{chatIds:[parent.id]});
  assert.equal(job.status,'failed');assert.equal(job.error.code,'JOB_STORE_UNAVAILABLE');assert.deepEqual(job.verified,[grandchild.id]);
  assert.deepEqual(job.pending,[child.id,parent.id]);assert.deepEqual(f.calls.archive.map(row=>row.id),[grandchild.id]);
});

function transport(t,custom={}) {
  const input=new PassThrough(),output=new PassThrough(),messages=[],calls=[];let wire='',disposed=0,htmlReads=0;
  const service={moduleStatus:async()=>({module:{archiveEnabled:true,nestingEnabled:false,independentArchive:true}}),
    listChats:async()=>({chats:[{id:solo.id,title:'Synthetic 元数据'}]}),planArchive:async args=>{calls.push({method:'plan',args});return {planToken:'synthetic-token'};},
    confirmArchive:async args=>{calls.push({method:'confirm',args});return {job:{jobId:uuid(9),status:'queued'}};},
    getJob:async()=>({job:{status:'completed'}}),stopJob:async()=>({job:{status:'stopped'}}),setModules:async args=>({module:args}),
    dispose:async()=>{disposed++;},...custom.service};
  output.on('data',chunk=>{wire+=chunk.toString('utf8');for(const line of chunk.toString('utf8').trim().split('\n'))if(line)messages.push(JSON.parse(line));});
  const server=serveArchiveStdio({service,input,output,readHtml:async()=>{htmlReads++;return '<!doctype html><title>Synthetic archive</title>';}});
  let nextId=1;
  const rpc=async(method,params)=>{const id=nextId++;await server.dispatch({jsonrpc:'2.0',id,method,...(params===undefined?{}:{params})});return messages.find(value=>value.id===id);};
  t.after(()=>server.stop());return {server,input,output,messages,calls,rpc,wire:()=>wire,disposed:()=>disposed,htmlReads:()=>htmlReads};
}

test('MCP handshake, ping, metadata tool, UI resource and visibility work without filesystem reads',async t=>{
  const f=transport(t);let response=await f.rpc('initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'synthetic',version:'1'}});
  assert.equal(response.result.protocolVersion,'2025-11-25');assert.equal(response.result.serverInfo.name,'codex-conversations-archive');
  assert.equal(f.htmlReads(),0);assert.deepEqual((await f.rpc('ping')).result,{});
  const listed=(await f.rpc('tools/list')).result.tools;assert.equal(listed.length,8);
  assert.deepEqual(listed.find(value=>value.name==='open_archive_manager')._meta.ui.visibility,['model','app']);
  for(const item of listed.filter(value=>value.name!=='open_archive_manager'))assert.deepEqual(item._meta.ui.visibility,['app']);
  assert.equal(listed.find(value=>value.name==='confirm_archive').annotations.destructiveHint,true);
  assert.deepEqual(Object.keys(listed.find(value=>value.name==='confirm_archive').inputSchema.properties),['planToken','backgroundReviewToken']);
  const resources=(await f.rpc('resources/list')).result.resources;assert.equal(resources[0].uri,UI_URI);
  const resource=(await f.rpc('resources/read',{uri:UI_URI})).result.contents[0];
  assert.equal(resource.mimeType,'text/html;profile=mcp-app');assert.ok(resource.text.includes('Synthetic archive'));
  assert.deepEqual(resource._meta.ui.csp,{connectDomains:[],resourceDomains:[]});assert.equal(f.htmlReads(),1);
  const listedChats=await f.rpc('tools/call',{name:'list_chats',arguments:{}});
  assert.equal(listedChats.result.structuredContent.chats[0].title,'Synthetic 元数据');
  assert.equal(f.wire().includes('PRIVATE_SENTINEL'),false);
});

test('MCP initialization is required, runs once and negotiates a supported fallback',async t=>{
  const f=transport(t);assert.ok((await f.rpc('tools/list')).error);
  assert.equal((await f.rpc('initialize',{protocolVersion:'unsupported'})).result.protocolVersion,'2025-11-25');
  assert.ok((await f.rpc('initialize',{})).error);
  await f.server.dispatch({jsonrpc:'2.0',method:'notifications/initialized'});
  assert.deepEqual((await f.rpc('ping')).result,{});
});

test('MCP tool arguments are routed to only the named service handler',async t=>{
  const f=transport(t);await f.rpc('initialize',{});
  await f.rpc('tools/call',{name:'plan_archive',arguments:{chatIds:[solo.id],includeDescendants:false}});
  await f.rpc('tools/call',{name:'confirm_archive',arguments:{planToken:'synthetic-token'}});
  assert.deepEqual(f.calls,[{method:'plan',args:{chatIds:[solo.id],includeDescendants:false}},{method:'confirm',args:{planToken:'synthetic-token'}}]);
});

test('MCP service errors are redacted and confined to protocol response envelopes',async t=>{
  const f=transport(t,{service:{listChats:async()=>{throw Object.assign(new Error('PRIVATE_SENTINEL'),{code:'MODULE_DISABLED'});}}});
  await f.rpc('initialize',{});const response=await f.rpc('tools/call',{name:'list_chats',arguments:{}});
  assert.equal(response.result.isError,true);assert.equal(response.result.structuredContent.error.code,'MODULE_DISABLED');
  assert.equal(f.wire().includes('PRIVATE_SENTINEL'),false);
  for(const line of f.wire().trim().split('\n'))assert.equal(JSON.parse(line).jsonrpc,'2.0');
  assert.equal(publicError(new Error('PRIVATE_SENTINEL')).message.includes('PRIVATE_SENTINEL'),false);
});

test('MCP rejects unknown resources, unknown tools and prototype-property tool names',async t=>{
  const f=transport(t);await f.rpc('initialize',{});
  assert.ok((await f.rpc('resources/read',{uri:'file:///private'})).error);
  for(const name of ['missing_tool','constructor','toString','__proto__']){
    const response=await f.rpc('tools/call',{name,arguments:{}});
    assert.ok(response.error||response.result?.isError,`Unknown tool ${name} must be rejected`);
  }
  assert.deepEqual(f.calls,[]);
});

test('unknown JSON-RPC methods return the standard method-not-found code',async t=>{
  const f=transport(t);await f.rpc('initialize',{});
  assert.equal((await f.rpc('unsupported/method')).error.code,-32601);
});

test('MCP rejects invalid argument types instead of coercing them into an archive request',async t=>{
  const f=transport(t);await f.rpc('initialize',{});
  for(const args of [{chatIds:[solo.id],includeDescendants:'false'},{chatIds:'bad'},null]){
    const response=await f.rpc('tools/call',{name:'plan_archive',arguments:args});
    assert.ok(response.error||response.result?.isError);
  }
  const response=await f.rpc('tools/call',{name:'confirm_archive',arguments:{planToken:'synthetic-token',chatIds:[parent.id]}});
  assert.ok(response.error||response.result?.isError);assert.deepEqual(f.calls,[]);
});

test('all tool schemas enforce required fields, extra-key rejection, primitive types and array bounds',async t=>{
  const f=transport(t);await f.rpc('initialize',{});
  const invalid=[
    ['open_archive_manager',{unexpected:true}],['list_chats',null],['get_module_status',{unexpected:true}],
    ['plan_archive',{}],['plan_archive',{chatIds:[]}],['plan_archive',{chatIds:Array(257).fill(solo.id)}],
    ['plan_archive',{chatIds:[7]}],['plan_archive',{chatIds:[solo.id],catalogRevision:42}],
    ['confirm_archive',{}],['confirm_archive',{planToken:42}],
    ['get_job',{}],['get_job',{jobId:7}],['stop_job',{jobId:solo.id,extra:true}],
    ['set_module_state',{}],['set_module_state',{archiveEnabled:'false'}],['set_module_state',{autostart:true}]
  ];
  for(const [name,args]of invalid){
    const response=await f.rpc('tools/call',{name,arguments:args});
    assert.equal(response.error?.code,-32602,`${name}: ${JSON.stringify(args)}`);
  }
  assert.deepEqual(f.calls,[]);
});

test('malformed JSON-RPC envelopes and params return bounded standard errors without invoking handlers',async t=>{
  const f=transport(t);
  for(const envelope of [null,[],{}, {jsonrpc:'1.0',id:1,method:'initialize'}, {jsonrpc:'2.0',id:{bad:true},method:'initialize'}]){
    const before=f.messages.length;await f.server.dispatch(envelope);
    assert.equal(f.messages.length,before+1);assert.equal(f.messages.at(-1).error.code,-32600);
  }
  await f.rpc('initialize',{});
  assert.equal((await f.rpc('tools/list',null)).error.code,-32602);
  assert.equal((await f.rpc('tools/list','bad')).error.code,-32602);
  assert.deepEqual(f.calls,[]);
});

test('malformed JSON is reported; oversized frames close the server without invoking a service',async t=>{
  const f=transport(t);f.input.write('{invalid json}\n');await tick();
  assert.equal(f.messages[0].error.code,-32700);
  f.input.write('x'.repeat(1024*1024+1));await tick();
  assert.equal(f.messages[1].error.code,-32600);assert.equal(f.disposed(),1);assert.deepEqual(f.calls,[]);
  assert.equal(f.input.listenerCount('data'),0);
});

test('stdio decoding preserves UTF-8 split across chunks and notifications emit no unsolicited logs',async t=>{
  const f=transport(t);await f.rpc('initialize',{});const before=f.messages.length;
  f.input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const wire=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:42,method:'tools/call',params:{name:'confirm_archive',arguments:{planToken:'中文'}}})+'\n');
  const split=wire.indexOf(Buffer.from('中文'))+1;f.input.write(wire.subarray(0,split));f.input.write(wire.subarray(split));await tick();
  assert.equal(f.messages.length,before+1);assert.equal(f.messages.at(-1).id,42);
  assert.equal(f.calls[0].args.planToken,'中文');
  await f.server.stop();await f.server.stop();assert.equal(f.disposed(),1);
});
