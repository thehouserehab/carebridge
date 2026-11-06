import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { quarantineRestoredDatabase,RecoveryQuarantineError } from '../recovery-quarantine.mjs';

// Transaction-contract doubles only. Actual SQL, locks, triggers, roles and
// restored credentials are exercised separately by test:recovery:local.
const input = () => ({ operationId:randomUUID(),bundleId:randomUUID(),
  sourceReceipt:{ name:'synthetic_source',oid:1001,ownerOid:42 },
  targetReceipt:{ name:'synthetic_restore',oid:1002,ownerOid:42 },confirmTarget:'synthetic_restore' });
const code = (value) => (e) => e instanceof RecoveryQuarantineError && e.code === value && e.message === value;
function fixture(request,{ failAt,lostAcknowledgement,resetInvalidationFailure,resetClosureFailure,activeUsers = 3,identity = {} } = {}) {
  const catalog = structuredClone(request);
  let state = { users:activeUsers,sessions:2,invitations:1,resets:2,receipt:null },transactions = 0;
  const queries = [];
  const database = { async transaction(work) {
    transactions++; const next = structuredClone(state);
    const value = await work({ async query(sql,params) {
      queries.push({ sql,params });
      if (failAt && sql.startsWith(failAt)) throw new Error('DO NOT EXPOSE postgresql://secret@private');
      if (sql.includes('FROM pg_catalog.pg_database')) return { rows:[catalog.sourceReceipt,catalog.targetReceipt].map((r) => ({
        datname:r.name,oid:String(r.oid),owner_oid:String(r.ownerOid),role_oid:'42',
        current_database:catalog.targetReceipt.name,direct_role:true,allowed:true,...identity })) };
      if (sql.startsWith('SELECT *')) return { rows:next.receipt ? [next.receipt] : [] };
      if (sql.startsWith('UPDATE public.cb_users')) {
        const rowCount = next.users; next.users = 0;
        if (rowCount && !resetInvalidationFailure) next.resets = 0; // Model schema deactivation trigger only.
        return { rowCount };
      }
      if (sql.startsWith('UPDATE public.cb_auth_sessions')) { const rowCount = next.sessions; next.sessions = 0; return { rowCount }; }
      if (sql.startsWith('UPDATE public.cb_auth_invitations')) { const rowCount = next.invitations; next.invitations = 0; return { rowCount }; }
      if (sql.startsWith('UPDATE public.cb_auth_password_resets')) {
        const rowCount = resetClosureFailure ? 0 : next.resets;
        if (!resetClosureFailure) next.resets = 0;
        return { rowCount };
      }
      if (sql.startsWith('SELECT NOT EXISTS')) return { rows:[{ closed:next.users === 0 && next.sessions === 0 &&
        next.invitations === 0 && (!sql.includes('public.cb_auth_password_resets') || next.resets === 0) }] };
      if (sql.startsWith('INSERT INTO public.cb_recovery_quarantine')) {
        const [operation_id,bundle_id,source_name,source_oid,source_owner_oid,target_name,target_oid,owner_oid,
          disabled_users,revoked_sessions,revoked_invitations] = params;
        next.receipt = { operation_id,bundle_id,source_name,source_oid,source_owner_oid,target_name,target_oid,owner_oid,
          disabled_users,revoked_sessions,revoked_invitations,created_at:'2026-10-06T00:00:00.000Z' };
        return { rows:[next.receipt] };
      }
      return { rows:[] };
    } });
    state = next;
    if (lostAcknowledgement && transactions === 1) throw new Error('UNKNOWN COMMIT private credentials');
    return value;
  } };
  return { database,queries,reopenReset() { state.resets = 1; },
    get state() { return structuredClone(state); },get transactions() { return transactions; } };
}

test('strict input confirmation and distinct owned receipts reject before connection',async () => {
  const good = input(),f = fixture(good);
  const bad = [null,{}, { ...good,extra:'token' },{ ...good,operationId:42 },{ ...good,bundleId:randomUUID().toUpperCase() },
    { ...good,confirmTarget:good.sourceReceipt.name },{ ...good,targetReceipt:{ ...good.targetReceipt,oid:'1002' } },
    { ...good,targetReceipt:{ ...good.targetReceipt,ownerOid:0 } },{ ...good,sourceReceipt:good.targetReceipt },
    { ...good,sourceReceipt:{ ...good.sourceReceipt,oid:good.targetReceipt.oid } },
    { ...good,targetReceipt:{ ...good.targetReceipt,name:'postgres' },confirmTarget:'postgres' }];
  for (const value of bad) await assert.rejects(quarantineRestoredDatabase(f.database,value),code('RECOVERY_QUARANTINE_INVALID_INPUT'));
  assert.equal(f.queries.length,0);
});
test('exact target receipt serializes affected writes and emits only minimal counts',async () => {
  const request = input(),f = fixture(request),result = await quarantineRestoredDatabase(f.database,request);
  assert.deepEqual(result,{ operationId:request.operationId,bundleId:request.bundleId,disabledUsers:3,revokedSessions:2,
    revokedInvitations:1,createdAt:'2026-10-06T00:00:00.000Z',replayed:false });
  const lock = f.queries.findIndex((q) => q.sql.startsWith('LOCK TABLE'));
  assert.ok(lock > 0 && lock < f.queries.findIndex((q) => q.sql.startsWith('UPDATE')));
  assert.ok(f.queries[lock].sql.includes('public.cb_auth_password_resets'));
  assert.equal(f.state.resets,0);
  assert.ok(f.queries.some((q) => q.sql.includes('public.cb_auth_password_resets WHERE consumed_at IS NULL AND revoked_at IS NULL')));
  assert.ok(f.queries.at(-1).sql.startsWith('INSERT INTO public.cb_recovery_quarantine'));
  assert.equal(JSON.stringify(result).includes(request.targetReceipt.name),false);
  assert.equal(f.transactions,1);
});
test('database identity owner session role and operator privilege drift fail before mutation',async () => {
  for (const identity of [{ current_database:'other' },{ oid:'9999' },{ owner_oid:'99' },{ role_oid:'99' },{ direct_role:false },{ allowed:false }]) {
    const request = input(),f = fixture(request,{ identity });
    await assert.rejects(quarantineRestoredDatabase(f.database,request),code('RECOVERY_QUARANTINE_TARGET_MISMATCH'));
    assert.equal(f.queries.some((q) => q.sql.startsWith('UPDATE') || q.sql.startsWith('LOCK')),false);
    assert.equal(f.state.users,3);
  }
});
test('same receipt replay preserves original counts timestamps and performs no writes',async () => {
  const request = input(),f = fixture(request),first = await quarantineRestoredDatabase(f.database,request),offset = f.queries.length;
  assert.deepEqual(await quarantineRestoredDatabase(f.database,request),{ ...first,replayed:true });
  assert.equal(f.queries.slice(offset).some((q) => /^(UPDATE|INSERT)/.test(q.sql)),false);
  assert.ok(f.queries.slice(offset).some((q) => q.sql.startsWith('SELECT NOT EXISTS')));
});

test('pending password reset closure is required before a receipt or successful replay',async () => {
  const request = input(),failed = fixture(request,{resetInvalidationFailure:true,resetClosureFailure:true}),before = failed.state;
  await assert.rejects(quarantineRestoredDatabase(failed.database,request),code('RECOVERY_QUARANTINE_AUTH_OPEN'));
  assert.deepEqual(failed.state,before);
  assert.equal(failed.queries.some((q) => q.sql.startsWith('INSERT INTO public.cb_recovery_quarantine')),false);
  const f = fixture(request); await quarantineRestoredDatabase(f.database,request);
  f.reopenReset(); const offset = f.queries.length;
  await assert.rejects(quarantineRestoredDatabase(f.database,request),code('RECOVERY_QUARANTINE_AUTH_OPEN'));
  assert.equal(f.queries.slice(offset).some((q) => /^(UPDATE|INSERT)/.test(q.sql)),false);
  assert.equal(f.state.resets,1);
});

test('already inactive users pending reset tokens are closed without adding or rewriting receipt counts',async () => {
  const request = input(),f = fixture(request,{activeUsers:0});
  const result = await quarantineRestoredDatabase(f.database,request);
  assert.equal(result.disabledUsers,0); assert.equal(f.state.resets,0);
  const update = f.queries.find((q) => q.sql.startsWith('UPDATE public.cb_auth_password_resets'));
  assert.ok(update.sql.includes('WHERE consumed_at IS NULL AND revoked_at IS NULL'));
  assert.equal(update.sql.includes('expires_at'),false);
  assert.equal(Object.hasOwn(result,'revokedResets'),false);
  assert.equal(Object.hasOwn(f.state.receipt,'revoked_resets'),false);
});
test('changed operation bundle or source provenance never reuses a quarantine receipt',async () => {
  const request = input(),f = fixture(request); await quarantineRestoredDatabase(f.database,request);
  for (const change of [{ operationId:randomUUID() },{ bundleId:randomUUID() },{ sourceReceipt:{ ...request.sourceReceipt,ownerOid:43 } }]) {
    await assert.rejects(quarantineRestoredDatabase(f.database,{ ...request,...change }),code(
      change.sourceReceipt ? 'RECOVERY_QUARANTINE_TARGET_MISMATCH' : 'RECOVERY_QUARANTINE_CONFLICT'));
  }
  assert.equal(f.state.receipt.operation_id,request.operationId);
});
test('middle failure rolls back account/session changes and never leaks driver content',async () => {
  const request = input(),f = fixture(request,{ failAt:'UPDATE public.cb_auth_invitations' }),before = f.state;
  await assert.rejects(quarantineRestoredDatabase(f.database,request),code('RECOVERY_QUARANTINE_UNAVAILABLE'));
  assert.deepEqual(f.state,before); assert.equal(f.transactions,1);
});
test('lost commit acknowledgement is not retried and explicit replay resolves persisted receipt',async () => {
  const request = input(),f = fixture(request,{ lostAcknowledgement:true });
  await assert.rejects(quarantineRestoredDatabase(f.database,request),code('RECOVERY_QUARANTINE_UNAVAILABLE'));
  assert.equal(f.transactions,1); assert.equal(f.state.receipt.operation_id,request.operationId);
  const replay = await quarantineRestoredDatabase(f.database,request);
  assert.equal(replay.replayed,true); assert.equal(replay.disabledUsers,3); assert.equal(f.transactions,2);
});
test('identifiers are bound parameters and never interpolated into privileged SQL',async () => {
  const request = input(); request.targetReceipt.name = "synthetic';--"; request.confirmTarget = request.targetReceipt.name;
  const f = fixture(request); await quarantineRestoredDatabase(f.database,request);
  assert.equal(f.queries.some((q) => q.sql.includes(request.targetReceipt.name)),false);
  assert.equal(f.queries[1].params.includes(request.targetReceipt.name),true);
});
test('caller mutation during connection cannot change confirmed target or source ownership',async () => {
  const request = input(),approved = structuredClone(request),f = fixture(request);
  const delayed = { transaction(work) {
    request.targetReceipt.name = 'unapproved'; request.targetReceipt.oid++;
    request.sourceReceipt.ownerOid++; request.bundleId = randomUUID();
    return f.database.transaction(work);
  } };
  const result = await quarantineRestoredDatabase(delayed,request);
  assert.equal(result.bundleId,approved.bundleId);
  assert.equal(f.state.receipt.target_name,approved.targetReceipt.name);
  assert.equal(f.state.receipt.target_oid,approved.targetReceipt.oid);
  assert.equal(f.state.receipt.source_owner_oid,approved.sourceReceipt.ownerOid);
});
