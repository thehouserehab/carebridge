import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { createPrototypeSandbox } from '../prototype-sandbox.mjs';
import { createLocalApiSandbox, createLocalPrototypeApiSandbox } from '../local-api-sandbox.mjs';
import { Records } from '../records.mjs';
import { Conversations } from '../conversations.mjs';
import { ActivityFeedback } from '../activity-feedback.mjs';
import { Appointments } from '../care-contexts.mjs';

let sandbox, therapist, guardian, base;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function request(route, { actor, method = 'GET', body, bytes, headers = {} } = {}) {
  const response = await fetch(sandbox.origin + route, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: {
    Origin: sandbox.origin, 'X-Carebridge-Request': '1',
    ...(actor ? { Cookie: actor.cookie, 'X-Carebridge-Account': actor.userId } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers,
  }, body: bytes ?? (body ? JSON.stringify(body) : undefined) });
  const data = Buffer.from(await response.arrayBuffer());
  const json = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(data) : null;
  return { status: response.status, headers: response.headers, json, bytes: data };
}
async function login(role) {
  const account = sandbox.credentials.find(item => item.role === role);
  const result = await request('/api/local/auth/login', { method: 'POST', body: { email: account.email, password: account.password } });
  assert.equal(result.status, 200);
  return { userId: result.json.user.userId, cookie: result.headers.get('set-cookie').split(';')[0], centerId: sandbox.ids.centerId };
}
async function upload(actor, sample) {
  const reserved = await request(base + '/uploads', { actor, method: 'POST', body: { clientId: randomUUID(),
    file: { name: sample.name, type: sample.type, size: sample.bytes.length, sha256: hash(sample.bytes) } } });
  assert.equal(reserved.status, 200, JSON.stringify(reserved.json));
  const uploaded = await request(base + '/uploads/' + reserved.json.upload.id + '/content', { actor, method: 'POST', bytes: sample.bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'X-Carebridge-Upload-Version': String(reserved.json.upload.version) } });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.json));
  assert.equal(uploaded.json.upload.state, 'ready', JSON.stringify(uploaded.json));
  return uploaded.json.upload;
}
before(async () => {
  sandbox = await createPrototypeSandbox();
  therapist = await login('therapist'); guardian = await login('guardian');
  base = `/api/local/centers/${sandbox.ids.centerId}/conversations/${sandbox.ids.conversationId}`;
});
after(async () => { await sandbox?.close(); if (sandbox) { assert.equal(sandbox.database.closed, true); await assert.rejects(access(sandbox.mediaRoot)); } });

test('prototype is visibly identified, offline, and seeded for the whole demonstration', async () => {
  const page = await request('/');
  assert.match(page.bytes.toString(), /data-prototype-mode="synthetic"/);
  assert.match(page.bytes.toString(), /data-ai-mode="fixture"/);
  assert.equal(sandbox.aiMode, 'fixture');
  assert.match(page.bytes.toString(), /외부 API를 호출하지 않습니다/);
  assert.match(page.bytes.toString(), /data-media-mode="prepared-delivery"/);
  assert.equal(sandbox.demoFiles.length, 3);
  const record = await new Records(sandbox.database).get(therapist, { conversationId: sandbox.ids.conversationId, recordId: sandbox.ids.recordId });
  assert.equal(record.title, '놀이 참여 관찰'); assert(record.activity);
  const appointment = await new Appointments(sandbox.database).get(therapist, { conversationId: sandbox.ids.conversationId, appointmentId: sandbox.ids.appointmentId });
  assert.equal(Date.parse(appointment.date) - Date.parse(record.date), 86400000);
  assert.equal(appointment.time, '14:00');
  const message = await new Conversations(sandbox.database).get(guardian, { conversationId: sandbox.ids.conversationId, messageId: sandbox.ids.publicationMessageId });
  assert(message.publication); assert.equal(message.publication.privateNote, undefined);
});

test('only exact provided samples can reserve uploads, including misleading name/type/hash cases', async () => {
  const sample = sandbox.demoFiles[0], other = Buffer.from(sample.bytes); other[other.length - 1] ^= 1;
  for (const file of [
    { name: sample.name, type: sample.type, size: other.length, sha256: hash(other) },
    { name: sample.name, type: 'image/jpeg', size: sample.bytes.length, sha256: sample.sha256 },
    { name: sample.name, type: sample.type, size: sample.bytes.length + 1, sha256: sample.sha256 },
  ]) {
    const result = await request(base + '/uploads', { actor: therapist, method: 'POST', body: { clientId: randomUUID(), file } });
    assert.equal(result.status, 400); assert.equal(result.json.code ?? result.json.error, 'INVALID_INPUT');
  }
  assert.equal((await sandbox.database.query('SELECT count(*) AS count FROM cb_media_uploads')).rows[0].count, 0);
});

test('a sample image uploads, binds to chat, and is privately delivered to the guardian', async () => {
  const file = await upload(therapist, sandbox.demoFiles[0]);
  const sent = await request(base + '/messages', { actor: therapist, method: 'POST', body: { clientId: randomUUID(), body: '가상 사진 전달', attachments: [{ id: file.id }] } });
  assert.equal(sent.status, 201); assert.equal(sent.json.message.attachments.length, 1);
  const route = `${base}/messages/${sent.json.message.id}/attachments/${file.id}/content`;
  const delivered = await request(route, { actor: guardian });
  assert.equal(delivered.status, 200); assert.equal(delivered.headers.get('content-type'), 'image/png');
  assert(delivered.bytes.length > 0); assert.equal((await request(route)).status, 401);
});

test('a fixed video attaches to activity feedback and uses the existing full-file delivery contract', async () => {
  const file = await upload(guardian, sandbox.demoFiles[1]);
  const record = await new Records(sandbox.database).get(therapist, { conversationId: sandbox.ids.conversationId, recordId: sandbox.ids.recordId });
  const receipt = await new ActivityFeedback(sandbox.database).save(guardian, { conversationId: sandbox.ids.conversationId,
    feedbackId: 'prototype-feedback-' + randomUUID(), sourceMessageId: sandbox.ids.publicationMessageId,
    clientId: randomUUID(), expectedRevision: 0, content: { date: record.date, result: 'partial', reaction: '가상 사례: 파란 블록을 골랐어요.',
      difficulty: '가상 사례: 오래 이어가기 어려웠어요.', attachments: [{ id: file.id }] } });
  const result = await request(`${base}/messages/${receipt.messageId}/attachments/${file.id}/content`, { actor: therapist, headers: { Range: 'bytes=0-31' } });
  assert.equal(result.status, 200); assert.equal(result.bytes.length, file.size); assert.equal(result.headers.get('accept-ranges'), 'none');
  assert.equal(result.headers.get('content-type'), 'video/mp4');
});

test('record media stays private until explicitly included in the shared publication', async () => {
  const file = await upload(therapist, sandbox.demoFiles[0]), records = new Records(sandbox.database);
  const recordId = 'prototype-private-record-' + randomUUID();
  await records.save(therapist, { conversationId: sandbox.ids.conversationId, recordId, clientId: randomUUID(), expectedRevision: 0,
    content: { date: '2026-11-16', title: '가상 첨부 보고서', goalId: sandbox.ids.goalId, status: 'saved', performed: '가상 관찰', response: '', privateNote: '내부만', nextPlan: '',
      summary: '가상 공유 요약', assessments: [], attachments: [{ id: file.id, share: true }] } });
  const privateRoute = `${base}/records/${recordId}/revisions/1/attachments/${file.id}/content`;
  assert.equal((await request(privateRoute, { actor: therapist })).status, 200);
  assert((await request(privateRoute, { actor: guardian })).status >= 400);
  const preview = await records.preview(therapist, { conversationId: sandbox.ids.conversationId, recordId });
  const published = await records.publish(therapist, { conversationId: sandbox.ids.conversationId, recordId, clientId: randomUUID(),
    expectedRevision: preview.recordRevision, expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds });
  assert.equal((await request(`${base}/messages/${published.messageId}/attachments/${file.id}/content`, { actor: guardian })).status, 200);
});

test('ordinary sandbox stays quarantine-only and prototype rejects an implicit live AI provider', async () => {
  await assert.rejects(createLocalPrototypeApiSandbox({ summaryProvider: { mode: 'openai' }, chatProvider: { mode: 'fixture' }, audioProvider: { mode: 'fixture' } }), TypeError);
  const ordinary = await createLocalApiSandbox();
  try { const response = await fetch(ordinary.origin); const html = await response.text(); assert(!html.includes('data-prototype-mode')); assert(!html.includes('data-media-mode="prepared-delivery"')); }
  finally { await ordinary.close(); }
});

test('prototype audio rejects unknown WAV before retaining a session and permits the fixed sample', async () => {
  const sample = sandbox.demoFiles.find(file => file.type === 'audio/wav');
  const changed = Buffer.from(sample.bytes); changed[changed.length - 1] ^= 1;
  const route = `${base}/records/${sandbox.ids.recordId}/audio-notes`;
  const body = { expectedRevision: 1, requestId: randomUUID(), filename: sample.name, type: sample.type,
    base64: changed.toString('base64'), syntheticConfirmed: true, processingConfirmed: true };
  const denied = await request(route, { actor: therapist, method: 'POST', body });
  assert.equal(denied.status, 400); assert.equal(denied.json.error, 'INVALID_INPUT');
  assert.deepEqual((await request(route, { actor: therapist })).json.sessions, []);
  const accepted = await request(route, { actor: therapist, method: 'POST', body: { ...body, requestId: randomUUID(), base64: sample.bytes.toString('base64') } });
  assert.equal(accepted.status, 201); assert.equal(accepted.json.session.state, 'uploaded');
  assert.equal((await request(route, { actor: guardian })).status, 404);
});
