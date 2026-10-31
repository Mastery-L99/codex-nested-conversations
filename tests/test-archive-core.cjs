'use strict';
// Synthetic manifests and providers only; no official app, file, or DB access.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_CHATS, classify, createScope, executeScope, assessProviderCapabilities } = require('../src/archive-core.cjs');
const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const chat = (n, title = `Chat ${n}`, extra = {}) => ({ id: uuid(n), title, kind: 'codex', hostId: 'local',
  threadSource: 'user', createdAtMs: 1793314800000 + n * 1000, updatedAtMs: 1793318400000 + n * 1000, ...extra });
const [parent, child, grandchild, otherParent, solo] = [chat(1), chat(2), chat(3), chat(4), chat(5)];
const manifest = () => ({ schemaVersion: 1, catalog: [parent, child, grandchild, otherParent, solo].map(value => ({ ...value })), groups: [
  { parent: { ...parent }, children: [{ ...child }] },
  { parent: { ...child }, children: [{ ...grandchild }] },
  { parent: { ...otherParent }, children: [{ ...child }] }
] });
function provider(extra = {}) {
  const state = { requests: [], statusReads: [], archived: new Set(), inFlight: 0, maximumInFlight: 0 };
  return {
    state, capabilities: { archiveMayCascade: false, atomicConfirmedScope: true, reportsAffectedIds: true },
    async archive(id, options) {
      state.inFlight++; state.maximumInFlight = Math.max(state.maximumInFlight, state.inFlight);
      state.requests.push({ id, confirmedIds: options.confirmedIds, signal: options.signal });
      await Promise.resolve(); state.archived.add(id); state.inFlight--;
      return { submitted: true, affectedIds: [id] };
    },
    async readStatus(id) { state.statusReads.push(id); return { id, archived: state.archived.has(id) }; },
    ...extra
  };
}
const run = (scope, original, adapter, options = {}) => executeScope(scope, {
  confirmedToken: scope.token, loadManifest: async () => structuredClone(original), provider: adapter, ...options
});
const code = value => failure => failure.code === value;

test('eligibility requires a trusted user-thread source and an exact local Codex UUID', () => {
  for (const source of ['user', 'agent_created_thread', 'agent_forked_thread', 'voice_chat', 'realtime_voice']) {
    assert.equal(classify(chat(1, 'Source', { threadSource: source })), 'eligible', source);
  }
  assert.equal(classify(chat(1, 'Legacy column', { threadSource: undefined, thread_source: 'user' })), 'eligible');
  assert.equal(classify(chat(1, 'Explicit classifier', { threadSource: undefined, eligibility: 'eligible' })), 'eligible');
  for (const [extra, reason] of [
    [{ id: ' prefix-' + parent.id }, 'invalid_identity'],
    [{ id: parent.id + '/suffix' }, 'invalid_identity'],
    [{ id: ' ' + parent.id }, 'invalid_identity'],
    [{ kind: 'chatgpt' }, 'unsupported_kind'],
    [{ hostId: 'remote' }, 'unsupported_host'],
    [{ archived: true }, 'archived'], [{ archived: 1 }, 'archived'],
    [{ title: null }, 'invalid_metadata'],
    [{ agentPath: 'worker' }, 'system_or_subagent'], [{ agent_path: 'worker' }, 'system_or_subagent'],
    [{ threadSource: 'subagent' }, 'system_or_subagent'],
    [{ threadSource: 'automation' }, 'system_or_subagent'],
    [{ source: { subagent: {} } }, 'system_or_subagent'],
    [{ source: JSON.stringify({ subagent: { spawn: {} } }) }, 'system_or_subagent'],
    [{ threadSource: undefined }, 'unknown_source'],
    [{ threadSource: 'app', eligibility: 'eligible' }, 'unknown_source']
  ]) assert.equal(classify({ ...parent, ...extra }), reason, JSON.stringify(extra));
  for (const value of [null, undefined, {}, { id: 1 }]) assert.equal(classify(value), 'invalid_identity');
});

test('catalog metadata is authoritative; relationship copies cannot promote or rename chats', () => {
  const data = manifest();
  data.groups[0].children[0].title = 'Spoofed edge title';
  data.groups[0].children.push(chat(6, 'Only appears in an edge'));
  assert.throws(() => createScope(data, [parent.id]), code('unresolved_relation'));
  data.catalog.push(chat(6, 'Catalog title', { threadSource: 'subagent' }));
  const scope = createScope(data, [parent.id]);
  assert.equal(scope.items.find(value => value.id === child.id).title, child.title);
  assert.deepEqual(scope.items.map(value => value.id), [grandchild.id, child.id, parent.id]);
  assert.deepEqual(scope.excludedRelations, [{ parentId: parent.id, id: uuid(6), reason: 'system_or_subagent' }]);
  assert.throws(() => createScope(data, [uuid(6)]), code('ineligible_chat'));
});

test('unknown relationship targets block expansion and remain outside selected-only scope', () => {
  const data = manifest(); data.groups[0].children.push(chat(6));
  const scope = createScope(data, [parent.id], { includeDescendants: false });
  assert.deepEqual(scope.items.map(value => value.id), [parent.id]);
  assert.equal(scope.excludedRelations[0].reason, 'unresolved_relation');
  assert.throws(() => createScope(data, [uuid(99)]), code('ineligible_chat'));
});

test('scope rejects malformed manifests, limits, options and identities', () => {
  for (const data of [null, {}, { ...manifest(), schemaVersion: 2 }, { ...manifest(), catalog: null }, { ...manifest(), groups: {} }]) {
    assert.throws(() => createScope(data, [parent.id]), code('invalid_manifest'));
  }
  const data = manifest(); data.groups[0].children = null;
  assert.throws(() => createScope(data, [parent.id]), code('invalid_manifest'));
  for (const value of [[], null, 'not-an-array']) assert.throws(() => createScope(manifest(), value), code('empty_scope'));
  for (const value of ['not-a-uuid', parent.id + ' ', undefined, 1]) assert.throws(() => createScope(manifest(), [value]), code('invalid_identity'));
  for (const value of [0, -1, 257, 1.5, '2', NaN]) assert.throws(() => createScope(manifest(), [parent.id], { maxChats: value }), code('invalid_limit'));
  assert.throws(() => createScope(manifest(), [parent.id], { includeDescendants: 'false' }), code('invalid_options'));
});

test('shared descendants, duplicated roots and duplicated edges are planned once, leaves first', () => {
  const data = manifest(); data.groups[0].children.push({ ...child });
  const scope = createScope(data, [otherParent.id, parent.id, child.id, parent.id]);
  assert.deepEqual(scope.selectedIds, [parent.id, child.id, otherParent.id]);
  assert.deepEqual(scope.items.map(value => value.id), [grandchild.id, child.id, parent.id, otherParent.id]);
  assert.equal(scope.edges.length, 3);
  assert.equal(new Set(scope.items.map(value => value.id)).size, scope.items.length);
});

test('selected-only order respects ancestry through unselected intermediate nodes', () => {
  const scope = createScope(manifest(), [parent.id, grandchild.id], { includeDescendants: false });
  assert.deepEqual(scope.items.map(value => value.id), [grandchild.id, parent.id]);
  assert.deepEqual(scope.edges, [parent.id + '>' + grandchild.id]);
  assert.equal(scope.items.some(value => value.id === child.id), false);
});

test('scope detects reachable cycles without recursion and ignores unrelated graph cycles', () => {
  for (const target of [parent, child]) {
    const data = manifest(); data.groups.push({ parent: { ...grandchild }, children: [{ ...target }] });
    assert.throws(() => createScope(data, [parent.id]), code('relationship_cycle'));
    assert.throws(() => createScope(data, [parent.id], { includeDescendants: false }), code('relationship_cycle'));
    assert.deepEqual(createScope(data, [solo.id]).items.map(value => value.id), [solo.id]);
  }
  const data = manifest(); data.groups.push({ parent: { ...solo }, children: [{ ...solo }] });
  assert.throws(() => createScope(data, [solo.id]), code('relationship_cycle'));
});

test('the 256-chat cap includes descendants and cannot be raised by callers', () => {
  const catalog = Array.from({ length: 257 }, (_, offset) => chat(offset + 1));
  const data = { schemaVersion: 1, catalog, groups: [{ parent: catalog[0], children: catalog.slice(1, 256) }] };
  assert.equal(MAX_CHATS, 256);
  assert.equal(createScope(data, [catalog[0].id]).items.length, 256);
  data.groups[0].children.push(catalog[256]);
  assert.throws(() => createScope(data, [catalog[0].id]), code('scope_limit'));
  assert.throws(() => createScope(data, catalog.map(value => value.id)), code('scope_limit'));
  assert.equal(createScope(data, [catalog[0].id], { includeDescendants: false }).items.length, 1);
  assert.throws(() => createScope(manifest(), [parent.id], { maxChats: 2 }), code('scope_limit'));
});

test('identical catalog copies deduplicate; conflicting metadata blocks planning', () => {
  const data = manifest(); data.catalog.push({ ...parent });
  assert.equal(createScope(data, [parent.id]).items.length, 3);
  data.catalog.push({ ...parent, title: 'Different authoritative title' });
  assert.throws(() => createScope(data, [parent.id]), code('conflicting_catalog'));
});

test('conflicting source classification for one UUID fails closed in either catalog order', () => {
  for (const extra of [{ threadSource: 'subagent' }, { archived: true }]) {
    for (const reverse of [false, true]) {
      const records = [{ ...parent }, { ...parent, ...extra }];
      if (reverse) records.reverse();
      assert.throws(() => createScope({ schemaVersion: 1, catalog: records, groups: [] }, [parent.id]),
        failure => ['conflicting_catalog', 'ineligible_chat'].includes(failure.code));
    }
  }
});

test('scopes are deeply immutable, detached from inputs, and bound to a unique review token', () => {
  const data = manifest(), before = structuredClone(data);
  const first = createScope(data, [parent.id]), second = createScope(data, [parent.id]);
  assert.equal(first.signature, second.signature); assert.notEqual(first.token, second.token);
  assert.match(first.signature, /^[a-f0-9]{64}$/);
  assert.match(first.token, /^archive-v1:[0-9a-f-]{36}:[a-f0-9]{64}$/);
  for (const value of [first, first.items, first.items[0], first.selectedIds, first.edges, first.excludedRelations, first.warnings, first.capabilities]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => { first.items[0].title = 'Tamper'; }, TypeError);
  assert.deepEqual(data, before);
  data.catalog[0].title = 'Later external mutation';
  assert.equal(first.items.find(value => value.id === parent.id).title, parent.title);
});

test('review signatures cover meaningful metadata and relations but ignore incidental update time', () => {
  const original = manifest(), scope = createScope(original, [parent.id]);
  for (const change of [
    data => { data.catalog[0].title = 'Renamed'; },
    data => { data.catalog[0].createdAtMs++; },
    data => { data.catalog[0].threadSource = 'voice_chat'; },
    data => { data.groups[0].children = []; }
  ]) {
    const data = structuredClone(original); change(data);
    assert.notEqual(createScope(data, [parent.id]).signature, scope.signature);
  }
  const data = structuredClone(original); data.catalog[0].updatedAtMs++;
  assert.equal(createScope(data, [parent.id]).signature, scope.signature);
});

test('provider capabilities conservatively distinguish preflight from atomic confirmed scope', () => {
  for (const capabilities of [undefined, {}, { archiveMayCascade: true }, { archiveMayCascade: true, confirmedScopePreflight: true }]) {
    const assessment = assessProviderCapabilities({ capabilities });
    assert.equal(assessment.nonAtomicScopeRisk, true);
    assert.equal(assessment.atomicConfirmedScope, false);
    assert.equal(assessment.requiresExplicitDescendantConsent, true);
    assert.ok(assessment.warnings.includes('scope_preflight_is_not_an_atomic_archive_condition'));
    assert.equal(Object.isFrozen(assessment), true);
  }
  assert.equal(assessProviderCapabilities({ capabilities: { archiveMayCascade: false } }).nonAtomicScopeRisk, false);
  assert.equal(assessProviderCapabilities({ capabilities: { archiveMayCascade: true, atomicConfirmedScope: true } }).nonAtomicScopeRisk, false);
});

test('execution requires an intact reviewed scope, exact token and complete provider', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), adapter = provider();
  let reads = 0;
  const result = await run(scope, data, adapter, { confirmedToken: 'wrong', loadManifest: async () => { reads++; return data; } });
  assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'confirmation_required');
  assert.equal(reads, 0); assert.deepEqual(adapter.state.requests, []);
  const changed = structuredClone(scope); changed.items[0].title = 'Tampered';
  await assert.rejects(run(changed, data, adapter), code('invalid_scope'));
  await assert.rejects(run(scope, data, {}), code('invalid_provider'));
  await assert.rejects(run(scope, data, adapter, { archiveTimeoutMs: 0 }), code('invalid_timeout'));
  await assert.rejects(run(scope, data, adapter, { statusTimeoutMs: 60001 }), code('invalid_timeout'));
});

test('unknown or non-atomic cascade providers are blocked before even reading fresh data', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  for (const capabilities of [{}, { archiveMayCascade: true, confirmedScopePreflight: true, reportsAffectedIds: true }]) {
    const adapter = provider({ capabilities }); let reads = 0;
    const result = await run(scope, data, adapter, { loadManifest: async () => { reads++; return data; } });
    assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'non_atomic_scope_consent_required');
    assert.equal(reads, 0); assert.deepEqual(adapter.state.requests, []);
    const accepted = await run(scope, data, adapter, { acceptNonAtomicScopeRisk: true });
    assert.equal(accepted.status, 'completed'); assert.equal(accepted.capabilities.atomicConfirmedScope, false);
  }
});

test('fresh validation precedes sequential archive and independent status reads', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), events = [], adapter = provider();
  const originalArchive = adapter.archive, originalStatus = adapter.readStatus;
  adapter.archive = async (id, options) => { events.push('archive:' + id); return originalArchive(id, options); };
  adapter.readStatus = async id => { events.push('status:' + id); return originalStatus(id); };
  const result = await run(scope, data, adapter, { loadManifest: async ({ signal }) => { assert.ok(signal instanceof AbortSignal); events.push('fresh'); return data; } });
  const ids = [grandchild.id, child.id, parent.id];
  assert.equal(result.status, 'completed'); assert.deepEqual(result.confirmedIds, ids);
  assert.deepEqual(events, ['fresh', ...ids.flatMap(id => ['archive:' + id, 'status:' + id])]);
  assert.equal(adapter.state.maximumInFlight, 1);
  for (const request of adapter.state.requests) {
    assert.deepEqual(request.confirmedIds, ids); assert.ok(request.signal instanceof AbortSignal);
  }
  assert.deepEqual(result.pendingIds, []); assert.deepEqual(result.unprocessedIds, []);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.confirmedIds), true);
});

test('changed titles, relations, eligible source or missing selected chats stop before submitting', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  for (const change of [
    fresh => { fresh.catalog[0].title = 'Renamed after review'; },
    fresh => { fresh.groups[0].children = []; },
    fresh => { fresh.catalog[0].threadSource = 'voice_chat'; },
    fresh => { fresh.catalog[0].threadSource = 'subagent'; },
    fresh => { fresh.catalog = fresh.catalog.filter(value => value.id !== parent.id); }
  ]) {
    const fresh = structuredClone(data); change(fresh); const adapter = provider();
    const result = await run(scope, fresh, adapter);
    assert.equal(result.status, 'stopped'); assert.ok(['scope_changed', 'ineligible_chat'].includes(result.error.code));
    assert.deepEqual(adapter.state.requests, []);
  }
});

test('fresh loader errors and timeouts stop without archive calls', async () => {
  const data = manifest(), scope = createScope(data, [solo.id]);
  for (const [loader, expected] of [
    [async () => { throw Object.assign(new Error('Loader unavailable'), { code: 'loader_down' }); }, 'loader_down'],
    [() => new Promise(() => {}), 'action_timeout']
  ]) {
    const adapter = provider(); const result = await run(scope, data, adapter, { loadManifest: loader, freshTimeoutMs: 5 });
    assert.equal(result.status, 'stopped'); assert.equal(result.error.code, expected); assert.deepEqual(adapter.state.requests, []);
  }
});

test('approved affected chats are status-verified without a duplicate archive request', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  const adapter = provider({ capabilities: { archiveMayCascade: true, atomicConfirmedScope: true, reportsAffectedIds: true } });
  adapter.archive = async (id, options) => {
    adapter.state.requests.push({ id, confirmedIds: options.confirmedIds });
    for (const affected of scope.items) adapter.state.archived.add(affected.id);
    return { submitted: true, affectedIds: scope.items.map(value => value.id) };
  };
  const result = await run(scope, data, adapter);
  assert.equal(result.status, 'completed'); assert.equal(adapter.state.requests.length, 1);
  assert.deepEqual(adapter.state.statusReads, scope.items.map(value => value.id));
  assert.deepEqual(result.submittedIds, [grandchild.id]);
  assert.deepEqual(result.confirmedIds, scope.items.map(value => value.id));
});

test('already-archived responses still require a read-only commit check', async () => {
  const data = manifest(), scope = createScope(data, [solo.id]), adapter = provider();
  adapter.archive = async id => { adapter.state.archived.add(id); return { submitted: false, alreadyArchived: true, affectedIds: [] }; };
  const result = await run(scope, data, adapter);
  assert.equal(result.status, 'completed'); assert.deepEqual(result.submittedIds, []);
  assert.deepEqual(result.confirmedIds, [solo.id]); assert.deepEqual(adapter.state.statusReads, [solo.id]);
});

test('archive submission alone is insufficient when the independent status check is false', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), adapter = provider({ readStatus: async () => ({ archived: false }) });
  const result = await run(scope, data, adapter);
  assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'archive_not_confirmed');
  assert.deepEqual(result.submittedIds, [grandchild.id]); assert.deepEqual(result.confirmedIds, []);
  assert.deepEqual(result.unconfirmedIds, [grandchild.id]); assert.equal(adapter.state.requests.length, 1);
});

test('status identity mismatch and status timeout stop the remaining requests', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  for (const [readStatus, expected] of [
    [async () => ({ id: solo.id, archived: true }), 'status_identity_mismatch'],
    [async () => { throw Object.assign(new Error('Read failed'), { code: 'read_failed' }); }, 'read_failed'],
    [() => new Promise(() => {}), 'action_timeout']
  ]) {
    const adapter = provider({ readStatus }), result = await run(scope, data, adapter, { statusTimeoutMs: 5 });
    assert.equal(result.status, 'stopped'); assert.equal(result.error.code, expected);
    assert.deepEqual(result.unconfirmedIds, [grandchild.id]); assert.equal(adapter.state.requests.length, 1);
  }
});

test('unapproved affected IDs halt the batch and preserve the distinction between affected and discovered IDs', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  for (const resultValue of [
    { submitted: true, affectedIds: [grandchild.id, solo.id] },
    { submitted: true, affectedIds: [grandchild.id], outsideScopeIds: [solo.id] }
  ]) {
    let calls = 0;
    const adapter = provider({ archive: async () => { calls++; return resultValue; } });
    const result = await run(scope, data, adapter);
    assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'outside_confirmed_scope');
    assert.deepEqual(result.outsideScopeIds, [solo.id]); assert.deepEqual(result.reportedAffectedIds, resultValue.affectedIds);
    assert.equal(calls, 1); assert.deepEqual(result.confirmedIds, []);
  }
});

test('outside IDs discovered by a failed archive are reported without implying they were archived', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  const adapter = provider({ archive: async () => { throw Object.assign(new Error('Outside scope'), {
    code: 'IMPLICIT_DESCENDANTS_OUTSIDE_SCOPE', submitted: false, affectedIds: [], outsideScopeIds: [solo.id]
  }); } });
  const result = await run(scope, data, adapter);
  assert.equal(result.error.code, 'outside_confirmed_scope');
  assert.deepEqual(result.outsideScopeIds, [solo.id]); assert.deepEqual(result.reportedAffectedIds, []);
  assert.deepEqual(result.submittedIds, []); assert.deepEqual(result.uncertainIds, []);
});

test('readStatus affected reports are checked against the confirmed scope', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  const adapter = provider({ readStatus: async () => ({ archived: true, affectedIds: [grandchild.id, solo.id] }) });
  const result = await run(scope, data, adapter);
  assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'outside_confirmed_scope');
  assert.deepEqual(result.outsideScopeIds, [solo.id]); assert.equal(adapter.state.requests.length, 1);
});

test('readStatus outside-only reports halt the batch as well', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  const adapter = provider({ readStatus: async () => ({ archived: true, outsideScopeIds: [solo.id] }) });
  const result = await run(scope, data, adapter);
  assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'outside_confirmed_scope');
  assert.deepEqual(result.outsideScopeIds, [solo.id]); assert.equal(adapter.state.requests.length, 1);
});

test('malformed or omitted promised affected reports stop further submission', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  for (const [response, expected] of [
    [{ submitted: true }, 'invalid_provider_result'],
    [{ submitted: true, affectedIds: 'bad' }, 'invalid_provider_result'],
    [{ submitted: true, affectedIds: ['not-a-uuid'] }, 'invalid_identity'],
    [{ submitted: true, affectedIds: [], outsideScopeIds: 'bad' }, 'invalid_provider_result']
  ]) {
    let calls = 0; const adapter = provider({ archive: async () => { calls++; return response; } });
    const result = await run(scope, data, adapter);
    assert.equal(result.status, 'stopped'); assert.equal(result.error.code, expected); assert.equal(calls, 1);
    assert.deepEqual(result.submittedIds, [grandchild.id]); assert.deepEqual(result.confirmedIds, []);
  }
});

test('submission refusals and ambiguous responses retain distinct uncertainty accounting', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  for (const [submitted, uncertain] of [[false, []], [undefined, [grandchild.id]]]) {
    const adapter = provider({ archive: async () => ({ submitted, affectedIds: [] }) });
    const result = await run(scope, data, adapter);
    assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'archive_not_submitted');
    assert.deepEqual(result.attemptedIds, [grandchild.id]); assert.deepEqual(result.submittedIds, []);
    assert.deepEqual(result.uncertainIds, uncertain); assert.deepEqual(result.unprocessedIds, [child.id, parent.id]);
  }
});

test('thrown errors preserve whether the provider did, did not, or may have submitted', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]);
  for (const submitted of [true, false, undefined]) {
    const adapter = provider({ archive: async () => { throw Object.assign(new Error('Archive failed'), { code: 'write_failed', submitted }); } });
    const result = await run(scope, data, adapter);
    assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'write_failed');
    assert.deepEqual(result.submittedIds, submitted === true ? [grandchild.id] : []);
    assert.deepEqual(result.uncertainIds, submitted === false ? [] : [grandchild.id]);
    assert.deepEqual(result.confirmedIds, []);
  }
});

test('archive timeouts are uncertain and never cause an automatic retry', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]); let calls = 0, capturedSignal;
  const adapter = provider({ archive: (_id, { signal }) => { calls++; capturedSignal = signal; return new Promise(() => {}); } });
  const result = await run(scope, data, adapter, { archiveTimeoutMs: 5 });
  assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'action_timeout');
  assert.deepEqual(result.uncertainIds, [grandchild.id]); assert.equal(capturedSignal.aborted, true); assert.equal(calls, 1);
});

test('pre-cancelled runs perform no reads or writes', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), adapter = provider(), controller = new AbortController();
  controller.abort(); let reads = 0;
  const result = await run(scope, data, adapter, { signal: controller.signal, loadManifest: async () => { reads++; return data; } });
  assert.equal(result.status, 'cancelled'); assert.equal(result.error.code, 'cancelled');
  assert.equal(reads, 0); assert.deepEqual(adapter.state.requests, []);
});

test('cancellation after one confirmed commit preserves it and stops before the next chat', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), adapter = provider(), controller = new AbortController();
  const result = await run(scope, data, adapter, { signal: controller.signal,
    onProgress: snapshot => { if (snapshot.confirmedIds.length === 1) controller.abort(); }
  });
  assert.equal(result.status, 'cancelled'); assert.deepEqual(result.confirmedIds, [grandchild.id]);
  assert.equal(adapter.state.requests.length, 1); assert.deepEqual(result.pendingIds, [child.id, parent.id]);
});

test('cancellation during an in-flight archive aborts its signal and records uncertainty', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), controller = new AbortController();
  let calls = 0, capturedSignal;
  const adapter = provider({ archive: (_id, { signal }) => {
    calls++; capturedSignal = signal; queueMicrotask(() => controller.abort()); return new Promise(() => {});
  } });
  const result = await run(scope, data, adapter, { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(capturedSignal.aborted, true);
  assert.deepEqual(result.uncertainIds, [grandchild.id]); assert.equal(calls, 1);
});

test('progress callback failures stop before an unreviewable write', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), adapter = provider();
  const result = await run(scope, data, adapter, { onProgress: snapshot => {
    if (snapshot.stage === 'archive_request') throw Object.assign(new Error('Progress consumer failed'), { code: 'progress_failed' });
  } });
  assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'progress_failed');
  assert.deepEqual(adapter.state.requests, []); assert.deepEqual(result.attemptedIds, []);
});

test('reviewed background IDs extend only the provider allowlist and are individually read back', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), implicit = [uuid(90), uuid(91)], events = [];
  const adapter = provider();
  adapter.archive = async (id, options) => {
    adapter.state.requests.push({ id, confirmedIds: options.confirmedIds }); events.push('archive:' + id);
    adapter.state.archived.add(id); for (const value of implicit) adapter.state.archived.add(value);
    return { submitted: true, affectedIds: [id, ...implicit] };
  };
  adapter.readStatus = async id => { adapter.state.statusReads.push(id); events.push('status:' + id); return { id, archived: adapter.state.archived.has(id) }; };
  const result = await run(scope, data, adapter, { reviewedImplicitIds: Object.freeze([...implicit]) });
  const ordinary = [grandchild.id, child.id, parent.id];
  assert.equal(result.status, 'completed'); assert.deepEqual(result.confirmedIds, ordinary);
  assert.deepEqual(result.plannedIds, ordinary); assert.equal(scope.items.length, 3);
  assert.deepEqual(result.reviewedImplicitIds, implicit); assert.deepEqual(result.verifiedImplicitIds, implicit); assert.deepEqual(result.pendingImplicitIds, []);
  assert.deepEqual(adapter.state.requests.map(value => value.id), ordinary);
  for (const request of adapter.state.requests) assert.deepEqual(request.confirmedIds, [...ordinary, ...implicit]);
  assert.deepEqual(events.slice(0, 4), ['archive:' + grandchild.id, 'status:' + grandchild.id, 'status:' + implicit[0], 'status:' + implicit[1]]);
  for (const value of implicit) assert.equal(adapter.state.statusReads.filter(id => id === value).length, 1);
  assert.equal(Object.isFrozen(result.reviewedImplicitIds), true); assert.equal(Object.isFrozen(result.verifiedImplicitIds), true);
});

test('implicit allowlists reject malformed, duplicate, sparse and explicit-overlap IDs before any action', async () => {
  const data = manifest(), scope = createScope(data, [solo.id]);
  for (const [reviewedImplicitIds, expected] of [
    [null, 'invalid_implicit_scope'], ['not-an-array', 'invalid_implicit_scope'],
    [[null], 'invalid_identity'], [['bad'], 'invalid_identity'], [[uuid(90) + ' '], 'invalid_identity'],
    [Array(1), 'invalid_identity'], [[uuid(90), uuid(90)], 'invalid_implicit_scope'], [[solo.id], 'invalid_implicit_scope']
  ]) {
    const adapter = provider(); let loads = 0;
    await assert.rejects(run(scope, data, adapter, { reviewedImplicitIds, loadManifest: async () => { loads++; return data; } }), code(expected));
    assert.equal(loads, 0); assert.deepEqual(adapter.state.requests, []); assert.deepEqual(adapter.state.statusReads, []);
  }
});

test('the combined ordinary and background scope respects the 256 maximum and any smaller reviewed limit', async () => {
  const data = manifest(), scope = createScope(data, [solo.id]), implicit = Array.from({ length: 255 }, (_, index) => uuid(100 + index));
  const adapter = provider({ readStatus: async id => ({ id, archived: true }) });
  const result = await run(scope, data, adapter, { reviewedImplicitIds: implicit });
  assert.equal(result.status, 'completed'); assert.equal(result.confirmedIds.length, 1); assert.equal(result.verifiedImplicitIds.length, 255);
  assert.equal(adapter.state.requests[0].confirmedIds.length, 256);
  await assert.rejects(run(scope, data, provider(), { reviewedImplicitIds: [...implicit, uuid(999)] }), code('scope_limit'));
  const smaller = createScope(data, [solo.id], { maxChats: 2 });
  await assert.rejects(run(smaller, data, provider(), { reviewedImplicitIds: [uuid(90), uuid(91)] }), code('scope_limit'));
});

test('the implicit allowlist is copied before asynchronous loading and cannot grow through caller or provider mutation', async () => {
  const data = manifest(), scope = createScope(data, [solo.id]), reviewedImplicitIds = [uuid(90)], adapter = provider();
  adapter.archive = async (id, options) => {
    adapter.state.requests.push({ id, confirmedIds: [...options.confirmedIds] });
    options.confirmedIds.push(uuid(92)); return { submitted: true, affectedIds: [id, uuid(90)] };
  };
  adapter.readStatus = async id => ({ id, archived: true });
  const result = await run(scope, data, adapter, { reviewedImplicitIds, loadManifest: async () => { reviewedImplicitIds.push(uuid(91)); return data; } });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.reviewedImplicitIds, [uuid(90)]);
  assert.deepEqual(adapter.state.requests[0].confirmedIds, [solo.id, uuid(90)]);
  assert.deepEqual(result.verifiedImplicitIds, [uuid(90)]);
});

test('an affected-ID report cannot stand in for an implicit commit; ordinary verified progress is retained', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), implicit = uuid(90), adapter = provider();
  adapter.archive = async (id, options) => { adapter.state.requests.push({ id, confirmedIds: options.confirmedIds }); return { submitted: true, affectedIds: [id, implicit] }; };
  adapter.readStatus = async id => { adapter.state.statusReads.push(id); return { id, archived: id !== implicit }; };
  const result = await run(scope, data, adapter, { reviewedImplicitIds: [implicit] });
  assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'implicit_archive_not_confirmed');
  assert.deepEqual(result.confirmedIds, [grandchild.id]); assert.deepEqual(result.pendingIds, [child.id, parent.id]);
  assert.deepEqual(result.verifiedImplicitIds, []); assert.deepEqual(result.pendingImplicitIds, [implicit]);
  assert.deepEqual(result.reportedAffectedIds, [grandchild.id, implicit]); assert.equal(adapter.state.requests.length, 1);
});

test('reviewed implicit records omitted from provider reports are still read back before completion', async () => {
  const data = manifest(), scope = createScope(data, [solo.id]), implicit = [uuid(90), uuid(91)], adapter = provider();
  adapter.readStatus = async id => { adapter.state.statusReads.push(id); return { id, archived: true }; };
  const result = await run(scope, data, adapter, { reviewedImplicitIds: implicit });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.confirmedIds, [solo.id]);
  assert.deepEqual(result.reportedAffectedIds, [solo.id]); assert.deepEqual(result.verifiedImplicitIds, implicit);
  assert.deepEqual(adapter.state.statusReads, [solo.id, ...implicit]); assert.equal(adapter.state.requests.length, 1);
});

test('a successful acknowledgement with an unchanged implicit record stops completion without erasing chat results', async () => {
  const data = manifest(), scope = createScope(data, [solo.id]), implicit = uuid(90), adapter = provider();
  const result = await run(scope, data, adapter, { reviewedImplicitIds: [implicit] });
  assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'implicit_archive_not_confirmed');
  assert.deepEqual(result.confirmedIds, [solo.id]); assert.deepEqual(result.pendingIds, []);
  assert.deepEqual(result.pendingImplicitIds, [implicit]); assert.deepEqual(result.verifiedImplicitIds, []);
  assert.deepEqual(adapter.state.statusReads, [solo.id, implicit]);
});

test('implicit commit identity errors, status failures and timeouts stop later ordinary archive requests', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), implicit = uuid(90);
  for (const [implicitStatus, expected] of [
    [async () => ({ id: uuid(91), archived: true }), 'status_identity_mismatch'],
    [async () => { throw Object.assign(new Error('Synthetic implicit read failed'), { code: 'implicit_read_failed' }); }, 'implicit_read_failed'],
    [async () => ({ archived: 1 }), 'implicit_archive_not_confirmed'],
    [() => new Promise(() => {}), 'action_timeout']
  ]) {
    const adapter = provider();
    adapter.archive = async (id, options) => { adapter.state.requests.push({ id, confirmedIds: options.confirmedIds }); return { submitted: true, affectedIds: [id, implicit] }; };
    adapter.readStatus = id => id === implicit ? implicitStatus() : Promise.resolve({ id, archived: true });
    const result = await run(scope, data, adapter, { reviewedImplicitIds: [implicit], statusTimeoutMs: 5 });
    assert.equal(result.status, 'stopped'); assert.equal(result.error.code, expected);
    assert.deepEqual(result.confirmedIds, [grandchild.id]); assert.deepEqual(result.pendingImplicitIds, [implicit]);
    assert.equal(adapter.state.requests.length, 1);
  }
});

test('unknown affected records remain outside scope even when other implicit records were reviewed', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), implicit = uuid(90), unknown = uuid(91);
  for (const resultValue of [
    { submitted: true, affectedIds: [grandchild.id, implicit, unknown] },
    { submitted: true, affectedIds: [grandchild.id, implicit], outsideScopeIds: [unknown] }
  ]) {
    const adapter = provider(); adapter.archive = async (id, options) => { adapter.state.requests.push({ id, confirmedIds: options.confirmedIds }); return resultValue; };
    const result = await run(scope, data, adapter, { reviewedImplicitIds: [implicit] });
    assert.equal(result.status, 'stopped'); assert.equal(result.error.code, 'outside_confirmed_scope');
    assert.deepEqual(result.outsideScopeIds, [unknown]); assert.deepEqual(result.verifiedImplicitIds, []);
    assert.equal(adapter.state.requests.length, 1); assert.deepEqual(adapter.state.statusReads, []);
  }
});

test('outside records discovered during implicit readback stop the batch and retain ordinary progress', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), implicit = uuid(90), outside = uuid(91), adapter = provider();
  adapter.archive = async (id, options) => { adapter.state.requests.push({ id, confirmedIds: options.confirmedIds }); return { submitted: true, affectedIds: [id, implicit] }; };
  adapter.readStatus = async id => id === implicit ? { id, archived: true, outsideScopeIds: [outside] } : { id, archived: true };
  const result = await run(scope, data, adapter, { reviewedImplicitIds: [implicit] });
  assert.equal(result.error.code, 'outside_confirmed_scope'); assert.deepEqual(result.outsideScopeIds, [outside]);
  assert.deepEqual(result.confirmedIds, [grandchild.id]); assert.deepEqual(result.verifiedImplicitIds, []);
  assert.deepEqual(result.pendingImplicitIds, [implicit]); assert.equal(adapter.state.requests.length, 1);
});

test('cancelling an implicit status read preserves verified ordinary chats and leaves the record pending', async () => {
  const data = manifest(), scope = createScope(data, [parent.id]), implicit = uuid(90), controller = new AbortController(), adapter = provider();
  adapter.archive = async (id, options) => { adapter.state.requests.push({ id, confirmedIds: options.confirmedIds }); return { submitted: true, affectedIds: [id, implicit] }; };
  adapter.readStatus = (id, { signal }) => {
    if (id !== implicit) return Promise.resolve({ id, archived: true });
    queueMicrotask(() => controller.abort()); return new Promise(() => {});
  };
  const result = await run(scope, data, adapter, { reviewedImplicitIds: [implicit], signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.deepEqual(result.confirmedIds, [grandchild.id]);
  assert.deepEqual(result.pendingImplicitIds, [implicit]); assert.equal(adapter.state.requests.length, 1);
});

test('reviewing implicit records does not remove non-atomic provider consent or exact-token requirements', async () => {
  const data = manifest(), scope = createScope(data, [solo.id]), adapter = provider({ capabilities: { archiveMayCascade: true, atomicConfirmedScope: false } });
  const result = await run(scope, data, adapter, { reviewedImplicitIds: [uuid(90)] });
  assert.equal(result.status, 'blocked'); assert.equal(result.error.code, 'non_atomic_scope_consent_required');
  assert.deepEqual(result.pendingImplicitIds, [uuid(90)]); assert.deepEqual(adapter.state.requests, []);
  const other = await run(scope, data, adapter, { reviewedImplicitIds: [uuid(90)], confirmedToken: 'wrong', acceptNonAtomicScopeRisk: true });
  assert.equal(other.status, 'blocked'); assert.equal(other.error.code, 'confirmation_required'); assert.deepEqual(adapter.state.requests, []);
});
