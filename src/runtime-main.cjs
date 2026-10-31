'use strict';
const fs=require('node:fs/promises');
const nativeFs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createEventIndex}=require('./event-index.cjs');
const {createPreloadRelay}=require('./preload-relay.cjs');
const {discoverConnection}=require('./connection.cjs');
const {readModuleState,defaultSettingsDir,defaults:moduleDefaults}=require('./module-state.cjs');
const run=promisify(execFile);
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TEMP=/^local:client-new-thread:[0-9a-f-]{36}$/i;
const URL='app://-/index.html';
function interaction(){
  const inspect=name=>{try{return window[name]?.inspect?.()??{};}catch{return {};}};
  const s=inspect('__codexNestedCascade'),bulk=inspect('__codexNestedBulk'),native=inspect('__codexNestedRuntime');
  return !!(s.busy||s.dialogOpen||s.previewOpen||bulk.dialogOpen||bulk.previewPending||native.nativeMenuOpen||
    [...document.querySelectorAll('[role="menu"]')].some(e=>e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})));
}
function applyFeatureFlags(value){
  // Cancelling archive must be independent of a failed tree display update.
  if(!value.archiveEnabled){
    try{window.__codexNestedCascade?.setEnabled?.(false);}catch{}
    try{window.__codexNestedBulk?.close?.();}catch{}
  }
  try{window.__codexNestedRuntime?.setEnabled?.(value.nestingEnabled);}catch{}
}
function cleanExpanded(value){return Array.isArray(value)?value.filter(x=>Array.isArray(x)&&typeof x[0]==='string'&&x[0].startsWith('local:')&&UUID.test(x[0].slice(6))&&typeof x[1]==='boolean'):[];}
function cleanAliases(value){return Array.isArray(value)?value.filter(x=>Array.isArray(x)&&TEMP.test(x[0]??'')&&UUID.test(x[1]??'')):[];}
async function start(){
  const dataDir=path.resolve(process.env.CNCC_DATA_DIR||__dirname);
  const settingsDir=path.resolve(process.env.CNCC_SETTINGS_DIR||defaultSettingsDir());
  const codexHome=path.resolve(process.env.CNCC_CODEX_HOME||path.join(os.homedir(),'.codex'));
  const python=process.env.CNCC_PYTHON||'python';
  const env={...process.env,CNCC_DATA_DIR:dataDir,CNCC_CODEX_HOME:codexHome,PYTHONIOENCODING:'utf-8'};
  const {chromium}=require(require.resolve('playwright',{paths:[process.env.CNCC_MODULE_ROOT||__dirname]}));
  await fs.mkdir(dataDir,{recursive:true});
  const statusFile=path.join(dataDir,'runtime-status.json');
  const pages=new Map(),watchers=[];
  const interactionPages=new Set(),archivePages=new Set();
  let browser,index,owner,stopped=false,uiLocked=false,archiveFrozen=false,painting=false,pending=false,paintTimer=null;
  let relations={schemaVersion:1,groups:[]},sources={},expanded=[],aliases=[],preferencesSignature='';
  let diagnostics=[],lastError=null;
  let features={...moduleDefaults},featureError=null;
  let statusQueue=Promise.resolve(),preferenceQueue=Promise.resolve();
  const commitWaiters=new Map();let commitTimer=null;
  const expectedEdges=new Map();
  async function status(state='running',extra={}){
    if(stopped&&!state.startsWith('stop'))return;
    const value=JSON.stringify({state,mode:'event_driven',time:new Date().toISOString(),processId:process.pid,
      ...owner,features,featureError,index:index?.inspect(),diagnostics,...(lastError?{error:lastError}:{}),...extra},null,2);
    statusQueue=statusQueue.catch(()=>{}).then(async()=>{
      await fs.writeFile(statusFile,value);
      if(settingsDir!==dataDir){
        await fs.mkdir(settingsDir,{recursive:true});
        const nativeState=!features.nestingEnabled?'disabled':diagnostics.some(row=>row.modules?.nesting?.state==='ready')?'ready':'unavailable';
        await fs.writeFile(path.join(settingsDir,'native-runtime-status.json'),JSON.stringify({state,processId:process.pid,nativeState,time:new Date().toISOString()}));
      }
    });await statusQueue;
  }
  async function readJson(name,fallback){try{return JSON.parse((await fs.readFile(path.join(dataDir,name),'utf8')).replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
  function allowed(row){return row&&UUID.test(row.id??'')&&row.kind==='codex'&&(row.hostId??'local')==='local'&&
    (Array.isArray(relations.catalog)?relations.catalog:relations.groups.flatMap(g=>[g.parent,...g.children]))
      .some(n=>n.id===row.id&&n.kind==='codex'&&(n.hostId??'local')==='local');}
  function fromPage(source){if(source.frame!==source.page.mainFrame()||source.page.url()!==URL)throw Error('Unsupported event source');}
  function releasePage(page){
    interactionPages.delete(page);archivePages.delete(page);
    uiLocked=interactionPages.size>0;archiveFrozen=archivePages.size>0;
    if(!uiLocked&&!archiveFrozen)index?.resume();
  }
  async function readArchived(row){const r=await run(python,[path.join(__dirname,'chat-is-archived.py'),row.id],{env,windowsHide:true,timeout:3000});return JSON.parse(r.stdout.trim());}
  function finishWaiter(waiter,result,error){clearTimeout(waiter.timer);commitWaiters.delete(waiter.row.id);if(error)waiter.reject(error);else waiter.resolve(result);}
  async function checkCommits(){
    commitTimer=null;
    for(const waiter of [...commitWaiters.values()]){
      if(waiter.reading){waiter.dirty=true;continue;}
      waiter.reading=true;waiter.dirty=false;
      try{const r=await readArchived(waiter.row);if(r.archived===true)finishWaiter(waiter,r);}
      catch(e){finishWaiter(waiter,null,e);}
      finally{waiter.reading=false;if(waiter.dirty&&commitWaiters.has(waiter.row.id))signalCommit();}
    }
  }
  function signalCommit(){if(commitWaiters.size&&!commitTimer)commitTimer=setTimeout(()=>void checkCommits(),25);}
  function waitArchived(row){
    if(!allowed(row))throw Error('Chat is outside verified local relations');
    if(commitWaiters.has(row.id))throw Error('Archive verification already pending');
    return new Promise((resolve,reject)=>{
      const waiter={row,resolve,reject,reading:false,dirty:false,timer:null};
      waiter.timer=setTimeout(()=>finishWaiter(waiter,null,Error('No archive commit was observed')),7000);
      commitWaiters.set(row.id,waiter);signalCommit();
    });
  }
  async function savePreferences(payload){
    expanded=cleanExpanded(payload.expanded);aliases=cleanAliases(payload.aliases);
    const value=JSON.stringify({schemaVersion:1,expanded,aliases});
    if(value===preferencesSignature)return;
    preferenceQueue=preferenceQueue.catch(()=>{}).then(async()=>{
      await fs.writeFile(path.join(dataDir,'ui-preferences.tmp.json'),value);
      await fs.rename(path.join(dataDir,'ui-preferences.tmp.json'),path.join(dataDir,'ui-preferences.json'));
    });await preferenceQueue;
    preferencesSignature=value;
  }
  async function notify(source,payload){
    fromPage(source);if(!payload||typeof payload.reason!=='string')return;
    switch(payload.reason){
      case 'native':
        if(typeof payload.method!=='string')return;
        if(payload.method==='thread/archived')signalCommit();
        if(UUID.test(payload.edge?.parentId??'')&&UUID.test(payload.edge?.childId??'')) {
          const key=payload.edge.parentId+'>'+payload.edge.childId;
          if(!expectedEdges.has(key))expectedEdges.set(key,{...payload.edge,attempt:0,timer:null});
        }
        index.markDirty('native:'+payload.method,{source:'native',urgent:true});break;
      case 'membership':index.markDirty('sidebar-membership',{source:'ui'});break;
      case 'focus':index.markDirty('window-focus',{source:'ui'});requestPaint();break;
      case 'preferences':await savePreferences(payload);break;
      case 'interaction':{
        if(payload.busy||payload.dialogOpen||payload.previewOpen||payload.menuOpen)interactionPages.add(source.page);else interactionPages.delete(source.page);
        uiLocked=interactionPages.size>0;
        if(uiLocked)await index.pause();else if(!archiveFrozen){index.resume();requestPaint();}
        break;
      }
      default:return;
    }
    await status();
  }
  async function bindPage(page){
    if(pages.has(page))return pages.get(page);
    if(await page.evaluate(interaction))return null;
    await page.evaluate(()=>{
      for(const name of ['__codexNestedHostEvents','__codexNestedBulk','__codexNestedCascade','__codexNestedRuntime']){try{window[name]?.dispose?.();}catch{}delete window[name];}
      for(const name of ['__codexNestedOpen','__codexNestedArchiveStatus','__codexNestedNotify','__codexNestedBeginArchive','__codexNestedEndArchive','__codexNestedValidateArchive','__codexNestedBatchArchive','__codexInstallConversationModules','__codexConversationModuleStatus','__codexNestedUiOptions','__codexNestedCascadeOptions'])delete window[name];
    });
    await page.exposeBinding('__codexNestedNotify',(source,payload)=>notify(source,payload));
    let batch;
    try{batch=require('./toolbar-archive.cjs').createToolbarArchive({
      canWrite:()=>!stopped&&features.archiveEnabled&&options.enableArchiveExecution===true,
      serviceFactory:()=>{
        const desktopRequest=require('./desktop-archive.cjs').createDesktopRequest(page);
        const provider=require('./archive-app-server.cjs').createArchiveAppServer({codexHome,python,desktopRequest});
        return require('./archive-server.cjs').createArchiveService({dataDir:settingsDir,settingsDir,codexHome,python,provider});
      }
    });}catch{batch={call(){throw Error('批量归档组件未加载，请检查安装文件。');},async dispose(){}};}
    await page.exposeBinding('__codexNestedBatchArchive',async(source,action,input)=>{
      fromPage(source);
      try {return {ok:true,value:await batch.call(action,input)};}
      catch(error){
        let message='批量归档组件无法连接，请检查安装文件。';
        if(!error.code)message=error.message;
        else try{message=require('./archive-server.cjs').publicError(error).message;}catch{}
        return {ok:false,message,code:error.code||'TOOLBAR_ARCHIVE_UNAVAILABLE'};
      }
    });
    await page.exposeBinding('__codexNestedOpen',async(source,row)=>{
      fromPage(source);if(!allowed(row))throw Error('Chat is outside verified local relations');
      await run(python,[path.join(__dirname,'open-local-chat.py'),row.id],{env,windowsHide:true,timeout:10000});
      return {requested:true,id:row.id};
    });
    await page.exposeBinding('__codexNestedArchiveStatus',(source,row)=>{fromPage(source);return waitArchived(row);});
    await page.exposeBinding('__codexNestedValidateArchive',async(source)=>{
      fromPage(source);
      if(!features.archiveEnabled)throw Error('Archive module is disabled');
      if(!archivePages.has(source.page))throw Error('Archive scope validation requires an active operation');
      const result=await run(python,[path.join(__dirname,'sync-relations.py'),'--codex-home',codexHome,'--manifest-stdout'],{env,windowsHide:true,timeout:15000,maxBuffer:4*1024*1024});
      const snapshot=JSON.parse(result.stdout.trim());
      if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.groups)||!Array.isArray(snapshot.catalog))throw Error('Fresh local chat catalog is unavailable');
      return snapshot;
    });
    await page.exposeBinding('__codexNestedBeginArchive',async(source,plan)=>{
      fromPage(source);
      if(!features.archiveEnabled)throw Error('Archive module is disabled');
      if(!Array.isArray(plan?.ids)||!plan.ids.length||plan.ids.some(id=>!allowed({id,kind:'codex',hostId:'local'})))throw Error('Invalid archive scope');
      archivePages.add(source.page);archiveFrozen=true;await index.pause();return {frozen:true};
    });
    await page.exposeBinding('__codexNestedEndArchive',async(source)=>{
      fromPage(source);archivePages.delete(source.page);archiveFrozen=archivePages.size>0;if(!uiLocked&&!archiveFrozen)index.resume();requestPaint();return {released:true};
    });
    let relay,relayError=null;
    try{relay=await createPreloadRelay(page);}catch(error){relayError=error.message;relay={inspect:async()=>[],stop:async()=>({restored:true,errors:[]})};}
    pages.set(page,{relay,relayError,batch,signature:null});
    page.on('domcontentloaded',()=>{releasePage(page);const record=pages.get(page);if(record)record.signature=null;requestPaint();});
    page.on('close',()=>{releasePage(page);void batch.dispose();void relay.stop();pages.delete(page);requestPaint();void status();});
    return pages.get(page);
  }
  async function load(){
    const names=['nested-ui.js','cascade-actions.js','bulk-archive.js','host-events.js','ui-modules.js'];
    const loaded=await Promise.allSettled(names.map(name=>fs.readFile(path.join(__dirname,name),'utf8')));
    sources=Object.fromEntries(names.map((name,i)=>[name,loaded[i].status==='fulfilled'?loaded[i].value:null]));
    if(typeof sources['ui-modules.js']!=='string')throw Error('The shared UI module loader is unavailable');
    try{features=await readModuleState(settingsDir);featureError=null;}catch(error){featureError=error.message;features={...features,archiveEnabled:false};}
    relations=await readJson('relations.json',{schemaVersion:1,groups:[]});
    if(relations.schemaVersion!==1||!Array.isArray(relations.groups))throw Error('Invalid relation manifest');
    return JSON.stringify(relations)+JSON.stringify(features)+Object.values(sources).join('\n');
  }
  async function settleExpectedEdges(){
    const current=await readJson('relations.json',{groups:[]});
    for(const [key,edge]of expectedEdges){
      if(current.groups.some(g=>g.parent.id===edge.parentId&&g.children.some(c=>c.id===edge.childId))){clearTimeout(edge.timer);expectedEdges.delete(key);continue;}
      if(edge.timer)continue;
      const delays=[60,180,450,1000];
      if(edge.attempt>=delays.length){lastError='A completed creation event is not reflected in the local relation index';expectedEdges.delete(key);continue;}
      edge.timer=setTimeout(()=>{edge.timer=null;index.markDirty('creation-commit-settle',{source:'native',urgent:true});},delays[edge.attempt++]);
    }
  }
  function requestPaint(){if(stopped)return;pending=true;if(!painting&&!paintTimer)paintTimer=setTimeout(()=>{paintTimer=null;void paint();},25);}
  function inspectPage(){
    const inspect=name=>{try{return window[name]?.inspect?.();}catch{return {installed:false,errors:['Component state is unavailable']};}};
    const native=inspect('__codexNestedRuntime')??{installed:false,errors:[]};
    const modules=window.__codexConversationModuleStatus;
    return {...native,installed:!!native.installed||modules?.archive?.state==='ready',modules,
      cascade:inspect('__codexNestedCascade'),bulk:inspect('__codexNestedBulk'),events:inspect('__codexNestedHostEvents')};
  }
  async function paint(){
    if(stopped||painting)return;painting=true;pending=false;let deferred=false;
    try{
      if(archiveFrozen){deferred=true;return;}
      const signature=await load();diagnostics=[];
      for(const context of browser.contexts())for(const page of context.pages())if(page.url()===URL){
        const record=await bindPage(page);if(!record){deferred=true;continue;}
        const relay=await record.relay.inspect().catch(()=>[]);
        const shortcutReady=relay.some(r=>r?.installed);
        if(record.signature===signature){diagnostics.push(await page.evaluate(inspectPage));continue;}
        const payload={sources,relations,expanded,aliases,features,archiveExecution:options.enableArchiveExecution===true,shortcutReady};
        const done=await page.evaluate(`(()=>{
          if((${interaction.toString()})())return false;
          ${sources['ui-modules.js']}
          window.__codexInstallConversationModules(${JSON.stringify(payload)});
          return true;
        })()`);
        if(!done){deferred=true;continue;}
        record.signature=signature;
        diagnostics.push(await page.evaluate(inspectPage));
      }
      await status();
    }catch(e){lastError=e.message;await status('runtime_error');}
    finally{painting=false;if(deferred)pending=true;else if(pending)requestPaint();}
  }
  async function stop(requestId=null){
    if(stopped)return;stopped=true;clearTimeout(paintTimer);clearTimeout(commitTimer);index?.stop();
    for(const w of watchers)w.close();
    for(const edge of expectedEdges.values())clearTimeout(edge.timer);
    for(const waiter of [...commitWaiters.values()])finishWaiter(waiter,null,Error('Enhancement stopped'));
    const cleanup=[];
    for(const [page,record]of pages){
      await record.batch?.dispose();
      if(page.isClosed()){cleanup.push({closed:true,restored:true});continue;}
      const result={url:page.url(),restored:false,errors:[]};
      try {const relay=await record.relay.stop();if(!relay?.restored)result.errors.push(...(relay?.errors??['Native relay cleanup was not verified']));}
      catch(error){if(!page.isClosed())result.errors.push(error.message);}
      try {
        if(page.isClosed()){result.closed=true;result.restored=result.errors.length===0;}
        else {
          const remaining=await page.evaluate(()=>{
            const errors=[];
            for(const name of ['__codexNestedHostEvents','__codexNestedBulk','__codexNestedCascade','__codexNestedRuntime']){try{window[name]?.dispose?.();}catch(error){errors.push(String(error.message??error).slice(0,200));}delete window[name];}
            for(const name of ['__codexNestedOpen','__codexNestedArchiveStatus','__codexNestedNotify','__codexNestedBeginArchive','__codexNestedEndArchive','__codexNestedValidateArchive','__codexNestedBatchArchive','__codexInstallConversationModules','__codexConversationModuleStatus','__codexNestedUiOptions','__codexNestedCascadeOptions'])delete window[name];
            return {ownedNodes:document.querySelectorAll('[data-codex-nested-owned],[data-codex-nested-cascade-owned],[data-codex-nested-bulk-owned]').length,
              hiddenRows:document.querySelectorAll('[data-codex-nested-flat-hidden]').length,disposeErrors:errors};
          });
          result.errors.push(...remaining.disposeErrors);
          Object.assign(result,remaining);result.restored=!remaining.ownedNodes&&!remaining.hiddenRows&&result.errors.length===0;
        }
      }catch(error){if(page.isClosed()){result.closed=true;result.restored=result.errors.length===0;}else result.errors.push(error.message);}
      cleanup.push(result);
    }
    const restored=cleanup.every(row=>row.restored);
    await status(restored?'stopped_ui_restored':'stop_incomplete',{stopRequestId:requestId,cleanup});process.exit(restored?0:1);
  }
  const connection=await discoverConnection();
  owner={packageVersion:connection.packageVersion,appProcessId:connection.appProcessId,transport:connection.transport};
  const options=await readJson('runtime-options.json',{enableArchiveExecution:true});
  const preferences=await readJson('ui-preferences.json',{});expanded=cleanExpanded(preferences.expanded);aliases=cleanAliases(preferences.aliases);
  browser=await chromium.connectOverCDP(connection.endpointUrl,{timeout:10000});
  browser.on('disconnected',()=>{index?.stop();for(const w of watchers)w.close();void status('official_app_closed').finally(()=>process.exit(0));});
  for(const c of browser.contexts())c.on('page',page=>{page.on('domcontentloaded',()=>requestPaint());});
  index=createEventIndex({codexHome,python,scriptPath:path.join(__dirname,'sync-relations.py'),outputPath:path.join(dataDir,'relations.json'),
    onSync:async result=>{lastError=null;await settleExpectedEdges();if(result?.changed||!pages.size)requestPaint();else void status();},onError:(e)=>{lastError=e.message;void status('index_error');},
    onFilesystemEvent:({filename})=>{if(!filename||filename.startsWith('state_5.sqlite'))signalCommit();}});
  index.start();
  const observe=(directory,handler)=>{const w=nativeFs.watch(directory,(_,name)=>handler(name&&String(name)));watchers.push(w);};
  async function updateFeatures(){
    try{features=await readModuleState(settingsDir);featureError=null;}catch(error){featureError=error.message;features={...features,archiveEnabled:false};}
    for(const [page,record] of pages){
      if(!features.archiveEnabled)record.batch?.invalidate?.();
      if(!page.isClosed())await page.evaluate(applyFeatureFlags,features).catch(()=>{});
    }
    requestPaint();
  }
  observe(dataDir,name=>{
    if(name==='stop-request.json')void readJson(name,null).then(value=>{
      if(typeof value?.requestId==='string'&&UUID.test(value.requestId))return stop(value.requestId);
    }).catch(()=>{});
    else if(name==='relations.json')requestPaint();
    else if(name==='module-state.json')void updateFeatures();
  });
  if(settingsDir!==dataDir){await fs.mkdir(settingsDir,{recursive:true});observe(settingsDir,name=>{if(name==='module-state.json')void updateFeatures();});}
  observe(__dirname,name=>{
    if(['nested-ui.js','cascade-actions.js','bulk-archive.js','host-events.js','ui-modules.js'].includes(name))requestPaint();
    else if(name==='sync-relations.py')index.markDirty('index-source',{source:'manual',urgent:true});
  });
  process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
  await index.flush();requestPaint();await status('starting');
  return {stop,index,requestPaint};
}
module.exports={start,cleanExpanded,cleanAliases,interaction,applyFeatureFlags};
