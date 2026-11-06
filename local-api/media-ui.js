import { MEDIA_TYPES, MEDIA_LIMITS, MEDIA_HELP, fileSize, attachmentListValid } from '../src/media-policy.js';
import { MediaApiError, mediaFileManifest } from './media-client.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const selectionId = (c, purpose) => purpose === 'record' ? c?.recordId : purpose === 'feedback' ? c?.feedbackId : purpose === 'reply' ? c?.replyDraftId : null;
const keyOf = (c, purpose = 'message') => c?.user?.userId && c.centerId && c.roomId && (purpose === 'message' || validId(selectionId(c, purpose)))
  ? JSON.stringify([c.user.userId, c.centerId, c.roomId, ...(purpose === 'message' ? [] : [selectionId(c, purpose)])]) : null;
const scopeOf = (c) => Object.freeze({ userId: c.user.userId, centerId: c.centerId, roomId: c.roomId });
const terminal = (u) => u && ['delete_pending', 'deleted'].includes(u.state);
const permitted = (c, purpose = 'message') => !!keyOf(c, purpose) && c.connected && c.visible !== false && !c.signal?.aborted;
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const uploadId = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const sourceOf = (upload) => upload?.mode === 'prepared-delivery' ? upload.source : upload;
const uploadExpired = (upload) => upload?.expired === true ||
  (typeof upload?.expiresAt === 'string' && Number.isFinite(Date.parse(upload.expiresAt)) && Date.parse(upload.expiresAt) <= Date.now());
const expiryNotice = '업로드가 만료되었어요. 상태 확인 또는 취소가 필요해요.';
const inspectionIncompleteNotice = '검사를 완료하지 못했어요. 이 파일은 아직 전송할 수 없어요. 상태 갱신으로 다시 확인하거나 업로드를 취소해 주세요.';
const uploadNotice = (upload, deliveryEnabled) => uploadExpired(upload) ? expiryNotice
  : deliveryEnabled && upload?.mode === 'prepared-delivery' && upload.state === 'quarantined' &&
    ['SCAN_INVALID', 'SCAN_UNAVAILABLE'].includes(upload.failureCode) ? inspectionIncompleteNotice : null;
const interactive = (node) => !!node?.matches?.('button,input,select,textarea,a[href],summary,[tabindex],[contenteditable]');
const sameFocus = (a, b) => !!a && !!b && a.kind === b.kind && a.action === b.action && a.id === b.id;
const labels = Object.freeze({ pending: '업로드 대기', receiving: '서버 수신 확인 중 · 상태를 갱신해 주세요',
  quarantined: '격리 보관됨 · 검사 서버 미연결', rejected: '파일 검증 거부됨 · 업로드를 취소해 주세요',
  delete_pending: '서버 취소 확인됨 · 정리 대기', deleted: '서버 정리됨' });
const observationInterval = 2000, observationLimit = 60, observationDuration = 120000;
const observationStoppedNotice = '자동 확인을 멈췄어요. 상태 갱신으로 다시 확인해 주세요.';
const observableUpload = (item) => item.attempted && !item.uncertain && !item.cancelRequested &&
  item.upload?.mode === 'prepared-delivery' && uploadId(item.upload.id) && !uploadExpired(item.upload) &&
  Number.isFinite(Date.parse(item.upload.expiresAt)) && ['receiving', 'quarantined', 'inspecting'].includes(item.upload.state);
const preparedLabels = (purpose) => ({ ...labels, quarantined: '격리 보관됨 · 검사 대기', inspecting: '안전 검사·처리 중',
  ready: purpose === 'reply' ? '준비 완료 · 이 답장에 함께 전송' : purpose === 'message' ? '준비 완료 · 다음 메시지에 함께 전송' : `준비 완료 · ${purpose === 'record' ? '기록' : '활동 경험'} 저장 시 첨부`,
  bound: `${purpose === 'record' ? '기록' : purpose === 'feedback' ? '활동 경험' : purpose === 'reply' ? '답장' : '메시지'}에 연결됨 · ${['message', 'reply'].includes(purpose) ? '전송' : '저장'} 결과를 확인해 주세요` });
const fileStatus = (upload, enabled, purpose) => uploadNotice(upload, enabled) ??
  (enabled ? preparedLabels(purpose) : labels)[upload?.state] ?? '선택됨 · 아직 서버에 보내지 않음';
// Bound both retained bytes and tiny-file metadata across all room drafts.
export const MEDIA_MEMORY_FILE_LIMIT = MEDIA_LIMITS.count * 4;

export function mediaUploadMarkup(state, busy = false, open = false, deliveryEnabled = false, messageLocked = false, purpose = 'message', cleanupOnly = false) {
  const record = purpose === 'record';
  const feedback = purpose === 'feedback', reply = purpose === 'reply', destination = record ? '기록' : feedback ? '활동 경험' : reply ? '답장' : '메시지';
  const disabled = busy || messageLocked;
  const scopeTitle = cleanupOnly ? '기존 첨부 상태 확인·취소만 가능' : !deliveryEnabled ? '격리 보관 시험 · 전송 안 함'
    : record ? '기본 비공개 · 기록에 보관' : feedback ? '활동 경험 저장 시 대화에 공유' : reply ? '답장과 함께 대화에 전송' : '메시지와 함께 대화에 전송';
  const scopeHelp = cleanupOnly ? '이전 요청의 첨부 선택만 표시합니다. 상태를 확인하고 취소해 주세요. 새 파일 선택·업로드·공유 변경은 할 수 없습니다.'
    : !deliveryEnabled ? '검사 서버가 연결되지 않아 격리 보관만 시험합니다. 메시지에 첨부되거나 상대에게 전송되지 않으며, 사진·영상 미리보기와 열람도 제공하지 않습니다.'
      : record ? '검사·처리가 끝난 파일을 기록 저장 시 비공개로 첨부합니다. 보호자 공유는 파일별 선택 → 기록 저장 → 공유 미리보기 확인 순서로 진행합니다.'
        : feedback ? '검사·처리가 끝난 파일은 활동 경험 저장 시 이 대화 참여자에게 함께 공유됩니다. 업로드만으로 공유되지 않습니다.'
          : reply ? '검사·처리가 끝난 파일만 이 인용 답장과 함께 현재 대화 참여자에게 보냅니다. 원문의 파일은 자동으로 첨부하지 않으며 업로드만으로 공유되지 않습니다.'
            : '실제 검사·처리가 끝난 파일만 다음 메시지와 함께 현재 대화 참여자에게 보냅니다. 업로드만으로 상대에게 공유되지 않습니다.';
  return `<details class="care-panel" data-media-details ${open ? 'open' : ''}><summary>${cleanupOnly ? '남아 있는 첨부 정리' : record ? '기록 사진·영상 추가' : feedback ? '활동 경험 사진·영상 추가' : reply ? '답장 사진·영상 추가' : '대화에 사진·영상 첨부'}</summary>
    <p class="small media-upload-scope"><strong>${scopeTitle}</strong><span>${scopeHelp}</span></p>
    <p class="small muted media-upload-safety">가상 자료만 사용하는 시험입니다. 실제 아동의 사진·영상은 선택하지 마세요.</p>
    <details class="media-upload-help" data-media-help><summary data-media-help-summary>파일 형식·용량 및 보관 안내</summary>
      <p class="small muted">${MEDIA_HELP}</p>
      <p class="small muted">여러 화면에 임시 보관 중인 ${record ? '기록' : feedback ? '활동 경험' : reply ? '답장' : '대화'} 첨부 선택 합계 ${MEDIA_MEMORY_FILE_LIMIT}개·100MB까지 허용합니다.</p>
      <p class="small muted">선택 목록은 새로고침하면 사라집니다. ${deliveryEnabled ? '파일은 이 PC의 비공개 시험 폴더에 보관됩니다. 서버 정리 전에는 직접 삭제하지 마세요.' : '업로드한 가상 파일은 이 PC의 비공개 임시 폴더에 보관되며 정상 종료 시 정리됩니다.'}</p>
    </details>
    ${messageLocked ? `<p class="small" role="status">${purpose === 'message' || reply ? `${destination} 전송` : `${destination} 저장`} 결과를 확인하고 있어요. 같은 파일과 요청 번호를 유지합니다.</p>` : ''}
    ${cleanupOnly ? '' : `<label class="small">시험용 사진·영상 선택<input type="file" multiple accept="${MEDIA_TYPES.join(',')}" aria-label="시험용 사진·영상 선택" ${disabled ? 'disabled' : ''}></label>`}
    <p class="small media-upload-notice" role="status" aria-live="polite" data-testid="media-upload-status">${esc(state?.notice ?? '')}</p>
    <div class="care-fields">${(state?.items ?? []).map((item) => {
      const upload = item.upload, expired = uploadExpired(upload), text = fileStatus(upload, deliveryEnabled, purpose);
      const canUpload = !cleanupOnly && !item.cancelRequested && (!upload || (upload.state === 'pending' && !expired));
      const button = (action, text) => `<button type="button" data-media-action="${action}" data-media-id="${esc(item.id)}" ${disabled ? 'disabled' : ''}>${text}</button>`;
      return `<article data-testid="media-upload-row" data-media-id="${esc(item.id)}"><p class="account media-file-name">${esc(item.manifest.name)}</p><p class="small muted media-file-meta">${esc(fileSize(item.manifest.size))}</p><p class="small media-file-status">${esc(text)}</p>
        <p class="small muted media-file-observation" ${item.observationNotice ? '' : 'hidden'}>${esc(item.observationNotice ?? '')}</p>
        ${record && !cleanupOnly ? `<label class="care-check"><input type="checkbox" aria-label="보호자 공유에 포함 · ${esc(item.manifest.name)}" data-media-share="${esc(item.id)}" ${item.share === true ? 'checked' : ''} ${disabled ? 'disabled' : ''}>보호자 공유에 포함</label>` : ''}
        ${item.uncertain ? '<p class="small media-file-warning">이전 결과를 확인해야 해요. 파일과 업로드 번호를 그대로 보존합니다.</p>' : ''}
        ${item.cancelRequested ? '<p class="small media-file-warning">취소 결과 확인 전에는 선택 파일을 지우지 않습니다.</p>' : ''}
        <div class="care-actions">${canUpload ? button('upload', item.attempted ? '같은 업로드 확인' : '업로드') : ''}
        ${item.attempted ? button('refresh', '상태 갱신') : ''}${button('cancel', item.attempted ? '업로드 취소' : '선택 취소')}</div></article>`;
    }).join('')}</div></details>`;
}

// A single owner holds memory-only selections across rooms. No IndexedDB,
// object URL, original-file preview or inspection command is used. The owner
// alone sends captured prepared IDs and confirms successful message receipts.
export class MediaUploadUi {
  constructor({ api, getContext, onError = () => {}, createId = () => crypto.randomUUID(), deliveryEnabled = false, onChanged = () => {}, purpose = 'message' }) {
    if (typeof deliveryEnabled !== 'boolean' || typeof onChanged !== 'function' || !['message', 'record', 'feedback', 'reply'].includes(purpose)) throw new TypeError('Invalid media UI options.');
    this.api = api; this.getContext = getContext; this.onError = onError; this.createId = createId;
    this.deliveryEnabled = deliveryEnabled; this.onChanged = onChanged; this.purpose = purpose;
    this.states = new Map(); this.host = null; this.key = null; this.owner = null; this.epoch = 0;
    this.busy = null; this.open = false; this.active = false; this.painted = null;
    this.observation = null; this.observationTimer = null; this.observationBudgets = new WeakMap();
    this.click = (event) => { const b = event.target.closest('[data-media-action]'); if (b && this.host?.contains(b)) void this.action(b.dataset.mediaAction, b.dataset.mediaId); };
    this.change = (event) => {
      if (event.target.matches('input[type="file"]')) { const files = [...event.target.files]; event.target.value = ''; void this.select(files); }
      else if (event.target.dataset?.mediaShare) this.setShare(event.target.dataset.mediaShare, event.target.checked);
    };
  }
  bind(host) {
    if (host === this.host) return;
    this.suspend(); this.host?.removeEventListener('click', this.click); this.host?.removeEventListener('change', this.change);
    this.host = host; host?.addEventListener('click', this.click); host?.addEventListener('change', this.change);
  }
  update(context = this.getContext()) {
    if (!permitted(context, this.purpose)) { this.suspend(); return; }
    if (this.owner && this.owner !== context.user.userId) this.clear();
    const key = keyOf(context, this.purpose); if (this.key !== key) this.suspend();
    this.owner = context.user.userId; this.key = key; this.active = true;
    if (!this.states.has(key)) this.states.set(key, { items: [], notice: '' });
    this.render(); this.scheduleObservation();
  }
  observationAllowed(context = this.getContext()) {
    return this.deliveryEnabled && this.active && !!this.host && !this.busy && !context.messageOperation &&
      context.cleanupOnly !== true && globalThis.document?.visibilityState !== 'hidden' &&
      permitted(context, this.purpose) && this.key === keyOf(context, this.purpose) && this.states.has(this.key);
  }
  stopObservation() {
    clearTimeout(this.observationTimer); this.observationTimer = null;
    this.observation?.controller.abort(); this.observation = null;
  }
  scheduleObservation() {
    if (!this.observationAllowed()) { this.stopObservation(); return; }
    if (this.observation && !this.observationCurrent(this.observation)) this.stopObservation();
    if (this.observation || this.observationTimer !== null) return;
    const candidates = [];
    for (const item of this.states.get(this.key).items) {
      if (!observableUpload(item)) continue;
      let budget = this.observationBudgets.get(item);
      if (!budget) { budget = { attempts: 0, deadline: Date.now() + observationDuration, stopped: false }; this.observationBudgets.set(item, budget); }
      if (budget.stopped) continue;
      if (budget.attempts >= observationLimit || Date.now() >= budget.deadline) { this.stopObservingItem(item, budget); continue; }
      candidates.push({ item, budget });
    }
    if (!candidates.length) return;
    // Fair, sequential reads; selecting another file never creates a burst.
    candidates.sort((a, b) => a.budget.attempts - b.budget.attempts);
    const context = this.getContext(), { item, budget } = candidates[0];
    const controller = new AbortController(), op = { item, budget, upload: item.upload, controller,
      signal: context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal,
      key: this.key, epoch: this.epoch, generation: context.generation, role: context.role,
      scope: scopeOf(context), state: this.states.get(this.key) };
    this.observation = op;
    this.observationTimer = setTimeout(() => { this.observationTimer = null; void this.observeStatus(op); }, Math.min(observationInterval, Math.max(0, budget.deadline - Date.now())));
    this.observationTimer.unref?.();
  }
  observationCurrent(op) {
    const context = this.getContext();
    return this.observation === op && !op.signal.aborted && this.observationAllowed(context) &&
      op.epoch === this.epoch && op.key === this.key && op.generation === context.generation && op.role === context.role &&
      op.state === this.states.get(op.key) && op.state.items.includes(op.item) && op.item.upload === op.upload && observableUpload(op.item);
  }
  stopObservingItem(item, budget) {
    budget.stopped = true;
    const before = this.observationMarkup(); item.observationNotice = observationStoppedNotice;
    this.renderObservation(item, before);
  }
  observationMarkup() {
    return mediaUploadMarkup(this.states.get(this.key), !!this.busy, false, this.deliveryEnabled,
      !!this.getContext().messageOperation, this.purpose, this.getContext().cleanupOnly === true);
  }
  renderObservation(item, before) {
    const after = this.observationMarkup(); if (before === after) return;
    const row = [...(this.host?.querySelectorAll('[data-testid="media-upload-row"]') ?? [])].find((node) => node.dataset.mediaId === item.id);
    const status = row?.querySelector('.media-file-status'), hint = row?.querySelector('.media-file-observation');
    const notice = this.host?.querySelector('[data-testid="media-upload-status"]');
    if (this.painted !== before || !status || !hint || !notice) { this.render(); return; }
    // Processing -> ready only changes these texts. Keep file input, checkboxes,
    // disclosure, focus and any pending pointer/keyboard activation untouched.
    status.textContent = fileStatus(item.upload, this.deliveryEnabled, this.purpose);
    hint.textContent = item.observationNotice ?? ''; hint.hidden = !item.observationNotice;
    notice.textContent = this.states.get(this.key).notice;
    this.painted = after;
  }
  async observeStatus(op) {
    let deadlineTimer;
    try {
      if (!this.observationCurrent(op)) return;
      if (op.budget.attempts >= observationLimit || Date.now() >= op.budget.deadline) { this.stopObservingItem(op.item, op.budget); return; }
      op.budget.attempts++;
      deadlineTimer = setTimeout(() => {
        if (this.observationCurrent(op)) { this.stopObservingItem(op.item, op.budget); op.controller.abort(); }
      }, Math.max(0, op.budget.deadline - Date.now()));
      deadlineTimer.unref?.();
      // Never resolve(): an unknown reservation must remain a manual action.
      const result = await this.api.get(op.scope, op.upload.id, op.signal);
      if (!this.observationCurrent(op)) return;
      if (Date.now() >= op.budget.deadline) { this.stopObservingItem(op.item, op.budget); return; }
      this.validateUpload(result, op.item);
      if (result.mode !== 'prepared-delivery' || result.id !== op.upload.id || result.conversationId !== op.scope.roomId ||
          !Number.isInteger(result.version) || result.version < op.upload.version ||
          !['receiving', 'quarantined', 'inspecting', 'ready', 'rejected', 'bound', 'delete_pending', 'deleted'].includes(result.state)) throw new MediaApiError('INVALID_RESPONSE');
      const before = this.observationMarkup();
      op.item.upload = result;
      // A background read must not replace a selection/cancellation error.
      const ownNotice = [fileStatus(op.upload, true, this.purpose),
        '격리 보관을 확인했어요. 실제 검사·처리를 기다려 주세요.', '안전 검사·처리 중이에요. 상태를 갱신해 주세요.'].includes(op.state.notice);
      if (ownNotice && (result.state !== op.upload.state || result.failureCode !== op.upload.failureCode || uploadExpired(result)))
        op.state.notice = uploadNotice(result, true) ?? fileStatus(result, true, this.purpose);
      this.renderObservation(op.item, before);
      if (before !== this.observationMarkup()) this.onChanged();
    } catch (error) {
      if (!this.observationCurrent(op)) return;
      if (['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) {
        this.clearRoom(op.scope.userId, op.scope.centerId, op.scope.roomId); this.onError(new MediaApiError(error.code, error.status));
      } else this.stopObservingItem(op.item, op.budget);
    } finally {
      clearTimeout(deadlineTimer);
      if (this.observation === op) { this.observation = null; this.scheduleObservation(); }
    }
  }
  render() {
    if (!this.active || !this.host || !this.key || !permitted(this.getContext(), this.purpose) || keyOf(this.getContext(), this.purpose) !== this.key) return;
    const locked = !!this.getContext().messageOperation, cleanupOnly = this.getContext().cleanupOnly === true;
    const markup = mediaUploadMarkup(this.states.get(this.key), !!this.busy, false, this.deliveryEnabled, locked, this.purpose, cleanupOnly);
    if (this.painted === markup) return;
    const details = this.host.querySelector('[data-media-details]'); if (details) this.open = details.open;
    const helpOpen = this.host.querySelector('[data-media-help]')?.open === true;
    const focused = this.focusDescriptor();
    this.host.innerHTML = mediaUploadMarkup(this.states.get(this.key), !!this.busy, this.open, this.deliveryEnabled, locked, this.purpose, cleanupOnly);
    const help = this.host.querySelector('[data-media-help]'); if (help) help.open = helpOpen;
    this.painted = markup;
    this.restoreFocus(focused);
  }
  focusDescriptor(element = globalThis.document?.activeElement) {
    if (!element || !this.host?.contains(element)) return null;
    if (element.matches?.('input[type="file"]')) return { kind: 'file' };
    if (element.matches?.('[data-media-help-summary]')) return { kind: 'help' };
    if (element.matches?.('summary')) return { kind: 'summary' };
    if (element.dataset?.mediaShare) return { kind: 'share', id: element.dataset.mediaShare };
    if (element.dataset?.mediaAction) return { kind: 'action', action: element.dataset.mediaAction, id: element.dataset.mediaId };
    return null;
  }
  restoreFocus(descriptor) {
    const target = descriptor?.kind === 'file' ? this.host?.querySelector('input[type="file"]')
      : descriptor?.kind === 'help' ? this.host?.querySelector('[data-media-help-summary]')
      : descriptor?.kind === 'summary' ? this.host?.querySelector('summary')
        : descriptor?.kind === 'share' ? [...(this.host?.querySelectorAll('[data-media-share]') ?? [])].find((b) => b.dataset.mediaShare === descriptor.id)
          : descriptor?.kind === 'action' ? [...(this.host?.querySelectorAll('[data-media-action]') ?? [])].find((b) => b.dataset.mediaAction === descriptor.action && b.dataset.mediaId === descriptor.id) ?? this.host?.querySelector('summary') : null;
    // Disabled controls cannot receive focus. The operation retains the
    // pre-disable descriptor until finish instead of treating body as intent.
    if (!target || target.disabled) return;
    this.restoringFocus = true;
    try { target.focus({ preventScroll: true }); } finally { this.restoringFocus = false; }
  }
  stopFocusTracking(op) {
    if (op?.focusListener) op.document?.removeEventListener?.('focusin', op.focusListener);
  }
  suspend() {
    this.stopObservation();
    this.active = false; this.epoch++; this.busy?.controller.abort(); this.painted = null;
    this.stopFocusTracking(this.busy);
    if (this.host) { const details = this.host.querySelector('[data-media-details]'); if (details) this.open = details.open; this.host.replaceChildren(); }
  }
  clear() {
    this.suspend();
    for (const state of this.states.values()) for (const item of state.items) item.file = null;
    this.states.clear(); this.key = null; this.owner = null; this.open = false;
    this.onChanged();
  }
  clearRoom(userId, centerId, roomId) {
    for (const key of [...this.states.keys()]) {
      const parts = JSON.parse(key);
      if (parts[0] === userId && parts[1] === centerId && parts[2] === roomId) this.clearKey(key);
    }
  }
  clearKey(key) {
    if (this.key === key) this.suspend();
    else if (this.busy?.key === key) { this.busy.controller.abort(); this.stopFocusTracking(this.busy); }
    for (const item of this.states.get(key)?.items ?? []) item.file = null;
    this.states.delete(key); if (this.key === key) this.key = null;
    this.onChanged();
  }
  // Call only with the complete, authenticated workspace room list. Absence
  // from a partial page/network failure is not evidence of revoked access.
  retainRooms(userId, centerId, allowedRoomIds) {
    if (!validId(userId) || !validId(centerId) || !Array.isArray(allowedRoomIds) ||
        !allowedRoomIds.every(validId) || new Set(allowedRoomIds).size !== allowedRoomIds.length) throw new MediaApiError('INVALID_INPUT');
    const allowed = new Set(allowedRoomIds); let removed = 0;
    for (const key of [...this.states.keys()]) {
      let parts; try { parts = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(parts) || ![3, 4].includes(parts.length) || parts[0] !== userId || parts[1] !== centerId || allowed.has(parts[2])) continue;
      this.clearKey(key); removed++;
    }
    return removed;
  }
  begin() {
    const context = this.getContext();
    if (this.busy || context.messageOperation || !this.active || !permitted(context, this.purpose) || this.key !== keyOf(context, this.purpose) || !this.states.has(this.key)) return null;
    this.stopObservation();
    const controller = new AbortController();
    const operation = { key: this.key, scope: scopeOf(context), generation: context.generation, epoch: this.epoch,
      state: this.states.get(this.key), controller, signal: context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal,
      focus: this.focusDescriptor(), focusMoved: false, document: globalThis.document };
    this.busy = operation; this.render(); this.onChanged();
    operation.focusListener = (event) => {
      if (!this.restoringFocus && interactive(event.target) && !sameFocus(this.focusDescriptor(event.target), operation.focus)) operation.focusMoved = true;
    };
    operation.document?.addEventListener?.('focusin', operation.focusListener);
    return operation;
  }
  current(op) {
    const c = this.getContext();
    return this.busy === op && !op.signal.aborted && op.epoch === this.epoch && permitted(c, this.purpose) &&
      c.generation === op.generation && keyOf(c, this.purpose) === op.key && this.states.get(op.key) === op.state;
  }
  assertCurrent(op) { if (!this.current(op)) throw new MediaApiError('CANCELLED'); }
  finish(op) {
    const activeElement = op.document?.activeElement;
    const restore = this.current(op) && this.active && !op.focusMoved &&
      (!interactive(activeElement) || sameFocus(this.focusDescriptor(activeElement), op.focus));
    this.stopFocusTracking(op);
    if (this.busy === op) this.busy = null;
    this.render();
    if (restore) this.restoreFocus(op.focus);
    this.onChanged();
    this.scheduleObservation();
  }
  failure(op, error) {
    if (!this.current(op)) return;
    if (['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) {
      this.clearRoom(op.scope.userId, op.scope.centerId, op.scope.roomId); this.onError(new MediaApiError(error.code, error.status)); return;
    }
    op.state.notice = error instanceof MediaApiError ? error.message : '파일 처리 결과를 확인하지 못했어요. 선택 파일을 보존했습니다.';
  }
  async select(input) {
    if (this.getContext().cleanupOnly === true) return false;
    const files = [...input]; if (!files.length) return false;
    const op = this.begin(); if (!op) return false;
    try {
      const selected = [...this.states.values()].flatMap((s) => s.items);
      const total = selected.reduce((n, item) => n + item.manifest.size, 0);
      const incoming = files.reduce((n, file) => n + (file?.size ?? Infinity), 0);
      if (op.state.items.length + files.length > MEDIA_LIMITS.count || selected.length + files.length > MEDIA_MEMORY_FILE_LIMIT ||
          !Number.isSafeInteger(incoming) || total + incoming > MEDIA_LIMITS.total) throw new MediaApiError('MEDIA_LIMIT');
      op.state.notice = '가상 파일의 형식과 업로드용 지문을 확인하고 있어요. 서버 검사는 아닙니다.'; this.render();
      const additions = [];
      for (const file of files) {
        const manifest = await mediaFileManifest(file, op.signal); this.assertCurrent(op);
        additions.push({ id: this.createId(), clientId: this.createId(), file, manifest, upload: null,
          attempted: false, uncertain: false, cancelRequested: false, share: false });
      }
      op.state.items.push(...additions); op.state.notice = this.deliveryEnabled ? this.purpose === 'record' ? '비공개 첨부로 선택했어요. 업로드 후 준비 완료를 확인하고 기록을 저장해 주세요.' : this.purpose === 'feedback' ? '활동 경험에 공유할 파일을 선택했어요. 업로드 후 준비 완료를 확인하고 활동 경험을 저장해 주세요.' : this.purpose === 'reply' ? '이 답장에 보낼 파일을 선택했어요. 업로드 후 준비 완료를 확인하고 답장을 보내 주세요.' : '선택했어요. 업로드 후 준비 완료를 확인하고 메시지를 보내 주세요.' : '선택했어요. 업로드를 누르면 서버 격리 보관을 시험합니다.'; return true;
    } catch (error) { this.failure(op, error); return false; }
    finally { this.finish(op); }
  }
  async resolve(op, item) {
    item.attempted = true; item.uncertain = true;
    const result = item.upload ? await this.api.get(op.scope, item.upload.id, op.signal)
      : await this.api.reserve(op.scope, Object.freeze({ clientId: item.clientId, file: item.manifest }), op.signal);
    this.assertCurrent(op);
    this.validateUpload(result, item);
    item.upload = result; item.uncertain = false; return result;
  }
  remove(op, item, cancelled) {
    op.state.items = op.state.items.filter((value) => value !== item);
    item.file = null;
    op.state.notice = cancelled ? '서버에서 업로드 취소를 확인했어요. 격리 파일의 실제 정리는 서버에서 처리합니다.' : '서버에 보내지 않은 선택을 취소했어요.';
  }
  validateUpload(result, item) {
    const original = sourceOf(result);
    if ((!this.deliveryEnabled && result?.mode === 'prepared-delivery') || !original ||
        original.name !== item.manifest.name || original.type !== item.manifest.type || original.size !== item.manifest.size)
      throw new MediaApiError('INVALID_RESPONSE');
  }
  // Capture only before the initial send. Ambiguous retries must use the
  // owner's already frozen operation, even if the server now reports bound.
  readyItems() {
    const c = this.getContext();
    if (!this.active || !permitted(c, this.purpose) || keyOf(c, this.purpose) !== this.key) throw new MediaApiError('CANCELLED');
    if (this.busy || c.messageOperation || c.cleanupOnly === true) throw new MediaApiError('MEDIA_BUSY');
    const items = this.states.get(this.key)?.items ?? [];
    if (!this.deliveryEnabled) return [];
    if (items.some((item) => item.uncertain || item.cancelRequested || !item.upload ||
        item.upload.mode !== 'prepared-delivery' || item.upload.state !== 'ready' || uploadExpired(item.upload) ||
        !Number.isFinite(Date.parse(item.upload.expiresAt)))) throw new MediaApiError('MEDIA_BUSY');
    if (items.length > MEDIA_LIMITS.count || items.some((item) => !uploadId(item.upload.id)) ||
        new Set(items.map((item) => item.upload.id)).size !== items.length ||
        items.reduce((n, item) => n + item.upload.size, 0) > MEDIA_LIMITS.total) throw new MediaApiError('INVALID_RESPONSE');
    return items;
  }
  captureAttachments() {
    if (!['message', 'reply'].includes(this.purpose)) throw new MediaApiError('INVALID_INPUT');
    return Object.freeze(this.readyItems().map((item) => Object.freeze({ id: item.upload.id })));
  }
  setShare(itemId, share) {
    if (this.purpose !== 'record' || typeof share !== 'boolean' || this.busy || this.getContext().messageOperation || this.getContext().cleanupOnly === true ||
        !this.active || !permitted(this.getContext(), this.purpose) || keyOf(this.getContext(), this.purpose) !== this.key) return false;
    const item = this.states.get(this.key)?.items.find((value) => value.id === itemId);
    if (!item) return false;
    item.share = share; this.render(); this.onChanged(); return true;
  }
  captureRecordAttachments(boundFiles = []) {
    if (this.purpose !== 'record' || !this.deliveryEnabled || !attachmentListValid(boundFiles) || !boundFiles.every((file) => uploadId(file.id)))
      throw new MediaApiError('INVALID_INPUT');
    const items = this.readyItems(), all = [...boundFiles, ...items.map((item) => ({
      id: item.upload.id, name: item.upload.name, type: item.upload.type, size: item.upload.size, share: item.share === true,
    }))];
    if (!attachmentListValid(all)) throw new MediaApiError('MEDIA_LIMIT');
    return Object.freeze(all.map(({ id, share }) => Object.freeze({ id, share })));
  }
  captureFeedbackAttachments(boundFiles = []) {
    if (this.purpose !== 'feedback' || !this.deliveryEnabled || !Array.isArray(boundFiles) ||
        boundFiles.some((file) => !file || Object.keys(file).length !== 4 || !['id', 'name', 'type', 'size'].every((key) => Object.hasOwn(file, key))))
      throw new MediaApiError('INVALID_INPUT');
    const all = [...boundFiles, ...this.readyItems().map((item) => item.upload)]
      .map(({ id, name, type, size }) => ({ id, name, type, size, share: true }));
    if (!attachmentListValid(all) || !all.every((file) => uploadId(file.id))) throw new MediaApiError('MEDIA_LIMIT');
    return Object.freeze(all.map(({ id }) => Object.freeze({ id })));
  }
  hasRecordSelections(scope, recordId) {
    if (this.purpose !== 'record') return false;
    return !!this.states.get(JSON.stringify([scope.userId, scope.centerId, scope.roomId, recordId]))?.items.length;
  }
  forgetSaved(scope, recordId, attachmentIds) {
    if (this.purpose !== 'record' || !validId(recordId)) throw new MediaApiError('INVALID_INPUT');
    return this.forgetCaptured(scope, attachmentIds, recordId);
  }
  hasFeedbackSelections(scope, feedbackId) {
    return this.purpose === 'feedback' && !!this.states.get(JSON.stringify([scope.userId, scope.centerId, scope.roomId, feedbackId]))?.items.length;
  }
  forgetFeedbackSaved(scope, feedbackId, attachmentIds) {
    if (this.purpose !== 'feedback' || !validId(feedbackId)) throw new MediaApiError('INVALID_INPUT');
    return this.forgetCaptured(scope, attachmentIds, feedbackId);
  }
  hasReplySelections(scope, replyDraftId) {
    return this.purpose === 'reply' && !!this.states.get(JSON.stringify([scope.userId, scope.centerId, scope.roomId, replyDraftId]))?.items.length;
  }
  forgetReplySent(scope, replyDraftId, attachmentIds) {
    if (this.purpose !== 'reply' || !validId(replyDraftId)) throw new MediaApiError('INVALID_INPUT');
    return this.forgetCaptured(scope, attachmentIds, replyDraftId);
  }
  // Call only after an acknowledged message receipt; never cancels bound files.
  // Scope is captured by the sender, so navigating meanwhile cannot erase a
  // different room/account's selection.
  forgetSent(scope, attachmentIds) {
    if (this.purpose !== 'message') throw new MediaApiError('INVALID_INPUT');
    return this.forgetCaptured(scope, attachmentIds);
  }
  forgetCaptured(scope, attachmentIds, recordId) {
    if (!scope || ![scope.userId, scope.centerId, scope.roomId].every(validId) ||
        !Array.isArray(attachmentIds) || !attachmentIds.every(uploadId) || new Set(attachmentIds).size !== attachmentIds.length)
      throw new MediaApiError('INVALID_INPUT');
    const key = JSON.stringify([scope.userId, scope.centerId, scope.roomId, ...(recordId ? [recordId] : [])]), state = this.states.get(key);
    if (!state) return 0;
    const ids = new Set(attachmentIds), removed = state.items.filter((item) => ids.has(item.upload?.id));
    if (!removed.length) return 0;
    if (this.key === key) this.stopObservation();
    if (this.busy?.key === key) { this.busy.controller.abort(); this.stopFocusTracking(this.busy); }
    for (const item of removed) item.file = null;
    state.items = state.items.filter((item) => !removed.includes(item)); state.notice = this.purpose === 'reply' ? '답장에 첨부를 보냈어요.' : recordId ? this.purpose === 'feedback' ? '활동 경험에 첨부를 저장했어요.' : '기록에 첨부를 저장했어요.' : '메시지에 첨부를 보냈어요.';
    this.render(); this.onChanged(); this.scheduleObservation(); return removed.length;
  }
  async action(action, itemId) {
    if (!['upload', 'refresh', 'cancel'].includes(action)) return false;
    if (action === 'upload' && this.getContext().cleanupOnly === true) return false;
    const op = this.begin(); if (!op) return false;
    const item = op.state.items.find((row) => row.id === itemId);
    try {
      if (!item) return false;
      if (action === 'cancel' && !item.attempted) { this.remove(op, item, false); return true; }
      if (action === 'cancel') item.cancelRequested = true;
      if (action === 'refresh' && !item.attempted) return false;
      const upload = await this.resolve(op, item);
      if (terminal(upload)) { this.remove(op, item, true); return true; }
      if (action === 'cancel') {
        item.uncertain = true;
        const result = await this.api.cancel(op.scope, upload, op.signal); this.assertCurrent(op);
        this.validateUpload(result, item);
        item.upload = result;
        if (!terminal(result)) throw new MediaApiError('INVALID_RESPONSE');
        item.uncertain = false; this.remove(op, item, true); return true;
      }
      // Every retry resolves the previous server state first. A receiving or
      // quarantined file is never uploaded again, even after response loss.
      if (action === 'upload' && !item.cancelRequested && upload.state === 'pending' && !uploadExpired(upload)) {
        item.uncertain = true;
        const result = await this.api.receive(op.scope, upload, item.file, op.signal); this.assertCurrent(op);
        this.validateUpload(result, item);
        item.upload = result;
        item.uncertain = false;
      }
      op.state.notice = uploadNotice(item.upload, this.deliveryEnabled) ?? (this.deliveryEnabled ? ({ quarantined: '격리 보관을 확인했어요. 실제 검사·처리를 기다려 주세요.',
        inspecting: '안전 검사·처리 중이에요. 상태를 갱신해 주세요.', ready: this.purpose === 'record' ? '준비 완료됐어요. 기록을 저장하면 첨부됩니다.' : this.purpose === 'feedback' ? '준비 완료됐어요. 활동 경험 저장 시 대화 참여자에게 공유됩니다.' : this.purpose === 'reply' ? '준비 완료됐어요. 이 답장과 함께 보낼 수 있어요.' : '준비 완료됐어요. 다음 메시지와 함께 보낼 수 있어요.',
        bound: this.purpose === 'record' ? '이미 기록에 연결된 파일이에요. 이전 저장 결과를 확인해 주세요.' : this.purpose === 'feedback' ? '이미 활동 경험에 연결된 파일이에요. 이전 저장 결과를 확인해 주세요.' : '이미 메시지에 연결된 파일이에요. 이전 전송 결과를 확인해 주세요.' }[item.upload.state] ?? labels[item.upload.state] ?? '현재 상태를 확인했어요.')
        : item.upload.state === 'quarantined' ? '격리 보관을 확인했어요. 검사와 상대방 전송은 진행되지 않았습니다.'
        : labels[item.upload.state] ?? '현재 상태를 확인했어요.');
      this.observationBudgets.delete(item); item.observationNotice = '';
      return true;
    } catch (error) { this.failure(op, error); return false; }
    finally { this.finish(op); }
  }
}
