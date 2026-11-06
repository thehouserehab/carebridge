import { LocalApiError } from './client.js';
import { OperationsApiClient } from './operations-client.js';
import { escapeHtml as esc, roleName } from './workspace-ui.js';
import { childProfileFields, childProfileFormValues, profileToday, ProfileFieldError } from '../src/profile-fields.js';
import { ChildRegistrationDraft, RelationshipDraft, registrationMarkup, relationshipsMarkup, relationshipSummary } from './operations-onboarding.js';
import { AppointmentApiClient } from './appointment-client.js';
import { contextDate } from '../src/context-fields.js';
import { CenterAppointmentDraft, scheduleFields, scheduleKey, scheduleSummary, operationsOverviewMarkup,
  operationsScheduleMarkup, operationsAppointmentMarkup } from './operations-schedule.js';

const valuesOf = p => ({ name: p.name ?? '', age: p.age === null ? '' : String(p.age), ageAsOf: p.ageAsOf ?? '' });
const denied = error => ['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error?.code);
const conflict = '다른 화면에서 기본정보가 바뀌었어요. 작성한 입력과 최신 내용을 비교한 뒤 다시 검토해 주세요.';
const uncertain = '저장 결과를 확인하지 못했어요. 내용과 저장 번호를 유지한 채 같은 요청으로 확인해 주세요.';
const safeError = error => error instanceof ProfileFieldError ? error.message
  : error?.code === 'PROFILE_CONFLICT' ? conflict : error instanceof LocalApiError ? error.message : '처리 결과를 확인할 수 없어요. 다시 확인해 주세요.';

// A draft belongs to one authenticated UI instance (user + center) and one
// child. It never goes to browser storage. An unknown write cannot be discarded
// or changed into a new command until the original receipt is confirmed.
export class ChildProfileDraft {
  constructor(profile) {
    this.childId = profile.childId; this.roomId = profile.conversationId;
    this.revision = profile.revision; this.values = valuesOf(profile); this.latest = profile;
    this.stale = false; this.operation = null; this.sending = false; this.uncertain = false; this.error = '';
  }
  reconcile(profile) {
    if (profile.childId !== this.childId || profile.conversationId !== this.roomId) throw new LocalApiError('INVALID_RESPONSE');
    this.latest = profile;
    if (profile.revision !== this.revision) this.stale = true;
  }
  begin(createId = () => crypto.randomUUID()) {
    if (this.sending) return null;
    if (!this.operation) {
      if (this.stale) throw new LocalApiError('PROFILE_CONFLICT', 409);
      const content = childProfileFields(childProfileFormValues(this.values), { today: profileToday() });
      this.operation = Object.freeze({ clientId: createId(), expectedRevision: this.revision, content: Object.freeze(content) });
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
  interrupt() {
    if (this.operation) { this.sending = false; this.uncertain = true; this.error = uncertain; }
  }
  compare(keepInput) {
    if (this.operation || !this.stale || !this.latest) return false;
    this.revision = this.latest.revision;
    if (!keepInput) this.values = valuesOf(this.latest);
    this.stale = false; this.error = ''; return true;
  }
}

export function operationsListMarkup(children, drafts = new Map()) {
  return `<header class="page-heading"><h1 tabindex="-1" data-ops-title>아이 기본정보</h1>
    <p class="muted small">아이 기본정보와 담당 관계를 관리합니다. 치료 대화와 임상 기록은 조회하지 않습니다.</p></header>
    <button type="button" class="primary" data-ops-action="new-child">아이 등록·작성 이어보기</button>
    <section class="surface-card" data-testid="operations-children">${children.map(p => `<article class="ops-child-row"><button type="button" class="list-link" data-ops-child="${esc(p.conversationId)}">
      <strong>${esc(p.name ?? '이름 미등록 아동')}</strong><span class="small muted">${p.age === null ? '연령 미등록' : `${esc(p.age)}세 · ${esc(p.ageAsOf)} 기준`}</span>
      <span class="small">${drafts.has(p.conversationId) ? '작성 중인 입력 이어보기' : '기본정보 수정'} →</span></button>
      <button type="button" data-ops-relationships="${esc(p.conversationId)}">담당 관계 설정 · ${esc(p.name ?? '이름 미등록 아동')}</button><button type="button" data-ops-recipient="${esc(p.conversationId)}">대상자 연결 · 주 소통자 · ${esc(p.name ?? '이름 미등록 대상자')}</button></article>`).join('') || '<p class="empty">등록된 아이가 없습니다.</p>'}</section>
    <p class="muted small">등록 후 담당 관계를 별도로 설정해 주세요. 일정 메뉴에서 현재 일정과 출결을 관리할 수 있습니다.</p>`;
}
export function operationsEditorMarkup(draft) {
  const v = draft.values;
  return `<button type="button" data-ops-action="back">아이 목록으로</button>
    <header class="page-heading"><h1 tabindex="-1" data-ops-title>아이 기본정보 수정</h1>
      <p class="muted small">연결된 치료사·보호자도 변경된 기본정보를 보게 됩니다. 메시지는 자동 전송하지 않습니다.</p></header>
    <section class="surface-card"><form data-testid="operations-form" autocomplete="off">
      <div class="care-fields"><label>이름<input name="name" value="${esc(v.name)}" required maxlength="30" autocomplete="off"></label>
      <div class="care-grid"><label>연령<input name="age" value="${esc(v.age)}" type="number" min="0" max="26" step="1" inputmode="numeric"></label>
      <label>연령 기준일<input name="ageAsOf" value="${esc(v.ageAsOf)}" type="date" min="1900-01-01" max="${esc(profileToday())}"></label></div>
      <p class="muted small">연령과 기준일은 함께 입력하거나 모두 비워 주세요. 0세와 미등록은 다릅니다. 생년월일을 추정하거나 연령을 자동으로 올리지 않습니다.</p></div>
      <p class="care-error" data-ops-error role="status"></p><section data-ops-conflict hidden></section>
      <div class="care-actions care-submit"><button class="primary" type="submit">기본정보 저장</button>
      <button type="button" data-ops-action="retry" hidden>같은 요청으로 확인</button>
      <button type="button" data-ops-action="discard">입력 취소</button></div>
      <p class="muted small">미저장 입력은 이 창의 메모리에만 보관합니다. 브라우저 새로고침·센터 전환·로그아웃 시 사라집니다.</p>
    </form></section>`;
}

export class OperationsUi {
  constructor({ host, transport, user, centerId, invitationsEnabled = false, announce = () => {}, onDenied = () => {}, onLogout = () => {}, onAccount = () => {}, onCenterChange = () => {} }) {
    this.host = host; this.transport = transport; this.api = new OperationsApiClient(transport);
    this.user = user; this.centerId = centerId; this.announce = announce; this.onDenied = onDenied;
    this.onLogout = onLogout; this.onAccount = onAccount; this.onCenterChange = onCenterChange;
    this.invitationsEnabled = invitationsEnabled; this.invitations = null;
    this.recipient = null;
    this.states = new Map(); this.children = []; this.selected = null; this.connected = false;
    this.relationshipStates = new Map(); this.registration = null; this.mode = 'profile';
    this.scheduleApi = new AppointmentApiClient(transport, { operational: true });
    this.scheduleDrafts = new Map(); this.appointmentId = null; this.scheduleRows = []; this.members = [];
    this.scheduleDate = profileToday(); this.dateInput = this.scheduleDate; this.summaryDate = this.scheduleDate; this.newAppointmentChild = '';
    this.painted = new WeakMap();
    this.controller = new AbortController(); this.epoch = 0; this.pending = null; this.destroyed = false;
  }
  mount() {
    this.host.innerHTML = `<section class="workspace" data-testid="operations"><header class="workspace-head">
      <div><p class="eyebrow">센터 관리자로 연결됨</p><p class="account">${esc(this.user.email)}</p></div>
      <div class="actions"><button type="button" data-ops-action="self-profile">계정 설정</button><button type="button" data-ops-action="refresh">새로고침</button><button type="button" data-ops-action="logout">로그아웃</button></div></header>
      ${this.user.centers.length > 1 ? `<label class="center-label">센터 선택<select data-ops-center>${this.user.centers.map(c => `<option value="${esc(c.id)}" ${c.id === this.centerId ? 'selected' : ''}>${esc(c.id)} · ${esc(roleName(c.role))}</option>`).join('')}</select></label>` : ''}
      <nav class="ops-nav" aria-label="센터 메뉴"><button type="button" data-ops-view="overview">운영 현황</button><button type="button" data-ops-view="children">아동</button><button type="button" data-ops-view="schedule">일정</button></nav>
      <div data-ops-content></div></section>`;
    this.events = new AbortController();
    this.host.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || !this.host.contains(button)) return;
      if (button.dataset.opsChild) { void this.open(button.dataset.opsChild); return; }
      if (button.dataset.opsRelationships) { void this.open(button.dataset.opsRelationships, 'relationships'); return; }
      if (button.dataset.opsRecipient) { void this.openRecipient(button.dataset.opsRecipient); return; }
      if (button.dataset.opsView) { void this.showSection(button.dataset.opsView); return; }
      if (button.dataset.opsAppointment) { void this.openAppointment(button.dataset.opsRoom, button.dataset.opsAppointment); return; }
      if (button.dataset.opsResume) {
        const draft = this.scheduleDrafts.get(button.dataset.opsResume);
        if (draft) void this.openAppointment(draft.roomId, draft.id); return;
      }
      const action = button.dataset.opsAction;
      if (action === 'logout') this.onLogout();
      else if (action === 'self-profile') this.onAccount();
      else if (action === 'refresh') void this.refresh();
      else if (action === 'back') this.back();
      else if (action === 'new-child') void this.newChild();
      else if (action === 'invitations') void this.openInvitations();
      else if (action === 'new-appointment') void this.openAppointment(this.host.querySelector('[data-ops-new-child]')?.value);
      else if (action === 'today-schedule') { this.scheduleDate = profileToday(); this.dateInput = this.scheduleDate; void this.showSection('schedule'); }
      else if (action === 'retry') void this.save();
      else if (action === 'discard') this.discard();
      else if (action === 'keep' || action === 'replace') this.compare(action === 'keep');
    }, { signal: this.events.signal });
    this.host.addEventListener('input', () => { this.capture(); this.controls(); }, { signal: this.events.signal });
    this.host.addEventListener('change', () => { this.capture(); this.controls(); }, { signal: this.events.signal });
    this.host.addEventListener('submit', event => {
      if (event.target.matches('[data-ops-date-form]')) { event.preventDefault(); void this.applyDate(); return; }
      if (!event.target.matches('[data-testid="operations-form"],[data-testid="operations-registration-form"],[data-testid="operations-relationships-form"],[data-testid="operations-appointment-form"]')) return;
      event.preventDefault(); void this.save();
    }, { signal: this.events.signal });
    this.host.querySelector('[data-ops-center]')?.addEventListener('change', event => {
      if (!this.hasPendingWrite()) this.onCenterChange(event.target.value);
    }, { signal: this.events.signal });
    this.render();
  }
  draftKey() { return this.mode === 'appointment' ? scheduleKey(this.selected, this.appointmentId) : this.selected; }
  current() { return this.mode === 'registration' ? this.registration : this.drafts().get(this.draftKey()); }
  drafts() { return this.mode === 'appointment' ? this.scheduleDrafts : this.mode === 'relationships' ? this.relationshipStates : this.states; }
  allDrafts() { return [...this.states.values(), ...this.relationshipStates.values(), ...this.scheduleDrafts.values(), ...(this.registration ? [this.registration] : [])]; }
  hasPendingWrite() { return !!this.invitations?.hasPendingWrite() || !!this.recipient?.hasPendingWrite() || this.allDrafts().some(state => state.operation); }
  form() { return this.host.querySelector(`[data-testid="${this.mode === 'appointment' ? 'operations-appointment-form' : this.mode === 'registration' ? 'operations-registration-form' : this.mode === 'relationships' ? 'operations-relationships-form' : 'operations-form'}"]`); }
  alive(epoch) { return !this.destroyed && this.epoch === epoch && !this.controller.signal.aborted; }
  capture() {
    if (this.mode === 'schedule') {
      const date = this.host.querySelector('[data-ops-date-input]'), child = this.host.querySelector('[data-ops-new-child]');
      if (date) this.dateInput = date.value; if (child) this.newAppointmentChild = child.value;
    }
    const state = this.current(), form = this.form();
    if (!state || !form || state.operation) return;
    if (this.mode === 'relationships') {
      const v = state.values, userId = form.elements.therapist.value;
      const history = form.elements.therapistHistory;
      if (userId !== (v.therapist?.userId ?? '')) history.value = state.latest?.participants.some(p => p.userId === userId && p.role === 'therapist') ? 'preserve' : 'from_now';
      const therapist = userId ? { userId, history: history.value } : null;
      const guardians = [...form.querySelectorAll('input[name="guardian"]')].filter(node => node.checked).map(node => ({
        userId: node.value, history: [...form.querySelectorAll('[data-guardian-history]')].find(select => select.dataset.guardianHistory === node.value).value,
      }));
      const changed = JSON.stringify([v.therapist, v.guardians]) !== JSON.stringify([therapist, guardians]);
      v.therapist = therapist; v.guardians = guardians;
      if (changed) { form.elements.historyConfirmed.checked = false; form.elements.pastHistoryConfirmed.checked = false; }
      v.historyConfirmed = form.elements.historyConfirmed.checked; v.pastHistoryConfirmed = form.elements.pastHistoryConfirmed.checked;
      return;
    }
    for (const key of this.mode === 'appointment' ? scheduleFields : ['name', 'age', 'ageAsOf']) state.values[key] = form.elements[key].value;
  }
  invalidate() {
    this.epoch++; this.controller.abort(); this.controller = new AbortController(); this.pending = null;
  }
  suspend() {
    if (this.destroyed) return;
    // A cancelled first import has no child controller to resume. Return to
    // the child list; its old import must not later mount into this new epoch.
    if (this.mode === 'invitations' && !this.invitations) this.mode = 'profile';
    if (this.mode === 'recipient' && !this.recipient) this.mode = 'profile';
    this.invitations?.suspend();
    this.recipient?.suspend();
    this.capture(); for (const state of this.allDrafts()) state.interrupt();
    this.invalidate(); this.connected = false; this.children = []; this.scheduleRows = []; this.members = []; this.render();
  }
  destroy() {
    this.invitations?.destroy(); this.invitations = null;
    this.recipient?.destroy(); this.recipient = null;
    this.suspend(); this.destroyed = true; this.controller.abort(); this.events?.abort();
    this.states.clear(); this.relationshipStates.clear(); this.scheduleDrafts.clear(); this.registration = null; this.appointmentId = null; this.newAppointmentChild = '';
    this.children = []; this.selected = null; this.mode = 'profile'; this.host.replaceChildren();
  }
  render() {
    const content = this.host.querySelector('[data-ops-content]'); if (!content || this.destroyed) return;
    if (['invitations', 'recipient'].includes(this.mode)) { this.controls(); return; }
    const html = !this.connected ? '<p class="empty">현재 관리 권한과 기본정보를 확인해 주세요.</p>'
      : this.mode === 'overview' ? operationsOverviewMarkup(this.children, this.members, this.scheduleRows, this.summaryDate)
      : this.mode === 'schedule' ? operationsScheduleMarkup(this.children, this.scheduleRows, this.scheduleDate, this.dateInput, this.scheduleDrafts, this.newAppointmentChild)
      : this.current() ? this.mode === 'appointment' ? operationsAppointmentMarkup(this.current()) : this.mode === 'registration' ? registrationMarkup(this.current())
        : this.mode === 'relationships' ? relationshipsMarkup(this.current()) : operationsEditorMarkup(this.current())
        : `${this.invitationsEnabled ? '<button type="button" data-ops-action="invitations">구성원 초대 관리</button>' : ''}${operationsListMarkup(this.children, this.states)}`;
    if (this.painted.get(content) !== html) {
      const active = this.host.ownerDocument?.activeElement;
      const focused = active && content.contains?.(active) ? active.dataset : null;
      const focusKeys = ['opsChild', 'opsRecipient', 'opsDateInput', 'opsNewChild', 'opsAppointment', 'opsResume'];
      const focusKey = focusKeys.find(key => focused && Object.hasOwn(focused, key));
      const focusValue = focused?.[focusKey], focusRoom = focused?.opsRoom;
      content.innerHTML = html; this.painted.set(content, html);
      if (focusKey) [...content.querySelectorAll('[data-ops-child],[data-ops-recipient],[data-ops-date-input],[data-ops-new-child],[data-ops-appointment],[data-ops-resume]')]
        .find(node => Object.hasOwn(node.dataset, focusKey) && node.dataset[focusKey] === focusValue &&
          (focusKey !== 'opsAppointment' || node.dataset.opsRoom === focusRoom))?.focus({ preventScroll: true });
    }
    this.controls();
  }
  controls() {
    const section = ['overview', 'schedule', 'appointment'].includes(this.mode) ? (this.mode === 'appointment' ? 'schedule' : this.mode) : 'children';
    for (const button of this.host.querySelectorAll?.('[data-ops-view]') ?? []) {
      button.disabled = !this.connected;
      if (button.dataset.opsView === section) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
    const form = this.form(), state = this.current();
    const center = this.host.querySelector('[data-ops-center]'); if (center) center.disabled = this.hasPendingWrite();
    if (!form || !state) return;
    for (const input of form.querySelectorAll('input')) input.disabled = !!state.operation || !this.connected;
    for (const select of form.querySelectorAll('select')) select.disabled = !!state.operation || !this.connected;
    if (this.mode === 'relationships') {
      const v = state.values, disabled = !!state.operation || !this.connected;
      form.elements.therapistHistory.disabled = disabled || !v.therapist;
      const preserve = form.elements.therapistHistory.querySelector('[value="preserve"]');
      preserve.disabled = !state.latest?.participants.some(p => p.userId === v.therapist?.userId && p.role === 'therapist');
      for (const select of form.querySelectorAll('[data-guardian-history]')) select.disabled = disabled || !v.guardians.some(p => p.userId === select.dataset.guardianHistory);
      form.querySelector('[data-past-confirm]').hidden = ![v.therapist, ...v.guardians].some(p => p?.history === 'all');
    }
    const submit = form.querySelector('[type="submit"]'); submit.hidden = !!state.operation;
    submit.disabled = !this.connected || state.sending || !!state.operation || state.stale;
    const retry = form.querySelector('[data-ops-action="retry"]'); retry.hidden = !state.operation; retry.disabled = state.sending || !this.connected;
    form.querySelector('[data-ops-action="discard"]').disabled = !!state.operation || state.sending;
    const notice = state.error || (state.uncertain ? uncertain : state.stale ? (this.mode === 'relationships'
      ? '다른 화면에서 담당 관계가 바뀌었어요. 최신 관계와 입력을 비교한 뒤 공개 범위를 다시 확인해 주세요.'
      : this.mode === 'appointment' ? '다른 화면에서 일정이 바뀌었어요. 최신 일정과 입력을 비교한 뒤 다시 저장해 주세요.' : conflict) : '');
    form.querySelector('[data-ops-error]').textContent = notice;
    const comparison = form.querySelector('[data-ops-conflict]'); comparison.hidden = !state.stale || !!state.operation;
    if (!comparison.hidden) {
      const p = state.latest;
      const latest = p && this.mode === 'relationships' ? `<ul data-ops-latest>${relationshipSummary(p, state.members)}</ul><p class="small muted">입력을 유지하면 최신 명단에서 선택하지 않은 치료사·보호자는 해제됩니다. 대상자 본인 계정 연결은 유지됩니다. 대상과 공개 범위를 다시 확인해야 저장할 수 있습니다.</p>`
        : p && this.mode === 'appointment' ? `<p data-ops-latest>${scheduleSummary(p)}</p>`
        : p ? `<p data-ops-latest>${esc(p.name ?? '이름 미등록')} · ${p.age === null ? '연령 미등록' : `${esc(p.age)}세 · ${esc(p.ageAsOf)} 기준`}</p>` : '';
      const html = p ? `<h2>서버의 최신 내용</h2>${latest}
        <p class="small muted">입력을 유지하는 경우에도 최신 내용과 비교하고 저장 버튼을 다시 눌러야 반영됩니다.</p>
        <div class="care-actions"><button type="button" data-ops-action="keep">현재 입력 유지하고 다시 검토</button><button type="button" data-ops-action="replace">최신 내용으로 바꾸기</button></div>`
        : '<p class="muted small">새로고침으로 최신 내용을 먼저 확인해 주세요. 작성한 입력은 유지됩니다.</p>';
      if (this.painted.get(comparison) !== html) { comparison.innerHTML = html; this.painted.set(comparison, html); }
    } else { comparison.replaceChildren(); this.painted.delete(comparison); }
  }
  focus() { this.host.querySelector('[data-ops-title]')?.focus({ preventScroll: true }); }
  async refresh({ focus = false } = {}) {
    if (this.destroyed || this.pending || this.current()?.sending) return;
    this.capture();
    const epoch = this.epoch, signal = this.controller.signal, work = {};
    this.pending = work;
    try {
      const identity = await this.transport.session(signal);
      if (!this.alive(epoch)) return;
      if (identity.userId !== this.user.userId || identity.centers.find(c => c.id === this.centerId)?.role !== 'center')
        throw new LocalApiError('AUTH_REQUIRED', 401);
      if (this.mode === 'invitations') {
        this.connected = true; this.controls(); await this.invitations?.resume(); return;
      }
      if (this.mode === 'recipient') {
        this.connected = true; this.controls(); await this.recipient?.resume(); return;
      }
      const children = await this.api.children(this.centerId, signal);
      const selected = this.selected, mode = this.mode, appointmentId = this.appointmentId;
      if (mode === 'overview' || mode === 'schedule') {
        const date = mode === 'overview' ? profileToday() : this.scheduleDate;
        const page = await this.scheduleApi.list(this.centerId, { dateFrom: date, dateTo: date }, signal);
        const members = mode === 'overview' ? await this.api.members(this.centerId, signal) : [];
        if (!this.alive(epoch) || this.mode !== mode) return;
        this.scheduleRows = page.appointments; this.members = members; this.summaryDate = date;
      } else if (mode === 'appointment' && selected) {
        const profile = await this.api.childProfile(this.centerId, selected, signal), key = scheduleKey(selected, appointmentId);
        const draft = this.scheduleDrafts.get(key);
        if (draft && draft.childId !== profile.childId) throw new LocalApiError('INVALID_RESPONSE');
        // A new unknown creation may not exist yet. Only its exact receipt can
        // resolve that outcome; a preliminary 404 must not erase the command.
        if (!draft || !draft.originNew || draft.revision > 0 || (draft.stale && !draft.operation)) {
          const value = await this.scheduleApi.appointment(this.centerId, selected, appointmentId, signal);
          if (!this.alive(epoch) || this.mode !== mode || this.selected !== selected || this.appointmentId !== appointmentId) return;
          if (value.childId !== profile.childId) throw new LocalApiError('INVALID_RESPONSE');
          if (draft) draft.reconcile(value);
          else this.scheduleDrafts.set(key, new CenterAppointmentDraft({ ...value, appointment: value }));
        }
        if (!this.alive(epoch) || this.mode !== mode || this.selected !== selected || this.appointmentId !== appointmentId) return;
        this.scheduleDrafts.get(key).childName = profile.name;
      } else if (mode === 'relationships' && selected) {
        const members = await this.api.members(this.centerId, signal);
        const data = await this.api.relationships(this.centerId, selected, signal);
        if (!this.alive(epoch) || this.selected !== selected || this.mode !== mode) return;
        const listed = children.find(child => child.conversationId === selected);
        if (listed && listed.childId !== data.childId) throw new LocalApiError('INVALID_RESPONSE');
        const state = this.relationshipStates.get(selected);
        if (state) state.reconcile(data, members); else this.relationshipStates.set(selected, new RelationshipDraft(data, members));
        this.relationshipStates.get(selected).childName = listed?.name ?? null;
      } else if (mode === 'profile' && selected) {
        const profile = await this.api.childProfile(this.centerId, selected, signal);
        if (!this.alive(epoch) || this.selected !== selected || this.mode !== mode) return;
        const state = this.states.get(selected);
        if (state) state.reconcile(profile); else this.states.set(selected, new ChildProfileDraft(profile));
      }
      if (!this.alive(epoch) || this.selected !== selected || this.mode !== mode) return;
      this.children = children; this.connected = true;
      // List pagination is not an atomic permission snapshot: absence never
      // destroys a draft. Opening/saving uses fresh exact-child authorization.
      if (this.form() && this.current() && !this.current().directoryChanged) this.controls();
      else this.render();
      if (this.current()) this.current().directoryChanged = false;
      if (focus) this.focus();
      this.announce(['overview', 'schedule', 'appointment'].includes(mode) ? '센터 일정을 서버에서 확인했어요.' : '센터 기본정보를 서버에서 확인했어요.');
    } catch (error) {
      if (!this.alive(epoch)) return;
      if (denied(error)) { this.destroy(); this.onDenied(error); }
      else { this.suspend(); this.announce(safeError(error)); }
    } finally { if (this.pending === work) this.pending = null; }
  }
  async openInvitations() {
    if (!this.invitationsEnabled || !this.connected || this.destroyed || this.mode === 'invitations' || this.recipient?.hasPendingWrite()) return;
    this.recipient?.destroy(); this.recipient = null;
    this.capture(); this.current()?.interrupt(); this.invalidate(); this.selected = null; this.mode = 'invitations';
    const epoch = this.epoch, content = this.host.querySelector('[data-ops-content]');
    content.innerHTML = '<p class="empty">초대 내역을 확인하고 있어요.</p>'; this.painted.delete(content); this.controls();
    try {
      const { OperationsInvitationsUi } = await import('./operations-invitations.js');
      if (!this.alive(epoch) || this.mode !== 'invitations') return;
      this.invitations = new OperationsInvitationsUi({ host: content, transport: this.transport,
        centerId: this.centerId, userId: this.user.userId, announce: this.announce,
        onDenied: error => { this.destroy(); this.onDenied(error); }, onExit: () => this.back() });
      await this.invitations.mount();
    } catch (error) {
      if (!this.alive(epoch) || this.mode !== 'invitations') return;
      this.back(); this.announce(safeError(error));
    }
  }
  async open(roomId, mode = 'profile') {
    if (!['profile', 'relationships'].includes(mode)) return;
    if (!this.connected || this.recipient?.hasPendingWrite() || !this.children.some(p => p.conversationId === roomId)) return;
    this.recipient?.destroy(); this.recipient = null;
    this.capture(); this.current()?.interrupt(); this.invalidate(); this.selected = roomId; this.mode = mode; this.connected = false; this.render();
    await this.refresh({ focus: true });
  }
  async newChild() {
    if (!this.connected || this.destroyed || this.recipient?.hasPendingWrite()) return;
    this.recipient?.destroy(); this.recipient = null;
    this.capture(); this.current()?.interrupt(); this.invalidate(); this.selected = null; this.mode = 'registration';
    this.registration ??= new ChildRegistrationDraft(); this.connected = false; this.render(); await this.refresh({ focus: true });
  }
  async showSection(section) {
    if (!this.connected || this.invitations?.hasPendingWrite() || this.recipient?.hasPendingWrite() || !['overview', 'children', 'schedule'].includes(section)) return;
    this.recipient?.destroy(); this.recipient = null;
    this.invitations?.destroy(); this.invitations = null;
    this.capture(); this.current()?.interrupt(); this.invalidate(); this.selected = null; this.appointmentId = null;
    this.mode = section === 'children' ? 'profile' : section; this.connected = false; this.render(); await this.refresh({ focus: true });
  }
  async applyDate() {
    this.capture();
    try { contextDate(this.dateInput); } catch { this.announce('일정 날짜를 확인해 주세요.'); return; }
    this.scheduleDate = this.dateInput; await this.showSection('schedule');
  }
  async openAppointment(roomId, id = null) {
    if (!this.connected || this.destroyed || this.recipient?.hasPendingWrite()) return;
    this.recipient?.destroy(); this.recipient = null;
    if (!id) {
      const child = this.children.find(child => child.conversationId === roomId);
      if (!child) { this.announce('일정을 등록할 아이를 선택해 주세요.'); return; }
      const existing = [...this.scheduleDrafts.values()].find(draft => draft.roomId === roomId && draft.originNew);
      id = existing?.id ?? crypto.randomUUID();
      if (!existing) this.scheduleDrafts.set(scheduleKey(roomId, id), new CenterAppointmentDraft({ ...child, id, date: this.scheduleDate }));
    } else if (!this.scheduleDrafts.has(scheduleKey(roomId, id)) && !this.scheduleRows.some(value => value.id === id && value.conversationId === roomId)) return;
    this.capture(); this.current()?.interrupt(); this.invalidate(); this.selected = roomId; this.appointmentId = id;
    this.mode = 'appointment'; this.connected = false; this.render(); await this.refresh({ focus: true });
  }
  back() {
    if (this.invitations?.hasPendingWrite() || this.recipient?.hasPendingWrite()) return;
    this.recipient?.destroy(); this.recipient = null;
    this.invitations?.destroy(); this.invitations = null;
    this.capture(); this.current()?.interrupt(); this.invalidate(); this.selected = null; this.appointmentId = null;
    this.mode = this.mode === 'appointment' ? 'schedule' : 'profile'; this.connected = false; this.render(); void this.refresh({ focus: true });
  }
  discard() {
    const state = this.current(); if (!state || state.operation || state.sending) return;
    if (this.mode === 'registration') this.registration = null; else this.drafts().delete(this.draftKey());
    this.back();
  }
  compare(keepInput) {
    this.capture(); if (this.current()?.compare(keepInput)) { this.render(); this.focus(); }
  }
  async openRecipient(roomId) {
    const child = this.children.find(p => p.conversationId === roomId);
    if (!this.connected || this.destroyed || !child || this.hasPendingWrite()) return;
    this.capture(); this.invalidate(); this.selected = roomId; this.mode = 'recipient';
    const epoch = this.epoch, content = this.host.querySelector('[data-ops-content]');
    content.innerHTML = '<p class="empty">대상자 연결 정보를 확인하고 있어요.</p>'; this.painted.delete(content); this.controls();
    try {
      const { OperationsRecipientUi } = await import('./operations-recipient.js');
      if (!this.alive(epoch) || this.mode !== 'recipient' || this.selected !== roomId) return;
      this.recipient = new OperationsRecipientUi({ host: content, transport: this.transport,
        centerId: this.centerId, userId: this.user.userId, roomId, name: child.name, announce: this.announce,
        onDenied: error => { this.destroy(); this.onDenied(error); }, onExit: () => this.back() });
      await this.recipient.mount();
    } catch (error) {
      if (!this.alive(epoch) || this.mode !== 'recipient') return;
      this.back(); this.announce(safeError(error));
    }
  }
  async save() {
    const state = this.current();
    if (!state || !this.connected || state.sending || this.destroyed) return;
    this.capture();
    let operation;
    try { operation = state.begin(); }
    catch (error) { state.error = safeError(error); this.controls(); return; }
    if (!operation) return;
    // An older poll must not repaint its pre-save version over this receipt.
    this.invalidate(); const epoch = this.epoch, selected = this.selected, mode = this.mode;
    this.controls();
    try {
      if (mode === 'registration') await this.api.childRegister(this.centerId, operation, this.controller.signal);
      else if (mode === 'relationships') await this.api.relationshipsSave(this.centerId, selected, operation, this.controller.signal);
      else if (mode === 'appointment') await this.scheduleApi.save(this.centerId, selected, state.id, operation, this.controller.signal);
      else await this.api.childProfileSave(this.centerId, selected, state.childId, operation, this.controller.signal);
      if (!this.alive(epoch) || this.selected !== selected || this.mode !== mode) return;
      if (mode === 'registration') this.registration = null; else this.drafts().delete(this.draftKey());
      if (mode === 'appointment') { this.scheduleDate = operation.content.date; this.dateInput = this.scheduleDate; this.newAppointmentChild = ''; }
      this.selected = null; this.appointmentId = null; this.mode = mode === 'appointment' ? 'schedule' : 'profile'; this.connected = false; this.render();
      await this.refresh({ focus: true }); if (this.alive(epoch)) this.announce(mode === 'profile' ? '아이 기본정보를 저장했어요. 메시지는 전송하지 않았습니다.'
        : mode === 'registration' ? '등록 요청을 확인했어요. 담당 관계는 별도로 설정해 주세요.'
        : mode === 'appointment' ? '일정 요청을 확인했어요. 목록에서 현재 내용을 확인해 주세요. 알림은 전송하지 않았습니다.' : '관계 변경 요청을 확인했어요. 다시 열어 현재 관계를 확인할 수 있습니다.');
    } catch (error) {
      if (!this.alive(epoch) || this.selected !== selected || this.mode !== mode) return;
      if (denied(error)) { this.destroy(); this.onDenied(error); return; }
      state.failed(operation, error); this.controls();
    }
  }
}
