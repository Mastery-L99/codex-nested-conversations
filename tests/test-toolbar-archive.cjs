'use strict';
// Real toolbar controller + synthetic service and headless Edge DOM only.
// No official app, real chat/profile, database, protocol launch or archive write.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {setImmediate:tick}=require('node:timers/promises');
const {chromium}=require('playwright');
const {createToolbarArchive}=require('../src/toolbar-archive.cjs');
const uuid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const chat=n=>({id:uuid(n),title:`Synthetic chat ${n}`,kind:'codex',hostId:'local',threadSource:'user'});
const [parent,child,grandchild]=[1,2,3].map(chat);
function controller(t,prefix='one',overrides={}){
  const calls={factory:0,plan:[],confirm:[],status:[],stop:[],dispose:0};let enabled=true,serial=0;
  const job={jobId:uuid(prefix==='one'?90:91),status:'queued',total:3,verified:[],submitted:[],pending:[grandchild.id,child.id,parent.id],uncertain:[],outsideScope:[],error:null};
  const service={
    planArchive:async args=>{calls.plan.push(args);return {planToken:prefix+'-token-'+(++serial),items:[grandchild,child,parent],totalCount:3,includeDescendants:args.includeDescendants,warnings:[]};},
    confirmArchive:async args=>{calls.confirm.push(args);return {job:{...job}};},
    getJob:async args=>{calls.status.push(args);return {job:{...job,status:'completed',verified:[grandchild.id,child.id,parent.id],pending:[]}};},
    stopJob:async args=>{calls.stop.push(args);return {job:{...job,status:'stopped'}};},dispose:async()=>{calls.dispose++;},...overrides
  };
  const toolbar=createToolbarArchive({canWrite:()=>enabled,serviceFactory:()=>{calls.factory++;return service;}});
  t.after(()=>toolbar.dispose());return {toolbar,service,calls,job,setEnabled:value=>{enabled=value;}};
}
const plan=f=>f.toolbar.call('plan',{chatIds:[parent.id],includeDescendants:true});

test('factory stays lazy and action allowlist rejects unknown/prototype actions before creating a service',async t=>{
  const f=controller(t);assert.equal(f.calls.factory,0);
  for(const action of ['archive','list','constructor','toString','__proto__',null])await assert.rejects(f.toolbar.call(action,{}));
  assert.equal(f.calls.factory,0);await plan(f);await plan(f);assert.equal(f.calls.factory,1);
});

test('plan validates local UUID inputs and rejects all extra scope fields',async t=>{
  const f=controller(t);
  for(const input of [null,{}, {chatIds:[],includeDescendants:true},{chatIds:'bad',includeDescendants:true},
    {chatIds:['bad'],includeDescendants:true},{chatIds:[parent.id],includeDescendants:'false'},
    {chatIds:Array(257).fill(parent.id),includeDescendants:true},
    {chatIds:[parent.id],includeDescendants:false,unapprovedIds:[uuid(88)]}])await assert.rejects(f.toolbar.call('plan',input));
  assert.equal(f.calls.factory,0);
  await f.toolbar.call('plan',{chatIds:[parent.id],includeDescendants:false});
  assert.deepEqual(f.calls.plan,[{chatIds:[parent.id],includeDescendants:false}]);
});

test('only the latest token for this window can confirm and a token is consumed once',async t=>{
  const f=controller(t),first=await plan(f),second=await plan(f);
  await assert.rejects(f.toolbar.call('confirm',{planToken:first.planToken}));
  await assert.rejects(f.toolbar.call('confirm',{planToken:second.planToken,chatIds:[uuid(88)]}));
  const job=await f.toolbar.call('confirm',{planToken:second.planToken});
  assert.equal(job.jobId,f.job.jobId);assert.deepEqual(f.calls.confirm,[{planToken:second.planToken}]);
  await assert.rejects(f.toolbar.call('confirm',{planToken:second.planToken}));assert.equal(f.calls.confirm.length,1);
});

test('separate window controllers cannot confirm each other tokens or inspect/stop each other jobs',async t=>{
  const one=controller(t,'one'),two=controller(t,'two'),first=await plan(one),second=await plan(two);
  await assert.rejects(one.toolbar.call('confirm',{planToken:second.planToken}));
  const a=await one.toolbar.call('confirm',{planToken:first.planToken}),b=await two.toolbar.call('confirm',{planToken:second.planToken});
  for(const action of ['status','stop']){
    await assert.rejects(one.toolbar.call(action,{jobId:b.jobId}));await assert.rejects(two.toolbar.call(action,{jobId:a.jobId}));
  }
  assert.equal((await one.toolbar.call('status',{jobId:a.jobId})).status,'completed');
  assert.equal((await two.toolbar.call('stop',{jobId:b.jobId})).status,'stopped');
});

test('closing a window disposes its service and rejects every subsequent action',async t=>{
  const f=controller(t),review=await plan(f);await f.toolbar.dispose();
  for(const action of ['plan','confirm','status','stop'])await assert.rejects(f.toolbar.call(action,{planToken:review.planToken,jobId:f.job.jobId}),/窗口已关闭/);
  assert.equal(f.calls.confirm.length,0);assert.equal(f.calls.dispose,1);
});

test('discard and module invalidation prevent reuse of a previously displayed review',async t=>{
  const f=controller(t),first=await plan(f);
  assert.equal(await f.toolbar.call('discard',{planToken:first.planToken}),null);
  await assert.rejects(f.toolbar.call('confirm',{planToken:first.planToken}));
  const second=await plan(f);f.toolbar.invalidate();
  await assert.rejects(f.toolbar.call('confirm',{planToken:second.planToken}));assert.equal(f.calls.confirm.length,0);
});

test('an older concurrent plan cannot replace the most recently requested review token',async t=>{
  const releases=[];let serial=0;
  const f=controller(t,'one',{planArchive:()=>{const index=++serial;return new Promise(resolve=>{releases.push(()=>resolve({planToken:'concurrent-'+index}));});}});
  const older=plan(f),newer=plan(f);assert.equal(releases.length,2);
  releases[1]();const current=await newer;releases[0]();await assert.rejects(older,/更新/);
  await assert.rejects(f.toolbar.call('confirm',{planToken:'concurrent-1'}));
  await f.toolbar.call('confirm',{planToken:current.planToken});assert.deepEqual(f.calls.confirm,[{planToken:'concurrent-2'}]);
});

test('module-off rejects planning/confirmation but still permits status and stop for the existing job',async t=>{
  const f=controller(t),review=await plan(f);f.setEnabled(false);
  await assert.rejects(plan(f),/已关闭/);await assert.rejects(f.toolbar.call('confirm',{planToken:review.planToken}),/已关闭/);
  assert.equal(f.calls.confirm.length,0);f.setEnabled(true);const job=await f.toolbar.call('confirm',{planToken:review.planToken});f.setEnabled(false);
  assert.equal((await f.toolbar.call('status',{jobId:job.jobId})).status,'completed');
  assert.equal((await f.toolbar.call('stop',{jobId:job.jobId})).status,'stopped');
});

test('closing or disabling while planning cannot leave a confirmable review',async t=>{
  for(const close of [true,false]){
    let release;const gate=new Promise(resolve=>{release=resolve;});
    const f=controller(t,close?'one':'two',{planArchive:async()=>{await gate;return {planToken:'late-review'};}});
    const pending=f.toolbar.call('plan',{chatIds:[parent.id],includeDescendants:true});await tick();
    if(close)await f.toolbar.dispose();else f.setEnabled(false);release();
    await assert.rejects(pending,/已关闭/);await assert.rejects(f.toolbar.call('confirm',{planToken:'late-review'}));assert.equal(f.calls.confirm.length,0);
  }
});

test('service plan/confirm failures preserve the concrete failure and never retry a consumed confirmation',async t=>{
  const f=controller(t,'one',{confirmArchive:async()=>{throw Object.assign(new Error('Synthetic scope changed'),{code:'scope_changed'});}}),review=await plan(f);
  await assert.rejects(f.toolbar.call('confirm',{planToken:review.planToken}),{code:'scope_changed'});
  await assert.rejects(f.toolbar.call('confirm',{planToken:review.planToken}),/失效/);
  f.service.planArchive=async()=>{throw Error('Synthetic backend unavailable');};await assert.rejects(plan(f),/Synthetic backend unavailable/);
});

async function dom(t,{mode='normal',bridge=true,closeThrows=false,service=true,implicit=[],reviewFault='',progressFault=''}={}){
  const browser=await chromium.launch({headless:true,channel:'msedge'});t.after(()=>browser.close());
  const page=await browser.newPage();await page.setContent('<html><head></head><body><aside id="app-shell-sidebar"></aside></body></html>');
  await page.evaluate(({parent,child,grandchild,mode,bridge,closeThrows,service,implicit,reviewFault,progressFault})=>{
    window.fixture={nativeOpens:0,nativeCloses:0,calls:[],confirmCount:0,statusCount:0,planCount:0,stopped:false,mode,reviewFault,progressFault};
    // An empty catalog and no native row intentionally model the reported UI
    // failure. Service review metadata is the sole authoritative scope here.
    window.__codexNestedRelations={schemaVersion:1,catalog:[],groups:[]};
    window.__codexNestedCascadeOptions={enableArchiveExecution:true,requireBatchService:true,requireFreshValidation:true,requireNativeMenuBridge:true};
    if(bridge)window.__codexNestedRuntime={
      openNativeMenu(){window.fixture.nativeOpens++;throw Error('Native chat row is not available');},
      closeNativeMenu(){window.fixture.nativeCloses++;if(closeThrows)throw Error('Synthetic native close failure');},getMenuContext(){return null;}
    };
    const ids=[grandchild.id,child.id,parent.id],implicitIds=implicit.map(item=>item.id),base={jobId:'00000000-0000-0000-0000-000000000090',total:3,submitted:[],verified:[],pending:ids,uncertain:[],outsideScope:[],currentTitle:'',error:null,
      ...(implicit.length?{implicitTotal:implicit.length,verifiedImplicit:[],pendingImplicit:implicitIds}:{})};
    function progress(job){
      const fault=window.fixture.progressFault;
      if(implicit.length){
        job={...job,implicitTotal:implicit.length,
          verifiedImplicit:job.status==='completed'?implicitIds:[],pendingImplicit:job.status==='completed'?[]:implicitIds};
        if(fault==='counts'){job.verifiedImplicit=job.verifiedImplicit.length;job.pendingImplicit=job.pendingImplicit.length;}
        if(fault==='wrong-total')job.implicitTotal++;
        if(fault==='missing')delete job.pendingImplicit;
        if(fault==='unknown')job.verifiedImplicit=['00000000-0000-0000-0000-000000000099'];
        if(fault==='overlap'){job.verifiedImplicit=[implicitIds[0]];job.pendingImplicit=implicitIds;}
        if(fault==='unverified'&&job.status==='completed'){job.verifiedImplicit=[];job.pendingImplicit=implicitIds;}
        if(fault==='partial'&&job.status==='completed'){job.status='failed';job.verifiedImplicit=implicitIds.slice(0,1);job.pendingImplicit=implicitIds.slice(1);job.error={message:'Synthetic partial archive stopped'};}
      }
      return job;
    }
    if(service)window.__codexNestedBatchArchive=async(action,input)=>{
      window.fixture.calls.push({action,input});
      if(action==='plan'){
        const review={planToken:'synthetic-review-'+(++window.fixture.planCount),items:[grandchild,child,parent],totalCount:3,rootCount:1,
          includeDescendants:input.includeDescendants,warnings:['官方接口可能包含后台运行记录，提交前会再次检查。'],
          ...(implicit.length?{implicitCount:implicit.length,implicitItems:implicit.map(item=>({...item})),backgroundReviewToken:'00000000-0000-0000-0000-000000000092'}:{})};
        switch(window.fixture.reviewFault){
          case 'missing-list':delete review.implicitItems;break;
          case 'missing-count':delete review.implicitCount;break;
          case 'wrong-count':review.implicitCount++;break;
          case 'duplicate':review.implicitItems[1]={...review.implicitItems[0]};break;
          case 'ordinary-overlap':review.implicitItems[0].id=parent.id;break;
          case 'missing-title':delete review.implicitItems[0].title;break;
          case 'empty-title':review.implicitItems[0].title=' ';break;
          case 'missing-parent-title':delete review.implicitItems[0].parentTitle;break;
          case 'wrong-parent-title':review.implicitItems[0].parentTitle='Wrong owner title';break;
          case 'outside-parent':review.implicitItems[0].parentId='00000000-0000-0000-0000-000000000099';break;
          case 'combined-total':review.totalCount+=implicit.length;break;
          case 'string-count':review.implicitCount=String(implicit.length);break;
          case 'missing-background-token':delete review.backgroundReviewToken;break;
          case 'invalid-background-token':review.backgroundReviewToken='not-a-uuid';break;
        }
        return {ok:true,value:review};
      }
      if(action==='confirm'){
        window.fixture.confirmCount++;
        if(mode==='transport-error')return {ok:false,message:'服务精确错误：归档范围发生变化。'};
        if(mode==='job-error')return {ok:true,value:{...base,status:'failed',error:{code:'scope_changed',message:'服务精确错误：归档范围发生变化。'}}};
        return {ok:true,value:progress({...base,status:'queued'})};
      }
      if(action==='discard')return {ok:true,value:null};
      if(action==='stop'){window.fixture.stopped=true;return {ok:true,value:{...base,status:'stopped',error:{message:'已停止后续归档。'}}};}
      if(action==='status'){
        window.fixture.statusCount++;
        if(mode==='running')return {ok:true,value:{...base,status:window.fixture.stopped?'stopped':'running'}};
        return {ok:true,value:progress({...base,status:'completed',submitted:ids,verified:ids,pending:[]})};
      }
      return {ok:false,message:'Unexpected synthetic action'};
    };
  },{parent,child,grandchild,mode,bridge,closeThrows,service,implicit,reviewFault,progressFault});
  await page.evaluate(await fs.readFile(path.join(__dirname,'../src/cascade-actions.js'),'utf8'));
  return {page,preview:()=>page.evaluate(parent=>window.__codexNestedCascade.previewMany([parent],{includeDescendants:true}),parent),
    inspect:()=>page.evaluate(()=>window.__codexNestedCascade.inspect()),fixture:()=>page.evaluate(()=>window.fixture)};
}

test('production batch preview and one confirmation work without rendered chats, native status hooks or native menu calls',async t=>{
  const f=await dom(t);await f.preview();
  assert.equal(await f.page.locator('[data-app-action-sidebar-thread-row]').count(),0);
  assert.equal(await f.page.getByRole('button',{name:'归档全部 3 个',exact:true}).isEnabled(),true);
  assert.ok(await f.page.getByRole('dialog').innerText().then(text=>text.includes('后台运行记录')));
  await f.page.evaluate(()=>{const button=[...document.querySelectorAll('button')].find(value=>value.textContent==='归档全部 3 个');button.click();button.click();});
  await f.page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='completed');
  const fixture=await f.fixture();assert.equal(fixture.confirmCount,1);assert.equal(fixture.nativeOpens,0);
  assert.deepEqual((await f.inspect()).verified,[grandchild.id,child.id,parent.id]);
  assert.ok(await f.page.getByRole('status').innerText().then(text=>text.includes('3 / 3')));
  const confirmation=fixture.calls.find(value=>value.action==='confirm');assert.deepEqual(Object.keys(confirmation.input),['planToken']);
});

test('batch service also works when the entire native bridge is unavailable',async t=>{
  const f=await dom(t,{bridge:false});await f.preview();await f.page.getByRole('button',{name:'归档全部 3 个',exact:true}).click();
  await f.page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='completed');assert.equal((await f.fixture()).nativeOpens,0);
});

test('cancelling service review submits no confirmation or native archive request',async t=>{
  const f=await dom(t);await f.preview();await f.page.getByRole('button',{name:'取消',exact:true}).click();
  const fixture=await f.fixture();assert.equal(fixture.planCount,1);assert.equal(fixture.confirmCount,0);assert.equal(fixture.nativeOpens,0);
  assert.deepEqual(fixture.calls.filter(value=>value.action==='discard'),[{action:'discard',input:{planToken:'synthetic-review-1'}}]);
  assert.equal((await f.inspect()).state,'cancelled');
});

test('a required missing batch service never silently falls back to the native menu route',async t=>{
  const f=await dom(t,{service:false});await assert.rejects(f.preview(),/归档服务尚未连接/);assert.equal((await f.fixture()).nativeOpens,0);
});

test('batch progress displays the concrete backend failure instead of an ambiguous zero count',async t=>{
  for(const mode of ['job-error','transport-error']){
    const f=await dom(t,{mode});await f.preview();await f.page.getByRole('button',{name:'归档全部 3 个',exact:true}).click();
    await f.page.waitForFunction(()=>!window.__codexNestedCascade.inspect().busy);
    assert.ok((await f.inspect()).error.includes('服务精确错误：归档范围发生变化。'));
    assert.ok(await f.page.getByRole('dialog').innerText().then(text=>text.includes('服务精确错误：归档范围发生变化。')));
    assert.equal((await f.fixture()).confirmCount,1);assert.equal((await f.fixture()).nativeOpens,0);
  }
});

test('disabling archive during service execution issues stop and does not confirm again',async t=>{
  const f=await dom(t,{mode:'running'});await f.preview();await f.page.getByRole('button',{name:'归档全部 3 个',exact:true}).click();
  await f.page.waitForFunction(()=>window.__codexNestedCascade.inspect().busy);
  await f.page.evaluate(()=>window.__codexNestedCascade.setEnabled(false));
  await f.page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='stopped');
  const fixture=await f.fixture();assert.equal(fixture.confirmCount,1);assert.equal(fixture.calls.filter(value=>value.action==='stop').length,1);assert.equal(fixture.nativeOpens,0);
});

test('a native menu-close failure cannot suppress an independent service review',async t=>{
  const f=await dom(t,{closeThrows:true});await f.preview();
  assert.equal(await f.page.getByRole('button',{name:'归档全部 3 个',exact:true}).isEnabled(),true);assert.equal((await f.fixture()).nativeOpens,0);
});

const implicitItems=[{id:uuid(50),title:'后台资料整理',parentId:parent.id,parentTitle:parent.title},
  {id:uuid(51),title:'<img src=x onerror=alert(1)>',parentId:child.id,parentTitle:child.title}];

test('implicit archive review separates complete background names and owners from chat totals before confirmation',async t=>{
  const f=await dom(t,{implicit:implicitItems});const result=await f.preview();
  assert.equal(result.count,3);assert.equal(result.implicitCount,2);
  assert.equal(await f.page.getByRole('heading',{name:'聊天（3 个）',exact:true}).count(),1);
  assert.equal(await f.page.getByRole('heading',{name:'后台记录（2 条）',exact:true}).count(),1);
  const section=f.page.getByRole('region',{name:'同时归档的后台记录'});
  // A labelled section receives the region role in the accessibility tree.
  assert.equal(await section.count(),1);assert.equal(await section.locator('li').count(),2);
  assert.match(await section.innerText(),/后台资料整理/);assert.match(await section.innerText(),/所属聊天：Synthetic chat 1/);
  assert.match(await section.innerText(),/所属聊天：Synthetic chat 2/);assert.equal(await section.locator('img').count(),0);
  assert.equal(await f.page.getByRole('button',{name:'归档全部 3 个',exact:true}).count(),0);
  assert.equal(await f.page.getByRole('button',{name:'按此范围归档 3 个聊天和 2 条后台记录',exact:true}).isEnabled(),true);
  assert.equal((await f.fixture()).confirmCount,0);
  await f.page.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await f.fixture()).confirmCount,0);
  assert.equal((await f.fixture()).calls.filter(call=>call.action==='discard').length,1);
});

test('implicit confirmation submits both reviewed tokens and reports chat/background verification separately',async t=>{
  const f=await dom(t,{implicit:implicitItems});await f.preview();
  await f.page.getByRole('button',{name:'按此范围归档 3 个聊天和 2 条后台记录',exact:true}).click();
  await f.page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='completed');
  const result=await f.inspect();assert.equal(result.implicitTotal,2);assert.deepEqual(result.verifiedImplicit,implicitItems.map(item=>item.id));
  assert.deepEqual(result.pendingImplicit,[]);assert.equal(result.verified.length,3);
  assert.match(await f.page.locator('.cnc-progress').textContent(),/3 \/ 3/);
  assert.match(await f.page.locator('.cnc-implicit-progress').textContent(),/已确认 2 \/ 2 条 · 待确认 0 条/);
  assert.match(await f.page.locator('.cnc-detail').textContent(),/3 个对话，并确认 2 条后台记录/);
  const fixture=await f.fixture();assert.equal(fixture.confirmCount,1);assert.equal(fixture.nativeOpens,0);
  assert.deepEqual(fixture.calls.find(call=>call.action==='confirm').input,{planToken:'synthetic-review-1',backgroundReviewToken:uuid(92)});
});

test('implicit progress accepts bounded numeric counters as well as canonical ID arrays',async t=>{
  const f=await dom(t,{implicit:implicitItems,progressFault:'counts'});await f.preview();
  await f.page.getByRole('button',{name:'按此范围归档 3 个聊天和 2 条后台记录',exact:true}).click();
  await f.page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='completed');
  assert.equal((await f.inspect()).verifiedImplicit,2);assert.equal((await f.inspect()).pendingImplicit,0);
  assert.match(await f.page.locator('.cnc-implicit-progress').textContent(),/已确认 2 \/ 2/);
});

test('incomplete implicit names, ownership, IDs or counts block review and discard its token without confirmation',async t=>{
  const f=await dom(t,{implicit:implicitItems});
  const faults=['missing-list','missing-count','wrong-count','duplicate','ordinary-overlap','missing-title','empty-title',
    'missing-parent-title','wrong-parent-title','outside-parent','combined-total','string-count','missing-background-token','invalid-background-token'];
  for(const fault of faults){
    await f.page.evaluate(fault=>window.fixture.reviewFault=fault,fault);
    await assert.rejects(f.preview(),/归档范围信息不完整/);
    assert.equal(await f.page.getByRole('dialog').count(),0);assert.equal((await f.fixture()).confirmCount,0);
  }
  const fixture=await f.fixture();assert.equal(fixture.calls.filter(call=>call.action==='discard').length,faults.length);
  assert.equal(fixture.nativeOpens,0);
});

test('unknown or incomplete implicit progress cannot become a successful completed result',async t=>{
  const f=await dom(t,{implicit:implicitItems});
  for(const fault of ['wrong-total','missing','unknown','overlap','unverified']){
    await f.page.evaluate(fault=>window.fixture.progressFault=fault,fault);await f.preview();
    await f.page.getByRole('button',{name:'按此范围归档 3 个聊天和 2 条后台记录',exact:true}).click();
    await f.page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='result_unavailable');
    assert.match(await f.page.locator('.cnc-detail').textContent(),/后台记录/);
    assert.doesNotMatch(await f.page.locator('.cnc-detail').textContent(),/已归档全部/);
    await f.page.getByRole('button',{name:'关闭',exact:true}).click();
  }
  assert.equal((await f.fixture()).confirmCount,5);
});

test('partial implicit verification remains visible alongside the concrete stopped error',async t=>{
  const f=await dom(t,{implicit:implicitItems,progressFault:'partial'});await f.preview();
  await f.page.getByRole('button',{name:'按此范围归档 3 个聊天和 2 条后台记录',exact:true}).click();
  await f.page.waitForFunction(()=>window.__codexNestedCascade.inspect().state==='failed');
  assert.match(await f.page.locator('.cnc-implicit-progress').textContent(),/已确认 1 \/ 2 条 · 待确认 1 条/);
  assert.match(await f.page.locator('.cnc-detail').textContent(),/Synthetic partial archive stopped/);
  assert.deepEqual((await f.inspect()).pendingImplicit,[implicitItems[1].id]);
});

test('long implicit review retains every named item and owner in a scrollable narrow dialog',async t=>{
  const entries=Array.from({length:60},(_,index)=>({id:uuid(200+index),title:`匿名后台记录 ${index+1}`,parentId:parent.id,parentTitle:parent.title}));
  const f=await dom(t,{implicit:entries});await f.page.setViewportSize({width:375,height:760});await f.preview();
  assert.equal(await f.page.locator('[data-codex-cascade-implicit-id]').count(),60);
  assert.equal(await f.page.locator('.cnc-implicit-scope .cnc-chat-hint').count(),60);
  assert(await f.page.locator('.cnc-implicit-scope').evaluate(node=>node.scrollHeight>node.clientHeight));
  assert(await f.page.locator('.cnc-box').evaluate(node=>node.scrollWidth<=node.clientWidth&&node.getBoundingClientRect().height<=window.innerHeight));
  await f.page.locator('.cnc-implicit-scope').evaluate(node=>node.scrollTop=node.scrollHeight);
  await f.page.getByText('匿名后台记录 60',{exact:true}).waitFor({state:'visible'});
  const confirm=f.page.getByRole('button',{name:'按此范围归档 3 个聊天和 60 条后台记录',exact:true});
  await confirm.scrollIntoViewIfNeeded();assert(await confirm.evaluate(node=>node.getBoundingClientRect().bottom<=window.innerHeight));
  await f.page.getByRole('button',{name:'取消',exact:true}).scrollIntoViewIfNeeded();
  const artifacts=await fs.mkdtemp(path.join(os.tmpdir(),'cncc-implicit-toolbar-'));
  const screenshot=path.join(artifacts,'implicit-confirm-mobile.png');await f.page.locator('.cnc-box').screenshot({path:screenshot});t.diagnostic(screenshot);
  assert.equal((await f.fixture()).confirmCount,0);
});
