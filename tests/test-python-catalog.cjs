'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
const python=process.env.CNCC_PYTHON||'python';
const source=path.resolve(__dirname,'../src');
const id='00000000-0000-0000-0000-000000000001';
const other='00000000-0000-0000-0000-000000000002';
const chat={id,title:'Synthetic standalone',kind:'codex',hostId:'local'};

test('Python helpers use authoritative standalone catalog without writing a database or opening an app',async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'cncc-python-guard-'));
  t.after(async()=>{
    assert(path.basename(folder).startsWith('cncc-python-guard-')&&path.dirname(folder)===os.tmpdir());
    await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CNCC_TEST_FOLDER,[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)'],
      {windowsHide:true,env:{...process.env,CNCC_TEST_FOLDER:folder}});
  });
  const env={...process.env,CNCC_DATA_DIR:folder,CNCC_CODEX_HOME:folder,PYTHONIOENCODING:'utf-8'};
  const init=`import sqlite3,sys\nfrom pathlib import Path\np=Path(sys.argv[1])\ns=sqlite3.connect(p/'state_5.sqlite')\ns.execute('CREATE TABLE threads (id TEXT PRIMARY KEY,name TEXT,title TEXT,archived INTEGER,thread_source TEXT,source TEXT,agent_path TEXT,created_at_ms INTEGER,created_at INTEGER,updated_at_ms INTEGER,attached_thread_parent_id TEXT)')\ns.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)',(sys.argv[2],'Synthetic standalone','PRIVATE_RAW_MESSAGE',0,'user','',None,1000,1,2000,None))\ns.commit();s.close()\nh=sqlite3.connect(p/'thread_history_1.sqlite')\nh.execute('CREATE TABLE thread_items (thread_id TEXT,item_id TEXT,item_type TEXT,item_json TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER)')\nh.commit();h.close()`;
  await run(python,['-c',init,folder,id],{windowsHide:true,env});
  const database=path.join(folder,'state_5.sqlite');
  const before=crypto.createHash('sha256').update(await fs.readFile(database)).digest('hex');
  const manifest=path.join(folder,'relations.json');
  async function save(value){await fs.writeFile(manifest,JSON.stringify(value));}
  const command=path.join(source,'chat-is-archived.py');
  await save({schemaVersion:1,catalog:[chat],groups:[]});
  assert.deepEqual(JSON.parse((await run(python,[command,id],{windowsHide:true,env})).stdout),{id,archived:false});
  const probe=`import os,sys,runpy,json\nrequests=[]\nos.startfile=lambda uri:requests.append(uri)\nscript=sys.argv[1];ident=sys.argv[2];sys.argv=[script,ident]\nrunpy.run_path(script,run_name='__main__')\nprint(json.dumps({'openRequests':requests}))`;
  const opened=await run(python,['-c',probe,path.join(source,'open-local-chat.py'),id],{windowsHide:true,env});
  assert.deepEqual(JSON.parse(opened.stdout.trim().split('\n').at(-1)),{openRequests:['codex://threads/'+id]});
  // A removed member cannot regain permission through an old relationship group.
  await save({schemaVersion:1,catalog:[],groups:[{parent:chat,children:[]}]});
  await assert.rejects(run(python,[command,id],{windowsHide:true,env}));
  await assert.rejects(run(python,['-c',probe,path.join(source,'open-local-chat.py'),id],{windowsHide:true,env}));
  await save({schemaVersion:1,catalog:[{...chat,kind:'chatgpt'},{...chat,id:other,hostId:'remote'}],groups:[]});
  await assert.rejects(run(python,[command,id],{windowsHide:true,env}));
  await assert.rejects(run(python,[command,other],{windowsHide:true,env}));
  await assert.rejects(run(python,[command,'not-a-uuid'],{windowsHide:true,env}));
  const output=path.join(folder,'must-not-be-written.json');
  const fresh=await run(python,[path.join(source,'sync-relations.py'),'--manifest-stdout','--output',output],{windowsHide:true,env});
  const snapshot=JSON.parse(fresh.stdout);
  assert.equal(snapshot.catalog.length,1);assert.equal(snapshot.catalog[0].id,id);
  assert.equal(snapshot.catalog[0].createdAtMs,1000);assert.equal(snapshot.catalog[0].updatedAtMs,2000);
  assert.deepEqual(snapshot.groups,[]);assert(!fresh.stdout.includes('PRIVATE_RAW_MESSAGE'));
  await assert.rejects(fs.stat(output),{code:'ENOENT'});
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(database)).digest('hex'),before);
});
