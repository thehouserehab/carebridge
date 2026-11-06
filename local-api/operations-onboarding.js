import { LocalApiError } from './client.js';
import { relationshipFields } from './operations-client.js';
import { escapeHtml as esc } from './workspace-ui.js';
import { childProfileFields, childProfileFormValues, profileToday } from '../src/profile-fields.js';

const uncertain = '처리 결과를 확인하지 못했어요. 최초 입력과 요청 번호 그대로 다시 확인해 주세요.';
const rejected = new Set(['CHILD_EXISTS', 'RELATIONSHIP_CONFLICT', 'PARTICIPANT_UNAVAILABLE',
  'HISTORY_CONFIRMATION_REQUIRED', 'HISTORY_CHOICE_REQUIRED', 'PAST_HISTORY_CONFIRMATION_REQUIRED',
  'SEQUENCE_LIMIT', 'REVISION_LIMIT', 'SCHEDULE_CONFLICT', 'APPOINTMENT_CONFLICT', 'THERAPIST_UNAVAILABLE']);
const selection = data => ({
  therapist: data.participants.find(p => p.role === 'therapist')
    ? { userId: data.participants.find(p => p.role === 'therapist').userId, history: 'preserve' } : null,
  guardians: data.participants.filter(p => p.role === 'guardian').map(p => ({ userId: p.userId, history: 'preserve' })),
  historyConfirmed: false, pastHistoryConfirmed: false,
});

export class OperationDraft {
  constructor() { this.operation = null; this.sending = false; this.uncertain = false; this.stale = false; this.error = ''; }
  failed(operation, error) {
    if (this.operation !== operation) return;
    this.sending = false;
    const definitive = error instanceof LocalApiError &&
      ((error.code === 'INVALID_INPUT' && [0, 400, 413].includes(error.status)) || (rejected.has(error.code) && [0, 400, 409].includes(error.status)));
    if (!this.uncertain && definitive) {
      this.operation = null; this.error = error.message;
      if (['RELATIONSHIP_CONFLICT', 'APPOINTMENT_CONFLICT'].includes(error.code)) { this.stale = true; this.latest = null; }
    } else { this.uncertain = true; this.error = uncertain; }
  }
  interrupt() { if (this.operation) { this.sending = false; this.uncertain = true; this.error = uncertain; } }
}

export class ChildRegistrationDraft extends OperationDraft {
  constructor() { super(); this.kind = 'registration'; this.values = { name: '', age: '', ageAsOf: '' }; }
  begin(createId = () => crypto.randomUUID()) {
    if (this.sending) return null;
    if (!this.operation) {
      const content = childProfileFields(childProfileFormValues(this.values), { today: profileToday() });
      this.operation = Object.freeze({ clientId: createId(), childId: createId(), conversationId: createId(), content: Object.freeze(content) });
    }
    this.sending = true; this.error = ''; return this.operation;
  }
}

export class RelationshipDraft extends OperationDraft {
  constructor(data, members) {
    super(); this.kind = 'relationships'; this.roomId = data.conversationId; this.childId = data.childId;
    this.revision = data.version; this.latest = data; this.members = members; this.values = selection(data);
  }
  reconcile(data, members) {
    if (data.conversationId !== this.roomId || data.childId !== this.childId) throw new LocalApiError('INVALID_RESPONSE');
    this.directoryChanged = JSON.stringify(this.members) !== JSON.stringify(members);
    if (this.directoryChanged && !this.operation) {
      this.values.historyConfirmed = false; this.values.pastHistoryConfirmed = false;
      this.error = '구성원 목록이 바뀌었어요. 연결 대상과 공개 범위를 다시 확인해 주세요.';
    }
    this.latest = data; this.members = members;
    if (data.version !== this.revision) this.stale = true;
  }
  begin(createId = () => crypto.randomUUID()) {
    if (this.sending) return null;
    if (!this.operation) {
      if (this.stale) throw new LocalApiError('RELATIONSHIP_CONFLICT', 409);
      const content = relationshipFields(this.values);
      if (content.therapist) Object.freeze(content.therapist);
      content.guardians.forEach(Object.freeze); Object.freeze(content.guardians);
      this.operation = Object.freeze({ clientId: createId(), expectedVersion: this.revision, ...content });
    }
    this.sending = true; this.error = ''; return this.operation;
  }
  compare(keepInput) {
    if (this.operation || !this.stale || !this.latest) return false;
    if (!keepInput) this.values = selection(this.latest);
    else {
      // A formerly active relation may now be disconnected. Keeping the user's
      // selection must not turn stale 'preserve' into a historical grant.
      for (const p of [this.values.therapist, ...this.values.guardians].filter(Boolean)) {
        const role = p === this.values.therapist ? 'therapist' : 'guardian';
        if (p.history === 'preserve' && !this.latest.participants.some(now => now.userId === p.userId && now.role === role)) p.history = 'from_now';
      }
      this.values.historyConfirmed = false; this.values.pastHistoryConfirmed = false;
    }
    this.revision = this.latest.version; this.stale = false; this.error = ''; return true;
  }
}

const submit = title => `<p class="care-error" data-ops-error role="status"></p><section data-ops-conflict hidden></section>
  <div class="care-actions care-submit"><button class="primary" type="submit">${title}</button>
  <button type="button" data-ops-action="retry" hidden>같은 요청으로 확인</button>
  <button type="button" data-ops-action="discard">입력 취소</button></div>
  <p class="muted small">미저장 입력은 이 창의 메모리에만 보관합니다. 새로고침·센터 전환·로그아웃 시 사라집니다.</p>`;
const back = '<button type="button" data-ops-action="back">아이 목록으로</button>';
export function registrationMarkup(draft) {
  const v = draft.values;
  return `${back}<header class="page-heading"><h1 tabindex="-1" data-ops-title>아이 등록</h1>
    <p class="muted small">기본정보만 등록합니다. 담당 치료사·보호자는 등록 후 별도로 연결하며 계정·메시지는 만들지 않습니다.</p></header>
    <section class="surface-card"><form data-testid="operations-registration-form" autocomplete="off"><div class="care-fields">
    <label>이름<input name="name" value="${esc(v.name)}" required maxlength="30" autocomplete="off"></label>
    <div class="care-grid"><label>연령<input name="age" value="${esc(v.age)}" type="number" min="0" max="26" step="1" inputmode="numeric"></label>
    <label>연령 기준일<input name="ageAsOf" value="${esc(v.ageAsOf)}" type="date" min="1900-01-01" max="${esc(profileToday())}"></label></div>
    <p class="muted small">연령과 기준일은 함께 입력하거나 모두 비워 주세요. 생년월일·연령을 추정하지 않습니다.</p></div>${submit('아이 등록')}</form></section>`;
}
const roleLabel = role => ({ therapist: '치료사', guardian: '보호자', care_recipient: '대상자' })[role] ?? '구성원';
const label = (p, members) => {
  const m = members.find(m => m.userId === p.userId && m.role === p.role);
  return `${m?.displayName ?? '이름 미등록'} · ${p.userId}${m ? '' : ' · 현재 선택 불가'}`;
};
export function relationshipPeople(draft, role) {
  const chosen = role === 'therapist' ? [draft.values.therapist].filter(Boolean) : draft.values.guardians;
  const rows = new Map(draft.members.filter(m => m.role === role).map(m => [m.userId, m]));
  for (const p of [...(draft.latest?.participants ?? []).filter(p => p.role === role), ...chosen])
    if (!rows.has(p.userId)) rows.set(p.userId, { userId: p.userId, role, displayName: null });
  return [...rows.values()];
}
const historyOptions = (value, preserve, role = 'guardian') => [
  ['preserve', '현재 열람 범위 유지'], ['from_now', role === 'therapist' ? '이번 연결 이후 소식·치료 기록만' : '이번 연결 이후 소식만'],
  ['all', role === 'therapist' ? '이전 소식·치료 기록 전체 공개' : '이전 소식 전체 공개'],
].map(([key, text]) => `<option value="${key}" ${key === value ? 'selected' : ''} ${key === 'preserve' && !preserve ? 'disabled' : ''}>${text}</option>`).join('');
const active = (draft, userId, role) => draft.latest?.participants.some(p => p.userId === userId && p.role === role);
export function relationshipSummary(data, members) {
  return data.participants.map(p => `<li>${esc(roleLabel(p.role))} · ${esc(label(p, members))} · ${p.firstSequence === 1 ? (p.role === 'therapist' ? '이전 소식·치료 기록 전체 열람' : '이전 소식 전체 열람') : '설정된 연결 시점 이후 열람'}</li>`).join('') || '<li>연결된 사람이 없습니다.</li>';
}
export function relationshipsMarkup(draft) {
  const v = draft.values, therapistId = v.therapist?.userId ?? '';
  return `${back}<header class="page-heading"><h1 tabindex="-1" data-ops-title>담당 관계 설정</h1>
    <p class="ops-child-context" data-ops-child-context>대상 아동 · ${esc(draft.childName ?? '이름 미등록')}<br><span class="small muted">등록 식별값 · ${esc(draft.childId)}</span></p>
    <p class="muted small">센터의 기존 활성 구성원을 연결합니다. 계정·초대 메일은 생성하지 않습니다. 표시 이름은 본인 설정 정보이므로 식별값과 연결 대상을 확인해 주세요.</p></header>
    <section class="surface-card"><form data-testid="operations-relationships-form" autocomplete="off"><div class="care-fields">
    <label>담당 치료사<select name="therapist"><option value="">연결 안 함</option>${relationshipPeople(draft, 'therapist').map(p => `<option value="${esc(p.userId)}" ${p.userId === therapistId ? 'selected' : ''}>${esc(label(p, draft.members))}</option>`).join('')}</select></label>
    <label>치료사 과거 소식·기록 공개 범위<select name="therapistHistory">${historyOptions(v.therapist?.history ?? 'from_now', active(draft, therapistId, 'therapist'), 'therapist')}</select></label>
    <p class="muted small" data-therapist-history-notice>치료사에게는 이 범위의 치료 기록과 비공개 메모·참고·첨부도 열람 대상에 포함됩니다. 보호자는 공유된 소식·자료만 볼 수 있습니다.</p>
    <fieldset class="ops-people"><legend>연결할 보호자</legend>${relationshipPeople(draft, 'guardian').map(p => {
      const chosen = v.guardians.find(g => g.userId === p.userId);
      return `<div class="ops-person"><label class="ops-check"><input type="checkbox" name="guardian" value="${esc(p.userId)}" ${chosen ? 'checked' : ''}><span>${esc(label(p, draft.members))}</span></label>
      <label>이 보호자의 과거 대화 공개 범위<select data-guardian-history="${esc(p.userId)}">${historyOptions(chosen?.history ?? (active(draft, p.userId, 'guardian') ? 'preserve' : 'from_now'), active(draft, p.userId, 'guardian'))}</select></label></div>`;
    }).join('') || '<p class="empty">선택 가능한 보호자가 없습니다.</p>'}</fieldset>
    <p class="muted small">신규·재연결은 기본적으로 이번 연결 이후 자료만 공개합니다. 선택에서 뺀 치료사·보호자는 연결 해제됩니다. 기존 기록과 별도 대상자 본인 계정 연결은 유지됩니다.</p>
    <label class="ops-check"><input type="checkbox" name="historyConfirmed" ${v.historyConfirmed ? 'checked' : ''}><span>연결·해제할 사람과 각 소식·기록 공개 범위를 확인했습니다.</span></label>
    <label class="ops-check" data-past-confirm><input type="checkbox" name="pastHistoryConfirmed" ${v.pastHistoryConfirmed ? 'checked' : ''}><span>이전 전체 공개를 선택하면 치료사는 과거 소식·치료 기록(비공개 메모·참고·첨부 포함)을, 보호자는 과거 공유 소식·자료를 열람할 수 있음을 확인했습니다.</span></label>
    </div>${submit('관계 저장')}</form></section>`;
}
