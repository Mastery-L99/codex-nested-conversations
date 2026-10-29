'use strict';

// Event-driven invalidation for our generated relation manifest. This module
// watches file names only; it never opens, changes, or copies a Codex database.
const fs = require('node:fs');
const path = require('node:path');
const {execFile} = require('node:child_process');

const DATABASE_FILES = Object.freeze([
  'thread_history_1.sqlite', 'thread_history_1.sqlite-wal',
  'state_5.sqlite', 'state_5.sqlite-wal'
]);
const DATABASE_NAMES = new Set(DATABASE_FILES);

function errorText(error) {
  return String(error?.message || error).slice(0, 1600);
}

function runPythonSync(options, signal) {
  return new Promise((resolve, reject) => {
    execFile(options.python, ['-X','utf8',options.scriptPath, '--codex-home', options.codexHome,
      '--output', options.outputPath], {
      windowsHide: true, timeout: options.syncTimeoutMs, maxBuffer: 256 * 1024,
      encoding: 'utf8', signal
    }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(JSON.parse(stdout.trim().replace(/^\uFEFF/, '')));
      } catch (parseError) {
        reject(new Error('Relation sync returned invalid JSON: ' + parseError.message));
      }
    });
  });
}

/**
 * createEventIndex({codexHome, python, scriptPath?, outputPath?, onSync?, onError?})
 *
 * start() attaches the watcher BEFORE queuing the first snapshot and returns
 * this controller. Await flush() to wait for queued work (including bounded
 * error retries); flush() on a clean controller performs no SQL.
 *
 * markDirty(reason, {source:'native'|'ui'|'manual', urgent:false}) schedules a
 * structural update. Native/UI events take precedence over the filesystem
 * backup: later token writes cannot postpone them. Filesystem events use a
 * trailing quiet window, WITHOUT a forced maximum wait by default, so an
 * actively streaming WAL does not cause a periodic full rebuild. The host
 * should forward only creation/archive/membership events, not token updates.
 *
 * watchMode:'nativeOnly' disables the filesystem backup. fsMaxWaitMs can bound
 * the backup delay if explicitly wanted; 0 (default) waits for a quiet window.
 * await pause() freezes new work and waits for an already-running sync to
 * finish. While paused, dirty events and file metadata callbacks still accrue.
 * resume() queues one immediate snapshot, even if no event was observed.
 * onFilesystemEvent({filename,eventType}) receives only relevant file metadata
 * and can observe a commit while manifest rebuilding is paused.
 *
 * No timer re-arms itself after success or retry exhaustion. stop() closes
 * watchers, cancels timers, and aborts this module's own sync child process.
 *
 * sync({signal, generation, reasons}) and watch are injectable for isolated
 * tests. They are never needed by the normal Python-backed integration.
 */
function createEventIndex(config) {
  if (!config || typeof config.codexHome !== 'string' || !config.codexHome) {
    throw new TypeError('codexHome is required');
  }
  if (typeof config.sync !== 'function' && !config.python) {
    throw new TypeError('python is required unless a sync function is supplied');
  }
  const options = {
    codexHome: path.resolve(config.codexHome), python: config.python,
    scriptPath: config.scriptPath || path.join(__dirname, 'sync-relations.py'),
    outputPath: config.outputPath || path.join(__dirname, 'relations.json'),
    syncTimeoutMs: config.syncTimeoutMs ?? 15000,
    debounceMs: config.debounceMs ?? 45,
    maxWaitMs: config.maxWaitMs ?? 200,
    fsDebounceMs: config.fsDebounceMs ?? 1200,
    fsMaxWaitMs: config.fsMaxWaitMs ?? 0,
    retryDelaysMs: config.retryDelaysMs || [100, 350, 1000],
    watchRetryDelaysMs: config.watchRetryDelaysMs || [100, 500, 1500],
    watchMode: config.watchMode || 'backup'
  };
  if (!['backup', 'nativeOnly'].includes(options.watchMode)) {
    throw new TypeError('watchMode must be backup or nativeOnly');
  }
  for (const key of ['syncTimeoutMs', 'debounceMs', 'maxWaitMs', 'fsDebounceMs', 'fsMaxWaitMs']) {
    if (!Number.isFinite(options[key]) || options[key] < 0) throw new TypeError(key + ' must be nonnegative');
  }
  for (const key of ['retryDelaysMs', 'watchRetryDelaysMs']) {
    if (!Array.isArray(options[key]) || options[key].some(ms => !Number.isFinite(ms) || ms < 0)) {
      throw new TypeError(key + ' must contain nonnegative delays');
    }
  }
  const sync = config.sync || ((context) => runPythonSync(options, context.signal));
  const watch = config.watch || fs.watch;
  const now = config.now || Date.now;
  let started = false, stopped = false, paused = false, watcher = null, workTimer = null, watchTimer = null;
  let dirty = false, inFlight = false, controller = null;
  let generation = 0, syncedGeneration = 0, priority = -1, deadline = 0;
  let firstDirtyAt = 0, firstStructuralAt = 0, retryAttempt = 0, watchRetryAttempt = 0;
  let reasons = new Set(), waiters = [];
  let lastError = null, lastCallbackError = null, lastWatchError = null, retryExhausted = false;
  let lastStartedAt = null, lastSucceededAt = null, lastResult = null, lastReasons = [];
  const counts = {invalidations:0, fileEvents:0, ignoredFileEvents:0, coalescedEvents:0,
    runs:0, successes:0, failures:0, retriesScheduled:0, watcherErrors:0,
    watcherReconnects:0, callbackFailures:0};

  function inspect() {
    return {mode:'event_driven', watchMode:options.watchMode, started, stopped, paused,
      watching:Boolean(watcher), pending:dirty, inFlight, generation, syncedGeneration,
      timerScheduled:Boolean(workTimer), watchRetryScheduled:Boolean(watchTimer),
      retryAttempt, retryExhausted, lastStartedAt, lastSucceededAt,
      lastReasons:[...lastReasons], pendingReasons:[...reasons], lastResult,
      lastError, lastWatchError, lastCallbackError, counts:{...counts}};
  }
  function notifyError(error, phase, extra = {}) {
    if (stopped || typeof config.onError !== 'function') return;
    Promise.resolve().then(() => config.onError(error, {phase, ...extra})).catch(callbackError => {
      counts.callbackFailures++;
      lastCallbackError = errorText(callbackError);
    });
  }
  function settleWaiters() {
    if (!stopped && (inFlight || (!paused && (dirty || workTimer)))) return;
    const pending = waiters; waiters = [];
    for (const resolve of pending) resolve(inspect());
  }
  function cancelWorkTimer() {
    if (workTimer) clearTimeout(workTimer);
    workTimer = null;
  }
  function scheduleWork() {
    if (!started || stopped || paused || !dirty || inFlight) return;
    cancelWorkTimer();
    workTimer = setTimeout(() => {workTimer = null; void execute();}, Math.max(0, deadline - now()));
  }
  function markDirty(reason = 'external', {source = 'manual', urgent = false} = {}) {
    if (!started || stopped) return false;
    const time = now(), filesystem = source === 'filesystem';
    const previousPriority = priority;
    counts.invalidations++;
    if (dirty || inFlight) counts.coalescedEvents++;
    generation++;
    retryAttempt = 0;
    retryExhausted = false;
    if (!dirty) {firstDirtyAt = time; firstStructuralAt = 0; priority = -1;}
    dirty = true;
    reasons.add(String(reason).slice(0, 128));
    if (filesystem) {
      if (priority < 1) {
        priority = 0;
        deadline = time + options.fsDebounceMs;
        if (options.fsMaxWaitMs > 0) deadline = Math.min(deadline, firstDirtyAt + options.fsMaxWaitMs);
      }
    } else if (urgent) {
      priority = 2;
      deadline = time;
    } else if (priority < 2) {
      if (previousPriority < 1 || !firstStructuralAt) firstStructuralAt = time;
      priority = 1;
      deadline = Math.min(time + options.debounceMs, firstStructuralAt + options.maxWaitMs);
    }
    scheduleWork();
    return true;
  }
  async function execute() {
    if (stopped || paused || !dirty || inFlight) return;
    const targetGeneration = generation, attemptReasons = [...reasons];
    const attemptPriority = priority, attemptRetry = retryAttempt;
    dirty = false; reasons = new Set(); priority = -1; firstDirtyAt = 0; firstStructuralAt = 0;
    inFlight = true;
    controller = new AbortController();
    counts.runs++;
    lastStartedAt = new Date(now()).toISOString();
    lastReasons = attemptReasons;
    let succeeded = false;
    try {
      const result = await sync({signal:controller.signal, generation:targetGeneration, reasons:attemptReasons});
      if (stopped) return;
      succeeded = true;
      counts.successes++;
      syncedGeneration = targetGeneration;
      lastSucceededAt = new Date(now()).toISOString();
      lastError = null; retryExhausted = false;
      lastResult = result && typeof result === 'object' ? Object.fromEntries(
        ['groups','children','changed','written','eligibleCandidateChats'].filter(key => key in result)
          .map(key => [key, result[key]])) : null;
      if (typeof config.onSync === 'function') {
        try {await config.onSync(result, {generation:targetGeneration, reasons:attemptReasons});}
        catch (error) {
          counts.callbackFailures++;
          lastCallbackError = errorText(error);
          notifyError(error, 'onSync', {generation:targetGeneration});
        }
      }
    } catch (error) {
      if (stopped) return;
      counts.failures++;
      lastError = errorText(error);
      notifyError(error, 'sync', {generation:targetGeneration, attempt:attemptRetry + 1});
      if (generation > targetGeneration) {
        // A newer real event owns a fresh bounded attempt budget.
        retryAttempt = 0;
      } else if (attemptRetry < options.retryDelaysMs.length) {
        retryAttempt = attemptRetry + 1;
        counts.retriesScheduled++;
        dirty = true; reasons = new Set(attemptReasons);
        priority = attemptPriority;
        firstDirtyAt = now(); firstStructuralAt = priority > 0 ? firstDirtyAt : 0;
        deadline = now() + options.retryDelaysMs[attemptRetry];
      } else {
        retryExhausted = true;
      }
    } finally {
      inFlight = false; controller = null;
      if (succeeded) retryAttempt = 0;
      if (!stopped && dirty) scheduleWork();
      settleWaiters();
    }
  }
  function closeWatcher() {
    const old = watcher; watcher = null;
    if (old) {try {old.close();} catch { /* The handle can already be closed after error. */ }}
  }
  function watchFailed(error) {
    if (stopped) return;
    counts.watcherErrors++;
    lastWatchError = errorText(error);
    closeWatcher();
    notifyError(error, 'watch');
    if (watchTimer || watchRetryAttempt >= options.watchRetryDelaysMs.length) return;
    const delay = options.watchRetryDelaysMs[watchRetryAttempt++];
    watchTimer = setTimeout(() => {
      watchTimer = null;
      if (!stopped) {counts.watcherReconnects++; attachWatcher();}
    }, delay);
  }
  function attachWatcher() {
    if (stopped || watcher || options.watchMode === 'nativeOnly') return;
    try {
      const reconnecting = watchRetryAttempt > 0;
      // Watching the parent directory survives DB/WAL file replacement and
      // notices a newly created WAL; a watch on a single inode would not.
      const handle = watch(options.codexHome, {persistent:true}, (eventType, filename) => {
        if (stopped) return;
        const name = filename == null ? null : path.basename(String(filename)).toLowerCase();
        if (name != null && !DATABASE_NAMES.has(name)) {counts.ignoredFileEvents++; return;}
        counts.fileEvents++;
        if (typeof config.onFilesystemEvent === 'function') {
          // No file contents, user text, credentials, or database handles cross
          // this boundary. In particular this callback still works in pause().
          Promise.resolve().then(() => {
            if (!stopped) return config.onFilesystemEvent({filename:name, eventType});
          }).catch(error => {
            counts.callbackFailures++;
            lastCallbackError = errorText(error);
            notifyError(error, 'onFilesystemEvent');
          });
        }
        markDirty('filesystem:' + (name || 'unknown'), {source:'filesystem'});
      });
      watcher = handle;
      handle.on?.('error', error => {if (watcher === handle) watchFailed(error);});
      lastWatchError = null;
      watchRetryAttempt = 0;
      if (reconnecting) markDirty('filesystem:watcher-reconnected', {source:'filesystem'});
    } catch (error) {watchFailed(error);}
  }
  function start() {
    if (started || stopped) return api;
    started = true;
    attachWatcher();
    markDirty('startup', {source:'startup', urgent:true});
    return api;
  }
  function flush() {
    if (!started || stopped || (!dirty && !inFlight && !workTimer)) return Promise.resolve(inspect());
    if (paused && !inFlight) return Promise.resolve(inspect());
    const done = new Promise(resolve => waiters.push(resolve));
    if (dirty && !inFlight) {priority = 2; deadline = now(); scheduleWork();}
    return done;
  }
  function pause() {
    paused = true;
    cancelWorkTimer();
    if (!inFlight || stopped) return Promise.resolve(inspect());
    return new Promise(resolve => waiters.push(resolve));
  }
  function resume() {
    if (!started || stopped || !paused) return false;
    paused = false;
    return markDirty('resume', {source:'manual', urgent:true});
  }
  function stop() {
    if (stopped) return inspect();
    stopped = true; dirty = false; reasons.clear();
    cancelWorkTimer();
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = null;
    closeWatcher();
    controller?.abort();
    settleWaiters();
    return inspect();
  }
  const api = {start, markDirty, flush, pause, resume, stop, inspect};
  return api;
}

module.exports = {createEventIndex, DATABASE_FILES};
