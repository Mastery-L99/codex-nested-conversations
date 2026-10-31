'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {withNamedMutex}=require('./windows-mutex.cjs');
const defaults=Object.freeze({schemaVersion:1,revision:0,nestingEnabled:true,archiveEnabled:true});
function invalid(message){return Object.assign(new Error(message),{code:'INVALID_MODULE_STATE'});}
function parse(value){
  if(!value||value.schemaVersion!==1||!Number.isSafeInteger(value.revision)||value.revision<0||
     typeof value.nestingEnabled!=='boolean'||typeof value.archiveEnabled!=='boolean')throw invalid('Module settings could not be read');
  return {schemaVersion:1,revision:value.revision,nestingEnabled:value.nestingEnabled,archiveEnabled:value.archiveEnabled};
}
function defaultDataDir(){return path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'CodexNestedConversationsData');}
// MSIX and a manually launched helper can see different physical LocalAppData
// directories under the same logical path. Store shared switches outside it.
function defaultSettingsDir(){return path.join(os.homedir(),'.codex-nested-conversations','settings');}
async function readModuleState(dataDir=process.env.CNCC_SETTINGS_DIR||defaultSettingsDir()){
  try{return parse(JSON.parse((await fs.readFile(path.join(dataDir,'module-state.json'),'utf8')).replace(/^\uFEFF/,'')));}
  catch(error){if(error.code==='ENOENT')return {...defaults};throw error;}
}
function createModuleStore({dataDir=process.env.CNCC_SETTINGS_DIR||defaultSettingsDir(),withLock}={}){
  const root=path.resolve(dataDir);
  const name='Local\\CnccModules-'+require('node:crypto').createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0,32);
  const lock=withLock||((work)=>withNamedMutex(name,work));
  async function update(patch){
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||
       Object.entries(patch).some(([key,value])=>!['nestingEnabled','archiveEnabled'].includes(key)||typeof value!=='boolean')){
      throw invalid('Only the nesting and archive switches can be changed');
    }
    const result=await lock(async lease=>{
      const current=await readModuleState(root),next={...current,...patch};
      if(current.nestingEnabled===next.nestingEnabled&&current.archiveEnabled===next.archiveEnabled)return current;
      if(current.revision===Number.MAX_SAFE_INTEGER)throw invalid('Module settings revision limit reached');
      next.revision=current.revision+1;
      await fs.mkdir(root,{recursive:true});
      const file=path.join(root,'module-state.json');
      const temporary=path.join(root,`.module-state-${process.pid}-${require('node:crypto').randomUUID()}.json`);
      await fs.writeFile(temporary,JSON.stringify(next,null,2)+'\n',{flag:'wx'});
      lease?.assertHeld?.();await fs.rename(temporary,file);return next;
    });
    if(result?.state==='mutex_busy')throw Object.assign(new Error('Another module setting is being saved; retry shortly'),{code:'MODULE_STATE_BUSY'});
    return result;
  }
  return {read:()=>readModuleState(root),update,dataDir:root};
}
module.exports={defaults,parse,defaultDataDir,defaultSettingsDir,readModuleState,createModuleStore};
