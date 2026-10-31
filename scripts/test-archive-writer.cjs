'use strict';
// Optional Windows E2E. It starts official software against a new synthetic
// profile, performs no model turn, and never opens the daily Codex data folder.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { StringDecoder } = require('node:string_decoder');
const { createArchiveAppServer, resolveOfficialExecutable } = require('../src/archive-app-server.cjs');
const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TIMEOUT = 20000;

function argumentsFor(argv) {
  const value = { python: process.env.CNCC_PYTHON || 'python' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { value.help = true; continue; }
    if (!['--output-dir', '--python'].includes(arg) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw Error('Use --output-dir <new directory> and optionally --python <executable>.');
    }
    const key = arg === '--python' ? 'python' : 'outputDir';
    if (key === 'outputDir' && value.outputDir) throw Error('--output-dir may be supplied only once.');
    value[key] = argv[++index];
  }
  if (!value.help && !value.outputDir) throw Error('--output-dir <new directory> is required.');
  return value;
}
function inside(root, target) {
  const relative = path.relative(root.toLowerCase(), target.toLowerCase());
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
async function checkOutputDirectory(directory, officialExecutable) {
  const output = path.resolve(directory);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const protectedRoots = [path.join(os.homedir(), '.codex'), process.env.CODEX_HOME, process.env.CNCC_CODEX_HOME,
    process.env.CNCC_DATA_DIR, process.env.CNCC_SETTINGS_DIR, path.join(local, 'CodexNestedConversationsData'),
    path.dirname(path.dirname(officialExecutable))].filter(Boolean).map(value => path.resolve(value));
  if (protectedRoots.some(root => inside(root, output) || inside(output, root))) throw Error('The test output must be separate from official and daily module data.');
  try { await fs.lstat(output); throw Error('The output directory already exists; no files were changed.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Refuse a junction/symlink ancestor rather than following it into another profile.
  for (let current = path.dirname(output); ; current = path.dirname(current)) {
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Output ancestors must be existing ordinary directories.');
    if (path.dirname(current) === current) break;
  }
  return output;
}
function isolatedEnvironment(home, profile) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'COMSPEC', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, CODEX_HOME: home, USERPROFILE: profile, HOME: profile,
    APPDATA: path.join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
    PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
}
function observeOwnedChild(child, { onResponse, onNativeError, onFailure }) {
  const decoder = new StringDecoder('utf8'); let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { onFailure?.(Error('Owned server frame exceeded test limit.')); child.kill(); return; }
    let position;
    while ((position = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, position); buffer = buffer.slice(position + 1);
      if (!line.trim()) continue;
      let message; try { message = JSON.parse(line); } catch { onFailure?.(Error('Owned server returned invalid JSON.')); continue; }
      if (message.error) onNativeError?.(message.error);
      onResponse?.(message);
    }
  });
  // Do not print native stderr, which can contain machine paths. Neither this
  // environment nor either server receives account files or API key variables.
  child.stderr.on('data', () => {});
}
function rawOwner(executable, work, env) {
  const child = spawn(executable, ['app-server'], { cwd: work, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(), methods = []; let nextId = 1;
  function rejectAll(error) { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); }
  observeOwnedChild(child, { onFailure: rejectAll, onResponse(message) {
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(Object.assign(Error(message.error.message || 'Native RPC error'), { nativeCode: message.error.code }));
    else request.resolve(message.result);
  } });
  child.on('error', rejectAll); child.stdin.on('error', rejectAll);
  child.once('exit', () => rejectAll(Error('Owned server exited.')));
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  function request(method, params) {
    methods.push(method);
    return new Promise((resolve, reject) => {
      const id = nextId++, timer = setTimeout(() => { pending.delete(id); reject(Error('Owned RPC timed out: ' + method)); }, TIMEOUT);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  return { child, methods, request, exited, async initialize() {
    await request('initialize', { clientInfo: { name: 'cncc-synthetic-writer-e2e', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }, async close() {
    if (child.exitCode != null) return;
    child.stdin.end(); const timer = setTimeout(() => child.kill(), 1500);
    await exited; clearTimeout(timer);
  } };
}

async function execute(options) {
  if (process.platform !== 'win32') throw Error('This optional E2E requires Windows and the official installed Codex package.');
  const descriptor = await resolveOfficialExecutable();
  const outputDir = await checkOutputDirectory(options.outputDir, descriptor.executable);
  const home = path.join(outputDir, 'synthetic-home'), profile = path.join(outputDir, 'synthetic-profile'), work = path.join(outputDir, 'work');
  const env = isolatedEnvironment(home, profile);
  await run(options.python, ['-c', 'import sys,sqlite3; assert sys.version_info >= (3,10)'], { windowsHide: true, env, timeout: 5000 });
  await fs.mkdir(outputDir); // Deliberately refuse an existing output, including a concurrent creator.
  for (const directory of [home, work, env.APPDATA, env.LOCALAPPDATA]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider = "openai"\n', { flag: 'wx' });
  const result = { passed: false, syntheticOnly: true, modelTurns: 0, accountFilesCopied: false,
    packageVersion: descriptor.packageVersion, steps: [], outputDir };
  const redact = value => String(value).replaceAll(path.toNamespacedPath(outputDir), '[fixture]').replaceAll(outputDir, '[fixture]').slice(0, 1000);
  const nativeErrors = []; let owner, peer, peerChild, peerExit, sameOwner;
  const step = (name, value) => result.steps.push({ name, ...value });
  async function storedFlag(threadId) {
    assert(UUID.test(threadId));
    const code = "import sqlite3,sys,pathlib,json;c=sqlite3.connect((pathlib.Path(sys.argv[1])/'state_5.sqlite').resolve().as_uri()+'?mode=ro',uri=True);c.execute('pragma query_only=ON');rows=c.execute('select id,archived from threads').fetchall();assert len(rows)==1 and rows[0][0]==sys.argv[2], 'isolated fixture membership changed';print(json.dumps(bool(rows[0][1])))";
    return JSON.parse((await run(options.python, ['-c', code, home, threadId], { windowsHide: true, env, timeout: 5000 })).stdout);
  }
  try {
    owner = rawOwner(descriptor.executable, work, env); await owner.initialize();
    peer = createArchiveAppServer({ codexHome: home, python: options.python, timeoutMs: TIMEOUT, deps: {
      resolveExecutable: async () => descriptor,
      spawn(executable, args, settings) {
        peerChild = spawn(executable, args, { ...settings, cwd: work, env });
        peerExit = new Promise(resolve => { peerChild.once('exit', resolve); peerChild.once('error', resolve); });
        observeOwnedChild(peerChild, { onNativeError: error => nativeErrors.push({ nativeCode: error.code, message: redact(error.message) }) });
        return peerChild;
      }
    } });
    await peer.start();
    const started = await owner.request('thread/start', { cwd: work, approvalPolicy: 'never', sandbox: 'read-only',
      ephemeral: false, historyMode: 'paginated', threadSource: 'user' });
    const threadId = started?.thread?.id; assert(UUID.test(threadId || ''), 'The owner did not create the synthetic thread.');
    step('owner-created-persistent-thread', { threadId, status: started.thread.status?.type });
    try { const metadata = await peer.readMetadata(threadId); step('peer-read-before-materialization', { available: true, status: metadata.status }); }
    catch (error) { step('peer-read-before-materialization', { available: false, code: error.code, details: error.details, native: nativeErrors.at(-1) }); }
    await owner.request('thread/archive', { threadId }); assert.equal(await storedFlag(threadId), true);
    step('owner-materialized-and-archived-fresh-thread', { archived: true });
    await owner.request('thread/unarchive', { threadId }); assert.equal(await storedFlag(threadId), false);
    const resumed = await owner.request('thread/resume', { threadId, includeTurns: false });
    assert.equal(resumed.thread.id, threadId);
    const loaded = await owner.request('thread/loaded/list', {});
    assert(JSON.stringify(loaded).includes(threadId), 'The owner must hold the loaded synthetic writer.');
    step('owner-resumed-persisted-thread', { loaded: true, archived: false });
    const peerRead = await peer.readMetadata(threadId); assert.equal(peerRead.id, threadId);
    step('peer-read-owned-persisted-thread', { status: peerRead.status });
    let blocked;
    try { await peer.archive(threadId, { confirmedIds: [threadId] }); }
    catch (error) { blocked = error; }
    assert(blocked, 'The separate server unexpectedly archived an owner-held writer.');
    assert.equal(blocked.code, 'APP_SERVER_RPC_FAILED'); assert.equal(blocked.details?.reason, 'active_writer');
    assert.equal(blocked.details?.method, 'thread/archive'); assert.equal(await storedFlag(threadId), false);
    step('separate-adapter-blocked-by-active-writer', { code: blocked.code, details: blocked.details,
      native: nativeErrors.at(-1), archived: false, archiveRequests: peer.inspect().counts.archive });
    assert.equal(peer.inspect().counts.archive, 1, 'Archive writes must not be retried.');
    sameOwner = createArchiveAppServer({ codexHome: home, python: options.python,
      desktopRequest: (method, id) => {
        assert(['thread/read', 'thread/archive'].includes(method)); assert.equal(id, threadId);
        return owner.request(method, method === 'thread/read' ? { threadId: id, includeTurns: false } : { threadId: id });
      }, deps: { spawn() { throw Error('The same-owner route must not start a separate server.'); } } });
    const archived = await sameOwner.archive(threadId, { confirmedIds: [threadId] });
    assert.equal(archived.submitted, true); assert.equal(await storedFlag(threadId), true);
    assert.equal(sameOwner.inspect().childProcessId, null); assert.equal(sameOwner.inspect().counts.archive, 1);
    step('same-owner-adapter-success', { archived: true, submitted: archived.submitted, separateServerStarted: false });
    assert(!owner.methods.some(method => method.startsWith('turn/')), 'The E2E must never invoke a model turn.');
    for (const name of ['auth.json', 'credentials.json']) {
      try { await fs.stat(path.join(home, name)); throw Error('Unexpected account file in the synthetic home.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    result.passed = true;
  } catch (error) {
    result.error = { message: redact(error.message), ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) };
  } finally {
    sameOwner?.dispose(); peer?.dispose();
    if (peerExit) {
      const timer = setTimeout(() => peerChild?.kill(), 2000); await peerExit; clearTimeout(timer);
    }
    await owner?.close(); result.ownedServicesExited = (!peerChild || peerChild.exitCode != null || peerChild.signalCode != null) &&
      (!owner || owner.child.exitCode != null || owner.child.signalCode != null);
    if (!result.ownedServicesExited) result.passed = false;
    await fs.writeFile(path.join(outputDir, 'results.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  }
  return result;
}

(async () => {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log('Optional Windows official-software E2E. No daily profile or model turn.\n' +
      'node scripts/test-archive-writer.cjs --output-dir <new directory> [--python <executable>]\n' +
      'Creates only synthetic homes under that new directory; leaves results and fixtures for inspection.');
    return;
  }
  const result = await execute(options); console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
