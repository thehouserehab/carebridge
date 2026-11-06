import { LocalApiError } from './client.js';
import { InvitationApiClient, invitationEmail, INVITATION_REQUEST_NOTICE } from './invitation-client.js';
import { escapeHtml as esc, roleName } from './workspace-ui.js';

const statuses = { pending: '수락 대기', accepted: '수락됨', revoked: '철회됨', expired: '만료됨' };
const unknown = '처리 결과를 확인하지 못했어요. 같은 발급·철회 요청을 자동으로 다시 보내지 않습니다. 목록을 새로 확인해 주세요.';
const denied = error => ['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND'].includes(error?.code);
const safe = error => error instanceof LocalApiError ? error.message : '처리 결과를 확인할 수 없어요.';

export function operationsInvitationsMarkup({ rows = [], values = { email: '', role: 'guardian' }, busy = false, uncertain = false, checked = false, error = '', notice = '' }) {
  return `<section data-testid="operations-invitations"><button type="button" data-invites-action="exit" ${busy ? 'disabled' : ''}>아이 목록으로</button>
    <header class="page-heading"><h1 tabindex="-1">구성원 초대</h1><p class="muted small">가상 계정의 센터 소속을 초대합니다. 수락 후 아이의 담당 관계는 별도로 설정해 주세요. 실제 메일은 보내지 않습니다.</p></header>
    <form class="surface-card" data-invitation-form="invite" autocomplete="off"><div class="care-fields"><label>시험 이메일<input name="email" type="email" value="${esc(values.email)}" required maxlength="254" autocomplete="off" placeholder="member@example.test" ${busy || uncertain ? 'disabled' : ''}></label>
    <label>초대할 역할<select name="role" ${busy || uncertain ? 'disabled' : ''}><option value="guardian" ${values.role === 'guardian' ? 'selected' : ''}>보호자</option><option value="therapist" ${values.role === 'therapist' ? 'selected' : ''}>치료사</option><option value="care_recipient" ${values.role === 'care_recipient' ? 'selected' : ''}>대상자 · 독립 계정</option></select></label></div>
    <p class="small muted">대상자는 본인 계정으로 초대를 수락한 뒤 별도로 연결합니다. 보호자 계정·권한을 양도하지 않으며, 연결 후에도 일반 텍스트 대화만 제공됩니다.</p>
    <p class="small muted">.test로 끝나는 시험 주소만 입력하세요. 초대 생성·안내 요청은 메일 도착이나 수락을 뜻하지 않습니다.</p><button type="submit" class="primary" ${busy || uncertain ? 'disabled' : ''}>초대 요청</button></form>
    <p role="status" data-invites-status>${esc(uncertain ? unknown : notice)}</p><p class="care-error" role="status">${esc(error)}</p>
    <div class="care-actions"><button type="button" data-invites-action="refresh" ${busy ? 'disabled' : ''}>초대 목록 새로고침</button>${uncertain && checked ? '<button type="button" data-invites-action="acknowledge">목록을 확인했어요</button>' : ''}</div>
    <section class="surface-card" aria-label="초대 내역">${rows.map(v => `<article class="ops-child-row" data-invitation-id="${esc(v.id)}"><div><strong>${esc(v.email)}</strong><p>${esc(roleName(v.role))} · ${statuses[v.status]}</p><p class="small muted">생성 ${esc(v.createdAt)} · 만료 ${esc(v.expiresAt)}</p></div>${v.status === 'pending' ? `<form data-invitation-form="revoke" data-invitation-id="${esc(v.id)}"><label><input type="checkbox" name="confirmed" required ${busy || uncertain ? 'disabled' : ''}>이 초대를 철회할게요</label><button type="submit" data-revoke-invitation="${esc(v.id)}" ${busy || uncertain ? 'disabled' : ''}>초대 철회</button></form>` : ''}</article>`).join('') || '<p class="empty">표시할 초대가 없습니다.</p>'}</section></section>`;
}

// Mounted only in the center's child-management subsection. It does not read
// rooms, participants, messages or clinical records and cannot grant access.
export class OperationsInvitationsUi {
  #epoch = 0; #request = null; #events = null; #destroyed = false; #hidden = false; #markup = null; #listError = false;
  constructor({ host, transport, centerId, userId, client = new InvitationApiClient(transport), onDenied = () => {}, announce = () => {}, onExit = () => {} }) {
    this.host = host; this.transport = transport; this.centerId = centerId; this.userId = userId; this.client = client;
    this.onDenied = onDenied; this.announce = announce; this.onExit = onExit;
    this.rows = []; this.values = { email: '', role: 'guardian' }; this.busy = false; this.loading = false;
    this.uncertain = false; this.checked = false; this.error = ''; this.notice = '';
  }
  mount() {
    if (this.#events || this.#destroyed) return;
    this.#events = new AbortController();
    this.host.addEventListener('input', () => this.capture(), { signal: this.#events.signal });
    this.host.addEventListener('change', () => this.capture(), { signal: this.#events.signal });
    this.host.addEventListener('click', event => {
      const button = event.target.closest('[data-invites-action]'); if (!button || !this.host.contains(button)) return;
      const action = button.dataset.invitesAction;
      if (action === 'refresh') void this.refresh();
      else if (action === 'acknowledge' && this.checked && !this.busy) { this.uncertain = false; this.checked = false; this.error = ''; this.render(); }
      else if (action === 'exit' && !this.busy) this.onExit();
    }, { signal: this.#events.signal });
    this.host.addEventListener('submit', event => {
      const form = event.target;
      if (!form.matches('[data-invitation-form]')) return;
      event.preventDefault();
      if (!form.reportValidity()) return;
      if (form.dataset.invitationForm === 'invite') { this.capture(); void this.invite(); }
      else if (form.dataset.invitationForm === 'revoke' && form.elements.namedItem('confirmed')?.checked) void this.revoke(form.dataset.invitationId);
    }, { signal: this.#events.signal });
    this.render(); return this.refresh();
  }
  capture() {
    if (this.busy || this.uncertain || this.#hidden || this.#destroyed) return;
    const form = this.host.querySelector('[data-invitation-form="invite"]');
    if (form) this.values = { email: form.elements.namedItem('email').value, role: form.elements.namedItem('role').value };
  }
  render() {
    if (this.#hidden || this.#destroyed) return;
    const html = operationsInvitationsMarkup(this); if (html === this.#markup) return;
    const active = this.host.ownerDocument?.activeElement;
    const descriptor = this.host.contains(active) ? { name: active.name === 'confirmed' ? null : active.name,
      action: active.dataset?.invitesAction, revoke: active.dataset?.revokeInvitation } : null;
    this.host.innerHTML = html; this.#markup = html;
    if (descriptor) [...this.host.querySelectorAll('input,select,button')].find(node => !node.disabled &&
      (descriptor.name ? node.name === descriptor.name : descriptor.action ? node.dataset?.invitesAction === descriptor.action :
        descriptor.revoke ? node.dataset?.revokeInvitation === descriptor.revoke : false))?.focus();
  }
  #begin() {
    this.#request?.abort(); const epoch = ++this.#epoch, controller = new AbortController(); this.#request = controller;
    return { signal: controller.signal, current: () => !this.#destroyed && !this.#hidden && !controller.signal.aborted && epoch === this.#epoch && this.transport.expectedUserId === this.userId };
  }
  #admit(interruptRead = false) {
    if (this.#destroyed || this.#hidden || this.busy || (this.loading && !interruptRead)) return false;
    if (this.transport.expectedUserId !== this.userId) { this.destroy(); this.onDenied(new LocalApiError('AUTH_REQUIRED', 401)); return false; }
    return true;
  }
  async refresh() {
    if (!this.#admit()) return;
    this.capture(); const task = this.#begin(); this.loading = true;
    try {
      const rows = await this.client.list(this.centerId, task.signal); if (!task.current()) return;
      this.rows = rows; this.checked = this.uncertain;
      if (this.#listError) this.error = '';
      this.#listError = false;
    } catch (error) {
      if (task.current()) {
        this.rows = []; this.checked = false;
        if (denied(error)) { this.destroy(); this.onDenied(error); return; }
        this.error = safe(error); this.#listError = true;
      }
    } finally { if (task.current()) { this.loading = false; this.#request = null; this.render(); } }
  }
  invite() { return this.#write('invite'); }
  revoke(invitationId) { return this.#write('revoke', invitationId); }
  async #write(kind, invitationId) {
    if (!this.#admit(true) || this.uncertain) return;
    let input;
    try {
      if (kind === 'invite') input = { email: invitationEmail(this.values.email), role: this.values.role };
      else if (!this.rows.some(v => v.id === invitationId && v.status === 'pending')) throw new LocalApiError('INVALID_INPUT');
    } catch (error) { this.error = safe(error); this.render(); return; }
    // A periodic read must not silently eat an enabled submit click. Only the
    // old read is aborted; a pending write can never be replaced this way.
    const task = this.#begin(); this.loading = false; this.busy = true; this.error = ''; this.#listError = false; this.notice = ''; this.render();
    try {
      if (kind === 'invite') await this.client.invite(this.centerId, input, task.signal);
      else await this.client.revoke(this.centerId, invitationId, task.signal);
      if (!task.current()) return;
      this.notice = kind === 'invite' ? INVITATION_REQUEST_NOTICE : '초대 철회를 확인했어요.';
      if (kind === 'invite') this.values = { email: '', role: this.values.role };
      this.announce(this.notice);
    } catch (error) {
      if (!task.current()) return;
      if (denied(error)) { this.destroy(); this.onDenied(error); return; }
      const rejected = error instanceof LocalApiError && ([400, 413].includes(error.status) ||
        (error.status === 409 && ['INVITATION_EXISTS', 'INVITATION_NOT_PENDING', 'INVITATION_LIST_LIMIT'].includes(error.code)) ||
        (error.code === 'INVALID_INPUT' && error.status === 0));
      this.uncertain = !rejected; this.checked = false; this.error = safe(error);
    } finally {
      if (task.current()) { this.busy = false; this.#request = null; this.render(); }
    }
    if (task.current()) await this.refresh();
  }
  hasPendingWrite() { return this.busy; }
  suspend() {
    if (this.#destroyed) return;
    this.capture(); if (this.busy) { this.uncertain = true; this.checked = false; }
    this.#hidden = true; this.#epoch++; this.#request?.abort(); this.#request = null;
    this.busy = false; this.loading = false; this.rows = []; this.#markup = null; this.host.replaceChildren();
  }
  resume() { if (this.#destroyed) return; this.#hidden = false; this.render(); return this.refresh(); }
  destroy() {
    if (this.#destroyed) return;
    this.suspend(); this.#destroyed = true; this.#events?.abort(); this.#events = null;
    this.rows = []; this.values = { email: '', role: 'guardian' }; this.error = ''; this.notice = ''; this.uncertain = false;
  }
}
