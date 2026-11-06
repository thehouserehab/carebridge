import { LocalApiError } from './client.js';
import { InvitationApiClient, invitationEmail } from './invitation-client.js';
import { escapeHtml as esc, roleName } from './workspace-ui.js';
export { takeInvitationToken } from './invitation-token.js';

const unknownNew = '수락 결과를 확인하지 못했어요. 다시 가입하지 말고, 초대받은 시험 이메일과 설정한 비밀번호로 로그인하여 확인해 주세요.';
const unknownExisting = '연결 결과를 확인하지 못했어요. 같은 로그인 계정으로 이전 요청만 다시 확인할 수 있습니다.';
const safe = error => error instanceof LocalApiError ? error.message : '요청 결과를 확인할 수 없어요.';
const definitive = e => e instanceof LocalApiError && ([400, 403, 404, 410, 413].includes(e.status) ||
  (e.status === 409 && ['ACCOUNT_SESSION_PRESENT', 'INVITATION_ACCOUNT_EXISTS', 'INVITATION_MEMBERSHIP_UNAVAILABLE', 'INVITATION_CONFLICT'].includes(e.code)) ||
  (e.status === 0 && e.code === 'INVALID_INPUT'));
const button = (label, action) => `<button type="button" data-invitation-action="${action}">${label}</button>`;
const password = (name, label) => `<label>${label}<input name="${name}" type="password" minlength="12" maxlength="128" required autocomplete="off"></label>`;

export function invitationMarkup({ phase, invitation, user, error = '' }) {
  const details = invitation ? `<section class="surface-card"><p>연결할 센터 <strong>${esc(invitation.centerId)}</strong></p><p>역할 <strong>${esc(roleName(invitation.role))}</strong></p><p class="small muted">센터 소속 수락과 아동 담당 관계 연결은 별개입니다.</p></section>` : '';
  const consent = '<label class="care-check"><input type="checkbox" name="confirmed" required>위 센터와 역할로 연결하는 것을 확인했어요.</label>';
  let body = '';
  if (phase === 'checking' || phase === 'pending') body = '<p role="status">초대와 현재 계정을 확인하고 있어요.</p>';
  else if (phase === 'choose') body = `${button('새 시험 계정으로 수락', 'new')}${button('기존 계정으로 연결', 'existing')}`;
  else if (phase === 'new') body = `<form data-invitation-form="new" autocomplete="off"><div class="care-fields">${password('password', '새 시험 비밀번호')}${password('confirmation', '비밀번호 확인')}${consent}</div><p class="small muted">12~128자. 실제 사용하는 비밀번호는 입력하지 마세요. 초대받은 주소의 새 계정을 생성합니다.</p><button class="primary" type="submit">초대 수락</button></form>${button('기존 계정으로 연결', 'existing')}`;
  else if (phase === 'login') body = `<form data-invitation-form="login" autocomplete="off"><div class="care-fields"><label>시험 이메일<input name="email" type="email" required maxlength="254" autocomplete="off" placeholder="member@example.test"></label>${password('password', '시험 비밀번호')}</div><p class="small muted">초대받은 주소와 같은 기존 계정으로 로그인해 주세요.</p><button class="primary" type="submit">로그인하고 확인</button></form>`;
  else if (phase === 'existing') body = `<p>현재 로그인된 계정 <strong>${esc(user?.email ?? '')}</strong></p><form data-invitation-form="existing">${consent}<button class="primary" type="submit">이 계정으로 연결</button></form>${button('다른 계정으로 로그인', 'logout')}`;
  else if (phase === 'unknown-new') body = `<p role="status">${unknownNew}</p>${button('로그인으로 결과 확인', 'exit')}`;
  else if (phase === 'unknown-existing') body = `<p role="status">${unknownExisting}</p>${button('이전 연결 요청 확인', 'retry-existing')}`;
  else if (phase === 'suspended') body = '<p role="status">화면을 숨겼어요. 다시 연결되면 현재 계정을 확인합니다.</p>';
  else body = '<p>이 초대를 사용할 수 없어요. 만료되었거나 이미 사용·철회된 링크일 수 있습니다. 센터에 새 안내를 요청해 주세요.</p>';
  return `<section class="login-card invitation-card" data-testid="invitation"><p class="eyebrow">Carebridge · 가상 자료 시험</p><h1 tabindex="-1">센터 초대</h1>${details}<div class="care-fields">${body}</div><p class="care-error" data-invitation-error role="status">${esc(error)}</p><p class="small muted">초대 링크와 비밀번호는 이 창의 저장소에 보관하지 않습니다. 새로고침하면 원래 링크를 다시 열어 주세요. 실제 메일은 보내지 않습니다.</p>${phase === 'unknown-new' ? '' : button('나가기', 'exit')}</section>`;
}

// Capability and retry body are private fields, never enumerable view state.
// Passwords live only in the submitted request and are never draft fields.
export class InvitationUi {
  #token = null; #existingOperation = null; #epoch = 0; #request = null; #events = null;
  #newAttempted = false; #busyKind = null; #destroyed = false; #hidden = false;
  constructor({ host, transport, client = new InvitationApiClient(transport), onAuthenticated = () => {}, onExit = () => {} }) {
    this.host = host; this.transport = transport; this.client = client;
    this.onAuthenticated = onAuthenticated; this.onExit = onExit;
    this.phase = 'checking'; this.invitation = null; this.user = null; this.error = '';
  }
  async mount(token) {
    if (this.#events || this.#destroyed) return;
    this.#events = new AbortController(); this.#token = token;
    this.host.addEventListener('click', event => {
      const control = event.target.closest('[data-invitation-action]');
      if (control && this.host.contains(control)) void this.action(control.dataset.invitationAction);
    }, { signal: this.#events.signal });
    this.host.addEventListener('submit', event => {
      if (!event.target.matches('[data-invitation-form]')) return;
      event.preventDefault(); void this.submit(event.target);
    }, { signal: this.#events.signal });
    await this.resume();
  }
  clearPasswords() {
    for (const input of this.host.querySelectorAll('input[name="password"],input[name="confirmation"]')) input.value = '';
  }
  render() {
    if (this.#destroyed || this.#hidden) return;
    this.clearPasswords(); this.host.innerHTML = invitationMarkup(this);
    this.host.querySelector('h1')?.focus();
  }
  #begin(kind) {
    this.#request?.abort(); const epoch = ++this.#epoch;
    const controller = new AbortController(); this.#request = controller; this.#busyKind = kind;
    return { signal: controller.signal, current: () => !this.#destroyed && !this.#hidden && this.#epoch === epoch && !controller.signal.aborted };
  }
  #finish(task) { if (task.current()) { this.#busyKind = null; this.#request = null; } }
  async #session(task) {
    try {
      const user = await this.transport.session(task.signal);
      if (task.current()) this.user = user;
    } catch (error) {
      if (!task.current()) return;
      if (error?.code !== 'AUTH_REQUIRED') throw error;
      this.transport.clearIdentity(); this.user = null;
    }
  }
  async resume() {
    if (this.#destroyed || (!this.#hidden && this.#busyKind)) return;
    this.#hidden = false;
    if (this.#newAttempted) { this.phase = 'unknown-new'; this.render(); return; }
    const retry = !!this.#existingOperation, task = this.#begin('read');
    this.phase = 'checking'; this.error = ''; this.render();
    try {
      const expected = retry ? this.user?.userId : null;
      await this.#session(task); if (!task.current()) return;
      if (retry) {
        if (!this.user || this.user.userId !== expected) { this.#existingOperation = null; this.#token = null; this.phase = 'unavailable'; }
        else this.phase = 'unknown-existing';
      } else {
        const invite = await this.client.preview(this.#token, task.signal); if (!task.current()) return;
        this.invitation = invite; this.phase = this.user ? 'existing' : 'choose';
      }
    } catch (error) { if (task.current()) { this.error = safe(error); this.phase = 'unavailable'; } }
    finally { this.#finish(task); if (task.current()) this.render(); }
  }
  async action(action) {
    if (this.#destroyed) return;
    if (action === 'exit') { this.destroy(); this.onExit(); return; }
    if (this.#hidden || this.#busyKind) return;
    if (action === 'retry-existing' && this.phase === 'unknown-existing') { await this.acceptExisting(); return; }
    if (action === 'logout' && this.phase === 'existing') {
      const task = this.#begin('logout'); this.phase = 'pending'; this.render();
      try { await this.transport.logout(task.signal); if (!task.current()) return; this.transport.clearIdentity(); this.user = null; this.phase = 'login'; }
      catch (error) { if (task.current()) { this.error = safe(error); this.phase = 'unavailable'; } }
      finally { this.#finish(task); if (task.current()) this.render(); }
      return;
    }
    if (!['choose', 'new', 'login', 'existing'].includes(this.phase) || this.#existingOperation || this.#newAttempted) return;
    if (action === 'new') this.phase = this.user ? 'existing' : 'new';
    else if (action === 'existing') this.phase = this.user ? 'existing' : 'login';
    this.error = ''; this.render();
  }
  async submit(form) {
    if (this.#destroyed || this.#hidden || this.#busyKind || this.host.querySelector('[data-invitation-form]') !== form) return;
    const kind = form.dataset.invitationForm;
    if (kind !== this.phase || !form.reportValidity()) return;
    if (kind === 'existing') { if (form.elements.namedItem('confirmed')?.checked) await this.acceptExisting(); return; }
    const password = form.elements.namedItem('password')?.value;
    const confirmation = form.elements.namedItem('confirmation')?.value;
    const email = form.elements.namedItem('email')?.value;
    const confirmed = form.elements.namedItem('confirmed')?.checked;
    this.clearPasswords();
    if (kind === 'new' && !confirmed) return;
    const task = this.#begin(kind); this.phase = 'pending'; this.error = ''; this.render();
    try {
      if (kind === 'login') {
        const user = await this.transport.login(invitationEmail(email), password, task.signal); if (!task.current()) return;
        this.user = user;
        this.invitation = await this.client.preview(this.#token, task.signal); if (!task.current()) return;
        this.phase = 'existing';
      } else if (kind === 'new' && !this.#newAttempted) {
        this.#newAttempted = true;
        const result = await this.client.accept({ token: this.#token, centerId: this.invitation.centerId, role: this.invitation.role, password, confirmation }, task.signal);
        if (!task.current()) return;
        await this.#authenticated(result, task);
      }
    } catch (error) {
      if (!task.current()) return;
      this.error = safe(error);
      if (kind === 'new') {
        if (definitive(error)) {
          this.#newAttempted = false;
          this.phase = error.code === 'INVITATION_ACCOUNT_EXISTS' ? 'login' : error.code === 'ACCOUNT_SESSION_PRESENT' ? 'unavailable' : error.status === 410 ? 'unavailable' : 'new';
        } else this.phase = 'unknown-new';
      } else this.phase = 'login';
    } finally { this.#finish(task); if (task.current()) this.render(); }
  }
  async #authenticated(result, task) {
    if (result.invitation.id !== this.invitation.id || result.invitation.centerId !== this.invitation.centerId || result.invitation.role !== this.invitation.role)
      throw new LocalApiError('INVALID_RESPONSE');
    this.transport.expectedUserId = result.user.userId;
    const current = await this.transport.session(task.signal);
    if (!task.current()) return;
    if (current.userId !== result.user.userId || !current.centers.some(c => c.id === this.invitation.centerId && c.role === this.invitation.role))
      throw new LocalApiError('AUTH_REQUIRED', 401);
    const centerId = this.invitation.centerId;
    this.destroy(); this.onAuthenticated(current, centerId);
  }
  async acceptExisting() {
    if (this.#busyKind || this.#destroyed || this.#hidden || !this.user || !['existing', 'unknown-existing'].includes(this.phase)) return;
    const task = this.#begin('existing'), previousUnknown = !!this.#existingOperation;
    this.#existingOperation ??= Object.freeze({ token: this.#token, centerId: this.invitation.centerId, role: this.invitation.role });
    this.phase = 'pending'; this.error = ''; this.render();
    try {
      const result = await this.client.acceptExisting(this.#existingOperation, task.signal); if (!task.current()) return;
      await this.#authenticated(result, task);
    } catch (error) {
      if (!task.current()) return;
      this.error = safe(error);
      if (error?.code === 'AUTH_REQUIRED' || error?.status === 403) { this.#existingOperation = null; this.#token = null; this.user = null; this.phase = 'unavailable'; }
      else if (!previousUnknown && definitive(error)) { this.#existingOperation = null; this.phase = 'existing'; }
      else this.phase = 'unknown-existing';
    } finally { this.#finish(task); if (task.current()) this.render(); }
  }
  suspend() {
    if (this.#destroyed) return;
    if (this.#busyKind === 'new') this.#newAttempted = true;
    this.#hidden = true; this.#epoch++; this.#request?.abort(); this.#request = null; this.#busyKind = null;
    this.clearPasswords(); this.host.replaceChildren();
  }
  destroy() {
    if (this.#destroyed) return;
    this.suspend(); this.#destroyed = true; this.#events?.abort(); this.#events = null;
    this.#token = null; this.#existingOperation = null; this.invitation = null; this.user = null; this.error = '';
  }
}
