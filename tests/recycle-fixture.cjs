'use strict';
// A test may recycle only a direct child of the system temp directory that this
// helper created in this process. There is deliberately no permanent-delete path.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const owned=new Map();
function fail(code){return Object.assign(new Error(code),{code});}
function samePath(left,right){return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;}
async function createFixture(prefix){
  if(typeof prefix!=='string'||!/^cncc-[a-z0-9]+(?:-[a-z0-9]+)*-$/.test(prefix))throw fail('INVALID_FIXTURE_PREFIX');
  const temporaryRoot=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(temporaryRoot,prefix)),stat=await fs.lstat(root);
  owned.set(root,{temporaryRoot,prefix,device:stat.dev,inode:stat.ino});
  return root;
}
async function recycleFixture(root){
  if(typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root)throw fail('INVALID_FIXTURE_PATH');
  const record=owned.get(root);if(!record)throw fail('UNOWNED_FIXTURE');
  const stat=await fs.lstat(root),real=await fs.realpath(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==record.device||stat.ino!==record.inode||
    !samePath(real,root)||!samePath(path.dirname(real),record.temporaryRoot)||
    !path.basename(real).startsWith(record.prefix))throw fail('UNSAFE_FIXTURE_PATH');
  if(process.platform!=='win32')throw fail('RECYCLE_REQUIRES_WINDOWS');
  const command="$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; "+
    '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CNCC_TEST_RECYCLE_FOLDER,'+
    '[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,'+
    '[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,'+
    '[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException); '+
    "@{recycled=$true}|ConvertTo-Json -Compress";
  // The target is passed literally in the environment, never interpolated into
  // shell source. A recycle failure rejects the cleanup hook and preserves the
  // fixture; callers must not fall back to fs.rm or any other deletion API.
  const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],
    {windowsHide:true,timeout:30000,env:{...process.env,CNCC_TEST_RECYCLE_FOLDER:root}});
  if(JSON.parse(result.stdout.trim()).recycled!==true)throw fail('RECYCLE_NOT_CONFIRMED');
  try{await fs.lstat(root);throw fail('RECYCLE_NOT_CONFIRMED');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  owned.delete(root);return {path:root,recycled:true};
}
module.exports={createFixture,recycleFixture};
