'use strict';
// Synthetic main window, preload and RPC replies only. The evaluated production
// function runs in a fresh VM; no desktop connection or real archive is made.
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {setImmediate:tick}=require('node:timers/promises');
const {createDesktopRequest}=require('../src/desktop-archive.cjs');
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const APP='app://-/index.html';
const isCode=code=>error=>error.code===code;
function fixture(options={}){
  const listeners=new Set(),calls=[],evaluations=[];
  const window={addEventListener:(name,fn)=>{assert.equal(name,'message');listeners.add(fn);},removeEventListener:(name,fn)=>{assert.equal(name,'message');listeners.delete(fn);}};
  window.top=options.subframe?{}:window;
  const emit=(request,message,event={})=>{
    const data={type:'mcp-response',hostId:'local',message:{id:request.request.id,...message}};
    const value={source:null,origin:'',data,...event};
    for(const listener of [...listeners])listener(value);
  };
  const send=request=>{calls.push(request);return options.send?.(request,{emit,listeners})};
  if(!options.noBridge)window.electronBridge={sendMessageFromView:send};
  const page={isClosed:()=>!!options.closed,url:()=>options.pageUrl||APP,
    evaluate:async(fn,args)=>{
      evaluations.push(args);if(options.evaluateThrows)throw Error('synthetic browser connection unavailable');
      const context={window,location:{href:options.location||APP},setTimeout,clearTimeout,Date:options.expired?{now:()=>args.deadline+1}:Date};
      return vm.runInNewContext(`(${fn.toString()})(${JSON.stringify(args)})`,context);
    }};
  return {page,request:createDesktopRequest(page),calls,evaluations,listeners,emit};
}
function plain(value){return JSON.parse(JSON.stringify(value));}
test('official main-window envelope uses the existing local host and strips every private metadata field',async()=>{
  const f=fixture({send:(request,{emit})=>{
    assert.equal(request.type,'mcp-request');assert.equal(request.hostId,'local');
    assert.equal(request.request.jsonrpc,'2.0');assert.equal(request.request.method,'thread/read');
    assert.deepEqual(plain(request.request.params),{threadId:A,includeTurns:false});
    emit(request,{result:{thread:{id:A,status:{type:'notLoaded',private:'PRIVATE_STATUS'},turns:[],title:'PRIVATE_TITLE',preview:'PRIVATE_PREVIEW',firstUserMessage:'PRIVATE_MESSAGE',source:'vscode',creatorAccountId:'PRIVATE_ACCOUNT'},private:'PRIVATE_RESULT'}});
  }});
  const result=await f.request('thread/read',A,{timeoutMs:100});
  assert.deepEqual(plain(result),{thread:{id:A,status:{type:'notLoaded'},turns:[]}});
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);assert.equal(f.calls.length,1);assert.equal(f.listeners.size,0);
});
test('archive returns only an empty result, with a new unique id and one dispatch per explicit call',async()=>{
  const f=fixture({send:(request,{emit})=>emit(request,{result:{private:'PRIVATE_ARCHIVE_RESULT'}})});
  assert.deepEqual(plain(await f.request('thread/archive',A,{timeoutMs:100})),{});
  assert.deepEqual(plain(await f.request('thread/archive',A,{timeoutMs:100})),{});
  assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].request.id,f.calls[1].request.id);
  assert.deepEqual(plain(f.calls[0].request.params),{threadId:A});assert.equal(f.listeners.size,0);
});
test('ignores replies from other frames, origins, hosts, request ids and message types',async()=>{
  const f=fixture();let settled=false;
  const pending=f.request('thread/archive',A,{timeoutMs:500}).then(value=>{settled=true;return value;});
  await tick();const request=f.calls[0];
  const reply={result:{}};
  f.emit(request,reply,{source:{}});f.emit(request,reply,{origin:'https://untrusted.invalid'});
  f.emit(request,reply,{data:{type:'mcp-response',hostId:'remote',message:{id:request.request.id,result:{}}}});
  f.emit(request,reply,{data:{type:'mcp-response',hostId:'local',message:{id:'wrong-id',result:{}}}});
  f.emit(request,reply,{data:{type:'mcp-notification',hostId:'local',message:{id:request.request.id,result:{}}}});
  await tick();assert.equal(settled,false);assert.equal(f.calls.length,1);
  f.emit(request,reply);assert.deepEqual(plain(await pending),{});assert.equal(f.listeners.size,0);
});
test('the IPC acknowledgement alone cannot be mistaken for an archive result',async()=>{
  const f=fixture({send:()=>Promise.resolve({result:{}})});
  await assert.rejects(f.request('thread/archive',A,{timeoutMs:15}),isCode('APP_SERVER_TIMEOUT'));
  assert.equal(f.calls.length,1);assert.equal(f.listeners.size,0);
});
test('rejects a reply for another thread, or any reply carrying message bodies',async()=>{
  for(const thread of [{id:B,status:{type:'notLoaded'},turns:[]},{id:A,status:{type:'notLoaded'},turns:[{text:'PRIVATE_BODY'}]},
    {id:A,status:{type:'notLoaded'},turns:{text:'PRIVATE_BODY'}}]){
    const f=fixture({send:(request,{emit})=>emit(request,{result:{thread}})});
    await assert.rejects(f.request('thread/read',A,{timeoutMs:100}),isCode('INVALID_THREAD_METADATA'));
    assert.equal(f.calls.length,1);assert.equal(f.listeners.size,0);
  }
});
test('classifies related-thread writer errors without exposing the native message or private path',async()=>{
  const f=fixture({send:(request,{emit})=>emit(request,{error:{code:-32600,message:`thread ${B} already has an active writer; PRIVATE_PATH PRIVATE_MESSAGE`}})});
  await assert.rejects(f.request('thread/archive',A,{timeoutMs:100}),error=>{
    assert.equal(error.code,'APP_SERVER_RPC_FAILED');assert.deepEqual(error.details,{method:'thread/archive',reason:'active_writer',nativeCode:-32600});
    assert.doesNotMatch(JSON.stringify(error)+error.message,/PRIVATE|22222222/);return true;
  });assert.equal(f.calls.length,1);assert.equal(f.listeners.size,0);
});
test('preserves structured sharing-violation diagnostics without raw error text',async()=>{
  const f=fixture({send:(request,{emit})=>emit(request,{error:{code:-32603,message:'failed at PRIVATE_PATH (os error 32)'}})});
  await assert.rejects(f.request('thread/archive',A,{timeoutMs:100}),error=>error.code==='APP_SERVER_RPC_FAILED'&&error.details.reason==='file_in_use'&&error.details.osCode===32);
});
test('rejects non-object and array RPC results instead of calling them success',async()=>{
  for(const result of [null,false,0,'PRIVATE_BODY',[]]){
    const f=fixture({send:(request,{emit})=>emit(request,{result})});
    await assert.rejects(f.request('thread/archive',A,{timeoutMs:100}),isCode('INVALID_APP_SERVER_RESPONSE'));
    assert.equal(f.calls.length,1);assert.equal(f.listeners.size,0);
  }
});
test('checks the main window, URL and bridge before sending anything',async()=>{
  for(const options of [{closed:true},{pageUrl:'https://untrusted.invalid'},{subframe:true},{location:'app://-/other.html'},{noBridge:true},{evaluateThrows:true}]){
    const f=fixture(options);await assert.rejects(f.request('thread/archive',A,{timeoutMs:100}),isCode('DESKTOP_ARCHIVE_UNAVAILABLE'));assert.equal(f.calls.length,0);
  }
});
test('expired deadlines and pre-aborted requests cannot dispatch a write',async()=>{
  const expired=fixture({expired:true});await assert.rejects(expired.request('thread/archive',A,{timeoutMs:100}),isCode('APP_SERVER_TIMEOUT'));assert.equal(expired.calls.length,0);
  const cancelled=fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(cancelled.request('thread/archive',A,{signal:controller.signal,timeoutMs:100}),isCode('ABORTED'));assert.equal(cancelled.evaluations.length,0);assert.equal(cancelled.calls.length,0);
});
test('invalid identities and unrelated methods never enter the window',async()=>{
  const f=fixture();for(const [method,id] of [['thread/delete',A],['thread/archive','bad-id'],['tools/call',A]])await assert.rejects(f.request(method,id,{timeoutMs:100}),isCode('INVALID_THREAD_ID'));
  assert.equal(f.evaluations.length,0);assert.equal(f.calls.length,0);
});
test('timeout does not retry a possibly dispatched write or retain a response listener',async()=>{
  const f=fixture();await assert.rejects(f.request('thread/archive',A,{timeoutMs:15}),isCode('APP_SERVER_TIMEOUT'));
  assert.equal(f.calls.length,1);assert.equal(f.listeners.size,0);f.emit(f.calls[0],{result:{}});await tick();assert.equal(f.calls.length,1);
});
test('synchronous and asynchronous preload failures stop without fallback or retry',async()=>{
  for(const send of [()=>{throw Error('PRIVATE_FAILURE');},()=>Promise.reject(Error('PRIVATE_FAILURE'))]){
    const f=fixture({send});await assert.rejects(f.request('thread/archive',A,{timeoutMs:100}),isCode('DESKTOP_ARCHIVE_UNAVAILABLE'));assert.equal(f.calls.length,1);assert.equal(f.listeners.size,0);
  }
});
test('cancellation after dispatch cannot retract the current action and never resubmits it',async()=>{
  const f=fixture(),controller=new AbortController();const pending=f.request('thread/archive',A,{signal:controller.signal,timeoutMs:500});
  await tick();assert.equal(f.calls.length,1);controller.abort();f.emit(f.calls[0],{result:{}});
  assert.deepEqual(plain(await pending),{});assert.equal(f.calls.length,1);assert.equal(f.listeners.size,0);
});
