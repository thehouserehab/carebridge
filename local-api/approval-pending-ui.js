// Presentation follows the authenticated server session. This is not an
// authorization check: every protected API must still check current membership.
export function assignedCenters(user) {
  return (Array.isArray(user?.centers) ? user.centers : []).filter(center =>
    center && typeof center.id === 'string' && center.id.length > 0 &&
    ['therapist', 'guardian', 'center', 'care_recipient'].includes(center.role));
}

export const approvalPendingMarkup = () => `<section class="login" data-testid="approval-pending">
  <p class="eyebrow">계정 연결 확인</p><h1 tabindex="-1">관리자 승인을 기다리고 있어요</h1>
  <p class="muted">아직 연결된 센터와 역할이 없습니다. 센터 관리자에게 계정 연결을 요청해 주세요.</p>
  <p class="muted small">역할은 센터 관리자가 부여합니다. 승인 전에는 아동 정보·대화·기록에 접근할 수 없습니다.</p>
  <div class="actions"><button type="button" class="primary" data-approval="refresh">승인 상태 확인</button>
    <button type="button" data-approval="logout">로그아웃</button></div></section>`;

export class ApprovalPendingUi {
  #host; #transport; #userId; #announce; #onApproved; #onDenied; #onLogout;
  #events = null; #request = null; #mounted = false;
  constructor({ host, transport, userId, announce, onApproved, onDenied, onLogout }) {
    this.#host = host; this.#transport = transport; this.#userId = userId;
    this.#announce = announce; this.#onApproved = onApproved;
    this.#onDenied = onDenied; this.#onLogout = onLogout;
  }
  mount() {
    if (this.#mounted) return;
    this.#mounted = true; this.#events = new AbortController();
    this.#host.innerHTML = approvalPendingMarkup();
    const options = { signal: this.#events.signal };
    this.#host.querySelector('[data-approval="refresh"]').addEventListener('click', () => { void this.refresh(); }, options);
    this.#host.querySelector('[data-approval="logout"]').addEventListener('click', () => {
      this.suspend(); this.#onLogout();
    }, options);
    this.#host.querySelector('h1').focus();
    this.#announce('센터 관리자의 계정 연결을 기다리고 있어요.');
  }
  async refresh() {
    if (!this.#mounted || this.#request) return;
    const request = new AbortController(); this.#request = request;
    this.#host.querySelector('[data-approval="refresh"]').disabled = true;
    try {
      const user = await this.#transport.session(request.signal);
      if (!this.#mounted || this.#request !== request || request.signal.aborted) return;
      if (user.userId !== this.#userId) { this.#onDenied(); return; }
      if (assignedCenters(user).length) { this.#onApproved(user); return; }
      this.#announce('아직 관리자 승인 대기 중입니다. 센터 관리자에게 문의해 주세요.');
    } catch (error) {
      if (!this.#mounted || this.#request !== request || request.signal.aborted) return;
      if (error?.code === 'AUTH_REQUIRED') this.#onDenied();
      else this.#announce('승인 상태를 확인하지 못했어요. 연결 후 다시 확인해 주세요.');
    } finally {
      if (this.#request === request) {
        this.#request = null;
        if (this.#mounted) this.#host.querySelector('[data-approval="refresh"]').disabled = false;
      }
    }
  }
  suspend() {
    this.#request?.abort(); this.#request = null;
    if (this.#mounted) this.#host.querySelector('[data-approval="refresh"]').disabled = false;
  }
  destroy() {
    this.suspend(); this.#events?.abort(); this.#events = null; this.#mounted = false;
  }
}
