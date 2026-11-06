import { LocalApiError, MessageDrafts, isRejectedMessageSend } from './client.js';
import { CareApiClient } from './care-client.js';
import { CareUi, renderCareMessage } from './care-ui.js';
import { MediaApiClient } from './media-client.js';
import { MediaUploadUi } from './media-ui.js';
import { MediaViewer } from './media-viewer.js';
import { ApprovalPendingUi, assignedCenters } from './approval-pending-ui.js';
import { CareRecipientApiClient, recipientTextMessage } from './care-recipient-client.js';
import { escapeHtml as escape, roleName, childName, workspacePeriod, formatWorkspaceTime, orderedNews, homeMarkup, childMarkup, guardianRecordsMarkup,
  loadingMarkup, historySelector, stableHistorySelector, captureMessagePosition, restoreMessagePosition, visibleMessageRows,
  scrollMessageTarget, roomParticipantsMarkup, reconcileNewsList, bindNewsActivation, workspaceMenus, reconcilePrimaryCommunicator,
  workspaceIcon, workspaceNavigationMarkup, bindAccountMenu } from './workspace-ui.js';

const api = new CareApiClient(), drafts = new MessageDrafts();
const recipientApi = new CareRecipientApiClient(api);
// This fixed server-rendered hint selects presentation only. The API still
// authorizes every upload, message binding and content read independently.
const deliveryEnabled = document.documentElement.dataset.mediaMode === 'prepared-delivery';
if (deliveryEnabled) document.querySelector('[data-storage-notice]').textContent =
  '이 PC 안의 가상 자료 전용 시험입니다. 검사 완료된 사진·영상은 대화나 활동 경험에 함께 보냅니다. 기록 첨부는 기본 비공개이며 선택한 파일만 공유합니다. 시험 자료는 E 드라이브에 진단용으로 남을 수 있으며, 실제 아동 자료·사진·영상은 받지 않습니다.';
if (document.documentElement.dataset.connectionMode === 'synthetic-private-wifi') {
  document.querySelector('[data-storage-notice]').textContent =
    '승인된 개인 Wi-Fi의 PC와 지정 휴대전화에서 가상 자료로만 시험합니다. 실제 아동 자료·사진·영상은 받지 않습니다.' +
    (deliveryEnabled ? ' 검사 완료된 첨부만 전달하며 기록 첨부는 기본 비공개입니다.' : ' 첨부는 격리 보관하며 전달하지 않습니다.');
}
const mediaApi = new MediaApiClient(api);
const app = document.querySelector('#app'), status = document.querySelector('#status');
let user = null, centerId = null, roomId = null, profile = null, messages = [], rooms = [];
let activeView = 'home', roomOpen = false, monthOffset = 0, careHost = null, mediaHost = null;
let committedPeriod = workspacePeriod();
let operations = null, approvalPending = null, emailLoginUi = null, selfProfile = null, selfProfileOpening = null;
const painted = new WeakMap();
const readingPositions = new Map();
const historySelectors = new Map();
let timelineWindow = null, historyNavigation = null, historyNotice = '';
const chatLayout = new ResizeObserver(() => fitChatViewport());
let phase = 'checking', generation = 0, lifetime = new AbortController(), refreshController = null;
// Navigation can change without an authority generation changing. An old
// selection must not reopen a detail after leaving and returning to a page.
let navigationIntent = 0;
let refreshing = false, connected = false, readBusy = false, readThrough = 0, renderKey = '', targetId = null, targetActivity = false;
// Presentation only. Reconnection never grants authority or restores content.
let projectionRecovery = 'checking';
const draftKey = () => JSON.stringify([user?.userId, centerId, roomId]);
const announce = (message) => { if (status.textContent !== message) status.textContent = message; };
const live = (token) => generation === token && phase === 'workspace';
const recipientRole = () => user?.centers.find(c => c.id === centerId)?.role === 'care_recipient';
const mediaAllowed = () => deliveryEnabled && !recipientRole();
const errorMessage = (error) => error instanceof LocalApiError ? error.message : '처리 결과를 확인할 수 없어요. 다시 시도해 주세요.';
const getContext = () => ({ user, centerId, roomId, profile, messages, connected, generation, signal: lifetime.signal,
  mediaDelivery: mediaAllowed(),
  roomRevision: rooms.find((r) => r.conversationId === roomId)?.revision,
  careData: rooms.find((r) => r.conversationId === roomId)?.care, panelMode: activeView === 'records' ? 'records' : 'compact',
  role: user?.centers.find((c) => c.id === centerId)?.role ?? null });
const getAccountContext = () => ({ userId: user?.userId, centerId,
  role: user?.centers.find((c) => c.id === centerId)?.role ?? null,
  active: ['workspace', 'operations'].includes(phase) && document.visibilityState === 'visible' && navigator.onLine });
function clearSelfProfile() {
  selfProfileOpening = null; selfProfile?.destroy(); selfProfile = null;
}
async function openSelfProfile() {
  if (!getAccountContext().active || !centerId || selfProfileOpening) return;
  if (selfProfile) { await selfProfile.open(); return; }
  const pending = {}, token = generation;
  selfProfileOpening = pending;
  try {
    const { SelfProfileUi } = await import('./self-profile-ui.js');
    if (selfProfileOpening !== pending || generation !== token || !getAccountContext().active) return;
    selfProfile = new SelfProfileUi({ host: document.querySelector('#self-profile-dialog'), transport: api,
      getContext: getAccountContext, announce,
      onDenied: () => showLogin('계정 또는 센터 권한이 변경되었어요. 다시 로그인해 주세요.'),
      onChanged: async () => {
        refreshController?.abort(); refreshController = null; refreshing = false;
        await refresh();
      } });
    await selfProfile.open();
  } catch {
    if (selfProfileOpening === pending && generation === token)
      announce('계정 설정을 불러오지 못했어요. 잠시 후 다시 열어 주세요.');
  } finally {
    if (selfProfileOpening === pending) selfProfileOpening = null;
  }
}
const getMediaContext = () => ({ ...getContext(), visible: !recipientRole() && phase === 'workspace' && activeView === 'chat' && roomOpen,
  enabled: mediaAllowed(), messageOperation: drafts.get(draftKey()).operation });
const media = new MediaUploadUi({ api: mediaApi, getContext: getMediaContext, deliveryEnabled,
  onChanged: () => updateComposer(),
  onError: (error) => {
    if (['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) denied(error);
    else announce(errorMessage(error));
  },
});
const viewer = new MediaViewer({ api, mediaApi, getContext: (source) => source?.kind === 'current-reference'
  ? { ...care.currentReferenceMediaContext(source), enabled: deliveryEnabled }
  : source && source.kind !== 'message'
  ? { ...getContext(), visible: phase === 'workspace' && care.dialog?.open === true, enabled: deliveryEnabled }
  : getMediaContext(),
  onClose: restoreCareAfterMediaClose,
  onError: (error, source) => {
    if (source?.kind === 'current-reference') {
      void care.currentReferenceMediaFailed(source, error).catch(() => announce('첨부 열람 상태를 확인하지 못했어요. 다시 연결해 주세요.'));
      return;
    }
    if (['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) denied(error);
    else announce(errorMessage(error));
  },
});
const care = new CareUi({ api, getContext, mediaApi, deliveryEnabled,
  onOpenRecordAttachment: (recordId, revision, attachmentId) => viewer.openRecord(recordId, revision, attachmentId),
  onOpenFeedbackAttachment: (feedbackId, messageId, revision, attachmentId) => viewer.openFeedback(feedbackId, messageId, revision, attachmentId),
  onOpenReferenceAttachment: (recordId, revision, messageId, attachmentId) => viewer.openReference(recordId, revision, messageId, attachmentId),
  onOpenCurrentReferenceAttachment: (source, attachmentId) => viewer.openCurrentReference(source, attachmentId),
  onRecordViewClosed: () => { if (viewer.operation && viewer.operation.source.kind !== 'message') viewer.clear(); },
  onChanged: async (change) => {
    if (change?.appendMessage && change.userId === user?.userId && change.centerId === centerId && change.roomId === roomId) {
      historySelectors.set(draftKey(), {}); readingPositions.delete(draftKey()); renderKey = '';
    }
    refreshController?.abort(); refreshController = null; refreshing = false;
    await refresh();
  },
  onSourceUnavailable: () => {
    // A source read can observe a newer permission/deletion state than the
    // workspace snapshot. Remove every old projection, including inbox text,
    // before asking for another coherent snapshot. Keep unrelated drafts.
    invalidate(); resetProjections();
    announce('소식 열람 범위가 바뀌어 대화와 미리보기를 다시 확인합니다.');
    void refresh();
  },
  onError: (error) => {
    if (['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) denied(error);
    else announce(errorMessage(error));
  },
});

function restoreCareAfterMediaClose(source) {
  // A chat attachment temporarily suspends the independent care controls.
  // Reapply only the current coherent snapshot after an explicit same-scope
  // close; do not wait for the next poll or restore a clinical dialog itself.
  if (source?.kind !== 'message' || document.visibilityState !== 'visible' || !navigator.onLine) return;
  const context = getMediaContext();
  if (!context.enabled || !context.visible || !context.connected || context.signal?.aborted) return;
  care.update(context);
}

function invalidate() {
  viewer.suspend();
  media.suspend();
  drafts.suspend();
  generation++; lifetime.abort(); lifetime = new AbortController();
  refreshController?.abort(); refreshController = null; refreshing = false; readBusy = false;
  historyNavigation = null;
}
function rememberReadingPosition() {
  if (!connected || !roomId || activeView !== 'chat' || !roomOpen) return;
  const position = captureMessagePosition(app.querySelector('[data-testid="message-list"]'));
  if (position) readingPositions.set(draftKey(), position);
}
function resetProjections({ selectionOnly = false, recovery = 'checking' } = {}) {
  projectionRecovery = recovery;
  rememberReadingPosition();
  chatLayout.disconnect();
  viewer.suspend();
  care.suspend();
  parkMedia();
  profile = null; messages = []; timelineWindow = null; historyNotice = ''; renderKey = ''; connected = false;
  if (!selectionOnly) rooms = [];
  if (phase === 'workspace') announce('현재 열람 범위를 확인하고 있어요.');
  const inbox = app.querySelector('[data-testid="inbox"]');
  if (inbox && !selectionOnly) { painted.delete(inbox); inbox.innerHTML = loadingMarkup('inbox', projectionRecovery); }
  const room = app.querySelector('[data-testid="room"]');
  if (room) { painted.delete(room); room.innerHTML = loadingMarkup('room', projectionRecovery); }
  for (const name of selectionOnly ? ['records-content', 'child-content'] : ['home', 'records-content', 'child-content']) {
    const surface = app.querySelector(`[data-testid="${name}"]`);
    if (surface) { painted.delete(surface); surface.innerHTML = loadingMarkup(name, projectionRecovery); }
  }
  const selector = app.querySelector('#child-select');
  if (selector && !selectionOnly) { selector.replaceChildren(); selector.disabled = true; }
  if (selector && selectionOnly) selector.value = roomId;
  parkCare();
}
function clearSession() {
  navigationIntent++;
  chatLayout.disconnect();
  clearSelfProfile();
  emailLoginUi?.destroy(); emailLoginUi = null;
  approvalPending?.destroy(); approvalPending = null;
  operations?.destroy(); operations = null;
  care.clear();
  media.clear();
  invalidate(); drafts.clear(); resetProjections();
  readingPositions.clear();
  historySelectors.clear();
  user = null; centerId = null; roomId = null; targetId = null; readThrough = 0;
  activeView = 'home'; roomOpen = false; monthOffset = 0;
}
function showLogin(message = '') {
  clearSession(); api.clearIdentity(); phase = 'login';
  app.innerHTML = `<section class="login"><p class="eyebrow">가상 계정 전용</p><h1>대화를 이어가 볼까요?</h1>
    <p class="muted">실행 터미널에 표시된 시험 계정으로 로그인해 주세요. 실제 계정은 사용할 수 없습니다.</p>
    <form data-testid="login-form" autocomplete="off">
      <label for="email">시험 이메일</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="off" autocapitalize="none" spellcheck="false" />
      <label for="password">시험 비밀번호</label><input id="password" name="password" type="password" required maxlength="128" autocomplete="off" />
      <button class="primary" type="submit">로그인</button>
    </form>${document.documentElement.dataset.emailLoginMode === 'synthetic'
      ? '<p><button type="button" data-email-login>가상 이메일 인증번호로 로그인</button></p>' : ''}${document.documentElement.dataset.recoveryMode === 'synthetic'
      ? '<p><a href="/account/password-recovery/request" data-testid="recovery-link">비밀번호를 잊으셨나요?</a></p>' : ''}
    <p class="muted small">현재 연결 범위: 로그인 · 대화 · 치료 기록 · 보호자 공유 · 가정 피드백<br>${deliveryEnabled ? '검사 완료된 사진·영상을 대화·활동 경험에 함께 보냅니다. 기록은 비공개 저장 후 선택 공유하며, 당시 참고 파일은 별도로 확인합니다.' : '사진·영상은 비공개 업로드 시험만 가능합니다. 검사·상대방 전송은 아직 연결되지 않았습니다.'}</p></section>`;
  announce(message);
  app.querySelector('form').addEventListener('submit', login);
  app.querySelector('[data-email-login]')?.addEventListener('click', () => { if (phase === 'login') void showEmailLogin(); });
}
async function showEmailLogin() {
  clearSession(); api.clearIdentity(); phase = 'email-login'; const token = generation;
  app.innerHTML = '<p role="status">이메일 로그인 화면을 준비하고 있어요.</p>'; announce('');
  try {
    const { EmailLoginUi } = await import('./email-login-ui.js');
    if (generation !== token || phase !== 'email-login') return;
    emailLoginUi = new EmailLoginUi({ host: app, transport: api,
      onAuthenticated: identity => { showWorkspace(identity); void refresh(); }, onBack: () => showLogin() });
    emailLoginUi.mount();
    if (document.visibilityState !== 'visible' || !navigator.onLine) emailLoginUi.suspend();
  } catch { if (generation === token && phase === 'email-login') showLogin('이메일 로그인 화면을 불러오지 못했어요.'); }
}
async function login(event) {
  event.preventDefault(); if (phase !== 'login') return;
  const form = event.currentTarget, email = form.elements.email.value, password = form.elements.password.value;
  form.elements.password.value = ''; phase = 'logging-in';
  form.querySelectorAll('input,button').forEach((node) => { node.disabled = true; });
  announce('로그인하고 있어요…');
  const token = generation;
  try {
    const identity = await api.login(email, password, lifetime.signal);
    if (token !== generation) return;
    showWorkspace(identity); await refresh();
  } catch (error) {
    if (token !== generation) return;
    phase = 'login'; form.querySelectorAll('input,button').forEach((node) => { node.disabled = false; });
    announce(errorMessage(error)); form.elements.password.focus();
  }
}
function showWorkspace(identity, selectedCenterId = null) {
  navigationIntent++;
  chatLayout.disconnect();
  clearSelfProfile();
  emailLoginUi?.destroy(); emailLoginUi = null;
  approvalPending?.destroy(); approvalPending = null;
  operations?.destroy(); operations = null; care.clear();
  invalidate(); drafts.clear(); media.clear(); user = identity; phase = 'workspace';
  readingPositions.clear();
  historySelectors.clear();
  const choices = assignedCenters(user);
  centerId = choices.find((c) => c.id === selectedCenterId)?.id ?? choices[0]?.id ?? null;
  roomId = null; targetId = null; readThrough = 0; activeView = 'home'; roomOpen = false; monthOffset = 0;
  if (!centerId) {
    phase = 'approval-pending';
    approvalPending = new ApprovalPendingUi({ host: app, transport: api, userId: user.userId, announce,
      onApproved: (currentIdentity) => { showWorkspace(currentIdentity); void refresh(); },
      onDenied: () => showLogin('로그인 상태가 변경되었어요. 다시 로그인해 주세요.'),
      onLogout: () => { void logout(); } });
    approvalPending.mount();
    return;
  }
  if (choices.find((c) => c.id === centerId)?.role === 'center') {
    // This branch never enters the clinical workspace. Lazy-load only the
    // center controller; the server separately enforces the operations scope.
    phase = 'operations'; const token = generation;
    app.innerHTML = '<p class="empty">센터 관리 화면을 준비하고 있어요.</p>';
    void import('./operations-ui.js').then(({ OperationsUi }) => {
      if (generation !== token || phase !== 'operations') return;
      operations = new OperationsUi({ host: app, transport: api, user, centerId, announce,
        invitationsEnabled: document.documentElement.dataset.invitationsMode === 'synthetic',
        onDenied: () => showLogin('센터 관리 권한 또는 로그인이 변경되었어요. 다시 로그인해 주세요.'),
        onLogout: () => { void logout(); },
        onAccount: () => { void openSelfProfile(); },
        onCenterChange: (id) => { showWorkspace(user, id); void refresh(); } });
      operations.mount(); void refresh();
    }).catch(() => {
      if (generation === token && phase === 'operations') showLogin('센터 화면을 불러오지 못했어요. 다시 로그인해 주세요.');
    });
    return;
  }
  app.innerHTML = `<section class="workspace">
    <header class="workspace-head"><div><p class="eyebrow">${escape(roleName(getContext().role))}로 연결됨</p></div>
      <details class="account-menu"><summary>${workspaceIcon('account')}<span>내 계정</span></summary><div class="account-panel"><p class="account">${escape(user.email)}</p><div class="actions"><button type="button" data-action="self-profile">계정 설정</button><button type="button" data-action="refresh">새로고침</button><button type="button" data-action="logout">로그아웃</button></div></div></details></header>
    ${choices.length > 1 ? `<label class="center-label">센터 선택<select id="center">${choices.map((c) => `<option value="${escape(c.id)}" ${c.id === centerId ? 'selected' : ''}>${escape(c.id)} · ${escape(roleName(c.role))}</option>`).join('')}</select></label>` : ''}
    <nav class="main-nav" aria-label="주 메뉴">${workspaceNavigationMarkup(getContext().role)}</nav>
    <div class="child-toolbar" hidden><label for="child-select">아이 선택</label><select id="child-select" disabled></select></div>
    <section data-page="home" data-testid="home" aria-label="홈"></section>
    <section data-page="chat" hidden aria-label="대화"><div class="workspace-grid"><nav class="room-list-nav" aria-label="아동별 대화"><div class="news-heading"><h1 data-page-title tabindex="-1">대화</h1><button type="button" data-news-sort="chat">새 소식순 정렬</button></div><div data-testid="inbox" tabindex="-1" aria-label="아동별 대화 목록"></div></nav>
      <section data-testid="room" aria-label="선택한 아동 대화"></section></div></section>
    <section data-page="records" hidden aria-label="기록"><header class="page-heading"><h1 data-page-title tabindex="-1">기록</h1></header><div class="surface-card" data-testid="records-content"></div></section>
    <section data-page="child" hidden aria-label="${recipientRole() ? '참여 정보' : '아이 정보'}"><header class="page-heading"><h1 data-page-title tabindex="-1">${recipientRole() ? '참여 정보' : '아이 정보'}</h1></header><div data-testid="child-content"></div></section>
    <div data-care-parking hidden><section data-testid="care" aria-label="기록과 가정 활동 연결"></section></div>
    <div data-media-parking hidden><section data-testid="media-upload-panel" aria-label="사진·영상 업로드 시험"></section></div>
    <div id="attachment-viewer"></div>
  </section>`;
  window.scrollTo({ top: 0, behavior: 'instant' });
  careHost = app.querySelector('[data-testid="care"]'); care.bind(careHost);
  mediaHost = app.querySelector('[data-testid="media-upload-panel"]'); media.bind(mediaHost);
  viewer.bind(app.querySelector('#attachment-viewer'));
  resetProjections();
  bindNewsActivation(app.querySelector('.workspace'), () => generation,
    () => announce('소식 목록이 바뀌었어요. 아이 이름을 확인한 뒤 다시 선택해 주세요.'));
  bindAccountMenu(app.querySelector('.workspace'));
  app.querySelector('[data-action="refresh"]').addEventListener('click', () => { void refresh(); });
  app.querySelector('[data-action="logout"]').addEventListener('click', () => { void logout(); });
  app.querySelector('[data-action="self-profile"]').addEventListener('click', () => { void openSelfProfile(); });
  app.querySelector('[data-testid="inbox"]').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-room-id]');
    if (button) void selectRoom(button.dataset.roomId);
  });
  app.querySelector('#center')?.addEventListener('change', (event) => {
    navigationIntent++;
    if (user.centers.find((c) => c.id === event.target.value)?.role !== getContext().role) {
      showWorkspace(user, event.target.value); return;
    }
    clearSelfProfile(); care.clear();
    media.clear();
    invalidate(); drafts.clear(); centerId = event.target.value; roomId = null; targetId = null; readThrough = 0; roomOpen = false;
    app.querySelector('.workspace-head .eyebrow').textContent = `${roleName(getContext().role)}로 연결됨`;
    resetProjections(); readingPositions.clear(); historySelectors.clear(); void refresh();
  });
  app.querySelector('#child-select').addEventListener('change', (event) => { void selectRoom(event.target.value, activeView); });
  app.querySelector('.workspace').addEventListener('click', (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.action === 'reconnect') { void refresh(); return; }
    if (button.hasAttribute('data-start-chat')) { changeView('chat'); return; }
    if (button.hasAttribute('data-open-schedule')) { void openSchedule(); return; }
    if (button.dataset.newsSort) {
      if (!connected) return;
      if (button.dataset.newsSort === 'home') renderHome(false); else renderInbox(false);
      announce('새 소식이 있는 대화부터 최신순으로 정렬했어요.'); return;
    }
    if (button.dataset.view) { changeView(button.dataset.view); return; }
    if (button.hasAttribute('data-family-plan')) { viewer.suspend(); void care.handleAction('family-plan'); return; }
    if (button.hasAttribute('data-goal-new') || button.hasAttribute('data-goal-edit')) {
      viewer.suspend(); void care.handleAction(button.hasAttribute('data-goal-new') ? 'new-goal' : 'edit-goal', button.dataset.goalEdit); return;
    }
    if (button.hasAttribute('data-appointment-new')) { viewer.suspend(); void care.handleAction('new-appointment'); return; }
    if (button.dataset.appointmentEdit) {
      void openCare(button.dataset.contextRoom, 'edit-appointment', button.dataset.appointmentEdit); return;
    }
    if (button.dataset.action === 'room-list') { navigationIntent++; rememberReadingPosition(); care.suspend(); viewer.suspend(); roomOpen = false; renderSurfaces(); focusPage(); return; }
    if (button.dataset.action?.startsWith('history-')) { void navigateHistory(button.dataset.action.slice(8)); return; }
    if (button.dataset.openRoom) { void selectRoom(button.dataset.openRoom, 'chat', button.dataset.targetId || null, button.hasAttribute('data-activity-link')); return; }
    if (button.dataset.openRecord || button.dataset.appointmentRecord) {
      void openCare(button.dataset.contextRoom, button.dataset.openRecord ? 'edit-record' : 'appointment-record', button.dataset.openRecord ?? button.dataset.appointmentRecord); return;
    }
    if (button.dataset.monthShift) {
      // Keep the committed period and its DOM until the new coherent snapshot
      // arrives. Month navigation is not a permission or identity boundary.
      monthOffset += Number(button.dataset.monthShift);
      refreshController?.abort(); refreshController = null; refreshing = false;
      void refresh();
    }
  });
}
function denied(error) {
  if (error?.code === 'AUTH_REQUIRED') { showLogin('로그인이 만료되었거나 종료되었어요. 다시 로그인해 주세요.'); return; }
  if (error?.code === 'NOT_FOUND' || error?.code === 'FORBIDDEN') {
    selfProfile?.suspend();
    care.clear();
    media.clear();
    invalidate(); drafts.clear(); roomId = null; targetId = null; readThrough = 0; roomOpen = false;
    readingPositions.clear();
    historySelectors.clear();
  }
  resetProjections({ recovery: ['NOT_FOUND', 'FORBIDDEN'].includes(error?.code) ? 'checking'
    : navigator.onLine ? 'unavailable' : 'offline' });
  // Losing the selected room must also reveal the mobile list; otherwise its
  // old room-open layout hides the remaining authorized rooms and back button.
  if (phase === 'workspace') applyView();
  announce(errorMessage(error));
}
async function refresh() {
  if (phase === 'email-login') {
    if (document.visibilityState === 'visible' && navigator.onLine) emailLoginUi?.resume();
    return;
  }
  if (phase === 'approval-pending') {
    if (document.visibilityState === 'visible' && navigator.onLine) return approvalPending?.refresh();
    return;
  }
  if (phase === 'operations') {
    if (document.visibilityState === 'visible' && navigator.onLine) return operations?.refresh();
    return;
  }
  if (phase !== 'workspace' || refreshing || !centerId || document.visibilityState !== 'visible' || !navigator.onLine) return;
  refreshing = true; const controller = new AbortController(); refreshController = controller;
  const token = generation, selected = roomId, currentCenter = centerId;
  const historyKey = draftKey(), requestedHistory = historySelectors.get(historyKey) ?? {};
  const requestedPeriod = workspacePeriod(monthOffset);
  const signal = AbortSignal.any([controller.signal, lifetime.signal]);
  try {
    const identity = await api.session(signal);
    if (!live(token) || signal.aborted) return;
    if (identity.userId !== user.userId) { showLogin('다른 창에서 계정이 변경되었어요. 다시 로그인해 주세요.'); return; }
    if (identity.centers.find((c) => c.id === currentCenter)?.role !== user.centers.find((c) => c.id === currentCenter)?.role) {
      showLogin('계정의 센터 권한이 변경되었어요. 다시 로그인해 주세요.'); return;
    }
    if (!identity.centers.some((c) => c.id === currentCenter && ['therapist', 'guardian', 'care_recipient'].includes(c.role))) throw new LocalApiError('NOT_FOUND');
    // Bracket authorized profile/message reads with the conversation change
    // token; never paint a pre-deletion preview beside post-deletion messages.
    // This is not an atomic snapshot of every profile field. Retries are bounded.
    const next = await api.careWorkspace(currentCenter, selected, { role: getContext().role, ...requestedPeriod, timeline: requestedHistory }, signal);
    if (selected && next.profile) {
      const primary = await recipientApi.primary(currentCenter, selected, signal);
      next.profile.primaryCommunicator = primary;
      const entry = next.rooms.find(room => room.conversationId === selected);
      if (entry) entry.profile = next.profile;
    }
    if (!live(token) || signal.aborted || selected !== roomId || currentCenter !== centerId) return;
    // Only this successfully completed, revision-bracketed full list can
    // revoke another room's local drafts and file selections. Never prune
    // from a failed/partial read; re-invitation must not revive old input.
    const allowedRoomIds = next.rooms.map((room) => room.conversationId);
    const positionKeys = new Set(allowedRoomIds.map((id) => JSON.stringify([user.userId, currentCenter, id])));
    for (const key of readingPositions.keys()) if (!positionKeys.has(key)) readingPositions.delete(key);
    for (const key of historySelectors.keys()) if (!positionKeys.has(key)) historySelectors.delete(key);
    drafts.retainRooms(user.userId, currentCenter, allowedRoomIds);
    media.retainRooms(user.userId, currentCenter, allowedRoomIds);
    care.retainRooms(user.userId, currentCenter, allowedRoomIds);
    rooms = next.rooms; profile = next.profile;
    messages = recipientRole() ? next.messages.map(recipientTextMessage).filter(Boolean) : next.messages;
    timelineWindow = next.timelineWindow?.window ?? null;
    const viewingMessage = viewer.operation?.source.kind === 'message' && viewer.current(viewer.operation);
    if (selected) historySelectors.set(historyKey, viewingMessage && timelineWindow?.startCursor > 0
      ? { from: timelineWindow.startCursor } : stableHistorySelector(next.targetUnavailable ? {} : requestedHistory, timelineWindow));
    if (next.targetUnavailable) {
      targetId = null; targetActivity = false;
      historyNotice = '선택한 소식은 더 이상 열람할 수 없어 최신 대화를 표시했어요. 작성 중인 내용은 유지했습니다.';
    }
    const turn = historyNavigation;
    if (turn?.key === historyKey && turn.intent === navigationIntent && activeView === 'chat' && roomOpen) {
      readingPositions.delete(historyKey); renderKey = '';
      targetId = (next.targetUnavailable ? messages.at(-1)?.id : turn.target ??
        (turn.edge === 'first' ? messages[0]?.id : messages.at(-1)?.id)) ?? null;
      targetActivity = !next.targetUnavailable && turn.activity;
    }
    connected = true; projectionRecovery = 'checking'; committedPeriod = requestedPeriod;
    viewer.reconcile(messages);
    renderSurfaces(); announce('서버와 연결되어 있어요.');
    return true;
  } catch (error) {
    if (!live(token) || signal.aborted || error?.code === 'CANCELLED') return;
    denied(error);
  } finally {
    if (refreshController === controller) { refreshing = false; refreshController = null; }
  }
}
function renderInbox(preserveOrder = activeView === 'chat' && (!roomOpen || getComputedStyle(app.querySelector('.main-nav')).position !== 'fixed')) {
  const inbox = app.querySelector('[data-testid="inbox"]');
  const sort = app.querySelector('[data-news-sort="chat"]');
  sort.disabled = !connected;
  if (!connected && !rooms.length) { paint(inbox, loadingMarkup('inbox', projectionRecovery)); sort.removeAttribute('data-pending'); return; }
  painted.delete(inbox);
  const pending = reconcileNewsList(inbox, rooms, { selectedId: roomId, preserveOrder });
  sort.toggleAttribute('data-pending', pending);
  sort.textContent = pending ? '새 순서 적용' : '새 소식순 정렬';
}
function renderHome(preserveOrder = activeView === 'home') {
  const host = app.querySelector('[data-testid="home"]');
  if (!connected) { paint(host, loadingMarkup('home', projectionRecovery)); return; }
  const html = homeMarkup(rooms, getContext().role, committedPeriod);
  if (!host.querySelector('[data-home-news]')) {
    // This first mount must not leave a cached copy of clinical previews in
    // paint's WeakMap when the subsequent targeted renders redact them.
    painted.delete(host); host.innerHTML = html;
  } else {
    const template = document.createElement('template'); template.innerHTML = html;
    for (const panel of recipientRole() ? [] : ['schedule', 'work']) {
      const selector = `[data-home-panel="${panel}"]`;
      paint(host.querySelector(selector), template.content.querySelector(selector).innerHTML);
    }
  }
  const news = orderedNews(rooms);
  const pending = reconcileNewsList(host.querySelector('[data-home-news]'), news, { home: true, preserveOrder });
  const sort = host.querySelector('[data-news-sort="home"]');
  sort.toggleAttribute('data-pending', pending);
  sort.textContent = pending ? '새 순서 적용' : '새 소식순 정렬';
}
async function selectRoom(id, view = 'chat', target = null, activity = false) {
  const allowed = rooms.find((r) => r.conversationId === id);
  if (!allowed) return false;
  const intent = ++navigationIntent;
  rememberReadingPosition();
  care.suspend(); viewer.suspend(); activeView = view; roomOpen = view === 'chat';
  // A normal room switch restores its reading bookmark. Only an explicit
  // home/news link overrides it with a particular message target.
  targetId = view === 'chat' ? target : null;
  targetActivity = !!targetId && activity;
  if (targetId) historyNotice = '';
  if (roomId === id && connected) {
    if (targetId && !messages.some(message => message.id === targetId))
      return navigateHistory('target', targetId, activity);
    // An explicit link to a currently loaded message also supersedes an older
    // pending page turn. Its late response must not replace the chosen target.
    if (targetId && historyNavigation) {
      refreshController?.abort(); refreshController = null; refreshing = false; historyNavigation = null;
      historySelectors.set(draftKey(), stableHistorySelector({ from: timelineWindow.startCursor }, timelineWindow));
    }
    renderKey = ''; renderSurfaces(); focusPage(); return true;
  }
  invalidate(); connected = false; roomId = id; readThrough = 0;
  if (targetId) historySelectors.set(draftKey(), { around: targetId });
  // The already-authorized navigation list stays stable. Only selected child
  // content is cleared, and no new child's content appears before verification.
  resetProjections({ selectionOnly: true }); renderInbox(); applyView();
  const loaded = await refresh();
  if (loaded && navigationIntent === intent && roomId === id && activeView === view) { focusPage(); return true; }
  return false;
}
async function navigateHistory(direction, target = null, activity = false) {
  const explicitTarget = direction === 'target' && typeof target === 'string' && target.length > 0;
  if (!connected || !roomId || activeView !== 'chat' || !roomOpen ||
      (!explicitTarget && (historyNavigation || drafts.get(draftKey()).sending)) ||
      document.visibilityState !== 'visible' || !navigator.onLine) return false;
  const selector = direction === 'target' ? { around: target } : historySelector(direction, timelineWindow);
  if (!selector) return false;
  rememberReadingPosition(); care.suspend(); viewer.suspend();
  const intent = ++navigationIntent, key = draftKey();
  const turn = { intent, key, target, activity, edge: direction === 'older' ? 'last' : 'first' };
  if (direction === 'latest') turn.edge = 'last';
  historyNavigation = turn;
  historyNotice = '';
  historySelectors.set(key, selector);
  // Keep the current same-room page and composer mounted until the new
  // permission-checked snapshot is complete. Never append mixed revisions.
  refreshController?.abort(); refreshController = null; refreshing = false;
  updateComposer(); announce('대화 소식을 불러오고 있어요…');
  const loaded = await refresh();
  if (historyNavigation === turn) {
    historyNavigation = null; updateComposer();
    if (loaded && navigationIntent === intent && draftKey() === key && activeView === 'chat' && roomOpen) {
      focusPage(); requestAnimationFrame(tryRead);
      announce(direction === 'latest' ? '최신 소식으로 이동했어요.' : '대화 소식을 불러왔어요.');
      return true;
    }
  }
  return false;
}
function renderHistoryControls() {
  const controls = app.querySelector('[data-history-controls]');
  if (!controls) return;
  const notice = app.querySelector('[data-history-notice]');
  if (notice) { notice.textContent = historyNotice; notice.hidden = !historyNotice; }
  controls.hidden = !timelineWindow || (!timelineWindow.hasOlder && !timelineWindow.hasNewer);
  controls.setAttribute('aria-busy', historyNavigation ? 'true' : 'false');
  for (const direction of ['older', 'newer', 'latest']) {
    const button = controls.querySelector(`[data-action="history-${direction}"]`);
    button.disabled = !connected || !!historyNavigation || drafts.get(draftKey()).sending || (direction === 'older'
      ? !historySelector('older', timelineWindow) : direction === 'newer' ? !historySelector('newer', timelineWindow)
      : !timelineWindow?.hasNewer && !Object.keys(historySelectors.get(draftKey()) ?? {}).length);
  }
}
function pinHistoryForMedia() {
  if (!connected || !timelineWindow?.startCursor || historyNavigation) return false;
  // Opening an attachment is an explicit reading choice. A send started
  // earlier must not jump back to latest and evict this source on completion.
  navigationIntent++;
  // A new latest message must not evict an unchanged attachment source while
  // its viewer is open. Still refresh this bounded page and reconcile current
  // authorization/files normally; no old message or media cache is retained.
  historySelectors.set(draftKey(), { from: timelineWindow.startCursor });
  refreshController?.abort(); refreshController = null; refreshing = false;
  return true;
}
async function openCare(id, action, target) {
  if (await selectRoom(id, action === 'edit-appointment' ? 'child' : 'records', null)) await care.handleAction(action, target);
}
async function openSchedule() {
  if (!connected || recipientRole() || !rooms.length) return;
  const id = rooms.find((room) => room.conversationId === roomId)?.conversationId ?? rooms[0].conversationId;
  const opening = selectRoom(id, 'child');
  const intent = navigationIntent;
  // Reuse authorized child selection. A later menu/child choice must win over
  // this shortcut's pending load, and the schedule never enters the chat view.
  if (!await opening || navigationIntent !== intent || activeView !== 'child' || roomId !== id || !connected) return;
  const title = app.querySelector('[data-schedule-heading]');
  title?.focus({ preventScroll: true });
  title?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
}
function parkCare() {
  const parking = app.querySelector('[data-care-parking]');
  if (parking && careHost && careHost.parentElement !== parking) parking.append(careHost);
}
function parkMedia() {
  media.suspend();
  const parking = app.querySelector('[data-media-parking]');
  if (parking && mediaHost && mediaHost.parentElement !== parking) parking.append(mediaHost);
}
function focusPage() {
  const title = activeView === 'chat' && roomOpen ? app.querySelector('#room-title')
    : app.querySelector(`[data-page="${activeView}"] [data-page-title]`);
  title?.focus({ preventScroll: true });
  // Only an explicit navigation aligns the outer page. Polling and ordinary
  // message scrolling never call this path. Chat gets a dedicated viewport;
  // account controls and the test notice remain reachable above it.
  if (activeView === 'chat' && roomOpen && connected && profile) {
    const header = app.querySelector('.room-head'), nav = app.querySelector('.main-nav');
    const navigationPosition = getComputedStyle(nav).position;
    if (header && ['fixed', 'sticky'].includes(navigationPosition)) {
      if (navigationPosition === 'fixed') header.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
      else window.scrollTo({ top: Math.max(0, header.getBoundingClientRect().top + window.scrollY - nav.getBoundingClientRect().height - 8), behavior: 'instant' });
      fitChatViewport();
      rememberReadingPosition();
      requestAnimationFrame(tryRead);
    }
  }
}
function applyView(focus = false) {
  app.dataset.view = activeView;
  for (const page of app.querySelectorAll('[data-page]')) page.hidden = page.dataset.page !== activeView;
  for (const button of app.querySelectorAll('[data-view]')) {
    if (button.dataset.view === activeView) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  app.querySelector('.workspace-grid')?.classList.toggle('room-open', roomOpen);
  const toolbar = app.querySelector('.child-toolbar');
  if (toolbar) toolbar.hidden = !['records', 'child'].includes(activeView);
  let slot = null;
  if (connected && profile && !recipientRole()) {
    slot = activeView === 'chat' && roomOpen ? app.querySelector('[data-chat-care]')
      : activeView === 'records' ? app.querySelector('[data-record-care]') : null;
  }
  if (slot) { if (careHost.parentElement !== slot) slot.append(careHost); } else parkCare();
  const mediaSlot = !recipientRole() && connected && profile && activeView === 'chat' && roomOpen ? app.querySelector('[data-chat-media]') : null;
  if (mediaSlot) { if (mediaHost.parentElement !== mediaSlot) mediaSlot.append(mediaHost); }
  else parkMedia();
  if (focus) focusPage();
}
function fitChatViewport() {
  if (phase !== 'workspace' || activeView !== 'chat' || !roomOpen || !connected) return;
  const list = app.querySelector('[data-testid="message-list"]'), grid = app.querySelector('.workspace-grid');
  if (!list || !grid || !grid.getClientRects().length) return;
  const room = app.querySelector('[data-testid="room"]'), nav = app.querySelector('.main-nav');
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  // Measure the actual navigation, including its safe-area inset.
  const chromeHeight = [...room.children].filter((node) => node !== list)
    .reduce((sum, node) => sum + node.getBoundingClientRect().height, 0);
  const navigationPosition = getComputedStyle(nav).position;
  const bottomNav = navigationPosition === 'fixed' ? nav.getBoundingClientRect().height : 0;
  if (bottomNav) {
    // A mobile room is one bounded workspace. Flex layout gives the remaining
    // space to messages instead of forcing a minimum that pushes Send below it.
    const height = `${Math.max(0, Math.round(viewportHeight - bottomNav - 16))}px`;
    if (grid.style.getPropertyValue('--mobile-chat-height') === height && !list.style.height) return;
    const position = captureMessagePosition(list);
    grid.style.setProperty('--mobile-chat-height', height);
    list.style.height = '';
    restoreMessagePosition(list, position);
    return;
  }
  grid.style.removeProperty('--mobile-chat-height');
  // Keep the desktop sticky origin stable through polling and outer scrolling.
  const top = navigationPosition === 'sticky' ? nav.getBoundingClientRect().height + 8
    : grid.getBoundingClientRect().top + window.scrollY;
  // A desktop conversation must remain readable even when disclosures or a
  // resized composer need outer scrolling. Never move that scroll on refresh.
  const height = Math.round(Math.max(320,
    Math.min(720, viewportHeight - top - chromeHeight - 16)));
  if (list.style.height === `${height}px`) return;
  const position = captureMessagePosition(list);
  list.style.height = `${height}px`;
  restoreMessagePosition(list, position);
}
function resizeChatViewport() {
  fitChatViewport();
  if (phase !== 'workspace' || activeView !== 'chat' || !roomOpen || !connected) return;
  const nav = app.querySelector('.main-nav'), header = app.querySelector('.room-head');
  // Only an actual viewport resize aligns the mobile frame. Polling, typing
  // and disclosures never call this path or move the user's page/reading anchor.
  if (header && nav && !document.querySelector('dialog[open]') && getComputedStyle(nav).position === 'fixed')
    header.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
}
function preserveChatDisclosurePosition(event) {
  if (phase !== 'workspace' || activeView !== 'chat' || !roomOpen || !connected ||
      !event.target.closest('.room-head summary, .chat-tools summary, [data-chat-media] summary')) return;
  const list = app.querySelector('[data-testid="message-list"]');
  const position = captureMessagePosition(list), turn = generation, selectedRoom = roomId;
  // Click runs before the native details toggle, including keyboard activation.
  // Preserve the pre-toggle bookmark after flex layout changes the reading pane.
  requestAnimationFrame(() => {
    if (phase === 'workspace' && activeView === 'chat' && roomOpen && connected &&
        generation === turn && roomId === selectedRoom && list?.isConnected &&
        app.querySelector('[data-testid="message-list"]') === list) restoreMessagePosition(list, position);
  });
}
function changeView(view) {
  if (!workspaceMenus(getContext().role).some(([key]) => key === view) || activeView === view) return;
  navigationIntent++;
  rememberReadingPosition();
  // Leaving a surface also invalidates pending detail openings. An old GET
  // must not open a dialog over the user's next page; drafts stay in memory.
  care.suspend(); viewer.suspend(); activeView = view;
  if (view === 'chat') roomOpen = !!roomId;
  // Selection is explicit; entering a non-chat page never opens a conversation
  // or advances its read cursor, including on mobile.
  if (['records', 'child'].includes(view) && !roomId && rooms.length) { void selectRoom(rooms[0].conversationId, view, null); return; }
  renderSurfaces(); focusPage();
}
function paint(node, html) {
  if (painted.get(node) === html) return;
  const active = document.activeElement;
  const focused = node.contains(active) && active?.matches('button') ? { ...active.dataset } : null;
  if (careHost && node.contains(careHost)) parkCare();
  node.innerHTML = html; painted.set(node, html);
  if (focused) [...node.querySelectorAll('button')].find((button) => Object.keys(focused).every((key) => button.dataset[key] === focused[key]))?.focus({ preventScroll: true });
}
function renderSurfaces() {
  if (phase !== 'workspace') return;
  // Retain a single host, dialog and mutation controller across all four menus.
  renderInbox();
  const period = committedPeriod, role = getContext().role;
  const selected = rooms.find((r) => r.conversationId === roomId);
  renderHome();
  const selector = app.querySelector('#child-select');
  const options = rooms.map((r) => `<option value="${escape(r.conversationId)}">${escape(childName(r))}</option>`).join('');
  if (selector.innerHTML !== options) selector.innerHTML = options;
  selector.disabled = !connected || !rooms.length; selector.value = roomId ?? '';
  paint(app.querySelector('[data-testid="records-content"]'), recipientRole() ? '' : !connected ? loadingMarkup('records-content', projectionRecovery) : selected ? `<h2 class="context-title">${escape(childName(selected))}</h2><div data-record-care></div>${role === 'guardian' ? guardianRecordsMarkup(selected) : ''}` : '<p class="empty">아이를 선택해 주세요.</p>');
  paint(app.querySelector('[data-testid="child-content"]'), connected ? childMarkup(selected, role, period) : loadingMarkup('child-content', projectionRecovery));
  if (activeView === 'chat' && roomOpen) renderRoom();
  else {
    // Off-screen chat DOM is not a cache. Keep drafts in their scoped memory
    // store, but remove old source text even before the next permission poll.
    chatLayout.disconnect();
    const chat = app.querySelector('[data-testid="room"]');
    // Only rescue a care host that would be removed with the old chat DOM.
    // An authorized record host already in its slot must stay mounted during
    // routine refreshes; moving it through hidden parking drops keyboard focus.
    if (careHost && chat.contains(careHost)) parkCare();
    parkMedia();
    if (chat.querySelector('[data-testid="message-list"]')) chat.replaceChildren();
    if (connected) paint(chat, '<div class="empty room-empty"><h2>아이의 대화를 선택해 주세요</h2><p>소식과 기록을 한곳에서 이어갈 수 있어요.</p></div>');
    renderKey = '';
  }
  applyView();
  // Source/permission checks remain active even when the chat surface is hidden.
  if (recipientRole()) care.suspend(); else care.update(getContext());
  media.update(getMediaContext());
  updateComposer();
  if (activeView === 'chat' && roomOpen && connected && profile) {
    fitChatViewport();
    // Measure only after the page is visible and the care/media hosts have
    // reached their final positions. A hidden page has zero layout dimensions.
    // Do not consume an explicit target while the selected room is loading.
    if (targetId) {
      const list = app.querySelector('[data-testid="message-list"]');
      if (!scrollMessageTarget(list, targetId, targetActivity)) restoreMessagePosition(list, readingPositions.get(draftKey()));
      targetId = null; targetActivity = false;
    } else restoreMessagePosition(app.querySelector('[data-testid="message-list"]'), readingPositions.get(draftKey()));
    rememberReadingPosition();
    requestAnimationFrame(tryRead);
  }
}
function renderRoom() {
  if (!roomId || !profile) return;
  const container = app.querySelector('[data-testid="room"]');
  if (!container.querySelector('[data-testid="message-list"]')) {
    chatLayout.disconnect();
    painted.delete(container);
    container.innerHTML = `<header class="room-head"><button type="button" class="room-back" data-action="room-list" aria-label="대화 목록"><span aria-hidden="true">←</span></button><div class="room-context"><p class="room-test-label">가상 자료 시험</p><h2 id="room-title" tabindex="-1"></h2><details class="room-participants"><summary></summary><ul id="participants"></ul></details></div></header>
      <div class="chat-tools" data-chat-tools><div data-primary-communicator></div><div data-chat-care></div>
      <p class="history-notice small" data-history-notice role="status" hidden></p>
      <nav class="history-controls" data-history-controls aria-label="이전·다음 대화 소식" hidden><button type="button" data-action="history-older">이전 소식</button><button type="button" data-action="history-newer">다음 소식</button><button type="button" data-action="history-latest">최신 소식</button></nav></div>
      <ol class="message-list" data-testid="message-list" aria-label="대화 내용"></ol>
      <form class="composer"><label for="message">메시지</label><textarea id="message" name="message" rows="2" maxlength="2000" placeholder="메시지 입력"></textarea>
        <p class="small" data-testid="send-error" role="status" hidden></p><div class="composer-actions"><button type="submit" class="primary">보내기</button></div></form>
      <div data-chat-media></div>`;
    for (const child of container.children) if (!child.matches('.message-list')) chatLayout.observe(child);
    container.addEventListener('click', preserveChatDisclosurePosition, true);
    container.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); void send(); });
    container.querySelector('textarea').addEventListener('input', (event) => {
      drafts.edit(draftKey(), event.target.value); updateComposer();
    });
    container.querySelector('[data-testid="message-list"]').addEventListener('scroll', tryRead, { passive: true });
    container.querySelector('[data-testid="message-list"]').addEventListener('click', (event) => {
      const attachment = event.target.closest('button[data-open-attachment]');
      if (mediaAllowed() && attachment && container.contains(attachment)) {
        if (!pinHistoryForMedia()) return;
        care.suspend(); void viewer.open(attachment.dataset.messageId, attachment.dataset.openAttachment); return;
      }
      const button = event.target.closest('button[data-care-action]');
      if (!recipientRole() && button && container.contains(button)) {
        viewer.suspend();
        // Opening chat media suspends clinical projections. Restore only the
        // current authorized workspace before a new action, without waiting
        // for the next poll. handleAction still rechecks its source authority.
        care.update(getContext());
        void care.handleAction(button.dataset.careAction, button.dataset.messageId);
      }
    });
  }
  container.querySelector('#room-title').textContent = profile.name ?? '이름 미등록 아동';
  renderHistoryControls();
  const participantSummary = container.querySelector('.room-participants > summary');
  const summaryText = `참여자 ${profile.participants.length}명`;
  if (participantSummary.textContent !== summaryText) participantSummary.textContent = summaryText;
  // Keep the native disclosure and its focused summary, not a cache of people.
  // Authority resets remove the whole room; refreshed names still replace data.
  paint(container.querySelector('#participants'), roomParticipantsMarkup(profile.participants, profile.primaryCommunicator?.userId));
  if (reconcilePrimaryCommunicator(container.querySelector('[data-primary-communicator]'), profile))
    container.querySelector('#room-title').focus({ preventScroll: true });
  const recipientNotice = container.querySelector('.composer label');
  if (recipientRole()) recipientNotice.textContent = '메시지 · 현재 참여자에게 보내는 일반 텍스트';
  const list = container.querySelector('[data-testid="message-list"]');
  const nextKey = JSON.stringify([profile, messages]);
  if (renderKey) rememberReadingPosition();
  if (renderKey !== nextKey) {
    const openMenus = new Set([...list.querySelectorAll('.care-message-menu[open]')]
      .map((menu) => menu.closest('[data-message-id]')?.dataset.messageId));
    const focused = document.activeElement;
    const focusMessage = list.contains(focused) ? focused.closest('[data-message-id]')?.dataset.messageId : null;
    const focusAction = focused?.dataset?.careAction;
    const focusAttachment = focused?.dataset?.openAttachment;
    const focusSummary = focused?.matches?.('.care-message-menu > summary');
    list.innerHTML = messages.map((m) => {
      const author = profile.participants.find((p) => p.userId === m.authorId);
      const mine = m.authorId === user.userId;
      return `<li data-testid="message-row" data-message-id="${escape(m.id)}" data-sequence="${m.sequence}" class="message ${mine ? 'mine' : ''} ${targetId === m.id ? 'target' : ''}">
        <p class="author">${mine ? '나' : escape(author?.displayName ?? (author ? roleName(author.role) : '이전 참여자'))}</p>
        <div class="bubble">${m.quote ? `<blockquote class="message-quote">${escape(m.quote.preview ?? m.quote.body)}</blockquote>${m.quote.changed ? '<p class="small muted">답장 당시 내용 · 원문 수정됨</p>' : ''}` : ''}${renderCareMessage(m, getContext().role, user.userId, deliveryEnabled)}</div>
        <p class="meta"><time datetime="${escape(m.createdAt)}">${escape(formatWorkspaceTime(m.createdAt))}</time>${m.edited ? ' · 수정됨' : ''}${mine ? ` · ${m.read ? '읽음' : '전송됨'}` : ''}</p></li>`;
    }).join('') || '<li class="empty">첫 메시지를 보내 보세요.</li>';
    // New receipts/read states must not close a keyboard user's open menu.
    // Removed content or capabilities are never recreated to restore focus.
    for (const row of list.querySelectorAll('[data-testid="message-row"]')) {
      const menu = row.querySelector('.care-message-menu');
      if (menu && openMenus.has(row.dataset.messageId)) menu.open = true;
      if (row.dataset.messageId === focusMessage && (focusSummary || focusAction || focusAttachment)) {
        const action = [...row.querySelectorAll('[data-care-action]')].find((node) => node.dataset.careAction === focusAction);
        const attachment = [...row.querySelectorAll('[data-open-attachment]')].find((node) => node.dataset.openAttachment === focusAttachment);
        (attachment ?? action ?? menu?.querySelector('summary'))?.focus({ preventScroll: true });
      }
    }
    renderKey = nextKey;
    // Restore after applyView(), when the active page has real dimensions.
  }
  updateComposer(); requestAnimationFrame(tryRead);
}
function updateComposer() {
  const textarea = app.querySelector('#message'); if (!textarea || !roomId) return;
  const draft = drafts.get(draftKey());
  if (textarea.value !== draft.body) textarea.value = draft.body;
  textarea.readOnly = !!draft.operation;
  const button = app.querySelector('.composer button'), error = app.querySelector('[data-testid="send-error"]');
  let attachments = [];
  try { attachments = draft.operation ? (draft.operation.attachments ?? []) : (mediaAllowed() ? media.captureAttachments() : []); }
  catch { attachments = null; }
  button.disabled = draft.sending || !!historyNavigation || !connected || (!draft.operation &&
    (attachments === null || (!draft.body.trim() && !attachments.length)));
  button.textContent = draft.sending ? '전송 확인 중…' : draft.uncertain ? '다시 보내기' : '보내기';
  error.hidden = !draft.uncertain && !draft.rejected;
  error.textContent = draft.uncertain ? '전송 결과를 확인하지 못했어요. 같은 내용·첨부·전송 번호로 다시 확인하며, 중복 저장하지 않습니다. 확인 전에는 내용과 첨부를 바꿀 수 없어요.'
    : draft.rejected ? '서버가 입력을 거부하여 저장하지 않았어요. 내용을 확인한 뒤 다시 보내 주세요.' : '';
  renderHistoryControls();
}
async function send() {
  if (phase !== 'workspace' || !connected || !roomId || historyNavigation) return;
  const key = draftKey(); let operation;
  try {
    const previous = drafts.get(key).operation;
    operation = drafts.begin(key, previous ? (previous.attachments ?? []) : (mediaAllowed() ? media.captureAttachments() : []));
  } catch (error) { announce(errorMessage(error)); return; }
  if (!operation) return;
  const token = generation, selected = roomId, currentCenter = centerId, sendIntent = navigationIntent;
  const scope = Object.freeze({ userId: user.userId, centerId: currentCenter, roomId: selected });
  updateComposer(); media.update(getMediaContext());
  try {
    await api.send(currentCenter, selected, operation, lifetime.signal);
    if (!live(token)) return;
    drafts.accepted(key, operation);
    media.forgetSent(scope, (operation.attachments ?? []).map((file) => file.id));
    updateComposer(); media.update(getMediaContext()); announce('메시지를 서버에 저장했어요.');
    // A successful send returns to the current conversation end. Keep an
    // ambiguous/failed send on its existing page with the same operation ID.
    if (sendIntent === navigationIntent) {
      historySelectors.set(key, {}); readingPositions.delete(key); renderKey = '';
    }
    // An earlier poll may have started before this commit. Replace that read.
    if (!historyNavigation) { refreshController?.abort(); refreshController = null; refreshing = false; }
    await refresh();
  } catch (error) {
    if (!live(token)) return;
    if (isRejectedMessageSend(error)) drafts.rejected(key, operation);
    else drafts.failed(key, operation);
    if (['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) { denied(error); return; }
    updateComposer(); media.update(getMediaContext()); announce(errorMessage(error));
  }
}
async function tryRead() {
  if (phase !== 'workspace' || activeView !== 'chat' || !roomOpen || !connected || historyNavigation || readBusy || !roomId || care.dialog?.open || viewer.dialog?.open || document.querySelector('#self-profile-dialog')?.open || document.visibilityState !== 'visible' || !navigator.onLine) return;
  const list = app.querySelector('[data-testid="message-list"]'); if (!list) return;
  const viewport = window.visualViewport, viewportTop = viewport?.offsetTop ?? 0;
  const viewportBottom = viewport ? viewportTop + viewport.height : window.innerHeight;
  const nav = app.querySelector('.main-nav');
  const navigationPosition = nav ? getComputedStyle(nav).position : null;
  const bottom = navigationPosition === 'fixed'
    ? Math.min(viewportBottom, nav.getBoundingClientRect().top) : viewportBottom;
  // Sticky desktop navigation can cover rows after the user scrolls the page.
  // Covered content is not evidence of reading, just as for mobile bottom nav.
  const navBounds = navigationPosition === 'sticky' ? nav.getBoundingClientRect() : null;
  const top = navBounds && navBounds.top < viewportBottom && navBounds.bottom > viewportTop
    ? Math.max(viewportTop, navBounds.bottom) : viewportTop;
  const visible = visibleMessageRows(list, bottom, top)
    .filter((node) => Number(node.dataset.sequence) > readThrough).at(-1);
  if (!visible) return;
  const token = generation, selected = roomId; readBusy = true;
  try {
    const result = await api.markRead(centerId, selected, visible.dataset.messageId, lifetime.signal);
    if (live(token) && roomId === selected) readThrough = result.lastRead;
  } catch (error) {
    if (live(token) && ['AUTH_REQUIRED', 'NOT_FOUND', 'FORBIDDEN'].includes(error?.code)) denied(error);
  } finally { if (live(token)) readBusy = false; }
}
async function logout() {
  if (!['workspace', 'operations', 'approval-pending', 'logout-failed'].includes(phase)) return;
  clearSession(); phase = 'logging-out'; app.innerHTML = '<p role="status">로그아웃을 확인하고 있어요…</p>'; announce('');
  const token = generation;
  try {
    await api.logout(lifetime.signal); if (token !== generation) return;
    showLogin('로그아웃했어요. 이 창의 대화와 입력 내용도 지웠습니다.');
  } catch (error) {
    if (token !== generation) return;
    if (error?.code === 'AUTH_REQUIRED') { showLogin('다른 창에서 계정이 변경되었거나 세션이 종료되었어요. 다시 로그인해 주세요.'); return; }
    phase = 'logout-failed'; app.innerHTML = `<section class="login" data-testid="logout-error"><h1>로그아웃 확인이 필요해요</h1>
      <p>이 창의 대화와 입력은 지웠지만, 서버의 세션 종료는 확인하지 못했습니다.</p><button type="button" class="primary">로그아웃 다시 시도</button></section>`;
    app.querySelector('button').addEventListener('click', () => { void logout(); }); announce(errorMessage(error));
  }
}
function suspend() {
  selfProfileOpening = null; selfProfile?.suspend();
  if (phase === 'email-login') { emailLoginUi?.suspend(); return; }
  if (phase === 'approval-pending') { approvalPending?.suspend(); return; }
  if (phase === 'operations') { operations?.suspend(); return; }
  if (phase !== 'workspace') return;
  // Aborted POSTs may have committed. Preserve their immutable request IDs.
  const key = draftKey(), operation = drafts.get(key).operation;
  if (operation) drafts.failed(key, operation);
  invalidate(); resetProjections({ recovery: navigator.onLine ? 'rechecking' : 'offline' });
  announce('연결과 열람 권한을 다시 확인합니다. 이 창에 남아 있는 입력은 권한이 유지되는 경우에만 이어 쓸 수 있어요.');
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') suspend(); else void refresh();
});
window.addEventListener('offline', suspend);
window.addEventListener('online', () => { void refresh(); });
window.addEventListener('focus', () => { void refresh(); });
window.addEventListener('scroll', tryRead, { passive: true });
window.addEventListener('resize', tryRead, { passive: true });
window.addEventListener('resize', resizeChatViewport, { passive: true });
window.visualViewport?.addEventListener('resize', resizeChatViewport, { passive: true });
window.addEventListener('pagehide', () => { clearSession(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });
setInterval(() => { void refresh(); }, 5000);

try { showWorkspace(await api.session(lifetime.signal)); await refresh(); }
catch (error) { showLogin(error?.code === 'AUTH_REQUIRED' ? '' : errorMessage(error)); }
