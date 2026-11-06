import { recordDetails, recordActivity, hasRecordContent, isCompleteAssessment, recordTitleSuggestion } from '../src/record-fields.js';
import { feedbackFields } from '../src/feedback-fields.js';
import { MEDIA_LIMITS } from '../src/media-policy.js';
import { MediaUploadUi } from './media-ui.js';
import { LocalApiError } from './client.js';
import { localDay } from './workspace-ui.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const identity = (context) => context?.user?.userId && context.centerId && context.roomId
  ? JSON.stringify([context.user.userId, context.centerId, context.roomId]) : null;
const roleOf = (context) => context?.user?.centers?.find((c) => c.id === context.centerId)?.role;
const results = { done: '했어요', partial: '일부 했어요', skipped: '하지 못했어요' };
const observationKeys = ['task', 'assistance', 'amount', 'repetitions', 'duration', 'context'];
const assessmentKeys = ['tool', 'item', 'value', 'unit', 'context'];
const rejectedCodes = new Set(['INVALID_INPUT', 'EMPTY_RECORD', 'RECORD_CONFLICT', 'FEEDBACK_CONFLICT', 'REVIEW_CONFLICT', 'PROFILE_CONFLICT', 'GOAL_CONFLICT', 'APPOINTMENT_CONFLICT', 'SCHEDULE_CONFLICT', 'THERAPIST_UNAVAILABLE', 'REVISION_LIMIT',
  'RECIPIENTS_CHANGED', 'PUBLICATION_CLOSED', 'CONTEXT_CHANGED', 'REFERENCE_CHANGED', 'ATTACHMENTS_NOT_CONNECTED',
  'NO_ACTIVITY', 'NO_RECIPIENT', 'RECORD_NOT_SHAREABLE', 'CONTEXT_NOT_FOUND', 'APPOINTMENT_RECORD_EXISTS', 'RECORD_IMPORT_REQUIRED',
  'MESSAGE_CONFLICT', 'MESSAGE_DELETED', 'MESSAGE_CHANGE_EXPIRED']);
const labels = { task: '과제', assistance: '도움 수준', amount: '수행량', repetitions: '반복 횟수', duration: '수행 시간', context: '관찰 조건' };
const titleCase = (value) => value[0].toUpperCase() + value.slice(1);
const recordDetailStatus = (observation, count) => [Object.values(observation).some(Boolean) ? '관찰 입력 있음' : '',
  count ? `측정값 ${count}개` : ''].filter(Boolean).join(' · ');

// Exact public projection: do not serialize a clinical record into this view.
export function publicCarePreview(preview) {
  return { recordId: preview.recordId, recordRevision: preview.recordRevision,
    relationshipsVersion: preview.relationshipsVersion, recipientIds: [...preview.recipientIds],
    date: preview.date, title: preview.title, summary: preview.summary,
    activity: preview.activity ? Object.fromEntries(['title', 'instruction', 'frequency', 'caution'].map((key) => [key, preview.activity[key] ?? ''])) : null,
    attachmentCount: preview.attachmentCount ?? 0,
    ...(Array.isArray(preview.attachments) ? { attachments: preview.attachments.filter((file) => file.share === true)
      .map(({ id, name, type, size, share }) => ({ id, name, type, size, share })) } : {}) };
}

// Shared rules preserve 0 versus blank and allow incomplete measurements only
// in a draft. Authorization and source-version checks remain on the server.
export function careRecordContent(values, status, references = [], attachments) {
  const details = recordDetails({ status, performed: values.performed, response: values.response,
    observation: values.observation ?? null, assessments: values.assessments ?? [] });
  const content = { date: values.date, title: values.title ?? '', goalId: values.goalId,
    appointmentId: values.appointmentId ?? null, status, performed: details.performed, response: details.response,
    nextPlan: (values.nextPlan ?? '').trim(), summary: (values.summary ?? '').trim(), privateNote: (values.privateNote ?? '').trim(),
    observation: details.observation, assessments: details.assessments,
    activity: recordActivity(values.activity, status), referenceMessageIds: references.map((r) => r.messageId) };
  if (status === 'saved' && !hasRecordContent(content)) throw new Error('활동·반응·다음 계획 중 기록할 내용을 입력해 주세요.');
  const feedback = references.filter((r) => r.feedbackRevision).map((r) => ({ messageId: r.messageId, revision: r.feedbackRevision }));
  const text = references.filter((r) => r.messageRevision).map((r) => ({ messageId: r.messageId, revision: r.messageRevision }));
  if (feedback.length) content.referenceFeedbackRevisions = feedback;
  if (text.length) content.referenceTextRevisions = text;
  if (attachments !== undefined) content.attachments = attachments.map(({ id, share }) => ({ id, share }));
  return content;
}

// A reusable form is not a copy of a clinical record. Select metadata before
// normalization so even future fields or the original value cannot enter it.
export function careRecordTemplate(record, goals = []) {
  const keys = ['tool', 'item', 'unit', 'context'];
  if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.goalId !== 'string' ||
      !Array.isArray(goals) || !Array.isArray(record.assessments) || record.assessments.length > 20 ||
      !record.assessments.every((row) => row && typeof row === 'object' && !Array.isArray(row) &&
        keys.every((key) => typeof row[key] === 'string'))) throw new LocalApiError('INVALID_RESPONSE');
  const { assessments } = recordDetails({ status: 'draft', assessments: record.assessments.map((row) =>
    ({ ...Object.fromEntries(keys.map((key) => [key, row[key]])), value: '' })) });
  return { goalId: goals.some((goal) => goal.id === record.goalId) ? record.goalId : '',
    assessments: assessments.map((row) => ({ ...row, value: '' })) };
}

// One row remains one observation, even for repeated items in one record.
// Dates sort chronologically; ties retain the server's creation/ordinal order.
export function groupCareMeasurements(measurements) {
  const groups = new Map();
  for (const { row } of measurements.map((row, index) => ({ row, index }))
    .filter(({ row }) => isCompleteAssessment(row))
    .sort((a, b) => a.row.date.localeCompare(b.row.date) || a.index - b.index)) {
    const key = JSON.stringify([row.goalId, row.tool, row.item, row.unit, row.context]);
    if (!groups.has(key)) groups.set(key, { key, goalId: row.goalId, goalTitle: null,
      tool: row.tool, item: row.item, unit: row.unit, context: row.context, measurements: [] });
    const group = groups.get(key);
    group.goalTitle = row.goalTitle;
    group.measurements.push({ recordId: row.recordId, recordRevision: row.recordRevision,
      date: row.date, title: row.title, goalTitle: row.goalTitle, ordinal: row.ordinal, value: row.value });
  }
  return [...groups.values()];
}

export function careMeasurementMarkup(comparison) {
  const groups = comparison?.groups ?? [];
  const loading = comparison?.loading === true, loaded = comparison?.loaded === true;
  return `<section class="care-comparison" data-testid="measurement-comparison" aria-label="측정값 비교">
    <div class="care-actions"><h2>측정값 비교</h2>${action('compare-records', loaded ? '비교 새로고침' : '측정값 비교', null, loading ? 'disabled' : '')}${comparison ? action('clear-comparison', '비교 닫기') : ''}</div>
    <details class="care-comparison-help"><summary>비교 기준과 안내</summary><p class="small muted">열람 가능한 정식 기록의 현재 저장본만 비교합니다. 같은 목표·도구·항목·단위·측정 조건끼리 표시하며 초안과 빈값은 제외합니다.</p><p class="small muted">직접 입력한 값의 비교이며, 자동 점수 산정이나 임상 해석은 제공하지 않습니다.</p></details>
    ${loading ? '<p role="status">측정값 전체를 확인하고 있어요…</p>' : comparison?.notice ? `<p role="status" data-comparison-notice>${esc(comparison.notice)}</p>` : ''}
    ${loaded ? `<p class="small" data-comparison-count>${groups.reduce((n, group) => n + group.measurements.length, 0)}개 측정값 · ${groups.length}개 조건</p>${groups.length ? groups.map((group) => `<article class="care-measurement-group" data-measurement-group><h3>${esc(group.item)}</h3><p class="small">목표 · ${esc(group.goalTitle ?? '제목이 보존되지 않은 이전 목표')}</p><p class="small muted">${esc(group.tool)} · ${esc(group.context)} · 단위 ${esc(group.unit)}</p>
      <ol>${group.measurements.map((row) => `<li data-measurement-row data-record-id="${esc(row.recordId)}" data-record-revision="${row.recordRevision}" data-measurement-ordinal="${row.ordinal}"><div><time>${esc(row.date)}</time><p class="small muted">${esc(row.title)} · ${row.recordRevision}번째 기록 · ${row.ordinal + 1}번째 측정</p>${row.goalTitle !== group.goalTitle ? `<p class="small muted">당시 목표 · ${esc(row.goalTitle ?? '제목 미보존')}</p>` : ''}</div><strong data-measurement-value>${esc(row.value)} ${esc(group.unit)}</strong></li>`).join('')}</ol></article>`).join('') : '<p>비교할 정식 측정값이 아직 없습니다.</p>'}` : ''}
    </section>`;
}

const comparisonScope = (context, state) => JSON.stringify([context.roomRevision ?? null, state.loaded,
  state.records.map((record) => [record.id, record.revision, record.status])]);

// A timeout is not a rejection. Only an acknowledged or explicitly rejected
// mutation may unlock/change this immutable request body and client ID.
export class CareMutation {
  constructor(createId = () => crypto.randomUUID()) { this.createId = createId; this.operation = null; this.sending = false; this.uncertain = false; this.everUncertain = false; }
  begin(kind, targetId, body) {
    if (this.sending) return null;
    if (!this.operation) this.operation = freeze({ kind, targetId, body: { ...clone(body), clientId: this.createId() } });
    this.sending = true; this.uncertain = false; return this.operation;
  }
  failed(operation) { if (operation && this.operation === operation) { this.sending = false; this.uncertain = true; this.everUncertain = true; } }
  accepted(operation) { if (this.operation === operation) this.clear(); }
  rejected(operation) { if (this.operation === operation) this.clear(); }
  clear() { this.operation = null; this.sending = false; this.uncertain = false; this.everUncertain = false; }
}

const action = (name, label, messageId, extra = '') => `<button type="button" data-care-action="${name}"${messageId ? ` data-message-id="${esc(messageId)}"` : ''} ${extra}>${esc(label)}</button>`;
const version = (value) => Number.isInteger(value) && value >= 1 && value <= 2147483647;
const files = (message) => Number.isSafeInteger(message?.attachmentCount) && message.attachmentCount > 0 ? message.attachmentCount : 0;
const attachmentNotice = (count, delivery = false) => count ? `<p class="small muted">첨부 ${count}개는 보존됩니다. ${delivery ? '이 창에서는 첨부를 추가·교체하지 않습니다. 파일 열기는 현재 대화에서 확인해 주세요.' : '이 연결 시험에서는 사진·영상 열기·추가·교체를 지원하지 않습니다.'}</p>` : '';
// Current chat content is a read-only projection, never a replacement for the
// pinned clinical reference or an input to its next save.
const currentReferenceSource = (message) => Object.freeze({ messageId: message.id, messageType: message.type,
  revision: message.type === 'feedback' ? message.feedback.revision : message.version,
  ...(message.type === 'feedback' ? { feedbackId: message.feedback.id } : {}) });
const sameReferenceSource = (a, b) => !!a && !!b &&
  ['messageId', 'messageType', 'revision', 'feedbackId'].every(key => a[key] === b[key]);
const currentReferenceFiles = (message) => Array.isArray(message.attachments) && files(message) > 0 &&
  message.attachments.length === files(message) && message.attachments.length <= MEDIA_LIMITS.count
  ? message.attachments.map(({ id, name, type, size }) => Object.freeze({ id, name, type, size })) : [];
export function careReferenceSourceMarkup(message, checkedAt, delivery = false) {
  const feedback = message.type === 'feedback' ? message.feedback : null;
  const source = currentReferenceSource(message), attachments = delivery === true ? currentReferenceFiles(message) : [];
  return `<p class="small"><strong>${feedback ? `현재 활동 경험 ${esc(feedback.revision)}번째 내용` : `현재 ${esc(message.version)}번째 소식`}</strong></p>
    ${feedback ? `<p class="small">${esc(feedback.date)} · ${esc(results[feedback.result])}</p><p>${esc(feedback.reaction)}</p>${feedback.difficulty ? `<p>어려움 · ${esc(feedback.difficulty)}</p>` : ''}` : `<p>${esc(message.body || '첨부 소식')}</p>`}
    ${message.archived ? '<p class="small muted">공유가 종료된 소식입니다. 현재 치료사 열람 권한으로 확인한 내용입니다.</p>' : ''}
    ${attachments.length ? `<p class="small muted">현재 첨부 ${attachments.length}개 · 위의 당시 첨부와 다를 수 있습니다.</p><ul class="message-attachments" aria-label="현재 원문 첨부">${attachments.map(file => `<li><button type="button" data-open-current-reference-attachment="${esc(file.id)}" data-message-id="${esc(message.id)}" data-message-type="${esc(source.messageType)}" data-reference-revision="${source.revision}"${feedback ? ` data-feedback-id="${esc(source.feedbackId)}"` : ''}>현재 ${file.type.startsWith('image/') ? '사진' : '동영상'} 열기 · ${esc(file.name)}</button></li>`).join('')}</ul>` : files(message) ? `<p class="small muted">현재 첨부 ${files(message)}개 · 파일은 대화에서 확인해 주세요. 위의 당시 첨부와 다를 수 있습니다.</p>` : ''}
    <p class="small muted">${esc(checkedAt)} 조회 · 당시 참고와 작성 중인 기록은 바뀌지 않습니다.</p>`;
}
function messageAttachments(message, delivery) {
  const count = files(message);
  if (delivery !== true || !Array.isArray(message.attachments) || !message.attachments.length || message.attachments.length !== count)
    return attachmentNotice(count);
  return `<ul class="message-attachments" aria-label="첨부 파일">${message.attachments.map((file) => {
    const kind = file.type.startsWith('image/') ? '사진' : '동영상';
    return `<li><button type="button" data-open-attachment="${esc(file.id)}" data-message-id="${esc(message.id)}" aria-label="${kind} 열기: ${esc(file.name)}"><span class="attachment-kind">${kind} 열기</span><span>${esc(file.name)}</span></button></li>`;
  }).join('')}</ul>`;
}
const textActionLabels = { reply: '인용 답장', reference: '다음 기록에 참고', 'text-edit': '본문 수정',
  'text-delete-self': '나에게만 삭제', 'text-delete-all': '모두에게서 삭제', 'text-review': '반영 메모' };
const staleTextReview = '소식 또는 반영 메모가 바뀌어 이 입력으로는 저장할 수 없어요. 작성 내용은 보존했습니다. 필요한 내용을 확인한 뒤 입력 취소로 닫고 최신 반영 메모를 다시 열어 주세요.';
const staleFamilyPlan = '가족 관심사가 바뀌어 이 입력으로는 저장할 수 없어요. 작성 내용은 보존했습니다. 필요한 내용을 확인한 뒤 입력 취소로 닫고 최신 내용을 다시 열어 주세요.';
const staleGoal = '목표가 다른 화면에서 바뀌었어요. 작성한 입력과 최신 목표를 비교한 뒤 다시 검토해 주세요.';
const goalStatus = { active: '진행 중', achieved: '달성', paused: '잠시 보류' };
const goalValues = (goal) => ({ title: goal.title, description: goal.description, status: goal.status });
const appointmentStatus = { scheduled: '예정', attended: '완료', absent: '미참석', cancelled: '취소' };
const appointmentValues = (value) => Object.fromEntries(['date', 'time', 'duration', 'title', 'room', 'status'].map(key => [key, value[key]]));
const staleAppointment = '일정이 다른 화면에서 바뀌었어요. 작성한 입력과 최신 일정을 비교한 뒤 다시 검토해 주세요.';
const contextEditors = Object.freeze({
  __proto__: null,
  goal: { idKey: 'goalId', label: '목표', conflict: 'GOAL_CONFLICT', stale: staleGoal, values: goalValues },
  appointment: { idKey: 'appointmentId', label: '일정', conflict: 'APPOINTMENT_CONFLICT', stale: staleAppointment, values: appointmentValues },
});

// These are presentation guards, never an authorization source. The server
// authenticates and checks current capabilities/version again for each command.
export function careMessageActions(message, role, userId) {
  if (!message || !['therapist', 'guardian'].includes(role)) return [];
  if (message.type === 'text') {
    if (message.hidden || message.deleted) return message.deleted === true && message.canHide === true ? ['text-delete-self'] : [];
    const actions = [];
    if (message.canReply === true && !message.archived && version(message.version)) actions.push('reply');
    if (role === 'therapist' && version(message.version)) actions.push('reference');
    if (role === 'therapist' && message.authorId !== userId && version(message.version)) actions.push('text-review');
    if (message.authorId === userId && message.canEdit === true && version(message.version)) actions.push('text-edit');
    if (message.canHide === true) actions.push('text-delete-self');
    if (message.authorId === userId && message.canDeleteAll === true && version(message.version)) actions.push('text-delete-all');
    return actions;
  }
  if (message.hidden || message.deleted) return [];
  if (message.type === 'publication') return message.publication && !message.archived && message.canReply === true ? ['reply'] : [];
  if (message.type === 'feedback' && message.feedback) return [
    ...(message.canReply === true && !message.archived && version(message.feedback.revision) ? ['reply'] : []),
    ...(role === 'therapist' && version(message.feedback.revision) ? ['reference'] : []),
  ];
  return [];
}

function textMenu(message, role, userId) {
  const actions = careMessageActions(message, role, userId);
  return actions.length ? `<details class="care-message-menu"><summary>메시지 메뉴</summary><div class="care-actions">${actions.map((name) => action(name, textActionLabels[name], message.id)).join('')}</div></details>` : '';
}

export function careTextChange(view, values) {
  if (view.kind === 'text-edit') {
    if (!version(view.expectedRevision) || typeof values.body !== 'string' || values.body.length > 2000 || (!values.body.trim() && !view.attachmentCount))
      throw new Error('메시지 본문은 1~2000자로 입력해 주세요. 첨부가 있는 소식만 본문을 비울 수 있어요.');
    return { expectedRevision: view.expectedRevision, body: values.body.trim() };
  }
  if (view.kind !== 'text-delete' || !['self', 'all'].includes(view.scope) || values.confirmed !== true ||
      (view.scope === 'all' && !version(view.expectedRevision))) throw new Error('삭제 범위와 다른 사람에게 미치는 영향을 확인해 주세요.');
  return { scope: view.scope, confirmed: true, ...(view.scope === 'all' ? { expectedRevision: view.expectedRevision } : {}) };
}

export function careFamilyPlanContent(view, values) {
  if (view.stale) throw new Error(staleFamilyPlan);
  if (!Number.isSafeInteger(view.expectedRevision) || view.expectedRevision < 0 ||
      typeof values.concern !== 'string' || !values.concern.isWellFormed() || values.concern.length > 1000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(values.concern))
    throw new Error('가족이 바라는 변화를 1000자 이내로 입력해 주세요. 비워 두고 저장하면 현재 내용을 지웁니다.');
  return { expectedRevision: view.expectedRevision, concern: values.concern.trim() };
}

export function careTextReviewContent(view, values) {
  if (view.stale) throw new Error(staleTextReview);
  if (!version(view.expectedRevision) || !Number.isInteger(view.expectedReviewVersion) ||
      view.expectedReviewVersion < 0 || view.expectedReviewVersion >= 2147483647 ||
      typeof values.note !== 'string' || !values.note.isWellFormed() ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(values.note) || !values.note.trim() || values.note.length > 2000)
    throw new Error('확인한 소식에 대한 비공개 반영 메모를 1~2000자로 입력해 주세요.');
  return { expectedRevision: view.expectedRevision, expectedReviewVersion: view.expectedReviewVersion, note: values.note.trim() };
}

export function careReplyContent(view, values, attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > MEDIA_LIMITS.count ||
      attachments.some((file) => !file || Object.keys(file).length !== 1 || typeof file.id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(file.id)) ||
      new Set(attachments.map((file) => file.id)).size !== attachments.length) throw new Error('답장 첨부를 다시 확인해 주세요.');
  if (typeof values.body !== 'string' || (!values.body.trim() && !attachments.length) || values.body.length > 2000)
    throw new Error('답장을 1~2000자로 입력하거나 준비 완료된 사진·영상을 선택해 주세요.');
  if (!['text', 'publication', 'feedback'].includes(view.sourceType) ||
      (view.sourceType === 'text' && !version(view.expectedReplyVersion)) ||
      (view.sourceType === 'feedback' && !version(view.expectedReplyRevision))) throw new Error('답장할 원문을 다시 확인해 주세요.');
  return { body: values.body.trim(), replyTo: view.messageId,
    ...(view.sourceType === 'text' ? { expectedReplyVersion: view.expectedReplyVersion } : {}),
    ...(view.sourceType === 'feedback' ? { expectedReplyRevision: view.expectedReplyRevision } : {}),
    ...(attachments.length ? { attachments: attachments.map(({ id }) => ({ id })) } : {}) };
}

function activityMarkup(activity) {
  if (!activity) return '';
  return `<section class="care-activity"><h3>${esc(activity.title)}</h3><p>${esc(activity.instruction)}</p><p class="small">빈도 · ${esc(activity.frequency)}</p>${activity.caution ? `<p class="small">주의 · ${esc(activity.caution)}</p>` : ''}</section>`;
}

/** The existing chat owns the one message list and delegates these buttons. */
export function renderCareMessage(message, role, userId, delivery = false) {
  // The API separately projects only eligible text. Never display richer
  // injected DTOs or clinical state in this role's UI as a fallback.
  if (role === 'care_recipient') return message.type === 'text'
    ? `<p>${esc(message.deleted ? '삭제된 소식입니다.' : message.hidden ? '열람할 수 없는 이전 소식입니다.' : message.body)}</p>` : '';
  if (message.type === 'text') {
    const body = message.deleted ? '삭제된 소식입니다.' : message.hidden ? '열람할 수 없는 이전 소식입니다.' : message.body;
    const reviewStatus = !message.hidden && !message.deleted && (message.reviewed || role === 'therapist' && message.authorId !== userId)
      ? `<p class="small muted" data-text-review-status>${message.reviewed ? '다음 회기 반영 확인' : '반영 확인 전'}</p>` : '';
    return `${body ? `<p>${esc(body)}</p>` : ''}${!message.hidden && !message.deleted ? messageAttachments(message, delivery) : ''}${reviewStatus}${textMenu(message, role, userId)}`;
  }
  if (message.hidden || message.deleted) return `<p>${esc(message.body)}</p>`;
  const actions = careMessageActions(message, role, userId);
  if (message.type === 'publication' && message.publication) {
    const p = message.publication;
    return `<article class="care-publication" data-publication-id="${esc(p.id)}"><p class="eyebrow">${message.archived ? '이전 공유본' : '공유된 기록'} · ${esc(p.date ?? '')}</p><h3>${esc(p.title)}</h3><p>${esc(p.summary)}</p>${activityMarkup(p.activity)}${messageAttachments(message, delivery)}
      ${!message.archived ? `<div class="care-actions">${role === 'guardian' && p.activity ? action('feedback', '활동 경험 남기기', message.id) : ''}${actions.includes('reply') ? action('reply', '인용 답장', message.id) : ''}${role === 'therapist' ? action('withdraw', '공유 종료', message.id) : ''}</div>` : ''}</article>`;
  }
  if (message.type === 'feedback' && message.feedback) {
    const f = message.feedback;
    return `<article class="care-feedback" data-feedback-id="${esc(f.id)}"><p class="eyebrow">가정 활동 경험 · ${esc(f.date)} · ${esc(results[f.result] ?? '')}</p><p>${esc(f.reaction)}</p>${f.difficulty ? `<p>어려움 · ${esc(f.difficulty)}</p>` : ''}${messageAttachments(message, delivery)}<p class="small">${f.reviewed ? '치료사 검토됨' : '치료사 검토 전'} · ${f.revision}번째 내용</p>
      <div class="care-actions">${role === 'therapist' ? action('review', '임상 검토', message.id) : ''}${actions.includes('reply') ? action('reply', '인용 답장', message.id) : ''}${actions.includes('reference') ? action('reference', '다음 기록에 참고', message.id) : ''}${role === 'guardian' && message.authorId === userId && !message.archived ? action('edit-feedback', '활동 경험 수정', message.id) : ''}</div></article>`;
  }
  return '';
}

const field = (name, label, value = '', { textarea = true, required = false, max = 2000, type = 'text' } = {}) => `<label>${esc(label)}${textarea
  ? `<textarea name="${name}" maxlength="${max}" ${required ? 'required' : ''}>${esc(value)}</textarea>`
  : `<input name="${name}" type="${type}" value="${esc(value)}" maxlength="${max}" ${required ? 'required' : ''} />`}</label>`;
const select = (name, label, value, options) => `<label>${label}<select name="${name}">${options.map(([v, text]) => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
function assessmentRow(row, index) {
  const titles = ['도구', '항목', '측정값', '단위', '측정 조건'];
  return `<fieldset data-assessment-row><legend>측정값 ${index + 1}</legend><div class="care-grid">${assessmentKeys.map((key, i) => `<label>${titles[i]}<input data-assessment-field="${key}" name="assessment-${index}-${key}" value="${esc(row[key])}" ${key === 'value' ? 'inputmode="decimal"' : `maxlength="${key === 'context' ? 300 : 100}"`} /></label>`).join('')}</div>${action('remove-assessment', '측정값 삭제')}</fieldset>`;
}
export function renumberCareAssessments(container) {
  [...container.querySelectorAll('[data-assessment-row]')].forEach((row, index) => {
    row.querySelector('legend').textContent = `측정값 ${index + 1}`;
    row.querySelectorAll('[data-assessment-field]').forEach((input) => { input.name = `assessment-${index}-${input.dataset.assessmentField}`; });
  });
}
function recordValues(form, initial = {}) {
  const value = (name) => form.elements.namedItem(name)?.value ?? '';
  const activity = Object.fromEntries(['title', 'instruction', 'frequency', 'caution'].map((key) => [key, value(`activity${titleCase(key)}`)]));
  const observation = { status: value('observationStatus'), ...Object.fromEntries(observationKeys.map((key) => [key, value(`observation${titleCase(key)}`)])) };
  return { ...initial, ...Object.fromEntries(['date', 'title', 'goalId', 'performed', 'response', 'nextPlan', 'summary', 'privateNote'].map((key) => [key, value(key)])),
    observation: Object.values(observation).some(Boolean) ? observation : null,
    activity: Object.values(activity).some((v) => v.trim()) ? activity : null,
    assessments: [...form.querySelectorAll('[data-assessment-row]')].map((row) => Object.fromEntries(assessmentKeys.map((key) => [key, row.querySelector(`[data-assessment-field="${key}"]`).value]))) };
}
const safeMessage = (error) => ({ INVALID_INPUT: '입력을 확인해 주세요. 서버가 요청을 거부하여 저장하지 않았어요.',
  RECORD_CONFLICT: '다른 창에서 기록이 바뀌었어요. 입력은 보존했습니다. 최신 기록을 확인한 뒤 다시 작성해 주세요.',
  FEEDBACK_CONFLICT: '활동 경험이 바뀌었어요. 입력을 보존했습니다. 현재 내용을 다시 확인해 주세요.',
  REVIEW_CONFLICT: '임상 검토가 바뀌었어요. 입력을 보존했습니다. 현재 내용을 다시 확인해 주세요.',
  PROFILE_CONFLICT: staleFamilyPlan,
  GOAL_CONFLICT: staleGoal,
  APPOINTMENT_CONFLICT: staleAppointment,
  SCHEDULE_CONFLICT: '아동·담당 치료사·장소의 시간이 겹쳐 저장하지 않았어요. 입력은 보존했습니다. 날짜·시간·장소를 조정해 주세요.',
  THERAPIST_UNAVAILABLE: '현재 활성 담당 치료사를 확인할 수 없어 저장하지 않았어요. 센터에 담당 연결을 확인해 주세요.',
  REVISION_LIMIT: '변경 횟수 한도에 도달했어요. 저장하지 않았으며 입력을 보존했습니다. 운영자에게 문의해 주세요.',
  RECIPIENTS_CHANGED: '받는 보호자가 바뀌었어요. 공유하지 않았습니다. 받는 사람을 다시 확인해 주세요.',
  PUBLICATION_CLOSED: '이 공유가 종료되어 저장할 수 없어요. 입력은 이 창에 보존했습니다.',
  RECORD_NOT_SHAREABLE: '기록을 저장하고 보호자 요약을 입력한 뒤 공유해 주세요.',
  NO_RECIPIENT: '현재 공유를 받을 보호자가 없습니다.',
  CONTEXT_CHANGED: '목표나 일정이 바뀌었어요. 입력은 보존했습니다. 현재 연결을 확인한 뒤 다시 작성해 주세요.',
  REFERENCE_CHANGED: '참고할 소식이 바뀌었어요. 현재 내용을 다시 확인해 주세요.',
  EMPTY_RECORD: '기록할 내용을 입력해 주세요.',
  ATTACHMENTS_NOT_CONNECTED: '첨부가 있는 자료는 이 텍스트 전용 연결 시험에서 변경하거나 공유하지 않습니다.',
  NO_ACTIVITY: '이 공유본에는 연결된 가정 활동이 없습니다.',
  CONTEXT_NOT_FOUND: '연결할 목표나 일정이 없습니다. 현재 연결을 다시 확인해 주세요.',
  CONTEXT_LOADING: '기록에 연결할 목표를 확인하고 있어요. 잠시 후 다시 시도해 주세요.',
  APPOINTMENT_RECORD_EXISTS: '이 일정에 이미 연결된 기록이 있어요. 기존 기록을 확인해 주세요.',
  RECORD_IMPORT_REQUIRED: '이전 자료를 이 시험 화면에서 변경할 수 없습니다.',
  MESSAGE_CONFLICT: '원문이 변경되었어요. 입력은 보존했습니다. 최신 메시지를 확인한 뒤 다시 시도해 주세요.',
  MESSAGE_DELETED: '이미 삭제된 메시지입니다. 입력은 보존했습니다.',
  MESSAGE_CHANGE_EXPIRED: '수정·전체 삭제가 가능한 시간이 지났어요. 나에게만 삭제는 메시지 메뉴에서 확인해 주세요.',
  SOURCE_UNAVAILABLE: '현재 읽을 수 없는 원문에 연결된 입력을 닫았어요. 저장된 자료는 변경하지 않았습니다.',
  SOURCE_CHECK_UNAVAILABLE: '원문 열람 권한을 확인하지 못해 입력 화면을 가렸어요. 연결 뒤 다시 확인해 주세요.',
  RECEIPT_REJECTED: '서버가 요청을 거부해 저장하지 않았어요. 원문을 가린 뒤 보관하던 입력은 종료했습니다. 최신 소식을 확인한 뒤 다시 작성해 주세요.',
  ATTACHMENT_NOT_READY: '첨부 준비가 완료되지 않아 저장하지 않았어요. 파일 상태를 확인해 주세요.',
  ATTACHMENT_ORIGIN_CONFLICT: '다른 자료에 연결된 파일이 있어 저장하지 않았어요. 첨부 선택을 확인해 주세요.',
  ATTACHMENT_LIMIT: '첨부 개수나 합계 용량을 초과해 저장하지 않았어요.',
  UPLOAD_EXPIRED: '첨부 업로드가 만료되어 저장하지 않았어요. 만료된 업로드를 취소하고 다시 선택해 주세요.',
})[error?.code] ?? '처리 결과를 확인하지 못했어요. 입력을 바꾸지 않고 같은 요청으로 다시 확인해 주세요.';
const rejectedCareAttachment = (operation, error) => ['record', 'feedback', 'reply'].includes(operation?.kind) && error instanceof LocalApiError && error.status === 409 &&
  ['UPLOAD_EXPIRED', 'ATTACHMENT_NOT_READY', 'ATTACHMENT_ORIGIN_CONFLICT', 'ATTACHMENT_LIMIT'].includes(error.code);

export class CareUi {
  constructor({ api, getContext, onChanged = () => {}, onError = () => {}, onSourceUnavailable = () => {},
    mediaApi, deliveryEnabled = false, onOpenRecordAttachment = () => {}, onRecordViewClosed = () => {},
    onOpenFeedbackAttachment = () => {}, onOpenReferenceAttachment = () => {}, onOpenCurrentReferenceAttachment = () => {}, goalApi = null, appointmentApi = null }) {
    if (typeof deliveryEnabled !== 'boolean' || [onOpenRecordAttachment, onRecordViewClosed, onOpenFeedbackAttachment, onOpenReferenceAttachment, onOpenCurrentReferenceAttachment].some((callback) => typeof callback !== 'function') || deliveryEnabled && !mediaApi)
      throw new TypeError('Invalid record media options.');
    this.api = api; this.getContext = getContext; this.onChanged = onChanged; this.onError = onError;
    this.goalApi = goalApi;
    this.appointmentApi = appointmentApi;
    this.contextMarkup = new WeakMap();
    this.recordBaselines = new WeakMap();
    this.onSourceUnavailable = onSourceUnavailable;
    this.deliveryEnabled = deliveryEnabled; this.onOpenRecordAttachment = onOpenRecordAttachment; this.onRecordViewClosed = onRecordViewClosed;
    this.onOpenFeedbackAttachment = onOpenFeedbackAttachment; this.onOpenReferenceAttachment = onOpenReferenceAttachment;
    this.onOpenCurrentReferenceAttachment = onOpenCurrentReferenceAttachment;
    this.states = new Map(); this.host = null; this.painted = null; this.dialog = null; this.key = null; this.epoch = 0;
    this.click = (event) => { const b = event.target.closest('[data-care-action]'); if (b) void this.handleAction(b.dataset.careAction, b.dataset.recordId ?? b.dataset.messageId ?? b.dataset.appointmentId); };
    this.recordMedia = deliveryEnabled ? new MediaUploadUi({ api: mediaApi, purpose: 'record', deliveryEnabled: true,
      getContext: () => this.recordMediaContext(), onChanged: () => this.lockForm(), onError: (error) => this.fail(error) }) : null;
    this.feedbackMedia = deliveryEnabled ? new MediaUploadUi({ api: mediaApi, purpose: 'feedback', deliveryEnabled: true,
      getContext: () => this.feedbackMediaContext(), onChanged: () => this.lockForm(), onError: (error) => this.fail(error) }) : null;
    // The purpose is a client-only selection namespace; server uploads and
    // binding still use the ordinary authenticated message attachment flow.
    this.replyMedia = deliveryEnabled ? new MediaUploadUi({ api: mediaApi, purpose: 'reply', deliveryEnabled: true,
      getContext: () => this.replyMediaContext(), onChanged: () => this.lockForm(), onError: (error) => this.fail(error) }) : null;
  }
  recordMediaContext() {
    const context = this.getContext(), state = this.state(), view = state?.view;
    const recordView = ['record', 'record-cleanup'].includes(view?.kind);
    return { ...context, recordId: recordView ? view.recordId : state?.mutation.operation?.kind === 'record' ? state.mutation.operation.targetId : null,
      visible: !!this.dialog?.open && recordView && roleOf(context) === 'therapist' && identity(context) === this.key,
      cleanupOnly: view?.kind === 'record-cleanup',
      messageOperation: state?.mutation.operation ?? null };
  }
  recordScope(context = this.getContext()) { return { userId: context.user.userId, centerId: context.centerId, roomId: context.roomId }; }
  feedbackMediaContext() {
    const context = this.getContext(), state = this.state(), view = state?.view;
    const feedbackView = ['feedback', 'feedback-cleanup'].includes(view?.kind);
    return { ...context, feedbackId: feedbackView ? view.feedbackId : state?.mutation.operation?.kind === 'feedback' ? state.mutation.operation.targetId : null,
      visible: !!this.dialog?.open && feedbackView && roleOf(context) === 'guardian' && identity(context) === this.key,
      cleanupOnly: view?.kind === 'feedback-cleanup', messageOperation: state?.mutation.operation ?? null };
  }
  syncFeedbackMedia() {
    if (!this.feedbackMedia) return;
    const host = ['feedback', 'feedback-cleanup'].includes(this.state()?.view?.kind) ? this.dialog?.querySelector('[data-feedback-upload]') : null;
    this.feedbackMedia.bind(host ?? null); this.feedbackMedia.update();
  }
  replyMediaContext() {
    const context = this.getContext(), state = this.state(), view = state?.view;
    const replyView = ['reply', 'reply-cleanup'].includes(view?.kind);
    return { ...context, replyDraftId: replyView ? view.replyDraftId : state?.replyDraftId,
      visible: !!this.dialog?.open && replyView && ['therapist', 'guardian'].includes(roleOf(context)) && identity(context) === this.key,
      cleanupOnly: view?.kind === 'reply-cleanup', messageOperation: state?.mutation.operation ?? null };
  }
  syncReplyMedia() {
    if (!this.replyMedia) return;
    const host = ['reply', 'reply-cleanup'].includes(this.state()?.view?.kind) ? this.dialog?.querySelector('[data-reply-upload]') : null;
    this.replyMedia.bind(host ?? null); this.replyMedia.update();
  }
  syncRecordMedia() {
    if (!this.recordMedia) return;
    const host = ['record', 'record-cleanup'].includes(this.state()?.view?.kind) ? this.dialog?.querySelector('[data-record-upload]') : null;
    this.recordMedia.bind(host ?? null); this.recordMedia.update();
  }
  retainRooms(userId, centerId, allowedRoomIds) {
    if (![userId, centerId].every((value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)) ||
        !Array.isArray(allowedRoomIds) || allowedRoomIds.some((value) => typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) ||
        new Set(allowedRoomIds).size !== allowedRoomIds.length) throw new TypeError('Invalid authorized room list.');
    this.recordMedia?.retainRooms(userId, centerId, allowedRoomIds);
    this.feedbackMedia?.retainRooms(userId, centerId, allowedRoomIds);
    this.replyMedia?.retainRooms(userId, centerId, allowedRoomIds);
    for (const key of [...this.states.keys()]) {
      const [user, center, room] = JSON.parse(key);
      if (user !== userId || center !== centerId || allowedRoomIds.includes(room)) continue;
      if (this.key === key) this.suspend();
      this.clearComparison(this.states.get(key));
      this.states.delete(key); if (this.key === key) this.key = null;
    }
  }
  bind(host) {
    if (this.host === host) return;
    this.host?.removeEventListener('click', this.click); this.host = host; this.painted = null;
    this.host?.addEventListener('click', this.click);
  }
  state() { return this.states.get(this.key); }
  current(context, epoch = this.epoch) {
    const next = this.getContext();
    return epoch === this.epoch && identity(next) === identity(context) && this.key === identity(context) &&
      next?.generation === context.generation && next.connected && !context.signal?.aborted;
  }
  update(context = this.getContext()) {
    if (!identity(context) || !context.connected) { this.suspend(); return; }
    if ((this.owner && this.owner !== context.user.userId) || (this.ownerRole && this.ownerRole !== roleOf(context))) this.clear();
    this.owner = context.user.userId; this.ownerRole = roleOf(context);
    const key = identity(context);
    if (this.key !== key) { this.suspend(); this.key = key; }
    if (!this.states.has(key)) this.states.set(key, { mutation: new CareMutation(), records: [], goals: [], appointments: [], loaded: false, loading: false, view: null });
    const state = this.state();
    if (this.referenceSource && !this.referenceSourceCurrent(this.referenceSource))
      this.clearReferenceSource('대화가 변경되어 현재 원문 보기를 닫았어요. 다시 조회해 주세요.');
    const supplied = context.careData !== undefined;
    if (supplied) {
      // The owner publishes one authorized workspace snapshot. A late legacy
      // list request must not replace any part of that coherent projection.
      state.loadRequest = null; state.loading = false;
      const data = context.careData;
      state.loaded = !!data && ['goals', 'records', 'appointments'].every((key) => Array.isArray(data[key]));
      for (const key of ['goals', 'records', 'appointments']) state[key] = state.loaded ? clone(data[key]) : [];
    }
    this.reconcileComparison(context, state);
    this.render();
    if (state.view) void this.guardView(context, state);
    if (!supplied && roleOf(context) === 'therapist' && !state.loading) void this.load(context);
  }
  receiptOnly(state) {
    if (!state.mutation.operation) return;
    const visible = this.dialog?.open;
    state.view = { kind: 'receipt', values: {} };
    this.wipeDialog();
    if (visible) this.display();
  }
  async canReadView(context, view, check = {}) {
    const args = [context.centerId, context.roomId];
    const readable = (message) => message && message.conversationId === context.roomId && !message.hidden && !message.deleted;
    const source = async (id) => {
      const message = await this.api.message(...args, id, context.signal);
      return message?.id === id && readable(message) ? message : null;
    };
    if (view.requiresProfileCheck) {
      check.profileChecked = false;
      if (roleOf(context) !== (view.profileRole ?? 'therapist')) return false;
      const profile = await this.api.profile(...args, context.signal);
      if (!view.profileChildId || profile?.childId !== view.profileChildId || profile.conversationId !== context.roomId) return false;
      check.profileChecked = true;
    }
    // Cleanup exposes only this authorized room's retained upload selections,
    // not clinical/source content. Each status/cancel still rechecks on server.
    if (['receipt', 'record-cleanup', 'feedback-cleanup'].includes(view.kind)) return true;
    if (view.kind === 'reply-cleanup') {
      if (!['therapist', 'guardian'].includes(roleOf(context))) return false;
      const profile = await this.api.profile(...args, context.signal);
      return profile?.conversationId === context.roomId && profile.childId === context.profile?.childId;
    }
    if (contextEditors[view.kind]) {
      if (roleOf(context) !== 'therapist') return false;
      if (view.expectedRevision === 0 && !view.stale) {
        const profile = await this.api.profile(...args, context.signal);
        return profile?.childId === view.childId && profile.conversationId === context.roomId;
      }
      const targetId = view[contextEditors[view.kind].idKey];
      const latest = await this[view.kind + 'Api'][view.kind](...args, targetId, context.signal);
      if (latest?.id !== targetId || latest.childId !== view.childId || latest.conversationId !== context.roomId) return false;
      view.latest = latest;
      if (latest.revision !== view.expectedRevision) view.stale = true;
      return true;
    }
    if (view.kind === 'family-plan') {
      if (roleOf(context) !== 'guardian') return false;
      const plan = await this.api.familyPlan(...args, context.signal);
      if (plan?.childId !== view.childId || plan.conversationId !== context.roomId) return false;
      if (plan.revision !== view.expectedRevision) view.stale = true;
      return true;
    }
    if (view.kind === 'record') {
      // A saved clinical snapshot has independent read authority. Hiding its
      // original chat source must not remove that authorized clinical record.
      if (view.expectedRevision > 0) {
        const record = await this.api.record(...args, view.recordId, context.signal);
        return record?.id === view.recordId && record.conversationId === context.roomId;
      }
      if (view.templateSource) {
        const { recordId, revision } = view.templateSource;
        const record = await this.api.record(...args, recordId, context.signal, revision);
        if (record?.id !== recordId || record.conversationId !== context.roomId || record.revision !== revision) return false;
      }
      if (view.values.appointmentId) await this.currentAppointment(context, view.values.appointmentId);
      for (const reference of view.references) if (!await source(reference.messageId)) return false;
      return true;
    }
    if (view.kind === 'publish') {
      const preview = await this.api.recordPreview(...args, view.preview.recordId, context.signal);
      return preview?.recordId === view.preview.recordId;
    }
    if (view.kind === 'feedback') {
      const publication = await source(view.sourceMessageId);
      if (publication?.type !== 'publication' || publication.archived) return false;
      if (!view.expectedRevision) return true;
      const message = await this.api.feedback(...args, view.feedbackId, context.signal);
      return readable(message) && message.feedback?.id === view.feedbackId && message.authorId === context.user.userId;
    }
    if (view.kind === 'review') {
      const review = await this.api.feedbackReview(...args, view.feedbackId, context.signal);
      if (review?.feedbackId !== view.feedbackId) return false;
      const message = await this.api.feedback(...args, view.feedbackId, context.signal);
      return readable(message) && message.feedback?.id === view.feedbackId;
    }
    if (view.kind === 'text-review') {
      // Permission is rechecked independently of the form's immutable source
      // and review versions. Never replace unsaved text with a later note.
      let review;
      try { review = await this.api.textReview(...args, view.messageId, context.signal); }
      catch (error) { if (error?.code === 'MESSAGE_DELETED') return false; throw error; }
      if (review?.messageId !== view.messageId || review.conversationId !== context.roomId) return false;
      if (review.revision !== view.expectedRevision || review.reviewVersion !== view.expectedReviewVersion) view.stale = true;
      return true;
    }
    if (view.kind === 'text-delete' && view.scope === 'self' && view.sourceDeleted === true) {
      const message = await this.api.message(...args, view.messageId, context.signal);
      return message?.id === view.messageId && message.conversationId === context.roomId &&
        message.type === 'text' && message.deleted === true && message.canHide === true;
    }
    const message = await source(view.messageId);
    if (!message) return false;
    if (view.kind === 'reply') return message.type === view.sourceType && message.canReply === true && !message.archived;
    if (view.kind === 'withdraw') return message.type === 'publication';
    return ['text-edit', 'text-delete'].includes(view.kind) && message.type === 'text';
  }
  guardView(context, state = this.state()) {
    if (!state?.view || !this.current(context)) return Promise.resolve(false);
    // Unknown operations need a receipt, not fresh source permission. Never
    // reveal their cached source or replace the immutable request while retrying.
    if (state.mutation.operation) {
      if (state.view.kind !== 'receipt') this.receiptOnly(state);
      return Promise.resolve(true);
    }
    const view = state.view, epoch = this.epoch;
    if (state.readCheck?.view === view && state.readCheck.epoch === epoch) return state.readCheck.promise;
    const check = { view, epoch, promise: null };
    state.readCheck = check;
    const current = () => this.current(context, epoch) && roleOf(this.getContext()) === roleOf(context) &&
      state.view === view && state.readCheck === check;
    check.promise = (async () => {
      try {
        const allowed = await this.canReadView(context, view, check);
        if (!current()) return false;
        if (state.mutation.operation) { this.receiptOnly(state); return true; }
        if (allowed) {
          if (view.kind === 'text-review' && view.stale) { this.notice(staleTextReview); this.lockForm(); }
          if (view.kind === 'family-plan' && view.stale) { this.notice(staleFamilyPlan); this.lockForm(); }
          if (contextEditors[view.kind]) { this.contextComparison(view.kind); this.lockForm(); if (view.stale) this.notice(contextEditors[view.kind].stale); }
          return true;
        }
        if (view.requiresProfileCheck && !check.profileChecked) this.fail(new LocalApiError('FORBIDDEN', 403));
        else this.sourceUnavailable(state);
      } catch (error) {
        if (!current()) return false;
        if (error?.code === 'AUTH_REQUIRED') { this.fail(error); return false; }
        if (state.mutation.operation) { this.receiptOnly(state); return true; }
        if (['NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) {
          if (view.requiresProfileCheck && !check.profileChecked) this.fail(error);
          else this.sourceUnavailable(state);
        } else {
          // A failed read is not a confirmed loss of permission. Keep the
          // draft only in memory, with all source projections removed from DOM.
          this.snapshot(); this.wipeDialog(); this.render(); this.fail({ code: 'SOURCE_CHECK_UNAVAILABLE' });
        }
      } finally { if (state.readCheck === check) state.readCheck = null; }
      return false;
    })();
    return check.promise;
  }
  sourceUnavailable(state) {
    const replyDraftId = state.view?.kind === 'reply' ? state.view.replyDraftId : null;
    const replyCleanup = replyDraftId && this.replyMedia?.hasReplySelections(this.recordScope(), replyDraftId);
    if (['record', 'record-cleanup'].includes(state.view?.kind)) {
      const scope = this.recordScope(); this.recordMedia?.clearRoom(scope.userId, scope.centerId, scope.roomId);
    }
    if (['feedback', 'feedback-cleanup'].includes(state.view?.kind)) {
      const scope = this.recordScope(); this.feedbackMedia?.clearRoom(scope.userId, scope.centerId, scope.roomId);
    }
    if (state.view?.kind === 'reply-cleanup') {
      const scope = this.recordScope(); this.replyMedia?.clearRoom(scope.userId, scope.centerId, scope.roomId);
    }
    this.wipeDialog();
    // A closed source cannot be shown again. Keep only the upload namespace,
    // so a still-authorized room may cancel its retained, unbound selections.
    state.view = replyCleanup ? { kind: 'reply-cleanup', replyDraftId, values: {} } : null;
    if (!replyCleanup) state.replyDraftId = null;
    this.render(); this.fail({ code: 'SOURCE_UNAVAILABLE' });
    // Notify only after the source and draft are gone. The owner can now
    // synchronously invalidate other projections (for example inbox previews).
    // A failed follow-up must never restore the rejected source or old epoch.
    try { void Promise.resolve(this.onSourceUnavailable()).catch(() => {}); } catch { /* already safely cleared */ }
  }
  async restoreView(context, state) {
    const opening = {}, epoch = this.epoch;
    state.opening = opening; this.render();
    try {
      if (await this.guardView(context, state) && this.current(context, epoch) && state.opening === opening && state.view) this.display();
    } finally {
      if (state.opening === opening) { state.opening = null; if (this.current(context, epoch)) this.render(); }
    }
  }
  async load(context) {
    const state = this.state(), epoch = this.epoch;
    if (!state || state.loading) return;
    const request = {}; state.loadRequest = request; state.loading = true;
    const current = () => this.current(context, epoch) && state.loadRequest === request;
    try {
      const [goals, records] = await Promise.all([this.api.goals(context.centerId, context.roomId, context.signal), this.api.records(context.centerId, context.roomId, context.signal)]);
      if (!current()) return;
      state.goals = goals; state.records = records; state.loaded = true; this.reconcileComparison(context, state); this.render();
    } catch (error) { if (current()) this.fail(error); }
    finally { if (state.loadRequest === request) { state.loadRequest = null; state.loading = false; } }
  }
  snapshot() {
    const state = this.state(), form = this.dialog?.querySelector('form');
    if (!state?.view || !form) return;
    if (state.view.kind === 'record') state.view.values = recordValues(form, state.view.values);
    else state.view.values = { ...state.view.values, ...Object.fromEntries([...form.elements].filter((el) => el.name && !['submit', 'button'].includes(el.type)).map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.value])) };
  }
  wipeDialog() {
    this.clearReferenceSource();
    // The owner's care-dialog viewer must revoke its displayed object URL before
    // this source disappears, not wait for a later workspace polling cycle.
    try { this.onRecordViewClosed(); } catch { /* Never block source/DOM cleanup. */ }
    this.recordMedia?.bind(null);
    this.feedbackMedia?.bind(null);
    this.replyMedia?.bind(null);
    if (!this.dialog) return;
    this.dialog.querySelectorAll('input,textarea,select').forEach((node) => { node.value = ''; if ('checked' in node) node.checked = false; });
    if (this.dialog.open) this.dialog.close();
    this.dialog.replaceChildren();
  }
  suspend() {
    this.snapshot(); this.epoch++; this.painted = null;
    const state = this.state();
    if (state) {
      state.sharePreparation = null;
      this.clearComparison(state);
      state.mutation.failed(state.mutation.operation); state.records = []; state.goals = []; state.appointments = []; state.loaded = false;
      state.loadRequest = null; state.loading = false;
      state.opening = null; state.readCheck = null;
      if (state.mutation.operation) state.view = { kind: 'receipt', values: {} };
    }
    this.wipeDialog(); this.host?.replaceChildren();
  }
  clear() {
    this.suspend(); this.recordMedia?.clear(); this.feedbackMedia?.clear(); this.replyMedia?.clear(); this.states.clear(); this.key = null; this.owner = null; this.ownerRole = null;
    this.dialog?.remove(); this.dialog = null;
  }
  render() {
    const context = this.getContext(), state = this.state();
    if (!this.host || !state || !context.connected || identity(context) !== this.key) return;
    const readNotice = state.readNotice ? `<p data-care-status role="status">${esc(state.readNotice)}</p>` : '';
    if (roleOf(context) !== 'therapist') {
      this.paintHost(`<p class="care-hint small muted">공유된 기록에서 가정 활동 경험을 남길 수 있어요.</p>${state.view ? action('resume', state.mutation.operation ? '처리 중인 입력 확인' : '입력 이어쓰기') : ''}${readNotice}`, !!state.opening);
      return;
    }
    const compact = context.panelMode === 'compact';
    const controls = `<div class="care-actions">${action('new-record', '기록하기', null, `class="primary" ${!state.loaded || !state.goals.length ? 'disabled' : ''}`)}${state.view ? action('resume', state.mutation.operation ? '처리 중인 입력 확인' : '입력 이어쓰기') : ''}</div>`;
    const recordRow = (r) => `<article class="care-record" data-record-id="${esc(r.id)}"><div><h4>${esc(r.title)}</h4><p class="small muted"><time datetime="${esc(r.date)}">${esc(r.date)}</time> · ${r.status === 'draft' ? '임시저장' : '저장됨'} · ${r.revision}번째 기록</p></div><div class="care-actions">${action('edit-record', '기록 열기', null, `data-record-id="${esc(r.id)}"`)}${action('reuse-record', '양식으로 새 기록', null, `data-record-id="${esc(r.id)}" ${!state.loaded || !state.goals.length || !version(r.revision) ? 'disabled' : ''}`)}${r.status === 'saved' ? action('preview-record', '공유 미리보기', null, `data-record-id="${esc(r.id)}"`) : ''}</div></article>`;
    const groups = compact ? [] : [['작성 중인 기록', state.records.filter((r) => r.status === 'draft')],
      ['저장한 기록', state.records.filter((r) => r.status !== 'draft')]];
    const recordList = compact ? '' : `<div class="care-record-list">${groups.filter(([, records]) => records.length).map(([title, records]) => `<section class="care-record-group" aria-label="${title}"><header class="care-record-section-head"><h3>${title}</h3><span class="small muted">${records.length}개</span></header>${records.map(recordRow).join('')}</section>`).join('')}${state.loaded && !state.records.length ? `<div class="care-record-empty"><h3>아직 기록이 없어요</h3><p class="small muted">${state.goals.length ? '활동·아이의 반응·다음 계획을 남기면 이곳에서 이어서 확인할 수 있어요.' : '목표를 만든 뒤 첫 관찰을 남겨 보세요.'}</p></div>` : ''}</div>`;
    this.paintHost(`<section class="care-panel${compact ? ' care-panel-compact' : ' care-record-workspace'}" aria-label="치료사 기록">${compact ? controls : `<header class="care-record-toolbar"><div><h3>치료 기록</h3><p class="small muted">활동 · 반응 · 다음 계획</p></div>${controls}</header>`}<p class="small muted">${compact ? '치료사 전용 · 공유 전 미리보기' : '기록은 치료사만 볼 수 있어요. 보호자에게는 미리보기로 확인한 내용만 공유합니다.'}</p>
      ${readNotice}${!state.loaded ? '<p role="status">기록과 목표를 확인하고 있어요…</p>' : !state.goals.length ? `<p>기록을 시작하려면 함께 확인할 목표를 먼저 만들어 주세요.</p>${action('new-goal', '첫 목표 만들기')}` : ''}
      ${recordList}${!compact && state.loaded ? careMeasurementMarkup(state.comparison) : ''}</section>`, !!state.opening);
  }
  paintHost(markup, opening) {
    // Cache generated markup, not browser-serialized HTML. Skipping this DOM
    // write must never skip update()'s independent source permission checks.
    if (this.painted?.markup === markup && this.painted.opening === opening) return;
    const active = this.host.ownerDocument.activeElement;
    const focus = this.host.contains(active) ? active?.closest('[data-care-action]')?.dataset : null;
    // This static help belongs to the current host only; bind/suspend/authority
    // changes invalidate painted and must not carry its disclosure to a new room.
    const help = this.painted ? this.host.querySelector?.('.care-comparison-help') : null;
    const helpOpen = help?.open === true, helpFocused = !!help && active === help.querySelector('summary');
    this.host.innerHTML = markup;
    const nextHelp = help ? this.host.querySelector?.('.care-comparison-help') : null;
    if (nextHelp) { nextHelp.open = helpOpen; if (helpFocused) nextHelp.querySelector('summary')?.focus({ preventScroll: true }); }
    if (opening) {
      this.host.querySelectorAll('[data-care-action]').forEach((button) => { button.disabled = true; });
      const status = this.host.ownerDocument.createElement('p'); status.setAttribute('role', 'status');
      status.textContent = '기록 내용을 확인하고 있어요…'; this.host.append(status);
    }
    this.painted = { markup, opening };
    if (focus?.careAction) [...this.host.querySelectorAll('[data-care-action]')].find((b) => !b.disabled && b.dataset.careAction === focus.careAction && b.dataset.recordId === focus.recordId)?.focus({ preventScroll: true });
  }
  ensureDialog() {
    if (this.dialog?.isConnected) return;
    const document = this.host.ownerDocument;
    this.dialog = document.createElement('dialog'); this.dialog.className = 'care-dialog';
    this.dialog.dataset.testid = 'care-dialog'; this.dialog.setAttribute('aria-labelledby', 'care-dialog-title');
    this.dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(); });
    this.dialog.addEventListener('click', (event) => {
      const currentReferenceAttachment = event.target.closest('[data-open-current-reference-attachment]');
      if (currentReferenceAttachment) { const d = currentReferenceAttachment.dataset; void this.openCurrentReferenceAttachment(d.messageId, d.openCurrentReferenceAttachment); return; }
      const feedbackAttachment = event.target.closest('[data-open-feedback-attachment]');
      if (feedbackAttachment) { const d = feedbackAttachment.dataset; void this.openFeedbackAttachment(d.feedbackId, d.messageId, Number(d.feedbackRevision), d.openFeedbackAttachment); return; }
      const referenceAttachment = event.target.closest('[data-open-reference-attachment]');
      if (referenceAttachment) { void this.openReferenceAttachment(referenceAttachment.dataset.messageId, referenceAttachment.dataset.openReferenceAttachment); return; }
      const attachment = event.target.closest('[data-open-record-attachment]');
      if (attachment) { void this.openRecordAttachment(attachment.dataset.openRecordAttachment); return; }
      const button = event.target.closest('[data-care-action]'); if (!button) return;
      if (button.dataset.careAction === 'close') this.close();
      else if (button.dataset.careAction === 'edit-preview-record') void this.editPreviewRecord();
      else if (button.dataset.careAction === 'reference-source') void this.toggleReferenceSource(button.dataset.messageId);
      else if (button.dataset.careAction === 'discard' && !this.state()?.mutation.operation) {
        this.discard();
      }
      else if (button.dataset.careAction === 'retry') void this.mutate();
      else if (button.dataset.careAction === 'goal-refresh') void this.refreshGoal();
      else if (button.dataset.careAction === 'appointment-refresh') void this.refreshContext('appointment');
      else if (button.dataset.careAction === 'record-context-refresh') void this.refreshRecordContext();
      else if (['goal-keep', 'goal-replace'].includes(button.dataset.careAction)) this.compareGoal(button.dataset.careAction === 'goal-keep');
      else if (['appointment-keep', 'appointment-replace'].includes(button.dataset.careAction)) this.compareContext('appointment', button.dataset.careAction === 'appointment-keep');
      else if (button.dataset.careAction === 'add-assessment') this.addAssessment();
      else if (button.dataset.careAction === 'remove-assessment') this.removeAssessment(button);
      else if (button.dataset.careAction === 'remove-record-attachment') this.removeRecordAttachment(button.dataset.attachmentId);
      else if (button.dataset.careAction === 'remove-feedback-attachment') this.removeFeedbackAttachment(button.dataset.attachmentId);
      else if (button.dataset.careAction === 'use-record-title') this.useRecordTitleSuggestion();
    });
    this.dialog.addEventListener('input', (event) => {
      this.updateRecordDisclosure(); this.updateRecordTitleSuggestion(event);
    });
    this.dialog.addEventListener('compositionend', (event) => this.updateRecordTitleSuggestion(event));
    this.dialog.addEventListener('change', (event) => {
      this.updateRecordDisclosure();
      this.updateRecordTitleSuggestion(event);
      if (event.target.dataset?.recordShare) this.setRecordShare(event.target.dataset.recordShare, event.target.checked);
      if (event.target.name === 'goalId' && this.state()?.view?.kind === 'record') {
        this.snapshot();
        const section = this.dialog.querySelector('[data-record-context]');
        if (section) section.innerHTML = this.recordContextMarkup(this.state().view);
      }
    });
    this.dialog.addEventListener('submit', (event) => { event.preventDefault(); void this.submit(event.submitter); });
    document.body.append(this.dialog);
  }
  close() {
    const state = this.state();
    this.snapshot();
    const unchanged = this.canCloseUnchangedRecord(state);
    if (state) state.sharePreparation = null;
    if (state?.view?.kind === 'record') state.view.contextRefresh = null;
    if (unchanged) state.view = null;
    this.wipeDialog(); this.render();
  }
  canCloseUnchangedRecord(state) {
    const view = state?.view, mutation = state?.mutation, context = this.getContext();
    if (view?.kind !== 'record' || view.values?.status !== 'saved' || !version(view.expectedRevision) || !this.recordBaselines.has(view) ||
        !this.dialog?.open || !this.dialog.querySelector('form') || !this.current(context) || roleOf(context) !== 'therapist' ||
        this.dialog.querySelector('[data-care-error]')?.textContent?.trim() ||
        state.opening || state.readCheck || state.readNotice || state.sharePreparation ||
        view.error || view.stale || view.contextStale || view.contextRefresh || view.contextRefreshed ||
        view.requiresProfileCheck || view.templateSource || !mutation || mutation.operation !== null ||
        mutation.sending !== false || mutation.uncertain !== false || mutation.everUncertain !== false) return false;
    try {
      if (this.recordMedia && (this.recordMedia.busy ||
          this.recordMedia.hasRecordSelections(this.recordScope(context), view.recordId) !== false)) return false;
      return this.recordBaselines.get(view) === JSON.stringify(view.values);
    } catch { return false; } // An unconfirmed comparison must preserve the input.
  }
  async editPreviewRecord() {
    const state = this.state(), context = this.getContext();
    if (state?.view?.kind !== 'publish' || state.opening || state.mutation.operation ||
        !this.current(context) || roleOf(context) !== 'therapist') return;
    const recordId = state.view.preview.recordId;
    // Editing leaves the public projection behind, including its confirmation.
    // Reload the authorized record through the existing editor path; never
    // reconstruct clinical fields from a public summary or publish implicitly.
    if (this.discard()) await this.handleAction('edit-record', recordId);
  }
  refreshGoal() { return this.refreshContext('goal'); }
  async refreshContext(kind) {
    const state = this.state(), context = this.getContext();
    if (!contextEditors[kind] || state?.view?.kind !== kind || state.mutation.operation || !this.current(context)) return;
    this.snapshot(); await this.guardView(context, state);
  }
  async refreshRecordContext() {
    const state = this.state(), context = this.getContext(), view = state?.view, epoch = this.epoch;
    if (view?.kind !== 'record' || roleOf(context) !== 'therapist' || !this.current(context) ||
        state.mutation.operation || view.contextRefresh) return;
    this.snapshot();
    const selectedId = view.values.goalId;
    if (!view.goals.some(goal => goal.id === selectedId)) { this.notice('연결 목표를 선택해 주세요.'); return; }
    const request = {}; view.contextRefresh = request; this.lockForm();
    const current = () => this.current(context, epoch) && roleOf(this.getContext()) === 'therapist' && state.view === view &&
      view.contextRefresh === request && !state.mutation.operation;
    try {
      view.requiresProfileCheck = true; view.profileChildId = context.profile?.childId;
      if (!await this.guardView(context, state) || !current()) return;
      if (!this.goalApi) {
        const { GoalApiClient } = await import('./goal-client.js');
        if (!current()) return;
        this.goalApi = new GoalApiClient(this.api);
      }
      const goal = await this.goalApi.goal(context.centerId, context.roomId, selectedId, context.signal);
      if (!current()) return;
      if (goal?.id !== selectedId || goal.childId !== view.profileChildId ||
          goal.conversationId !== context.roomId || !version(goal.revision)) throw new LocalApiError('INVALID_RESPONSE');
      const appointment = view.values.appointmentId ? await this.currentAppointment(context, view.values.appointmentId) : null;
      if (!current()) return;
      // Explicitly refresh only selection metadata, never authored observations,
      // saved snapshots, references, attachments or the record's own revision.
      view.goals = view.goals.map(item => item.id === selectedId ? clone(goal) : item);
      if (appointment) { view.appointment = appointment; view.expectedAppointmentRevision = appointment.revision; }
      view.contextStale = false; view.contextRefreshed = true; view.error = '';
      this.display(); this.notice('최신 목표·일정을 불러왔어요. 내용을 확인한 뒤 저장해 주세요.');
    } catch (error) {
      if (!current()) return;
      if (['NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) this.sourceUnavailable(state);
      else {
        this.snapshot(); this.wipeDialog(); this.render(); this.fail(error?.code === 'AUTH_REQUIRED' ? error : { code: 'SOURCE_CHECK_UNAVAILABLE' });
      }
    } finally {
      if (view.contextRefresh === request) view.contextRefresh = null;
      if (this.current(context, epoch) && state.view === view) this.lockForm();
    }
  }
  recordContextMarkup(view) {
    const goal = view.goals.find(item => item.id === view.values.goalId);
    return `<p>${view.contextStale ? '목표나 일정이 바뀌어 저장하지 않았어요. 최신 내용을 확인한 뒤 다시 저장해 주세요.' : '이번에 연결할 목표·일정을 확인해 주세요. 아직 저장하지 않았습니다.'}</p>${goal ? `<strong>${esc(goal.title)}</strong><p>${esc(goal.description ?? '')}</p><p class="small muted">${esc(goalStatus[goal.status] ?? '')} · ${goal.revision}번째 목표</p>` : ''}${action('record-context-refresh', '목표·일정 다시 확인')}`;
  }
  goalComparison() { this.contextComparison('goal'); }
  contextComparison(kind) {
    const config = contextEditors[kind], view = this.state()?.view, section = this.dialog?.querySelector('[data-' + kind + '-conflict]');
    if (!config || view?.kind !== kind || !section) return;
    section.hidden = !view.stale;
    const latest = view.latest;
    const details = latest ? kind === 'goal'
      ? `<p>${esc(latest.description)}</p><p class="small">${esc(goalStatus[latest.status])} · ${latest.revision}번째 내용</p>`
      : `<p>${esc(latest.date)} · ${esc(latest.time)} · ${esc(latest.duration)}분 · ${esc(latest.room)}</p><p class="small">${esc(appointmentStatus[latest.status])} · ${latest.revision}번째 내용</p>` : '';
    const html = !view.stale ? '' : `<p class="care-error">${esc(config.stale)}</p>${latest
      ? `<h3>서버의 최신 ${config.label}</h3><div data-${kind}-latest><strong>${esc(latest.title)}</strong>${details}</div><p class="small muted">입력을 유지해도 저장 버튼을 다시 눌러야 반영됩니다.</p><div class="care-actions">${action(kind + '-keep', '현재 입력 유지하고 다시 검토')}${action(kind + '-replace', '최신 내용으로 바꾸기')}</div>`
      : '<p class="small muted">최신 내용을 확인해 주세요. 작성한 입력은 유지됩니다.</p>'}${action(kind + '-refresh', '최신 ' + config.label + ' 확인')}`;
    if (this.contextMarkup.get(section) !== html) { section.innerHTML = html; this.contextMarkup.set(section, html); }
  }
  compareGoal(keepInput) { this.compareContext('goal', keepInput); }
  compareContext(kind, keepInput) {
    const state = this.state(), view = state?.view;
    if (!contextEditors[kind] || !this.current(this.getContext()) || state?.mutation.operation || view?.kind !== kind || !view.stale || !view.latest) return;
    this.snapshot(); view.expectedRevision = view.latest.revision;
    if (!keepInput) view.values = contextEditors[kind].values(view.latest);
    view.stale = false; view.error = ''; this.display();
  }
  discard() {
    const state = this.state(); if (!state?.view || state.mutation.operation) return false;
    if (['record', 'record-cleanup'].includes(state.view.kind) && this.recordMedia?.hasRecordSelections(this.recordScope(), state.view.recordId)) {
      this.notice('먼저 첨부 선택을 취소해 주세요. 업로드한 파일은 서버의 취소 확인 뒤 선택에서 제거합니다.'); return false;
    }
    if (['feedback', 'feedback-cleanup'].includes(state.view.kind) && this.feedbackMedia?.hasFeedbackSelections(this.recordScope(), state.view.feedbackId)) {
      this.notice('먼저 첨부 선택을 취소해 주세요. 업로드한 파일은 서버의 취소 확인 뒤 선택에서 제거합니다.'); return false;
    }
    if (['reply', 'reply-cleanup'].includes(state.view.kind) && this.replyMedia?.hasReplySelections(this.recordScope(), state.view.replyDraftId)) {
      this.notice('먼저 첨부 선택을 취소해 주세요. 업로드한 파일은 서버의 취소 확인 뒤 선택에서 제거합니다.'); return false;
    }
    this.wipeDialog(); state.view = null; state.replyDraftId = null; state.sharePreparation = null; this.render(); return true;
  }
  recordAttachmentsMarkup(view) {
    const attachments = view.values.attachments ?? [];
    return attachments.map((file) => `<article class="care-record-attachment" data-record-attachment="${esc(file.id)}"><p>${esc(file.name)}</p>
      <label class="care-check"><input type="checkbox" aria-label="보호자 공유에 포함 · ${esc(file.name)}" data-record-share="${esc(file.id)}" ${file.share === true ? 'checked' : ''}>보호자 공유에 포함</label>
      <div class="care-actions"><button type="button" aria-label="저장된 ${file.type.startsWith('image/') ? '사진' : '동영상'} 열기 · ${esc(file.name)}" data-open-record-attachment="${esc(file.id)}" data-record-id="${esc(view.recordId)}" data-record-revision="${view.expectedRevision}">저장된 ${file.type.startsWith('image/') ? '사진' : '동영상'} 열기</button>
      ${action('remove-record-attachment', '기록에서 제외', null, `data-attachment-id="${esc(file.id)}"`)}</div></article>`).join('');
  }
  setRecordShare(id, share) {
    const state = this.state(), view = state?.view;
    if (!this.deliveryEnabled || !this.current(this.getContext()) || state.mutation.operation || view?.kind !== 'record' || typeof share !== 'boolean') return false;
    const file = view.values.attachments?.find((value) => value.id === id); if (!file) return false;
    file.share = share; return true;
  }
  removeRecordAttachment(id) {
    const state = this.state(), view = state?.view;
    if (!this.deliveryEnabled || !this.current(this.getContext()) || state.mutation.operation || view?.kind !== 'record') return false;
    this.snapshot(); view.values.attachments = (view.values.attachments ?? []).filter((file) => file.id !== id);
    const host = this.dialog?.querySelector('[data-record-attachments]'); if (host) host.innerHTML = this.recordAttachmentsMarkup(view);
    this.notice('다음 저장에서 이 첨부를 제외합니다. 이전 기록과 공유본에 보존된 파일은 삭제하지 않습니다.');
    this.dialog?.querySelector('[data-record-upload] summary')?.focus(); return true;
  }
  async openRecordAttachment(id) {
    const state = this.state(), view = state?.view, context = this.getContext(), epoch = this.epoch;
    if (!this.deliveryEnabled || !this.current(context) || roleOf(context) !== 'therapist' || state.mutation.operation ||
        !['record', 'publish'].includes(view?.kind)) return;
    const preview = view.kind === 'publish' ? view.preview : null;
    const recordId = preview ? preview.recordId : view.recordId;
    const revision = preview ? preview.recordRevision : view.expectedRevision;
    const attachments = preview ? preview.attachments?.filter((file) => file.share === true) : view.values.attachments;
    if (!version(revision) || !attachments?.some((file) => file.id === id)) return;
    try { await this.onOpenRecordAttachment(recordId, revision, id); }
    catch (error) { if (this.current(context, epoch) && state.view === view) this.fail(error); }
  }
  feedbackAttachmentsMarkup(view) {
    return (view.values.attachments ?? []).map((file) => `<article class="care-record-attachment" data-feedback-attachment="${esc(file.id)}"><p>${esc(file.name)}</p>
      ${action('remove-feedback-attachment', '활동 경험에서 제외', null, `data-attachment-id="${esc(file.id)}"`)}</article>`).join('');
  }
  removeFeedbackAttachment(id) {
    const state = this.state(), view = state?.view;
    if (!this.deliveryEnabled || !this.current(this.getContext()) || roleOf(this.getContext()) !== 'guardian' || state.mutation.operation || view?.kind !== 'feedback') return false;
    this.snapshot(); view.values.attachments = (view.values.attachments ?? []).filter((file) => file.id !== id);
    const host = this.dialog?.querySelector('[data-feedback-attachments]'); if (host) host.innerHTML = this.feedbackAttachmentsMarkup(view);
    this.notice('다음 저장에서 이 첨부를 제외합니다. 이전 활동 경험과 치료 기록에 보존된 파일은 삭제하지 않습니다.');
    this.dialog?.querySelector('[data-feedback-upload] summary')?.focus(); return true;
  }
  feedbackAnchors(view) {
    if (view?.kind === 'review') return [{ feedbackId: view.feedbackId, messageId: view.messageId, feedbackRevision: view.expectedRevision, attachments: view.attachments }];
    if (view?.kind === 'reply' && view.sourceType === 'feedback') return [{ feedbackId: view.feedbackId, messageId: view.messageId, feedbackRevision: view.expectedReplyRevision, attachments: view.attachments }];
    if (view?.kind === 'record' && !view.expectedRevision) return view.references.filter((reference) => reference.feedbackId);
    return [];
  }
  exactFeedbackMarkup(source) {
    if (!this.deliveryEnabled || roleOf(this.getContext()) !== 'therapist' || !version(source?.feedbackRevision) || !source.feedbackId || !source.messageId || !Array.isArray(source.attachments) || !source.attachments.length) return '';
    return `<ul class="message-attachments" aria-label="당시 활동 경험 첨부">${source.attachments.map((file) => `<li><button type="button" data-open-feedback-attachment="${esc(file.id)}" data-feedback-id="${esc(source.feedbackId)}" data-message-id="${esc(source.messageId)}" data-feedback-revision="${source.feedbackRevision}">당시 ${file.type.startsWith('image/') ? '사진' : '동영상'} 열기 · ${esc(file.name)}</button></li>`).join('')}</ul>`;
  }
  referenceAttachmentsMarkup(view, reference) {
    if (!this.deliveryEnabled || roleOf(this.getContext()) !== 'therapist' || !Array.isArray(reference.attachments)) return attachmentNotice(files(reference), this.deliveryEnabled);
    if (!reference.attachments.length) return '';
    if (!view.expectedRevision) return reference.feedbackId ? this.exactFeedbackMarkup(reference) : attachmentNotice(reference.attachments.length, true);
    return `<ul class="message-attachments" aria-label="기록 당시 참고 첨부">${reference.attachments.map((file) => `<li><button type="button" data-open-reference-attachment="${esc(file.id)}" data-record-id="${esc(view.recordId)}" data-record-revision="${view.expectedRevision}" data-message-id="${esc(reference.messageId)}">기록 당시 ${file.type.startsWith('image/') ? '사진' : '동영상'} 열기 · ${esc(file.name)}</button></li>`).join('')}</ul>`;
  }
  referenceSourceNodes(messageId) {
    const wrapper = [...(this.dialog?.querySelectorAll('[data-reference-message-id]') ?? [])]
      .find(node => node.dataset.referenceMessageId === messageId);
    return { panel: wrapper?.querySelector('[data-reference-source]'),
      button: wrapper?.querySelector('[data-care-action="reference-source"]') };
  }
  referenceSourceCurrent(request) {
    const next = this.getContext(), { context, state, view, reference } = request;
    const nodes = this.referenceSourceNodes(reference.messageId);
    return this.referenceSource === request && this.current(context, request.epoch) &&
      roleOf(next) === 'therapist' && next.profile?.childId === request.childId &&
      next.roomRevision === request.roomRevision && this.state() === state && state.view === view &&
      view.references.includes(reference) && !state.mutation.operation && !view.contextRefresh &&
      !!this.dialog?.open && !request.controller.signal.aborted &&
      nodes.panel === request.panel && nodes.button === request.button;
  }
  clearReferenceSource(notice = '') {
    const request = this.referenceSource;
    this.referenceSource = null;
    if (!request) return;
    request.source = null; request.attachments = [];
    request.controller.abort();
    request.panel.textContent = notice; request.panel.hidden = !notice;
    request.button.setAttribute('aria-expanded', 'false'); request.button.textContent = '현재 원문 보기';
  }
  async toggleReferenceSource(messageId) {
    if (this.referenceSource?.reference.messageId === messageId) { this.clearReferenceSource(); return; }
    const context = this.getContext(), state = this.state(), view = state?.view;
    if (view?.kind !== 'record' || !this.current(context) || roleOf(context) !== 'therapist' ||
        !context.profile?.childId || !this.dialog?.open || state.mutation.operation || view.contextRefresh) return;
    const reference = view.references.find(item => item.messageId === messageId);
    const { panel, button } = this.referenceSourceNodes(messageId);
    if (!reference || !panel || !button) return;
    this.clearReferenceSource();
    const request = { context, state, view, reference, panel, button, epoch: this.epoch,
      childId: context.profile.childId, roomRevision: context.roomRevision, controller: new AbortController() };
    request.signal = context.signal ? AbortSignal.any([context.signal, request.controller.signal]) : request.controller.signal;
    this.referenceSource = request;
    panel.textContent = '현재 원문을 확인하고 있어요…'; panel.hidden = false;
    button.textContent = '현재 원문 닫기'; button.setAttribute('aria-expanded', 'true');
    const current = () => this.referenceSourceCurrent(request);
    try {
      // Do not reuse a read started before this explicit inspection. A saved
      // record and its current chat source have separate read authorities.
      view.requiresProfileCheck = true; view.profileChildId = request.childId;
      state.readCheck = null;
      if (!await this.guardView(context, state) || !current()) return;
      const message = await this.api.message(context.centerId, context.roomId, messageId, request.signal);
      if (!current()) return;
      if (message?.hidden || message?.deleted) {
        panel.textContent = '현재 원문을 볼 수 없습니다. 기록 당시 참고는 그대로 보존됩니다.'; return;
      }
      if (message?.id !== messageId || message.conversationId !== context.roomId ||
          message.childId !== request.childId || (reference.feedbackId
            ? message.type !== 'feedback' || message.feedback?.id !== reference.feedbackId || !version(message.feedback.revision)
            : message.type !== 'text' || !version(message.version))) throw new LocalApiError('INVALID_RESPONSE');
      request.source = currentReferenceSource(message);
      request.attachments = Object.freeze(this.deliveryEnabled ? currentReferenceFiles(message) : []);
      panel.innerHTML = careReferenceSourceMarkup(message, new Date().toLocaleString('ko-KR'), this.deliveryEnabled);
    } catch (error) {
      if (!current()) return;
      if (error?.code === 'AUTH_REQUIRED') { this.fail(error); return; }
      if (['NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) {
        // Recheck the clinical record, without treating a hidden chat source
        // as revocation of the independently authorized historical snapshot.
        state.readCheck = null;
        if (!await this.guardView(context, state) || !current()) return;
        panel.textContent = '현재 원문을 볼 수 없습니다. 기록 당시 참고는 그대로 보존됩니다.';
      } else panel.textContent = '현재 원문을 확인하지 못했어요. 닫은 뒤 다시 조회해 주세요. 당시 참고와 작성 내용은 바뀌지 않았습니다.';
    } finally {
      if (this.referenceSource === request && !current()) this.clearReferenceSource();
    }
  }
  currentReferenceMediaContext(source) {
    const context = this.getContext(), request = this.referenceSource;
    const visible = !!request && this.referenceSourceCurrent(request) && sameReferenceSource(request.source, source);
    return { ...context, role: roleOf(context), enabled: this.deliveryEnabled,
      visible, referenceAttachments: visible ? request.attachments : [],
      signal: request?.signal ?? context.signal };
  }
  async openCurrentReferenceAttachment(messageId, attachmentId) {
    const request = this.referenceSource;
    if (!this.deliveryEnabled || !request || !this.referenceSourceCurrent(request) ||
        request.source?.messageId !== messageId || !request.attachments?.some(file => file.id === attachmentId)) return false;
    try { return await this.onOpenCurrentReferenceAttachment(request.source, attachmentId); }
    catch (error) {
      if (this.referenceSource === request) await this.currentReferenceMediaFailed(request.source, error);
      return false;
    }
  }
  async currentReferenceMediaFailed(source, error) {
    const request = this.referenceSource;
    if (!request || !this.referenceSourceCurrent(request) || !sameReferenceSource(request.source, source)) return;
    if (error?.code === 'AUTH_REQUIRED') { this.fail(error); return; }
    this.clearReferenceSource('현재 첨부를 열지 못했어요. 현재 원문을 다시 조회해 주세요. 작성 중인 기록과 당시 참고는 바꾸지 않았습니다.');
    if (['NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) {
      // A changed/hidden current file is not proof of clinical revocation.
      // Recheck that independent authority before retaining the draft UI.
      request.state.readCheck = null;
      await this.guardView(request.context, request.state);
    }
  }
  async openFeedbackAttachment(feedbackId, messageId, revision, fileId) {
    const state = this.state(), view = state?.view, context = this.getContext(), epoch = this.epoch;
    if (!this.deliveryEnabled || !this.current(context) || roleOf(context) !== 'therapist' || state.mutation.operation ||
        !this.feedbackAnchors(view).some((source) => source.feedbackId === feedbackId && source.messageId === messageId && source.feedbackRevision === revision &&
          version(revision) && source.attachments?.some((file) => file.id === fileId))) return;
    try { await this.onOpenFeedbackAttachment(feedbackId, messageId, revision, fileId); }
    catch (error) { if (this.current(context, epoch) && state.view === view) this.fail(error); }
  }
  async openReferenceAttachment(messageId, fileId) {
    const state = this.state(), view = state?.view, context = this.getContext(), epoch = this.epoch;
    if (!this.deliveryEnabled || !this.current(context) || roleOf(context) !== 'therapist' || state.mutation.operation || view?.kind !== 'record' ||
        !version(view.expectedRevision) || !view.references.some((source) => source.messageId === messageId && source.attachments?.some((file) => file.id === fileId))) return;
    try { await this.onOpenReferenceAttachment(view.recordId, view.expectedRevision, messageId, fileId); }
    catch (error) { if (this.current(context, epoch) && state.view === view) this.fail(error); }
  }
  form(title, kind, body, buttons) {
    this.ensureDialog(); this.wipeDialog();
    const recordContext = ['record', 'publish'].includes(kind);
    const child = recordContext ? `<p class="small muted" data-care-child>${esc(this.getContext().profile?.name ?? '선택한 아이')}</p>` : '';
    this.dialog.innerHTML = `<header class="care-dialog-head${recordContext ? ' care-dialog-head-context' : ''}"><div><h2 id="care-dialog-title">${esc(title)}</h2>${child}</div>${action('close', '닫기')}</header><form data-care-form="${kind}" autocomplete="off"><div class="care-fields">${body}</div><p class="care-error" data-care-error data-testid="care-error" role="status"></p><div class="care-actions care-submit${kind === 'record' ? ' care-record-submit' : ''}">${buttons}${kind === 'record' ? '' : action('discard', '입력 취소')}</div></form>`;
    this.dialog.showModal(); this.lockForm();
  }
  updateRecordDisclosure() {
    if (this.state()?.view?.kind !== 'record') return;
    const form = this.dialog?.querySelector('form'); if (!form) return;
    const value = (name) => form.elements.namedItem(name)?.value ?? '';
    const observation = Object.fromEntries(['Status', ...observationKeys.map(titleCase)].map((key) => [key, value(`observation${key}`)]));
    const statuses = { '[data-record-detail-status]': recordDetailStatus(observation, form.querySelectorAll('[data-assessment-row]').length),
      '[data-record-private-status]': value('privateNote').trim() ? '내부 메모 있음' : '비공개' };
    // Presentation only: never replace controls, capture new requests, or mirror
    // clinical text into the collapsed summaries.
    for (const [selector, text] of Object.entries(statuses)) {
      const element = form.querySelector(selector);
      if (element && element.textContent !== text) element.textContent = text;
    }
  }
  updateRecordTitleSuggestion(event) {
    const state = this.state();
    if (state?.view?.kind !== 'record' || state.mutation.operation || event?.isComposing ||
        event && !['date', 'performed'].includes(event.target?.name)) return;
    const form = this.dialog?.querySelector('form'), output = form?.querySelector('[data-record-title-suggestion]');
    if (!output) return;
    const suggestion = recordTitleSuggestion(form.elements.namedItem('date')?.value ?? '', form.elements.namedItem('performed')?.value ?? '');
    if (output.textContent !== suggestion) output.textContent = suggestion;
  }
  useRecordTitleSuggestion() {
    const state = this.state(), context = this.getContext();
    if (state?.view?.kind !== 'record' || state.mutation.operation || state.view.contextRefresh ||
        !this.current(context) || roleOf(context) !== 'therapist') return;
    const form = this.dialog?.querySelector('form'), input = form?.elements.namedItem('title');
    if (!input) return;
    // Applying a suggestion is explicit. Never overwrite a manual/old title
    // when a date, activity, permission snapshot or dialog changes.
    input.value = recordTitleSuggestion(form.elements.namedItem('date')?.value ?? '', form.elements.namedItem('performed')?.value ?? '');
    state.view.values.title = input.value; input.focus();
  }
  display() {
    const state = this.state(), view = state?.view;
    if (!view) return;
    const v = view.values ?? {}, mediaDelivery = this.getContext().mediaDelivery === true;
    if (view.kind === 'receipt') {
      this.form('이전 요청 처리 확인', 'receipt', '<p>원문과 입력 내용은 이 화면에 다시 표시하지 않습니다. 이전 요청의 처리 결과만 같은 요청 번호와 내용으로 확인합니다.</p>', '');
    } else if (view.kind === 'record-cleanup') {
      this.form('미저장 첨부 정리', 'record-cleanup', '<p>서버가 기록 저장을 거부했습니다. 원문과 임상 입력은 다시 표시하지 않습니다. 남아 있는 첨부 선택을 취소한 뒤 새 기록을 시작해 주세요.</p><div data-record-upload></div>', '');
      this.syncRecordMedia(); this.lockForm();
    } else if (view.kind === 'feedback-cleanup') {
      this.form('미저장 첨부 정리', 'feedback-cleanup', '<p>서버가 활동 경험 저장을 거부했습니다. 원문과 입력 내용은 다시 표시하지 않습니다. 남아 있는 첨부 선택을 취소한 뒤 활동 경험을 다시 작성해 주세요.</p><div data-feedback-upload></div>', '');
      this.syncFeedbackMedia(); this.lockForm();
    } else if (view.kind === 'reply-cleanup') {
      this.form('미전송 첨부 정리', 'reply-cleanup', '<p>이전 답장을 계속 작성할 수 없어 원문과 입력 내용은 다시 표시하지 않습니다. 남아 있는 첨부 선택의 상태를 확인하고 취소한 뒤 새 답장을 시작해 주세요.</p><div data-reply-upload></div>', '');
      this.syncReplyMedia(); this.lockForm();
    } else if (view.kind === 'goal') {
      this.form(view.expectedRevision === 0 ? '목표 추가' : '목표 수정', 'goal',
        `<p class="small muted">현재 연결된 보호자와 담당 치료사가 이 목표를 함께 봅니다. 새로 연결된 참여자에게도 현재 목표가 보입니다.</p>
        ${field('title', '목표', v.title, { textarea: false, required: true, max: 100 })}
        ${field('description', '목표 설명', v.description)}
        ${select('status', '목표 상태', v.status, Object.entries(goalStatus))}
        <p class="small muted">수정해도 이전 기록에 남은 당시 목표는 바뀌지 않습니다. 메시지나 치료 기록은 자동 생성하지 않습니다.</p>
        <section data-goal-conflict hidden></section>`, '<button type="submit" class="primary">목표 저장</button>');
      this.goalComparison(); this.lockForm();
      if (view.stale) this.notice(staleGoal);
    } else if (view.kind === 'appointment') {
      this.form(view.expectedRevision === 0 ? '일정 추가' : '일정 수정', 'appointment',
        `<p class="small muted">${esc(this.getContext().profile?.name ?? '선택한 아이')} · 연결된 보호자와 담당 치료사가 확인하는 일정입니다. 날짜와 시간은 한국 기준입니다.</p>
        <div class="care-grid">${field('date', '일정 날짜', v.date, { textarea: false, type: 'date', required: true })}${field('time', '시작 시간', v.time, { textarea: false, type: 'time', required: true })}</div>
        <label>진행 시간(분)<input name="duration" type="number" min="10" max="180" step="1" value="${esc(v.duration)}" required /></label>
        ${field('title', '일정 이름', v.title, { textarea: false, max: 100, required: true })}
        ${field('room', '장소', v.room, { textarea: false, max: 60, required: true })}
        ${select('status', '일정 상태', v.status, Object.entries(appointmentStatus))}
        <p class="small muted">아동·치료사·장소의 중복 시간을 서버에서 확인합니다. 새 회기는 새 일정으로 추가하세요. 수정·취소해도 기존 치료 기록과 당시 일정은 바뀌지 않습니다.</p>
        <section data-appointment-conflict hidden></section>`, '<button type="submit" class="primary">일정 저장</button>');
      this.contextComparison('appointment'); this.lockForm();
      if (view.stale) this.notice(staleAppointment);
    } else if (view.kind === 'record') {
      const observation = v.observation ?? {}, activity = v.activity ?? {};
      const goals = view.goals ?? state.goals;
      const appointment = view.appointment;
      const historicalGoal = v.goalSnapshot ? `<p class="small muted" data-record-goal-snapshot>이 기록에 저장된 당시 목표 · ${esc(v.goalSnapshot.title)} (${esc(v.goalSnapshot.revision)}번째 내용). 다시 저장하면 위에서 확인한 현재 목표를 연결합니다.</p>` : '';
      const previousAppointment = v.appointmentSnapshot;
      const historicalAppointment = previousAppointment ? `<p class="small muted" data-record-appointment-snapshot>이 기록에 저장된 당시 일정 · ${esc(previousAppointment.date)} ${esc(previousAppointment.time)} · ${esc(previousAppointment.duration)}분 · ${esc(previousAppointment.title)} · ${esc(previousAppointment.room)} · ${esc(appointmentStatus[previousAppointment.status])} (${esc(previousAppointment.revision)}번째 내용). 현재 연결 일정과 다를 수 있습니다.</p>` : '';
      const contextNotice = view.contextStale || view.contextRefreshed ? `<section data-record-context>${this.recordContextMarkup(view)}</section>` : '';
      const template = view.templateSource ? `<p class="small muted" data-record-template-notice>이전 목표와 측정 항목만 가져왔어요. 오늘의 관찰·측정값은 새로 입력해 주세요.${!v.goalId ? ' 이전 목표를 현재 선택할 수 없어 새 목표를 직접 선택해야 합니다.' : ''}</p>` : '';
      const linked = appointment ? `<p class="care-appointment-context">연결 일정 · ${esc(appointment.date)}${appointment.time ? ` ${esc(appointment.time)}` : ''} · ${esc(appointment.title)}</p><p class="small muted">일정과 연결된 기록입니다. 목표를 직접 확인해 주세요. 이전 관찰·반응·측정값은 자동으로 복사하지 않습니다.</p>` : '';
      const references = view.references.map((r, index) => `<blockquote class="care-reference" data-reference-message-id="${esc(r.messageId)}"><p data-reference-quote>${esc(r.body || '기록에 연결된 당시 소식')}</p><p class="small">당시 ${r.feedbackRevision ? `활동 경험 ${r.feedbackRevision}번째 내용` : `${r.messageRevision ?? 1}번째 소식`} · 치료사 기록 참고${r.changed || r.deleted || r.hidden ? ' · 현재 대화 내용과 별도로 보존됨' : ''}</p>${this.referenceAttachmentsMarkup(view, r)}${action('reference-source', '현재 원문 보기', r.messageId, `aria-expanded="false" aria-controls="care-reference-source-${index}"`)}<section id="care-reference-source-${index}" data-reference-source aria-label="현재 원문" role="status" hidden></section></blockquote>`).join('');
      const detailStatus = recordDetailStatus(observation, v.assessments?.length ?? 0);
      this.form(view.recordId && view.expectedRevision ? '기록 수정' : '새 기록', 'record', `<p class="care-scope-note">치료사 기록 · 저장만으로 보호자에게 공유되지 않아요.</p><div class="care-grid">${field('date', '기록 날짜', v.date, { textarea: false, type: 'date', required: true })}${select('goalId', '연결 목표', v.goalId, [...(appointment || !v.goalId ? [['', '목표를 선택해 주세요']] : []), ...goals.map((g) => [g.id, g.title])])}</div>
        ${contextNotice}${template}<section class="care-record-basics" data-record-basics aria-label="기본 기록"><div><h3>오늘의 기록</h3><p class="small muted">기본 3칸으로 시작해 보세요.</p></div>${field('performed', '오늘 한 활동', v.performed)}${field('response', '아이의 반응', v.response)}${field('nextPlan', '다음 계획', v.nextPlan)}</section>
        ${field('title', '기록 제목', v.title, { textarea: false, max: 100 })}
        <section class="care-title-suggestion" aria-label="제안 제목"><div><span class="small muted">날짜·활동으로 만든 제안</span><output data-record-title-suggestion aria-live="off">${esc(recordTitleSuggestion(v.date ?? '', v.performed ?? ''))}</output></div>${action('use-record-title', '이 제목 사용')}</section><p class="small muted">제목은 공유 미리보기에도 표시돼요. 직접 수정할 수 있어요.</p>
        ${references ? `<details data-record-references><summary>참고한 대화 <span class="care-summary-meta">${view.references.length}개</span></summary>${references}</details>` : ''}
        ${linked || historicalGoal || historicalAppointment ? `<details data-record-history><summary>연결 일정·이전 기록 정보</summary>${linked}${historicalGoal}${historicalAppointment}</details>` : ''}
        <details ${view.templateSource && v.assessments?.length ? 'open' : ''}><summary>상세 관찰·측정값 <span class="care-summary-meta" data-record-detail-status>${esc(detailStatus)}</span></summary>${select('observationStatus', '관찰 상태', observation.status ?? '', [['', '선택하지 않음'], ['observed', '관찰함'], ['not-observed', '관찰하지 않음'], ['not-applicable', '해당 없음']])}<div class="care-grid">${observationKeys.map((key) => field(`observation${titleCase(key)}`, labels[key], observation[key], { textarea: false, max: 500 })).join('')}</div><div data-assessment-rows>${(v.assessments ?? []).map(assessmentRow).join('')}</div>${action('add-assessment', '측정값 추가')}</details>
        <details><summary>치료사 내부 메모 <span class="care-summary-meta" data-record-private-status>${v.privateNote?.trim() ? '내부 메모 있음' : '비공개'}</span></summary>${field('privateNote', '내부 메모 · 보호자에게 공개하지 않음', v.privateNote)}</details>
        ${this.deliveryEnabled ? `<section aria-label="기록 사진·영상"><h3>사진·영상</h3><p class="small muted">기본은 비공개입니다. 공유에 포함한 파일도 기록 저장 후 공유 미리보기에서 확인해야 보호자에게 보입니다.</p><div data-record-attachments>${this.recordAttachmentsMarkup(view)}</div><div data-record-upload></div></section>` : ''}
        <details class="care-sharing-fields" ${v.summary || v.activity ? 'open' : ''}><summary>보호자 요약·가정 활동</summary><p class="small muted">‘공유 준비’는 기록 저장 후 미리보기만 열어요. 받는 사람과 공개 내용을 확인하고 별도로 공유해 주세요.</p>${field('summary', '보호자에게 전할 요약', v.summary)}${field('activityTitle', '가정 활동 이름', activity.title, { textarea: false, max: 100 })}${field('activityInstruction', '가정 활동 안내', activity.instruction)}${field('activityFrequency', '가정 활동 빈도', activity.frequency, { textarea: false, max: 100 })}${field('activityCaution', '가정 활동 주의사항', activity.caution, { max: 500 })}</details>`,
      // Keep draft as the first native submitter: Enter in a single-line
      // field must not silently turn an incomplete draft into a saved record.
      `<div class="care-record-secondary"><button type="submit" name="intent" value="draft" formnovalidate>임시저장</button>${action('discard', '입력 취소')}</div><div class="care-record-primary"><button type="submit" class="primary" name="intent" value="saved">기록 저장</button><button type="submit" name="intent" value="prepare-share" aria-label="보호자 공유 준비">공유 준비</button></div>`);
      this.syncRecordMedia(); this.lockForm();
    } else if (view.kind === 'publish') {
      const p = view.preview, participants = this.getContext().profile?.participants ?? [];
      const shared = (p.attachments ?? []).filter((file) => file.share === true);
      const attachments = this.deliveryEnabled ? `<section class="care-share-attachments" aria-label="공유할 첨부"><h4>공유할 사진·영상 ${shared.length}개</h4>${shared.length ? `<p class="small muted">파일을 열어 내용을 확인해 주세요. 열기만으로 공유되지 않아요.</p><ul>${shared.map((file) => `<li><button type="button" data-open-record-attachment="${esc(file.id)}" data-record-id="${esc(p.recordId)}" data-record-revision="${p.recordRevision}"><span>${file.type.startsWith('image/') ? '사진 열기' : '동영상 열기'}</span><span>${esc(file.name)}</span></button></li>`).join('')}</ul>` : '<p class="small muted">공유에 포함한 첨부가 없어요.</p>'}</section>` : '';
      this.form('공유 미리보기', 'publish', `<section class="care-share-recipients" data-share-recipients aria-label="받는 보호자"><p class="small muted">받는 보호자 · ${p.recipientIds.length}명</p><ul>${p.recipientIds.map((id) => `<li>${esc(participants.find((p) => p.userId === id)?.displayName ?? '연결된 보호자')}</li>`).join('')}</ul></section><p class="small muted">보호자에게 아래 내용이 전달됩니다.</p><article class="care-share-preview"><p class="eyebrow">${esc(p.date)} · 치료 소식</p><h3>${esc(p.title)}</h3><p>${esc(p.summary)}</p>${activityMarkup(p.activity)}${attachments}</article><p class="care-scope-note">위 날짜·제목·요약·가정 활동${this.deliveryEnabled ? '·선택한 첨부' : ''}만 공유합니다. 측정값·내부 메모·참고 소식·임상 검토와 비공개 첨부는 공개하지 않습니다.</p><label class="care-check care-share-confirm"><input type="checkbox" name="confirmed" required ${v.confirmed ? 'checked' : ''} />받는 보호자와 공개 내용을 확인했어요</label>`, `${action('edit-preview-record', '기록 수정')}<button type="submit" class="primary">확인하고 공유</button>`);
    } else if (view.kind === 'feedback') {
      this.form(view.expectedRevision ? '활동 경험 수정' : '활동 경험 남기기', 'feedback', `<p>${esc(view.sourceTitle)}</p>${field('date', '활동 날짜', v.date, { textarea: false, type: 'date', required: true })}${select('result', '수행 상태', v.result, [['done', '했어요'], ['partial', '일부 했어요'], ['skipped', '하지 못했어요']])}${field('reaction', '아이 반응', v.reaction, { required: true, max: 1000 })}${field('difficulty', '어려움', v.difficulty, { max: 1000 })}
        ${this.deliveryEnabled ? `<section aria-label="활동 경험 사진·영상"><h3>사진·영상</h3><p class="small muted">저장하면 선택한 첨부가 이 대화 참여자에게 공유됩니다. 이미 저장된 파일은 현재 대화에서 열 수 있어요.</p><div data-feedback-attachments>${this.feedbackAttachmentsMarkup(view)}</div><div data-feedback-upload></div></section>` : ''}`, '<button type="submit" class="primary">활동 경험 저장</button>');
      this.syncFeedbackMedia(); this.lockForm();
    } else if (view.kind === 'review') {
      this.form('치료사 임상 검토', 'review', `<blockquote>${esc(view.sourceBody)}</blockquote>${this.exactFeedbackMarkup(this.feedbackAnchors(view)[0])}<p class="small muted">이 메모는 치료사만 볼 수 있어요. 보호자에게 전할 내용은 ‘인용 답장’으로 따로 보내 주세요.</p>${field('note', '비공개 임상 검토', v.note, { required: true })}`, '<button type="submit" class="primary">임상 검토 저장</button>');
    } else if (view.kind === 'family-plan') {
      this.form('가족이 바라는 변화', 'family-plan', `<p class="small muted" data-family-plan-version>작성 시작 당시 저장 버전 ${view.expectedRevision}</p><p class="small muted">이 아이에게 연결된 보호자들이 함께 작성합니다. 현재 담당 치료사와 보호자가 볼 수 있으며, 나중에 새로 연결된 보호자·담당 치료사에게도 현재 내용이 보입니다.</p>${field('concern', '가족이 바라는 변화', v.concern, { max: 1000 })}<p class="small muted">비워 두고 저장하면 현재 내용만 지웁니다. 대화나 치료 기록에 이미 남긴 내용은 지워지지 않습니다. 저장해도 메시지가 전송되거나 읽음으로 표시되지는 않아요.</p>`, '<button type="submit" class="primary">가족 관심사 저장</button>');
      if (view.stale) { this.notice(staleFamilyPlan); this.lockForm(); }
    } else if (view.kind === 'text-review') {
      const history = view.reviewedRevision != null && view.reviewedRevision !== view.expectedRevision
        ? `<p class="small" data-text-review-history>아래 메모는 수정 전 ${view.reviewedRevision}번째 소식에 대한 내용입니다. 현재 ${view.expectedRevision}번째 소식을 확인하고 메모를 검토한 뒤 저장해 주세요.</p>` : '';
      this.form('소식 반영 메모', 'text-review', `<p class="small muted">작성 시작 당시 ${view.expectedRevision}번째 소식 · 메모 저장 버전 ${view.expectedReviewVersion}</p><blockquote>${esc(view.sourceBody || '첨부 소식')}</blockquote>${attachmentNotice(view.attachmentCount, mediaDelivery)}${history}<p class="small muted">읽음과 별도로 다음 회기에 반영할 내용을 확인합니다. 메모는 담당 치료사만 볼 수 있고, 보호자에게는 반영 확인 상태만 보입니다. 보호자에게 전할 내용은 ‘인용 답장’으로 따로 보내 주세요.</p>${field('note', '비공개 반영 메모', v.note, { required: true })}`, '<button type="submit" class="primary">반영 확인 저장</button>');
      if (view.stale) { this.notice(staleTextReview); this.lockForm(); }
    } else if (view.kind === 'reply') {
      this.form('소식에 인용 답장', 'reply', `<blockquote>${esc(view.sourceBody || '첨부 소식')}</blockquote>${view.sourceType === 'feedback' && roleOf(this.getContext()) === 'therapist' ? this.exactFeedbackMarkup(this.feedbackAnchors(view)[0]) : attachmentNotice(view.attachmentCount, mediaDelivery)}${field('body', '대화에 보낼 답장', v.body, { required: !this.deliveryEnabled })}${this.deliveryEnabled ? '<p class="small muted">글 없이 준비 완료된 사진·영상만 답장할 수도 있어요.</p><div data-reply-upload></div>' : ''}`, '<button type="submit" class="primary">답장 보내기</button>');
      this.syncReplyMedia(); this.lockForm();
    } else if (view.kind === 'text-edit') {
      this.form('메시지 본문 수정', 'text-edit', `<p class="small muted">본문만 수정합니다. 이미 치료 기록에 보존된 당시 참고 원문은 바뀌지 않습니다.</p>${attachmentNotice(view.attachmentCount, mediaDelivery)}${field('body', '메시지 본문', v.body, { required: !view.attachmentCount })}`, '<button type="submit" class="primary">수정 저장</button>');
    } else if (view.kind === 'text-delete') {
      const all = view.scope === 'all';
      this.form(all ? '모두에게서 삭제' : '나에게만 삭제', 'text-delete', `<blockquote>${esc(view.sourceBody || '첨부 소식')}</blockquote><p>${all ? '이 대화의 모든 참여자에게 메시지가 삭제된 소식으로 표시됩니다.' : '내 대화 목록에서만 이 소식을 숨깁니다. 다른 참여자에게는 계속 보입니다.'}</p><p class="small muted">영구 파기가 아닙니다. 치료 기록에 보존된 당시 참고 원문과 첨부는 삭제하지 않습니다.</p>${attachmentNotice(view.attachmentCount, mediaDelivery)}<label class="care-check"><input type="checkbox" name="confirmed" required ${v.confirmed ? 'checked' : ''} />${all ? '다른 참여자에게도 삭제 표시가 되는 것을 확인했어요' : '나에게만 숨겨지고 다른 사람에게는 남는 것을 확인했어요'}</label>`, `<button type="submit" class="primary">${all ? '모두에게서 삭제 확인' : '나에게만 삭제 확인'}</button>`);
    } else if (view.kind === 'withdraw') {
      this.form('공유 종료', 'withdraw', `<p>‘${esc(view.sourceTitle)}’ 공유를 종료할까요?</p><p class="small muted">보호자는 이 공유본의 내용을 더 이상 볼 수 없습니다. 치료사의 원기록과 기록에 보존한 참고는 삭제하지 않습니다.</p>`, '<button type="submit" class="primary">공유 종료 확인</button>');
    }
    if (view.error) this.notice(view.error);
  }
  notice(message) { const node = this.dialog?.querySelector('[data-care-error]'); if (node) node.textContent = message; }
  lockForm() {
    const state = this.state(), form = this.dialog?.querySelector('form'); if (!state || !form) return;
    const mutation = state.mutation;
    for (const element of form.querySelectorAll('input,textarea,select,button')) {
      if (element.dataset.careAction === 'retry') continue;
      if (element.closest?.('[data-record-upload],[data-feedback-upload],[data-reply-upload]')) continue;
      element.disabled = !!mutation.operation || !!state.view?.contextRefresh || (state.view?.kind === 'record' && state.view.contextStale === true && element.type === 'submit') || (['record', 'feedback', 'reply'].includes(state.view?.kind) && !!(this.recordMedia?.busy || this.feedbackMedia?.busy || this.replyMedia?.busy) && element.type === 'submit') ||
        (['text-review', 'family-plan', 'goal', 'appointment'].includes(state.view?.kind) && state.view.stale === true && element.type === 'submit');
    }
    form.querySelector('[data-care-action="retry"]')?.remove();
    if (mutation.operation) {
      const button = this.host.ownerDocument.createElement('button'); button.type = 'button'; button.dataset.careAction = 'retry';
      button.textContent = mutation.sending ? '처리 확인 중…' : '같은 요청 다시 확인'; button.disabled = mutation.sending;
      form.querySelector('.care-submit').append(button);
      this.notice(mutation.sending ? '서버 처리 결과를 확인하고 있어요…' : '처리 결과가 확인되지 않았어요. 원래 내용·요청 번호를 보존했습니다.');
    }
  }
  addAssessment() {
    if (this.state()?.mutation.operation) return;
    const rows = this.dialog.querySelector('[data-assessment-rows]'); if (!rows) return;
    if (rows.children.length >= 20) { this.notice('측정값은 20개까지 추가할 수 있어요.'); return; }
    rows.insertAdjacentHTML('beforeend', assessmentRow({}, rows.children.length)); rows.lastElementChild.querySelector('input').focus();
    this.updateRecordDisclosure();
  }
  removeAssessment(button) {
    if (this.state()?.mutation.operation) return;
    const row = button.closest('[data-assessment-row]'), container = row.parentElement;
    const focus = row.nextElementSibling?.querySelector('input') ?? row.previousElementSibling?.querySelector('input');
    row.remove(); renumberCareAssessments(container);
    this.updateRecordDisclosure();
    (focus ?? this.dialog.querySelector('[data-care-action="add-assessment"]')).focus();
  }
  async handleAction(name, id, savedRevision = null) {
    const context = this.getContext(), state = this.state(), epoch = this.epoch;
    if (!state || !this.current(context)) return;
    // A read-only comparison must not replace a record draft or its receipt.
    if (['compare-records', 'clear-comparison'].includes(name)) {
      if (roleOf(context) !== 'therapist' || context.panelMode === 'compact') return;
      if (name === 'compare-records') await this.loadComparison(context, state);
      else { this.clearComparison(state); this.render(); }
      return;
    }
    if (state.opening) return;
    if (name === 'edit-record' && state.view?.kind === 'publish' && state.view.preview.recordId === id) {
      await this.editPreviewRecord(); return;
    }
    if (name === 'resume' || state.view) {
      await this.restoreView(context, state);
      if (name === 'reuse-record' && this.current(context, epoch) && this.dialog?.open && !state.mutation.operation)
        this.notice('작성 중인 입력을 먼저 이어갑니다. 저장하거나 입력 취소 후 다른 양식으로 새 기록을 시작해 주세요.');
      return;
    }
    const therapist = roleOf(context) === 'therapist';
    if (therapist && ['new-record', 'reference', 'reuse-record'].includes(name) && (!state.loaded || !state.goals.length)) {
      this.fail({ code: state.loaded ? 'CONTEXT_NOT_FOUND' : 'CONTEXT_LOADING' }); return;
    }
    if (therapist && name === 'appointment-record' && !state.loaded) { this.fail({ code: 'CONTEXT_LOADING' }); return; }
    const opening = {}; state.opening = opening; state.readNotice = ''; this.render();
    const available = () => this.current(context, epoch) && state.opening === opening && !state.view;
    try {
      if (['new-goal', 'edit-goal', 'new-appointment', 'edit-appointment'].includes(name)) {
        if (!therapist) return;
        const kind = name.endsWith('appointment') ? 'appointment' : 'goal', config = contextEditors[kind];
        // Editing loads only its own adapter; list/record views do not acquire
        // another request or credential cache merely by displaying a row.
        if (!this[kind + 'Api']) {
          const Client = kind === 'goal' ? (await import('./goal-client.js')).GoalApiClient
            : (await import('./appointment-client.js')).AppointmentApiClient;
          if (!available()) return;
          this[kind + 'Api'] = new Client(this.api);
        }
        if (name.startsWith('new-')) {
          const profile = await this.api.profile(context.centerId, context.roomId, context.signal);
          if (!available()) return;
          if (profile?.childId !== context.profile?.childId || profile.conversationId !== context.roomId) throw new LocalApiError('INVALID_RESPONSE');
          state.view = { kind, [config.idKey]: crypto.randomUUID(), childId: profile.childId, expectedRevision: 0,
            values: kind === 'goal' ? { title: '', description: '', status: 'active' }
              : { date: localDay(), time: '', duration: '', title: '', room: '', status: 'scheduled' }, stale: false, latest: null };
        } else {
          if (!state[kind === 'goal' ? 'goals' : 'appointments'].some(item => item.id === id)) throw new LocalApiError('CONTEXT_NOT_FOUND');
          const item = await this[kind + 'Api'][kind](context.centerId, context.roomId, id, context.signal);
          if (!available()) return;
          if (item?.id !== id || item.childId !== context.profile?.childId || item.conversationId !== context.roomId) throw new LocalApiError('INVALID_RESPONSE');
          state.view = { kind, [config.idKey]: item.id, childId: item.childId, expectedRevision: item.revision,
            values: config.values(item), stale: false, latest: item };
        }
        this.display(); return;
      }
      if (name === 'family-plan') {
        if (roleOf(context) !== 'guardian') return;
        const plan = await this.api.familyPlan(context.centerId, context.roomId, context.signal);
        if (!available()) return;
        if (plan?.conversationId !== context.roomId || plan.childId !== context.profile?.childId)
          throw new LocalApiError('INVALID_RESPONSE');
        state.view = { kind: 'family-plan', childId: plan.childId, expectedRevision: plan.revision, values: { concern: plan.concern } };
        this.display(); return;
      }
      if (name === 'new-record' && therapist) {
        state.view = this.newRecord(state); this.display(); return;
      }
      if (name === 'reuse-record' && therapist) {
        const selected = state.records.find((record) => record.id === id);
        if (!selected || !version(selected.revision)) { this.fail({ code: 'CONTEXT_NOT_FOUND' }); return; }
        const revision = selected.revision;
        // Read the version the user selected, not a silently changed head. The
        // server rechecks current assignment and history visibility on this GET.
        const record = await this.api.record(context.centerId, context.roomId, id, context.signal, revision);
        if (!available()) return;
        if (!state.loaded || !state.goals.length) { this.fail({ code: state.loaded ? 'CONTEXT_NOT_FOUND' : 'CONTEXT_LOADING' }); return; }
        if (record?.id !== id || record.conversationId !== context.roomId || record.revision !== revision)
          throw new LocalApiError('INVALID_RESPONSE');
        const template = careRecordTemplate(record, state.goals);
        const view = this.newRecord(state);
        Object.assign(view.values, template);
        view.templateSource = { recordId: id, revision };
        state.view = view; this.display(); return;
      }
      let selectedAppointment;
      if (name === 'appointment-record' && therapist) {
        if (!state.appointments?.some((a) => a.id === id && a.conversationId === context.roomId)) {
          this.fail({ code: 'CONTEXT_NOT_FOUND' }); return;
        }
        selectedAppointment = await this.currentAppointment(context, id);
        if (!available()) return;
        const existing = state.records.find((r) => r.appointmentId === id);
        if (!existing) {
          if (!state.goals.length) { this.fail({ code: 'CONTEXT_NOT_FOUND' }); return; }
          state.view = this.newRecord(state, selectedAppointment); this.display(); return;
        }
        name = 'edit-record'; id = existing.id;
      }
      if (['edit-record', 'preview-record'].includes(name) && therapist) {
        if (name === 'preview-record') {
          const preview = await this.api.recordPreview(context.centerId, context.roomId, id, context.signal);
          if (!available()) return;
          if (savedRevision !== null && preview.recordRevision !== savedRevision) {
            state.readNotice = '기록은 저장됐지만 이후 내용이 변경되어 공유 준비를 멈췄어요. 기록 목록에서 최신 내용을 확인해 주세요.';
            return;
          }
          if (preview.attachmentCount && (!this.deliveryEnabled || !Array.isArray(preview.attachments) ||
              preview.attachments.length !== preview.attachmentCount || preview.attachments.some((file) => file.share !== true))) {
            this.fail({ code: 'ATTACHMENTS_NOT_CONNECTED' }); return;
          }
          state.view = { kind: 'publish', preview: publicCarePreview(preview), values: {} };
        } else {
          const record = await this.api.record(context.centerId, context.roomId, id, context.signal);
          if (!available()) return;
          if (record.attachmentCount && (!this.deliveryEnabled || !Array.isArray(record.attachments) || record.attachments.length !== record.attachmentCount)) {
            this.fail({ code: 'ATTACHMENTS_NOT_CONNECTED' }); return;
          }
          if (selectedAppointment && record.appointmentId !== selectedAppointment.id) { this.fail({ code: 'CONTEXT_CHANGED' }); return; }
          // A record's appointmentRevision is historical. Pin the currently
          // authorized appointment head, never infer it from its old snapshot
          // or a date-bounded list that may omit a rescheduled appointment.
          const appointment = record.appointmentId
            ? selectedAppointment ?? await this.currentAppointment(context, record.appointmentId) : null;
          if (!available()) return;
          const references = [];
          for (const reference of record.referenceSources ?? []) {
            let body = reference.body;
            if (reference.feedbackId) {
              const message = await this.api.feedback(context.centerId, context.roomId, reference.feedbackId, context.signal, reference.feedbackRevision);
              if (!available()) return;
              body = message.feedback?.reaction ?? message.body;
            }
            references.push({ ...reference, body });
          }
          if (!available()) return;
          state.view = { kind: 'record', recordId: record.id, expectedRevision: record.revision,
            values: clone(record), references, goals: clone(state.goals),
            ...(appointment ? { appointment, expectedAppointmentRevision: appointment.revision } : {}) };
        }
        this.display();
        if (name === 'edit-record' && state.view?.kind === 'record' && state.view.values.status === 'saved') {
          // Capture only the first authorized form, including native string
          // values such as measurement "0". Redisplay must never rebase edits.
          const form = this.dialog?.querySelector('form');
          if (form && !this.recordBaselines.has(state.view)) {
            try { this.recordBaselines.set(state.view, JSON.stringify(recordValues(form, state.view.values))); }
            catch { /* Without a confirmed baseline, closing retains the form. */ }
          }
        }
        return;
      }
      let message = context.messages.find((m) => m.id === id);
      if (!message) return;
      if (name === 'text-review') {
        if (!careMessageActions(message, roleOf(context), context.user.userId).includes(name)) return;
        // This single authorized read pins current source and private note in
        // the same server transaction, without putting the note in chat DTOs.
        const review = await this.api.textReview(context.centerId, context.roomId, id, context.signal);
        if (!available()) return;
        if (review?.messageId !== id || review.conversationId !== context.roomId) throw new LocalApiError('INVALID_RESPONSE');
        state.view = { kind: 'text-review', messageId: id, expectedRevision: review.revision,
          expectedReviewVersion: review.reviewVersion, reviewedRevision: review.reviewedRevision,
          sourceBody: review.body, attachmentCount: review.attachmentCount, values: { note: review.note } };
        this.display(); return;
      }
      const genericActions = ['reply', 'reference', 'text-edit', 'text-delete-self', 'text-delete-all'];
      if (genericActions.includes(name)) {
        if (!careMessageActions(message, roleOf(context), context.user.userId).includes(name)) return;
        // The initial list is only a hint. Recheck current source and server
        // capabilities before opening a form, using the same opening token.
        message = await this.api.message(context.centerId, context.roomId, id, context.signal);
        if (!available()) return;
        if (message.id !== id || message.conversationId !== context.roomId ||
            !careMessageActions(message, roleOf(context), context.user.userId).includes(name)) {
          this.fail({ code: 'MESSAGE_CONFLICT' }); return;
        }
        if (name === 'reply') {
          state.replyDraftId = crypto.randomUUID();
          state.view = { kind: 'reply', replyDraftId: state.replyDraftId, messageId: id, sourceType: message.type, attachmentCount: files(message),
            ...(message.type === 'text' ? { expectedReplyVersion: message.version } : {}),
            ...(message.type === 'feedback' ? { expectedReplyRevision: message.feedback.revision, feedbackId: message.feedback.id,
              ...(this.deliveryEnabled && Array.isArray(message.attachments) ? { attachments: clone(message.attachments) } : {}) } : {}),
            sourceBody: message.feedback?.reaction ?? message.publication?.title ?? message.body, values: { body: '' } };
        } else if (name === 'reference') {
          state.view = this.newRecord(state);
          state.view.references = [message.type === 'text'
            ? { messageId: id, messageRevision: message.version, body: message.body, attachmentCount: files(message),
              ...(this.deliveryEnabled && Array.isArray(message.attachments) ? { attachments: clone(message.attachments) } : {}) }
            : { messageId: id, feedbackId: message.feedback.id, feedbackRevision: message.feedback.revision, body: message.feedback.reaction, attachmentCount: files(message),
              ...(this.deliveryEnabled && Array.isArray(message.attachments) ? { attachments: clone(message.attachments) } : {}) }];
        } else if (name === 'text-edit') {
          state.view = { kind: 'text-edit', messageId: id, expectedRevision: message.version,
            attachmentCount: files(message), values: { body: message.body } };
        } else {
          const scope = name === 'text-delete-all' ? 'all' : 'self';
          state.view = { kind: 'text-delete', messageId: id, scope, ...(scope === 'all' ? { expectedRevision: message.version } : {}),
            sourceDeleted: message.deleted === true, sourceBody: message.deleted ? '삭제된 소식입니다.' : message.body,
            attachmentCount: files(message), values: { confirmed: false } };
        }
        this.display(); return;
      }
      if (message.hidden || message.deleted) return;
      if (name === 'withdraw' && therapist && message.type === 'publication' && !message.archived) {
        state.view = { kind: 'withdraw', messageId: id, sourceTitle: message.publication.title, values: {} };
      } else if (name === 'feedback' && !therapist && roleOf(context) === 'guardian' && message.type === 'publication' && message.publication?.activity && !message.archived) {
        state.view = { kind: 'feedback', feedbackId: crypto.randomUUID(), sourceMessageId: id, expectedRevision: 0,
          sourceTitle: message.publication.title, values: { date: localDay(), result: 'done', reaction: '', difficulty: '' } };
      } else if (name === 'edit-feedback' && roleOf(context) === 'guardian' && message.authorId === context.user.userId && message.feedback && !message.archived) {
        // Capture the current feedback revision and its complete file list as
        // one snapshot. An older message list cannot silently omit attachments.
        const current = await this.api.feedback(context.centerId, context.roomId, message.feedback.id, context.signal);
        if (!available()) return;
        if (current.id !== id || current.conversationId !== context.roomId || current.hidden || current.deleted || current.archived ||
            current.authorId !== context.user.userId || !version(current.feedback?.revision)) { this.fail({ code: 'FEEDBACK_CONFLICT' }); return; }
        message = current;
        if (files(message) && (!this.deliveryEnabled || !Array.isArray(message.attachments) || message.attachments.length !== files(message))) {
          this.fail({ code: 'ATTACHMENTS_NOT_CONNECTED' }); return;
        }
        // Active publications belong to the same coherent workspace snapshot
        // but are independent of the bounded chat window. A recent feedback
        // can refer to a still-active activity shared much earlier.
        const source = [...context.messages, ...(context.careData?.publications ?? [])].find((m) =>
          m.conversationId === context.roomId && m.type === 'publication' &&
          m.publication?.id === message.feedback.publicationId && !m.archived && !m.hidden && !m.deleted);
        if (!source) { this.fail({ code: 'PUBLICATION_CLOSED' }); return; }
        state.view = { kind: 'feedback', feedbackId: message.feedback.id, messageId: message.id, sourceMessageId: source.id,
          expectedRevision: message.feedback.revision, sourceTitle: source.publication.title, values: { ...clone(message.feedback),
            ...(this.deliveryEnabled ? { attachments: clone(message.attachments ?? []) } : {}) } };
      } else if (name === 'review' && therapist && message.feedback) {
        const review = await this.api.feedbackReview(context.centerId, context.roomId, message.feedback.id, context.signal);
        if (!available()) return;
        if (review.revision !== message.feedback.revision) { this.fail({ code: 'FEEDBACK_CONFLICT' }); return; }
        state.view = { kind: 'review', feedbackId: message.feedback.id, messageId: message.id, expectedRevision: review.revision,
          ...(this.deliveryEnabled && Array.isArray(message.attachments) ? { attachments: clone(message.attachments) } : {}),
          expectedReviewVersion: review.reviewVersion, sourceBody: message.feedback.reaction, values: { note: review.note ?? '' } };
      } else return;
      this.display();
    } catch (error) { if (this.current(context, epoch)) this.fail(error); }
    finally {
      if (state.opening === opening) {
        state.opening = null;
        if (this.current(context, epoch)) this.render();
      }
    }
  }
  async currentAppointment(context, id) {
    const appointment = await this.api.appointment(context.centerId, context.roomId, id, context.signal);
    if (appointment?.id !== id || appointment.conversationId !== context.roomId || !version(appointment.revision)) throw { code: 'INVALID_RESPONSE' };
    return clone(appointment);
  }
  clearComparison(state, notice = '') {
    if (!state) return;
    const previous = state.comparison;
    previous?.controller?.abort();
    if (previous) previous.groups = [];
    state.comparison = notice ? { notice, key: comparisonScope(this.getContext(), state) } : null;
  }
  reconcileComparison(context, state) {
    const comparison = state.comparison;
    if (!comparison) return;
    const key = comparisonScope(context, state);
    if (comparison.key === key) return;
    if (state.loaded && comparison.loaded && Number.isSafeInteger(context.roomRevision) && comparison.revision === context.roomRevision) {
      comparison.key = key; return;
    }
    this.clearComparison(state, '기록 또는 열람 범위가 바뀌어 이전 비교를 닫았어요. 다시 조회해 주세요.');
  }
  async loadComparison(context, state) {
    if (!state.loaded || state.comparison?.loading) return;
    this.clearComparison(state);
    const epoch = this.epoch, controller = new AbortController();
    const comparison = { loading: true, loaded: false, groups: [], key: comparisonScope(context, state), controller };
    state.comparison = comparison; this.render();
    const current = () => this.current(context, epoch) && state.comparison === comparison && !controller.signal.aborted;
    try {
      const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
      const result = await this.api.recordMeasurements(context.centerId, context.roomId, signal);
      if (!current()) return;
      if (!Number.isSafeInteger(result?.revision) || result.revision < 0 || !Array.isArray(result.measurements)) throw new LocalApiError('INVALID_RESPONSE');
      comparison.groups = groupCareMeasurements(result.measurements); comparison.revision = result.revision;
      comparison.loaded = true;
    } catch (error) {
      if (!current()) return;
      comparison.groups = []; comparison.loaded = false;
      if (['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) { this.clearComparison(state); this.fail(error); return; }
      comparison.notice = error?.code === 'TOO_MUCH_DATA'
        ? '한 번에 비교할 수 있는 범위를 넘었어요. 일부 결과는 표시하지 않았습니다.'
        : '측정값 전체를 확인하지 못했어요. 일부 결과는 표시하지 않았습니다. 다시 조회해 주세요.';
    } finally {
      if (current()) { comparison.loading = false; comparison.controller = null; this.render(); }
    }
  }
  newRecord(state, appointment = null) {
    return { kind: 'record', recordId: crypto.randomUUID(), expectedRevision: 0, references: [], goals: clone(state.goals),
      ...(appointment ? { appointment: clone(appointment), expectedAppointmentRevision: appointment.revision } : {}),
      values: { date: appointment?.date ?? localDay(), goalId: appointment ? '' : state.goals[0]?.id ?? '', title: appointment?.title ?? '',
        ...(appointment ? { appointmentId: appointment.id } : {}),
        performed: '', response: '', nextPlan: '', summary: '', privateNote: '', assessments: [], observation: null, activity: null } };
  }
  async submit(submitter) {
    const state = this.state(), form = this.dialog?.querySelector('form');
    if (!state?.view || !form || state.mutation.operation || ['record-cleanup', 'feedback-cleanup', 'reply-cleanup', 'receipt'].includes(state.view.kind)) return;
    const draft = state.view.kind === 'record' && submitter?.value === 'draft';
    if (!draft && !form.reportValidity()) return;
    this.snapshot(); const view = state.view, values = view.values;
    const prepareShare = view.kind === 'record' && submitter?.value === 'prepare-share';
    if (prepareShare && !values.summary?.trim()) {
      const sharing = form.querySelector('.care-sharing-fields'); if (sharing) sharing.open = true;
      this.notice('공유 준비에는 보호자에게 전할 요약이 필요해요. 아직 저장하거나 공유하지 않았습니다.');
      form.elements.namedItem('summary')?.focus(); return;
    }
    try {
      let kind = view.kind, target, body;
      if (kind === 'record') {
        if (view.contextStale || view.contextRefresh) throw new Error('목표·일정 다시 확인 후 내용을 검토해 주세요. 입력은 보존했습니다.');
        target = view.recordId;
        const goal = view.goals.find((g) => g.id === values.goalId);
        if (!goal) throw new Error('연결 목표를 확인해 주세요.');
        if (values.appointmentId && (view.appointment?.id !== values.appointmentId || !version(view.expectedAppointmentRevision)))
          throw new Error('연결 일정의 현재 내용을 확인한 뒤 기록을 다시 열어 주세요. 입력은 보존했습니다.');
        body = { expectedRevision: view.expectedRevision, expectedGoalRevision: goal.revision,
          ...(values.appointmentId ? { expectedAppointmentRevision: view.expectedAppointmentRevision } : {}),
          content: careRecordContent(values, draft ? 'draft' : 'saved', view.references,
            this.recordMedia ? this.recordMedia.captureRecordAttachments(values.attachments ?? []) : undefined) };
      } else if (kind === 'publish') {
        if (!values.confirmed) throw new Error('받는 보호자와 공개 내용을 확인해 주세요.');
        target = view.preview.recordId; body = { expectedRevision: view.preview.recordRevision,
          expectedRelationshipsVersion: view.preview.relationshipsVersion, recipientIds: view.preview.recipientIds };
      } else if (kind === 'feedback') {
        target = view.feedbackId; body = { sourceMessageId: view.sourceMessageId, expectedRevision: view.expectedRevision,
          content: { ...feedbackFields(values), ...(this.feedbackMedia ? { attachments: this.feedbackMedia.captureFeedbackAttachments(values.attachments ?? []) } : {}) } };
      } else if (kind === 'review') {
        target = view.feedbackId; body = { expectedRevision: view.expectedRevision, expectedReviewVersion: view.expectedReviewVersion, note: values.note.trim() };
      } else if (kind === 'text-review') {
        target = view.messageId; body = careTextReviewContent(view, values);
      } else if (kind === 'family-plan') {
        target = view.childId; body = careFamilyPlanContent(view, values);
      } else if (contextEditors[kind]) {
        const config = contextEditors[kind];
        if (roleOf(this.getContext()) !== 'therapist' || view.stale) throw new Error(config.stale);
        target = view[config.idKey]; body = { expectedRevision: view.expectedRevision, content: this[kind + 'Api'].content(config.values(values)) };
      } else if (kind === 'reply') {
        target = view.messageId; body = careReplyContent(view, values, this.replyMedia ? this.replyMedia.captureAttachments() : []);
      } else if (kind === 'text-edit' || kind === 'text-delete') {
        target = view.messageId; body = careTextChange(view, values);
      } else { target = view.messageId; body = {}; }
      view.error = ''; const operation = state.mutation.begin(kind, target, body);
      state.sharePreparation = prepareShare ? { operation } : null;
      await this.mutate(true);
    } catch (error) { this.notice(error.message); }
  }
  async mutate(started = false) {
    const state = this.state(), context = this.getContext(), epoch = this.epoch;
    if (!state || !this.current(context) || !state.mutation.operation) return;
    const operation = started ? state.mutation.operation : state.mutation.begin();
    if (!operation) return;
    this.clearReferenceSource();
    const submittedView = started ? state.view : null;
    const replyDraftId = state.replyDraftId;
    this.recordMedia?.update();
    this.feedbackMedia?.update();
    this.replyMedia?.update();
    this.lockForm();
    let completedPreparation = null;
    try {
      const args = [context.centerId, context.roomId, operation.targetId, operation.body, context.signal];
      let receipt;
      if (operation.kind === 'record') {
        receipt = await this.api.recordSave(...args);
        if (state.sharePreparation?.operation === operation && (receipt?.operation !== 'save' ||
            receipt.recordId !== operation.targetId || !version(receipt.revision) || receipt.revision !== operation.body.expectedRevision + 1))
          throw new LocalApiError('INVALID_RESPONSE');
      }
      else if (operation.kind === 'publish') await this.api.recordPublish(...args);
      else if (operation.kind === 'feedback') await this.api.feedbackSave(...args);
      else if (operation.kind === 'review') await this.api.feedbackReviewSave(...args);
      else if (operation.kind === 'text-review') await this.api.textReviewSave(...args);
      else if (operation.kind === 'family-plan') await this.api.familyPlanSave(...args);
      else if (contextEditors[operation.kind]) await this[operation.kind + 'Api'].save(...args);
      else if (operation.kind === 'reply') await this.api.send(context.centerId, context.roomId, operation.body, context.signal);
      else if (operation.kind === 'text-edit') await this.api.messageEdit(...args);
      else if (operation.kind === 'text-delete') await this.api.messageDelete(...args);
      else await this.api.withdraw(context.centerId, context.roomId, operation.targetId, context.signal);
      if (!this.current(context, epoch)) return;
      if (state.sharePreparation?.operation === operation)
        completedPreparation = { intent: state.sharePreparation, revision: receipt.revision };
      if (operation.kind === 'record') this.recordMedia?.forgetSaved(this.recordScope(context), operation.targetId,
        (operation.body.content.attachments ?? []).map((file) => file.id));
      if (operation.kind === 'feedback') this.feedbackMedia?.forgetFeedbackSaved(this.recordScope(context), operation.targetId,
        (operation.body.content.attachments ?? []).map((file) => file.id));
      if (operation.kind === 'reply' && replyDraftId) this.replyMedia?.forgetReplySent(this.recordScope(context), replyDraftId,
        (operation.body.attachments ?? []).map((file) => file.id));
      state.mutation.accepted(operation); state.view = null; state.loaded = false;
      if (operation.kind === 'reply') state.replyDraftId = null;
      if (operation.kind === 'record' && state.comparison) this.clearComparison(state, '기록이 저장되어 이전 비교를 닫았어요. 다시 조회해 주세요.');
      this.wipeDialog(); this.render();
      await Promise.resolve(this.onChanged({ userId: context.user.userId, centerId: context.centerId, roomId: context.roomId,
        appendMessage: ['publish', 'reply'].includes(operation.kind) ||
          (operation.kind === 'feedback' && operation.body.expectedRevision === 0) })).catch((error) => this.fail(error));
    } catch (error) {
      if (!this.current(context, epoch)) return;
      // A failed/unknown save may be retried with its immutable ID, but never
      // silently continues into a different user action after that uncertainty.
      state.sharePreparation = null;
      const alreadyUncertain = state.mutation.everUncertain;
      const rejected = rejectedCodes.has(error?.code) || rejectedCareAttachment(operation, error);
      if (rejected && !state.mutation.everUncertain) state.mutation.rejected(operation);
      else state.mutation.failed(operation);
      if (!state.mutation.operation && operation.kind === 'reply' && state.view?.kind === 'reply' &&
          ['PUBLICATION_CLOSED', 'MESSAGE_DELETED'].includes(error?.code)) {
        this.sourceUnavailable(state); return;
      }
      if (!state.mutation.operation && !alreadyUncertain && operation.kind === 'record' && submittedView?.kind === 'record' &&
          ['receipt', 'record'].includes(state.view?.kind) && error instanceof LocalApiError && error.code === 'CONTEXT_CHANGED' && error.status === 409) {
        // A first, definitive context rejection did not save the record. A poll
        // may have hidden its form, but is not a reason to discard authored input.
        // Keep the pinned context; reveal it only after current child and source
        // authority are rechecked. Unknown retries never enter this branch.
        const visible = this.dialog?.open;
        // A pre-submit source check may still reference this same view object.
        // It cannot authorize a new restoration or clear it with a late error.
        state.readCheck = null;
        submittedView.requiresProfileCheck = true; submittedView.profileChildId = context.profile?.childId;
        submittedView.contextStale = true;
        submittedView.error = safeMessage(error); state.view = submittedView;
        this.wipeDialog(); this.render();
        if (await this.guardView(context, state) && this.current(context, epoch) && state.view === submittedView && visible) {
          this.display(); this.notice(submittedView.error);
        }
        return;
      }
      if (!state.mutation.operation && !alreadyUncertain && submittedView &&
          ['record', 'feedback', 'reply'].includes(submittedView.kind) && state.view?.kind === 'receipt' &&
          error instanceof LocalApiError && [400, 409, 413].includes(error.status) &&
          !['PUBLICATION_CLOSED', 'MESSAGE_DELETED'].includes(error.code)) {
        // A successful poll hiding a pending form is not a loss of source
        // permission. On the first definitive no-write response, retain the
        // authored input and selected files, but keep them out of the DOM until
        // fresh room/role/child and source checks succeed. Unknown retries must
        // never become a new editable operation through this recovery path.
        const visible = this.dialog?.open;
        state.readCheck = null;
        submittedView.requiresProfileCheck = true; submittedView.profileRole = roleOf(context);
        submittedView.profileChildId = context.profile?.childId; submittedView.error = safeMessage(error);
        state.view = submittedView; this.wipeDialog(); this.render();
        if (await this.guardView(context, state) && this.current(context, epoch) &&
            roleOf(this.getContext()) === roleOf(context) && state.view === submittedView && visible) {
          this.display(); this.notice(submittedView.error);
        }
        return;
      }
      if (!state.mutation.operation && contextEditors[operation.kind]) {
        const config = contextEditors[operation.kind];
        if (state.view?.kind === 'receipt') {
          // A poll can hide a pending form before a definitive first rejection.
          // Restore only the submitted input and only after current authority.
          const visible = this.dialog?.open;
          const view = { kind: operation.kind, [config.idKey]: operation.targetId, childId: context.profile?.childId,
            expectedRevision: operation.body.expectedRevision, values: clone(operation.body.content),
            stale: error?.code === config.conflict, latest: null, error: safeMessage(error) };
          state.view = view; this.wipeDialog(); this.render();
          if (await this.guardView(context, state) && this.current(context, epoch) && state.view === view && visible) {
            this.display(); this.notice(view.stale ? config.stale : safeMessage(error));
          }
          return;
        }
        if (state.view?.kind === operation.kind && error?.code === config.conflict) {
          state.view.stale = true; state.view.latest = null; this.contextComparison(operation.kind);
        }
      }
      if (!state.mutation.operation && state.view?.kind === 'family-plan' && error?.code === 'PROFILE_CONFLICT') state.view.stale = true;
      if (!state.mutation.operation && state.view?.kind === 'receipt' && operation.kind === 'family-plan' && error?.code === 'PROFILE_CONFLICT') {
        // Polling hides a pending form's source. A definitive first-attempt
        // conflict may restore only the user's submitted draft, after a fresh
        // permission check; never merge another guardian's latest content.
        const visible = this.dialog?.open;
        const draft = { kind: 'family-plan', childId: operation.targetId, expectedRevision: operation.body.expectedRevision,
          stale: true, values: { concern: operation.body.concern } };
        state.view = draft; this.wipeDialog(); this.render();
        if (await this.guardView(context, state) && this.current(context, epoch) && state.view === draft && visible) this.display();
        return;
      }
      if (!state.mutation.operation && state.view?.kind === 'receipt') {
        // Polling may have hidden the original form before this first attempt
        // was definitively rejected. Do not resurrect that unchecked source,
        // and do not leave an empty receipt screen with nothing to retry.
        const visible = this.dialog?.open;
        const cleanup = operation.kind === 'record' && this.recordMedia?.hasRecordSelections(this.recordScope(context), operation.targetId);
        const feedbackCleanup = operation.kind === 'feedback' && this.feedbackMedia?.hasFeedbackSelections(this.recordScope(context), operation.targetId);
        const replyCleanup = operation.kind === 'reply' && this.replyMedia?.hasReplySelections(this.recordScope(context), replyDraftId);
        state.view = cleanup ? { kind: 'record-cleanup', recordId: operation.targetId, values: {} }
          : feedbackCleanup ? { kind: 'feedback-cleanup', feedbackId: operation.targetId, values: {} }
            : replyCleanup ? { kind: 'reply-cleanup', replyDraftId, values: {} } : null;
        if (operation.kind === 'reply' && !replyCleanup) state.replyDraftId = null;
        this.wipeDialog();
        if ((cleanup || feedbackCleanup) && visible) this.display();
        if (replyCleanup && await this.guardView(context, state) && this.current(context, epoch) && state.view?.kind === 'reply-cleanup' && visible) this.display();
        this.render();
        if (!cleanup && !feedbackCleanup && !replyCleanup) this.fail({ code: 'RECEIPT_REJECTED' });
        return;
      }
      this.recordMedia?.update(); this.feedbackMedia?.update(); this.replyMedia?.update(); this.lockForm();
      if (alreadyUncertain && ['NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) {
        this.receiptOnly(state);
        this.notice('현재 원문을 열람할 수 없지만 이전 요청의 처리 결과는 아직 확인되지 않았어요. 원래 요청을 보존했습니다.');
      } else if (rejected && state.mutation.everUncertain) {
        // A later state-dependent rejection cannot prove the first attempt
        // never committed. Keep its exact identity; do not invent a new save.
        state.view.error = '이전 요청의 처리 여부를 아직 확인하지 못했어요. 현재의 충돌만으로 저장 실패를 단정하지 않았습니다. 같은 내용·요청 번호를 보존했으며, 연결 상태를 확인한 뒤 다시 확인해 주세요.';
        this.notice(state.view.error);
      } else if (state.view?.kind === 'family-plan' && state.view.stale) {
        state.view.error = staleFamilyPlan; this.notice(staleFamilyPlan);
      } else this.fail(error);
    }
    // This GET is a distinct phase. A preview failure cannot turn an accepted
    // save into an unknown save or cause the record POST to be sent again.
    if (completedPreparation && state.sharePreparation === completedPreparation.intent) {
      state.sharePreparation = null;
      if (!this.current(context, epoch) || state.view || state.opening || state.mutation.operation) return;
      if (state.loaded) await this.handleAction('preview-record', operation.targetId, completedPreparation.revision);
      if (!this.current(context, epoch)) return;
      if (state.view?.kind === 'publish') this.notice('기록을 저장했어요. 아직 보호자에게 전송하지 않았습니다.');
      else if (!state.view && !state.opening) {
        state.readNotice ||= '기록은 저장됐지만 공유 미리보기를 열지 못했어요. 기록 목록에서 공유 미리보기를 다시 열어 주세요.';
        this.render();
      }
    }
  }
  fail(error) {
    if (['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) { this.clear(); this.onError(error); return; }
    const message = safeMessage(error), state = this.state();
    if (state && ['SOURCE_UNAVAILABLE', 'SOURCE_CHECK_UNAVAILABLE', 'RECEIPT_REJECTED'].includes(error?.code)) state.readNotice = message;
    if (state?.view) state.view.error = message;
    if (this.dialog?.open) this.notice(message);
    else if (this.host) {
      this.painted = null;
      let status = this.host.querySelector('[data-care-status]');
      if (!status) { status = this.host.ownerDocument.createElement('p'); status.dataset.careStatus = ''; status.setAttribute('role', 'status'); this.host.append(status); }
      status.textContent = message;
    }
  }
}
