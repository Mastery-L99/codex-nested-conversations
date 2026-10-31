(() => {
  'use strict';
  window.__codexNestedHostEvents?.dispose();
  const ROW='[data-app-action-sidebar-thread-row]';
  const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const methods=new Set(['thread/started','thread/archived','thread/unarchived','thread/deleted','thread/name/updated']);
  let disposed=false,scheduled=false,lastMembers='',lastPreferences='',lastInteraction='';
  let events=0;
  function notify(reason,extra={}) {
    if(disposed||typeof window.__codexNestedNotify!=='function')return;
    events++;
    Promise.resolve(window.__codexNestedNotify({reason,...extra})).catch(()=>{});
  }
  function hostMessage(event) {
    const data=event.data;
    if(!data||data.type!=='mcp-notification') {
      if(data?.type==='thread-project-memberships-updated')notify('membership');
      return;
    }
    const params=data.params??{},method=data.method;
    if(methods.has(method)) {
      const raw=params.threadId??params.thread?.id;
      notify('native',{method,...(uuid.test(raw??'')?{threadId:raw}:{})});
    } else if(method==='item/completed') {
      const item=params.item;
      if(item?.type==='mcpToolCall' && /(?:^|__)codex_app$/.test(item.server??'') &&
        ['create_thread','fork_thread','set_thread_archived','set_thread_title'].includes(item.tool)) {
        const edge=creationEdge(item,params.threadId);
        notify('native',{method:'tool:'+item.tool,...(edge?{edge}:{})});
      }
    }
  }
  function creationEdge(item,parent){
    if(!['create_thread','fork_thread'].includes(item.tool)||item.result?.isError)return null;
    const values=[item.result?.structuredContent,item.result];
    for(const block of item.result?.content??[])if(block.type==='text'){try{values.push(JSON.parse(block.text))}catch{}}
    for(const value of values){
      if(!value||typeof value!=='object')continue;
      const child=value.threadId,source=item.tool==='fork_thread'?value.sourceThreadId:parent;
      if(uuid.test(source??'')&&uuid.test(child??'')&&source!==child&&(value.hostId??'local')==='local')return {parentId:source,childId:child};
    }
    return null;
  }
  function reconcileMetadata() {
    scheduled=false;if(disposed)return;
    const root=document.querySelector('#app-shell-sidebar');
    const members=JSON.stringify(root?[...new Set([...root.querySelectorAll(ROW)].map(e=>
      e.getAttribute('data-app-action-sidebar-thread-id')+'|'+e.getAttribute('data-app-action-sidebar-thread-title')))].sort():[]);
    if(members!==lastMembers){lastMembers=members;notify('membership');}
    const preferences={expanded:window.__codexNestedRuntime?.getExpansionState?.()??[],aliases:window.__codexNestedRuntime?.getIdentityAliases?.()??[]};
    const preferenceSignature=JSON.stringify(preferences);
    if(preferenceSignature!==lastPreferences){lastPreferences=preferenceSignature;notify('preferences',preferences);}
    const cascade=window.__codexNestedCascade?.inspect();
    const bulk=window.__codexNestedBulk?.inspect();
    const interaction={busy:!!cascade?.busy||!!bulk?.previewPending,dialogOpen:!!cascade?.dialogOpen||!!bulk?.dialogOpen,previewOpen:!!cascade?.previewOpen,
      menuOpen:!!window.__codexNestedRuntime?.inspect().nativeMenuOpen||[...document.querySelectorAll('[role="menu"]')].some(e=>e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}))};
    const signature=JSON.stringify(interaction);
    if(signature!==lastInteraction){lastInteraction=signature;notify('interaction',interaction);}
  }
  function schedule(){if(!scheduled&&!disposed){scheduled=true;queueMicrotask(reconcileMetadata);}}
  const observer=new MutationObserver(records=>{
    if(records.some(record=>{
      const root=document.querySelector('#app-shell-sidebar');
      if(root&&(record.target===root||root.contains(record.target)))return true;
      return [...record.addedNodes,...record.removedNodes].some(n=>n.nodeType===1&&
        (n.matches?.('[role="menu"],[role="dialog"],#app-shell-sidebar')||n.querySelector?.('[role="menu"],[role="dialog"],#app-shell-sidebar')));
    }))schedule();
  });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,
    attributeFilter:['data-app-action-sidebar-thread-id','data-app-action-sidebar-thread-title','data-state','hidden']});
  function identityChanged(){notify('membership');schedule();}
  function focused(){notify('focus');schedule();}
  window.addEventListener('message',hostMessage,true);
  window.addEventListener('focus',focused);
  document.addEventListener('codex-nested:identity-mapped',identityChanged);
  document.addEventListener('codex-nested:state-changed',schedule);
  window.__codexNestedHostEvents={inspect:()=>({installed:!disposed,events}),dispose(){
    disposed=true;observer.disconnect();window.removeEventListener('message',hostMessage,true);
    window.removeEventListener('focus',focused);document.removeEventListener('codex-nested:identity-mapped',identityChanged);
    document.removeEventListener('codex-nested:state-changed',schedule);
  }};
  schedule();return window.__codexNestedHostEvents.inspect();
})();
