import { LocalApiError } from './client.js';
import { SelfProfileApiClient } from './self-profile-client.js';
import { memberDisplayNameForm, ProfileFieldError } from '../src/profile-fields.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const roles = Object.freeze({ center: '센터', therapist: '치료사', guardian: '보호자', care_recipient: '대상자' });
const conflict = '다른 화면에서 표시 이름이 바뀌었어요. 최신 이름을 확인하고 사용할 입력을 선택해 주세요.';
const uncertain = '저장 결과를 확인하지 못했어요. 입력과 저장 번호를 유지한 채 같은 요청으로 확인해 주세요.';
const denied = error => error instanceof LocalApiError && ['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error.code);
const safeError = error => error instanceof ProfileFieldError ? error.message : error?.code === 'PROFILE_CONFLICT' ? conflict
  : error?.code === 'REVISION_LIMIT' ? '변경 횟수 한도에 도달했어요. 입력을 보존했으며 운영자에게 문의해 주세요.'
    : error?.code === 'INVALID_INPUT' ? '표시 이름은 줄바꿈 없이 1~30자로 입력하거나 비워 주세요.'
      : '현재 표시 이름을 확인할 수 없어요. 연결 상태를 확인하고 다시 시도해 주세요.';
const same = (a, b) => !!a && !!b && a.userId === b.userId && a.centerId === b.centerId && a.role === b.role;
const notify = (fn, ...args) => { try { Promise.resolve(fn?.(...args)).catch(() => {}); } catch { /* UI cleanup must complete. */ } };

// Only this center/account's draft. An uncertain command cannot be turned into
// another write by closing, refreshing or editing another account's profile.
export class SelfProfileDraft {
  constructor(profile) {
    this.userId = profile.userId; this.role = profile.role; this.revision = profile.revision;
    this.value = profile.displayName ?? ''; this.latest = { ...profile }; this.stale = false;
    this.operation = null; this.sending = false; this.uncertain = false; this.error = '';
  }
  reconcile(profile) {
    if (profile.userId !== this.userId || profile.role !== this.role) throw new LocalApiError('AUTH_REQUIRED', 401);
    this.latest = { ...profile };
    if (profile.revision !== this.revision) this.stale = true;
  }
  begin(createId = () => crypto.randomUUID()) {
    if (this.sending) return null;
    if (!this.operation) {
      if (this.stale) throw new LocalApiError('PROFILE_CONFLICT', 409);
      const displayName = memberDisplayNameForm(this.value);
      this.operation = Object.freeze({ clientId: createId(), expectedRevision: this.revision, displayName });
    }
    this.sending = true; this.error = ''; return this.operation;
  }
  failed(operation, error) {
    if (this.operation !== operation) return;
    this.sending = false;
    const rejected = error instanceof LocalApiError && ((error.code === 'INVALID_INPUT' && [0, 400, 413].includes(error.status)) ||
      (['PROFILE_CONFLICT', 'REVISION_LIMIT'].includes(error.code) && error.status === 409));
    if (!this.uncertain && rejected) {
      this.operation = null; this.error = safeError(error);
      if (error.code === 'PROFILE_CONFLICT') { this.stale = true; this.latest = null; }
    } else { this.uncertain = true; this.error = uncertain; }
  }
  interrupt() { if (this.operation) { this.sending = false; this.uncertain = true; this.error = uncertain; } }
  compare(keepInput) {
    if (this.operation || !this.stale || !this.latest) return false;
    this.revision = this.latest.revision;
    if (!keepInput) this.value = this.latest.displayName ?? '';
    this.stale = false; this.error = ''; return true;
  }
}

export function selfProfileMarkup(draft, { role, loading = false, unavailable = false, error = '' } = {}) {
  const button = (action, label, disabled = false) => `<button type="button" data-self-profile-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
  const heading = `<h2 id="self-profile-title" tabindex="-1">내 표시 이름</h2>`;
  const close = button('close', '닫기');
  if (loading || unavailable || !draft) return `<section data-testid="self-profile">${heading}
    <p role="status">${esc(loading ? '현재 계정과 표시 이름을 확인하고 있어요.' : error || '표시 이름을 다시 확인해 주세요.')}</p>
    <div class="self-profile-actions">${loading ? '' : button('refresh', '최신 이름 확인')}${close}</div></section>`;
  const locked = !!draft.operation, value = locked ? draft.operation.displayName ?? '' : draft.value;
  return `<section data-testid="self-profile">${heading}
    <p class="muted small">이 센터에서 소통할 때 보이는 이름입니다. 확인된 실명을 뜻하지 않으며 로그인 정보와 다른 센터의 이름은 바뀌지 않습니다.</p>
    <p class="small">현재 역할: ${esc(roles[role] ?? '')} · 여기에서 역할이나 담당 관계를 변경할 수 없습니다.</p>
    <form data-self-profile-form><div class="self-profile-fields">
      <label>이 센터의 표시 이름<input name="displayName" value="${esc(value)}" maxlength="30" autocomplete="off"${locked ? ' readonly' : ''}></label>
      <p class="small muted">비워 저장하면 이 센터의 기본 표시로 돌아갑니다. 미저장 입력은 이 설정 창을 닫아도 남지만, 새로고침·센터 전환·로그아웃 시 사라집니다.</p>
    </div>${draft.stale && !locked ? `<section data-self-profile-conflict><p>${conflict}</p>
      ${draft.latest ? `<p data-self-profile-latest>최신 이름: ${esc(draft.latest.displayName ?? '기본 표시')}</p><div class="self-profile-actions">${button('keep', '내 입력 유지')}${button('replace', '최신 이름 사용')}</div>` : ''}
      ${button('refresh', '최신 이름 확인')}</section>` : ''}
    <p role="status" data-self-profile-error>${esc(error || draft.error || (draft.sending ? '저장 결과를 확인하고 있어요.' : ''))}</p>
    <div class="self-profile-actions">${locked ? button('retry', '같은 요청 다시 확인', draft.sending)
      : `<button type="submit" class="primary" data-self-profile-action="save"${draft.stale ? ' disabled' : ''}>표시 이름 저장</button>`}${close}</div>
    </form></section>`;
}

export class SelfProfileUi {
  constructor({ host, transport, getContext, onChanged = () => {}, onDenied = () => {}, announce = () => {} }) {
    this.host = host; this.transport = transport; this.getContext = getContext;
    this.onChanged = onChanged; this.onDenied = onDenied; this.announce = announce;
    this.api = new SelfProfileApiClient(transport); this.scope = null; this.draft = null;
    this.epoch = 0; this.pending = null; this.visible = false; this.verified = false; this.destroyed = false; this.opener = null;
    this.events = new AbortController(); const options = { signal: this.events.signal };
    host.setAttribute('aria-labelledby', 'self-profile-title');
    host.addEventListener('cancel', event => { event.preventDefault(); this.close(); }, options);
    host.addEventListener('close', () => { if (this.visible && !host.open) this.close(); }, options);
    host.addEventListener('input', event => { if (event.target?.name === 'displayName') this.snapshot(); }, options);
    host.addEventListener('submit', event => { if (event.target === host.querySelector('[data-self-profile-form]')) { event.preventDefault(); void this.submit(); } }, options);
    host.addEventListener('click', event => {
      const button = event.target.closest?.('[data-self-profile-action]');
      if (!button || !host.contains(button) || button.disabled) return;
      const action = button.dataset.selfProfileAction;
      if (action === 'close') this.close();
      else if (action === 'refresh') void this.open();
      else if (action === 'retry') void this.submit(true);
      else if (action === 'keep' || action === 'replace') this.compare(action === 'keep');
    }, options);
  }
  context() { const ctx = this.getContext(); return ctx && { userId: ctx.userId, centerId: ctx.centerId, role: ctx.role, active: ctx.active === true }; }
  allowed(ctx) { return !!ctx?.active && Object.hasOwn(roles, ctx.role) && ctx.userId === this.transport.expectedUserId && !!ctx.centerId; }
  current(epoch, scope) { const ctx = this.context(); return !this.destroyed && this.visible && this.epoch === epoch && same(scope, ctx) && this.allowed(ctx); }
  settleCurrent(epoch, scope) {
    if (this.current(epoch, scope)) return true;
    if (!this.destroyed && this.visible && this.epoch === epoch) {
      const ctx = this.context();
      if (!same(scope, ctx) || ctx?.userId !== this.transport.expectedUserId) this.invalidate(new LocalApiError('AUTH_REQUIRED', 401));
      else this.suspend();
    }
    return false;
  }
  snapshot() {
    if (this.draft && !this.draft.operation) {
      const input = this.host.querySelector('[name="displayName"]');
      if (input) this.draft.value = input.value;
    }
  }
  render(options = {}, focus = false) {
    if (!this.visible) return;
    this.host.innerHTML = selfProfileMarkup(this.draft, { role: this.scope?.role, ...options });
    if (!this.host.open) this.host.showModal();
    if (focus) (this.host.querySelector('[name="displayName"]') ?? this.host.querySelector('#self-profile-title'))?.focus({ preventScroll: true });
  }
  invalidate(error) {
    this.close(false); this.draft = null; this.scope = null; notify(this.onDenied, error);
  }
  async open() {
    if (this.destroyed || this.pending) return;
    const scope = this.context();
    if (!this.allowed(scope)) { if (this.scope && !same(this.scope, scope)) this.invalidate(new LocalApiError('AUTH_REQUIRED', 401)); else this.suspend(); return; }
    if (this.scope && !same(this.scope, scope)) { this.invalidate(new LocalApiError('AUTH_REQUIRED', 401)); return; }
    this.snapshot(); if (!this.visible) this.opener = this.host.ownerDocument?.activeElement ?? null;
    this.scope = scope; this.visible = true; this.verified = false;
    const epoch = ++this.epoch, controller = new AbortController(); this.pending = controller;
    this.render({ loading: true }, true);
    try {
      const profile = await this.api.get(scope.centerId, controller.signal);
      if (!this.settleCurrent(epoch, scope)) return;
      if (profile.userId !== scope.userId || profile.role !== scope.role) throw new LocalApiError('AUTH_REQUIRED', 401);
      if (this.draft) this.draft.reconcile(profile); else this.draft = new SelfProfileDraft(profile);
      this.verified = true; this.render({}, true);
    } catch (error) {
      if (!this.settleCurrent(epoch, scope)) return;
      if (denied(error)) this.invalidate(error); else this.render({ unavailable: true, error: safeError(error) }, true);
    } finally { if (this.pending === controller) this.pending = null; }
  }
  compare(keepInput) {
    if (this.pending || !this.verified || !this.current(this.epoch, this.scope)) return;
    this.snapshot(); if (this.draft?.compare(keepInput)) this.render({}, true);
  }
  async submit(retry = false) {
    if (this.pending || !this.verified || !this.current(this.epoch, this.scope) || !this.draft || (retry !== !!this.draft.operation)) return;
    this.snapshot(); let operation;
    try { operation = this.draft.begin(); }
    catch (error) { this.draft.error = safeError(error); this.render({}, true); return; }
    if (!operation) return;
    const scope = this.scope, draft = this.draft, epoch = ++this.epoch, controller = new AbortController(); this.pending = controller;
    this.render({}, true);
    try {
      const receipt = await this.api.save(scope.centerId, operation, controller.signal);
      if (!this.settleCurrent(epoch, scope) || this.draft !== draft) return;
      this.draft = null; this.close();
      notify(this.announce, receipt.replayed ? '이전 저장 요청의 처리를 확인했어요. 최신 이름은 다시 열어 확인해 주세요.' : '이 센터의 표시 이름을 저장했어요.');
      notify(this.onChanged);
    } catch (error) {
      if (!this.settleCurrent(epoch, scope) || this.draft !== draft) return;
      if (denied(error)) this.invalidate(error);
      else { draft.failed(operation, error); this.render({}, true); }
    } finally { if (this.pending === controller) this.pending = null; }
  }
  hasPendingWrite() { return !!this.draft?.operation; }
  close(returnFocus = true) {
    this.snapshot(); this.draft?.interrupt(); this.epoch++; this.pending?.abort(); this.pending = null;
    this.visible = false; this.verified = false; if (this.host.open) this.host.close(); this.host.replaceChildren();
    const ctx = this.context();
    if (returnFocus && this.allowed(ctx) && same(this.scope, ctx)) {
      const opener = this.opener?.isConnected ? this.opener : this.host.ownerDocument?.querySelector(
        ctx.role === 'center' ? '[data-ops-action="self-profile"]' : '[data-action="self-profile"]');
      if (opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
    }
    this.opener = null;
  }
  suspend() { this.close(false); }
  destroy() {
    if (this.destroyed) return;
    this.suspend(); this.destroyed = true; this.events.abort(); this.draft = null; this.scope = null;
  }
}
