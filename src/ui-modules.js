(() => {
  'use strict';
  window.__codexInstallConversationModules = function install(payload) {
    const {sources,relations,expanded,aliases,features,archiveExecution,shortcutReady}=payload;
    window.__codexNestedRelations=relations;
    window.__codexNestedExpansionState=expanded;
    window.__codexNestedIdentityAliases=aliases;
    window.__codexNestedUiOptions={enabled:features.nestingEnabled};
    window.__codexNestedCascadeOptions={enableArchiveExecution:archiveExecution,
      requireFreshValidation:true,requireNativeMenuBridge:true,requireBatchService:true,enableShortcutInterception:shortcutReady};
    const modules={nesting:{enabled:features.nestingEnabled,state:'unavailable',errors:[]},
      archive:{enabled:features.archiveEnabled,state:'disabled',errors:[]},events:{state:'unavailable',errors:[]}};
    function load(name,target){
      try {if(typeof sources[name]!=='string')throw Error('Module source is unavailable');new Function(sources[name])();return true;}
      catch(error){target.errors.push(String(error.message??error).slice(0,200));return false;}
    }
    function safely(target,work){try{return work();}catch(error){target.errors.push(String(error.message??error).slice(0,200));return undefined;}}
    function dispose(name,target){safely(target,()=>window[name]?.dispose?.());delete window[name];}
    if(load('nested-ui.js',modules.nesting)){
      const state=safely(modules.nesting,()=>window.__codexNestedRuntime?.inspect?.());
      modules.nesting.state=!features.nestingEnabled?'disabled':state?.errors?.length?'display_error':state?.installed?'ready':'unavailable';
      modules.nesting.displayState=state?.state??null;
      modules.nesting.errors.push(...(state?.errors??[]));
    } else {dispose('__codexNestedRuntime',modules.nesting);}
    if(features.archiveEnabled){
      if(load('cascade-actions.js',modules.archive)){
        safely(modules.archive,()=>window.__codexNestedCascade?.setEnabled?.(true));
        if(load('bulk-archive.js',modules.archive))modules.archive.state=archiveExecution&&(typeof window.__codexNestedBatchArchive==='function'||typeof window.__codexNestedRuntime?.openNativeMenu==='function')?'ready':'preview_only';
        else {dispose('__codexNestedBulk',modules.archive);}
      } else {dispose('__codexNestedBulk',modules.archive);dispose('__codexNestedCascade',modules.archive);}
    } else {
      dispose('__codexNestedBulk',modules.archive);dispose('__codexNestedCascade',modules.archive);
    }
    if(load('host-events.js',modules.events))modules.events.state='ready';
    else dispose('__codexNestedHostEvents',modules.events);
    if(modules.nesting.errors.length&&features.nestingEnabled)modules.nesting.state='display_error';
    if(modules.archive.errors.length&&features.archiveEnabled)modules.archive.state='error';
    window.__codexConversationModuleStatus=modules;
    return modules;
  };
})();
