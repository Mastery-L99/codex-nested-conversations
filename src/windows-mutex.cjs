'use strict';
const {spawn}=require('node:child_process');
function fault(code){return Object.assign(new Error(code),{code});}
async function withNamedMutex(name,callback){
  if(process.platform!=='win32')throw fault('UNSUPPORTED_PLATFORM');
  if(!/^Local\\Cncc[A-Za-z0-9-]{1,100}$/.test(name))throw fault('INVALID_MUTEX_NAME');
  const command="$ErrorActionPreference='Stop'; $m=New-Object System.Threading.Mutex($false,$env:CNCC_PRIVATE_MUTEX); $held=$false; try { try {$held=$m.WaitOne(0)} catch [System.Threading.AbandonedMutexException] {$held=$true}; if($held){[Console]::Out.WriteLine('{\"acquired\":true}');[Console]::Out.Flush();$null=[Console]::In.ReadLine()}else{[Console]::Out.WriteLine('{\"acquired\":false}')} } finally {if($held){$m.ReleaseMutex()};$m.Dispose()}";
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,env:{...process.env,CNCC_PRIVATE_MUTEX:name},stdio:['pipe','pipe','ignore']});
  let line='',releasing=false,lost=false;
  child.on('exit',()=>{if(!releasing)lost=true;});
  try{
    const acquired=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>done(fault('MUTEX_TIMEOUT')),5000);
      const done=(error,value)=>{clearTimeout(timer);child.stdout.removeListener('data',data);child.removeListener('error',fail);child.removeListener('exit',exit);error?reject(error):resolve(value);};
      const fail=()=>done(fault('MUTEX_FAILED'));
      const exit=()=>done(fault('MUTEX_FAILED'));
      const data=chunk=>{line+=chunk.toString('utf8');if(line.length>1024)return fail();if(line.includes('\n')){try{done(null,JSON.parse(line.split('\n')[0]).acquired===true);}catch{fail();}}};
      child.stdout.on('data',data);child.once('error',fail);child.once('exit',exit);
    });
    if(!acquired)return {state:'mutex_busy'};
    return await callback({assertHeld(){if(lost||child.exitCode!=null)throw fault('MUTEX_LOST');}});
  }finally{
    releasing=true;child.stdin.on('error',()=>{});child.stdin.end('\n');
    const timer=setTimeout(()=>child.kill(),1000);timer.unref();child.once('exit',()=>clearTimeout(timer));
  }
}
module.exports={withNamedMutex};
