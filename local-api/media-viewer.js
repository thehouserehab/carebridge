import { LocalApiError } from './client.js';
import { MEDIA_TYPES, MEDIA_LIMITS } from '../src/media-policy.js';

const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const validRevision = (value) => Number.isInteger(value) && value > 0 && value <= 2147483647;
const scopeOf = (c) => Object.freeze({ userId: c.user.userId, centerId: c.centerId, roomId: c.roomId });
const permitted = (c) => c?.enabled === true && c.visible !== false && c.connected === true &&
  [c.user?.userId, c.centerId, c.roomId].every(validId) && !c.signal?.aborted;
const sameScope = (scope, c) => scope.userId === c.user?.userId && scope.centerId === c.centerId && scope.roomId === c.roomId;
const sameFile = (a, b) => !!a && !!b && ['id', 'name', 'type', 'size'].every((key) => a[key] === b[key]);

function selectedAttachment(attachments, attachmentId) {
  if (!Array.isArray(attachments) || attachments.length > MEDIA_LIMITS.count ||
      new Set(attachments.map((file) => file?.id)).size !== attachments.length) throw new LocalApiError('NOT_FOUND', 404);
  const file = attachments.find((value) => value?.id === attachmentId);
  if (!file || !uuid(file.id) || typeof file.name !== 'string' || !file.name.trim() || file.name !== file.name.trim() ||
      file.name.length > 255 || !file.name.isWellFormed() || /[\x00-\x1f\x7f/\\]/.test(file.name) || !MEDIA_TYPES.includes(file.type) ||
      !Number.isSafeInteger(file.size) || file.size < 1 || file.size > (file.type.startsWith('image/') ? MEDIA_LIMITS.image : MEDIA_LIMITS.video))
    throw new LocalApiError('INVALID_RESPONSE');
  return Object.freeze({ id: file.id, name: file.name, type: file.type, size: file.size });
}
function attachmentFrom(message, roomId, messageId, attachmentId) {
  if (!message || message.id !== messageId || message.conversationId !== roomId || message.hidden || message.deleted)
    throw new LocalApiError('NOT_FOUND', 404);
  return selectedAttachment(message.attachments, attachmentId);
}
function recordAttachmentFrom(record, roomId, source, attachmentId) {
  if (!record || record.id !== source.recordId || record.conversationId !== roomId || record.revision !== source.revision)
    throw new LocalApiError('NOT_FOUND', 404);
  if (source.kind === 'record-reference') {
    const references = record.referenceSources;
    if (!Array.isArray(references) || references.filter((ref) => ref?.messageId === source.messageId).length !== 1)
      throw new LocalApiError('NOT_FOUND', 404);
    // The server supplies files captured at this record revision. Never fall
    // back to the current chat/feedback or to this record's own attachments.
    return selectedAttachment(references.find((ref) => ref.messageId === source.messageId).attachments, attachmentId);
  }
  if (!Array.isArray(record.attachments) || record.attachments.some((file) => typeof file?.share !== 'boolean'))
    throw new LocalApiError('NOT_FOUND', 404);
  return selectedAttachment(record.attachments, attachmentId);
}
function validSource(source) {
  switch (source.kind) {
    case 'message': return validId(source.messageId);
    case 'record': return validId(source.recordId) && validRevision(source.revision);
    case 'feedback': return validId(source.feedbackId) && validId(source.messageId) && validRevision(source.revision);
    case 'record-reference': return validId(source.recordId) && validRevision(source.revision) && validId(source.messageId);
    case 'current-reference': return validId(source.messageId) && validRevision(source.revision) &&
      (source.messageType === 'feedback' ? validId(source.feedbackId)
        : source.messageType === 'text' && !Object.hasOwn(source, 'feedbackId'));
    default: return false;
  }
}
function sourceButton(source, attachmentId) {
  switch (source.kind) {
    case 'record': return ['openRecordAttachment', { openRecordAttachment: attachmentId, recordId: source.recordId, recordRevision: String(source.revision) }];
    case 'feedback': return ['openFeedbackAttachment', { openFeedbackAttachment: attachmentId, feedbackId: source.feedbackId,
      messageId: source.messageId, feedbackRevision: String(source.revision) }];
    case 'record-reference': return ['openReferenceAttachment', { openReferenceAttachment: attachmentId,
      recordId: source.recordId, recordRevision: String(source.revision), messageId: source.messageId }];
    case 'current-reference': return ['openCurrentReferenceAttachment', { openCurrentReferenceAttachment: attachmentId,
      messageId: source.messageId, messageType: source.messageType, referenceRevision: String(source.revision),
      ...(source.messageType === 'feedback' ? { feedbackId: source.feedbackId } : {}) }];
    default: return ['openAttachment', { openAttachment: attachmentId, messageId: source.messageId }];
  }
}

// One bound-source viewer, no original upload preview, browser persistence,
// arbitrary source URL or implicit autoplay. The HTTP client verifies bytes;
// this owner checks current message authorization before and after that read.
export class MediaViewer {
  constructor({ api, mediaApi, getContext, onError = () => {}, onClose = () => {} }) {
    this.api = api; this.mediaApi = mediaApi; this.getContext = getContext; this.onError = onError; this.onClose = onClose;
    this.host = null; this.operation = null; this.dialog = null; this.media = null; this.objectUrl = null;
  }
  bind(host) { if (this.host !== host) { this.clear(); this.host = host; } }
  current(op) {
    const c = this.getContext(op.source);
    return this.operation === op && !op.signal.aborted && permitted(c) && sameScope(op.scope, c) && c.generation === op.generation &&
      (op.source.kind === 'message' || c.role === 'therapist');
  }
  assertCurrent(op) { if (!this.current(op)) throw new LocalApiError('CANCELLED'); }
  releaseMedia() {
    const media = this.media, url = this.objectUrl; this.media = null; this.objectUrl = null;
    if (media) {
      try { media.pause?.(); } catch { /* Already detached/unsupported playback. */ }
      media.removeAttribute('src');
      for (const source of media.querySelectorAll?.('source') ?? []) source.removeAttribute('src');
      try { media.load?.(); } catch { /* Detachment must continue. */ }
      media.remove();
    }
    if (url) URL.revokeObjectURL(url);
  }
  clear() {
    const op = this.operation; this.operation = null;
    op?.signal.removeEventListener('abort', op.onAbort); op?.controller.abort();
    this.releaseMedia();
    const dialog = this.dialog; this.dialog = null;
    if (dialog?.open) dialog.close();
    this.host?.replaceChildren();
  }
  suspend() { this.clear(); }
  close() {
    const op = this.operation;
    const current = op && this.current(op);
    let opener = null;
    if (current) {
      if (op.opener?.isConnected && !op.opener.disabled) opener = op.opener;
      else {
        // Polling may replace the original button. Restore only a currently
        // visible exact anchor, never create a missing/withdrawn message again.
        const doc = this.host?.ownerDocument ?? globalThis.document;
        const [attribute, values] = sourceButton(op.source, op.attachmentId);
        const selector = `button[data-${attribute.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`;
        opener = [...(doc?.querySelectorAll?.(selector) ?? [])].find((button) =>
          button.isConnected && !button.disabled && Object.entries(values).every(([key, value]) =>
            (button.dataset[key] ?? (key === 'messageId' && op.source.kind === 'message' ? button.closest('[data-message-id]')?.dataset.messageId : undefined)) === value) &&
          button.getClientRects().length > 0 && !button.closest('[hidden],[inert]')) ?? null;
      }
    }
    this.clear();
    // Only an explicit close in the same permitted lifetime may restore the
    // owner's UI. Abort, permission loss, navigation and reconcile use clear()
    // and must never resurrect a projection from the previous scope.
    if (current) this.onClose(op.source);
    opener?.focus({ preventScroll: true });
  }
  shell(op) {
    const title = { record: '기록 첨부', feedback: '활동 경험 첨부', 'record-reference': '당시 참고 첨부',
      'current-reference': '현재 참고 첨부', message: '대화 첨부' }[op.source.kind];
    this.host.innerHTML = '<dialog class="media-viewer" data-testid="media-viewer" aria-labelledby="media-viewer-title">' +
      `<div class="media-viewer-heading"><h2 id="media-viewer-title">${title}</h2><button type="button" data-media-viewer-close aria-label="첨부 닫기">닫기</button></div>` +
      '<p class="small" data-media-viewer-name></p><p class="small" role="status" aria-live="polite" data-media-viewer-status>현재 열람 권한과 파일을 확인하고 있어요.</p>' +
      '<div class="media-viewer-content" data-media-viewer-content></div></dialog>';
    const dialog = this.host.querySelector('dialog'); this.dialog = dialog;
    const close = dialog.querySelector('[data-media-viewer-close]');
    close.addEventListener('click', () => { if (this.operation === op) this.close(); });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (this.operation === op) this.close(); });
    dialog.addEventListener('close', () => { if (this.operation === op) this.close(); });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog || this.operation !== op) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.close();
    });
    dialog.showModal(); close.focus({ preventScroll: true });
  }
  async open(messageId, attachmentId) {
    return this.#openSource(Object.freeze({ kind: 'message', messageId }), attachmentId);
  }
  async openRecord(recordId, revision, attachmentId) {
    return this.#openSource(Object.freeze({ kind: 'record', recordId, revision }), attachmentId);
  }
  async openFeedback(feedbackId, messageId, revision, attachmentId) {
    return this.#openSource(Object.freeze({ kind: 'feedback', feedbackId, messageId, revision }), attachmentId);
  }
  async openReference(recordId, revision, messageId, attachmentId) {
    return this.#openSource(Object.freeze({ kind: 'record-reference', recordId, revision, messageId }), attachmentId);
  }
  async openCurrentReference(input, attachmentId) {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    // The current-source panel owns this short-lived anchor. Never retain its
    // body, arbitrary metadata, or a replacement for the saved clinical source.
    const source = Object.freeze({ kind: 'current-reference', messageId: value.messageId,
      messageType: value.messageType, revision: value.revision,
      ...(Object.hasOwn(value, 'feedbackId') ? { feedbackId: value.feedbackId } : {}) });
    return this.#openSource(source, attachmentId);
  }
  async readAttachment(op) {
    const { source, scope, signal, attachmentId } = op;
    if (['record', 'record-reference'].includes(source.kind)) {
      const record = await this.api.record(scope.centerId, scope.roomId, source.recordId, signal, source.revision);
      this.assertCurrent(op);
      return recordAttachmentFrom(record, scope.roomId, source, attachmentId);
    }
    if (source.kind === 'feedback') {
      const message = await this.api.feedback(scope.centerId, scope.roomId, source.feedbackId, signal, source.revision);
      this.assertCurrent(op);
      if (message?.type !== 'feedback' || message.feedback?.id !== source.feedbackId || message.feedback?.revision !== source.revision)
        throw new LocalApiError('NOT_FOUND', 404);
      return attachmentFrom(message, scope.roomId, source.messageId, attachmentId);
    }
    const message = await this.api.message(scope.centerId, scope.roomId, source.messageId, signal);
    this.assertCurrent(op);
    if (source.kind === 'current-reference' && (message?.type !== source.messageType ||
        (source.messageType === 'feedback'
          ? message.feedback?.id !== source.feedbackId || message.feedback?.revision !== source.revision
          : message.version !== source.revision))) throw new LocalApiError('NOT_FOUND', 404);
    return attachmentFrom(message, scope.roomId, source.messageId, attachmentId);
  }
  async readFile(op) {
    const { source, scope, attachment, signal } = op;
    switch (source.kind) {
      case 'record': return this.mediaApi.openRecordAttachment(scope, source.recordId, source.revision, attachment, signal);
      case 'feedback': return this.mediaApi.openFeedbackAttachment(scope, source.messageId, source.revision, attachment, signal);
      case 'record-reference': return this.mediaApi.openReferenceAttachment(scope, source.recordId, source.revision, source.messageId, attachment, signal);
      default: return this.mediaApi.openMessageAttachment(scope, source.messageId, attachment, signal);
    }
  }
  async #openSource(source, attachmentId) {
    this.clear();
    const c = this.getContext(source);
    if (!this.host || !permitted(c) || (source.kind !== 'message' && c.role !== 'therapist')) return false;
    if (!uuid(attachmentId) || !validSource(source)) {
      this.onError(new LocalApiError('INVALID_INPUT'), source); return false;
    }
    const controller = new AbortController();
    const op = { scope: scopeOf(c), generation: c.generation, source, messageId: source.messageId, attachmentId, controller,
      signal: c.signal ? AbortSignal.any([controller.signal, c.signal]) : controller.signal,
      opener: (this.host.ownerDocument ?? globalThis.document)?.activeElement, attachment: null };
    op.onAbort = () => { if (this.operation === op) this.clear(); };
    this.operation = op; op.signal.addEventListener('abort', op.onAbort, { once: true });
    try {
      // Capture the exact file shown by this inspection before the first await.
      // A fresh GET must not silently substitute different metadata even when
      // the source revision still matches. Do not retain it in source identity.
      const expected = source.kind === 'current-reference' ? selectedAttachment(c.referenceAttachments, attachmentId) : null;
      this.shell(op);
      op.attachment = await this.readAttachment(op); this.assertCurrent(op);
      if (expected && !sameFile(expected, op.attachment)) throw new LocalApiError('NOT_FOUND', 404);
      const blob = await this.readFile(op); this.assertCurrent(op);
      if (!(blob instanceof Blob) || blob.type !== op.attachment.type || blob.size !== op.attachment.size) throw new LocalApiError('INVALID_RESPONSE');
      const latest = await this.readAttachment(op); this.assertCurrent(op);
      if (!sameFile(op.attachment, latest)) throw new LocalApiError('NOT_FOUND', 404);
      // Only now may verified bytes become a browser-readable object URL.
      this.objectUrl = URL.createObjectURL(blob);
      const doc = this.host.ownerDocument ?? globalThis.document;
      const media = doc.createElement(op.attachment.type.startsWith('image/') ? 'img' : 'video'); this.media = media;
      if (media.tagName === 'IMG') media.alt = op.attachment.name;
      else { media.controls = true; media.playsInline = true; media.preload = 'metadata'; media.setAttribute('aria-label', op.attachment.name); }
      media.addEventListener('error', () => {
        if (!this.current(op)) return;
        this.releaseMedia(); this.dialog.querySelector('[data-media-viewer-status]').textContent = '파일을 표시하지 못했어요. 닫은 뒤 다시 확인해 주세요.';
      }, { once: true });
      media.src = this.objectUrl;
      this.dialog.querySelector('[data-media-viewer-name]').textContent = op.attachment.name;
      this.dialog.querySelector('[data-media-viewer-status]').textContent = {
        record: `기록 ${source.revision}판의 첨부를 확인했어요. 이 열람만으로 보호자에게 공유되지 않습니다.`,
        feedback: `활동 경험 ${source.revision}판의 첨부입니다. 이후 수정된 파일로 바뀌지 않습니다.`,
        'record-reference': `기록 ${source.revision}판에 참고한 당시 첨부입니다. 기록의 공유 파일에 자동으로 포함되지 않습니다.`,
        'current-reference': `조회 시점 ${source.messageType === 'feedback' ? '활동 경험' : '소식'} ${source.revision}판의 현재 첨부입니다. 기록 당시 참고와 첨부는 바뀌지 않습니다.`,
        message: '현재 대화에서 열람을 확인했어요.',
      }[source.kind];
      this.dialog.querySelector('[data-media-viewer-content]').append(media);
      return true;
    } catch (error) {
      if (!this.current(op)) { if (this.operation === op) this.clear(); return false; }
      const safe = error instanceof LocalApiError ? new LocalApiError(error.code, error.status) : new LocalApiError('UNAVAILABLE');
      this.releaseMedia();
      if (['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(safe.code) || !this.dialog) this.clear();
      else this.dialog.querySelector('[data-media-viewer-status]').textContent = '파일을 열지 못했어요. 닫은 뒤 다시 확인해 주세요.';
      this.onError(safe, source); return false;
    }
  }
  reconcile(messages) {
    const op = this.operation; if (!op) return;
    if (!this.current(op)) { this.clear(); return; }
    // Clinical/feedback versions and the current-source panel are owned outside
    // the chat cache. Their parent contexts/signals invalidate this lifetime.
    if (op.source.kind !== 'message') return;
    if (!Array.isArray(messages)) { this.clear(); return; }
    try {
      const message = messages.find((m) => m.id === op.messageId);
      const current = attachmentFrom(message, op.scope.roomId, op.messageId, op.attachmentId);
      if (op.attachment && !sameFile(op.attachment, current)) this.clear();
    } catch { this.clear(); }
  }
}
