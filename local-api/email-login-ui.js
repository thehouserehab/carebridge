import { LocalApiError } from './client.js';
import { EmailLoginClient, EMAIL_LOGIN_NOTICE, emailLoginRequest } from './email-login-client.js';

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
export function emailLoginMarkup({ phase, error = '', email = '' }) {
  let body = '<p role="status">요청을 확인하고 있어요.</p>';
  if (phase === 'email') body = '<form data-email-form="email"><label>시험 이메일<input name="email" type="email" maxlength="254" autocomplete="off" autocapitalize="none" spellcheck="false" required /></label><button class="primary" type="submit">인증번호 요청</button></form>';
  if (phase === 'code') body = `<p>${escape(EMAIL_LOGIN_NOTICE)}</p><p>${escape(email)}</p><form data-email-form="code"><label>8자리 인증번호<input name="code" type="text" inputmode="numeric" pattern="[0-9]{8}" minlength="8" maxlength="8" autocomplete="one-time-code" required /></label><button class="primary" type="submit">인증번호로 로그인</button></form><button type="button" data-email-action="resend">인증번호 다시 요청</button><p class="muted small">유효 시간 10분 · 재요청 간격 60초 · 잘못 입력하면 최대 5회 후 만료됩니다.</p>`;
  if (phase === 'unknown-request') body = '<p role="status">요청 결과를 확인할 수 없어요. 같은 요청을 다시 확인하며 새 인증번호를 중복 발급하지 않습니다.</p><button type="button" data-email-action="retry">같은 요청 다시 확인</button>';
  if (phase === 'unknown-verify') body = '<p role="status">로그인 결과를 확인할 수 없어요. 입력했던 동일한 인증번호로 결과만 다시 확인합니다. 새로 고침하면 현재 서버 세션을 확인합니다.</p><button type="button" data-email-action="retry">같은 로그인 다시 확인</button>';
  if (phase === 'session') body = '<p>이 브라우저에 로그인된 계정이 있습니다. 계정을 바꾸지 않고 현재 로그인을 확인해 주세요.</p><button type="button" data-email-action="session">현재 로그인 확인</button>';
  const exit = !['verifying', 'unknown-verify', 'requesting', 'checking'].includes(phase)
    ? '<button type="button" data-email-action="back">비밀번호 로그인으로 이동</button>' : '';
  return `<section class="login" data-testid="email-login" data-email-phase="${escape(phase)}"><p class="eyebrow">가상 계정 전용</p><h1 tabindex="-1">이메일 인증번호로 연결</h1><p class="muted">실제 메일은 보내지 않습니다. 실행 터미널의 시험 메일함에서 인증번호를 확인하세요.</p>${error ? `<p role="alert" class="care-error">${escape(error)}</p>` : ''}${body}${exit}</section>`;
}

export class EmailLoginUi {
  #events = null; #request = null; #epoch = 0; #busy = null; #hidden = false; #destroyed = false;
  #operation = null; #verification = null; #requestedAt = 0;
  constructor({ host, transport, client = new EmailLoginClient(transport), onAuthenticated, onBack, now = () => Date.now() }) {
    Object.assign(this, { host, transport, client, onAuthenticated, onBack, now });
    this.phase = 'email'; this.error = ''; this.email = '';
  }
  mount() {
    if (this.#events || this.#destroyed) return;
    this.#events = new AbortController();
    this.host.addEventListener('click', event => {
      const button = event.target.closest('[data-email-action]');
      if (button && this.host.contains(button)) void this.action(button.dataset.emailAction);
    }, { signal: this.#events.signal });
    this.host.addEventListener('submit', event => {
      if (!event.target.matches('[data-email-form]')) return;
      event.preventDefault(); void this.submit(event.target);
    }, { signal: this.#events.signal });
    this.render();
  }
  render() {
    if (this.#hidden || this.#destroyed) return;
    this.clearCode(); this.host.innerHTML = emailLoginMarkup(this); this.host.querySelector('h1')?.focus();
  }
  clearCode() { for (const input of this.host.querySelectorAll('input[name="code"]')) input.value = ''; }
  #begin(kind) {
    const controller = new AbortController(), epoch = ++this.#epoch;
    this.#request = controller; this.#busy = kind;
    return { signal: controller.signal, current: () => !this.#destroyed && !this.#hidden && this.#epoch === epoch && !controller.signal.aborted };
  }
  async submit(form) {
    if (this.#destroyed || this.#hidden || this.#busy || this.host.querySelector('[data-email-form]') !== form ||
        form.dataset.emailForm !== this.phase || !['email', 'code'].includes(this.phase) || !form.reportValidity()) return;
    try {
      if (this.phase === 'email') {
        this.#operation = emailLoginRequest(form.elements.namedItem('email').value);
        this.email = this.#operation.email; this.#requestedAt = this.now();
        await this.#run('request');
      } else {
        this.#verification = Object.freeze({ clientId: this.#operation.clientId, code: form.elements.namedItem('code').value });
        await this.#run('verify');
      }
    } catch { this.error = '시험 이메일(.test)과 입력 내용을 확인해 주세요.'; this.render(); }
  }
  async #run(kind) {
    const task = this.#begin(kind); this.phase = kind === 'request' ? 'requesting' : 'verifying'; this.error = ''; this.render();
    try {
      if (kind === 'request') {
        await this.client.request(this.#operation, task.signal);
        if (task.current()) this.phase = 'code';
      } else {
        const identity = await this.client.verify(this.#verification, task.signal);
        if (!task.current()) return;
        this.#verification = null; this.onAuthenticated(identity);
      }
    } catch (error) {
      if (!task.current()) return;
      if (error instanceof LocalApiError && error.code === 'ACCOUNT_SESSION_PRESENT' && error.status === 409) {
        this.#verification = null; this.phase = 'session';
      } else if (error instanceof LocalApiError && ((error.code === 'EMAIL_LOGIN_INVALID' && error.status === 401) ||
          (error.code === 'INVALID_INPUT' && [0, 400, 413].includes(error.status)))) {
        this.#verification = null; this.phase = kind === 'request' ? 'email' : 'code';
        this.error = kind === 'request' ? '시험 이메일(.test)을 확인해 주세요.' : '인증번호가 올바르지 않거나 만료되었어요. 새 인증번호가 필요할 수 있습니다.';
      } else this.phase = kind === 'request' ? 'unknown-request' : 'unknown-verify';
    } finally {
      if (task.current()) { this.#busy = null; this.#request = null; this.render(); }
    }
  }
  async action(action) {
    if (this.#destroyed || this.#hidden || this.#busy) return;
    if (action === 'back' && !['unknown-verify', 'verifying'].includes(this.phase)) { this.destroy(); this.onBack(); return; }
    if (action === 'retry' && ['unknown-request', 'unknown-verify'].includes(this.phase)) {
      await this.#run(this.phase === 'unknown-request' ? 'request' : 'verify'); return;
    }
    if (action === 'resend' && this.phase === 'code') {
      const remaining = 60_000 - (this.now() - this.#requestedAt);
      if (remaining > 0) { this.error = `${Math.ceil(remaining / 1000)}초 뒤에 다시 요청할 수 있어요.`; this.render(); return; }
      this.#operation = emailLoginRequest(this.email); this.#requestedAt = this.now(); this.#verification = null;
      await this.#run('request'); return;
    }
    if (action !== 'session' || this.phase !== 'session') return;
    const task = this.#begin('session'); this.phase = 'checking'; this.error = ''; this.render();
    try {
      this.transport.clearIdentity();
      const identity = await this.transport.session(task.signal);
      if (task.current()) this.onAuthenticated(identity);
    } catch (error) {
      if (task.current()) {
        this.phase = error?.code === 'AUTH_REQUIRED' ? 'email' : 'session';
        this.error = '현재 로그인을 확인하지 못했어요. 다시 확인해 주세요.';
      }
    } finally { if (task.current()) { this.#busy = null; this.#request = null; this.render(); } }
  }
  suspend() {
    if (this.#destroyed) return;
    if (['request', 'verify'].includes(this.#busy)) this.phase = this.#busy === 'request' ? 'unknown-request' : 'unknown-verify';
    if (this.#busy === 'session') this.phase = 'session';
    this.#hidden = true; this.#epoch++; this.#request?.abort(); this.#request = null; this.#busy = null;
    this.clearCode(); this.host.replaceChildren();
  }
  resume() { if (this.#hidden && !this.#destroyed) { this.#hidden = false; this.render(); } }
  destroy() { if (this.#destroyed) return; this.suspend(); this.#destroyed = true; this.#events?.abort(); this.#operation = null; this.#verification = null; this.email = ''; }
}
