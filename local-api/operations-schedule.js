import { LocalApiError } from './client.js';
import { OperationDraft } from './operations-onboarding.js';
import { appointmentFields, contextDate } from '../src/context-fields.js';
import { escapeHtml as esc } from './workspace-ui.js';

export const scheduleStatus = Object.freeze({ scheduled: '예정', attended: '완료', absent: '미참석', cancelled: '취소' });
export const scheduleFields = ['date', 'time', 'duration', 'title', 'room', 'status'];
const valuesOf = value => Object.fromEntries(scheduleFields.map(key => [key, String(value[key])]));
export const scheduleKey = (roomId, id) => `${roomId}/${id}`;

export class CenterAppointmentDraft extends OperationDraft {
  constructor({ childId, conversationId, id, date, appointment = null }) {
    super(); this.kind = 'appointment'; this.childId = childId; this.roomId = conversationId; this.id = id;
    this.originNew = !appointment; this.revision = appointment?.revision ?? 0; this.latest = appointment;
    this.values = appointment ? valuesOf(appointment) : { date: contextDate(date), time: '', duration: '', title: '', room: '', status: 'scheduled' };
  }
  reconcile(value) {
    if (value.id !== this.id || value.conversationId !== this.roomId || value.childId !== this.childId) throw new LocalApiError('INVALID_RESPONSE');
    this.latest = value; if (value.revision !== this.revision) this.stale = true;
  }
  begin(createId = () => crypto.randomUUID()) {
    if (this.sending) return null;
    if (!this.operation) {
      if (this.stale) throw new LocalApiError('APPOINTMENT_CONFLICT', 409);
      let content;
      try { content = appointmentFields(this.values); } catch { throw new LocalApiError('INVALID_INPUT'); }
      this.operation = Object.freeze({ clientId: createId(), expectedRevision: this.revision, content: Object.freeze(content) });
    }
    this.sending = true; this.error = ''; return this.operation;
  }
  compare(keepInput) {
    if (this.operation || !this.stale || !this.latest) return false;
    this.revision = this.latest.revision;
    if (!keepInput) this.values = valuesOf(this.latest);
    this.stale = false; this.error = ''; return true;
  }
}

const childName = (children, roomId) => children.find(child => child.conversationId === roomId)?.name ?? '이름 미등록 아동';
export function scheduleSummary(value) {
  return `${esc(value.date)} ${esc(value.time)} · ${esc(value.duration)}분 · ${esc(value.title)} · ${esc(value.room)} · ${esc(scheduleStatus[value.status])}`;
}
export function operationsOverviewMarkup(children, members, appointments, date) {
  const count = role => members.filter(member => member.role === role).length;
  return `<header class="page-heading"><h1 tabindex="-1" data-ops-title>오늘의 센터</h1><p class="muted" data-ops-summary-date>${esc(date)}</p></header>
    <section class="surface-card" data-testid="operations-overview"><h2>운영 현황</h2><dl class="ops-metrics">
    <div><dt>등록 아동</dt><dd data-ops-count="children">${children.length}</dd></div>
    <div><dt>활성 치료사</dt><dd data-ops-count="therapists">${count('therapist')}</dd></div>
    <div><dt>활성 보호자</dt><dd data-ops-count="guardians">${count('guardian')}</dd></div></dl>
    <h2>오늘의 일정</h2><dl class="ops-metrics">${Object.entries(scheduleStatus).map(([key, title]) => `<div><dt>${title}</dt><dd data-ops-status-count="${key}">${appointments.filter(row => row.status === key).length}</dd></div>`).join('')}</dl>
    <button type="button" data-ops-action="today-schedule">오늘 일정 보기</button>
    <p class="muted small">서울 기준 오늘의 일정 상태입니다. 각 목록 조회 시점의 현황이며 조회 사이에 변경될 수 있습니다. 활성 구성원 수는 로그인 계정 발급 수와 다릅니다. 임상 원문·기록 건수·읽음은 조회하지 않습니다.</p></section>`;
}
export function operationsScheduleMarkup(children, appointments, date, dateInput, drafts = new Map(), selectedChild = '') {
  return `<header class="page-heading"><h1 tabindex="-1" data-ops-title>센터 일정</h1><p class="muted small">일정을 저장하면 연결된 치료사·보호자도 현재 일정을 확인합니다. 문자·카카오톡 알림은 전송하지 않습니다.</p></header>
    <section data-testid="operations-schedule"><form data-ops-date-form class="ops-date"><label>일정 날짜<input data-ops-date-input name="scheduleDate" type="date" value="${esc(dateInput)}" required min="0001-01-01" max="9999-12-31"></label><button type="submit">날짜 적용</button></form>
    <section class="surface-card"><h2>일정 추가</h2><label>대상 아동<select data-ops-new-child><option value="">아이를 선택해 주세요</option>${children.map(child => `<option value="${esc(child.conversationId)}" ${child.conversationId === selectedChild ? 'selected' : ''}>${esc(child.name ?? '이름 미등록')} · ${esc(child.childId)}</option>`).join('')}</select></label>
    <button type="button" data-ops-action="new-appointment" ${children.length ? '' : 'disabled'}>일정 추가·작성 이어보기</button></section>
    ${drafts.size ? `<section class="surface-card" data-testid="operations-schedule-drafts"><h2>이어 쓸 일정</h2>${[...drafts].map(([key, draft]) => `<button type="button" class="list-link" data-ops-resume="${esc(key)}"><strong>${esc(childName(children, draft.roomId))}</strong><span>${esc(draft.values.date)} · ${draft.operation ? '처리 결과 확인 필요' : '미저장 입력'}</span></button>`).join('')}</section>` : ''}
    <section class="surface-card"><h2>${esc(date)} 일정</h2>${appointments.map(value => `<article class="ops-schedule-row"><div><strong>${esc(childName(children, value.conversationId))}</strong><p>${scheduleSummary(value)}</p><p class="muted small">${value.therapistId ? `현재 담당 치료사 · ${esc(value.therapistId)}` : '활성 담당 치료사 없음'}</p></div><button type="button" data-ops-appointment="${esc(value.id)}" data-ops-room="${esc(value.conversationId)}">일정 수정</button></article>`).join('') || '<p class="empty">이 날짜에 등록된 일정이 없습니다.</p>'}</section></section>`;
}
export function operationsAppointmentMarkup(draft) {
  const v = draft.values, input = (key, text, attrs) => `<label>${text}<input name="${key}" value="${esc(v[key])}" ${attrs}></label>`;
  return `<button type="button" data-ops-action="back">일정 목록으로</button><header class="page-heading"><h1 tabindex="-1" data-ops-title>${draft.originNew ? '일정 추가' : '일정 수정'}</h1>
    <p class="ops-child-context">대상 아동 · ${esc(draft.childName ?? '이름 미등록')}<br><span class="small muted">등록 식별값 · ${esc(draft.childId)}</span></p></header>
    <section class="surface-card"><form data-testid="operations-appointment-form" autocomplete="off"><div class="care-fields"><div class="care-grid">
    ${input('date', '날짜', 'type="date" required min="0001-01-01" max="9999-12-31"')}${input('time', '시작 시각', 'type="time" required')}
    ${input('duration', '진행 시간(분)', 'type="number" min="10" max="180" step="1" inputmode="numeric" required')}
    ${input('title', '일정 이름', 'maxlength="100" required')}${input('room', '장소', 'maxlength="60" required')}
    <label>상태<select name="status">${Object.entries(scheduleStatus).map(([key, text]) => `<option value="${key}" ${v.status === key ? 'selected' : ''}>${text}</option>`).join('')}</select></label></div>
    <p class="muted small">현재 담당 관계를 기준으로 아동·치료사·장소의 시간 중복을 확인합니다. 과거 치료 기록의 당시 일정은 바꾸지 않으며 소식을 자동 발신하지 않습니다.</p></div>
    <p class="care-error" data-ops-error role="status"></p><section data-ops-conflict hidden></section>
    <div class="care-actions care-submit"><button type="submit" class="primary">일정 저장</button><button type="button" data-ops-action="retry" hidden>같은 요청으로 확인</button><button type="button" data-ops-action="discard">입력 취소</button></div>
    <p class="muted small">미저장 입력은 이 창의 메모리에만 보관합니다. 새로고침·센터 전환·로그아웃 시 사라집니다.</p></form></section>`;
}
