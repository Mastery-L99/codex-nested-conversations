'use strict';
// All write, link and failure fixtures are created under one owned temporary
// directory and sent to the recycle bin by the shared helper. No CLI install,
// production profile, network request or real chat operation is performed.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {build,parseArgs,validateManifest,validatePlugin,validateMcp,ARCHIVE_ALLOWLIST,ROOT_FILES,DEFAULT_OUTPUT}=require('../scripts/build-plugin.cjs');
const {createFixture,recycleFixture}=require('./recycle-fixture.cjs');
const repo=path.resolve(__dirname,'..');
const isCode=code=>error=>error.code===code;
async function names(root,prefix=''){
  const result=[];
  for(const entry of await fs.readdir(root,{withFileTypes:true})){const relative=prefix+entry.name;
    if(entry.isDirectory())result.push(...await names(path.join(root,entry.name),relative+'/'));else result.push(relative);
  }
  return result.sort();
}
test('clean independent local plugin package',async t=>{
  if(process.platform!=='win32'){t.skip('Fixture cleanup requires Windows recycle bin');return;}
  const temporary=await createFixture('cncc-plugin-package-');
  t.after(async()=>{const result=await recycleFixture(temporary);assert.equal(result.recycled,true);});
  let sequence=0;
  async function source(options={}){
    const base=path.join(temporary,'case-'+(++sequence)),root=path.join(base,'source'),output=path.join(base,'output');
    await fs.mkdir(root,{recursive:true});
    const directory=options.srcJunction?path.join(base,'source-target'):path.join(root,'src');await fs.mkdir(directory);
    for(const name of ROOT_FILES)await fs.copyFile(path.join(repo,name),path.join(root,name));
    for(const name of ARCHIVE_ALLOWLIST)await fs.copyFile(path.join(repo,'src',name),path.join(directory,name));
    if(options.srcJunction)await fs.symlink(directory,path.join(root,'src'),'junction');
    const manifest={schemaVersion:1,files:[...ARCHIVE_ALLOWLIST,'nested-ui.js'],archiveFiles:[...ARCHIVE_ALLOWLIST]};
    await fs.writeFile(path.join(root,'runtime-manifest.json'),JSON.stringify(manifest));
    return {base,root,output,manifest,writeManifest:async value=>fs.writeFile(path.join(root,'runtime-manifest.json'),JSON.stringify(value))};
  }
  async function noOutput(file){await assert.rejects(fs.lstat(file),isCode('ENOENT'));}
  await t.test('copies the complete reviewed runtime and notices, excluding every unlisted directory and file',async()=>{
    const f=await source();await fs.mkdir(path.join(f.root,'.git'));await fs.mkdir(path.join(f.root,'node_modules'));
    await fs.writeFile(path.join(f.root,'.git','synthetic-private'),'not for distribution');
    await fs.writeFile(path.join(f.root,'node_modules','synthetic-dependency'),'not for distribution');
    await fs.writeFile(path.join(f.root,'auth.json'),'synthetic credential fixture');
    await fs.writeFile(path.join(f.root,'src','relations.json'),'synthetic local data');
    const result=await build({root:f.root,outputDir:f.output});
    const expected=[...ROOT_FILES,...ARCHIVE_ALLOWLIST.map(name=>'src/'+name)].sort();
    assert.deepEqual(await names(f.output),expected);assert.equal(result.files.length,expected.length);
    for(const file of result.files){assert.match(file.sha256,/^[a-f0-9]{64}$/);assert.equal(file.bytes,(await fs.stat(path.join(f.output,file.path))).size);
      assert.deepEqual(await fs.readFile(path.join(f.output,file.path)),await fs.readFile(path.join(f.root,file.path)));}
    assert.deepEqual(result.archiveFiles,ARCHIVE_ALLOWLIST);assert.equal((await fs.stat(path.join(f.root,'auth.json'))).isFile(),true);
    const first=await fs.readFile(path.join(f.output,'src','archive-panel.html'));
    await assert.rejects(build({root:f.root,outputDir:f.output}),isCode('OUTPUT_EXISTS'));
    assert.deepEqual(await fs.readFile(path.join(f.output,'src','archive-panel.html')),first);
  });
  await t.test('default output is a dedicated directory below dist and never the source root',async()=>{
    const f=await source(),result=await build({root:f.root});assert.equal(result.outputDir,path.join(f.root,DEFAULT_OUTPUT));
    assert.deepEqual(await names(result.outputDir),[...ROOT_FILES,...ARCHIVE_ALLOWLIST.map(name=>'src/'+name)].sort());
  });
  await t.test('refuses unsafe, source and shared directories without writing into them',async()=>{
    const f=await source();
    for(const output of [f.root,path.dirname(f.root),path.join(f.root,'src','package'),path.join(f.root,'docs','package'),path.join(f.root,'dist'),path.parse(f.root).root,os.homedir(),os.tmpdir()]){
      await assert.rejects(build({root:f.root,outputDir:output}),isCode('UNSAFE_OUTPUT'));
    }
    await noOutput(path.join(f.root,'src','package'));await noOutput(path.join(f.root,'docs'));
    await fs.writeFile(f.output,'existing file');await assert.rejects(build({root:f.root,outputDir:f.output}),isCode('OUTPUT_EXISTS'));assert.equal(await fs.readFile(f.output,'utf8'),'existing file');
  });
  await t.test('permits a fresh dedicated AppData install while protecting actual profile trees and shared roots',async()=>{
    const f=await source(),roaming=path.join(f.base,'simulated-roaming'),local=path.join(f.base,'simulated-local');
    const previous={APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA};
    process.env.APPDATA=roaming;process.env.LOCALAPPDATA=local;
    try{
      for(const [index,base] of [local,roaming].entries()){
        const output=path.join(base,'CodexNestedConversations','plugin-'+index),result=await build({root:f.root,outputDir:output});
        assert.equal(result.outputDir,output);assert.equal(result.files.length,ROOT_FILES.length+ARCHIVE_ALLOWLIST.length);
        await assert.rejects(build({root:f.root,outputDir:output}),isCode('OUTPUT_EXISTS'));
      }
      const protectedRoots=[roaming,local,path.join(roaming,'Codex'),path.join(roaming,'ChatGPT'),
        path.join(roaming,'Mozilla','Firefox','Profiles'),path.join(local,'Packages'),path.join(local,'OpenAI'),
        path.join(local,'Google','Chrome','User Data'),path.join(local,'Microsoft','Edge','User Data'),
        path.join(local,'Chromium','User Data'),path.join(local,'BraveSoftware','Brave-Browser','User Data')];
      for(const root of protectedRoots){
        await assert.rejects(build({root:f.root,outputDir:root}),isCode('UNSAFE_OUTPUT'));
        if(root!==roaming&&root!==local){const descendant=path.join(root,'new-plugin');await assert.rejects(build({root:f.root,outputDir:descendant}),isCode('UNSAFE_OUTPUT'));await noOutput(root);}
      }
    }finally{
      for(const [name,value] of Object.entries(previous))if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
  });
  await t.test('requires an exact, complete basename allowlist before creating output',async()=>{
    const f=await source();
    const variants=[undefined,[],[...ARCHIVE_ALLOWLIST.slice(1)],['../archive-server.cjs',...ARCHIVE_ALLOWLIST.slice(1)],
      ['src/archive-server.cjs',...ARCHIVE_ALLOWLIST.slice(1)],['C:\\private\\file.cjs',...ARCHIVE_ALLOWLIST.slice(1)],
      ['ARCHIVE-CORE.CJS',...ARCHIVE_ALLOWLIST.slice(1)],['auth.json',...ARCHIVE_ALLOWLIST.slice(1)],
      [...ARCHIVE_ALLOWLIST,ARCHIVE_ALLOWLIST[0]],[...ARCHIVE_ALLOWLIST.slice(1),ARCHIVE_ALLOWLIST[1]],'archive-server.cjs'];
    for(const archiveFiles of variants){await f.writeManifest({...f.manifest,archiveFiles});await assert.rejects(build({root:f.root,outputDir:f.output}),isCode('INVALID_ARCHIVE_FILES'));await noOutput(f.output);}
    assert.throws(()=>validateManifest({...f.manifest,schemaVersion:2}),isCode('INVALID_ARCHIVE_FILES'));
    assert.throws(()=>validateManifest({...f.manifest,files:[]}),isCode('INVALID_ARCHIVE_FILES'));
  });
  await t.test('invalid public environment, entry points and private metadata never reach an output',async()=>{
    const f=await source(),original=JSON.parse(await fs.readFile(path.join(f.root,'mcp.json'),'utf8'));
    for(const patch of [{env:{CNCC_DATA_DIR:'C:\\Users\\Synthetic\\private'}},{env:{OPENAI_API_KEY:'synthetic'}},{command:'powershell.exe'},
      {command:process.execPath},{command:'C:\\Program Files\\nodejs\\node.exe'},
      {args:['${PLUGIN_ROOT}/../private.cjs']},{cwd:'C:\\Users\\Synthetic'},{type:'streamable-http',url:'https://example.invalid/mcp'}]){
      const value=structuredClone(original);Object.assign(value.mcpServers['conversation-manager'],patch);
      await fs.writeFile(path.join(f.root,'mcp.json'),JSON.stringify(value));
      await assert.rejects(build({root:f.root,outputDir:f.output}),error=>['INVALID_MCP_METADATA','PRIVATE_METADATA','PRIVATE_SOURCE'].includes(error.code));await noOutput(f.output);
    }
    await fs.writeFile(path.join(f.root,'mcp.json'),JSON.stringify(original));
    const value=JSON.parse(await fs.readFile(path.join(f.root,'plugin.json'),'utf8'));value.author.name='C:\\Users\\Synthetic\\author';
    await fs.writeFile(path.join(f.root,'plugin.json'),JSON.stringify(value));
    await assert.rejects(build({root:f.root,outputDir:f.output}),error=>['PRIVATE_SOURCE','PRIVATE_METADATA'].includes(error.code));await noOutput(f.output);
    const portable=structuredClone(original);portable.mcpServers['conversation-manager'].env={PYTHONIOENCODING:'utf-8'};assert.doesNotThrow(()=>validateMcp(portable));
  });
  await t.test('validates plugin schema, identity, text types and bundled component boundaries',async()=>{
    const original=JSON.parse(await fs.readFile(path.join(repo,'plugin.json'),'utf8'));
    assert.doesNotThrow(()=>validatePlugin(original));
    for(const patch of [{name:123},{name:'Invalid_Name'},{version:['1.0.0']},{version:'1.0.0-01'},{mcpServers:{}},{extensions:{'com.openai':{hooks:'./hooks/hooks.json'}}}]){
      assert.throws(()=>validatePlugin({...structuredClone(original),...patch}),isCode('INVALID_PLUGIN_METADATA'));
    }
    const long=structuredClone(original);long.extensions['com.openai'].interface.shortDescription='x'.repeat(31);assert.throws(()=>validatePlugin(long),isCode('INVALID_PLUGIN_METADATA'));
  });
  await t.test('rejects source, source-parent and output-parent junctions without following them',async()=>{
    const f=await source({srcJunction:true});await assert.rejects(build({root:f.root,outputDir:f.output}),isCode('REPARSE_POINT'));await noOutput(f.output);
    const normal=await source(),alias=path.join(normal.base,'source-alias');await fs.symlink(normal.root,alias,'junction');
    await assert.rejects(build({root:alias,outputDir:normal.output}),isCode('REPARSE_POINT'));await noOutput(normal.output);
    const outputAlias=path.join(normal.base,'output-alias'),target=path.join(normal.base,'output-target');await fs.mkdir(target);await fs.symlink(target,outputAlias,'junction');
    await assert.rejects(build({root:normal.root,outputDir:path.join(outputAlias,'plugin')}),isCode('REPARSE_POINT'));await noOutput(path.join(target,'plugin'));
  });
  await t.test('rejects a linked source file when the host permits creating file symlinks',async child=>{
    const f=await source(),file=path.join(f.root,'plugin.json'),target=path.join(f.base,'owned-plugin.json');await fs.rename(file,target);
    try{await fs.symlink(target,file,'file');}catch(error){if(error.code==='EPERM'||error.code==='EACCES'){child.skip('Creating file symlinks requires additional Windows permission');return;}throw error;}
    await assert.rejects(build({root:f.root,outputDir:f.output}),isCode('REPARSE_POINT'));await noOutput(f.output);
  });
  await t.test('refuses binary, malformed UTF-8, oversized, missing and personal-path source files',async()=>{
    const f=await source(),file=path.join(f.root,'src',ARCHIVE_ALLOWLIST[0]);
    for(const bytes of [Buffer.from([0]),Buffer.from([255]),Buffer.alloc(2*1024*1024+1,65)]){
      await fs.writeFile(file,bytes);await assert.rejects(build({root:f.root,outputDir:f.output}),isCode('INVALID_SOURCE'));await noOutput(f.output);
    }
    await fs.writeFile(file,'const path="C:\\\\Users\\\\Synthetic\\\\private";');
    await assert.rejects(build({root:f.root,outputDir:f.output}),isCode('PRIVATE_SOURCE'));await noOutput(f.output);
    const missing=await source();await fs.rename(path.join(missing.root,'src','archive-panel.html'),path.join(missing.base,'owned-panel.html'));
    await assert.rejects(build({root:missing.root,outputDir:missing.output}),isCode('ENOENT'));await noOutput(missing.output);
  });
  await t.test('CLI accepts only an explicit fresh output parameter and provides read-only help',()=>{
    assert.deepEqual(parseArgs([]),{outputDir:undefined,help:false});assert.deepEqual(parseArgs(['--output-dir','fresh']),{outputDir:'fresh',help:false});
    for(const args of [['--output-dir'],['--output-dir','--help'],['--output-dir','-h'],['--output-dir','one','--output-dir','two'],['--install'],['unexpected']])assert.throws(()=>parseArgs(args),isCode('INVALID_ARGUMENT'));
    const script=path.join(repo,'scripts','build-plugin.cjs');
    const help=spawnSync(process.execPath,[script,'--help'],{encoding:'utf8',windowsHide:true});assert.equal(help.status,0);assert.match(help.stdout,/does not install/);
    const invalid=spawnSync(process.execPath,[script,'--install'],{encoding:'utf8',windowsHide:true});assert.equal(invalid.status,1);assert.match(invalid.stderr,/INVALID_ARGUMENT/);
  });
});
