import { LocalApiError } from './client.js';
import { CareRecipientApiClient } from './care-recipient-client.js';
import { OperationsApiClient } from './operations-client.js';
import { escapeHtml as esc, roleName, PRIMARY_COMMUNICATOR_NOTICE } from './workspace-ui.js';

const denied = error => ['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND'].includes(error?.code);
const safe = error => error instanceof LocalApiError ? error.message : '현재 설정을 확인하지 못했어요. 다시 확인해 주세요.';
const unknown = '처리 결과가 불확실합니다. 선택과 요청 번호를 바꾸지 않고 같은 요청으로 확인해 주세요.';

export function recipientSettingsCandidates(link, relationships, members) {
  const available = members.filter(member => member.role === 'care_recipient' && (!link.userId || member.userId === link.userId));
  const primary = members.filter(member => member.role === 'guardian'
    ? relationships.participants.some(person => person.userId === member.userId && person.role === 'guardian')
    : member.role === 'care_recipient' && link.active && member.userId === link.userId);
  return { available, primary };
}

export class RecipientSettingsOperation {
  constructor() { this.operation = null; this.sending = false; this.uncertain = false; this.error = ''; }
  begin(kind, body, createId = () => crypto.randomUUID()) {
    if (this.sending) return null;
    if (!this.operation) this.operation = Object.freeze({ kind, body: Object.freeze({ ...body, clientId: createId() }) });
    this.sending = true; this.error = ''; return this.operation;
  }
  failed(operation, error) {
    if (this.operation !== operation) return;
    this.sending = false;
    const definitive = error instanceof LocalApiError && ([400, 413].includes(error.status) ||
      (error.code === 'INVALID_INPUT' && error.status === 0) || (error.status === 409 &&
        ['RELATIONSHIP_CONFLICT', 'PRIMARY_COMMUNICATOR_CONFLICT', 'PARTICIPANT_UNAVAILABLE', 'SEQUENCE_LIMIT', 'REVISION_LIMIT'].includes(error.code)));
    if (!this.uncertain && definitive) { this.operation = null; this.error = safe(error); }
    else { this.uncertain = true; this.error = unknown; }
  }
  interrupt() { if (this.operation) { this.sending = false; this.uncertain = true; this.error = unknown; } }
  accepted(operation) { if (this.operation === operation) { this.operation = null; this.sending = false; this.uncertain = false; this.error = ''; } }
}

export function recipientSettingsMarkup(state) {
  const { link, primary, members = [], relationships, name, selection, mutation, checked } = state;
  const locked = !state.connected || mutation.sending || !!mutation.operation;
  const disabled = locked ? 'disabled' : '';
  const heading = `<header class="page-heading"><h1 tabindex="-1" data-recipient-title>대상자 연결 · 주 소통자</h1><p>${esc(name ?? '이름 미등록 대상자')}</p></header>`;
  const back = `<button type="button" data-recipient-action="exit" ${mutation.operation ? 'disabled' : ''}>대상 목록으로</button>`;
  if (!link || !primary || !relationships) return `${back}${heading}<p class="empty">현재 관리 권한과 연결 정보를 확인해 주세요.</p><p class="care-error" role="status">${esc(mutation.error || state.error)}</p><button type="button" data-recipient-action="refresh" ${state.loading ? 'disabled' : ''}>현재 설정 확인</button>`;
  const { available, primary: choices } = recipientSettingsCandidates(link, relationships, members);
  const person = members.find(member => member.userId === link.userId);
  const option = member => `<option value="${esc(member.userId)}" ${selection.link === member.userId ? 'selected' : ''}>${esc(member.displayName ?? '이름 미등록')} · 대상자</option>`;
  return `${back}${heading}<section class="surface-card"><h2>본인 계정 연결</h2>
    <p class="muted small">센터 가입과 대상 연결은 별개입니다. 연결 이후 일반 텍스트 대화만 열리며 보호자의 계정·기존 권한은 유지됩니다. 기존 기록·사진·영상은 대상자에게 공개하지 않습니다.</p>
    <p>현재 상태: <strong>${link.active ? '연결됨' : link.userId ? '연결 해제됨 · 본인 계정 이력 유지' : '미연결'}</strong>${link.userId ? ` · ${esc(person?.displayName ?? '현재 선택 불가 계정')}` : ''}</p>
    ${link.userId ? '<p class="small muted">이 대상과 본인 계정의 대응 관계는 유지됩니다. 잘못 연결했다면 다른 계정으로 재배정하지 말고 별도 정정 절차를 요청해 주세요.</p>' : ''}
    <form data-recipient-form="${link.active ? 'disconnect' : 'connect'}"><label>대상자 본인 계정<select name="recipientUserId" ${disabled} ${link.active ? 'disabled' : 'required'}><option value="">계정 선택</option>${available.map(option).join('')}</select></label>
    ${!link.active && !available.length ? '<p class="small muted">연결 가능한 대상자 계정이 없습니다. 구성원 초대에서 대상자 독립 계정을 먼저 준비해 주세요.</p>' : ''}
    <label class="recipient-confirm"><input type="checkbox" name="linkConfirmed" ${checked.link ? 'checked' : ''} ${disabled} required>선택한 본인 계정과 ${link.active ? '연결 해제' : '연결 이후부터 대화 공개'} 범위를 확인했습니다.</label>
    <button type="submit" ${disabled} ${!link.active && !available.length ? 'disabled' : ''}>${link.active ? '대상자 연결 해제' : '대상자 계정 연결'}</button></form></section>
    <section class="surface-card"><h2>주 소통자</h2><p class="small muted">${PRIMARY_COMMUNICATOR_NOTICE}</p><p class="small muted">설정은 본인의 의사·동의 확인을 대신하지 않습니다. 계정·참여자·과거 대화·기록 수신 범위는 바뀌지 않습니다.</p>
    <form data-recipient-form="primary"><label>연락 우선 대상<select name="primaryUserId" ${disabled}><option value="" ${selection.primary === '' ? 'selected' : ''}>미지정</option>${choices.map(member => `<option value="${esc(member.userId)}" ${selection.primary === member.userId ? 'selected' : ''}>${esc(member.displayName ?? '이름 미등록')} · ${esc(roleName(member.role))}</option>`).join('')}</select></label>
    <label class="recipient-confirm"><input type="checkbox" name="primaryConfirmed" ${checked.primary ? 'checked' : ''} ${disabled} required>주 소통자 지정은 권한 부여나 동의 완료가 아님을 확인했습니다.</label><button type="submit" ${disabled}>주 소통자 저장</button></form></section>
    <p class="care-error" role="status">${esc(mutation.error || state.error)}</p><p role="status">${esc(state.notice)}</p>
    <div class="care-actions"><button type="button" data-recipient-action="refresh" ${mutation.sending || state.loading ? 'disabled' : ''}>현재 설정 다시 확인</button>${mutation.operation ? `<button type="button" class="primary" data-recipient-action="retry" ${mutation.sending || !state.connected ? 'disabled' : ''}>같은 요청으로 확인</button>` : ''}</div>`;
}

// Independent administrative surface: no clinical reads, no browser storage,
// no inferred identity reassignment and no automatic retry of a write.
export class OperationsRecipientUi {
  constructor({ host, transport, centerId, userId, roomId, name, client = new CareRecipientApiClient(transport), directory = new OperationsApiClient(transport), onDenied = () => {}, onExit = () => {}, announce = () => {} }) {
    Object.assign(this, { host, transport, centerId, userId, roomId, name, client, directory, onDenied, onExit, announce });
    this.mutation = new RecipientSettingsOperation(); this.selection = { link: '', primary: '' }; this.checked = { link: false, primary: false };
    this.connected = false; this.loading = false; this.hidden = false; this.destroyed = false; this.epoch = 0;
    this.link = null; this.primary = null; this.relationships = null; this.members = []; this.notice = ''; this.error = '';
  }
  mount() {
    this.events = new AbortController(); const options = { signal: this.events.signal };
    this.host.addEventListener('change', event => { this.capture(event.target?.name); }, options);
    this.host.addEventListener('submit', event => {
      const form = event.target; if (!form.matches('[data-recipient-form]')) return;
      event.preventDefault(); if (!form.reportValidity()) return;
      this.capture(); void this.save(form.dataset.recipientForm);
    }, options);
    this.host.addEventListener('click', event => {
      const button = event.target.closest('[data-recipient-action]'); if (!button || !this.host.contains(button)) return;
      if (button.dataset.recipientAction === 'exit' && !this.hasPendingWrite()) this.onExit();
      if (button.dataset.recipientAction === 'refresh') void this.refresh();
      if (button.dataset.recipientAction === 'retry' && this.mutation.operation) void this.save(this.mutation.operation.kind);
    }, options);
    this.render(); return this.refresh();
  }
  capture(changed) {
    if (this.hidden || this.destroyed || this.mutation.operation) return;
    const link = this.host.querySelector('[name="recipientUserId"]'), primary = this.host.querySelector('[name="primaryUserId"]');
    if (link) this.selection.link = link.value;
    if (primary) this.selection.primary = primary.value;
    const linkCheck = this.host.querySelector('[name="linkConfirmed"]'), primaryCheck = this.host.querySelector('[name="primaryConfirmed"]');
    if (changed === 'recipientUserId' && linkCheck) linkCheck.checked = false;
    if (changed === 'primaryUserId' && primaryCheck) primaryCheck.checked = false;
    this.checked = { link: linkCheck?.checked ?? false, primary: primaryCheck?.checked ?? false };
  }
  beginRead() {
    this.request?.abort(); this.request = new AbortController(); const epoch = ++this.epoch, signal = this.request.signal;
    return { signal, current: () => !this.destroyed && !this.hidden && this.epoch === epoch && !signal.aborted && this.transport.expectedUserId === this.userId };
  }
  render() {
    if (this.hidden || this.destroyed) return;
    const html = recipientSettingsMarkup(this); if (html === this.markup) return;
    const active = this.host.ownerDocument?.activeElement;
    const focused = this.host.contains(active) ? { name: active.name, action: active.dataset?.recipientAction } : null;
    this.host.innerHTML = html; this.markup = html;
    if (focused) [...this.host.querySelectorAll('input,select,button')].find(node => !node.disabled &&
      (focused.name ? node.name === focused.name : focused.action && node.dataset?.recipientAction === focused.action))?.focus({ preventScroll: true });
  }
  admitted() {
    if (this.destroyed || this.hidden || this.mutation.sending) return false;
    if (this.transport.expectedUserId !== this.userId) { this.destroy(); this.onDenied(new LocalApiError('AUTH_REQUIRED', 401)); return false; }
    return true;
  }
  async refresh() {
    if (!this.admitted() || this.loading) return;
    this.capture(); const task = this.beginRead(); this.loading = true;
    try {
      const [link, primary, members, relationships] = await Promise.all([
        this.client.link(this.centerId, this.roomId, task.signal), this.client.primary(this.centerId, this.roomId, task.signal),
        this.directory.members(this.centerId, task.signal), this.directory.relationships(this.centerId, this.roomId, task.signal),
      ]);
      if (!task.current()) return;
      if (link.childId !== relationships.childId || link.version !== relationships.version) throw new LocalApiError('RELATIONSHIP_CONFLICT', 409);
      // Eligibility changes can clear the effective primary without changing
      // its explicit designation revision. Never revive an old choice/check.
      const changed = !this.link || this.link.version !== link.version || this.link.active !== link.active ||
        this.primary.revision !== primary.revision || this.primary.userId !== primary.userId || JSON.stringify(this.members) !== JSON.stringify(members);
      if (changed && !this.mutation.operation) {
        this.selection = { link: link.userId ?? '', primary: primary.userId ?? '' };
        this.checked = { link: false, primary: false };
        if (this.link) this.notice = '연결 정보가 바뀌었어요. 현재 대상과 범위를 다시 확인해 주세요.';
      }
      Object.assign(this, { link, primary, members, relationships, connected: true, error: '' });
    } catch (error) {
      if (!task.current()) return;
      if (denied(error)) { this.destroy(); this.onDenied(error); return; }
      this.connected = false; this.link = null; this.primary = null; this.members = []; this.relationships = null; this.error = safe(error);
    } finally { if (task.current()) { this.loading = false; this.render(); } }
  }
  async save(kind) {
    if (!this.admitted() || !this.connected) return;
    this.capture();
    if (!this.mutation.operation) {
      const candidates = recipientSettingsCandidates(this.link, this.relationships, this.members);
      if (!['connect', 'disconnect', 'primary'].includes(kind)) return;
      if (kind === 'primary' ? !this.checked.primary : !this.checked.link) return;
      if (kind === 'connect' && (this.link.active || !candidates.available.some(person => person.userId === this.selection.link))) return;
      if (kind === 'disconnect' && !this.link.active) return;
      if (kind === 'primary' && this.selection.primary && !candidates.primary.some(person => person.userId === this.selection.primary)) return;
    }
    const body = kind === 'primary' ? { conversationId: this.roomId, userId: this.selection.primary || null, expectedRevision: this.primary.revision }
      : { conversationId: this.roomId, userId: kind === 'disconnect' ? this.link.userId : this.selection.link, expectedVersion: this.link.version };
    const operation = this.mutation.begin(kind, body); if (!operation) return;
    const task = this.beginRead(); this.loading = false; this.error = ''; this.notice = ''; this.render();
    try {
      await this.client.save(this.centerId, operation.kind, operation.body, task.signal);
      if (!task.current()) return;
      this.mutation.accepted(operation); this.checked = { link: false, primary: false };
      this.notice = '변경 요청을 확인했어요. 현재 연결과 주 소통자를 다시 조회합니다.'; this.announce(this.notice);
    } catch (error) {
      if (!task.current()) return;
      if (denied(error)) { this.destroy(); this.onDenied(error); return; }
      this.mutation.failed(operation, error); this.checked = { link: false, primary: false };
      // A definitive conflict requires a new read before another command.
      if (!this.mutation.operation) this.connected = false;
    } finally { if (task.current()) this.render(); }
    if (task.current() && !this.mutation.operation) await this.refresh();
  }
  hasPendingWrite() { return !!this.mutation.operation; }
  suspend() {
    if (this.destroyed) return;
    this.capture(); this.mutation.interrupt(); this.hidden = true; this.epoch++; this.request?.abort(); this.loading = false;
    this.connected = false; this.link = null; this.primary = null; this.members = []; this.relationships = null; this.markup = null; this.host.replaceChildren();
  }
  resume() { if (this.destroyed) return; this.hidden = false; this.render(); return this.refresh(); }
  destroy() { if (this.destroyed) return; this.suspend(); this.destroyed = true; this.events?.abort(); this.mutation = new RecipientSettingsOperation(); this.selection = { link: '', primary: '' }; this.checked = { link: false, primary: false }; }
}
