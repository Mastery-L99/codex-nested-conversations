'use strict';
// Synthetic transport + isolated SQLite only. No desktop, account, real chat,
// MCP catalog, model turn, debug connection or native loader is used by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createArchiveAppServer, CAPABILITIES} = require('../src/archive-app-server.cjs');
const {publicError} = require('../src/archive-server.cjs');
const {createFixture, recycleFixture} = require('./recycle-fixture.cjs');
const run = promisify(execFile);
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve}; }
function fixture(t, custom = {}) {
  const rows = new Map([A, B, C, D].map(id => [id, {id, archived:false, source:'vscode', threadSource:'app'}]));
  const edges = [], requests = [], children = [], snapshotCalls = [], spawnCalls = [];
  const home = path.join(os.tmpdir(), 'synthetic-archive-home');
  function closure(threadId) {
    const found = new Set(), queue = [threadId];
    while (queue.length) { const parent = queue.shift(); for (const [p, child] of edges) if (p === parent && !found.has(child)) {found.add(child); queue.push(child);} }
    return [...found];
  }
  let beforeRead = () => {};
  const descriptor = {family:FAMILY, packageVersion:'fixture', executable:path.join(os.tmpdir(), 'official-fixture', 'codex.exe')};
  const deps = {
    resolveExecutable:async () => descriptor,
    readSnapshot:async ({threadId, mode}) => {
      snapshotCalls.push({id:threadId, mode}); beforeRead(threadId, mode);
      if (!rows.has(threadId)) throw Object.assign(Error(), {code:'THREAD_NOT_FOUND'});
      return {schemaVersion:1, thread:{...rows.get(threadId)}, spawnedDescendants:mode === 'scope' ? closure(threadId).map(value => ({...rows.get(value)})) : []};
    },
    spawn:(exe, args, options) => {
      spawnCalls.push({exe, args, options});
      const child = new EventEmitter(); child.pid = 7000 + children.length; child.exitCode = null; child.kills = 0;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.reply = (request, result) => child.stdout.write(JSON.stringify({id:request.id, result}) + '\n');
      child.notify = threadId => child.stdout.write(JSON.stringify({method:'thread/archived', params:{threadId}}) + '\n');
      child.exit = () => { if (child.exitCode != null) return; child.exitCode = 0; child.emit('exit', 0); };
      child.kill = () => {child.kills++; child.exit();}; child.stdin.once('end', child.exit);
      let input = '';
      child.stdin.on('data', chunk => {
        input += chunk.toString('utf8'); let index;
        while ((index = input.indexOf('\n')) >= 0) {
          const line = input.slice(0, index); input = input.slice(index + 1); if (!line) continue;
          const request = JSON.parse(line); requests.push(request);
          if (!Object.hasOwn(request, 'id')) continue;
          if (custom.handle?.(request, child, {rows, edges, closure}) === true) continue;
          if (request.method === 'initialize') child.reply(request, {userAgent:'fixture'});
          else if (request.method === 'thread/read') {
            custom.onMetadata?.(request, {rows, edges});
            child.reply(request, {thread:{id:request.params.threadId, source:'vscode', status:{type:'notLoaded'}, turns:[], preview:'private fixture preview', firstUserMessage:'private fixture message'}});
          } else if (request.method === 'thread/archive') {
            custom.onArchive?.(request, {rows, edges});
            for (const value of [request.params.threadId, ...closure(request.params.threadId)]) {
              const row = rows.get(value); if (row && !row.archived) {row.archived = true; child.notify(value);}
            }
            child.reply(request, {});
          } else throw Error('Unexpected fixture request: ' + request.method);
        }
      });
      children.push(child); return child;
    },
    ...custom.deps,
  };
  const provider = createArchiveAppServer({codexHome:home, notificationSettleMs:0, timeoutMs:custom.timeoutMs || 200, deps,desktopRequest:custom.desktopRequest});
  t.after(() => provider.dispose());
  return {provider, rows, edges, requests, children, snapshotCalls, spawnCalls, deps, descriptor, home, onSnapshot:callback => {beforeRead = callback;}};
}

test('capabilities disclose implicit cascading and non-atomic scope; status needs no app-server or loader', async t => {
  const f = fixture(t);
  assert.deepEqual(f.provider.capabilities, CAPABILITIES); assert.equal(Object.isFrozen(CAPABILITIES), true);
  assert.equal(CAPABILITIES.atomicConfirmedScope, false); assert.equal(CAPABILITIES.requiresExplicitDescendantConsent, true);
  assert.deepEqual(await f.provider.readStatus(A), {archived:false}); assert.equal(f.spawnCalls.length, 0); assert.deepEqual(f.requests, []);
});

test('notLoaded desktop thread archives without resume, MCP discovery, model calls, CDP or Windhawk', async t => {
  const f = fixture(t), result = await f.provider.archive(A, {confirmedIds:[A]});
  assert.deepEqual(result, {submitted:true, affectedIds:[A]}); assert.deepEqual(await f.provider.readStatus(A), {archived:true});
  assert.deepEqual(f.requests.map(row => row.method), ['initialize', 'initialized', 'thread/read', 'thread/archive']);
  assert.deepEqual(f.requests.find(row => row.method === 'thread/read').params, {threadId:A, includeTurns:false});
  assert.deepEqual(f.spawnCalls[0].args, ['app-server']); assert.equal(f.spawnCalls[0].options.env.CODEX_HOME, f.home);
  assert.equal(f.spawnCalls[0].options.windowsHide, true);
  assert.equal(f.provider.inspect().counts.archive, 1);
});

test('metadata projection excludes previews, messages, turns and transcript paths', async t => {
  const f = fixture(t), metadata = await f.provider.readMetadata(A);
  assert.deepEqual(metadata, {id:A, source:'vscode', status:'notLoaded'});
  assert.equal(JSON.stringify(metadata).includes('private'), false);
});

test('a reviewed backend record must still be the same kind and title immediately before the write',async t=>{
  for(const change of ['name','type']){
    const f=fixture(t,{onMetadata:(_r,{rows})=>{
      if(change==='name')rows.get(B).label='Changed';else rows.get(B).threadSource='user';
    }});
    f.edges.push([A,B]);Object.assign(f.rows.get(B),{threadSource:'subagent',label:'Worker'});
    await assert.rejects(f.provider.archive(A,{confirmedIds:[A,B],reviewedBackground:[{id:B,title:'Worker'}]}),
      {code:'BACKGROUND_SCOPE_CHANGED',submitted:false});
    assert.equal(f.provider.inspect().counts.archive,0);
  }
});

test('toolbar archives on the owning connection by ID and verifies the approved worker through the shared store',async t=>{
  const calls=[];
  const f=fixture(t,{desktopRequest:async(method,id)=>{
    calls.push([method,id]);
    if(method==='thread/read')return {thread:{id,status:{type:'idle'},turns:[]}};
    f.rows.get(A).archived=true;f.rows.get(B).archived=true;return {};
  }});
  f.edges.push([A,B]);Object.assign(f.rows.get(B),{threadSource:'subagent',label:'Worker'});
  const result=await f.provider.archive(A,{confirmedIds:[A,B],reviewedBackground:[{id:B,title:'Worker'}]});
  assert.deepEqual(result.affectedIds,[A,B]);
  assert.deepEqual(calls,[['thread/read',A],['thread/read',B],['thread/archive',A]]);
  assert.equal(f.spawnCalls.length,0);
});

test('a running turn in the target or a worker stops the toolbar before any write',async t=>{
  for(const active of [A,B]){
    const f=fixture(t,{desktopRequest:async(method,id)=>{
      assert.equal(method,'thread/read');return {thread:{id,status:{type:id===active?'active':'idle'},turns:[]}};
    }});
    f.edges.push([A,B]);
    await assert.rejects(f.provider.archive(A,{confirmedIds:[A,B]}),{code:'DESKTOP_TURN_ACTIVE',submitted:false});
    assert.equal(f.provider.inspect().counts.archive,0);assert.equal(f.spawnCalls.length,0);
  }
});

test('missing confirmation, out-of-scope target and invalid IDs fail before any process or database work', async t => {
  const f = fixture(t);
  await assert.rejects(f.provider.archive(A), {code:'CONFIRMED_SCOPE_REQUIRED', submitted:false});
  await assert.rejects(f.provider.archive(A, {confirmedIds:[B]}), {code:'THREAD_OUTSIDE_CONFIRMED_SCOPE', submitted:false});
  await assert.rejects(f.provider.archive(A, {confirmedIds:['not-an-id']}), {code:'INVALID_CONFIRMED_SCOPE', submitted:false});
  assert.throws(() => f.provider.archive('invalid', {confirmedIds:[A]}), {code:'INVALID_THREAD_ID'});
  assert.equal(f.snapshotCalls.length, 0); assert.equal(f.spawnCalls.length, 0);
});

test('known active implicit descendants outside confirmation are refused before archive submission', async t => {
  const f = fixture(t); f.edges.push([A, B], [B, C]);
  await assert.rejects(f.provider.archive(A, {confirmedIds:[A, B]}), error => error.code === 'IMPLICIT_DESCENDANTS_OUTSIDE_SCOPE' && !error.submitted && error.outsideScopeIds.includes(C));
  assert.equal(f.requests.filter(row => row.method === 'thread/archive').length, 0);
  assert.ok([...f.rows.values()].every(row => !row.archived));
});

test('confirmed implicit subtree reports every actually archived ID; already archived outside descendants are not rewritten', async t => {
  const f = fixture(t); f.edges.push([A, B], [B, C], [A, D]); f.rows.get(D).archived = true;
  const result = await f.provider.archive(A, {confirmedIds:[A, B, C]});
  assert.deepEqual(result.affectedIds.sort(), [A, B, C].sort());
  assert.equal(f.rows.get(D).archived, true);
});

test('already archived targets are verified without starting another process', async t => {
  const f = fixture(t); f.rows.get(A).archived = true;
  assert.deepEqual(await f.provider.archive(A, {confirmedIds:[A]}), {submitted:false, alreadyArchived:true, affectedIds:[]});
  assert.equal(f.spawnCalls.length, 0);
});

test('scope is re-read immediately before submission, after thread/read', async t => {
  const f = fixture(t, {onMetadata:(_, {edges}) => edges.push([A, B])});
  await assert.rejects(f.provider.archive(A, {confirmedIds:[A]}), {code:'IMPLICIT_DESCENDANTS_OUTSIDE_SCOPE', submitted:false});
  assert.equal(f.provider.inspect().counts.archive, 0); assert.equal(f.snapshotCalls.filter(row => row.mode === 'scope').length, 2);
});

test('concurrent new descendants are reported as post-submission uncertainty, never described as prevented', async t => {
  const f = fixture(t, {onArchive:(_, {edges}) => edges.push([A, B])});
  await assert.rejects(f.provider.archive(A, {confirmedIds:[A]}), error => error.code === 'SCOPE_CHANGED_AFTER_SUBMISSION' && error.submitted && error.affectedIds.includes(B) && error.outsideScopeIds.includes(B));
  assert.equal(f.rows.get(B).archived, true); assert.equal(f.provider.inspect().counts.archive, 1);
});

test('a notification outside scope stops the provider and retains its audit IDs', async t => {
  const f = fixture(t, {handle:(request, child, {rows}) => {
    if (request.method !== 'thread/archive') return false;
    rows.get(A).archived = true; child.notify(A); child.notify(D); child.reply(request, {}); return true;
  }});
  await assert.rejects(f.provider.archive(A, {confirmedIds:[A]}), error => error.code === 'AFFECTED_IDS_OUTSIDE_SCOPE' && error.submitted && error.outsideScopeIds.includes(D));
});

test('database commit readback supplies affected IDs even if notification delivery is missing', async t => {
  const f = fixture(t, {handle:(request, child, {rows}) => {
    if (request.method !== 'thread/archive') return false;
    rows.get(A).archived = true; child.reply(request, {}); return true;
  }});
  assert.deepEqual((await f.provider.archive(A, {confirmedIds:[A]})).affectedIds, [A]);
});

test('RPC errors are bounded, sanitized and marked as potentially submitted', async t => {
  const f = fixture(t, {handle:(request, child) => {
    if (request.method !== 'thread/archive') return false;
    child.stdout.write(JSON.stringify({id:request.id, error:{code:-32600, message:'private fixture body must not escape'}}) + '\n'); return true;
  }});
  await assert.rejects(f.provider.archive(A, {confirmedIds:[A]}), error => {
    assert.equal(error.code,'APP_SERVER_RPC_FAILED'); assert.equal(error.submitted,true);
    assert.deepEqual(error.details,{method:'thread/archive',reason:'unknown',nativeCode:-32600});
    assert.match(publicError(error).message,/RPC -32600/);
    assert.doesNotMatch(JSON.stringify(publicError(error)),/private/); return true;
  });
  assert.equal(f.provider.inspect().counts.archive, 1); assert.equal(f.rows.get(A).archived, false);
});

test('desktop and storage errors preserve the failed step and safe diagnostics, without exposing native text', async t => {
  for (const [method,message,reason,osCode] of [
    ['thread/archive','thread private-file already has an active writer','active_writer',null],
    ['thread/archive','unspecified private-file (os error 32)','file_in_use',32],
    ['thread/archive','access is denied in private-file (os error 5)','access_denied',5],
    ['thread/read','thread not found: private-file','not_found',null],
    ['initialize','private-file database is locked','database_busy',null]
  ]) {
    const f=fixture(t,{handle:(req,child)=>{
      if(req.method!==method)return false;
      child.stdout.write(JSON.stringify({id:req.id,error:{code:-32602,message,data:{private:'private-file'}}})+'\n');
      return true;
    }});
    await assert.rejects(f.provider.archive(A,{confirmedIds:[A]}),err=>{
      assert.equal(err.submitted,method==='thread/archive');
      const publicValue=publicError(err);
      assert.deepEqual(publicValue.details,{method,reason,nativeCode:-32602,osCode});
      assert.doesNotMatch(JSON.stringify([publicValue,err]),/private-file/);return true;
    });
    assert.equal(f.provider.inspect().counts.archive,method==='thread/archive'?1:0);
  }
});

test('archive timeout terminates only the adapter-owned child and does not retry writes', async t => {
  const f = fixture(t, {timeoutMs:20, handle:request => request.method === 'thread/archive'});
  await assert.rejects(f.provider.archive(A, {confirmedIds:[A]}), error => error.code === 'APP_SERVER_TIMEOUT' && error.submitted);
  assert.equal(f.children.length, 1); assert.equal(f.children[0].kills, 1); assert.equal(f.provider.inspect().counts.archive, 1);
});

test('archive requests serialize through one server; queued cancellation submits nothing', async t => {
  const wait = deferred(); let response;
  const f = fixture(t, {handle:(request, child, {rows}) => {
    if (request.method !== 'thread/archive' || request.params.threadId !== A) return false;
    response = () => {rows.get(A).archived = true; child.notify(A); child.reply(request, {});}; wait.resolve(); return true;
  }});
  const first = f.provider.archive(A, {confirmedIds:[A, B]}), controller = new AbortController();
  const second = f.provider.archive(B, {confirmedIds:[A, B], signal:controller.signal});
  await wait.promise; controller.abort(); response(); await first;
  await assert.rejects(second, error => error.code === 'ABORTED' && !error.submitted);
  assert.equal(f.requests.filter(row => row.method === 'thread/archive').length, 1);
  assert.equal(f.snapshotCalls.some(row => row.id === B), false);
});

test('metadata with turns, missing SQL rows and invalid snapshots cannot trigger archive', async t => {
  const f = fixture(t, {handle:(request, child) => {
    if (request.method !== 'thread/read') return false;
    child.reply(request, {thread:{id:A, turns:[{private:'unexpected'}]}}); return true;
  }});
  await assert.rejects(f.provider.archive(A, {confirmedIds:[A]}), {code:'INVALID_THREAD_METADATA', submitted:false});
  assert.equal(f.provider.inspect().counts.archive, 0);
  const missing = fixture(t); missing.rows.delete(A);
  await assert.rejects(missing.provider.archive(A, {confirmedIds:[A]}), {code:'THREAD_NOT_FOUND', submitted:false}); assert.equal(missing.spawnCalls.length, 0);
  const invalid = fixture(t, {deps:{readSnapshot:async () => ({schemaVersion:1, thread:{id:B, archived:false}, spawnedDescendants:[]})}});
  await assert.rejects(invalid.provider.archive(A, {confirmedIds:[A]}), {code:'INVALID_DATABASE_SNAPSHOT', submitted:false}); assert.equal(invalid.spawnCalls.length, 0);
});

test('foreign package identity is refused before starting a process', async t => {
  const f = fixture(t); f.descriptor.family = 'foreign';
  await assert.rejects(f.provider.readMetadata(A), {code:'OFFICIAL_APP_SERVER_UNAVAILABLE'}); assert.equal(f.spawnCalls.length, 0);
});

test('invalid or oversized server responses terminate only the owned transport', async t => {
  for (const payload of ['private invalid json\n', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    const f = fixture(t, {handle:(request, child) => {if (request.method !== 'initialize') return false; child.stdout.write(payload); return true;}});
    await assert.rejects(f.provider.start(), error => ['INVALID_APP_SERVER_RESPONSE', 'APP_SERVER_FRAME_TOO_LARGE'].includes(error.code) && !error.message.includes('private'));
    assert.equal(f.children[0].kills, 1);
  }
});

test('disposal closes its child, forbids future requests and never calls the official desktop', async t => {
  const f = fixture(t); await f.provider.start(); f.provider.dispose(); await delay(5);
  assert.equal(f.provider.inspect().closed, true); assert.notEqual(f.children[0].exitCode, null);
  await assert.rejects(f.provider.readStatus(A), {code:'ADAPTER_STOPPED'});
  assert.deepEqual(f.requests.map(row => row.method), ['initialize', 'initialized']);
});

async function databaseFixture(t, extraSql = '') {
  const root = await createFixture('cncc-archive-db-'); t.after(() => recycleFixture(root));
  const python = process.env.CNCC_PYTHON || 'python';
  const code = String.raw`import sqlite3,sys,pathlib
c=sqlite3.connect(pathlib.Path(sys.argv[1])/'state_5.sqlite')
c.executescript('create table threads(id text primary key,archived integer,source text,thread_source text,first_user_message text);create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text);')
for x,a in [(sys.argv[2],0),(sys.argv[3],0),(sys.argv[4],1)]:c.execute('insert into threads values(?,?,?,?,?)',(x,a,'vscode','app','never-return-this-fixture-body'))
c.execute('insert into thread_spawn_edges values(?,?,?)',(sys.argv[2],sys.argv[3],'completed'))
c.execute('insert into thread_spawn_edges values(?,?,?)',(sys.argv[3],sys.argv[4],'completed'))
c.executescript(sys.argv[5]);c.commit();c.close()`;
  await run(python, ['-c', code, root, A, B, C, extraSql], {windowsHide:true, env:{...process.env, PYTHONIOENCODING:'utf-8'}});
  const provider = createArchiveAppServer({codexHome:root, python, deps:{resolveExecutable:async () => {throw Error('must not start an app-server');}}});
  t.after(() => provider.dispose()); return {root, provider};
}

test('real isolated SQLite reads metadata and transitive spawn closure without returning body or changing database bytes', async t => {
  const f = await databaseFixture(t), file = path.join(f.root, 'state_5.sqlite');
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex'); const before = hash(await fs.readFile(file));
  assert.deepEqual(await f.provider.readStatus(A), {archived:false});
  const scope = await f.provider.readScope(A);
  assert.deepEqual(scope.spawnedDescendants.map(row => row.id).sort(), [B, C].sort()); assert.equal(scope.spawnedDescendants.find(row => row.id === C).archived, true);
  assert.equal(JSON.stringify(scope).includes('never-return'), false); assert.equal(hash(await fs.readFile(file)), before);
});

test('real SQLite rejects incomplete edges and descendant-only cycles instead of guessing implicit scope', async t => {
  const missing = await databaseFixture(t, `insert into thread_spawn_edges values('${A}','${D}','completed');`);
  await assert.rejects(missing.provider.readScope(A), {code:'DESCENDANT_METADATA_MISSING'});
  const cycle = await databaseFixture(t, `insert into thread_spawn_edges values('${C}','${B}','completed');`);
  await assert.rejects(cycle.provider.readScope(A), {code:'SPAWN_GRAPH_CYCLE'});
});

test('an unsupported spawn schema still allows status reads but cannot authorize an archive', async t => {
  const f = await databaseFixture(t, 'drop table thread_spawn_edges;');
  assert.deepEqual(await f.provider.readStatus(A), {archived:false});
  await assert.rejects(f.provider.archive(A, {confirmedIds:[A]}), {code:'UNSUPPORTED_SPAWN_SCHEMA', submitted:false});
});
