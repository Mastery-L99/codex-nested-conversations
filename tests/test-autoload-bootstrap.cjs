'use strict';
// All identities, connections, profiles and helper processes below are synthetic.
// The only real subprocess tests use this project's unconfigured MCP or a short OS mutex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {PassThrough} = require('node:stream');
const {EventEmitter} = require('node:events');
const {spawn} = require('node:child_process');
const {PROJECT, loadConfig, windowsArgv, createBootstrap, serveStdio, withWindowsMutex} = require('../src/autoload-bootstrap.cjs');
const {createFixture, recycleFixture} = require('./recycle-fixture.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve; const promise = new Promise(yes => {resolve = yes;}); return {promise, resolve}; }
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() > deadline) throw Error('fixture deadline'); await delay(5); }
}
async function diskFixture(t) {
  const root = await createFixture('cncc-autoload-fixture-');
  t.after(() => recycleFixture(root));
  const installDir = path.join(root, 'installed'), dataDir = path.join(root, 'data'), profileDir = path.join(root, 'profile');
  await Promise.all([fs.mkdir(path.join(installDir, 'app'), {recursive:true}), fs.mkdir(dataDir), fs.mkdir(profileDir)]);
  const configPath = path.join(dataDir, 'autoload-config.json');
  const moduleFilename = path.join(installDir, 'app', 'autoload-bootstrap.cjs');
  const helperScript = path.join(installDir, 'app', 'enhance-current.cjs');
  const python = path.join(root, 'python.exe');
  await Promise.all([moduleFilename, helperScript, python].map(file => fs.writeFile(file, '// fixture only')));
  const config = {schemaVersion:1, project:PROJECT, enabled:true, installDir, dataDir, profileDir};
  const marker = {schemaVersion:1, project:PROJECT, state:'installed', installDir, dataDir, node:process.execPath, python,
    runtime:{companionScript:'enhance-current.cjs', files:['enhance-current.cjs', 'autoload-bootstrap.cjs']}};
  const markerPath = path.join(installDir, '.cncc-install.json'), dataMarkerPath = path.join(dataDir, '.cncc-data.json');
  const write = (file, value) => fs.writeFile(file, JSON.stringify(value));
  await Promise.all([write(configPath, config), write(markerPath, marker), write(dataMarkerPath, {schemaVersion:1, project:PROJECT})]);
  return {root, config, configPath, moduleFilename, marker, markerPath, dataMarkerPath, installDir, dataDir, profileDir, helperScript, python, write};
}
function serialLock() {
  let queue = Promise.resolve();
  return async (_, callback) => {
    const previous = queue, released = deferred(); queue = released.promise;
    await previous;
    try { return await callback(); } finally { released.resolve(); }
  };
}
async function behaviorFixture(t, overrides = {}) {
  const disk = await diskFixture(t), processes = [], logs = [], calls = {discover:0, spawn:0, lists:0, watch:0};
  let watchCallback;
  const watcher = new EventEmitter(); watcher.closed = false; watcher.close = () => { watcher.closed = true; };
  const config = {...disk.config, node:process.execPath, python:disk.python, helperScript:disk.helperScript, codexHome:path.join(disk.root, 'home')};
  const connection = {appProcessId:98765, packageVersion:'fixture', transport:'profile_approval', endpointUrl:'ws://127.0.0.1:59999/devtools/browser/fixture'};
  const deps = {
    loadConfig:async () => config,
    discoverConnection:async () => { calls.discover++; return connection; },
    listProcesses:async () => { calls.lists++; return processes; },
    withLock:serialLock(),
    spawnHelper:async () => { calls.spawn++; processes.push({pid:12345, executable:config.node, commandLine:JSON.stringify(config.node) + ' ' + JSON.stringify(config.helperScript)}); return {pid:12345}; },
    watch:(_, options, callback) => { calls.watch++; watchCallback = callback; return watcher; },
    ...overrides,
  };
  const bootstrap = createBootstrap({configPath:disk.configPath, moduleFilename:disk.moduleFilename, deps, logger:event => logs.push(event)});
  t.after(() => bootstrap.stop());
  return {...disk, config, connection, processes, calls, logs, deps, bootstrap, watcher, fire:name => watchCallback?.('change', name)};
}

test('no explicit autoload config means no filesystem, process, endpoint or launch activity', async () => {
  let touched = 0;
  const bootstrap = createBootstrap({configPath:'', deps:{loadConfig:async () => {touched++; throw Error();}, discoverConnection:async () => {touched++;}}});
  assert.equal((await bootstrap.attempt()).state, 'unconfigured');
  assert.equal((await bootstrap.attempt()).state, 'unconfigured');
  bootstrap.stop(); assert.equal(touched, 0);
});

test('installer identity binds config, data marker, module, executable and companion', async t => {
  const f = await diskFixture(t);
  const value = await loadConfig(f.configPath, f.moduleFilename);
  assert.equal(value.helperScript, f.helperScript);
  assert.equal(value.node, process.execPath);
  assert.equal(value.dataDir, f.dataDir);
  assert.equal(value.profileDir, f.profileDir);
  assert.equal(value.enabled, true);
});

for (const [label, mutate] of [
  ['foreign project', async f => f.write(f.configPath, {...f.config, project:'foreign'} )],
  ['installing marker', async f => f.write(f.markerPath, {...f.marker, state:'installing'})],
  ['foreign data marker', async f => f.write(f.dataMarkerPath, {schemaVersion:1, project:'foreign'})],
  ['different marker data', async f => f.write(f.markerPath, {...f.marker, dataDir:f.profileDir})],
  ['arbitrary helper script', async f => f.write(f.markerPath, {...f.marker, runtime:{...f.marker.runtime, companionScript:'other.cjs'}})],
  ['missing bootstrap manifest entry', async f => f.write(f.markerPath, {...f.marker, runtime:{...f.marker.runtime, files:['enhance-current.cjs']}})],
  ['relative executable', async f => f.write(f.markerPath, {...f.marker, node:'node.exe'})],
  ['shell as executable', async f => f.write(f.markerPath, {...f.marker, node:f.python})],
  ['nested data root', async f => f.write(f.configPath, {...f.config, dataDir:path.join(f.installDir, 'data')})],
]) test('rejects ' + label + ' before launching anything', async t => {
  const f = await diskFixture(t); await mutate(f);
  await assert.rejects(loadConfig(f.configPath, f.moduleFilename));
});

test('copied config and uninstalled source module cannot authorize an installation', async t => {
  const f = await diskFixture(t), copy = path.join(f.root, 'copied.json');
  await fs.copyFile(f.configPath, copy);
  await assert.rejects(loadConfig(copy, f.moduleFilename), {code:'CONFIG_IDENTITY_MISMATCH'});
  await assert.rejects(loadConfig(f.configPath, __filename), {code:'CONFIG_IDENTITY_MISMATCH'});
});

test('configuration, marker and script symlinks are refused', async t => {
  const f = await diskFixture(t), link = path.join(f.root, 'linked');
  try { await fs.symlink(f.dataDir, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('host cannot create fixture junction'); throw error; }
  await assert.rejects(loadConfig(path.join(link, 'autoload-config.json'), f.moduleFilename), {code:'REPARSE_PATH'});
});

test('oversized config is refused without parsing it', async t => {
  const f = await diskFixture(t); await fs.writeFile(f.configPath, ' '.repeat(65537));
  await assert.rejects(loadConfig(f.configPath, f.moduleFilename), {code:'INVALID_JSON_FILE'});
});

test('disabled config performs no app discovery or helper spawn', async t => {
  const f = await behaviorFixture(t, {loadConfig:async () => ({enabled:false})});
  assert.equal((await f.bootstrap.attempt()).state, 'disabled');
  assert.deepEqual(f.calls, {discover:0, spawn:0, lists:0, watch:0});
});

test('startup and repeated initialize attempts share one launch; later attempts reuse the exact helper', async t => {
  const f = await behaviorFixture(t);
  const values = await Promise.all(Array.from({length:40}, () => f.bootstrap.attempt()));
  assert.ok(values.every(value => value.state === 'starting'));
  assert.equal(f.calls.spawn, 1);
  assert.equal((await f.bootstrap.attempt()).state, 'reused');
  assert.equal(f.calls.spawn, 1);
  assert.equal(f.calls.watch, 1);
  const status = JSON.parse(await fs.readFile(path.join(f.dataDir, 'autoload-status.json'), 'utf8'));
  assert.equal(status.state, 'reused'); assert.equal(status.helperProcessId, 12345);
  assert.equal(Object.hasOwn(status, 'endpointUrl'), false);
});

test('two MCP instances serialize and reuse the same installed helper', async t => {
  const f = await behaviorFixture(t), other = createBootstrap({configPath:f.configPath, deps:f.deps, logger:() => {}});
  t.after(() => other.stop());
  const states = (await Promise.all([f.bootstrap.attempt(), other.attempt()])).map(value => value.state).sort();
  assert.deepEqual(states, ['reused', 'starting']); assert.equal(f.calls.spawn, 1);
});

test('another installation or altered helper invocation blocks a duplicate instead of guessing ownership', async t => {
  const f = await behaviorFixture(t);
  f.processes.push({pid:22222, executable:f.config.node, commandLine:JSON.stringify(f.config.node) + ' ' + JSON.stringify(path.join(f.root, 'other', 'enhance-current.cjs'))});
  assert.equal((await f.bootstrap.attempt()).state, 'blocked_other_runtime'); assert.equal(f.calls.spawn, 0);
  f.processes[0].commandLine = JSON.stringify(f.config.node) + ' ' + JSON.stringify(f.helperScript) + ' --extra';
  assert.equal((await f.bootstrap.attempt()).state, 'blocked_other_runtime'); assert.equal(f.calls.spawn, 0);
  f.processes[0].commandLine = JSON.stringify(f.config.node) + ' --inspect ' + JSON.stringify(f.helperScript);
  assert.equal((await f.bootstrap.attempt()).state, 'blocked_other_runtime'); assert.equal(f.calls.spawn, 0);
  f.processes[0].commandLine = 'node.exe enhance-current.cjs';
  assert.equal((await f.bootstrap.attempt()).state, 'blocked_other_runtime'); assert.equal(f.calls.spawn, 0);
  f.processes[0].commandLine = 'node.exe "C:\\fixture\\enhance-current.cjs';
  assert.equal((await f.bootstrap.attempt()).state, 'blocked_other_runtime'); assert.equal(f.calls.spawn, 0);
});

test('incomplete process identity and invalid app identity cannot authorize a spawn', async t => {
  const f = await behaviorFixture(t);
  f.processes.push({pid:777, executable:null, commandLine:null});
  assert.equal((await f.bootstrap.attempt()).code, 'PROCESS_IDENTITY_UNAVAILABLE'); assert.equal(f.calls.spawn, 0);
  f.processes.length = 0; f.connection.appProcessId = -1;
  assert.equal((await f.bootstrap.attempt()).code, 'INVALID_CONNECTION_IDENTITY'); assert.equal(f.calls.spawn, 0);
});

test('missing endpoint returns quiet need_connection without launching or restarting the official app', async t => {
  const f = await behaviorFixture(t, {discoverConnection:async () => { throw Object.assign(Error('sensitive-message-must-not-be-logged'), {code:'NO_ENDPOINT'}); }});
  const status = await f.bootstrap.attempt();
  assert.equal(status.state, 'need_connection'); assert.equal(status.code, 'NO_ENDPOINT');
  assert.equal(f.calls.spawn, 0); assert.deepEqual(f.logs, ['need_connection:NO_ENDPOINT']);
});

test('a lost mutex and timeout both stop late discovery results from spawning', async t => {
  const lost = await behaviorFixture(t, {withLock:async (_, callback) => callback({assertHeld(){throw Object.assign(Error(), {code:'MUTEX_LOST'});}})});
  assert.equal((await lost.bootstrap.attempt()).code, 'MUTEX_LOST'); assert.equal(lost.calls.spawn, 0);
  const wait = deferred(), f = await behaviorFixture(t, {discoverConnection:() => wait.promise});
  const bootstrap = createBootstrap({configPath:f.configPath, deps:f.deps, timeoutMs:20, logger:() => {}}); t.after(() => bootstrap.stop());
  const pending = bootstrap.attempt(); await delay(40);
  assert.equal((await pending).state, 'timed_out');
  wait.resolve(f.connection); await delay(30); assert.equal(f.calls.spawn, 0);
});

test('stopping a bootstrap during discovery never closes the app or launches a helper afterward', async t => {
  const wait = deferred(), f = await behaviorFixture(t, {discoverConnection:() => wait.promise});
  const pending = f.bootstrap.attempt(); await until(() => f.calls.watch === 1);
  f.bootstrap.stop(); wait.resolve(f.connection); await pending;
  assert.equal(f.calls.spawn, 0); assert.equal(f.bootstrap.inspect().state, 'stopped'); assert.equal(f.watcher.closed, true);
});

test('endpoint file events trigger recovery, unrelated changes and idle time do no work', async t => {
  let available = false;
  const f = await behaviorFixture(t, {discoverConnection:async () => { f.calls.discover++; if (!available) throw Object.assign(Error(), {code:'NO_ENDPOINT'}); return f.connection; }});
  await f.bootstrap.attempt(); const before = f.calls.discover;
  f.fire('Preferences'); await delay(160); assert.equal(f.calls.discover, before);
  available = true; for (let i = 0; i < 20; i++) f.fire('DevToolsActivePort');
  await until(() => f.calls.spawn === 1); await delay(180);
  assert.equal(f.calls.discover, before + 1); assert.equal(f.calls.spawn, 1);
});

test('Windows quoting binds spaced executable/script paths and rejects unmatched quotes', () => {
  assert.deepEqual(windowsArgv('"C:\\Program Files\\nodejs\\node.exe" "C:\\A B\\enhance-current.cjs"'), ['C:\\Program Files\\nodejs\\node.exe', 'C:\\A B\\enhance-current.cjs']);
  assert.deepEqual(windowsArgv('node.exe "unterminated'), []);
  assert.deepEqual(windowsArgv('node.exe "" x'), ['node.exe', '', 'x']);
  assert.deepEqual(windowsArgv('node.exe "a\\\\\\"b"'), ['node.exe', 'a\\"b']);
});

function protocolFixture(t) {
  const input = new PassThrough(), output = new PassThrough(), records = [], calls = [], stopped = [];
  output.on('data', value => { for (const line of String(value).trim().split('\n')) if (line) records.push(JSON.parse(line)); });
  const bootstrap = {attempt:reason => {calls.push(reason); return Promise.resolve();}, inspect:() => ({state:'need_connection'}), stop:() => stopped.push(true)};
  const server = serveStdio({bootstrap, input, output}); t.after(() => server.close());
  const send = (id, method, params) => input.write(JSON.stringify({jsonrpc:'2.0', id, method, params}) + '\n');
  return {input, output, records, calls, stopped, server, send, bootstrap};
}

test('MCP initialize and empty tools respond immediately without awaiting bootstrap work', async t => {
  const f = protocolFixture(t);
  f.bootstrap.attempt = reason => {f.calls.push(reason); return new Promise(() => {});};
  f.send(1, 'initialize', {protocolVersion:'2025-06-18', clientInfo:{name:'fixture', version:'1'}, capabilities:{}});
  f.input.write(JSON.stringify({jsonrpc:'2.0', method:'notifications/initialized'}) + '\n');
  f.send(2, 'tools/list', {}); f.send(3, 'ping', {}); f.send(4, 'cncc/status', {});
  assert.equal(f.records[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(f.records[1].result, {tools:[]}); assert.deepEqual(f.records[2].result, {});
  assert.deepEqual(f.records[3].result, {state:'need_connection'});
  assert.deepEqual(f.calls, ['process_start', 'initialize', 'initialized']);
  f.input.end(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.stopped.length, 1);
});

test('MCP errors remain valid JSON-RPC and do not echo private input', t => {
  const f = protocolFixture(t);
  f.input.write('secret invalid JSON\n'); f.send(5, 'tools/call', {secret:'do-not-echo'}); f.send(6, 'initialize', {});
  assert.deepEqual(f.records.map(row => row.error.code), [-32700, -32601, -32602]);
  assert.equal(JSON.stringify(f.records).includes('secret'), false);
});

test('MCP supports split UTF-8 input and bounded line frames', t => {
  const f = protocolFixture(t);
  const value = Buffer.from(JSON.stringify({jsonrpc:'2.0', id:'中文', method:'ping'}) + '\n');
  const index = value.indexOf(Buffer.from('中文')) + 1;
  f.input.write(value.subarray(0, index)); f.input.write(value.subarray(index));
  assert.equal(f.records[0].id, '中文');
  f.input.write('x'.repeat(65537)); assert.equal(f.records[1].error.code, -32700); assert.equal(f.stopped.length, 1);
});

test('real unconfigured MCP process writes protocol only and does no application work', async () => {
  const env = {...process.env}; delete env.CNCC_AUTOLOAD_CONFIG;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'autoload-bootstrap.cjs')], {env, windowsHide:true, stdio:['pipe', 'pipe', 'pipe']});
  let stdout = '', stderr = ''; child.stdout.on('data', value => {stdout += value;}); child.stderr.on('data', value => {stderr += value;});
  child.stdin.end(JSON.stringify({jsonrpc:'2.0', id:1, method:'initialize', params:{protocolVersion:'2025-06-18'}}) + '\n' + JSON.stringify({jsonrpc:'2.0', id:2, method:'tools/list'}) + '\n');
  const code = await new Promise((resolve, reject) => {child.once('exit', resolve); child.once('error', reject);});
  assert.equal(code, 0); assert.equal(stderr, '');
  const records = stdout.trim().split('\n').map(value => JSON.parse(value));
  assert.equal(records.length, 2); assert.equal(records[0].jsonrpc, '2.0'); assert.deepEqual(records[1].result, {tools:[]});
});

test('real Windows mutex excludes a second holder and recovers after callback failure', {skip:process.platform !== 'win32'}, async t => {
  const root = await createFixture('cncc-mutex-fixture-'); t.after(() => recycleFixture(root));
  const entered = deferred(), release = deferred(), config = {installDir:root};
  const first = withWindowsMutex(config, async lease => {lease.assertHeld(); entered.resolve(); await release.promise; return {state:'first'};});
  await entered.promise;
  const second = await withWindowsMutex(config, async () => {throw Error('must not acquire');}); assert.equal(second.state, 'bootstrap_busy');
  release.resolve(); assert.equal((await first).state, 'first');
  await delay(100);
  await assert.rejects(withWindowsMutex(config, async () => {throw Error('fixture callback failed');}), /fixture callback failed/);
  await delay(100);
  assert.equal((await withWindowsMutex(config, async () => ({state:'recovered'}))).state, 'recovered');
});
