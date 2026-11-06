// Presentation only: all inputs are authorized server DTOs, never a local DB.
// History bookmarks retain cursors only. Authorization and the coherent
// workspace revision bracket remain responsible for every displayed page.
export function historySelector(direction, window) {
  if (direction === 'latest') return {};
  if (!window) return null;
  if (direction === 'older' && window.hasOlder && window.startCursor > 0) return { before: window.startCursor };
  if (direction === 'newer' && window.hasNewer && window.endCursor > 0) return { after: window.endCursor };
  return null;
}
export function stableHistorySelector(requested, window) {
  // Polling follows recent messages, but anchors a historical window to its
  // inclusive start instead of repeating the navigation or jumping to latest.
  if (!Object.keys(requested).length) return {};
  if (!window?.startCursor && window?.hasOlder) return requested;
  if (!window?.hasNewer) return {};
  return window.startCursor > 0 ? { from: window.startCursor } : requested;
}

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const esc = escapeHtml;
export const roleName = (role) => ({ therapist: '치료사', guardian: '보호자', center: '센터 관리자', care_recipient: '대상자' })[role] ?? '사용자';
export const workspaceMenus = (role) => role === 'care_recipient'
  ? [['home', '홈'], ['chat', '대화'], ['child', '참여 정보']]
  : [['home', '홈'], ['chat', '대화'], ['records', '기록'], ['child', '아이 정보']];
// Small, local icons supplement visible labels; no remote assets or icon font.
export function workspaceIcon(name) {
  const paths = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>',
    chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-4 3 2-6a8 8 0 1 1 17-5Z"/><path d="M7 10h10M7 14h6"/>',
    records: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    child: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    account: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="3"/><path d="M6 19a6 6 0 0 1 12 0"/>',
  };
  return `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] ?? paths.child}</svg>`;
}
export function workspaceNavigationMarkup(role) {
  return workspaceMenus(role).map(([view, label]) => `<button type="button" data-view="${view}" ${view === 'home' ? 'aria-current="page"' : ''}>${workspaceIcon(view)}<span>${label}</span></button>`).join('');
}
export function bindAccountMenu(root) {
  const menu = root.querySelector('.account-menu');
  if (!menu) return;
  menu.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    event.preventDefault(); event.stopPropagation(); menu.open = false;
    menu.querySelector('summary').focus({ preventScroll: true });
  });
  root.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
}
export const PRIMARY_COMMUNICATOR_NOTICE = '주 소통자는 연락의 우선 대상입니다. 개인 대화·동의 완료·기록 열람 권한을 뜻하지 않으며, 일반 소식은 현재 참여자에게 함께 전달됩니다.';
const primaryCommunicatorPerson = (profile) => {
  const primary = profile?.primaryCommunicator;
  if (!primary) return null;
  const person = profile.participants.find(p => p.userId === primary.userId && ['guardian', 'care_recipient'].includes(p.role));
  return person ? `${person.displayName ?? roleName(person.role)} (${roleName(person.role)})` : '미지정';
};
export function primaryCommunicatorMarkup(profile, { compact = false } = {}) {
  const person = primaryCommunicatorPerson(profile);
  if (person === null) return '';
  if (compact) return `<section class="primary-communicator primary-communicator-compact" aria-label="주 소통자">
    <details class="primary-communicator-details"><summary><span><strong>주 소통자</strong> · <span data-primary-person>${esc(person)}</span></span><span class="primary-info-label">안내 <span aria-hidden="true">⌄</span></span></summary>
      <p class="small muted">주 소통자는 연락의 우선 대상입니다. 개인 대화·동의 완료·기록 열람 권한을 뜻하지 않습니다.</p></details>
    <p class="small muted" data-primary-audience>일반 소식은 현재 참여자에게 함께 전달됩니다.</p></section>`;
  return `<section class="primary-communicator" aria-label="주 소통자"><p><strong>주 소통자</strong> · ${esc(person)}</p><p class="small muted">${PRIMARY_COMMUNICATOR_NOTICE}</p></section>`;
}
// The disclosure contains fixed explanatory text. Only the current authorized
// name changes during a poll; never replace its focused summary or persist its
// open state outside the current room DOM. Return whether removal needs focus
// rescue by the caller's still-authorized room heading.
export function reconcilePrimaryCommunicator(host, profile) {
  const person = primaryCommunicatorPerson(profile);
  if (person === null) {
    const removedFocus = host.contains(host.ownerDocument.activeElement);
    if (host.firstChild) host.replaceChildren();
    return removedFocus;
  }
  const label = host.querySelector('[data-primary-person]');
  if (!label) host.innerHTML = primaryCommunicatorMarkup(profile, { compact: true });
  else if (label.textContent !== person) label.textContent = person;
  return false;
}
export const childName = (room) => room?.profile?.name ?? '이름 미등록 아동';
export function localDay(date = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function workspacePeriod(offset = 0, date = new Date()) {
  const [year, month] = localDay(date).split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1 + offset, 1)), end = new Date(Date.UTC(year, month + offset, 0));
  return { dateFrom: start.toISOString().slice(0, 10), dateTo: end.toISOString().slice(0, 10),
    label: `${start.getUTCFullYear()}년 ${start.getUTCMonth() + 1}월` };
}
// Domestic center calendar: the home preview and conversation must show the
// same instant, regardless of the device's timezone. Stored values stay intact.
export const formatWorkspaceTime = (value) => {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  // Keep Korean UI wording stable across OS/ICU locale versions while Intl
  // still performs the real Asia/Seoul timezone conversion.
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', calendar: 'gregory',
    numberingSystem: 'latn', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(value));
  const field = type => parts.find(part => part.type === type)?.value;
  const hour = Number(field('hour'));
  return `${Number(field('month'))}. ${Number(field('day'))}. ${hour < 12 ? '오전' : '오후'} ${String(hour % 12 || 12).padStart(2, '0')}:${field('minute')}`;
};
const empty = (text) => `<p class="empty">${esc(text)}</p>`;
const heading = (title, hint = '') => `<header class="section-head"><h2>${esc(title)}</h2>${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}</header>`;
// A loading projection contains no child, account or message data. Keep the
// surface geometry while permission checks run, never a hidden copy of content.
export function loadingMarkup(surface = 'home', recovery = 'checking') {
  const state = ['unavailable', 'offline', 'rechecking'].includes(recovery) ? recovery : 'checking';
  const headings = { unavailable: '연결을 다시 확인해야 해요', offline: '네트워크 연결을 기다리고 있어요',
    rechecking: '열람 권한을 다시 확인하고 있어요' };
  const compact = surface === 'inbox';
  const recoveryNotice = state !== 'checking' ? `<div class="connection-recovery${compact ? ' connection-recovery-compact' : ''}" data-connection-state="${state}">
    <h2>${headings[state]}</h2>${compact ? '' : '<p>확인이 끝날 때까지 대화와 정보를 잠시 표시하지 않습니다.</p><p class="small" data-input-retention-notice>이 창에 남아 있는 입력은 연결·권한 확인 후 이어 쓸 수 있어요. 페이지를 새로고침하거나 창을 닫으면 사라질 수 있어요.</p>'}
    <div class="connection-recovery-actions"><button type="button" data-action="reconnect" ${state === 'offline' ? 'disabled' : ''}>연결 다시 확인</button>${compact ? '' : `<span class="small muted">${state === 'offline' ? '네트워크 연결 후 자동으로 다시 확인합니다.' : '자동으로도 다시 확인하고 있어요.'}</span>`}</div></div>` : '';
  const rows = surface === 'room' ? 4 : 3;
  // Only fixed wording is rendered. No source or draft is copied into the
  // recovery UI, and a failed/offline state is not an indefinitely busy region.
  return `<div class="loading-surface loading-${['home', 'inbox', 'room', 'records-content', 'child-content'].includes(surface) ? surface : 'home'}" aria-busy="${state === 'checking' || state === 'rechecking'}" aria-label="${headings[state] ?? '화면 불러오는 중'}">
    ${recoveryNotice || '<p class="loading-label">연결을 확인하고 있어요</p>'}<div aria-hidden="true">${Array.from({ length: rows }, () => '<div class="loading-row"><span class="loading-line short"></span><span class="loading-line"></span></div>').join('')}</div></div>`;
}
// Only viewport metadata is retained between authorized renders. These helpers
// do not retain message bodies, nodes, media URLs or input values.
// Menu and attachment controls also carry message IDs. Their geometry is not
// a message boundary, especially while a native details element is closed.
const messageRows = (list) => [...list.querySelectorAll('[data-testid="message-row"][data-message-id]')];
export function scrollMessageTarget(list, messageId, activity = false) {
  if (!list || list.clientHeight <= 0) return false;
  const row = messageRows(list).find((node) => node.dataset.messageId === messageId);
  if (!row) return false;
  // scrollIntoView would also move the outer document and hide the child
  // header. Only the message pane owns this target's scroll position.
  const anchor = (activity ? row.querySelector('.care-activity h3') : null)
    ?? row.querySelector('.bubble') ?? row;
  list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop;
  return true;
}
export function roomParticipantsMarkup(participants, primaryUserId = null) {
  return participants.map((person) => `<li><span>${esc(person.displayName ?? roleName(person.role))}${primaryUserId !== null && person.userId === primaryUserId && ['guardian', 'care_recipient'].includes(person.role) ? ' · 주 소통자' : ''}</span><span class="muted">${esc(roleName(person.role))}</span></li>`).join('');
}
export function captureMessagePosition(list) {
  if (!list || list.clientHeight <= 0) return null;
  const top = list.getBoundingClientRect().top + list.clientTop;
  const anchor = messageRows(list).find((row) => row.getBoundingClientRect().bottom > top);
  return { atEnd: list.scrollHeight - list.scrollTop - list.clientHeight < 48,
    messageId: anchor?.dataset.messageId ?? null,
    offset: anchor ? anchor.getBoundingClientRect().top - top : 0, top: list.scrollTop };
}
export function restoreMessagePosition(list, position) {
  if (!list || list.clientHeight <= 0) return;
  if (!position || position.atEnd) { list.scrollTop = list.scrollHeight; return; }
  const anchor = messageRows(list).find((row) => row.dataset.messageId === position.messageId);
  list.scrollTop = anchor ? list.scrollTop + anchor.getBoundingClientRect().top
    - list.getBoundingClientRect().top - list.clientTop - position.offset : position.top;
}
export function visibleMessageRows(list, viewportBottom, viewportTop = 0) {
  if (!list || list.clientHeight <= 0) return [];
  const bounds = list.getBoundingClientRect();
  const top = Math.max(bounds.top, viewportTop), bottom = Math.min(bounds.bottom, viewportBottom);
  if (bottom <= top) return [];
  return messageRows(list).filter((node) => {
    const rect = node.getBoundingClientRect();
    return rect.top < bottom && rect.bottom > top;
  });
}
export function newsMarkup(rooms, selectedId = null, home = false) {
  return rooms.map((room) => {
    const author = room.profile.participants.find((p) => p.userId === room.latest?.authorId);
    const sender = author?.displayName ?? (author ? roleName(author.role) : room.latest ? '이전 참여자' : '');
    const preview = `<span class="preview">${esc(room.latest?.body ?? '아직 대화가 없어요.')}</span>`;
    const meta = `<span class="news-meta"><span class="news-sender">${esc(sender)}</span><span>${esc(formatWorkspaceTime(room.latest?.createdAt))}</span></span>`;
    const badge = `<span class="badge${room.unread ? '' : ' badge-empty'}"${room.unread ? '' : ' aria-hidden="true"'}>${room.unread ? `새 소식 ${room.unread}` : ''}</span>`;
    return `<button type="button" data-news-room="${esc(room.conversationId)}" class="room-link ${home ? 'home-news-row' : selectedId === room.conversationId ? 'selected' : ''}"
      ${home ? `data-open-room="${esc(room.conversationId)}" data-target-id="${esc(room.targetId)}"` : `data-room-id="${esc(room.conversationId)}"`}
      ${!home && selectedId === room.conversationId ? 'aria-current="true"' : ''}>
      <span class="news-avatar" aria-hidden="true">${esc(Array.from(childName(room).trim())[0] || '·')}</span>
      <span class="room-name"><strong>${esc(childName(room))}</strong>${home ? `${badge}<span class="room-cta" aria-hidden="true">→</span>` : ''}</span>
      ${home ? `${meta}${preview}` : `${preview}<span class="news-footer">${meta}${badge}</span>`}</button>`;
  }).join('') || empty('연결된 아동이 없습니다.');
}
export const orderedNews = (rooms) => [...rooms].sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0));
// Current authorized data replaces content immediately. Only the order of
// existing IDs can be held; no old DTO, preview or target is cached here.
export function reconcileNewsList(host, rooms, { selectedId = null, home = false, preserveOrder = false } = {}) {
  const document = host.ownerDocument, template = document.createElement('template');
  template.innerHTML = newsMarkup(rooms, selectedId, home);
  const desired = [...template.content.children].filter((node) => node.matches('button[data-news-room]'));
  const allowed = new Set(desired.map((node) => node.dataset.newsRoom));
  const existing = new Map();
  for (const node of [...host.children]) {
    if (node.matches('button[data-news-room]') && allowed.has(node.dataset.newsRoom) && !existing.has(node.dataset.newsRoom)) {
      existing.set(node.dataset.newsRoom, node);
    } else {
      if (node.contains(document.activeElement)) host.focus({ preventScroll: true });
      node.remove();
    }
  }
  if (!desired.length) { host.replaceChildren(template.content); return false; }
  const ordered = desired.map((next) => {
    const current = existing.get(next.dataset.newsRoom);
    if (!current) { host.append(next); return next; }
    for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of next.attributes) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
    return current;
  });
  if (!preserveOrder) {
    let cursor = host.firstElementChild;
    for (const node of ordered) {
      if (node !== cursor) host.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
    }
  }
  return [...host.children].some((node, index) => node !== ordered[index]);
}

// Press/release can straddle a permission reset, renamed row or new home target.
// Cancel that one activation instead of letting it select a replacement row.
// Store only IDs/geometry/generation, never DOM nodes or preview text.
export function bindNewsActivation(root, getGeneration, onChanged) {
  let pressed = null;
  const buttonFor = (target) => {
    const button = target?.closest?.('button[data-news-room]');
    return button && root.contains(button) ? button : null;
  };
  const capture = (button, kind) => {
    if (!button) return null;
    const { top, left, width, height } = button.getBoundingClientRect();
    return { kind, roomId: button.dataset.newsRoom, targetId: button.dataset.targetId ?? null,
      generation: getGeneration(), top, left, width, height };
  };
  root.addEventListener('pointerdown', (event) => { pressed = event.button === 0 ? capture(buttonFor(event.target), 'pointer') : null; }, true);
  root.addEventListener('pointercancel', () => { if (pressed?.kind === 'pointer') pressed.cancelled = true; }, true);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      // Key repeat must not replace the original press snapshot with content
      // that appeared while Space was held, or emit repeated Enter activations.
      if (event.repeat) { if (buttonFor(event.target)) event.preventDefault(); return; }
      pressed = capture(buttonFor(event.target), 'keyboard');
    } else if ((event.key === 'Escape' || event.key === 'Tab') && pressed) pressed.cancelled = true;
  }, true);
  root.addEventListener('click', (event) => {
    const initial = pressed; pressed = null;
    if (!initial || (event.detail === 0 ? initial.kind !== 'keyboard' : initial.kind !== 'pointer')) return;
    const button = buttonFor(event.target), bounds = button?.getBoundingClientRect();
    if (!initial.cancelled && button && initial.roomId === button.dataset.newsRoom && initial.targetId === (button.dataset.targetId ?? null)
      && initial.generation === getGeneration() && ['top', 'left', 'width', 'height'].every((key) => Math.abs(initial[key] - bounds[key]) < 1)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    onChanged();
  }, true);
}
const appointmentStatus = { scheduled: '예정', attended: '완료', cancelled: '취소', absent: '미참석' };
export function appointmentMarkup(room, appointment, role) {
  const existing = room.care.records.find((record) => record.appointmentId === appointment.id);
  return `<article class="schedule-row" data-appointment-id="${esc(appointment.id)}"><div><p class="small muted">${esc(appointment.date)} · ${esc(appointment.time ?? '')} · ${esc(appointment.duration ?? '')}분 · ${esc(appointmentStatus[appointment.status] ?? appointment.status)}</p>
    <h3>${esc(appointment.title || '일정')}</h3><p class="small">${esc(childName(room))}${appointment.room ? ` · ${esc(appointment.room)}` : ''}</p></div>
    ${role === 'therapist' ? `<div class="actions"><button type="button" data-appointment-edit="${esc(appointment.id)}" data-context-room="${esc(room.conversationId)}">일정 수정</button><button type="button" data-appointment-record="${esc(appointment.id)}" data-context-room="${esc(room.conversationId)}">${existing ? '기록 이어보기' : '기록하기'}</button></div>` : `<button type="button" data-open-room="${esc(room.conversationId)}">대화하기</button>`}</article>`;
}
// Read only current, visible public snapshots. Clinical record activities are
// never a fallback, including for therapists who can read their original record.
function activityEntries(room) {
  return room.care.publications.filter((message) => message.type === 'publication' &&
    message.conversationId === room.conversationId && message.publication?.activity &&
    !message.hidden && !message.deleted && !message.archived).map((message) => ({ room, message }));
}
function activityLinks(entries, role, showChild = false) {
  return entries.map(({ room, message }) => `<button type="button" class="list-link" data-activity-link data-open-room="${esc(room.conversationId)}" data-target-id="${esc(message.id)}"><strong>${esc(message.publication.activity.title)}</strong><span class="small muted">${showChild ? `${esc(childName(room))} · ` : ''}${esc(message.publication.activity.frequency)}</span><span class="small">${role === 'guardian' ? '활동을 확인하고 경험 남기기' : '활동 안내와 소식 보기'} →</span></button>`).join('') || empty('현재 공유된 가정 활동이 없습니다.');
}
export function homeMarkup(rooms, role, period, day = localDay()) {
  const news = orderedNews(rooms);
  if (role === 'care_recipient') return `<header class="page-heading home-heading"><div><p class="eyebrow">내 계정으로 함께하는 대화</p><h1 data-page-title tabindex="-1">내 소식을 나눠요</h1></div><button type="button" class="primary" data-start-chat>소식 보내기</button></header>
    <section class="surface-card"><p class="muted small">연결 이후의 일반 텍스트 대화만 표시합니다. 목표나 운동 소감·질문을 글로 전할 수 있어요. 치료 기록·가정 활동·사진·영상은 이 계정에 공개하지 않습니다.</p><div class="news-heading">${heading('연결된 대화')}<button type="button" data-news-sort="home">새 소식순 정렬</button></div><div data-home-news tabindex="-1" aria-label="연결된 대화 목록">${newsMarkup(news, null, true)}</div></section>`;
  const upcoming = rooms.flatMap((room) => room.care.appointments
    .filter((a) => a.date >= day && a.status === 'scheduled').map((appointment) => ({ room, appointment })))
    .sort((a, b) => `${a.appointment.date} ${a.appointment.time}`.localeCompare(`${b.appointment.date} ${b.appointment.time}`));
  const drafts = role === 'therapist' ? rooms.flatMap((room) => room.care.records.filter((r) => r.status === 'draft').map((record) => ({ room, record }))) : [];
  const activities = role === 'guardian' ? rooms.flatMap(activityEntries) : [];
  return `<header class="page-heading home-heading"><div><p class="eyebrow">함께 이어가는 아이의 하루</p><h1 data-page-title tabindex="-1">새 소식부터 확인해요</h1></div><button type="button" class="primary" data-start-chat>${role === 'guardian' ? '소식 보내기' : '대화 시작'}</button></header>
    <div class="home-layout"><section class="surface-card home-news-card"><div class="news-heading">${heading('아이의 소식')}<button type="button" data-news-sort="home">새 소식순 정렬</button></div><div data-home-news tabindex="-1" aria-label="아이의 소식 목록">${newsMarkup(news, null, true)}</div></section>
    <div class="home-columns"><section class="surface-card" data-home-panel="schedule"><div class="period-head">${heading('다가오는 일정', period.label)}<button type="button" data-open-schedule ${rooms.length ? '' : 'disabled'}>전체 일정</button></div>
      ${upcoming.map(({ room, appointment }) => appointmentMarkup(room, appointment, role)).join('') || empty('조회 기간에 남은 예정 일정이 없습니다.')}</section>
    <section class="surface-card" data-home-panel="work">${heading(role === 'therapist' ? '작성 중인 기록' : '함께 해볼 가정 활동')}
      ${role === 'therapist' ? drafts.map(({ room, record }) => `<button type="button" class="list-link" data-open-record="${esc(record.id)}" data-context-room="${esc(room.conversationId)}"><strong>${esc(record.title || '제목 없는 기록')}</strong><span class="small muted">${esc(childName(room))} · ${esc(record.date)} · 임시저장</span></button>`).join('') || empty('서버에 임시저장한 기록이 없습니다.')
    : activityLinks(activities, role, true)}</section></div></div>`;
}
export function guardianRecordsMarkup(room) {
  return `<p class="muted small">치료사가 공유한 내용만 표시합니다. 전체 임상 기록은 공개되지 않아요.</p>${room.care.publications.map((m) => `<article class="shared-record" data-shared-message="${esc(m.id)}"><p class="small muted">${esc(m.publication.date)}</p><h3>${esc(m.publication.title)}</h3><p>${esc(m.publication.summary)}</p>
    <button type="button" data-open-room="${esc(room.conversationId)}" data-target-id="${esc(m.id)}">대화에서 보기${m.publication.activity ? ' · 활동 경험 남기기' : ''}</button></article>`).join('') || empty('현재 열람 가능한 공유 기록이 없습니다.')}`;
}
export function childMarkup(room, role, period) {
  if (!room) return empty('아이를 선택해 주세요.');
  const p = room.profile;
  if (role === 'care_recipient') return `<section class="surface-card">${heading(childName(room))}<p class="muted small">본인 계정에 연결된 대화입니다. 보호자의 계정·권한을 대신하지 않습니다.</p><ul class="participant-list">${roomParticipantsMarkup(p.participants, p.primaryCommunicator?.userId)}</ul>${primaryCommunicatorMarkup(p)}<button type="button" data-open-room="${esc(room.conversationId)}">대화로 이동</button></section>`;
  const age = p.age == null ? '미등록' : `${p.age}세${p.ageAsOf ? ` · ${p.ageAsOf} 기준` : ''}`;
  return `<section class="surface-card">${heading(childName(room))}<dl class="child-summary"><div><dt>연령</dt><dd>${esc(age)}</dd></div><div><dt>가족이 바라는 변화</dt><dd data-family-plan-concern>${esc(p.familyPlan?.concern || '아직 등록되지 않았어요.')}</dd></div></dl>
    ${role === 'guardian' ? '<button type="button" data-family-plan>가족 관심사 작성·수정</button><p class="small muted">연결된 보호자들이 함께 작성하며, 현재 담당 치료사와 보호자가 볼 수 있어요.</p>' : ''}
    <div class="participant-list">${p.participants.map((member) => `<span>${esc(member.displayName ?? roleName(member.role))} · ${esc(roleName(member.role))}${member.userId === p.primaryCommunicator?.userId ? ' · 주 소통자' : ''}</span>`).join('')}</div>${primaryCommunicatorMarkup(p)}
    <button type="button" data-open-room="${esc(room.conversationId)}">이 아이의 대화로</button></section>
    ${['guardian', 'therapist'].includes(role) ? `<section class="surface-card" data-testid="child-activities">${heading('공유 중인 가정 활동', '활동을 선택하면 대화에서 전체 안내와 주의사항을 확인할 수 있어요.')}${activityLinks(activityEntries(room), role)}</section>` : ''}
    <section class="surface-card" data-testid="child-goals">${heading('함께 확인할 목표')}${role === 'therapist' ? '<button type="button" data-goal-new>목표 추가</button>' : ''}${room.care.goals.map((goal) => `<article class="goal-row" data-goal-id="${esc(goal.id)}"><h3>${esc(goal.title)}</h3>${goal.description ? `<p>${esc(goal.description)}</p>` : ''}<p class="small muted">${goal.status === 'active' ? '진행 중' : goal.status === 'achieved' ? '달성' : '잠시 보류'}</p>${role === 'therapist' ? `<button type="button" data-goal-edit="${esc(goal.id)}">목표 수정</button>` : ''}</article>`).join('') || empty('등록된 목표가 없습니다.')}</section>
    <section class="surface-card" data-testid="child-appointments"><div class="period-head"><header class="section-head"><h2 data-schedule-heading tabindex="-1">${esc(childName(room))}의 일정</h2><p class="muted small">${esc(period.label)}</p></header><div class="actions">${role === 'therapist' ? '<button type="button" data-appointment-new>일정 추가</button>' : ''}<button type="button" data-month-shift="-1" aria-label="이전 달 일정">이전 달</button><button type="button" data-month-shift="1" aria-label="다음 달 일정">다음 달</button></div></div>
    ${room.care.appointments.map((a) => appointmentMarkup(room, a, role)).join('') || empty('이번 조회 기간의 일정이 없습니다.')}<p class="small muted">기본정보는 센터 전용 화면에서 관리합니다. 다른 달로 옮긴 일정은 해당 월에서 확인해 주세요.</p></section>`;
}
