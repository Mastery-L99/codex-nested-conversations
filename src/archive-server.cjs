'use strict';
// Official local MCP App: no renderer connection, loader, startup service,
// conversation generation, or direct database writes are used by this server.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {StringDecoder}=require('node:string_decoder');
const {createModuleStore,defaultDataDir,defaultSettingsDir}=require('./module-state.cjs');
const {createScope,executeScope,assessProviderCapabilities,classify}=require('./archive-core.cjs');
const {createArchiveAppServer,backgroundTitle}=require('./archive-app-server.cjs');
const {withNamedMutex}=require('./windows-mutex.cjs');
const run=promisify(execFile);
const UI_URI='ui://codex-conversations/archive-manager';
const NESTING_URI='ui://codex-conversations/nested-chats';
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const active=new Set(['queued','running','stopping']);
function fail(code,message){return Object.assign(new Error(message),{code});}
function hash(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
async function launchDesktopChat(id){
  if(process.platform!=='win32'||!UUID.test(id))throw fail('DESKTOP_OPEN_FAILED');
  // The argument is already a catalogued local UUID. Only the official AppX
  // family receives the request, even if another app registered this scheme.
  const script=`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.System.Launcher,Windows.System,ContentType=WindowsRuntime]
$options=[Windows.System.LauncherOptions,Windows.System,ContentType=WindowsRuntime]::new()
$options.TargetApplicationPackageFamilyName='OpenAI.Codex_2p2nqsd0c76g0'
$operation=[Windows.System.Launcher]::LaunchUriAsync([Uri]('codex://threads/'+$env:CNCC_OPEN_CHAT_ID),$options)
$asTask=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1' } | Select-Object -First 1
$task=$asTask.MakeGenericMethod([bool]).Invoke($null,@($operation))
if(!$task.GetAwaiter().GetResult()){throw 'The desktop did not accept this link'}
`;
  await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {windowsHide:true,timeout:15000,env:{...process.env,CNCC_OPEN_CHAT_ID:id}});
}
function publicError(error){
  const code=typeof error?.code==='string'?error.code:'ARCHIVE_UNAVAILABLE';
  if(code==='APP_SERVER_RPC_FAILED'&&error.details){
    const raw=error.details;
    const steps={initialize:'连接桌面服务', 'thread/read':'读取对话', 'thread/archive':'提交归档'};
    const reasons={
      active_writer:'另一个 Codex 进程持有这次归档涉及的聊天。请从持有聊天的桌面窗口打开“批量归档”，重新检查范围。',
      not_loaded:'这条聊天尚未保存为当前服务可以读取的会话。请先在创建它的窗口查看。',
      file_in_use:'Windows 报告会话文件正被占用。请先结束正在使用该文件的操作。',
      access_denied:'Windows 拒绝访问会话文件。请检查该文件的访问权限。',
      not_found:'官方程序找不到这次操作所需的聊天或会话文件。请刷新聊天列表。',
      outside_sessions:'官方程序判断会话文件不在可归档的目录中。',
      database_busy:'本机聊天数据库正在使用中。请等当前写入结束后重新检查。',
      unknown:'官方程序未提供可识别的原因。'
    };
    const method=Object.hasOwn(steps,raw.method)?raw.method:null;
    const reason=Object.hasOwn(reasons,raw.reason)?raw.reason:'unknown';
    const nativeCode=Number.isSafeInteger(raw.nativeCode)?raw.nativeCode:null;
    const osCode=Number.isSafeInteger(raw.osCode)?raw.osCode:null;
    const codes=[nativeCode===null?null:'RPC '+nativeCode,osCode===null?null:'系统错误 '+osCode].filter(Boolean);
    return {code,details:{method,reason,nativeCode,osCode},message:(steps[method]||'归档操作')+'失败。'+reasons[reason]+(codes.length?'（'+codes.join('，')+'）':'')};
  }
  const messages={MODULE_DISABLED:'批量归档已关闭，可在上方独立开启。',PLAN_EXPIRED:'归档范围已过期，请重新检查。',
    PLAN_USED:'这个确认范围已使用，请重新选择。',SCOPE_CHANGED:'聊天或下级范围有变化，请重新检查。',
    RELATIONS_UNAVAILABLE:'层级读取暂不可用，可取消包含下级，仅归档勾选聊天。',JOB_BUSY:'另一个归档任务正在执行，请稍后重试。',
    JOB_NOT_FOUND:'没有找到这个归档任务，请刷新面板。',PLAN_NOT_FOUND:'没有找到这个确认范围，请重新选择。',
    IMPLICIT_SCOPE_UNREVIEWED:'官方归档还会影响来源无法识别的记录，暂不能提交这个范围。',
    UNSELECTED_CHAT_DESCENDANT:'官方归档还会影响未选中的普通聊天，请将该聊天加入选择后重新检查。',
    BACKGROUND_SCOPE_CHANGED:'后台子任务的范围或名称已变化，请重新检查归档清单。',
    BACKGROUND_REVIEW_REQUIRED:'请在新版确认页查看后台子任务清单后再提交。旧确认页需要关闭后重新打开。',
    implicit_archive_not_confirmed:'聊天的归档已提交，但部分后台子任务尚未确认归档。请查看进度中的两类结果。',
    APP_SERVER_RPC_FAILED:'官方程序拒绝了这次归档请求。请检查当前聊天的状态，其他聊天不会继续提交。',
    APP_SERVER_TIMEOUT:'官方程序未在时限内返回结果，请先检查当前聊天是否已归档。',
    DESKTOP_ARCHIVE_UNAVAILABLE:'当前窗口无法连接桌面归档服务。请关闭归档面板，重新打开后再检查范围。',
    DESKTOP_TURN_ACTIVE:'当前聊天或它的下级仍在执行任务，已在提交前停止。请等任务结束后重新检查范围。',
    OFFICIAL_APP_SERVER_UNAVAILABLE:'未找到可用的官方 Codex 程序，请检查桌面客户端是否安装正常。',
    THREAD_NOT_FOUND:'当前聊天已不在本机目录中，请刷新后重新选择。',
    NESTING_DISABLED:'嵌套对话已关闭。可在批量归档面板的功能开关中开启。',
    NESTING_CATALOG_UNAVAILABLE:'未能读取本机聊天目录。请检查桌面端能否找到 Python，以及本机 Codex 数据是否可用。',
    DESKTOP_OPEN_FAILED:'Windows 未能打开这个聊天。可在官方客户端查找下方的聊天 ID。',
    READ_ONLY_DATABASE_UNAVAILABLE:'暂时无法读取本机聊天状态，请稍后重新检查范围。',
    IMPLICIT_DESCENDANTS_OUTSIDE_SCOPE:'提交前发现确认清单以外的下级记录，已停止。请重新检查范围。',
    scope_limit:'聊天和后台子任务合计超过 256 条，请缩小范围后分批处理。',
    ineligible_chat:'所选聊天已经归档或已移出本机目录，请重新选择。',
    JOB_STORE_UNAVAILABLE:'归档进度无法保存，已停止后续操作。请先检查已完成项。',
    scope_changed:'聊天或下级范围有变化，尚未提交归档，请重新检查。',
    archive_not_confirmed:'当前聊天的归档结果暂未得到确认，已停止后续操作。',
    outside_confirmed_scope:'发现确认范围以外的变化，已停止后续操作，请检查结果。',
    action_timeout:'当前操作响应超时，已停止后续操作；请先检查结果。',
    cancelled:'已停止后续归档，已经完成的聊天会保留归档状态。'};
  return {code,message:messages[code]||'归档模块暂时无法完成操作，请刷新状态后重试。'};
}
function createArchiveService(options={}){
  const dataDir=path.resolve(options.dataDir||process.env.CNCC_DATA_DIR||defaultDataDir());
  const codexHome=path.resolve(options.codexHome||process.env.CNCC_CODEX_HOME||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
  const python=options.python||process.env.CNCC_PYTHON||'python';
  const settingsDir=options.settingsDir||process.env.CNCC_SETTINGS_DIR||(options.dataDir?dataDir:defaultSettingsDir());
  const store=options.store||createModuleStore({dataDir:settingsDir});
  const provider=options.provider||createArchiveAppServer({codexHome,python});
  const now=options.now||Date.now;
  const plans=new Map(),jobs=new Map();let closed=false,lastJob=null,persistQueue=Promise.resolve();
  const readManifest=options.loadManifest||(async()=>{
    const result=await run(python,[path.join(__dirname,'archive-catalog.py'),'--codex-home',codexHome],{windowsHide:true,timeout:15000,maxBuffer:8*1024*1024,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
    return JSON.parse(result.stdout.trim());
  });
  const lock=options.withExecutionLock||((work)=>withNamedMutex('Local\\CnccArchive-'+hash(codexHome.toLowerCase()).slice(0,32),work));
  async function enabled(){if(closed)throw fail('SERVER_STOPPED');const value=await store.read();if(!value.archiveEnabled)throw fail('MODULE_DISABLED');return value;}
  function cleanPlans(){for(const [token,plan]of plans)if(plan.expiresAt<=now())plans.delete(token);}
  async function moduleStatus(){
    const settings=await store.read();let nativeState='unavailable';
    try{let contents;try{contents=await fs.readFile(path.join(settingsDir,'native-runtime-status.json'),'utf8');}
      catch{contents=await fs.readFile(path.join(dataDir,'runtime-status.json'),'utf8');}
      const status=JSON.parse(contents.replace(/^\uFEFF/,''));
      if(status.state==='running'&&Number.isInteger(status.processId)){try{process.kill(status.processId,0);nativeState=status.nativeState||
        (status.diagnostics?.some(row=>row.modules?.nesting?.state==='ready')?'ready':'unavailable');}catch{}}
    }catch{}
    if(!settings.nestingEnabled)nativeState='disabled';
    return {module:{state:settings.archiveEnabled?'ready':'disabled',archiveEnabled:settings.archiveEnabled,
      nestingEnabled:settings.nestingEnabled,archiveState:settings.archiveEnabled?'ready':'disabled',nativeState,
      independentArchive:true,revision:settings.revision},activeJob:lastJob?viewJob(jobs.get(lastJob)):null};
  }
  async function listChats(){
    const manifest=await readManifest();
    if(manifest?.schemaVersion!==1||!Array.isArray(manifest.catalog)||!Array.isArray(manifest.groups))throw fail('INVALID_MANIFEST');
    const parents=new Map();for(const group of manifest.groups){
      if(!group?.parent||!UUID.test(group.parent.id||'')||!Array.isArray(group.children))continue;
      for(const child of group.children)if(child&&UUID.test(child.id||'')&&!parents.has(child.id))parents.set(child.id,group.parent.id);
    }
    // Keep this boundary narrow even when an upstream catalog grows fields.
    // Conversation text, transcript paths and arbitrary provider data must not
    // become visible to the MCP app through an object spread.
    const timestamp=value=>Number.isFinite(value)&&value>0?value:null;
    const chats=manifest.catalog.filter(chat=>classify(chat)==='eligible').map(chat=>({
      id:chat.id,title:chat.title,kind:'codex',hostId:'local',threadSource:chat.threadSource??chat.thread_source??null,
      eligibility:'eligible',createdAtMs:timestamp(chat.createdAtMs),updatedAtMs:timestamp(chat.updatedAtMs),parentId:parents.get(chat.id)||null
    }));
    const status=await moduleStatus();
    if(manifest.relationsAvailable===false)status.module.message=manifest.relationMessage||'层级读取暂不可用，可取消包含下级，仅归档勾选聊天。';
    return {...status,chats,relationsAvailable:manifest.relationsAvailable!==false,relationCoverage:manifest.relationCoverage,
      catalogRevision:hash(chats.map(chat=>[chat.id,chat.title,chat.parentId,chat.createdAtMs,chat.threadSource]))};
  }
  async function listNestedChats(){
    if(closed)throw fail('SERVER_STOPPED');
    if(!(await store.read()).nestingEnabled)return {enabled:false,chats:[],relationsAvailable:false};
    let data;try{data=await listChats();}catch{throw fail('NESTING_CATALOG_UNAVAILABLE');}
    if(!data.module.nestingEnabled)return {enabled:false,chats:[],relationsAvailable:false};
    return {enabled:true,relationsAvailable:data.relationsAvailable,relationCoverage:data.relationCoverage,
      chats:data.chats.map(({id,title,parentId})=>({id,title,parentId}))};
  }
  async function openNestedChat({chatId}){
    if(!UUID.test(chatId))throw fail('THREAD_NOT_FOUND');
    const catalog=await listNestedChats();
    if(!catalog.enabled)throw fail('NESTING_DISABLED');
    const chat=catalog.chats.find(item=>item.id===chatId);
    if(!chat)throw fail('THREAD_NOT_FOUND');
    if(closed||!(await store.read()).nestingEnabled)throw fail('NESTING_DISABLED');
    try{await (options.launchChat||launchDesktopChat)(chat.id);}catch{throw fail('DESKTOP_OPEN_FAILED');}
    return {requestedChatId:chat.id};
  }
  async function collectBackground(scope,signal){
    const explicit=new Set(scope.items.map(chat=>chat.id));
    const records=new Map(),byChat=Object.create(null);
    // Use bounded parallel reads. Planning only inspects metadata and does
    // not start model turns or archive any thread.
    for(let offset=0;offset<scope.items.length;offset+=4){
      if(signal?.aborted)throw fail('cancelled');
      const chunk=scope.items.slice(offset,offset+4);
      const snapshots=await Promise.all(chunk.map(chat=>{
        if(typeof provider.readScope==='function')return provider.readScope(chat.id,{signal});
        if(provider.capabilities?.archiveMayCascade===false)return {spawnedDescendants:[]};
        throw fail('IMPLICIT_SCOPE_UNREVIEWED');
      }));
      for(const [i,chat] of chunk.entries()){
        const children=snapshots[i]?.spawnedDescendants;
        if(!Array.isArray(children))throw fail('IMPLICIT_SCOPE_UNREVIEWED');
        const owned=[];
        for(const row of children){
          if(!row||typeof row.archived!=='boolean'||!UUID.test(row.id||''))throw fail('IMPLICIT_SCOPE_UNREVIEWED');
          const id=row.id.toLowerCase();
          if(row.archived||explicit.has(id))continue;
          const title=backgroundTitle(row);
          if(!title)throw fail(['user','agent_created_thread','agent_forked_thread','voice_chat','realtime_voice'].includes(row.threadSource)
            ?'UNSELECTED_CHAT_DESCENDANT':'IMPLICIT_SCOPE_UNREVIEWED');
          const depth=Number.isSafeInteger(row.depth)&&row.depth>0?row.depth:1;
          const old=records.get(id);
          if(old&&old.title!==title)throw fail('BACKGROUND_SCOPE_CHANGED');
          if(!old||depth<old.depth||(depth===old.depth&&chat.id<old.parentId)){
            records.set(id,{id,title,parentId:chat.id,parentTitle:chat.title||chat.id,depth});
          }
          owned.push(Object.freeze({id,title}));
          if(records.size+explicit.size>scope.maxChats)throw fail('scope_limit');
        }
        byChat[chat.id]=Object.freeze(owned.sort((a,b)=>a.id.localeCompare(b.id)));
      }
    }
    const items=Object.freeze([...records.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(({depth,...item})=>Object.freeze(item)));
    return Object.freeze({items,byChat:Object.freeze(byChat),signature:hash([items,byChat])});
  }
  async function planArchive(args={}){
    await enabled();cleanPlans();
    if([...jobs.values()].some(job=>active.has(job.status)))throw fail('JOB_BUSY');
    const manifest=await readManifest(),includeDescendants=args.includeDescendants!==false;
    if(manifest.relationsAvailable===false&&includeDescendants)throw fail('RELATIONS_UNAVAILABLE');
    const scope=createScope(manifest,args.chatIds,{includeDescendants});
    const background=await collectBackground(scope);
    const confirmed=new Set(scope.items.map(chat=>chat.id));
    if(plans.size>=64)throw fail('TOO_MANY_PLANS');
    const capabilities=assessProviderCapabilities(provider),expiresAt=now()+5*60*1000;
    const warnings=capabilities.nonAtomicScopeRisk?
      ['将调用官方归档接口。它可能同时整理所选任务的后台运行记录；提交前会再次检查范围，发现变化会停止。其他窗口的并发新建无法由本操作锁定。']:[];
    // Older panels only send the chat token. They must not confirm tasks
    // they did not display, even if a current server supplied the review.
    const backgroundReviewToken=background.items.length?crypto.randomUUID():null;
    plans.set(scope.token,{scope,background,backgroundReviewToken,expiresAt,used:false,disclosedRisk:capabilities.nonAtomicScopeRisk});
    const parents=new Map();
    for(const group of manifest.groups)if(confirmed.has(group.parent?.id)){
      for(const child of group.children||[])if(confirmed.has(child?.id)&&!parents.has(child.id))parents.set(child.id,group.parent.id);
    }
    return {planToken:scope.token,expiresAt,totalCount:scope.items.length,rootCount:scope.selectedIds.length,
      includeDescendants,items:scope.items.map(chat=>({...chat,parentId:parents.get(chat.id)||null})),
      implicitCount:background.items.length,implicitItems:background.items,...(backgroundReviewToken?{backgroundReviewToken}:{}),warnings,capabilities};
  }
  function viewJob(job){
    if(!job)return null;
    const snapshot=job.snapshot||{};
    return {jobId:job.id,status:job.status,total:job.scope.items.length,completed:snapshot.confirmedIds?.length||0,
      verified:snapshot.confirmedIds||[],submitted:snapshot.submittedIds||[],pending:snapshot.pendingIds||job.scope.items.map(chat=>chat.id),
      implicitTotal:job.implicitIds.length,verifiedImplicit:snapshot.verifiedImplicitIds||[],
      pendingImplicit:snapshot.pendingImplicitIds||job.implicitIds,
      uncertain:snapshot.uncertainIds||[],outsideScope:snapshot.outsideScopeIds||[],
      currentTitle:job.scope.items.find(chat=>chat.id===snapshot.currentId)?.title||'',error:job.error||snapshot.error||null};
  }
  async function persist(job){
    if(options.persist===false)return;
    const dir=path.join(dataDir,'archive-jobs');
    const value={schemaVersion:1,...viewJob(job),updatedAt:now()};
    persistQueue=persistQueue.catch(()=>{}).then(async()=>{
      await fs.mkdir(dir,{recursive:true});const file=path.join(dir,job.id+'.json');
      const temporary=path.join(dir,'.'+job.id+'-'+crypto.randomUUID()+'.json');
      await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await fs.rename(temporary,file);
    });await persistQueue;
  }
  async function confirmArchive(args={}){
    await enabled();
    const review=plans.get(args.planToken);
    if(!review)throw fail('PLAN_NOT_FOUND');
    if(review.expiresAt<=now())throw fail('PLAN_EXPIRED');
    if(review.used)throw fail('PLAN_USED');
    if(review.backgroundReviewToken!==null && args.backgroundReviewToken!==review.backgroundReviewToken)throw fail('BACKGROUND_REVIEW_REQUIRED');
    if([...jobs.values()].some(job=>active.has(job.status)))throw fail('JOB_BUSY');
    review.used=true;
    const implicitIds=Object.freeze(review.background.items.map(item=>item.id));
    const job={id:crypto.randomUUID(),scope:review.scope,implicitIds,status:'queued',controller:new AbortController(),snapshot:null,error:null};
    jobs.set(job.id,job);lastJob=job.id;
    try{await persist(job);}catch{jobs.delete(job.id);lastJob=null;review.used=false;throw fail('JOB_STORE_UNAVAILABLE');}
    // Only a confirmation of the exact, displayed token reaches this queue.
    job.done=Promise.resolve().then(async()=>{
      const result=await lock(async lease=>{
        await enabled();lease?.assertHeld?.();job.status='running';await persist(job);
        const guarded={capabilities:provider.capabilities,
          archive:async(id,args)=>{
            await enabled();lease?.assertHeld?.();
            const reviewedBackground=review.background.byChat[id];
            const allowed=new Set([...job.scope.items.map(item=>item.id),...reviewedBackground.map(item=>item.id)]);
            return provider.archive(id,{...args,confirmedIds:args.confirmedIds.filter(value=>allowed.has(value)),reviewedBackground});
          },
          readStatus:(id,args)=>provider.readStatus(id,args)};
        const freshManifest=async({signal}={})=>{const fresh=await readManifest();
          if(review.scope.includeDescendants&&fresh.relationsAvailable===false)throw fail('RELATIONS_UNAVAILABLE');
          const current=await collectBackground(review.scope,signal);
          if(current.signature!==review.background.signature)throw fail('BACKGROUND_SCOPE_CHANGED');
          return fresh;};
        job.snapshot=await executeScope(job.scope,{confirmedToken:review.scope.token,loadManifest:freshManifest,provider:guarded,
          signal:job.controller.signal,acceptNonAtomicScopeRisk:review.disclosedRisk,reviewedImplicitIds:implicitIds,
          onProgress:async snapshot=>{job.snapshot=snapshot;await persist(job);}});
        job.status=job.snapshot.status==='completed'?'completed':job.snapshot.status==='cancelled'?'stopped':'failed';
        if(job.snapshot.error)job.error=publicError(job.snapshot.error);
      });
      if(result?.state==='mutex_busy')throw fail('JOB_BUSY');
    }).catch(error=>{job.status=job.controller.signal.aborted?'stopped':'failed';job.error=publicError(error);})
      .finally(async()=>{try{await persist(job);}catch{job.status='failed';job.error=publicError(fail('JOB_STORE_UNAVAILABLE'));}});
    return {job:viewJob(job)};
  }
  async function getJob({jobId}={}){
    if(typeof jobId!=='string'||!UUID.test(jobId))throw fail('JOB_NOT_FOUND');
    if(jobs.has(jobId))return {job:viewJob(jobs.get(jobId))};
    try{
      const saved=JSON.parse(await fs.readFile(path.join(dataDir,'archive-jobs',jobId+'.json'),'utf8'));
      if(saved.schemaVersion!==1||saved.jobId!==jobId)throw Error();
      if(active.has(saved.status)){saved.status='interrupted';saved.error={message:'上次归档连接已中断，请先检查结果后重新选择。'};}
      return {job:saved};
    }catch{throw fail('JOB_NOT_FOUND');}
  }
  async function stopJob({jobId}={}){
    const job=jobs.get(jobId);if(!job)throw fail('JOB_NOT_FOUND');
    if(active.has(job.status)){job.status='stopping';job.controller.abort();await persist(job);}
    return {job:viewJob(job)};
  }
  async function setModules(args={}){
    const value=await store.update(args);
    if(!value.archiveEnabled)for(const job of jobs.values())if(active.has(job.status)){job.status='stopping';job.controller.abort();}
    return moduleStatus();
  }
  async function dispose(){closed=true;for(const job of jobs.values())if(active.has(job.status))job.controller.abort();provider.dispose?.();await persistQueue.catch(()=>{});}
  return {listChats,listNestedChats,openNestedChat,planArchive,confirmArchive,getJob,stopJob,moduleStatus,setModules,dispose,
    waitForJob:async id=>{const job=jobs.get(id);if(job)await job.done;return job?viewJob(job):null;}};
}

const empty={type:'object',properties:{},additionalProperties:false};
const tools=[
  {name:'open_archive_manager',title:'批量归档',description:'打开独立批量归档页面；嵌套显示未加载时也可使用。',inputSchema:empty,
    annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:UI_URI,visibility:['model','app']},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}},
  {name:'open_nested_chats',title:'嵌套对话',description:'在官方插件页面或聊天侧面板查看父子聊天目录。',inputSchema:empty,
    annotations:{readOnlyHint:true},_meta:{ui:{resourceUri:NESTING_URI,visibility:['model','app']},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}},
  {name:'list_nested_chats',description:'供嵌套目录读取本机聊天标题和上级关系。',inputSchema:empty,annotations:{readOnlyHint:true},_meta:{ui:{visibility:['app']}}},
  {name:'open_nested_chat',description:'在用户点击后，请求官方 Windows 客户端打开选中的本机聊天。',inputSchema:{type:'object',properties:{chatId:{type:'string'}},required:['chatId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app']}}},
  {name:'list_chats',description:'读取可归档的本机聊天元数据，不读取正文。',inputSchema:empty,annotations:{readOnlyHint:true},_meta:{ui:{visibility:['app']}}},
  {name:'plan_archive',description:'生成待用户确认的归档范围，不执行归档。',inputSchema:{type:'object',properties:{chatIds:{type:'array',items:{type:'string'},minItems:1,maxItems:256},includeDescendants:{type:'boolean'},catalogRevision:{type:'string'}},required:['chatIds'],additionalProperties:false},annotations:{readOnlyHint:true},_meta:{ui:{visibility:['app']}}},
  {name:'confirm_archive',description:'用户确认已展示的聊天与后台子任务后，提交这个范围的一次性确认。',inputSchema:{type:'object',properties:{planToken:{type:'string'},backgroundReviewToken:{type:'string'}},required:['planToken'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false},_meta:{ui:{visibility:['app']}}},
  ...['get_job','stop_job'].map(name=>({name,description:name==='get_job'?'读取已提交归档任务的进度。':'停止未提交的后续归档，保留已完成项。',inputSchema:{type:'object',properties:{jobId:{type:'string'}},required:['jobId'],additionalProperties:false},annotations:{readOnlyHint:name==='get_job',destructiveHint:false},_meta:{ui:{visibility:['app']}}})),
  {name:'get_module_status',description:'分别读取归档和嵌套的开关与连接状态。',inputSchema:empty,annotations:{readOnlyHint:true},_meta:{ui:{visibility:['app']}}},
  {name:'set_module_state',description:'独立启停归档或嵌套，不改变Windows自启动。',inputSchema:{type:'object',properties:{archiveEnabled:{type:'boolean'},nestingEnabled:{type:'boolean'}},additionalProperties:false,minProperties:1},annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false},_meta:{ui:{visibility:['app']}}}
];
// The stdio server owns the validation boundary. A client can send raw JSON-RPC
// without consulting tools/list, so publishing a schema is not enforcement.
function matchesSchema(value,schema){
  switch(schema.type){
    case 'object':{
      if(!value||typeof value!=='object'||Array.isArray(value))return false;
      const keys=Object.keys(value),properties=schema.properties||{};
      if(schema.minProperties!==undefined&&keys.length<schema.minProperties)return false;
      if(schema.additionalProperties===false&&keys.some(key=>!Object.hasOwn(properties,key)))return false;
      if((schema.required||[]).some(key=>!Object.hasOwn(value,key)))return false;
      return keys.every(key=>!Object.hasOwn(properties,key)||matchesSchema(value[key],properties[key]));
    }
    case 'array':return Array.isArray(value)&&
      (schema.minItems===undefined||value.length>=schema.minItems)&&
      (schema.maxItems===undefined||value.length<=schema.maxItems)&&value.every(item=>matchesSchema(item,schema.items));
    case 'string':return typeof value==='string';
    case 'boolean':return typeof value==='boolean';
    default:return false;
  }
}
function rpcErrorCode(error){
  if(error?.code==='METHOD_NOT_FOUND')return -32601;
  if(error?.code==='INVALID_REQUEST')return -32600;
  if(error?.code==='NOT_INITIALIZED')return -32002;
  if(['INVALID_ARGUMENTS','INVALID_PARAMS','UNKNOWN_TOOL','UNKNOWN_RESOURCE','ALREADY_INITIALIZED'].includes(error?.code))return -32602;
  return -32603;
}
function serveArchiveStdio({service=createArchiveService(),input=process.stdin,output=process.stdout,readHtml=()=>fs.readFile(path.join(__dirname,'archive-panel.html'),'utf8')}={}){
  let initialized=false,closed=false,buffer='';const decoder=new StringDecoder('utf8');
  const handlers={open_archive_manager:()=>service.moduleStatus(),open_nested_chats:async()=>({view:'nested-chats'}),
    list_nested_chats:()=>service.listNestedChats(),open_nested_chat:args=>service.openNestedChat(args),
    list_chats:()=>service.listChats(),plan_archive:args=>service.planArchive(args),
    confirm_archive:args=>service.confirmArchive(args),get_job:args=>service.getJob(args),stop_job:args=>service.stopJob(args),
    get_module_status:()=>service.moduleStatus(),set_module_state:args=>service.setModules(args)};
  function send(value){if(!closed)output.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');}
  async function dispatch(message){
    if(!message||typeof message!=='object'||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||
      (Object.hasOwn(message,'id')&&message.id!==null&&!['string','number'].includes(typeof message.id))){
      send({id:null,error:{code:-32600,message:'Invalid JSON-RPC request'}});return;
    }
    const hasId=Object.hasOwn(message,'id');
    if(message.method==='notifications/initialized')return;
    if(!hasId)return;
    try{
      if(message.params!==undefined&&(!message.params||typeof message.params!=='object'||Array.isArray(message.params)))throw fail('INVALID_PARAMS');
      let result;
      if(message.method==='initialize'){
        if(initialized)throw fail('ALREADY_INITIALIZED');initialized=true;
        const supported=['2024-11-05','2025-03-26','2025-06-18','2025-11-25','2026-07-28'];
        result={protocolVersion:supported.includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-11-25',
          capabilities:{tools:{},resources:{}},serverInfo:{name:'codex-conversations-archive',version:'0.3.0-preview.6'}};
      }else{
        if(!initialized)throw fail('NOT_INITIALIZED');
        switch(message.method){
          case 'ping':result={};break;
          case 'tools/list':result={tools};break;
          case 'resources/list':result={resources:[{uri:UI_URI,name:'批量归档',mimeType:'text/html;profile=mcp-app'},{uri:NESTING_URI,name:'嵌套对话',mimeType:'text/html;profile=mcp-app'}]};break;
          case 'resources/read':{
            const uri=message.params?.uri;if(uri!==UI_URI&&uri!==NESTING_URI)throw fail('UNKNOWN_RESOURCE');
            let html=await readHtml();
            if(uri===NESTING_URI)html=html.replace('<html lang="zh-CN">','<html lang="zh-CN" data-cncc-view="nested">').replace('<title>批量归档</title>','<title>嵌套对话</title>');
            result={contents:[{uri,mimeType:'text/html;profile=mcp-app',text:html,_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]}}}}]};break;
          }
          case 'tools/call':{
            const name=message.params?.name;
            if(typeof name!=='string'||!Object.hasOwn(handlers,name))throw fail('UNKNOWN_TOOL');
            const handler=handlers[name],schema=tools.find(tool=>tool.name===name).inputSchema;
            const args=Object.hasOwn(message.params,'arguments')?message.params.arguments:{};
            if(!matchesSchema(args,schema))throw fail('INVALID_ARGUMENTS');
            try{const data=await handler(args);result={content:[{type:'text',text:name==='open_archive_manager'?'已准备批量归档管理页面。':name==='open_nested_chats'?'已准备嵌套对话目录。':JSON.stringify(data)}],structuredContent:data};}
            catch(error){const value=publicError(error);result={isError:true,content:[{type:'text',text:value.message}],structuredContent:{error:value}};}
            break;
          }
          default:throw fail('METHOD_NOT_FOUND');
        }
      }
      send({id:message.id,result});
    }catch(error){send({id:message.id,error:{code:rpcErrorCode(error),message:'Archive plugin request could not be completed'}});}
  }
  function data(chunk){
    buffer+=decoder.write(chunk);
    if(Buffer.byteLength(buffer)>1024*1024){send({id:null,error:{code:-32600,message:'Request too large'}});void stop();return;}
    let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;
      try{void dispatch(JSON.parse(line));}catch{send({id:null,error:{code:-32700,message:'Invalid JSON'}});}}
  }
  async function stop(){if(closed)return;closed=true;input.removeListener('data',data);input.pause?.();input.unref?.();await service.dispose();}
  input.on('data',data);input.once('end',()=>void stop());input.once('error',()=>void stop());
  return {stop,dispatch};
}
if(require.main===module){const server=serveArchiveStdio();process.on('SIGINT',()=>void server.stop());process.on('SIGTERM',()=>void server.stop());}
module.exports={createArchiveService,serveArchiveStdio,UI_URI,NESTING_URI,tools,publicError};
