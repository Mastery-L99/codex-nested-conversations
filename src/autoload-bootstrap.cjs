'use strict';
// Local MCP lifecycle bootstrap. It never launches, restarts, or closes ChatGPT.
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {StringDecoder} = require('node:string_decoder');
const run = promisify(execFile);
const PROJECT = 'codex-nested-conversations';
const CONFIG_NAME = 'autoload-config.json';
const MAX_JSON_BYTES = 65536;
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'];

function fault(code) { return Object.assign(new Error(code), {code}); }
function absolute(value) {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value) || value.includes('\0')) throw fault('INVALID_PATH');
  return path.resolve(value);
}
function comparable(value) { const result = path.resolve(value); return process.platform === 'win32' ? result.toLowerCase() : result; }
function same(a, b) { return comparable(a) === comparable(b); }
function inside(value, root) { const relative = path.relative(comparable(root), comparable(value)); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
async function noLinks(value) {
  let cursor = absolute(value);
  for (;;) {
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink()) throw fault('REPARSE_PATH');
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
async function readJson(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) throw fault('INVALID_JSON_FILE');
    return JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, ''));
  } finally { await handle.close(); }
}

async function loadConfig(configPath, moduleFilename = __filename) {
  const file = absolute(configPath);
  await noLinks(file);
  const config = await readJson(file);
  if (config?.schemaVersion !== 1 || config.project !== PROJECT || typeof config.enabled !== 'boolean') throw fault('INVALID_CONFIG');
  if (!config.enabled) return {enabled:false};
  const installDir = absolute(config.installDir), dataDir = absolute(config.dataDir);
  if (same(installDir, path.parse(installDir).root) || same(dataDir, path.parse(dataDir).root) || inside(dataDir, installDir) || inside(installDir, dataDir)) throw fault('INVALID_INSTALL_ROOT');
  if (!same(file, path.join(dataDir, CONFIG_NAME)) || !same(moduleFilename, path.join(installDir, 'app', 'autoload-bootstrap.cjs'))) throw fault('CONFIG_IDENTITY_MISMATCH');
  for (const root of [installDir, dataDir]) await noLinks(root);
  const markerFile = path.join(installDir, '.cncc-install.json'), dataMarkerFile = path.join(dataDir, '.cncc-data.json');
  await noLinks(markerFile); await noLinks(dataMarkerFile);
  const marker = await readJson(markerFile), dataMarker = await readJson(dataMarkerFile);
  if (marker?.schemaVersion !== 1 || marker.project !== PROJECT || marker.state !== 'installed' || !same(absolute(marker.installDir), installDir) || !same(absolute(marker.dataDir), dataDir) || dataMarker?.schemaVersion !== 1 || dataMarker.project !== PROJECT) throw fault('INSTALL_IDENTITY_MISMATCH');
  if (marker.runtime?.companionScript !== 'enhance-current.cjs' || !Array.isArray(marker.runtime.files) || !marker.runtime.files.includes('enhance-current.cjs') || !marker.runtime.files.includes('autoload-bootstrap.cjs')) throw fault('INVALID_RUNTIME_MANIFEST');
  const helperScript = path.join(installDir, 'app', 'enhance-current.cjs');
  const node = absolute(marker.node), python = absolute(marker.python);
  if (!/^node(?:\.exe)?$/i.test(path.basename(node)) || !/^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/i.test(path.basename(python))) throw fault('INVALID_RUNTIME_EXECUTABLE');
  for (const entry of [helperScript, node, python]) {
    await noLinks(entry);
    if (!(await fs.stat(entry)).isFile()) throw fault('MISSING_RUNTIME_EXECUTABLE');
  }
  const profileDir = config.profileDir == null ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Codex', 'web', 'Codex') : absolute(config.profileDir);
  const codexHome = config.codexHome == null ? path.join(os.homedir(), '.codex') : absolute(config.codexHome);
  return {enabled:true, installDir, dataDir, helperScript, node, python, profileDir, codexHome, configPath:file};
}

// Windows command-line quoting rules, sufficient to bind the exact executable + script.
function windowsArgv(commandLine) {
  if (typeof commandLine !== 'string') return [];
  const args = []; let i = 0;
  while (i < commandLine.length) {
    while (/\s/.test(commandLine[i] || '') && i < commandLine.length) i++;
    if (i >= commandLine.length) break;
    let value = '', quoted = false;
    while (i < commandLine.length) {
      if (!quoted && /\s/.test(commandLine[i])) break;
      let slashes = 0;
      while (commandLine[i] === '\\') { slashes++; i++; }
      if (commandLine[i] === '"') {
        value += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) { value += '"'; i++; }
        else if (quoted && commandLine[i + 1] === '"') { value += '"'; i += 2; }
        else { quoted = !quoted; i++; }
      } else {
        value += '\\'.repeat(slashes);
        if (i >= commandLine.length || (!quoted && /\s/.test(commandLine[i]))) break;
        value += commandLine[i++];
      }
    }
    if (quoted) return [];
    args.push(value);
    while (i < commandLine.length && /\s/.test(commandLine[i])) i++;
  }
  return args;
}

async function listNodeProcesses() {
  const command = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object @{n='pid';e={$_.ProcessId}},@{n='executable';e={$_.ExecutablePath}},@{n='commandLine';e={$_.CommandLine}}) | ConvertTo-Json -Compress";
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide:true, timeout:5000, maxBuffer:1024 * 1024});
  const parsed = JSON.parse(result.stdout.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

// The OS abandons this short-lived mutex if its holder dies. No persistent lock,
// service, registry entry, or Windows logon task is created.
async function withWindowsMutex(config, callback) {
  if (process.platform !== 'win32') throw fault('UNSUPPORTED_PLATFORM');
  const name = 'Local\\CnccAutoload-' + crypto.createHash('sha256').update(comparable(config.installDir)).digest('hex').slice(0, 32);
  const command = "$ErrorActionPreference='Stop'; $m=New-Object System.Threading.Mutex($false,$env:CNCC_BOOTSTRAP_MUTEX); $held=$false; try { try {$held=$m.WaitOne(0)} catch [System.Threading.AbandonedMutexException] {$held=$true}; if($held){[Console]::Out.WriteLine('{\"acquired\":true}');[Console]::Out.Flush();$null=[Console]::In.ReadLine()}else{[Console]::Out.WriteLine('{\"acquired\":false}')} } finally {if($held){$m.ReleaseMutex()};$m.Dispose()}";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide:true, env:{...process.env, CNCC_BOOTSTRAP_MUTEX:name}, stdio:['pipe', 'pipe', 'ignore']});
  let line = '', releasing = false, lost = false;
  const lostLease = () => { if (!releasing) lost = true; };
  child.on('exit', lostLease);
  try {
    const acquired = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fault('MUTEX_TIMEOUT')), 5000);
      const done = (error, value) => { clearTimeout(timer); child.stdout.removeListener('data', data); child.removeListener('error', fail); child.removeListener('exit', exit); error ? reject(error) : resolve(value); };
      const fail = () => done(fault('MUTEX_FAILED'));
      const exit = () => done(fault('MUTEX_FAILED'));
      const data = chunk => {
        line += chunk.toString('utf8');
        if (line.length > 1024) return fail();
        if (line.includes('\n')) { try { done(null, JSON.parse(line.split('\n')[0]).acquired === true); } catch { fail(); } }
      };
      child.stdout.on('data', data); child.once('error', fail); child.once('exit', exit);
    });
    if (!acquired) return {state:'bootstrap_busy'};
    return await callback({assertHeld() { if (lost || child.exitCode != null) throw fault('MUTEX_LOST'); }});
  } finally {
    releasing = true;
    child.stdin.on('error', () => {}); child.stdin.end('\n');
    const timer = setTimeout(() => child.kill(), 1000); timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }
}

async function spawnHelper(config) {
  const env = {...process.env, CNCC_NODE:config.node, CNCC_PYTHON:config.python,
    CNCC_DATA_DIR:config.dataDir, CNCC_CODEX_HOME:config.codexHome,
    CNCC_PROFILE_DIR:config.profileDir, CNCC_CONNECTION_MODE:'auto'};
  // Discovery is performed by the runtime again; inherited endpoint strings are not authority.
  delete env.CNCC_ENDPOINT_URL; delete env.CNCC_BROWSER_WS_ENDPOINT;
  const child = spawn(config.node, [config.helperScript], {cwd:path.dirname(config.helperScript), env, detached:true, windowsHide:true, stdio:'ignore'});
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(fault('HELPER_SPAWN_FAILED'))); });
  child.unref(); return {pid:child.pid};
}

function createBootstrap(options = {}) {
  const deps = {loadConfig, discoverConnection:args => require('./connection.cjs').discoverConnection(args), listProcesses:listNodeProcesses,
    withLock:withWindowsMutex, spawnHelper, watch:nativeFs.watch, now:Date.now, ...options.deps};
  const configPath = options.configPath ?? process.env.CNCC_AUTOLOAD_CONFIG;
  const logger = options.logger || (event => process.stderr.write('[cncc-autoload] ' + event + '\n'));
  const log = event => { try { logger(event); } catch {} };
  let state = {state:'unconfigured'}, inFlight = null, stopped = false, watcher = null, watcherPath = null, eventTimer = null, pendingEvent = false;
  let generation = 0;
  const inspect = () => ({...state});
  function checkpoint(signal) { if (stopped || signal.aborted) throw fault(stopped ? 'STOPPED' : 'BOOTSTRAP_TIMEOUT'); }
  async function publish(value, config, current) {
    if (stopped || current !== generation) return;
    state = {...value, time:new Date(deps.now()).toISOString()};
    if (!config?.enabled) return;
    const temporary = path.join(config.dataDir, '.autoload-status-' + process.pid + '-' + crypto.randomUUID() + '.tmp');
    try {
      await fs.writeFile(temporary, JSON.stringify(state, null, 2), {flag:'wx'});
      await fs.rename(temporary, path.join(config.dataDir, 'autoload-status.json'));
    } catch { log('status_write_failed'); }
  }
  function endpointEvent(filename) {
    if (stopped || (filename != null && String(filename) !== 'DevToolsActivePort')) return;
    if (inFlight) { pendingEvent = true; return; }
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => { eventTimer = null; void attempt('endpoint_change'); }, 100);
    eventTimer.unref?.();
  }
  function ensureWatcher(config) {
    if (watcherPath === config.profileDir) return;
    watcher?.close(); watcher = null; watcherPath = null;
    try {
      watcher = deps.watch(config.profileDir, {persistent:false}, (_, filename) => endpointEvent(filename));
      watcherPath = config.profileDir;
      watcher.on?.('error', () => { watcher?.close(); watcher = null; watcherPath = null; log('endpoint_watch_unavailable'); });
    } catch { log('endpoint_watch_unavailable'); }
  }
  function attempt(reason = 'initialize') {
    if (stopped) return Promise.resolve(inspect());
    if (inFlight) return inFlight;
    if (!configPath) { state = {state:'unconfigured'}; return Promise.resolve(inspect()); }
    const current = ++generation, controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 15000;
    let config;
    const task = (async () => {
      try {
        config = await deps.loadConfig(configPath, options.moduleFilename || __filename); checkpoint(controller.signal);
        if (!config.enabled) {
          watcher?.close(); watcher = null; watcherPath = null;
          await publish({state:'disabled'}, config, current); return inspect();
        }
        ensureWatcher(config);
        const result = await deps.withLock(config, async lease => {
          const guard = () => { checkpoint(controller.signal); lease?.assertHeld(); };
          guard();
          const connection = await deps.discoverConnection({profileDir:config.profileDir, mode:'auto', signal:controller.signal});
          guard();
          if (!connection || !Number.isSafeInteger(connection.appProcessId) || connection.appProcessId <= 0 || !['legacy', 'profile_approval'].includes(connection.transport)) throw fault('INVALID_CONNECTION_IDENTITY');
          const processes = await deps.listProcesses(); guard();
          if (!Array.isArray(processes) || processes.some(row => !Number.isSafeInteger(row?.pid) || row.pid <= 0 || typeof row.executable !== 'string' || typeof row.commandLine !== 'string')) throw fault('PROCESS_IDENTITY_UNAVAILABLE');
          const companions = processes.flatMap(row => {
            const argv = windowsArgv(row.commandLine);
            const scripts = argv.slice(1).filter(arg => /^enhance-current\.cjs$/i.test(path.basename(arg)));
            if (scripts.length) return [{...row, argv, script:scripts[0]}];
            // An unreadable invocation is never evidence that no helper is running.
            return /enhance-current\.cjs/i.test(row.commandLine) ? [{...row, argv:[], script:null}] : [];
          });
          const exact = companions.filter(row => row.argv.length === 2 && path.isAbsolute(row.script) && same(row.executable, config.node) && same(row.script, config.helperScript));
          if (exact.length === 1 && companions.length === 1) return {state:'reused', helperProcessId:exact[0].pid, appProcessId:connection.appProcessId, transport:connection.transport};
          if (companions.length) return {state:'blocked_other_runtime'};
          guard();
          const child = await deps.spawnHelper(config, connection); guard();
          if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) throw fault('HELPER_SPAWN_FAILED');
          return {state:'starting', helperProcessId:child.pid, appProcessId:connection.appProcessId, transport:connection.transport};
        });
        checkpoint(controller.signal);
        await publish(result, config, current); return inspect();
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'BOOTSTRAP_FAILED';
        const next = stopped ? 'stopped' : controller.signal.aborted ? 'timed_out' : config?.enabled ? 'need_connection' : 'configuration_error';
        await publish({state:next, code}, config, current); log(next + ':' + code); return inspect();
      }
    })();
    let timer;
    const timed = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        void publish({state:'timed_out', code:'BOOTSTRAP_TIMEOUT'}, config, current).finally(() => resolve(inspect()));
      }, timeoutMs);
      timer.unref?.();
    });
    inFlight = Promise.race([task, timed]).finally(() => {
      clearTimeout(timer); inFlight = null;
      if (pendingEvent && !stopped) { pendingEvent = false; endpointEvent('DevToolsActivePort'); }
    });
    return inFlight;
  }
  function stop() { stopped = true; generation++; clearTimeout(eventTimer); watcher?.close(); watcher = null; state = {state:'stopped'}; }
  return {attempt, inspect, stop};
}

function serveStdio({bootstrap = createBootstrap(), input = process.stdin, output = process.stdout, logger = () => {}, maxInputBytes = MAX_JSON_BYTES} = {}) {
  let buffer = '', closed = false; const decoder = new StringDecoder('utf8');
  const send = value => { if (!closed && !output.destroyed) output.write(JSON.stringify({jsonrpc:'2.0', ...value}) + '\n'); };
  const dispatch = request => {
    if (!request || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return send({id:request?.id ?? null, error:{code:-32600, message:'Invalid Request'}});
    const hasId = Object.hasOwn(request, 'id');
    if (hasId && request.id !== null && typeof request.id !== 'string' && typeof request.id !== 'number') return send({id:null, error:{code:-32600, message:'Invalid Request'}});
    if (!hasId) { if (request.method === 'notifications/initialized') void bootstrap.attempt('initialized'); return; }
    let result;
    switch (request.method) {
      case 'initialize':
        if (!request.params || typeof request.params.protocolVersion !== 'string') return send({id:request.id, error:{code:-32602, message:'Invalid initialize parameters'}});
        result = {protocolVersion:PROTOCOLS.includes(request.params.protocolVersion) ? request.params.protocolVersion : '2025-11-25', capabilities:{tools:{}}, serverInfo:{name:PROJECT + '-autoload', version:'0.1.0'}};
        void bootstrap.attempt('initialize'); break;
      case 'ping': result = {}; break;
      case 'tools/list': result = {tools:[]}; break;
      case 'resources/list': result = {resources:[]}; break;
      case 'resources/templates/list': result = {resourceTemplates:[]}; break;
      case 'prompts/list': result = {prompts:[]}; break;
      case 'cncc/status': result = bootstrap.inspect(); break;
      default: return send({id:request.id, error:{code:-32601, message:'Method not found'}});
    }
    send({id:request.id, result});
  };
  const data = chunk => {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.byteLength(buffer) > maxInputBytes && !buffer.includes('\n')) { send({id:null, error:{code:-32700, message:'Input frame too large'}}); close(); return; }
    let index;
    while (!closed && (index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > maxInputBytes) { send({id:null, error:{code:-32700, message:'Input frame too large'}}); continue; }
      try { dispatch(JSON.parse(line)); } catch { send({id:null, error:{code:-32700, message:'Parse error'}}); }
    }
  };
  function close() { if (closed) return; closed = true; input.removeListener('data', data); input.pause?.(); input.unref?.(); bootstrap.stop(); }
  input.on('data', data); input.once('end', close); input.once('error', () => { logger('input_closed'); close(); });
  output.once('error', () => { logger('output_closed'); close(); });
  void bootstrap.attempt('process_start');
  return {close};
}

module.exports = {PROJECT, CONFIG_NAME, loadConfig, windowsArgv, createBootstrap, serveStdio, withWindowsMutex};
if (require.main === module) {
  const server = serveStdio();
  process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
}
