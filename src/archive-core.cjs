'use strict';
// Shared archive orchestration. No DOM, native menu, application process, or
// database access belongs here; a caller supplies a fresh manifest and provider.
const { createHash, randomUUID } = require('node:crypto');

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_CHATS = 256;
const MAX_TRAVERSAL = 16384;
const USER_SOURCES = new Set(['user', 'agent_created_thread', 'agent_forked_thread', 'voice_chat', 'realtime_voice']);

class ArchiveCoreError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'ArchiveCoreError'; this.code = code; this.details = details;
  }
}
function error(code, message, details) { return new ArchiveCoreError(code, message, details); }
function ident(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw error('invalid_identity', 'A canonical chat UUID is required');
  return value.toLowerCase();
}
function frozen(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function sourceValue(chat) { return chat.threadSource ?? chat.thread_source ?? null; }
function classify(chat) {
  if (!chat || typeof chat !== 'object' || typeof chat.id !== 'string' || !UUID.test(chat.id)) return 'invalid_identity';
  if (chat.kind !== 'codex') return 'unsupported_kind';
  if (chat.hostId !== 'local') return 'unsupported_host';
  if (chat.archived === true || chat.archived === 1) return 'archived';
  if (typeof chat.title !== 'string') return 'invalid_metadata';
  if (chat.agentPath || chat.agent_path) return 'system_or_subagent';
  const threadSource = sourceValue(chat);
  if (threadSource === 'subagent' || threadSource === 'automation') return 'system_or_subagent';
  let runtimeSource = chat.source;
  if (runtimeSource === 'exec') return 'execution_record';
  if (typeof runtimeSource === 'string') { try { runtimeSource = JSON.parse(runtimeSource); } catch { runtimeSource = null; } }
  if (runtimeSource && typeof runtimeSource === 'object' && Object.hasOwn(runtimeSource, 'subagent')) return 'system_or_subagent';
  if (threadSource != null) return USER_SOURCES.has(threadSource) ? 'eligible' : 'unknown_source';
  // Upstream may provide its explicit, read-only source-classification result.
  // Missing evidence is never silently upgraded to an ordinary user chat.
  return chat.eligibility === 'eligible' ? 'eligible' : 'unknown_source';
}
function safeTimestamp(value) { return Number.isFinite(value) && value > 0 ? value : null; }
function metadata(chat) {
  return { id: ident(chat.id), title: chat.title, kind: 'codex', hostId: 'local',
    threadSource: sourceValue(chat), eligibility: 'eligible',
    createdAtMs: safeTimestamp(chat.createdAtMs), updatedAtMs: safeTimestamp(chat.updatedAtMs) };
}
function indexManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.catalog) || !Array.isArray(manifest.groups)) {
    throw error('invalid_manifest', 'A version 1 manifest with an authoritative catalog and groups is required');
  }
  const byId = new Map(), excluded = new Map(), children = new Map(), rejectedEdges = new Map(), classifications = new Map();
  for (const chat of manifest.catalog) {
    const category = classify(chat);
    if (chat?.kind === 'codex' && chat.hostId === 'local' && typeof chat.id === 'string' && UUID.test(chat.id)) {
      const key = ident(chat.id), previous = classifications.get(key);
      if (previous !== undefined && previous !== category) throw error('conflicting_catalog', 'The same UUID has conflicting eligibility records', {id:key});
      classifications.set(key,category);
    }
    if (category !== 'eligible') {
      if (typeof chat?.id === 'string' && UUID.test(chat.id)) excluded.set(ident(chat.id), category);
      continue;
    }
    const value = metadata(chat), old = byId.get(value.id);
    if (old && JSON.stringify(old) !== JSON.stringify(value)) {
      throw error('conflicting_catalog', 'The same local UUID has conflicting catalog metadata', { id: value.id });
    }
    byId.set(value.id, value);
  }
  for (const group of manifest.groups) {
    const parent = group?.parent;
    if (!parent || parent.kind !== 'codex' || parent.hostId !== 'local' || !UUID.test(parent.id ?? '')) continue;
    const parentId = ident(parent.id);
    if (!byId.has(parentId)) continue;
    if (!Array.isArray(group.children)) throw error('invalid_manifest', 'Relationship children must be an array');
    const next = children.get(parentId) ?? new Set(); children.set(parentId, next);
    for (const child of group.children) {
      const childId = typeof child?.id === 'string' && UUID.test(child.id) ? ident(child.id) : null;
      if (!childId || child.kind !== 'codex' || child.hostId !== 'local' || !byId.has(childId)) {
        const rejected = rejectedEdges.get(parentId) ?? [];
        rejected.push({ id: childId, reason: childId && excluded.get(childId) || 'unresolved_relation' });
        rejectedEdges.set(parentId, rejected); continue;
      }
      next.add(childId);
    }
  }
  return { byId, excluded, children, rejectedEdges };
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function signatureInput(scope) {
  return { operation: 'archive', selectedIds: scope.selectedIds, includeDescendants: scope.includeDescendants,
    maxChats: scope.maxChats, items: scope.items.map(chat => [chat.id, chat.title, chat.createdAtMs, chat.threadSource]),
    edges: scope.edges, excludedRelations: scope.excludedRelations };
}
function createScope(manifest, selectedIds, options = {}) {
  if (!Array.isArray(selectedIds) || !selectedIds.length) throw error('empty_scope', 'Select at least one local chat');
  const roots = [...new Set(selectedIds.map(ident))].sort();
  const maxChats = options.maxChats ?? MAX_CHATS;
  if (!Number.isInteger(maxChats) || maxChats < 1 || maxChats > MAX_CHATS) throw error('invalid_limit', 'The scope limit must be between 1 and 256');
  if (roots.length > maxChats) throw error('scope_limit', 'The selected scope exceeds the archive limit');
  if (options.includeDescendants !== undefined && typeof options.includeDescendants !== 'boolean') throw error('invalid_options', 'includeDescendants must be a boolean');
  const includeDescendants = options.includeDescendants !== false;
  const { byId, excluded, children, rejectedEdges } = indexManifest(manifest);
  for (const id of roots) if (!byId.has(id)) throw error('ineligible_chat', 'A selected UUID is outside the eligible local catalog', { id, reason: excluded.get(id) ?? 'unknown_chat' });
  const rootsSet = new Set(roots), seen = new Set(), visiting = new Set(), ordered = [], dependencyEdges = new Set();
  const selectedBelow = new Map(), excludedRelations = new Map();
  for (const root of roots) {
    if (seen.has(root)) continue;
    const stack = [{ id: root, entered: false, next: [], offset: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (!frame.entered) {
        if (visiting.has(frame.id)) throw error('relationship_cycle', 'A relationship cycle prevents archive planning');
        if (seen.has(frame.id)) { stack.pop(); continue; }
        if (seen.size + visiting.size >= MAX_TRAVERSAL) throw error('traversal_limit', 'The relationship graph is too large to review safely');
        visiting.add(frame.id); frame.entered = true; frame.next = [...(children.get(frame.id) ?? [])].sort();
        for (const rejected of rejectedEdges.get(frame.id) ?? []) {
          if (includeDescendants && rejected.reason === 'unresolved_relation') {
            throw error('unresolved_relation', 'A reachable relationship is missing from the authoritative local catalog', { parentId: frame.id, childId: rejected.id });
          }
          excludedRelations.set(`${frame.id}>${rejected.id ?? '?'}`, { parentId: frame.id, ...rejected });
        }
      }
      if (frame.offset < frame.next.length) {
        const next = frame.next[frame.offset++];
        if (visiting.has(next)) throw error('relationship_cycle', 'A relationship cycle prevents archive planning');
        if (!seen.has(next)) stack.push({ id: next, entered: false, next: [], offset: 0 });
        continue;
      }
      visiting.delete(frame.id); seen.add(frame.id); stack.pop();
      const below = new Set();
      for (const next of frame.next) {
        if (rootsSet.has(next)) below.add(next);
        for (const id of selectedBelow.get(next) ?? []) below.add(id);
        if (includeDescendants) dependencyEdges.add(`${frame.id}>${next}`);
      }
      selectedBelow.set(frame.id, below);
      if (rootsSet.has(frame.id) && !includeDescendants) for (const id of below) dependencyEdges.add(`${frame.id}>${id}`);
      if (includeDescendants || rootsSet.has(frame.id)) {
        ordered.push(byId.get(frame.id));
        if (ordered.length > maxChats) throw error('scope_limit', 'The selected scope and descendants exceed the archive limit');
      }
    }
  }
  const data = { schemaVersion: 1, operation: 'archive', selectedIds: roots, includeDescendants, maxChats,
    items: ordered, edges: [...dependencyEdges].sort(),
    excludedRelations: [...excludedRelations.values()].sort((a, b) => `${a.parentId}>${a.id}`.localeCompare(`${b.parentId}>${b.id}`)),
    warnings: ['manifest_relations_do_not_define_official_implicit_archive_scope'],
    capabilities: { plansVerifiedLocalUserChats: true, controlsOfficialImplicitDescendants: false } };
  data.signature = digest(signatureInput(data));
  // A token binds a confirmation to this review instance. It is not an access
  // credential and does not claim to authenticate the caller.
  data.token = `archive-v1:${randomUUID()}:${data.signature}`;
  return frozen(data);
}
function assessProviderCapabilities(provider) {
  const source = provider?.capabilities ?? {};
  const archiveMayCascade = source.archiveMayCascade === false ? false : source.archiveMayCascade === true ? true : 'unknown';
  const atomicConfirmedScope = source.atomicConfirmedScope === true;
  const risk = archiveMayCascade !== false && !atomicConfirmedScope;
  return frozen({ archiveMayCascade, atomicConfirmedScope,
    confirmedScopePreflight: source.confirmedScopePreflight === true,
    reportsAffectedIds: source.reportsAffectedIds === true,
    requiresExplicitDescendantConsent: source.requiresExplicitDescendantConsent === true || risk,
    nonAtomicScopeRisk: risk,
    warnings: risk ? ['provider_may_archive_implicit_descendants', 'scope_preflight_is_not_an_atomic_archive_condition'] : [] });
}
function checkedScope(scope) {
  if (!scope || scope.schemaVersion !== 1 || scope.operation !== 'archive' || !Array.isArray(scope.selectedIds) || !Array.isArray(scope.items) ||
      !scope.items.length || scope.items.length > MAX_CHATS || !Array.isArray(scope.edges) || !Array.isArray(scope.excludedRelations) ||
      typeof scope.token !== 'string' || typeof scope.signature !== 'string') throw error('invalid_scope', 'An archive scope created by this core is required');
  const ids = scope.items.map(chat => ident(chat.id));
  if (new Set(ids).size !== ids.length || ids.some((id, i) => id !== scope.items[i].id || classify(scope.items[i]) !== 'eligible') ||
      digest(signatureInput(scope)) !== scope.signature || !scope.token.endsWith(`:${scope.signature}`)) throw error('invalid_scope', 'Archive scope integrity check failed');
  return ids;
}
function milliseconds(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < 1 || result > 60000) throw error('invalid_timeout', 'Action timeouts must be between 1 and 60000 milliseconds');
  return result;
}
function serializeError(failure) {
  let details;
  if (failure?.details) { try { details = JSON.parse(JSON.stringify(failure.details)); } catch { /* Non-data provider details are not exposed. */ } }
  return { code: typeof failure?.code === 'string' ? failure.code : 'provider_error',
    message: String(failure?.message ?? failure ?? 'Archive failed').slice(0, 300),
    ...(details ? { details } : {}) };
}
function bounded(call, milliseconds, signal, stage) {
  if (signal?.aborted) return Promise.reject(error('cancelled', 'Archive was cancelled before the next action'));
  const controller = new AbortController();
  let timer, onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => { controller.abort(); reject(error('cancelled', 'Archive was cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(error('action_timeout', `${stage} timed out`, { stage })); }, milliseconds);
  });
  const action = Promise.resolve().then(() => {
    if (controller.signal.aborted || signal?.aborted) throw error('cancelled', 'Archive was cancelled before the next action');
    return call(controller.signal);
  });
  return Promise.race([action, deadline, cancelled]).finally(() => {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
  });
}
async function executeScope(scope, options = {}) {
  const plannedIds = checkedScope(scope);
  // The service binds this auxiliary allowlist to its immutable, displayed
  // review. Background records never become explicit archive request targets.
  // Their source and relationship membership must be freshly checked by the
  // service/provider; this core only enforces identity, scope and readback.
  if (options.reviewedImplicitIds !== undefined && !Array.isArray(options.reviewedImplicitIds)) {
    throw error('invalid_implicit_scope', 'Reviewed implicit record IDs must be an array');
  }
  const rawImplicitIds = options.reviewedImplicitIds ?? [];
  if (plannedIds.length + rawImplicitIds.length > MAX_CHATS || plannedIds.length + rawImplicitIds.length > scope.maxChats) {
    throw error('scope_limit', 'The combined chat and implicit record scope exceeds the archive limit');
  }
  const implicitIds = Object.freeze(Array.from(rawImplicitIds, ident));
  const approved = new Set(plannedIds);
  for (const id of implicitIds) {
    if (approved.has(id)) throw error('invalid_implicit_scope', 'Implicit record IDs must be unique and separate from explicit chat targets', { id });
    approved.add(id);
  }
  if (approved.size > MAX_CHATS || approved.size > scope.maxChats) throw error('scope_limit', 'The combined chat and implicit record scope exceeds the archive limit');
  const approvedIds = Object.freeze([...plannedIds, ...implicitIds]);
  const provider = options.provider, capabilities = assessProviderCapabilities(provider);
  if (typeof options.loadManifest !== 'function' || typeof provider?.archive !== 'function' || typeof provider?.readStatus !== 'function') {
    throw error('invalid_provider', 'A fresh manifest loader and archive/readStatus provider are required');
  }
  const freshTimeoutMs = milliseconds(options.freshTimeoutMs, 17000);
  const archiveTimeoutMs = milliseconds(options.archiveTimeoutMs, 15000);
  const statusTimeoutMs = milliseconds(options.statusTimeoutMs, 8000);
  const attempted = new Set(), submitted = new Set(), confirmed = new Set(), reported = new Set(), outside = new Set(), uncertain = new Set();
  const verifiedImplicit = new Set();
  let currentId = null, stage = 'confirmation', status = 'ready', failure = null;
  function snapshot() {
    return frozen({ status, stage, currentId, token: scope.token, signature: scope.signature,
      selectedIds: [...scope.selectedIds], plannedIds: [...plannedIds], attemptedIds: [...attempted], submittedIds: [...submitted], confirmedIds: [...confirmed],
      reportedAffectedIds: [...reported], outsideScopeIds: [...outside], uncertainIds: [...uncertain],
      reviewedImplicitIds: [...implicitIds], verifiedImplicitIds: [...verifiedImplicit],
      pendingImplicitIds: implicitIds.filter(id => !verifiedImplicit.has(id)),
      unconfirmedIds: [...submitted].filter(id => !confirmed.has(id)),
      unprocessedIds: plannedIds.filter(id => !attempted.has(id) && !confirmed.has(id) && !reported.has(id)),
      pendingIds: plannedIds.filter(id => !confirmed.has(id)),
      capabilities, error: failure ? serializeError(failure) : null });
  }
  async function progress() {
    if (typeof options.onProgress === 'function') await bounded(() => options.onProgress(snapshot()), 5000, options.signal, 'Progress update');
  }
  function recordAffected(result, requireReport = capabilities.reportsAffectedIds) {
    const affected = result?.affectedIds ?? result?.affectedIDs;
    if (affected === undefined) {
      if (requireReport) throw error('invalid_provider_result', 'The archive provider omitted its affected-ID report');
    } else {
      if (!Array.isArray(affected)) throw error('invalid_provider_result', 'Affected chat IDs must be an array');
      for (const raw of affected) {
        const id = ident(raw); reported.add(id); if (!approved.has(id)) outside.add(id);
      }
    }
    // A provider can also discover a concurrent, unapproved spawned ID without
    // claiming it has already archived that ID. Keep that distinction intact.
    if (result?.outsideScopeIds !== undefined) {
      if (!Array.isArray(result.outsideScopeIds)) throw error('invalid_provider_result', 'Outside-scope chat IDs must be an array');
      for (const raw of result.outsideScopeIds) { const id = ident(raw); if (!approved.has(id)) outside.add(id); }
    }
    if (outside.size) throw error('outside_confirmed_scope', 'The provider reported chat IDs outside the confirmed scope; remaining requests were stopped',
      { ids: [...outside], ...(typeof result?.code === 'string' ? { providerCode: result.code } : {}) });
  }
  async function verify(id, implicit = false) {
    stage = implicit ? 'implicit_commit_confirmation' : 'commit_confirmation';
    if (implicit) currentId = id;
    const result = await bounded(signal => provider.readStatus(id, { signal, timeoutMs: statusTimeoutMs }), statusTimeoutMs, options.signal, 'Archive commit confirmation');
    if (result?.affectedIds !== undefined || result?.affectedIDs !== undefined || result?.outsideScopeIds !== undefined) recordAffected(result,false);
    if (result?.id !== undefined && ident(result.id) !== id) throw error('status_identity_mismatch', 'Archive status belongs to a different chat');
    if (result?.archived !== true) throw error(implicit ? 'implicit_archive_not_confirmed' : 'archive_not_confirmed', 'The read-only status check did not confirm archive commit', { id });
    (implicit ? verifiedImplicit : confirmed).add(id); await progress();
  }
  async function verifyReportedImplicit() {
    // A status read may itself report further reviewed IDs. Re-evaluate the
    // finite pending set so each report is independently checked exactly once.
    let id;
    while ((id = implicitIds.find(value => reported.has(value) && !verifiedImplicit.has(value))) !== undefined) await verify(id, true);
  }
  if (options.confirmedToken !== scope.token) { status = 'blocked'; failure = error('confirmation_required', 'Confirm this exact scope token before archive execution'); return snapshot(); }
  if (options.signal?.aborted) { status = 'cancelled'; failure = error('cancelled', 'Archive was cancelled before execution'); return snapshot(); }
  if (capabilities.nonAtomicScopeRisk && options.acceptNonAtomicScopeRisk !== true) {
    status = 'blocked'; failure = error('non_atomic_scope_consent_required', 'The provider may archive implicit descendants and does not offer an atomic confirmed-scope condition'); return snapshot();
  }
  try {
    status = 'running'; stage = 'fresh_scope_validation'; await progress();
    const freshManifest = await bounded(signal => options.loadManifest({ signal }), freshTimeoutMs, options.signal, 'Fresh archive scope read');
    const fresh = createScope(freshManifest, scope.selectedIds, { includeDescendants: scope.includeDescendants, maxChats: scope.maxChats });
    if (fresh.signature !== scope.signature) throw error('scope_changed', 'The reviewed archive scope changed; review it again before submitting any request');
    for (const id of plannedIds) {
      if (options.signal?.aborted) throw error('cancelled', 'Archive was cancelled before the next request');
      currentId = id;
      // If an earlier official call reported another approved ID as affected,
      // verify that ID without issuing a duplicate archive request.
      if (reported.has(id)) { await verify(id); await verifyReportedImplicit(); continue; }
      stage = 'archive_request'; await progress(); attempted.add(id);
      let result;
      try {
        result = await bounded(signal => provider.archive(id, { signal, confirmedIds: [...approvedIds] }), archiveTimeoutMs, options.signal, 'Official archive request');
      } catch (cause) {
        if (cause?.submitted === true) { submitted.add(id); uncertain.add(id); }
        else if (cause?.submitted !== false) uncertain.add(id);
        if (cause?.affectedIds !== undefined || cause?.affectedIDs !== undefined || cause?.outsideScopeIds !== undefined) recordAffected(cause, false);
        throw cause;
      }
      if (result?.submitted === true) submitted.add(id);
      else if (result?.submitted !== false) uncertain.add(id);
      recordAffected(result);
      if (result?.submitted === false && result.alreadyArchived === true) { await verify(id); await verifyReportedImplicit(); continue; }
      if (result?.submitted !== true) throw error('archive_not_submitted', 'The provider did not confirm submission of the archive request', { id });
      await verify(id);
      await verifyReportedImplicit();
    }
    // A successful acknowledgement or affected-ID report is not commit proof.
    // Even records omitted from a provider report need independent readback.
    for (const id of implicitIds) if (!verifiedImplicit.has(id)) await verify(id, true);
    status = 'completed'; stage = 'complete'; currentId = null;
  } catch (cause) {
    status = cause?.code === 'cancelled' ? 'cancelled' : 'stopped'; failure = cause;
  }
  return snapshot();
}

module.exports = { MAX_CHATS, ArchiveCoreError, classify, createScope, executeScope, assessProviderCapabilities };
