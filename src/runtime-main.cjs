'use strict';
const fs=require('node:fs/promises');
const nativeFs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {createEventIndex}=require('./event-index.cjs');
const {createPreloadRelay}=require('./preload-relay.cjs');
const run=promisify(execFile);
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TEMP=/^local:client-new-thread:[0-9a-f-]{36}$/i;
const URL='app://-/index.html';
function interaction(){
  const s=window.__codexNestedCascade?.inspect();
  return !!(s?.busy||s?.dialogOpen||s?.previewOpen||window.__codexNestedRuntime?.inspect().nativeMenuOpen||
    [...document.querySelectorAll('[role="menu"]')].some(e=>e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})));
}
function cleanExpanded(value){return Array.isArray(value)?value.filter(x=>Array.isArray(x)&&typeof x[0]==='string'&&x[0].startsWith('local:')&&UUID.test(x[0].slice(6))&&typeof x[1]==='boolean'):[];}
function cleanAliases(value){return Array.isArray(value)?value.filter(x=>Array.isArray(x)&&TEMP.test(x[0]??'')&&UUID.test(x[1]??'')):[];}
async function start(){
  const dataDir=path.resolve(process.env.CNCC_DATA_DIR||__dirname);
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
  let statusQueue=Promise.resolve(),preferenceQueue=Promise.resolve();
  const commitWaiters=new Map();let commitTimer=null;
  const expectedEdges=new Map();
  async function status(state='running',extra={}){
    const value=JSON.stringify({state,mode:'event_driven',time:new Date().toISOString(),processId:process.pid,
      ...owner,index:index?.inspect(),diagnostics,...(lastError?{error:lastError}:{}),...extra},null,2);
    statusQueue=statusQueue.catch(()=>{}).then(()=>fs.writeFile(statusFile,value));await statusQueue;
  }
  async function readJson(name,fallback){try{return JSON.parse((await fs.readFile(path.join(dataDir,name),'utf8')).replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
  function allowed(row){return row&&UUID.test(row.id??'')&&row.kind==='codex'&&(row.hostId??'local')==='local'&&relations.groups.some(g=>[g.parent,...g.children].some(n=>n.id===row.id&&n.kind==='codex'&&(n.hostId??'local')==='local'));}
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
      window.__codexNestedHostEvents?.dispose();window.__codexNestedCascade?.dispose();window.__codexNestedRuntime?.dispose();
      for(const name of ['__codexNestedOpen','__codexNestedArchiveStatus','__codexNestedNotify','__codexNestedBeginArchive','__codexNestedEndArchive'])delete window[name];
    });
    await page.exposeBinding('__codexNestedNotify',(source,payload)=>notify(source,payload));
    await page.exposeBinding('__codexNestedOpen',async(source,row)=>{
      fromPage(source);if(!allowed(row))throw Error('Chat is outside verified local relations');
      await run(python,[path.join(__dirname,'open-local-chat.py'),row.id],{env,windowsHide:true,timeout:10000});
      return {requested:true,id:row.id};
    });
    await page.exposeBinding('__codexNestedArchiveStatus',(source,row)=>{fromPage(source);return waitArchived(row);});
    await page.exposeBinding('__codexNestedBeginArchive',async(source,plan)=>{
      fromPage(source);
      if(!Array.isArray(plan?.ids)||!plan.ids.length||plan.ids.some(id=>!allowed({id,kind:'codex',hostId:'local'})))throw Error('Invalid archive scope');
      archivePages.add(source.page);archiveFrozen=true;await index.pause();return {frozen:true};
    });
    await page.exposeBinding('__codexNestedEndArchive',async(source)=>{
      fromPage(source);archivePages.delete(source.page);archiveFrozen=archivePages.size>0;if(!uiLocked&&!archiveFrozen)index.resume();requestPaint();return {released:true};
    });
    const relay=await createPreloadRelay(page);pages.set(page,{relay,signature:null});
    page.on('domcontentloaded',()=>{releasePage(page);const record=pages.get(page);if(record)record.signature=null;requestPaint();});
    page.on('close',()=>{releasePage(page);void relay.stop();pages.delete(page);requestPaint();void status();});
    return pages.get(page);
  }
  async function load(){
    const names=['nested-ui.js','cascade-actions.js','host-events.js'];
    const loaded=await Promise.all(names.map(name=>fs.readFile(path.join(__dirname,name),'utf8')));
    sources=Object.fromEntries(names.map((name,i)=>[name,loaded[i]]));
    relations=await readJson('relations.json',{schemaVersion:1,groups:[]});
    if(relations.schemaVersion!==1||!Array.isArray(relations.groups))throw Error('Invalid relation manifest');
    return JSON.stringify(relations)+Object.values(sources).join('\n');
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
  async function paint(){
    if(stopped||painting)return;painting=true;pending=false;let deferred=false;
    try{
      if(archiveFrozen){deferred=true;return;}
      const signature=await load();diagnostics=[];
      for(const context of browser.contexts())for(const page of context.pages())if(page.url()===URL){
        const record=await bindPage(page);if(!record){deferred=true;continue;}
        const relay=await record.relay.inspect();
        if(!relay.some(r=>r?.installed))throw Error('Supported native shortcut relay context was not found');
        if(record.signature===signature){diagnostics.push(await page.evaluate(()=>({...window.__codexNestedRuntime.inspect(),cascade:window.__codexNestedCascade.inspect(),events:window.__codexNestedHostEvents.inspect()})));continue;}
        const done=await page.evaluate(`(()=>{
          if((${interaction.toString()})())return false;
          window.__codexNestedRelations=${JSON.stringify(relations)};
          window.__codexNestedExpansionState=${JSON.stringify(expanded)};
          window.__codexNestedIdentityAliases=${JSON.stringify(aliases)};
          window.__codexNestedCascadeOptions={enableArchiveExecution:${options.enableArchiveExecution===true}};
          ${sources['nested-ui.js']}
          ${sources['cascade-actions.js']}
          ${sources['host-events.js']}
          return true;
        })()`);
        if(!done){deferred=true;continue;}
        record.signature=signature;
        diagnostics.push(await page.evaluate(()=>({...window.__codexNestedRuntime.inspect(),cascade:window.__codexNestedCascade.inspect(),events:window.__codexNestedHostEvents.inspect()})));
      }
      await status();
    }catch(e){lastError=e.message;await status('runtime_error');}
    finally{painting=false;if(deferred)pending=true;else if(pending)requestPaint();}
  }
  async function stop(){
    if(stopped)return;stopped=true;clearTimeout(paintTimer);clearTimeout(commitTimer);index?.stop();
    for(const w of watchers)w.close();
    for(const edge of expectedEdges.values())clearTimeout(edge.timer);
    for(const waiter of [...commitWaiters.values()])finishWaiter(waiter,null,Error('Enhancement stopped'));
    for(const [page,record]of pages){
      await record.relay.stop().catch(()=>{});
      if(!page.isClosed())await page.evaluate(()=>{
        window.__codexNestedHostEvents?.dispose();window.__codexNestedCascade?.dispose();window.__codexNestedRuntime?.dispose();
        for(const name of ['__codexNestedOpen','__codexNestedArchiveStatus','__codexNestedNotify','__codexNestedBeginArchive','__codexNestedEndArchive'])delete window[name];
      }).catch(()=>{});
    }
    await status('stopped_ui_restored');process.exit(0);
  }
  const command="$ErrorActionPreference='Stop'; $p=@(Get-AppxPackage -Name OpenAI.Codex); if($p.Count -ne 1){throw 'Official package identity ambiguous'}; $e=Join-Path $p[0].InstallLocation 'app\\ChatGPT.exe'; $l=@(Get-NetTCPConnection -State Listen -LocalPort 9347 -ErrorAction SilentlyContinue);if($l.Count -eq 0){throw 'Native endpoint not running'};foreach($v in $l){$o=Get-CimInstance Win32_Process -Filter ('ProcessId='+$v.OwningProcess);if($v.LocalAddress -notin @('127.0.0.1','::1') -or $o.ExecutablePath -ne $e){throw 'Endpoint owner mismatch'}};@{packageVersion=[string]$p[0].Version;appProcessId=$l[0].OwningProcess}|ConvertTo-Json -Compress";
  owner=JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:15000})).stdout.trim());
  const options=await readJson('runtime-options.json',{enableArchiveExecution:true});
  const preferences=await readJson('ui-preferences.json',{});expanded=cleanExpanded(preferences.expanded);aliases=cleanAliases(preferences.aliases);
  browser=await chromium.connectOverCDP('http://127.0.0.1:9347',{timeout:10000});
  browser.on('disconnected',()=>{index?.stop();for(const w of watchers)w.close();void status('official_app_closed').finally(()=>process.exit(0));});
  for(const c of browser.contexts())c.on('page',page=>{page.on('domcontentloaded',()=>requestPaint());});
  index=createEventIndex({codexHome,python,scriptPath:path.join(__dirname,'sync-relations.py'),outputPath:path.join(dataDir,'relations.json'),
    onSync:async result=>{lastError=null;await settleExpectedEdges();if(result?.changed||!pages.size)requestPaint();else void status();},onError:(e)=>{lastError=e.message;void status('index_error');},
    onFilesystemEvent:({filename})=>{if(!filename||filename.startsWith('state_5.sqlite'))signalCommit();}});
  index.start();
  const observe=(directory,handler)=>{const w=nativeFs.watch(directory,(_,name)=>handler(name&&String(name)));watchers.push(w);};
  observe(dataDir,name=>{
    if(name==='stop-request.json')void fs.stat(path.join(dataDir,name)).then(()=>stop(),()=>{});
    else if(name==='relations.json')requestPaint();
  });
  observe(__dirname,name=>{
    if(['nested-ui.js','cascade-actions.js','host-events.js'].includes(name))requestPaint();
    else if(name==='sync-relations.py')index.markDirty('index-source',{source:'manual',urgent:true});
  });
  process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
  await index.flush();requestPaint();await status('starting');
  return {stop,index,requestPaint};
}
module.exports={start,cleanExpanded,cleanAliases,interaction};
