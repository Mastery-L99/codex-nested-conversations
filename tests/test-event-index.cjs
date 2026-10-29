'use strict';
// Synthetic fixtures only: no official app, profile, transcript, or database.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createEventIndex, DATABASE_FILES} = require('../src/event-index.cjs');
const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message = 'condition', timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + message);
    await delay(5);
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
function watchFixture() {
  const handles = [];
  function watch(directory, options, callback) {
    const handle = new EventEmitter();
    Object.assign(handle, {directory, options, closed:false,
      close() {this.closed = true;},
      fire(filename, eventType = 'change') {if (!this.closed) callback(eventType, filename);}});
    handles.push(handle);
    return handle;
  }
  return {watch, handles};
}
function fixture(t, extra = {}) {
  const watched = watchFixture();
  const calls = [];
  const index = createEventIndex({codexHome:path.join(os.tmpdir(), 'synthetic-codex-event-index'),
    watch:watched.watch, debounceMs:15, maxWaitMs:50, fsDebounceMs:55,
    retryDelaysMs:[5, 10], watchRetryDelaysMs:[5, 10],
    sync:async context => {calls.push(context); return {groups:0, children:0, changed:false};}, ...extra});
  t.after(() => index.stop());
  return {index, calls, ...watched};
}

test('startup watches before first snapshot; clean/idle flush does no work', async t => {
  let watcherPresent = false;
  const watched = watchFixture();
  const calls = [];
  const index = createEventIndex({codexHome:os.tmpdir(), watch:watched.watch,
    sync:async () => {watcherPresent = watched.handles.length === 1; calls.push(1); return {};}});
  t.after(() => index.stop());
  assert.equal(index.inspect().counts.runs, 0);
  index.start().start();
  await index.flush();
  assert.equal(watcherPresent, true);
  assert.equal(calls.length, 1);
  await index.flush();
  await delay(90);
  assert.equal(calls.length, 1);
  assert.equal(index.inspect().timerScheduled, false);
  assert.equal(index.inspect().pending, false);
});

test('exact database names only; duplicates coalesce; null filename is conservative', async t => {
  const {index, calls, handles} = fixture(t);
  index.start(); await index.flush();
  handles[0].fire('state_5.sqlite-shm');
  handles[0].fire('session_index.jsonl');
  handles[0].fire('thread_history_1.sqlite.tmp');
  await delay(70);
  assert.equal(calls.length, 1);
  assert.equal(index.inspect().counts.ignoredFileEvents, 3);
  for (let i = 0; i < 30; i++) handles[0].fire(Buffer.from('state_5.sqlite-wal'));
  await delay(20);
  assert.equal(calls.length, 1);
  await until(() => calls.length === 2, 'coalesced filesystem rebuild');
  await delay(70);
  assert.equal(calls.length, 2);
  handles[0].fire(null);
  await index.flush();
  assert.equal(calls.length, 3);
  assert.ok(calls[2].reasons.includes('filesystem:unknown'));
  assert.deepEqual(DATABASE_FILES, ['thread_history_1.sqlite','thread_history_1.sqlite-wal',
    'state_5.sqlite','state_5.sqlite-wal']);
});

test('continuous WAL writes do not become polling; native event cannot be postponed by WAL', async t => {
  const {index, calls, handles} = fixture(t, {fsDebounceMs:80});
  index.start(); await index.flush();
  for (let i = 0; i < 22; i++) {
    handles[0].fire('thread_history_1.sqlite-wal');
    await delay(8);
    assert.equal(calls.length, 1, 'no forced max-wait rebuild during continuous writes');
  }
  index.markDirty('native:thread-created', {source:'native', urgent:true});
  for (let i = 0; i < 12; i++) {
    handles[0].fire('thread_history_1.sqlite-wal');
    await delay(5);
  }
  assert.equal(calls.length, 2, 'native update runs while WAL remains busy');
  assert.ok(calls[1].reasons.includes('native:thread-created'));
  await until(() => calls.length === 3, 'one quiet-window backup');
  await delay(120);
  assert.equal(calls.length, 3);
});

test('native/UI bursts coalesce independently and nativeOnly never opens a watcher', async t => {
  const {index, calls, handles} = fixture(t, {watchMode:'nativeOnly'});
  index.start(); await index.flush();
  assert.equal(handles.length, 0);
  for (let i = 0; i < 15; i++) index.markDirty('ui:sidebar-membership', {source:'ui'});
  await until(() => calls.length === 2, 'one UI burst rebuild');
  await delay(60);
  assert.equal(calls.length, 2);
  assert.equal(index.inspect().watchMode, 'nativeOnly');
  assert.equal(index.inspect().watching, false);
});

test('events during a read produce a fresh serial snapshot instead of being cleared', async t => {
  const gates = [deferred(), deferred()];
  const generations = [];
  let active = 0, maximumActive = 0;
  const {index, handles} = fixture(t, {sync:async context => {
    generations.push(context.generation);
    active++; maximumActive = Math.max(maximumActive, active);
    await gates[generations.length - 1].promise;
    active--; return {changed:true};
  }});
  index.start();
  await until(() => generations.length === 1, 'initial read');
  handles[0].fire('state_5.sqlite-wal');
  index.markDirty('native:create-completed', {source:'native', urgent:true});
  handles[0].fire('thread_history_1.sqlite-wal');
  gates[0].resolve();
  await until(() => generations.length === 2, 'snapshot after concurrent commits');
  assert.equal(maximumActive, 1);
  assert.equal(index.inspect().syncedGeneration, generations[0]);
  gates[1].resolve();
  await index.flush();
  assert.ok(generations[1] > generations[0]);
  assert.equal(index.inspect().syncedGeneration, index.inspect().generation);
  await delay(70);
  assert.equal(generations.length, 2);
});

test('transient read failure retries are bounded and a later real event gets a fresh budget', async t => {
  let fail = true, calls = 0;
  const errors = [];
  const {index} = fixture(t, {sync:async () => {calls++; if (fail) throw new Error('database is locked'); return {groups:1};},
    onError:(error, context) => errors.push(context.phase)});
  index.start(); await index.flush();
  assert.equal(calls, 3);
  assert.equal(index.inspect().counts.retriesScheduled, 2);
  assert.equal(index.inspect().retryExhausted, true);
  assert.match(index.inspect().lastError, /database is locked/);
  assert.equal(index.inspect().timerScheduled, false);
  await delay(70);
  assert.equal(calls, 3);
  fail = false;
  index.markDirty('native:thread-created', {source:'native', urgent:true});
  await index.flush();
  assert.equal(calls, 4);
  assert.equal(index.inspect().retryExhausted, false);
  assert.equal(index.inspect().lastError, null);
  assert.equal(index.inspect().lastResult.groups, 1);
  assert.deepEqual(errors, ['sync','sync','sync']);
});

test('a new event arriving during a failed attempt is retained', async t => {
  const gate = deferred();
  let calls = 0;
  const {index} = fixture(t, {retryDelaysMs:[], sync:async () => {
    if (++calls === 1) await gate.promise;
    return {groups:1};
  }});
  index.start(); await until(() => calls === 1);
  index.markDirty('native:second-commit', {source:'native', urgent:true});
  gate.reject(new Error('first transaction busy'));
  await index.flush();
  assert.equal(calls, 2);
  assert.equal(index.inspect().counts.failures, 1);
  assert.equal(index.inspect().lastError, null);
});

test('successful manifest callback failure is reported without repeating SQL', async t => {
  const errors = [];
  const {index, calls} = fixture(t, {onSync:async () => {throw new Error('renderer unavailable');},
    onError:(error, context) => errors.push(context.phase)});
  index.start(); await index.flush();
  await delay(50);
  assert.equal(calls.length, 1);
  assert.equal(index.inspect().counts.successes, 1);
  assert.equal(index.inspect().counts.callbackFailures, 1);
  assert.match(index.inspect().lastCallbackError, /renderer unavailable/);
  assert.deepEqual(errors, ['onSync']);
});

test('watcher errors reconnect finitely and reconcile the observation gap', async t => {
  const {index, calls, handles} = fixture(t);
  index.start(); await index.flush();
  const old = handles[0];
  old.emit('error', new Error('fixture watch interrupted'));
  assert.equal(old.closed, true);
  await until(() => handles.length === 2, 'watcher reconnection');
  assert.equal(index.inspect().watching, true);
  old.emit('error', new Error('late error from old watcher'));
  assert.equal(handles[1].closed, false);
  await index.flush();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].reasons.includes('filesystem:watcher-reconnected'));
  assert.equal(index.inspect().counts.watcherErrors, 1);
  assert.equal(index.inspect().lastWatchError, null);
});

test('unavailable watch stops after finite reconnect attempts and keeps native updates usable', async t => {
  let attempts = 0, calls = 0;
  const index = createEventIndex({codexHome:os.tmpdir(), watchRetryDelaysMs:[5,10],
    watch() {attempts++; throw new Error('watch unavailable');},
    sync:async () => {calls++; return {};}});
  t.after(() => index.stop());
  index.start(); await index.flush();
  await until(() => attempts === 3);
  await delay(50);
  assert.equal(attempts, 3);
  assert.equal(index.inspect().watchRetryScheduled, false);
  assert.match(index.inspect().lastWatchError, /watch unavailable/);
  index.markDirty('native:thread-created', {source:'native', urgent:true});
  await index.flush();
  assert.equal(calls, 2);
});

test('stop cancels pending events, closes handles, aborts this read, and suppresses late callbacks', async t => {
  const gate = deferred();
  let signal, callbacks = 0, calls = 0;
  const {index, handles} = fixture(t, {sync:async context => {
    calls++; signal = context.signal; await gate.promise; return {groups:1};
  }, onSync:() => callbacks++});
  index.start(); await until(() => calls === 1);
  index.markDirty('native:queued-event', {source:'native', urgent:true});
  const waiting = index.flush();
  index.stop();
  assert.equal(signal.aborted, true);
  assert.equal(handles[0].closed, true);
  assert.equal((await waiting).stopped, true);
  assert.equal(index.markDirty('native:after-stop'), false);
  handles[0].fire('state_5.sqlite');
  gate.resolve();
  await delay(80);
  assert.equal(calls, 1);
  assert.equal(callbacks, 0);
  assert.equal(index.inspect().timerScheduled, false);
  assert.equal(index.inspect().inFlight, false);
});

test('pause keeps generations and filesystem metadata while freezing manifest rebuilds', async t => {
  const events = [];
  const {index, calls, handles} = fixture(t, {onFilesystemEvent:event => events.push(event)});
  index.start(); await index.flush();
  await index.pause();
  const previousGeneration = index.inspect().generation;
  handles[0].fire('state_5.sqlite-wal', 'rename');
  handles[0].fire('thread_history_1.sqlite-wal');
  handles[0].fire('unrelated.json');
  index.markDirty('native:archive-completed', {source:'native', urgent:true});
  await delay(90);
  assert.equal(calls.length, 1);
  assert.equal(index.inspect().timerScheduled, false);
  assert.equal(index.inspect().pending, true);
  assert.ok(index.inspect().generation > previousGeneration);
  assert.equal((await index.flush()).paused, true);
  assert.deepEqual(events, [{filename:'state_5.sqlite-wal',eventType:'rename'},
    {filename:'thread_history_1.sqlite-wal',eventType:'change'}]);
  assert.equal(index.resume(), true);
  await index.flush();
  assert.equal(calls.length, 2);
  assert.equal(index.inspect().syncedGeneration, index.inspect().generation);
  assert.equal(index.resume(), false);
});

test('await pause waits for the running snapshot then gives a stable write-free boundary', async t => {
  const gate = deferred();
  let calls = 0, settled = false;
  const {index} = fixture(t, {sync:async () => {
    if (++calls === 1) await gate.promise;
    return {};
  }});
  index.start(); await until(() => calls === 1);
  const pausing = index.pause().then(() => {settled = true;});
  index.markDirty('native:archive', {source:'native', urgent:true});
  await delay(20);
  assert.equal(settled, false);
  gate.resolve();
  await pausing;
  assert.equal(index.inspect().inFlight, false);
  await delay(70);
  assert.equal(calls, 1);
  index.resume(); await index.flush();
  assert.equal(calls, 2);
});

test('real directory watch survives WAL removal and replacement with no idle rebuild', async t => {
  // Tiny, generated caches contain no user data and stay in the OS temp area.
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-event-index-watch-'));
  const filename = path.join(folder, 'state_5.sqlite-wal');
  let calls = 0;
  const index = createEventIndex({codexHome:folder, fsDebounceMs:30,
    sync:async () => {calls++; return {};}});
  t.after(() => index.stop());
  index.start(); await index.flush();
  await fs.writeFile(path.join(folder, 'unrelated.json'), '{}');
  await delay(70);
  assert.equal(calls, 1);
  await fs.writeFile(filename, 'synthetic WAL one');
  await until(() => calls >= 2, 'new WAL event');
  await index.flush();
  const first = calls;
  // Rename preserves the synthetic old cache instead of deleting it.
  await fs.rename(filename, path.join(folder, 'old-synthetic-wal.cache'));
  await fs.writeFile(filename, 'synthetic WAL two');
  await until(() => calls > first, 'replacement WAL event');
  await index.flush();
  const settled = calls;
  await delay(120);
  assert.equal(calls, settled);
  assert.equal(index.inspect().watching, true);
});

const python = process.env.CNCC_PYTHON || 'python';
test('real Python sync discovers synthetic create then archive via filesystem events', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-event-index-sqlite-'));
  const output = path.join(folder, 'synthetic-relations.json');
  const parent = '00000000-0000-0000-0000-000000000001';
  const child = '00000000-0000-0000-0000-000000000002';
  const init = `import sqlite3,sys\nfrom pathlib import Path\np=Path(sys.argv[1])\ns=sqlite3.connect(p/'state_5.sqlite')\ns.execute('CREATE TABLE threads (id TEXT PRIMARY KEY,name TEXT,archived INTEGER,thread_source TEXT,source TEXT,agent_path TEXT,created_at_ms INTEGER,created_at INTEGER,updated_at_ms INTEGER,attached_thread_parent_id TEXT)')\ns.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?)',(sys.argv[2],'Synthetic parent',0,'user','',None,1000,1,1000,None))\ns.commit();s.close()\nh=sqlite3.connect(p/'thread_history_1.sqlite')\nh.execute('CREATE TABLE thread_items (thread_id TEXT,item_id TEXT,item_type TEXT,item_json TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER)')\nh.commit();h.close()`;
  await run(python, ['-c', init, folder, parent], {windowsHide:true});
  const snapshots = [];
  const index = createEventIndex({codexHome:folder, python, outputPath:output,
    fsDebounceMs:40, retryDelaysMs:[20,60],
    onSync:result => snapshots.push(result)});
  t.after(() => index.stop());
  index.start(); await index.flush();
  assert.equal(snapshots.at(-1).groups, 0);
  const create = `import sqlite3,sys,json,time\nfrom pathlib import Path\np=Path(sys.argv[1]);parent=sys.argv[2];child=sys.argv[3]\ns=sqlite3.connect(p/'state_5.sqlite');s.execute('PRAGMA journal_mode=WAL')\ns.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?)',(child,'Synthetic child',0,'agent_created_thread','',None,2000,2,2000,None));s.commit()\nh=sqlite3.connect(p/'thread_history_1.sqlite');h.execute('PRAGMA journal_mode=WAL')\ne={'type':'mcpToolCall','server':'codex_app','tool':'create_thread','status':'completed','error':None,'arguments':{'target':{'type':'projectless'}},'result':{'threadId':child,'hostId':'local'}}\nh.execute('INSERT INTO thread_items VALUES (?,?,?,?,?,?)',(parent,'synthetic-call','mcpToolCall',json.dumps(e),1,2000));h.commit()\ntime.sleep(0.15);h.close();s.close()`;
  await run(python, ['-c', create, folder, parent, child], {windowsHide:true});
  await until(() => snapshots.some(row => row.groups === 1), 'created relation snapshot', 6000);
  await index.flush();
  let manifest = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(manifest.groups[0].parent.id, parent);
  assert.equal(manifest.groups[0].children[0].id, child);
  const archive = `import sqlite3,sys\nfrom pathlib import Path\ns=sqlite3.connect(Path(sys.argv[1])/'state_5.sqlite');s.execute('UPDATE threads SET archived=1 WHERE id=?',(sys.argv[2],));s.commit();s.close()`;
  const previous = snapshots.length;
  await run(python, ['-c', archive, folder, child], {windowsHide:true});
  await until(() => snapshots.length > previous && snapshots.at(-1).groups === 0, 'archived relation snapshot', 6000);
  await index.flush();
  manifest = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.deepEqual(manifest.groups, []);
  const settledRuns = index.inspect().counts.runs;
  await delay(180);
  assert.equal(index.inspect().counts.runs, settledRuns);
  assert.equal(index.inspect().lastError, null);
});
