'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
const FAMILY = 'OpenAI.Codex_2p2nqsd0c76g0';
function failure(code, message) { return Object.assign(new Error(message), {code}); }

function parseActivePort(text) {
  const lines = String(text).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length !== 2 || !/^\d{1,5}$/.test(lines[0]) ||
      !/^\/devtools\/browser\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(lines[1])) {
    throw failure('INVALID_ENDPOINT_FILE', 'The app connection file is invalid');
  }
  const port = Number(lines[0]);
  if (port < 1 || port > 65535) throw failure('INVALID_ENDPOINT_FILE', 'The app connection port is invalid');
  return {port, browserPath: lines[1]};
}

function validateOwner(record, port) {
  if (!record || record.family !== FAMILY || typeof record.expectedExe !== 'string' ||
      !Number.isInteger(record.appProcessId) || record.appProcessId <= 0 || record.mainCount !== 1 ||
      !Array.isArray(record.listeners) || !record.listeners.length ||
      record.listeners.some(row => row.port !== port || !['127.0.0.1', '::1'].includes(row.address) ||
        row.processId !== record.appProcessId || typeof row.executable !== 'string' ||
        row.executable.toLowerCase() !== record.expectedExe.toLowerCase() || row.isChild !== false)) {
    throw failure('UNSAFE_ENDPOINT', 'The local connection is not owned exclusively by the official app');
  }
  return {packageVersion: record.packageVersion, appProcessId: record.appProcessId, startTimeMs: record.startTimeMs};
}

async function probe(port) {
  const script = String.raw`$ErrorActionPreference='Stop'
$pkgs=@(Get-AppxPackage -Name OpenAI.Codex)
if($pkgs.Count -ne 1){throw 'Official package identity is ambiguous'}
$exe=Join-Path $pkgs[0].InstallLocation 'app\ChatGPT.exe'
$main=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object {$_.ExecutablePath -eq $exe -and $_.CommandLine -notmatch '(?:^|\s)--type='})
$port=[int]$env:CNCC_PROBE_PORT
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
$rows=@(foreach($listener in $listeners){
  $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listener.OwningProcess)
  @{port=[int]$listener.LocalPort;address=$listener.LocalAddress;processId=[int]$listener.OwningProcess;executable=$owner.ExecutablePath;isChild=($owner.CommandLine -match '(?:^|\s)--type=')}
})
$id=if($main.Count -eq 1){[int]$main[0].ProcessId}else{0}
$start=if($main.Count -eq 1){([DateTimeOffset]$main[0].CreationDate).ToUnixTimeMilliseconds()}else{0}
@{family=$pkgs[0].PackageFamilyName;packageVersion=[string]$pkgs[0].Version;expectedExe=$exe;mainCount=$main.Count;appProcessId=$id;startTimeMs=$start;listeners=$rows}|ConvertTo-Json -Depth 5 -Compress`;
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {windowsHide:true, timeout:15000, maxBuffer:128*1024, env:{...process.env,CNCC_PROBE_PORT:String(port)}});
  const record = JSON.parse(result.stdout.trim());
  if (!record.listeners?.length) throw failure('NO_ENDPOINT', 'The official app connection is not active');
  return validateOwner(record, port);
}

async function discoverConnection({profileDir, mode = process.env.CNCC_CONNECTION_MODE || 'legacy'} = {}) {
  if (!['legacy', 'auto', 'profile_approval'].includes(mode)) throw failure('INVALID_MODE', 'Unsupported connection mode');
  if (mode !== 'profile_approval') {
    try {
      return {...await probe(9347), endpointUrl:'http://127.0.0.1:9347', transport:'legacy'};
    } catch (error) {
      if (mode === 'legacy' || error.code !== 'NO_ENDPOINT') throw error;
    }
  }
  const dir = profileDir || process.env.CNCC_PROFILE_DIR ||
    (process.env.APPDATA && path.join(process.env.APPDATA, 'Codex', 'web', 'Codex'));
  if (!dir || !path.isAbsolute(dir)) throw failure('NO_ENDPOINT', 'The official profile connection is unavailable');
  const file = path.join(dir, 'DevToolsActivePort');
  let value, stat;
  try { [value, stat] = await Promise.all([fs.readFile(file,'utf8'), fs.stat(file)]); }
  catch (error) { if (error.code === 'ENOENT') throw failure('NO_ENDPOINT', 'The app has no active connection file'); throw error; }
  const endpoint = parseActivePort(value), owner = await probe(endpoint.port);
  if (!Number.isFinite(owner.startTimeMs) || stat.mtimeMs < owner.startTimeMs - 2000) {
    throw failure('STALE_ENDPOINT', 'The app connection file belongs to an earlier session');
  }
  // Discovery alone does not grant permission. Current Owl builds can reject
  // this approval-only endpoint; callers must report that failure, never claim
  // installation success merely because a socket is listening.
  return {...owner, endpointUrl:`ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`, transport:'profile_approval'};
}
module.exports = {discoverConnection, parseActivePort, validateOwner};
