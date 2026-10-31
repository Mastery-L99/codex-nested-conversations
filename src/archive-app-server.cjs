'use strict';
// One archive provider with an isolated official process or the current window's official connection.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {StringDecoder} = require('node:string_decoder');
const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0';
const MAX_SCOPE = 10000;
const CAPABILITIES = Object.freeze({archiveMayCascade:true, confirmedScopePreflight:true, atomicConfirmedScope:false,
  reportsAffectedIds:true, requiresExplicitDescendantConsent:true});
function failure(code, extra = {}) { return Object.assign(new Error(code), {code, ...extra}); }
// Keep only structured diagnostics. Native error text can contain private paths or chat content.
function rpcFailure(method, error) {
  const message = typeof error?.message === 'string' ? error.message.slice(0, 8192) : '';
  const osMatch = /\bos error (\d{1,6})\b/i.exec(message);
  const osCode = osMatch ? Number(osMatch[1]) : null;
  let reason = 'unknown';
  if (/already has an active writer/i.test(message)) reason = 'active_writer';
  else if (/thread not loaded\b/i.test(message)) reason = 'not_loaded';
  else if (osCode === 32 || osCode === 33 || /sharing violation/i.test(message)) reason = 'file_in_use';
  else if (osCode === 5 || /permission denied|access is denied/i.test(message)) reason = 'access_denied';
  else if (osCode === 2 || osCode === 3 || /thread not found|no rollout found|not found for thread/i.test(message)) reason = 'not_found';
  else if (/outside (?:the )?sessions directory|must be in (?:the )?sessions directory|not (?:within|under) .*sessions/i.test(message)) reason = 'outside_sessions';
  else if (/database is (?:locked|busy)/i.test(message)) reason = 'database_busy';
  const details = {method, reason};
  if (Number.isSafeInteger(error?.code)) details.nativeCode = error.code;
  if (osCode !== null) details.osCode = osCode;
  return failure('APP_SERVER_RPC_FAILED', {details});
}
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) throw failure('INVALID_THREAD_ID'); return value.toLowerCase(); }
function abort(signal) { if (signal?.aborted) throw failure('ABORTED'); }
function bounded(value, fallback, min, max) { if (value == null) return fallback; if (!Number.isInteger(value) || value < min || value > max) throw failure('INVALID_TIMEOUT'); return value; }

async function resolveOfficialExecutable() {
  if (process.platform !== 'win32') throw failure('UNSUPPORTED_PLATFORM');
  const command = "$ErrorActionPreference='Stop'; $p=@(Get-AppxPackage -Name OpenAI.Codex); if($p.Count -ne 1 -or $p[0].PackageFamilyName -cne 'OpenAI.Codex_2p2nqsd0c76g0'){throw 'Official package identity mismatch'}; @{family=$p[0].PackageFamilyName;packageVersion=[string]$p[0].Version;executable=(Join-Path $p[0].InstallLocation 'app\\resources\\codex.exe')}|ConvertTo-Json -Compress";
  let result;
  try { result = JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide:true, timeout:5000, maxBuffer:65536})).stdout.trim()); }
  catch { throw failure('OFFICIAL_APP_SERVER_UNAVAILABLE'); }
  if (result.family !== FAMILY || !path.isAbsolute(result.executable || '') || path.basename(result.executable).toLowerCase() !== 'codex.exe' || !(await fs.stat(result.executable)).isFile()) throw failure('OFFICIAL_APP_SERVER_UNAVAILABLE');
  return result;
}

const READ_ONLY_SNAPSHOT = String.raw`
import sys,json,pathlib,sqlite3
def fail(code):
 print(json.dumps({'error':code}));sys.exit(0)
try:
 db=(pathlib.Path(sys.argv[1])/'state_5.sqlite').resolve()
 c=sqlite3.connect(db.as_uri()+'?mode=ro',uri=True,timeout=1)
 c.execute('pragma query_only=ON')
 cols={r[1] for r in c.execute('pragma table_info(threads)')}
 if not {'id','archived'}.issubset(cols):fail('UNSUPPORTED_THREAD_SCHEMA')
 source=',source' if 'source' in cols else ',null'
 thread_source=',thread_source' if 'thread_source' in cols else ',null'
 labels=''.join(','+col if col in cols else ',null' for col in ('name','agent_nickname','agent_role'))
 fields='select id,archived'+source+thread_source+labels+' from threads where id=?'
 row=c.execute(fields,(sys.argv[2],)).fetchone()
 if row is None:fail('THREAD_NOT_FOUND')
 def convert(r):return {'id':r[0],'archived':bool(r[1]),'source':r[2],'threadSource':r[3],'label':next((v.strip() for v in r[4:] if isinstance(v,str) and v.strip()),None)}
 out={'schemaVersion':1,'thread':convert(row),'spawnedDescendants':[]}
 if sys.argv[3]=='scope':
  edgecols={r[1] for r in c.execute('pragma table_info(thread_spawn_edges)')}
  if not {'parent_thread_id','child_thread_id'}.issubset(edgecols):fail('UNSUPPORTED_SPAWN_SCHEMA')
  cte='with recursive descendants(id) as (select child_thread_id from thread_spawn_edges where parent_thread_id=? union select e.child_thread_id from thread_spawn_edges e join descendants d on e.parent_thread_id=d.id) '
  ids=[r[0] for r in c.execute(cte+'select id from descendants limit 10001',(sys.argv[2],))]
  if len(ids)>10000:fail('SPAWN_SCOPE_TOO_LARGE')
  if sys.argv[2] in ids:fail('SPAWN_GRAPH_CYCLE')
  for child in ids:
   r=c.execute(fields,(child,)).fetchone()
   if r is None:fail('DESCENDANT_METADATA_MISSING')
   out['spawnedDescendants'].append(convert(r))
  edges=list(c.execute(cte+'select e.parent_thread_id,e.child_thread_id from thread_spawn_edges e where e.parent_thread_id=? or e.parent_thread_id in (select id from descendants) limit 20001',(sys.argv[2],sys.argv[2])))
  if len(edges)>20000:fail('SPAWN_SCOPE_TOO_LARGE')
  outgoing={p:[] for p in [sys.argv[2],*ids]};indegree={p:0 for p in outgoing}
  for parent,child in edges:
   if child not in indegree:fail('SPAWN_SCOPE_INCONSISTENT')
   outgoing[parent].append(child);indegree[child]+=1
  ready=[v for v,n in indegree.items() if n==0];seen=0
  while ready:
   node=ready.pop();seen+=1
   for child in outgoing[node]:
    indegree[child]-=1
    if indegree[child]==0:ready.append(child)
  if seen!=len(indegree):fail('SPAWN_GRAPH_CYCLE')
  from collections import deque
  depth={sys.argv[2]:0};queue=deque([sys.argv[2]])
  while queue:
   p=queue.popleft()
   for child in outgoing[p]:
    if child not in depth:depth[child]=depth[p]+1;queue.append(child)
  for child in out['spawnedDescendants']:child['depth']=depth[child['id']]
 print(json.dumps(out))
 c.close()
except sqlite3.Error:fail('READ_ONLY_DATABASE_UNAVAILABLE')
except Exception:fail('READ_ONLY_SNAPSHOT_FAILED')
`;

async function readLocalSnapshot({codexHome, threadId, mode, python, signal}) {
  abort(signal);
  let output;
  try {
    output = await run(python, ['-c', READ_ONLY_SNAPSHOT, codexHome, threadId, mode],
      {windowsHide:true, timeout:5000, maxBuffer:4 * 1024 * 1024, signal, env:{...process.env, PYTHONIOENCODING:'utf-8'}});
  } catch (error) { throw failure(signal?.aborted ? 'ABORTED' : error.code === 'ENOENT' ? 'PYTHON_UNAVAILABLE' : 'READ_ONLY_DATABASE_UNAVAILABLE'); }
  let result;
  try { result = JSON.parse(output.stdout.trim()); } catch { throw failure('INVALID_DATABASE_SNAPSHOT'); }
  if (result.error) throw failure(/^[A-Z_]+$/.test(result.error) ? result.error : 'INVALID_DATABASE_SNAPSHOT');
  return result;
}

function validateSnapshot(snapshot, threadId) {
  if (snapshot?.schemaVersion !== 1 || snapshot.thread?.id !== threadId || typeof snapshot.thread.archived !== 'boolean' || !Array.isArray(snapshot.spawnedDescendants) || snapshot.spawnedDescendants.length > MAX_SCOPE) throw failure('INVALID_DATABASE_SNAPSHOT');
  const seen = new Set([threadId]);
  for (const row of snapshot.spawnedDescendants) {
    if (typeof row?.id !== 'string' || !UUID.test(row.id) || typeof row.archived !== 'boolean' || seen.has(row.id)) throw failure('INVALID_DATABASE_SNAPSHOT');
    seen.add(row.id);
  }
  return snapshot;
}

function backgroundTitle(row) {
  if (!row || row.source === 'exec' || (row.threadSource && row.threadSource!=='subagent')) return null;
  let source=row.source;
  if(typeof source==='string'){try{source=JSON.parse(source);}catch{source=null;}}
  if(row.threadSource!=='subagent' && !(source && typeof source==='object' && Object.hasOwn(source,'subagent')))return null;
  return typeof row.label==='string'&&row.label.trim()?row.label.trim():'后台子任务 · '+row.id.slice(-8);
}

function createArchiveAppServer(options = {}) {
  const codexHome = path.resolve(options.codexHome || process.env.CNCC_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const python = options.python || process.env.CNCC_PYTHON || 'python';
  const timeoutMs = bounded(options.timeoutMs, 15000, 10, 60000);
  const settleMs = bounded(options.notificationSettleMs, 50, 0, 1000);
  const deps = {resolveExecutable:resolveOfficialExecutable, spawn, readSnapshot:readLocalSnapshot, ...options.deps};
  const desktopRequest = options.desktopRequest;
  let child = null, descriptor = null, startPromise = null, closed = false, terminalError = null, nextId = 1, buffer = '', sequence = 0;
  let archiveQueue = Promise.resolve();
  const pending = new Map(), notifications = [], counts = {initialize:0, read:0, archive:0};
  const decoder = new StringDecoder('utf8');
  function rejectPending(error) { for (const request of [...pending.values()]) request.reject(error); }
  function stopWith(code) {
    terminalError = failure(code); rejectPending(terminalError);
    child?.stdin?.destroy(); if (child && child.exitCode == null) child.kill();
  }
  function handle(message) {
    if (message?.method === 'thread/archived') {
      const value = message.params?.threadId;
      if (typeof value === 'string' && UUID.test(value)) {
        notifications.push({sequence:++sequence, id:value.toLowerCase()});
        if (notifications.length > 50000) notifications.splice(0, notifications.length - 50000);
      }
    }
    if (Object.hasOwn(message || {}, 'id')) {
      const request = pending.get(message.id);
      if (!request) return;
      if (message.error) request.reject(rpcFailure(request.method, message.error));
      else if (Object.hasOwn(message, 'result')) request.resolve(message.result);
      else request.reject(failure('INVALID_APP_SERVER_RESPONSE'));
    }
  }
  function receive(chunk) {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return stopWith('APP_SERVER_FRAME_TOO_LARGE');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { handle(JSON.parse(line)); } catch { stopWith('INVALID_APP_SERVER_RESPONSE'); return; }
    }
  }
  function request(method, params, signal) {
    abort(signal);
    if (closed) return Promise.reject(failure('ADAPTER_STOPPED'));
    if (terminalError) return Promise.reject(terminalError);
    if (desktopRequest) {
      if (method === 'thread/read') counts.read++;
      else if (method === 'thread/archive') counts.archive++;
      else return Promise.reject(failure('INVALID_APP_SERVER_RESPONSE'));
      return desktopRequest(method, params.threadId, {signal, timeoutMs});
    }
    if (!child?.stdin?.writable) return Promise.reject(failure('APP_SERVER_NOT_RUNNING'));
    const requestId = nextId++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); pending.delete(requestId);
        error ? reject(error) : resolve(value);
      };
      const onAbort = () => finish(failure('ABORTED'));
      const timer = setTimeout(() => { finish(failure('APP_SERVER_TIMEOUT')); stopWith('APP_SERVER_TIMEOUT'); }, timeoutMs);
      signal?.addEventListener('abort', onAbort, {once:true});
      pending.set(requestId, {method, resolve:value => finish(null, value), reject:error => finish(error)});
      if (method === 'initialize') counts.initialize++; else if (method === 'thread/read') counts.read++; else if (method === 'thread/archive') counts.archive++;
      child.stdin.write(JSON.stringify({jsonrpc:'2.0', id:requestId, method, params}) + '\n', error => { if (error) finish(failure('APP_SERVER_WRITE_FAILED')); });
    });
  }
  async function start(signal) {
    abort(signal);
    if (closed) throw failure('ADAPTER_STOPPED');
    if (terminalError) throw terminalError;
    if (desktopRequest) return;
    if (!startPromise) startPromise = (async () => {
      descriptor = await deps.resolveExecutable(); abort(signal);
      if (closed) throw failure('ADAPTER_STOPPED');
      if (descriptor?.family !== FAMILY || typeof descriptor.executable !== 'string' || !path.isAbsolute(descriptor.executable)) throw failure('OFFICIAL_APP_SERVER_UNAVAILABLE');
      child = deps.spawn(descriptor.executable, ['app-server'], {cwd:codexHome, env:{...process.env, CODEX_HOME:codexHome}, windowsHide:true, stdio:['pipe','pipe','pipe']});
      child.stdout.on('data', receive); child.stderr.on('data', () => {});
      child.stdin.on('error', () => stopWith('APP_SERVER_WRITE_FAILED'));
      child.once('error', () => stopWith('APP_SERVER_START_FAILED'));
      child.once('exit', () => { if (!closed) { terminalError = failure('APP_SERVER_EXITED'); rejectPending(terminalError); } });
      await request('initialize', {clientInfo:{name:'codex-nested-conversations-archive', version:'0.1.0'}, capabilities:{experimentalApi:true}}, signal);
      abort(signal);
      child.stdin.write(JSON.stringify({jsonrpc:'2.0', method:'initialized', params:{}}) + '\n');
      return {packageVersion:descriptor.packageVersion};
    })();
    return startPromise;
  }
  async function snapshot(threadId, mode, signal) {
    abort(signal);
    if (closed) throw failure('ADAPTER_STOPPED');
    const result = await deps.readSnapshot({codexHome, threadId, mode, python, signal}); abort(signal);
    return validateSnapshot(result, threadId);
  }
  async function readStatus(threadId, {signal} = {}) {
    threadId = id(threadId);
    const result = await snapshot(threadId, 'status', signal);
    return {archived:result.thread.archived};
  }
  async function readMetadata(threadId, {signal} = {}) {
    threadId = id(threadId); await start(signal); abort(signal);
    const result = await request('thread/read', {threadId, includeTurns:false}, signal);
    if (result?.thread?.id !== threadId || (Array.isArray(result.thread.turns) && result.thread.turns.length !== 0)) throw failure('INVALID_THREAD_METADATA');
    // Return no preview, user-message text, turns, transcript path, or auth data.
    return {id:threadId, source:result.thread.source, status:result.thread.status?.type || null};
  }
  function archive(threadId, {signal, confirmedIds, reviewedBackground} = {}) {
    threadId = id(threadId);
    if (!Array.isArray(confirmedIds) || !confirmedIds.length || confirmedIds.length > MAX_SCOPE) return Promise.reject(failure('CONFIRMED_SCOPE_REQUIRED', {submitted:false}));
    let scope;
    try { scope = new Set(confirmedIds.map(id)); } catch { return Promise.reject(failure('INVALID_CONFIRMED_SCOPE', {submitted:false})); }
    if (!scope.has(threadId)) return Promise.reject(failure('THREAD_OUTSIDE_CONFIRMED_SCOPE', {submitted:false}));
    const operation = async () => {
      let submitted = false, cursor = sequence;
      try {
        abort(signal);
        let before = await snapshot(threadId, 'scope', signal);
        if (before.thread.archived) return {submitted:false, alreadyArchived:true, affectedIds:[]};
        const metadata=await readMetadata(threadId, {signal});
        if (desktopRequest) {
          // Archiving on the owning connection releases idle writers. An active turn
          // is user work, so stop before preparing it or its children for archive.
          function requireIdle(status) {
            if (status === 'active') throw failure('DESKTOP_TURN_ACTIVE');
            if (status !== 'idle' && status !== 'notLoaded') throw failure('INVALID_THREAD_METADATA');
          }
          requireIdle(metadata.status);
          for (const row of before.spawnedDescendants) {
            if (row.archived || !scope.has(row.id)) continue;
            requireIdle((await readMetadata(row.id,{signal})).status);
          }
        }
        before = await snapshot(threadId, 'scope', signal); // Fresh check immediately before the only write.
        if (before.thread.archived) return {submitted:false, alreadyArchived:true, affectedIds:[]};
        const implicit = before.spawnedDescendants.filter(row => !row.archived).map(row => row.id);
        const outside = implicit.filter(value => !scope.has(value));
        if (outside.length) throw failure('IMPLICIT_DESCENDANTS_OUTSIDE_SCOPE', {outsideScopeIds:outside});
        if(reviewedBackground){
          const rows=new Map(before.spawnedDescendants.map(row=>[row.id,row]));
          for(const item of reviewedBackground){
            const row=rows.get(item.id);
            if(!row||backgroundTitle(row)!==item.title)throw failure('BACKGROUND_SCOPE_CHANGED');
          }
        }
        abort(signal); cursor = sequence; submitted = true;
        await request('thread/archive', {threadId}, signal);
        if (settleMs) await new Promise(resolve => setTimeout(resolve, settleMs));
        abort(signal);
        const after = await snapshot(threadId, 'scope', signal);
        const prior = new Map([before.thread, ...before.spawnedDescendants].map(row => [row.id, row.archived]));
        const afterRows = [after.thread, ...after.spawnedDescendants];
        const affectedIds = [...new Set([...notifications.filter(row => row.sequence > cursor).map(row => row.id),
          ...afterRows.filter(row => row.archived && prior.get(row.id) === false).map(row => row.id)])];
        const newOutside = after.spawnedDescendants.filter(row => !prior.has(row.id) && !scope.has(row.id)).map(row => row.id);
        if (newOutside.length) throw failure('SCOPE_CHANGED_AFTER_SUBMISSION', {affectedIds, outsideScopeIds:newOutside});
        const affectedOutside = affectedIds.filter(value => !scope.has(value));
        if (affectedOutside.length) throw failure('AFFECTED_IDS_OUTSIDE_SCOPE', {affectedIds, outsideScopeIds:affectedOutside});
        return {submitted:true, affectedIds};
      } catch (error) {
        const safeCode = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'ARCHIVE_PROVIDER_FAILED';
        throw failure(safeCode, {submitted, affectedIds:error.affectedIds || notifications.filter(row => row.sequence > cursor).map(row => row.id),
          ...(safeCode === 'APP_SERVER_RPC_FAILED' ? {details:error.details} : {}),
          ...(error.outsideScopeIds ? {outsideScopeIds:error.outsideScopeIds} : {})});
      }
    };
    const result = archiveQueue.catch(() => {}).then(operation); archiveQueue = result; return result;
  }
  function dispose() {
    if (closed) return; closed = true; rejectPending(failure('ADAPTER_STOPPED'));
    if (!child || child.exitCode != null) return;
    child.stdin.end();
    const timer = setTimeout(() => { if (child.exitCode == null) child.kill(); }, 1000); timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }
  return {capabilities:CAPABILITIES, start, readMetadata, readStatus,
    readScope:(threadId, {signal} = {}) => snapshot(id(threadId), 'scope', signal), archive, dispose,
    inspect:() => ({started:!!child, closed, childProcessId:child?.pid || null, packageVersion:descriptor?.packageVersion || null, counts:{...counts}})};
}

module.exports = {createArchiveAppServer, CAPABILITIES, resolveOfficialExecutable, readLocalSnapshot, validateSnapshot,backgroundTitle, rpcFailure};
