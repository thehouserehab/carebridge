// Explicit synthetic recovery fixture only. Importing this helper opens no
// database, account, listener, child process or file. Callers own all services.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assertRecoveryReviewRows } from './recovery-native-contract.mjs';

const originalReviewBody = 'Synthetic original recovery review source';

async function reviewSchema(owner) {
  const tables=['cb_message_reviews','cb_message_review_requests'];
  const schema=await owner.transaction(async tx=>{
    const {rows:constraints}=await tx.query(`SELECT c.relname,k.conname,k.contype,k.conenforced,k.convalidated,
      k.condeferrable,k.condeferred,k.connoinherit,referenced.relname AS referenced_table,
      pg_catalog.pg_get_constraintdef(k.oid,true) AS definition
      FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_class referenced ON referenced.oid=k.confrelid
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,k.conname`,[tables]);
    const {rows:functions}=await tx.query(`SELECT p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_catalog.pg_get_functiondef(p.oid) AS definition FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=$1 ORDER BY p.proname,arguments`,['cb_message_review_guard']);
    const {rows:triggers}=await tx.query(`SELECT c.relname,t.tgname,t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid) AS definition
      FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,[tables]);
    return {constraints,functions,triggers};
  });
  // Reject empty catalog doubles/results and missing essential 022 objects,
  // before adopting the source signature as the restore expectation.
  for(const table of tables){
    assert.ok(schema.constraints.some(row=>row.relname===table&&row.contype==='p'));
    assert.ok(schema.constraints.some(row=>row.relname===table&&row.contype==='c'&&
      row.conname===`${table}_review_version_check`&&row.conenforced&&row.convalidated));
    assert.ok(schema.constraints.some(row=>row.relname===table&&row.contype==='f'&&row.referenced_table==='cb_message_text_revisions'));
  }
  assert.equal(schema.functions.length,1);assert.equal(schema.functions[0].proname,'cb_message_review_guard');
  assert.equal(schema.functions[0].arguments,'');assert.ok(schema.functions[0].definition.length>0);
  for(const [table,name]of [['cb_message_reviews','cb_message_review_guard'],
    ['cb_message_review_requests','cb_message_review_request_guard'],['cb_message_review_requests','cb_message_review_request_immutable'],
    ...tables.flatMap(table=>[[table,'cb_000_recovery_guard'],[table,'cb_recovery_truncate_guard']])])
    assert.ok(schema.triggers.some(row=>row.relname===table&&row.tgname===name&&row.tgenabled==='O'&&row.definition.length>0));
  return schema;
}

export async function seedRecoveryReviewFixture(chat, { therapist, guardian, manager, conversationId }, owner) {
  const actors = Object.fromEntries(Object.entries({ therapist, guardian, manager })
    .map(([kind, actor]) => [kind, Object.freeze({ ...actor })]));
  const message = await chat.sendText(actors.guardian, { conversationId, clientId: 'synthetic-e-review-source-0001',
    body: originalReviewBody });
  const target = Object.freeze({ conversationId, messageId: message.id });
  const firstRequest = Object.freeze({ ...target, clientId: 'synthetic-e-review-request-0001',
    expectedRevision: 1, expectedReviewVersion: 0, note: 'SYNTHETIC-PRIVATE-RECOVERY-REVIEW-ONE' });
  const firstReceipt = await chat.textReviewSave(actors.therapist, firstRequest);
  assert.deepEqual(firstReceipt, { messageId: message.id, revision: 1, reviewVersion: 1, operation: 'review', replayed: false });
  await chat.editText(actors.guardian, { ...target, clientId: 'synthetic-e-review-edit-0001', expectedRevision: 1,
    body: 'Synthetic revised recovery review source' });
  const secondRequest = Object.freeze({ ...firstRequest, clientId: 'synthetic-e-review-request-0002',
    expectedRevision: 2, expectedReviewVersion: 1, note: 'SYNTHETIC-PRIVATE-RECOVERY-REVIEW-TWO' });
  assert.deepEqual(await chat.textReviewSave(actors.therapist, secondRequest),
    { messageId: message.id, revision: 2, reviewVersion: 2, operation: 'review', replayed: false });
  const view = Object.freeze({ ...target, revision: 2, reviewVersion: 2, reviewedRevision: 2,
    note: secondRequest.note, body: 'Synthetic revised recovery review source', attachmentCount: 0 });
  assert.deepEqual(await chat.textReview(actors.therapist, target), view);
  const schema=await reviewSchema(owner);
  return Object.freeze({ ...actors, target, firstRequest, secondRequest, firstReceipt: Object.freeze({ ...firstReceipt }), view, schema });
}

export async function verifyRecoveryReviewFixture({ chat, owner, fingerprint, fixture }) {
  // The owner snapshot includes every table, including room revision and audit
  // rows that the runtime deliberately cannot SELECT. Keep it in memory only.
  const before = await fingerprint(owner);
  assert.deepEqual(await reviewSchema(owner),fixture.schema);
  const { therapist, guardian, manager, target, firstRequest, secondRequest, firstReceipt, view } = fixture;
  const evidence = await owner.transaction(async tx => {
    const parameters = [therapist.centerId, target.conversationId, target.messageId];
    const { rows: counts } = await tx.query(`SELECT
      (SELECT count(*)::integer FROM cb_message_reviews WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3) AS reviews,
      (SELECT count(*)::integer FROM cb_message_review_requests WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3) AS requests`, parameters);
    const { rows: receipts } = await tx.query(`SELECT client_id,message_revision,review_version FROM cb_message_review_requests
      WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3 ORDER BY review_version,client_id`, parameters);
    return { counts: counts[0], receipts };
  });
  assertRecoveryReviewRows([{ name: 'cb_message_reviews', count: evidence.counts?.reviews },
    { name: 'cb_message_review_requests', count: evidence.counts?.requests }]);
  assert.deepEqual(evidence.receipts, [
    { client_id: firstRequest.clientId, message_revision: 1, review_version: 1 },
    { client_id: secondRequest.clientId, message_revision: 2, review_version: 2 },
  ]);
  assert.deepEqual(await chat.textReview(therapist, target), view);
  assert.deepEqual(await chat.textReviewSave(therapist, firstRequest), { ...firstReceipt, replayed: true });
  assert.deepEqual(await chat.textReview(therapist, target), view);
  await assert.rejects(chat.textReview(guardian, target), { code: 'FORBIDDEN' });
  await assert.rejects(chat.textReview(manager, target), { code: 'NOT_FOUND' });
  const visible = await chat.list(guardian, { conversationId: target.conversationId });
  assert.ok(visible.messages.some(row => row.id === target.messageId && row.body === view.body));
  assert.doesNotMatch(JSON.stringify(visible), /SYNTHETIC-PRIVATE-RECOVERY-REVIEW|reviewNote|reviewVersion|reviewedRevision/);
  assert.deepEqual(await fingerprint(owner), before); // Exact retry and denied reads cannot mutate any table.
}

export async function verifyQuarantinedRecoveryReviewFixture({ owner, fingerprint, fixture }) {
  // Quarantine deliberately disables every service identity. Inspect through
  // the already-owned fixture connection; never replay a service request here.
  const before = await fingerprint(owner);
  try {
    const { therapist, guardian, manager, target, firstRequest, secondRequest, view } = fixture;
    const parameters = [therapist.centerId, target.conversationId, target.messageId];
    const actors = [therapist.userId, guardian.userId, manager.userId];
    assert.equal(new Set(actors).size, 3);
    const posture = await owner.transaction(async tx => (await tx.query(`SELECT
      (SELECT count(*)::integer FROM public.cb_recovery_quarantine) AS gates,
      (SELECT count(*)::integer FROM public.cb_users WHERE active) AS active_users,
      (SELECT count(*)::integer FROM public.cb_users WHERE id=ANY($1::text[])) AS fixture_users`, [actors])).rows);
    assert.deepEqual(posture, [{ gates: 1, active_users: 0, fixture_users: actors.length }]);
    assert.deepEqual(await reviewSchema(owner), fixture.schema);
    const evidence = await owner.transaction(async tx => {
      const reviews = (await tx.query(`SELECT reviewer_id,message_revision,review_version,note FROM public.cb_message_reviews
        WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3`, parameters)).rows;
      const receipts = (await tx.query(`SELECT actor_id,client_id,message_revision,review_version FROM public.cb_message_review_requests
        WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3 ORDER BY review_version,client_id`, parameters)).rows;
      const heads = (await tx.query(`SELECT current_revision FROM public.cb_message_text_heads
        WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3`, parameters)).rows;
      const revisions = (await tx.query(`SELECT revision,actor_id,operation,body FROM public.cb_message_text_revisions
        WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3 ORDER BY revision`, parameters)).rows;
      return { reviews, receipts, heads, revisions };
    });
    assertRecoveryReviewRows([{ name: 'cb_message_reviews', count: evidence.reviews.length },
      { name: 'cb_message_review_requests', count: evidence.receipts.length }]);
    assert.deepEqual(evidence.reviews, [{ reviewer_id: therapist.userId, message_revision: 2, review_version: 2, note: view.note }]);
    assert.deepEqual(evidence.receipts, [
      { actor_id: therapist.userId, client_id: firstRequest.clientId, message_revision: 1, review_version: 1 },
      { actor_id: therapist.userId, client_id: secondRequest.clientId, message_revision: 2, review_version: 2 },
    ]);
    assert.deepEqual(evidence.heads, [{ current_revision: 2 }]);
    assert.deepEqual(evidence.revisions, [
      { revision: 1, actor_id: guardian.userId, operation: 'sent', body: originalReviewBody },
      { revision: 2, actor_id: guardian.userId, operation: 'edit', body: view.body },
    ]);
    const blocked = async (sql, values) => {
      await assert.rejects(owner.transaction(async tx => {
        await tx.query(sql, values);
        // Unexpected success must roll back, not commit a probe into the
        // retained restore. It still fails the required quarantine assertion.
        throw new Error('RECOVERY_REVIEW_WRITE_NOT_BLOCKED');
      }), { code: '23514', message: 'restored service remains quarantined' });
    };
    // These satisfy the normal review guard: advance the existing head by
    // one, or insert a fresh receipt matching its current reviewer/source.
    // Require the quarantine error message too; another 23514 is not proof.
    await blocked(`UPDATE public.cb_message_reviews SET review_version=review_version+1
      WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3`, parameters);
    await blocked(`INSERT INTO public.cb_message_review_requests
      (center_id,conversation_id,actor_id,client_id,request_hash,message_id,message_revision,review_version)
      SELECT center_id,conversation_id,reviewer_id,$4,$5,message_id,message_revision,review_version
      FROM public.cb_message_reviews WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3`,
    [...parameters, randomUUID(), 'a'.repeat(64)]);
  } finally {
    // Also run on wrong schema/data, wrong rejection, or unexpected success.
    assert.deepEqual(await fingerprint(owner), before);
  }
}
