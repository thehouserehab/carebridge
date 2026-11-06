import { LocalApiError } from './client.js';
import { RecoveryApiClient, RECOVERY_REQUEST_NOTICE } from './recovery-client.js';
import { isRecoveryToken } from './recovery-token.js';

const exit = '<button type="button" data-recovery-action="exit">로그인으로 이동</button>';
const retrySession = '<button type="button" data-recovery-action="session">세션 다시 확인</button>';
const newLink = '<a href="/account/password-recovery/request">새 재설정 안내 요청</a>';
const terminal = phase => ['requested', 'completed', 'unknown-request', 'unknown-complete', 'invalid'].includes(phase);
const errors = Object.freeze({
  INVALID_INPUT: '입력 내용을 확인하고 다시 입력해 주세요.',
  PASSWORD_CONFIRMATION_MISMATCH: '새 비밀번호와 확인 값이 일치하지 않습니다.',
  PASSWORD_UNCHANGED: '기존 비밀번호와 다른 새 비밀번호를 입력해 주세요.',
});
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function recoveryMarkup({ phase, error = '' }) {
  let title = '세션을 확인하고 있어요', content = '<p role="status">잠시 기다려 주세요.</p>';
  if (phase === 'request') {
    title = '비밀번호 재설정 안내';
    content = '<p>가입할 때 사용한 시험 이메일(.test)을 입력해 주세요.</p><form data-recovery-form="request" autocomplete="off"><label>시험 이메일<input name="email" type="email" maxlength="254" autocomplete="off" required /></label><button class="primary" type="submit">재설정 안내 요청</button></form>';
  } else if (phase === 'complete') {
    title = '새 비밀번호 설정';
    content = '<p>시험 계정에 사용할 새 비밀번호를 입력해 주세요. 변경 후 모든 기존 세션이 종료됩니다.</p><form data-recovery-form="complete" autocomplete="off"><label>새 비밀번호<input name="newPassword" type="password" minlength="12" maxlength="128" autocomplete="off" required /></label><label>새 비밀번호 확인<input name="confirmation" type="password" minlength="12" maxlength="128" autocomplete="off" required /></label><p>12~128자로 입력하세요. 실제 사용하는 비밀번호는 입력하지 마세요.</p><button class="primary" type="submit">비밀번호 재설정</button></form>';
  } else if (phase === 'session') {
    title = '먼저 현재 계정을 로그아웃해 주세요';
    content = '<p>이 브라우저에 로그인된 계정이 있어요. 비밀번호 복구는 로그아웃한 뒤 진행할 수 있습니다.</p><button type="button" data-recovery-action="logout">현재 계정 로그아웃</button>';
  } else if (phase === 'requested') {
    title = '요청을 확인했어요'; content = `<p role="status">${RECOVERY_REQUEST_NOTICE}</p><p>계정 존재나 실제 메일 발송 완료를 뜻하지 않습니다. 시험용 전달 경로에서 새 안내를 확인해 주세요.</p>`;
  } else if (phase === 'completed') {
    title = '비밀번호를 재설정했어요'; content = '<p role="status">새 비밀번호로 다시 로그인해 주세요. 이 화면에서는 자동 로그인하지 않습니다.</p>';
  } else if (phase === 'unknown-request') {
    title = '요청 결과를 확인할 수 없어요'; content = '<p role="status">요청을 다시 보내지 않았습니다. 시험용 전달 경로에서 새 안내를 확인해 주세요. 계정 존재나 발송 여부는 이 화면에서 알 수 없습니다.</p>';
  } else if (phase === 'unknown-complete') {
    title = '재설정 결과를 확인할 수 없어요'; content = '<p role="status">재설정 요청을 다시 보내지 않습니다. 설정한 새 비밀번호로 일반 로그인을 시도해 주세요. 로그인되지 않으면 새 안내를 요청해 주세요.</p>';
  } else if (phase === 'invalid') {
    title = '재설정 링크를 사용할 수 없어요'; content = `<p>만료되었거나 이미 사용된 링크일 수 있어요. 새 안내를 요청해 주세요.</p>${newLink}`;
  } else if (phase === 'unavailable') {
    title = '현재 세션을 확인할 수 없어요'; content = `<p>로그아웃되었다고 확인되지 않아 복구 입력을 열지 않았습니다.</p>${retrySession}`;
  } else if (phase === 'requesting' || phase === 'completing' || phase === 'logout') {
    title = '요청을 확인하고 있어요'; content = '<p role="status">중복으로 요청하지 말고 잠시 기다려 주세요.</p>';
  }
  return `<section class="login invitation-card" data-testid="recovery" data-recovery-phase="${escape(phase)}"><h1 tabindex="-1">${title}</h1>${error ? `<p class="care-error" role="alert">${escape(error)}</p>` : ''}${content}${exit}</section>`;
}

export class RecoveryUi {
  #token = null; #events = null; #request = null; #epoch = 0; #busy = null; #hidden = false; #destroyed = false; #mounted = false;
  constructor({ host, transport, client = new RecoveryApiClient(transport), mode, onExit = () => {} }) {
    if (!['request', 'complete'].includes(mode)) throw new TypeError('Recovery mode required.');
    this.host = host; this.transport = transport; this.client = client; this.mode = mode; this.onExit = onExit;
    this.phase = 'checking'; this.error = '';
  }
  async mount(token = null) {
    if (this.#mounted || this.#destroyed) return;
    this.#mounted = true; this.#token = this.mode === 'complete' && isRecoveryToken(token) ? token : null;
    this.#events = new AbortController();
    this.host.addEventListener('click', event => {
      const button = event.target.closest('[data-recovery-action]');
      if (button && this.host.contains(button)) void this.action(button.dataset.recoveryAction);
    }, { signal: this.#events.signal });
    this.host.addEventListener('submit', event => {
      if (!event.target.matches('[data-recovery-form]')) return;
      event.preventDefault(); void this.submit(event.target);
    }, { signal: this.#events.signal });
    if (this.mode === 'complete' && !this.#token) { this.phase = 'invalid'; this.render(); return; }
    await this.resume();
  }
  clearPasswords() {
    for (const input of this.host.querySelectorAll('input[name="newPassword"],input[name="confirmation"]')) input.value = '';
  }
  render() {
    if (this.#hidden || this.#destroyed) return;
    this.clearPasswords(); this.host.innerHTML = recoveryMarkup(this); this.host.querySelector('h1')?.focus();
  }
  #begin(kind) {
    this.#request?.abort(); const epoch = ++this.#epoch, controller = new AbortController();
    this.#request = controller; this.#busy = kind;
    return { signal: controller.signal, current: () => !this.#destroyed && !this.#hidden && this.#epoch === epoch && !controller.signal.aborted };
  }
  #finish(task) { if (task.current()) { this.#request = null; this.#busy = null; } }
  async #checkSession(task) {
    // A fresh read can identify a changed cookie; logout itself stays bound.
    this.transport.clearIdentity();
    try {
      await this.transport.session(task.signal);
      if (task.current()) this.phase = 'session';
    } catch (error) {
      if (!task.current()) return;
      if (!(error instanceof LocalApiError) || error.code !== 'AUTH_REQUIRED' || error.status !== 401) throw error;
      this.transport.clearIdentity(); this.phase = this.mode;
    }
  }
  async resume() {
    if (this.#destroyed || !this.#mounted || (!this.#hidden && this.#busy)) return;
    this.#hidden = false;
    if (terminal(this.phase)) { this.render(); return; }
    const task = this.#begin('session'); this.phase = 'checking'; this.error = ''; this.render();
    try { await this.#checkSession(task); }
    catch { if (task.current()) this.phase = 'unavailable'; }
    finally { this.#finish(task); if (task.current()) this.render(); }
  }
  async action(action) {
    if (this.#destroyed) return;
    if (action === 'exit') { this.destroy(); this.onExit(); return; }
    if (this.#hidden || this.#busy) return;
    if (action === 'session' && this.phase === 'unavailable') { await this.resume(); return; }
    if (action !== 'logout' || this.phase !== 'session') return;
    const task = this.#begin('logout'); this.phase = 'logout'; this.error = ''; this.render();
    try {
      await this.transport.logout(task.signal); if (!task.current()) return;
      await this.#checkSession(task);
    } catch { if (task.current()) this.phase = 'unavailable'; }
    finally { this.#finish(task); if (task.current()) this.render(); }
  }
  async submit(form) {
    if (this.#destroyed || this.#hidden || this.#busy || this.host.querySelector('[data-recovery-form]') !== form ||
        form?.dataset.recoveryForm !== this.phase || !['request', 'complete'].includes(this.phase) || !form.reportValidity()) return;
    const kind = this.phase, email = form.elements.namedItem('email')?.value;
    const newPassword = form.elements.namedItem('newPassword')?.value, confirmation = form.elements.namedItem('confirmation')?.value;
    this.clearPasswords();
    const task = this.#begin(kind); this.phase = kind === 'request' ? 'requesting' : 'completing'; this.error = ''; this.render();
    try {
      if (kind === 'request') await this.client.request(email, task.signal);
      else await this.client.complete({ token: this.#token, newPassword, confirmation }, task.signal);
      if (!task.current()) return;
      this.#token = null; this.phase = kind === 'request' ? 'requested' : 'completed';
    } catch (error) {
      if (!task.current()) return;
      if (error instanceof LocalApiError && [0, 400].includes(error.status) && Object.hasOwn(errors, error.code)) {
        this.phase = kind; this.error = errors[error.code];
      } else if (error instanceof LocalApiError && error.status === 409 && error.code === 'ACCOUNT_SESSION_PRESENT') {
        // No write was accepted; confirm the live cookie before a bound logout.
        try { await this.#checkSession(task); } catch { if (task.current()) this.phase = 'unavailable'; }
      } else {
        this.#token = null;
        this.phase = error instanceof LocalApiError && error.status === 410 && error.code === 'PASSWORD_RECOVERY_INVALID'
          ? 'invalid' : kind === 'request' ? 'unknown-request' : 'unknown-complete';
      }
    } finally { this.#finish(task); if (task.current()) this.render(); }
  }
  suspend() {
    if (this.#destroyed) return;
    if (this.#busy === 'request' || this.#busy === 'complete') {
      this.phase = this.#busy === 'request' ? 'unknown-request' : 'unknown-complete'; this.#token = null;
    }
    this.#hidden = true; this.#epoch++; this.#request?.abort(); this.#request = null; this.#busy = null;
    this.clearPasswords(); this.host.replaceChildren();
  }
  destroy() {
    if (this.#destroyed) return;
    this.suspend(); this.#destroyed = true; this.#token = null; this.#events?.abort(); this.#events = null; this.error = '';
  }
}
