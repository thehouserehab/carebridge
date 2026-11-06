// Borrowed, caller-owned synthetic pages only. Mutations use visible UI;
// observed HTTP responses are evidence, never an alternate mutation path.
// No credentials, authored bodies or request payloads leave these helpers.
import assert from 'node:assert/strict';
import { workspaceRecords, workspaceRoom } from './local-workspace-browser-helpers.mjs';

const code = 'NATIVE_REPLY_SOURCE_BROWSER_FAILED';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const uploadId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const dialog = who => who.page.getByTestId('care-dialog');
const row = (who, id) => who.page.locator(`[data-testid="message-row"][data-message-id="${id}"]`);
const text = Object.freeze({
  title: '가상 인용 첨부 확인 기록', performed: '가상 내부 수행 관찰 — 답장 첨부 확인',
  response: '가상 내부 반응 관찰 — 답장 첨부 확인', nextPlan: '가상 내부 다음 회기 계획 — 답장 첨부 확인',
  privateNote: '가상 치료사 전용 메모 — 보호자 공유 제외', summary: '가상 공유 요약 — 가정 활동 없이 답장으로 소식을 남겨 주세요',
  source: '가상 일반 소식 — 이 소식에 사진이나 영상으로 답장해 주세요',
});

function context(options) {
  const { origin, centerId, conversationId, guardian, therapist, capture, onPhase } = options;
  const url = new URL(origin);
  assert(url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
    Number(url.port) >= 1024 && Number(url.port) <= 65535 && !url.username && !url.password && !url.search && !url.hash &&
    validId(centerId) && validId(conversationId) && guardian?.page && therapist?.page && guardian.page !== therapist.page &&
    typeof capture === 'function' && typeof onPhase === 'function', code);
  const base = `${origin}/api/local/centers/${centerId}/conversations/${conversationId}`;
  const response = (who, suffix, method, status) => who.page.waitForResponse(r =>
    r.url() === base + suffix && r.request().method() === method && r.status() === status);
  const reloadRoom = async who => {
    await who.page.reload(); await who.page.getByTestId('home').waitFor(); await workspaceRoom(who.page, conversationId);
  };
  const roomSnapshot = async (who, ids, operation) => {
    let messages;
    const observed = who.page.waitForResponse(async r => {
      const u = new URL(r.url());
      if (`${u.origin}${u.pathname}` !== `${base}/messages` || r.request().method() !== 'GET' || r.status() !== 200) return false;
      const payload = await r.json();
      if (payload?.resetRequired !== false || !Array.isArray(payload.messages) ||
          !ids.every(id => payload.messages.some(message => message.id === id))) return false;
      messages = payload.messages; return true;
    });
    await Promise.all([observed, operation()]);
    assert(messages && ids.every(id => messages.filter(message => message.id === id).length === 1), code);
    return messages;
  };
  return { base, response, reloadRoom, roomSnapshot };
}

async function field(who, name, value, select = false) {
  const input = dialog(who).locator(`[name="${name}"]`);
  for (const details of await input.locator('xpath=ancestor::details').all())
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  if (select) await input.selectOption(value); else await input.fill(value);
}

async function submit(who, label) {
  await dialog(who).getByRole('button', { name: label, exact: true }).click();
  await dialog(who).waitFor({ state: 'hidden' });
}

function noPrivate(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const name of ['performed', 'response', 'nextPlan', 'privateNote']) assert(!serialized.includes(text[name]), code);
}

export async function prepareReplySources(options) {
  const { origin, centerId, conversationId, goalId, appointmentId, guardianId, guardian, therapist, capture, onPhase } = options;
  const { base, response, reloadRoom, roomSnapshot } = context(options);
  assert(validId(goalId) && validId(guardianId) && (appointmentId === undefined || validId(appointmentId)), code);
  const checks = { publicationWithoutActivity: false, privatePreview: false, textSource: false };

  onPhase('REPLY_SOURCE_RECORD');
  // A separate new record avoids reusing an appointment already exercised by
  // another caller-owned care flow. Appointment linkage is not claimed here.
  await workspaceRecords(therapist.page, conversationId);
  await therapist.page.locator('[data-care-action="new-record"]:not([disabled])').click();
  await dialog(therapist).waitFor();
  for (const name of ['title', 'performed', 'response', 'nextPlan', 'privateNote', 'summary']) await field(therapist, name, text[name]);
  await field(therapist, 'goalId', goalId, true);
  for (const name of ['activityTitle', 'activityInstruction', 'activityFrequency', 'activityCaution']) await field(therapist, name, '');
  const [savedResponse] = await Promise.all([
    therapist.page.waitForResponse(r => {
      const u = new URL(r.url()), prefix = `${base}/records/`;
      return r.url().startsWith(prefix) && !u.search && validId(r.url().slice(prefix.length)) &&
        r.request().method() === 'POST' && r.status() === 201;
    }),
    submit(therapist, '기록 저장'),
  ]);
  const saved = (await savedResponse.json()).receipt, command = savedResponse.request().postDataJSON();
  assert(validId(saved?.recordId) && saved.revision === 1 && command.expectedRevision === 0 &&
    command.content?.status === 'saved' && command.content.goalId === goalId && command.content.activity === null &&
    (command.content.attachments ?? []).length === 0, code);
  for (const name of ['performed', 'response', 'nextPlan', 'privateNote', 'summary']) assert(command.content[name] === text[name], code);

  onPhase('REPLY_SOURCE_PREVIEW');
  await workspaceRecords(therapist.page, conversationId);
  const [previewResponse] = await Promise.all([
    response(therapist, `/records/${saved.recordId}/preview`, 'GET', 200),
    therapist.page.locator(`[data-care-action="preview-record"][data-record-id="${saved.recordId}"]`).click(),
  ]);
  await dialog(therapist).waitFor();
  const preview = (await previewResponse.json()).preview;
  assert(preview?.recordId === saved.recordId && preview.recordRevision === saved.revision &&
    preview.summary === text.summary && preview.activity === null && preview.attachmentCount === 0 &&
    Array.isArray(preview.recipientIds) && preview.recipientIds.length === 1 && preview.recipientIds[0] === guardianId, code);
  noPrivate(preview); noPrivate(await dialog(therapist).innerText());
  await dialog(therapist).locator('[name="confirmed"]').check();
  await capture(therapist, '1440-reply-source-private-preview');
  const [publishedResponse] = await Promise.all([
    response(therapist, `/records/${saved.recordId}/publish`, 'POST', 201), submit(therapist, '확인하고 공유'),
  ]);
  const publicationMessageId = (await publishedResponse.json()).receipt?.messageId;
  assert(validId(publicationMessageId), code); checks.privatePreview = true;

  onPhase('REPLY_SOURCE_PUBLICATION');
  const shared = (await roomSnapshot(guardian, [publicationMessageId], () => reloadRoom(guardian)))
    .find(message => message.id === publicationMessageId);
  assert(shared?.conversationId === conversationId && shared.type === 'publication' && shared.canReply === true &&
    shared.hidden === false && shared.archived === false && shared.publication?.activity === null &&
    shared.publication.summary === text.summary && shared.attachmentCount === 0, code);
  noPrivate(shared); noPrivate(await guardian.page.locator('body').innerText());
  const publicationRow = row(guardian, publicationMessageId); await publicationRow.waitFor();
  assert(await publicationRow.locator('[data-care-action="feedback"]').count() === 0, code);
  await publicationRow.locator(`[data-care-action="reply"][data-message-id="${publicationMessageId}"]`).waitFor();
  await publicationRow.scrollIntoViewIfNeeded(); await capture(guardian, '390-publication-without-activity-reply');
  checks.publicationWithoutActivity = true;

  onPhase('REPLY_SOURCE_TEXT');
  await workspaceRoom(therapist.page, conversationId);
  await therapist.page.getByLabel('메시지', { exact: true }).fill(text.source);
  const [sentResponse] = await Promise.all([
    response(therapist, '/messages', 'POST', 201),
    therapist.page.locator('.composer').getByRole('button', { name: '보내기', exact: true }).click(),
  ]);
  const message = (await sentResponse.json()).message, sent = sentResponse.request().postDataJSON();
  assert(validId(message?.id) && message.type === 'text' && message.conversationId === conversationId && message.version === 1 &&
    message.body === text.source && message.attachmentCount === 0 && !message.quote &&
    sent.body === text.source && !sent.replyTo && (sent.attachments ?? []).length === 0, code);
  const visible = (await roomSnapshot(guardian, [message.id], () => reloadRoom(guardian))).find(item => item.id === message.id);
  assert(visible?.type === 'text' && visible.version === 1 && visible.body === text.source && visible.canReply === true && !visible.hidden, code);
  const textRow = row(guardian, message.id); await textRow.waitFor();
  const menu = textRow.locator('.care-message-menu');
  if (await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
  await textRow.locator(`[data-care-action="reply"][data-message-id="${message.id}"]`).waitFor();
  await textRow.scrollIntoViewIfNeeded(); await capture(guardian, '390-text-source-reply'); checks.textSource = true;
  return Object.freeze({ checks: Object.freeze(checks), recordId: saved.recordId, recordRevision: saved.revision,
    sources: Object.freeze([Object.freeze({ id: publicationMessageId, type: 'publication' }),
      Object.freeze({ id: message.id, type: 'text', version: 1 })]) });
}

export async function verifyReplyWithdrawal(options) {
  const { conversationId, guardian, therapist, publicationMessageId, replyMessageId, uploadId: fileId, capture, onPhase } = options;
  const { response, reloadRoom, roomSnapshot } = context(options);
  assert(validId(publicationMessageId) && validId(replyMessageId) && publicationMessageId !== replyMessageId && uploadId(fileId), code);
  onPhase('REPLY_WITHDRAW_BASELINE');
  const before = await roomSnapshot(guardian, [publicationMessageId, replyMessageId], () => reloadRoom(guardian));
  const originalReply = before.find(message => message.id === replyMessageId);
  assert(originalReply?.type === 'text' && originalReply.hidden === false && originalReply.deleted === false &&
    originalReply.quote?.id === publicationMessageId && originalReply.quote.hidden === false &&
    originalReply.attachments?.some(file => file.id === fileId), code);

  onPhase('REPLY_WITHDRAW_PUBLICATION');
  await workspaceRoom(therapist.page, conversationId);
  await therapist.page.locator(`[data-care-action="withdraw"][data-message-id="${publicationMessageId}"]`).click();
  await dialog(therapist).waitFor();
  const [withdrawnResponse] = await Promise.all([
    response(therapist, `/publications/${publicationMessageId}/withdraw`, 'POST', 200), submit(therapist, '공유 종료 확인'),
  ]);
  const withdrawn = (await withdrawnResponse.json()).message;
  assert(withdrawn?.id === publicationMessageId && withdrawn.archived === true && withdrawn.canReply === false, code);

  onPhase('REPLY_WITHDRAW_RETAINED_ATTACHMENT');
  const after = await roomSnapshot(guardian, [publicationMessageId, replyMessageId], () => reloadRoom(guardian));
  const source = after.find(message => message.id === publicationMessageId), reply = after.find(message => message.id === replyMessageId);
  assert(source?.hidden === true && source.archived === true && source.canReply === false && !source.publication && source.attachmentCount === 0, code);
  assert(reply?.type === 'text' && reply.hidden === false && reply.deleted === false && reply.body === originalReply.body &&
    reply.quote?.id === publicationMessageId && reply.quote.hidden === true &&
    JSON.stringify(reply.attachments) === JSON.stringify(originalReply.attachments), code);
  const sourceRow = row(guardian, publicationMessageId), replyRow = row(guardian, replyMessageId);
  await sourceRow.waitFor(); await replyRow.waitFor();
  assert(await sourceRow.locator('[data-care-action="reply"]').count() === 0 &&
    await sourceRow.locator('[data-publication-id]').count() === 0, code);
  const attachment = replyRow.locator(`[data-open-attachment="${fileId}"][data-message-id="${replyMessageId}"]`);
  await attachment.waitFor();
  assert((await replyRow.locator('.message-quote').innerText()).includes('공유가 종료된 기록입니다.'), code);
  await replyRow.scrollIntoViewIfNeeded(); await capture(guardian, '390-withdrawn-source-retained-reply-attachment');
  const [contentResponse] = await Promise.all([
    response(guardian, `/messages/${replyMessageId}/attachments/${fileId}/content`, 'GET', 200), attachment.click(),
  ]);
  const file = originalReply.attachments.find(item => item.id === fileId), headers = contentResponse.headers();
  assert(headers['content-type'] === file.type && Number(headers['content-length']) === file.size, code);
  const viewer = guardian.page.getByTestId('media-viewer'); await viewer.waitFor();
  if (file.type.startsWith('image/')) {
    await guardian.page.waitForFunction(() => {
      const image = document.querySelector('[data-media-viewer-content] img');
      return image?.complete && image.naturalWidth > 0;
    });
    assert(await viewer.locator('img').evaluate(async image => {
      await image.decode(); return image.naturalWidth > 0 && image.currentSrc.startsWith('blob:');
    }), code);
  } else {
    await guardian.page.waitForFunction(() => {
      const video = document.querySelector('[data-media-viewer-content] video');
      return video?.readyState >= 1 && video.videoWidth > 0;
    });
  }
  await capture(guardian, '390-withdrawn-source-retained-reply-viewer');
  await viewer.locator('[data-media-viewer-close]').click(); await viewer.waitFor({ state: 'hidden' });
  return true;
}
