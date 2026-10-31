'use strict';
// SQLite fixtures only: no official profile, app process, native window or account.
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const python=process.env.CNCC_PYTHON||'python';
const source=path.resolve(__dirname,'../src/archive-catalog.py');
const rootPromise=fs.mkdtemp(path.join(os.tmpdir(),'cncc-archive-catalog-fixture-'));
const uuid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
after(async()=>{
  const root=await rootPromise;assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('cncc-archive-catalog-fixture-'));
  await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CNCC_TEST_FOLDER,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)'],
    {windowsHide:true,env:{...process.env,CNCC_TEST_FOLDER:root}});
});
function options(folder){return {windowsHide:true,env:{...process.env,CNCC_CODEX_HOME:folder,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}};}
async function fixture(name,history='valid'){
  const folder=path.join(await rootPromise,name);await fs.mkdir(folder);
  const init=`import sqlite3,sys,json\nfrom pathlib import Path\np=Path(sys.argv[1])\ns=sqlite3.connect(p/'state_5.sqlite')\ns.execute('CREATE TABLE threads (id TEXT PRIMARY KEY,name TEXT,title TEXT,archived INTEGER,thread_source TEXT,source TEXT,agent_path TEXT,created_at_ms INTEGER,created_at INTEGER,updated_at_ms INTEGER,attached_thread_parent_id TEXT)')\nu=lambda n:'00000000-0000-0000-0000-'+str(n).zfill(12)\nrows=[(u(1),'Parent 中文','PRIVATE_RAW_MESSAGE',0,'user','',None,1000,1,2000,None),(u(2),'Child','PRIVATE_RAW_MESSAGE',0,'agent_created_thread','',None,0,3,4000,u(1)),(u(3),'Archived','PRIVATE_RAW_MESSAGE',1,'user','',None,1000,1,2000,None),(u(4),'System','PRIVATE_RAW_MESSAGE',0,'subagent','',None,1000,1,2000,None),(u(5),'Agent path','PRIVATE_RAW_MESSAGE',0,'user','', 'PRIVATE_AGENT_PATH',1000,1,2000,None),(u(6),'Unknown','PRIVATE_RAW_MESSAGE',0,'future_source','',None,1000,1,2000,None),(u(7),'JSON subagent','PRIVATE_RAW_MESSAGE',0,'user',json.dumps({'subagent':'PRIVATE_SOURCE'}),None,1000,1,2000,None),('invalid-id','Invalid','PRIVATE_RAW_MESSAGE',0,'user','',None,1000,1,2000,None)]\ns.executemany('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)',rows)\ns.commit();s.close()\nmode=sys.argv[2]\nif mode=='valid':\n h=sqlite3.connect(p/'thread_history_1.sqlite');h.execute('CREATE TABLE thread_items (thread_id TEXT,item_id TEXT,item_type TEXT,item_json TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER)');h.execute('INSERT INTO thread_items VALUES (?,?,?,?,?,?)',(u(1),'raw','userMessage',json.dumps({'text':'PRIVATE_TRANSCRIPT'}),0,1000));h.commit();h.close()\nelif mode=='broken':\n (p/'thread_history_1.sqlite').write_bytes(b'PRIVATE_BROKEN_HISTORY')\nelif mode=='schema':\n h=sqlite3.connect(p/'thread_history_1.sqlite');h.execute('CREATE TABLE future_schema (secret TEXT)');h.commit();h.close()`;
  await run(python,['-c',init,folder,history],options(folder));return folder;
}
async function read(folder,args=[]){const output=await run(python,[source,...args],options(folder));return {manifest:JSON.parse(output.stdout),text:output.stdout};}
async function hashes(folder){const result={};for(const name of await fs.readdir(folder))result[name]=crypto.createHash('sha256').update(await fs.readFile(path.join(folder,name))).digest('hex');return result;}

test('valid relations returns only eligible metadata with attached children and no transcript data',async()=>{
  const p=await fixture('valid');const before=await hashes(p);const {manifest,text}=await read(p);
  assert.equal(manifest.relationsAvailable,true);assert.equal(manifest.catalog.length,2);
  assert.deepEqual(manifest.catalog.map(c=>c.id),[uuid(2),uuid(1)]);assert.equal(manifest.groups.length,1);
  assert.equal(manifest.groups[0].parent.id,uuid(1));assert.equal(manifest.groups[0].children[0].id,uuid(2));
  const parent=manifest.catalog.find(c=>c.id===uuid(1));const child=manifest.catalog.find(c=>c.id===uuid(2));
  assert.equal(parent.title,'Parent 中文');assert.equal(child.createdAtMs,3000);assert.equal(child.updatedAtMs,4000);
  assert.equal(child.threadSource,'agent_created_thread');assert.equal(child.eligibility,'eligible');
  assert(!text.includes('PRIVATE_'));assert.deepEqual(await hashes(p),before);
});
test('both catalogs exclude noninteractive runs while retaining an unnamed desktop chat',async()=>{
  for(const history of ['valid','missing']){
    const folder=await fixture('sources-'+history,history);
    const setup=`import sqlite3,sys,pathlib
c=sqlite3.connect(pathlib.Path(sys.argv[1])/'state_5.sqlite')
for ident,source,name in [(sys.argv[2],'exec',None),(sys.argv[3],'exec','Named run'),(sys.argv[4],'vscode',None)]:
 c.execute('insert into threads(id,name,archived,thread_source,source,created_at,updated_at_ms) values(?,?,0,?,?,1,1000)',(ident,name,'user',source))
c.commit();c.close()`;
    await run(python,['-c',setup,folder,uuid(80),uuid(81),uuid(82)],options(folder));
    const before=await hashes(folder),{manifest}=await read(folder);
    assert.deepEqual(new Set(manifest.catalog.map(c=>c.id)),new Set([uuid(1),uuid(2),uuid(82)]));
    assert.deepEqual(await hashes(folder),before);
  }
});
for(const history of ['missing','broken','schema']){
  test(`${history} relationship database leaves a complete flat catalog available without writes`,async()=>{
    const p=await fixture(history,history);const before=await hashes(p);const {manifest,text}=await read(p);
    assert.equal(manifest.relationsAvailable,false);assert.deepEqual(manifest.groups,[]);assert.equal(manifest.catalog.length,2);
    assert.deepEqual(new Set(manifest.catalog.map(c=>c.id)),new Set([uuid(1),uuid(2)]));
    assert.match(manifest.relationMessage,/取消包含下级/);assert(!text.includes('PRIVATE_'));assert.deepEqual(await hashes(p),before);
  });
}
test('explicit no-relations mode never needs a relationship database',async()=>{
  const p=await fixture('explicit-flat','missing');const before=await hashes(p);
  const script=`import importlib.util,json,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('catalog_fixture',Path(sys.argv[1]));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nprint(json.dumps(m.read_catalog(Path(sys.argv[2]),include_relations=False)))`;
  const output=await run(python,['-c',script,source,p],options(p));const manifest=JSON.parse(output.stdout);
  assert.equal(manifest.relationsAvailable,false);assert.equal(manifest.catalog.length,2);assert.deepEqual(manifest.groups,[]);
  assert.deepEqual(await hashes(p),before);
});
test('explicit --codex-home overrides environment and missing state cannot create a database',async()=>{
  const p=await fixture('argument','valid');const absent=path.join(await rootPromise,'absent');await fs.mkdir(absent);
  const output=await run(python,[source,'--codex-home',p],options(absent));assert.equal(JSON.parse(output.stdout).catalog.length,2);
  await assert.rejects(run(python,[source,'--codex-home',absent],options(p)));assert.deepEqual(await fs.readdir(absent),[]);
});
for(const adapter of ['missing','syntax-error']){
  test(`${adapter} optional nesting adapter cannot remove flat archive metadata or bypass missing state`,async()=>{
    const original=await fs.readFile(source);const p=await fixture('adapter-'+adapter,'valid');const before=await hashes(p);
    const scripts=path.join(await rootPromise,'scripts-'+adapter);await fs.mkdir(scripts);
    const isolatedSource=path.join(scripts,'archive-catalog.py');await fs.copyFile(source,isolatedSource);
    if(adapter==='syntax-error')await fs.writeFile(path.join(scripts,'sync-relations.py'),'def invalid adapter(:\n    PRIVATE_SENTINEL\n');
    const output=await run(python,[isolatedSource,'--codex-home',p],options(p));const manifest=JSON.parse(output.stdout);
    assert.equal(manifest.relationsAvailable,false);assert.deepEqual(manifest.groups,[]);
    assert.deepEqual(manifest.catalog.map(c=>c.id),[uuid(2),uuid(1)]);assert.match(manifest.relationMessage,/取消包含下级/);
    assert(!output.stdout.includes('PRIVATE_'));assert.deepEqual(await hashes(p),before);
    const absent=path.join(await rootPromise,'absent-adapter-'+adapter);await fs.mkdir(absent);
    await assert.rejects(run(python,[isolatedSource,'--codex-home',absent],options(p)));
    assert.deepEqual(await fs.readdir(absent),[]);assert.deepEqual(await fs.readFile(source),original);
  });
}
