'use strict';
// Only the inspected preload world is adapted. No Electron/Node bridge is read.
const relaySource=`(()=>{
  window.__codexNestedPreloadRelay?.dispose();
  const descriptor=Object.getOwnPropertyDescriptor(window,'dispatchEvent');
  const original=window.dispatchEvent;
  let intercepted=0,disposed=false;
  function dispatch(event,...args){
    if(this===window && !disposed && event?.type==='message' && event.source==null && event.origin==='' &&
       event.data?.type==='archive-thread' && event.data?.source==='native_accelerator') {
      const signal=new CustomEvent('codex-nested:archive-request',{cancelable:true,detail:{version:1,source:'native_accelerator'}});
      if(!Reflect.apply(original,window,[signal])){intercepted++;return true;}
    }
    return Reflect.apply(original,this,[event,...args]);
  }
  Object.defineProperty(window,'dispatchEvent',{configurable:true,writable:true,value:dispatch});
  window.__codexNestedPreloadRelay={inspect:()=>({installed:!disposed,intercepted}),dispose(){
    if(disposed)return;disposed=true;
    if(window.dispatchEvent===dispatch){if(descriptor)Object.defineProperty(window,'dispatchEvent',descriptor);else delete window.dispatchEvent;}
  }};
  return window.__codexNestedPreloadRelay.inspect();
})()`;
async function createPreloadRelay(page){
  const session=await page.context().newCDPSession(page);
  const contexts=new Map();let stopped=false,frameId;
  async function inject(context){
    if(stopped||context.name!=='Electron Isolated Context'||context.auxData?.isDefault||context.auxData?.frameId!==frameId)return;
    const result=await session.send('Runtime.evaluate',{expression:relaySource,contextId:context.id,returnByValue:true});
    if(result.exceptionDetails)throw Error('Native shortcut relay could not be installed');
  }
  const tree=await session.send('Page.getFrameTree');frameId=tree.frameTree.frame.id;
  session.on('Runtime.executionContextCreated',({context})=>{contexts.set(context.id,context);void inject(context).catch(()=>{});});
  session.on('Runtime.executionContextDestroyed',e=>contexts.delete(e.executionContextId));
  session.on('Runtime.executionContextsCleared',()=>contexts.clear());
  await session.send('Runtime.enable');
  for(const context of contexts.values())await inject(context);
  return {async inspect(){
    const results=[];
    for(const context of contexts.values())if(context.name==='Electron Isolated Context'&&context.auxData?.frameId===frameId){
      const r=await session.send('Runtime.evaluate',{expression:'window.__codexNestedPreloadRelay?.inspect()',contextId:context.id,returnByValue:true});results.push(r.result.value);
    }
    return results;
  },async stop(){
    stopped=true;
    const errors=[];
    for(const context of contexts.values())if(context.name==='Electron Isolated Context'&&context.auxData?.frameId===frameId){
      try {
        const result=await session.send('Runtime.evaluate',{expression:'(()=>{window.__codexNestedPreloadRelay?.dispose();return window.__codexNestedPreloadRelay?.inspect()?.installed!==true})()',contextId:context.id,returnByValue:true});
        if(result.exceptionDetails||result.result.value!==true)errors.push('Native shortcut relay was not restored');
      } catch(error) {if(contexts.has(context.id)&&!page.isClosed())errors.push(error.message);}
    }
    await session.detach().catch(()=>{});
    return {restored:errors.length===0,errors};
  }};
}
module.exports={createPreloadRelay,relaySource};
