'use strict';
// Build a local plugin from reviewed files only. No install, configuration edit,
// package-manager lifecycle, source-tree traversal, or cleanup is performed.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify,TextDecoder}=require('node:util');
const {createHash}=require('node:crypto');
const run=promisify(execFile);
const DEFAULT_OUTPUT=path.join('dist','conversation-manager-plugin');
const ARCHIVE_ALLOWLIST=Object.freeze(['module-state.cjs','windows-mutex.cjs','archive-core.cjs',
  'archive-app-server.cjs','archive-server.cjs','archive-catalog.py','archive-panel.html','sync-relations.py']);
const ROOT_FILES=Object.freeze(['plugin.json','mcp.json','NOTICE.md','LICENSE']);
const MAX_BYTES=2*1024*1024;
const PERSONAL_PATH=/(?:[a-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+|\/(?:Users|home)\/[^/\s"'<>]+)/i;
const SEMVER=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
function fail(code,message){return Object.assign(new Error(message),{code});}
function same(left,right){return process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;}
function within(parent,child){const relative=path.relative(parent,child);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));}
function object(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function keys(value,allowed,code){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw fail(code,'Unexpected or unsupported metadata fields');}
function string(value){return typeof value==='string'&&value.trim().length>0;}
function publicStrings(value){
  if(typeof value==='string'&&(PERSONAL_PATH.test(value)||path.win32.isAbsolute(value)||path.posix.isAbsolute(value)||/^file:/i.test(value)))throw fail('PRIVATE_METADATA','Plugin metadata must not contain absolute local paths');
  if(Array.isArray(value))for(const item of value)publicStrings(item);
  else if(object(value))for(const item of Object.values(value))publicStrings(item);
}
function validateManifest(value){
  if(!object(value)||value.schemaVersion!==1||!Array.isArray(value.archiveFiles)||!Array.isArray(value.files))throw fail('INVALID_ARCHIVE_FILES','runtime-manifest.json needs schemaVersion 1 and archiveFiles');
  if(value.archiveFiles.length!==ARCHIVE_ALLOWLIST.length||new Set(value.archiveFiles).size!==value.archiveFiles.length||
     value.archiveFiles.some(name=>typeof name!=='string'||!ARCHIVE_ALLOWLIST.includes(name)||!value.files.includes(name))||
     ARCHIVE_ALLOWLIST.some(name=>!value.archiveFiles.includes(name)))throw fail('INVALID_ARCHIVE_FILES','archiveFiles must contain the complete reviewed archive-only basename allowlist');
  return [...value.archiveFiles];
}
function validatePlugin(value){
  const code='INVALID_PLUGIN_METADATA';
  keys(value,['$schema','name','version','description','author','homepage','repository','license','keywords','extensions'],code);
  if(value.$schema!=='https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'||
     !string(value.name)||!/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value.name)||value.name.length>64||
     !string(value.version)||!SEMVER.test(value.version))throw fail(code,'Invalid portable plugin identity or semantic version');
  for(const key of ['description','homepage','repository','license'])if(value[key]!==undefined&&!string(value[key]))throw fail(code,'Invalid plugin text field');
  if(value.author!==undefined){keys(value.author,['name','email','url'],code);if(Object.values(value.author).some(item=>!string(item)))throw fail(code,'Invalid author metadata');}
  if(value.keywords!==undefined&&(!Array.isArray(value.keywords)||value.keywords.some(item=>!string(item))))throw fail(code,'Invalid plugin keywords');
  keys(value.extensions,['com.openai'],code);keys(value.extensions['com.openai'],['interface'],code);
  const ui=value.extensions['com.openai'].interface;
  keys(ui,['displayName','shortDescription','longDescription','developerName','category','capabilities','defaultPrompt'],code);
  for(const key of ['displayName','shortDescription','longDescription','developerName','category'])if(!string(ui[key]))throw fail(code,'Incomplete plugin presentation');
  if(ui.shortDescription.length>30||ui.category!=='Productivity'||!Array.isArray(ui.capabilities)||ui.capabilities.some(item=>!string(item)))throw fail(code,'Invalid listing subtitle, category or capabilities');
  if(ui.defaultPrompt!==undefined&&!(string(ui.defaultPrompt)||(Array.isArray(ui.defaultPrompt)&&ui.defaultPrompt.length>0&&ui.defaultPrompt.length<=3&&ui.defaultPrompt.every(string))))throw fail(code,'Invalid default prompt');
  publicStrings(value);return value;
}
function validateMcp(value){
  const code='INVALID_MCP_METADATA';keys(value,['$schema','mcpServers'],code);
  if(value.$schema!=='https://agent-plugins.org/schemas/1.0.0/mcp.schema.json')throw fail(code,'Invalid portable MCP schema');
  keys(value.mcpServers,['conversation-manager'],code);
  const server=value.mcpServers['conversation-manager'];keys(server,['type','command','args','cwd','env'],code);
  if(server.type!=='stdio'||server.command!=='node'||server.cwd!=='${PLUGIN_ROOT}'||
     !Array.isArray(server.args)||server.args.length!==1||server.args[0]!=='${PLUGIN_ROOT}/src/archive-server.cjs')throw fail(code,'Only the independent archive stdio entry point can be packaged');
  if(server.env!==undefined){
    // Installed wrappers may use private environment paths. The portable source
    // must never copy those paths or credentials into a public package.
    keys(server.env,['PYTHONIOENCODING'],code);
    if(Object.values(server.env).some(item=>item!=='utf-8'))throw fail(code,'Only public UTF-8 encoding configuration is supported');
  }
  publicStrings(value);return value;
}
function ancestors(absolute){const result=[];let current=absolute;for(;;){result.push(current);const parent=path.dirname(current);if(parent===current)break;current=parent;}return result.reverse();}
async function existing(absolute){try{return await fs.lstat(absolute);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function noReparse(paths,windowsAttributes=true){
  const unique=[...new Set(paths.flatMap(ancestors))],present=[];
  for(const file of unique){const stat=await existing(file);if(!stat)continue;if(stat.isSymbolicLink())throw fail('REPARSE_POINT','Build paths must not contain symbolic links or reparse points');present.push(file);}
  if(windowsAttributes&&process.platform==='win32'&&present.length){
    const command="$ErrorActionPreference='Stop'; $paths=ConvertFrom-Json $env:CNCC_PLUGIN_BUILD_PATHS; $found=@(); foreach($p in $paths){if(([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0){$found+=$p}}; @{reparse=$found}|ConvertTo-Json -Compress";
    const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:10000,maxBuffer:65536,env:{...process.env,CNCC_PLUGIN_BUILD_PATHS:JSON.stringify(present)}});
    if(JSON.parse(result.stdout.trim()).reparse.length)throw fail('REPARSE_POINT','Build paths must not contain Windows reparse points');
  }
}
function safeOutput(root,output){
  const driveRoot=path.parse(output).root;
  if(same(output,driveRoot)||same(output,root)||within(output,root)||/^\\\\/.test(output))throw fail('UNSAFE_OUTPUT','Output must be a new, dedicated plugin directory');
  if(within(root,output)){
    const dist=path.join(root,'dist');if(!within(dist,output)||same(dist,output))throw fail('UNSAFE_OUTPUT','Inside the source repository, output is allowed only below dist');
  }
  const roaming=process.env.APPDATA,local=process.env.LOCALAPPDATA;
  // A dedicated plugin directory in AppData is a normal per-user install.
  // Protect actual client/profile trees, rather than denying that whole area.
  const profileTrees=[
    ...(roaming?['Codex','ChatGPT',path.join('Mozilla','Firefox','Profiles')].map(item=>path.join(roaming,item)):[]),
    ...(local?['Packages','OpenAI',path.join('Google','Chrome','User Data'),path.join('Microsoft','Edge','User Data'),
      path.join('Chromium','User Data'),path.join('BraveSoftware','Brave-Browser','User Data')].map(item=>path.join(local,item)):[])
  ];
  const protectedTrees=[process.env.SystemRoot,process.env.WINDIR,process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.ProgramData,
    path.join(os.homedir(),'.codex'),path.join(os.homedir(),'.agents'),...profileTrees].filter(Boolean).map(item=>path.resolve(item));
  if(protectedTrees.some(item=>within(item,output)))throw fail('UNSAFE_OUTPUT','Output must stay outside system, installed-program, client-profile and agent-configuration directories');
  const temporary=path.resolve(os.tmpdir());
  if([os.homedir(),temporary,...[process.env.APPDATA,process.env.LOCALAPPDATA].filter(Boolean)].some(item=>same(path.resolve(item),output)))throw fail('UNSAFE_OUTPUT','Output cannot replace a shared user directory');
  for(const part of output.slice(driveRoot.length).split(path.sep))if(/[.:]$/.test(part)||/[<>:"|?*]/.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)||/ $/.test(part))throw fail('UNSAFE_OUTPUT','Output contains an unsafe or aliased path segment');
}
async function readSource(root,relative){
  const file=path.join(root,relative);await noReparse([file],false);
  const before=await fs.lstat(file);if(!before.isFile()||before.size>MAX_BYTES)throw fail('INVALID_SOURCE','Source must be a regular UTF-8 file under 2 MiB');
  const handle=await fs.open(file,'r');let bytes;
  try{const opened=await handle.stat();if(opened.dev!==before.dev||opened.ino!==before.ino)throw fail('SOURCE_CHANGED','Source changed during the build');bytes=await handle.readFile();}
  finally{await handle.close();}
  const after=await fs.lstat(file);
  if(after.isSymbolicLink()||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw fail('SOURCE_CHANGED','Source changed during the build');
  if(bytes.length>MAX_BYTES||bytes.includes(0))throw fail('INVALID_SOURCE','Binary or oversized source is excluded');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw fail('INVALID_SOURCE','Source must be valid UTF-8');}
  if(PERSONAL_PATH.test(text))throw fail('PRIVATE_SOURCE','Source contains a personal absolute path');
  return {bytes,text};
}
function json(text){try{return JSON.parse(text.replace(/^\uFEFF/,''));}catch{throw fail('INVALID_JSON','A packaging manifest is not valid JSON');}}
async function collectPluginSources(root){
  const sourcePaths=['runtime-manifest.json',...ROOT_FILES,...ARCHIVE_ALLOWLIST.map(name=>path.join('src',name))].map(name=>path.join(root,name));
  await noReparse([root,...sourcePaths]);
  const manifest=validateManifest(json((await readSource(root,'runtime-manifest.json')).text));
  const entries=[];
  for(const relative of ROOT_FILES){const content=await readSource(root,relative);if(relative==='plugin.json')validatePlugin(json(content.text));if(relative==='mcp.json')validateMcp(json(content.text));entries.push({relative,...content});}
  for(const name of manifest)entries.push({relative:'src/'+name,...await readSource(root,path.join('src',name))});
  return {manifest,entries,sourcePaths};
}
async function build(options={}){
  const root=path.resolve(options.root||path.join(__dirname,'..'));
  const output=path.resolve(options.outputDir===undefined?path.join(root,DEFAULT_OUTPUT):options.outputDir);
  safeOutput(root,output);
  await noReparse([path.dirname(output)]);
  if(await existing(output))throw fail('OUTPUT_EXISTS','The output directory already exists; choose a new directory');
  const {manifest,entries,sourcePaths}=await collectPluginSources(root);
  // Validate everything before creating any output. A later I/O error leaves a
  // partial new directory for inspection; it never deletes or replaces a path.
  await noReparse([path.dirname(output),...sourcePaths]);await fs.mkdir(path.dirname(output),{recursive:true});
  await noReparse([path.dirname(output)]);
  try{await fs.mkdir(output);}catch(error){if(error.code==='EEXIST')throw fail('OUTPUT_EXISTS','The output directory already exists; choose a new directory');throw error;}
  await fs.mkdir(path.join(output,'src'));
  const files=[];
  for(const entry of entries){
    await noReparse([output,path.join(output,'src')],false);
    await fs.writeFile(path.join(output,entry.relative),entry.bytes,{flag:'wx'});
    files.push({path:entry.relative,bytes:entry.bytes.length,sha256:createHash('sha256').update(entry.bytes).digest('hex')});
  }
  return {outputDir:output,files,archiveFiles:[...manifest]};
}
function parseArgs(args){
  let outputDir,help=false;
  for(let index=0;index<args.length;index++){
    const arg=args[index];if(arg==='--help'||arg==='-h')help=true;
    else if(arg==='--output-dir'&&outputDir===undefined&&typeof args[index+1]==='string'&&args[index+1].length&&!args[index+1].startsWith('-'))outputDir=args[++index];
    else throw fail('INVALID_ARGUMENT','Use --output-dir <new-directory> or --help');
  }
  return {outputDir,help};
}
if(require.main===module){
  (async()=>{const options=parseArgs(process.argv.slice(2));if(options.help){console.log('Usage: node scripts/build-plugin.cjs [--output-dir <new-directory>]\nDefault: dist/conversation-manager-plugin\nBuilds a clean plugin only; does not install it. Existing outputs are never replaced.');return;}console.log(JSON.stringify(await build(options),null,2));})()
    .catch(error=>{console.error(JSON.stringify({code:error.code||'BUILD_FAILED',message:error.message}));process.exitCode=1;});
}
module.exports={build,collectPluginSources,parseArgs,validateManifest,validatePlugin,validateMcp,ARCHIVE_ALLOWLIST,ROOT_FILES,DEFAULT_OUTPUT};
