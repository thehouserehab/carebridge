import { MEDIA_LIMITS, MEDIA_TYPES } from '../src/media-policy.js';

// This transport does not import the prototype's whole-database repository.
// The server authenticates every request; no role, token or content is persisted
// in browser storage. The local-only launcher is the sole host of these assets.
const MESSAGES = Object.freeze({
  AUTH_REQUIRED: '로그인이 필요합니다.',
  AUTH_INVALID: '시험 이메일 또는 비밀번호를 확인해 주세요.',
  EMAIL_LOGIN_INVALID: '인증번호를 확인하거나 새 번호를 요청해 주세요.',
  NOT_FOUND: '대화에 대한 접근 권한이 변경되었어요. 허용된 대화만 다시 불러와 주세요.',
  FORBIDDEN: '요청을 허용할 수 없습니다. 시험 화면을 다시 열어 주세요.',
  INVALID_INPUT: '입력 내용을 확인해 주세요.',
  INVITATION_INVALID: '사용할 수 없는 초대입니다. 만료·철회 또는 처리 여부를 확인해 주세요.',
  PASSWORD_RECOVERY_INVALID: '사용할 수 없는 재설정 링크입니다. 새 안내를 요청해 주세요.',
  PASSWORD_UNCHANGED: '기존 비밀번호와 다른 새 비밀번호를 입력해 주세요.',
  PASSWORD_CONFIRMATION_MISMATCH: '새 비밀번호와 확인 값이 일치하지 않습니다.',
  ACCOUNT_SESSION_PRESENT: '이미 로그인된 계정이 있습니다. 현재 계정 연결 또는 명시적인 로그아웃을 선택해 주세요.',
  INVITATION_ACCOUNT_EXISTS: '이 초대는 기존 계정으로 로그인한 뒤 연결해 주세요.',
  INVITATION_MEMBERSHIP_UNAVAILABLE: '이 계정의 현재 센터 역할과 상태를 확인해야 합니다. 운영자에게 문의해 주세요.',
  INVITATION_CONFLICT: '계정 등록 결과를 확인해야 합니다. 먼저 일반 로그인을 시도해 주세요.',
  INVITATION_NOT_PENDING: '이미 처리되거나 철회된 초대입니다. 목록에서 현재 상태를 확인해 주세요.',
  INVITATION_LIST_LIMIT: '초대 조회 한도를 넘었습니다. 일부 내역만 표시하지 않았습니다.',
  IDEMPOTENCY_CONFLICT: '같은 전송 번호의 내용이 달라 확인이 필요합니다. 새 메시지로 다시 보내지 마세요.',
  MESSAGE_CONFLICT: '다른 화면에서 소식이 바뀌었어요. 입력을 보존한 채 최신 내용을 확인해 주세요.',
  MESSAGE_DELETED: '이미 삭제된 소식입니다. 수정하거나 새 답장을 보낼 수 없어요.',
  MESSAGE_CHANGE_EXPIRED: '소식을 수정하거나 모두에게서 삭제할 수 있는 시간이 지났어요.',
  RECORD_CONFLICT: '다른 화면에서 기록이 바뀌었어요. 입력을 보관한 채 최신 기록을 확인해 주세요.',
  GOAL_CONFLICT: '다른 화면에서 목표가 바뀌었어요. 입력을 보존한 채 최신 목표를 확인해 주세요.',
  APPOINTMENT_CONFLICT: '다른 화면에서 일정이 바뀌었어요. 입력을 보존한 채 최신 일정을 확인해 주세요.',
  SCHEDULE_CONFLICT: '다른 일정과 시간이 겹쳐 저장하지 않았어요. 입력을 보존한 채 시간과 장소를 확인해 주세요.',
  THERAPIST_UNAVAILABLE: '현재 연결된 치료사를 확인할 수 없어 저장하지 않았어요. 입력을 보존한 채 담당 연결을 확인해 주세요.',
  CHILD_EXISTS: '같은 등록 번호의 아이 또는 대화가 이미 있어요. 입력을 보존한 채 등록 결과를 확인해 주세요.',
  RELATIONSHIP_CONFLICT: '다른 화면에서 담당 관계가 바뀌었어요. 선택을 보존한 채 최신 연결과 열람 범위를 확인해 주세요.',
  PRIMARY_COMMUNICATOR_CONFLICT: '주 소통자 설정이 바뀌었어요. 최신 설정을 다시 확인해 주세요.',
  PARTICIPANT_UNAVAILABLE: '선택한 구성원의 현재 연결 가능 여부가 바뀌었어요. 목록을 다시 확인해 주세요.',
  HISTORY_CHOICE_REQUIRED: '새 연결 또는 재연결의 열람 범위를 다시 선택해 주세요.',
  HISTORY_CONFIRMATION_REQUIRED: '연결할 구성원과 기존 소식의 열람 범위를 확인해 주세요.',
  PAST_HISTORY_CONFIRMATION_REQUIRED: '과거 소식을 추가 공개할 구성원을 별도로 확인해 주세요.',
  SEQUENCE_LIMIT: '소식 처리 한도에 도달했어요. 선택을 보존한 채 운영자에게 문의해 주세요.',
  RECIPIENTS_CHANGED: '공유 대상이 바뀌었어요. 수신자를 다시 확인한 뒤 공유해 주세요.',
  REFERENCE_CHANGED: '참고한 소식이 수정되었어요. 현재 내용과 참고 버전을 다시 확인해 주세요.',
  CONTEXT_CHANGED: '연결된 목표나 일정이 바뀌었어요. 최신 내용을 확인해 주세요.',
  FEEDBACK_CONFLICT: '가정 피드백이 다른 화면에서 바뀌었어요. 최신 내용을 확인해 주세요.',
  REVIEW_CONFLICT: '임상 검토가 다른 화면에서 바뀌었어요. 최신 내용을 확인해 주세요.',
  PROFILE_CONFLICT: '가족이 바라는 변화가 다른 화면에서 바뀌었어요. 입력을 보존한 채 최신 내용을 확인해 주세요.',
  REVISION_LIMIT: '변경 횟수 한도에 도달했어요. 입력을 보존한 채 운영자에게 문의해 주세요.',
  PUBLICATION_CLOSED: '공유가 종료되어 새로운 답변을 받을 수 없어요.',
  RECORD_NOT_SHAREABLE: '기록을 정식 저장하고 보호자용 요약을 작성해 주세요.',
  NO_RECIPIENT: '현재 공유할 보호자가 연결되어 있지 않아요.',
  NO_ACTIVITY: '이 공유본에는 가정 활동이 없어요.',
  ATTACHMENTS_NOT_CONNECTED: '첨부 전송은 아직 이 시험 서버에 연결되지 않아 변경하지 않았어요.',
  ATTACHMENT_NOT_READY: '파일 검사가 아직 완료되지 않았어요. 상태를 확인한 뒤 다시 시도해 주세요.',
  ATTACHMENT_ORIGIN_CONFLICT: '이미 다른 자료에 연결된 파일이에요. 전송 내용을 확인해 주세요.',
  ATTACHMENT_LIMIT: '첨부 개수나 합계 용량 한도를 확인해 주세요.',
  MEDIA_READ_BUSY: '다른 파일을 불러오는 중이에요. 잠시 후 다시 시도해 주세요.',
  UPLOAD_CONFLICT: '업로드 상태가 바뀌었어요. 파일을 유지한 채 상태를 먼저 갱신해 주세요.',
  UPLOAD_STATE: '현재 상태에서는 파일을 다시 올릴 수 없어요. 상태를 갱신해 주세요.',
  UPLOAD_EXPIRED: '임시 업로드가 만료되었어요. 취소 상태를 확인해 주세요.',
  FILE_IN_USE: '이미 연결된 파일은 임시 업로드 화면에서 취소할 수 없어요.',
  UPLOAD_QUOTA: '대기 중인 파일의 개수나 용량 한도에 도달했어요. 기존 업로드를 먼저 취소해 주세요.',
  MEDIA_RESOURCES_UNCONFIGURED: '서버의 업로드 용량 설정을 확인해야 합니다.',
  CENTER_MEDIA_PAUSED: '서버에서 업로드를 잠시 중단했어요.',
  CENTER_MEDIA_RATE: '시험용 시간당 업로드 횟수에 도달했어요. 잠시 후 다시 시도해 주세요.',
  CENTER_MEDIA_CAPACITY: '시험 서버의 예약 용량이 부족해요. 기존 업로드를 먼저 취소해 주세요.',
  CENTER_MEDIA_BACKLOG: '시험 서버의 검사 대기 한도에 도달했어요. 기존 업로드를 먼저 취소해 주세요.',
  UPLOAD_BUSY: '다른 파일을 받는 중이에요. 선택 파일을 유지한 채 잠시 후 다시 시도해 주세요.',
  EMPTY_RECORD: '기록할 내용을 입력해 주세요.',
  CONTEXT_NOT_FOUND: '연결된 목표나 일정을 찾을 수 없어요.',
  APPOINTMENT_RECORD_EXISTS: '이 일정에는 이미 기록이 연결되어 있어요.',
  RECORD_IMPORT_REQUIRED: '이전 형식의 기록은 이 시험 화면에서 수정하지 않습니다.',
  UNAVAILABLE: '서버 연결을 확인할 수 없어요. 잠시 후 다시 시도해 주세요.',
  INVALID_RESPONSE: '서버 응답을 확인할 수 없어요. 화면을 새로고침해 주세요.',
  SNAPSHOT_CHANGED: '대화가 갱신 중이에요. 잠시 후 다시 불러와 주세요.',
  TOO_MUCH_DATA: '이 시험 화면의 조회 한도를 넘었어요. 일부 대화만 표시하지 않았습니다.',
  CANCELLED: '요청을 중단했습니다.',
});
export const LOCAL_MEDIA_CONFLICT_CODES = Object.freeze(['UPLOAD_CONFLICT', 'UPLOAD_STATE', 'UPLOAD_EXPIRED', 'FILE_IN_USE', 'UPLOAD_QUOTA',
  'MEDIA_RESOURCES_UNCONFIGURED', 'CENTER_MEDIA_PAUSED', 'CENTER_MEDIA_RATE', 'CENTER_MEDIA_CAPACITY', 'CENTER_MEDIA_BACKLOG', 'UPLOAD_BUSY',
  'MEDIA_READ_BUSY', 'ATTACHMENT_NOT_READY', 'ATTACHMENT_ORIGIN_CONFLICT', 'ATTACHMENT_LIMIT']);
const CONFLICT_CODES = new Set([...LOCAL_MEDIA_CONFLICT_CODES, 'IDEMPOTENCY_CONFLICT', 'RECORD_CONFLICT', 'GOAL_CONFLICT',
  'APPOINTMENT_CONFLICT', 'SCHEDULE_CONFLICT', 'THERAPIST_UNAVAILABLE', 'RECIPIENTS_CHANGED',
  'CHILD_EXISTS', 'RELATIONSHIP_CONFLICT', 'PARTICIPANT_UNAVAILABLE', 'HISTORY_CHOICE_REQUIRED',
  'PRIMARY_COMMUNICATOR_CONFLICT',
  'HISTORY_CONFIRMATION_REQUIRED', 'PAST_HISTORY_CONFIRMATION_REQUIRED', 'SEQUENCE_LIMIT',
  'REFERENCE_CHANGED', 'CONTEXT_CHANGED', 'FEEDBACK_CONFLICT', 'REVIEW_CONFLICT', 'PROFILE_CONFLICT', 'REVISION_LIMIT', 'PUBLICATION_CLOSED',
  'RECORD_NOT_SHAREABLE', 'NO_RECIPIENT', 'NO_ACTIVITY', 'ATTACHMENTS_NOT_CONNECTED', 'EMPTY_RECORD',
  'CONTEXT_NOT_FOUND', 'APPOINTMENT_RECORD_EXISTS', 'RECORD_IMPORT_REQUIRED',
  'MESSAGE_CONFLICT', 'MESSAGE_DELETED', 'MESSAGE_CHANGE_EXPIRED',
  'ACCOUNT_SESSION_PRESENT', 'INVITATION_ACCOUNT_EXISTS',
  'INVITATION_MEMBERSHIP_UNAVAILABLE', 'INVITATION_CONFLICT', 'INVITATION_NOT_PENDING', 'INVITATION_LIST_LIMIT']);
export class LocalApiError extends Error {
  constructor(code, status = 0) {
    super(MESSAGES[code] ?? MESSAGES.UNAVAILABLE);
    this.name = 'LocalApiError'; this.code = code; this.status = status;
  }
}
// Only for a message-send outcome. bindAttachments rejects these four states
// before COMMIT; the enclosing transaction rolls back the message and bindings.
// Do not generalize all media conflicts into safe retry-with-new-content errors.
// MessageDrafts.rejected still retains any operation with an earlier unknown
// outcome, even when the current attempt returns one of these exact errors.
const MESSAGE_BIND_REJECTIONS = new Set(['UPLOAD_EXPIRED', 'ATTACHMENT_NOT_READY', 'ATTACHMENT_ORIGIN_CONFLICT', 'ATTACHMENT_LIMIT']);
export function isRejectedMessageSend(error) {
  if (!(error instanceof LocalApiError)) return false;
  // Status zero is the client's synchronous pre-request path/attachment check.
  if (error.code === 'INVALID_INPUT') return [0, 400, 413].includes(error.status);
  return error.status === 409 && MESSAGE_BIND_REJECTIONS.has(error.code);
}
const invalid = () => { throw new LocalApiError('INVALID_RESPONSE'); };
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = (v) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const pathId = (v) => { if (!id(v)) throw new LocalApiError('INVALID_INPUT'); return v; };
const role = (v) => ['therapist', 'guardian', 'center', 'care_recipient'].includes(v);
function userResult(value) {
  const u = value?.user;
  if (!object(u) || !id(u.userId) || typeof u.email !== 'string' ||
      !Array.isArray(u.centers) || !u.centers.every((c) => object(c) && id(c.id) && role(c.role)) ||
      !Number.isFinite(Date.parse(u.expiresAt))) invalid();
  return { userId: u.userId, email: u.email, centers: u.centers.map((c) => ({ id: c.id, role: c.role })), expiresAt: u.expiresAt };
}
function message(value) {
  if (!object(value) || !id(value.id) || !id(value.conversationId) || !id(value.childId) ||
      !count(value.sequence) || value.sequence < 1 || !(value.authorId === null || id(value.authorId)) ||
      typeof value.body !== 'string' || !['text', 'publication', 'feedback'].includes(value.type) ||
      typeof value.read !== 'boolean' || !Number.isFinite(Date.parse(value.createdAt))) invalid();
  if (Object.hasOwn(value, 'attachments')) {
    const files = value.attachments;
    if (!Array.isArray(files) || files.length > MEDIA_LIMITS.count ||
        new Set(files.map((file) => file?.id)).size !== files.length ||
        !files.every((file) => object(file) && Object.keys(file).every((key) => ['id', 'name', 'type', 'size'].includes(key)) &&
          uuid(file.id) && typeof file.name === 'string' && !!file.name.trim() && file.name === file.name.trim() &&
          file.name.length <= 255 && file.name.isWellFormed() && !/[\x00-\x1f\x7f/\\]/.test(file.name) &&
          MEDIA_TYPES.includes(file.type) && Number.isSafeInteger(file.size) && file.size > 0 &&
          file.size <= (file.type.startsWith('image/') ? MEDIA_LIMITS.image : MEDIA_LIMITS.video)) ||
        files.reduce((sum, file) => sum + file.size, 0) > MEDIA_LIMITS.total ||
        ((value.hidden || value.deleted) && files.length) ||
        (Object.hasOwn(value, 'attachmentCount') && value.attachmentCount !== files.length)) invalid();
  }
  return value;
}
function attachmentIds(files) {
  if (!Array.isArray(files) || files.length > MEDIA_LIMITS.count ||
      new Set(files.map((file) => file?.id)).size !== files.length ||
      !Array.from(files).every((file) => object(file) && Reflect.ownKeys(file).length === 1 && Object.hasOwn(file, 'id') && uuid(file.id))) {
    throw new LocalApiError('INVALID_INPUT');
  }
  // Never send the source hash, object key, name, role or mutable server state.
  return files.map(({ id }) => ({ id }));
}
function changeReceipt(value, messageId, operation) {
  const r = value?.receipt;
  if (!object(r) || r.messageId !== messageId || !count(r.revision) || r.revision < 1 ||
      r.operation !== operation || typeof r.replayed !== 'boolean') invalid();
  return { messageId: r.messageId, revision: r.revision, operation: r.operation, replayed: r.replayed };
}
function query(input) {
  const values = Object.entries(input).filter(([, value]) => value !== undefined);
  const q = new URLSearchParams(values.map(([key, value]) => [key, String(value)]));
  return q.size ? `?${q}` : '';
}
const ownDataKeys = (value, allowed, required = allowed) => object(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key) &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) && required.every(key => Object.hasOwn(value, key));
const messageKeys = ['id', 'conversationId', 'childId', 'sequence', 'authorId', 'createdAt', 'type', 'body',
  'read', 'edited', 'hidden', 'deleted', 'archived', 'version', 'canReply', 'reviewed', 'canEdit', 'canDeleteAll', 'canHide',
  'attachmentCount', 'attachments', 'publication', 'feedback', 'quote'];
function timelineSelector(value) {
  const directions = ['before', 'after', 'from', 'around'];
  if (!ownDataKeys(value, [...directions, 'expectedRevision'], []) ||
      directions.filter(key => Object.hasOwn(value, key)).length > 1 ||
      Object.entries(value).some(([key, item]) => key === 'around' ? !id(item) : !count(item)))
    throw new LocalApiError('INVALID_INPUT');
  return { ...value };
}
function messageBatch(values, roomId) {
  if (!Array.isArray(values) || values.length > 100) invalid();
  const ids = new Set(); let previous = 0, childId = null;
  for (let index = 0; index < values.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid();
    const value = descriptor.value;
    if (!ownDataKeys(value, messageKeys, []) || message(value).conversationId !== roomId ||
        ids.has(value.id) || value.sequence <= previous || childId !== null && value.childId !== childId) invalid();
    ids.add(value.id); previous = value.sequence; childId = value.childId;
  }
  return values;
}
export class LocalApiClient {
  constructor({ fetch: request = globalThis.fetch.bind(globalThis), timeoutMs = 10000 } = {}) {
    this.fetch = request; this.timeoutMs = timeoutMs; this.expectedUserId = null;
  }
  clearIdentity() { this.expectedUserId = null; }
  async request(path, { body, signal } = {}) {
    if (!path.startsWith('/api/local/') || path.includes('://')) throw new LocalApiError('INVALID_INPUT');
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    try {
      // Cookies can change in another tab. This is a precondition, NOT an
      // identity source: the server still authenticates its HttpOnly cookie.
      const publicAuth = ['/api/local/auth/login', '/api/local/auth/invitations/preview', '/api/local/auth/invitations/accept',
        '/api/local/auth/password-recovery/request', '/api/local/auth/password-recovery/complete',
        '/api/local/auth/email-login/start', '/api/local/auth/email-login/request', '/api/local/auth/email-login/verify'].includes(path);
      const account = this.expectedUserId && !publicAuth
        ? { 'X-Carebridge-Account': this.expectedUserId } : {};
      const response = await this.fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: body === undefined ? { Accept: 'application/json', ...account } : {
          Accept: 'application/json', 'Content-Type': 'application/json', 'X-Carebridge-Request': '1', ...account,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      });
      if (signal?.aborted) throw new LocalApiError('CANCELLED');
      let result = null;
      if (response.status !== 204) {
        if (!response.headers.get('content-type')?.startsWith('application/json')) invalid();
        try { result = await response.json(); } catch { invalid(); }
      }
      if (signal?.aborted) throw new LocalApiError('CANCELLED');
      if (!response.ok) {
        const code = response.status === 401 ? (['AUTH_INVALID', 'EMAIL_LOGIN_INVALID'].includes(result?.error) ? result.error : 'AUTH_REQUIRED')
          : response.status === 404 ? 'NOT_FOUND'
          : response.status === 403 ? 'FORBIDDEN'
          : response.status === 400 && ['PASSWORD_UNCHANGED', 'PASSWORD_CONFIRMATION_MISMATCH'].includes(result?.error) ? result.error
          : response.status === 400 || response.status === 413 ? 'INVALID_INPUT'
          : response.status === 409 ? (CONFLICT_CODES.has(result?.error) ? result.error : 'IDEMPOTENCY_CONFLICT')
          : response.status === 410 && ['INVITATION_INVALID', 'PASSWORD_RECOVERY_INVALID'].includes(result?.error) ? result.error : 'UNAVAILABLE';
        throw new LocalApiError(code, response.status);
      }
      return result;
    } catch (error) {
      if (signal?.aborted) throw new LocalApiError('CANCELLED');
      if (error instanceof LocalApiError) throw error;
      throw new LocalApiError('UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
  async login(email, password, signal) {
    const user = userResult(await this.request('/api/local/auth/login', { body: { email, password }, signal }));
    this.expectedUserId = user.userId; return user;
  }
  async session(signal) {
    const user = userResult(await this.request('/api/local/auth/session', { signal }));
    if (this.expectedUserId && user.userId !== this.expectedUserId) throw new LocalApiError('AUTH_REQUIRED', 401);
    this.expectedUserId = user.userId; return user;
  }
  async emailLoginVerify(body, signal) {
    if (this.expectedUserId !== null) throw new LocalApiError('ACCOUNT_SESSION_PRESENT', 409);
    const user = userResult(await this.request('/api/local/auth/email-login/verify', { body, signal }));
    if (this.expectedUserId !== null) throw new LocalApiError('AUTH_REQUIRED', 401);
    this.expectedUserId = user.userId; return user;
  }
  logout(signal) { return this.request('/api/local/auth/logout', { body: {}, signal }); }
  centerPath(centerId) { return `/api/local/centers/${pathId(centerId)}`; }
  roomPath(centerId, roomId) { return `${this.centerPath(centerId)}/conversations/${pathId(roomId)}`; }
  async profile(centerId, roomId, signal) {
    const p = await this.request(`${this.roomPath(centerId, roomId)}/profile`, { signal });
    if (!object(p) || p.conversationId !== roomId || !id(p.childId) || !(p.name === null || typeof p.name === 'string') ||
        !Array.isArray(p.participants) || !p.participants.every((v) => object(v) && id(v.userId) && role(v.role) &&
          (v.displayName === null || typeof v.displayName === 'string'))) invalid();
    return p;
  }
  async inbox(centerId, signal) {
    return (await this.#inboxSnapshot(centerId, signal)).items;
  }
  async #inboxSnapshot(centerId, signal) {
    return collectPageSnapshot(async (cursor, snapshot) => {
      const p = await this.request(`${this.centerPath(centerId)}/inbox${query({ limit: 100, offset: cursor, expectedSnapshot: snapshot })}`, { signal });
      if (!object(p) || typeof p.snapshot !== 'string' || !/^[a-f0-9]{32}$/.test(p.snapshot) || typeof p.resetRequired !== 'boolean') invalid();
      if (p.resetRequired) return { reset: true };
      if (!Array.isArray(p.rooms) || !p.rooms.every((r) => object(r) && id(r.conversationId) && id(r.childId) && count(r.unread) &&
          (r.targetId === null || id(r.targetId)) && (r.latest === null || (object(r.latest) && typeof r.latest.body === 'string'))) ||
          typeof p.hasMore !== 'boolean' || !count(p.nextOffset)) invalid();
      return { items: p.rooms, cursor: p.nextOffset, snapshot: p.snapshot, more: p.hasMore };
    });
  }
  async workspace(centerId, selectedRoomId, signal, { readRelated, timeline } = {}) {
    this.centerPath(centerId);
    if (selectedRoomId !== null) pathId(selectedRoomId);
    let selection = timeline === undefined ? undefined : timelineSelector(timeline);
    let targetUnavailable = false;
    const restartWindow = () => {
      const { expectedRevision: ignored, ...position } = selection;
      selection = position;
    };
    const expectedUserId = this.expectedUserId;
    const assertCurrent = () => {
      if (signal?.aborted) throw new LocalApiError('CANCELLED');
      if (this.expectedUserId !== expectedUserId) throw new LocalApiError('AUTH_REQUIRED', 401);
    };
    // The inbox token detects room revision/history-boundary/role changes; it
    // is not authorization or an atomic snapshot of every profile field.
    for (let attempt = 0; attempt < 3; attempt++) {
      assertCurrent();
      const before = await this.#inboxSnapshot(centerId, signal);
      assertCurrent();
      if (selectedRoomId !== null && !before.items.some((r) => r.conversationId === selectedRoomId)) {
        throw new LocalApiError('NOT_FOUND', 404);
      }
      const rooms = [];
      for (const room of before.items) {
        const profile = await this.profile(centerId, room.conversationId, signal);
        assertCurrent();
        if (profile.childId !== room.childId) invalid();
        rooms.push({ ...room, profile });
      }
      const selectedRoom = rooms.find((r) => r.conversationId === selectedRoomId);
      const profile = selectedRoom?.profile ?? null;
      let page = null;
      if (selectedRoomId !== null && selection !== undefined) {
        try { page = await this.messageWindow(centerId, selectedRoomId, selection, signal); }
        catch (error) {
          assertCurrent();
          if (!Object.hasOwn(selection, 'around') || !(error instanceof LocalApiError) ||
              error.code !== 'NOT_FOUND' || error.status !== 404) throw error;
          // A missing exact message is not proof that the whole room was
          // revoked. Discard this attempt and reauthorize every projection
          // from a fresh inbox. The explicit result flag lets the UI explain
          // the unavailable target instead of silently changing its intent.
          targetUnavailable = true;
          selection = {};
          continue;
        }
      }
      assertCurrent();
      if (page?.resetRequired) { restartWindow(); continue; }
      const messages = page ? page.messages : selectedRoomId === null ? [] : await this.messages(centerId, selectedRoomId, signal);
      assertCurrent();
      if (page) {
        if (!count(selectedRoom.revision) || messages.some(item => item.childId !== profile.childId)) invalid();
        if (page.revision !== selectedRoom.revision) { restartWindow(); continue; }
      }
      // Additional product projections belong INSIDE this same revision
      // bracket. Never combine them with an earlier cached inbox on failure.
      if (readRelated) for (const room of rooms) {
        room.care = await readRelated(room, room.conversationId === selectedRoomId ? messages : null);
        assertCurrent();
      }
      const after = await this.#inboxSnapshot(centerId, signal);
      assertCurrent();
      if (before.snapshot === after.snapshot) return { rooms, profile, messages,
        ...(targetUnavailable ? { targetUnavailable: true } : {}),
        ...(selection === undefined ? {} : { timelineWindow: page ? {
          revision: page.revision, lastRead: page.lastRead, unread: page.unread, window: page.window,
        } : null }) };
      if (selection !== undefined) restartWindow();
    }
    throw new LocalApiError('SNAPSHOT_CHANGED');
  }
  async messages(centerId, roomId, signal) {
    return collectPages(async (cursor, revision) => {
      const p = await this.request(`${this.roomPath(centerId, roomId)}/messages${query({ limit: 100, after: cursor, expectedRevision: revision })}`, { signal });
      if (!object(p) || !count(p.revision) || typeof p.resetRequired !== 'boolean') invalid();
      if (p.resetRequired) return { reset: true };
      if (!Array.isArray(p.messages) || typeof p.hasMore !== 'boolean' || !count(p.nextCursor)) invalid();
      p.messages.forEach((m) => { message(m); if (m.conversationId !== roomId) invalid(); });
      return { items: p.messages, cursor: p.nextCursor, snapshot: p.revision, more: p.hasMore };
    });
  }
  // One bounded, freshly authorized window, not a replacement for the legacy
  // whole-history collector. Never append pages from different revisions.
  async messageWindow(centerId, roomId, selector = {}, signal) {
    const path = this.roomPath(centerId, roomId), selection = timelineSelector(selector), account = this.expectedUserId;
    const current = () => {
      if (signal?.aborted) throw new LocalApiError('CANCELLED');
      if (this.expectedUserId !== account) throw new LocalApiError('AUTH_REQUIRED', 401);
    };
    current();
    const page = await this.request(`${path}/messages${query({ view: 'timeline', limit: 100, ...selection })}`, { signal });
    current();
    if (!object(page) || !count(page.revision) || typeof page.resetRequired !== 'boolean') invalid();
    if (page.resetRequired) {
      if (!ownDataKeys(page, ['revision', 'resetRequired']) || selection.expectedRevision === undefined ||
          page.revision === selection.expectedRevision) invalid();
      return { revision: page.revision, resetRequired: true };
    }
    if (!ownDataKeys(page, ['messages', 'revision', 'lastRead', 'unread', 'resetRequired', 'window']) ||
        !count(page.lastRead) || !count(page.unread) ||
        selection.expectedRevision !== undefined && page.revision !== selection.expectedRevision ||
        !ownDataKeys(page.window, ['hasOlder', 'hasNewer', 'startCursor', 'endCursor']) ||
        typeof page.window.hasOlder !== 'boolean' || typeof page.window.hasNewer !== 'boolean' ||
        !count(page.window.startCursor) || !count(page.window.endCursor)) invalid();
    const values = messageBatch(page.messages, roomId), first = values[0]?.sequence ?? 0, last = values.at(-1)?.sequence ?? 0;
    if (page.window.startCursor !== first || page.window.endCursor !== last ||
        values.some(item => selection.before !== undefined && item.sequence >= selection.before ||
          selection.after !== undefined && item.sequence <= selection.after ||
          selection.from !== undefined && item.sequence < selection.from) ||
        selection.around !== undefined && !values.some(item => item.id === selection.around) ||
        !['before', 'after', 'from', 'around'].some(key => Object.hasOwn(selection, key)) && page.window.hasNewer) invalid();
    return { messages: values, revision: page.revision, lastRead: page.lastRead, unread: page.unread,
      resetRequired: false, window: { ...page.window } };
  }
  // Active shared cards are independent of the selected chat window. Keep the
  // existing finite pagination cap; no full-history or unlimited fallback.
  async activePublications(centerId, roomId, signal) {
    const path = this.roomPath(centerId, roomId), account = this.expectedUserId;
    let childId = null; const seen = new Set();
    const current = () => {
      if (signal?.aborted) throw new LocalApiError('CANCELLED');
      if (this.expectedUserId !== account) throw new LocalApiError('AUTH_REQUIRED', 401);
    };
    return collectPages(async (cursor, revision) => {
      current();
      if (revision === undefined) { childId = null; seen.clear(); }
      const page = await this.request(`${path}/messages${query({ view: 'publications', limit: 100, after: cursor, expectedRevision: revision })}`, { signal });
      current();
      if (!object(page) || !count(page.revision) || typeof page.resetRequired !== 'boolean') invalid();
      if (page.resetRequired) {
        if (!ownDataKeys(page, ['revision', 'resetRequired']) || revision === undefined || page.revision === revision) invalid();
        return { reset: true };
      }
      if (!ownDataKeys(page, ['messages', 'revision', 'lastRead', 'unread', 'resetRequired', 'nextCursor', 'hasMore']) ||
          !count(page.lastRead) || !count(page.unread) || !count(page.nextCursor) || typeof page.hasMore !== 'boolean') invalid();
      const values = messageBatch(page.messages, roomId);
      if (page.nextCursor !== (values.at(-1)?.sequence ?? cursor)) invalid();
      for (const value of values) {
        if (value.sequence <= cursor || seen.has(value.id) || value.type !== 'publication' ||
            value.hidden !== false || value.deleted !== false || value.archived !== false || !object(value.publication) ||
            childId !== null && value.childId !== childId) invalid();
        childId = value.childId; seen.add(value.id);
      }
      return { items: values, cursor: page.nextCursor, snapshot: page.revision, more: page.hasMore };
    });
  }
  async send(centerId, roomId, operation, signal) {
    const attachments = operation.attachments === undefined ? undefined : attachmentIds(operation.attachments);
    const result = await this.request(`${this.roomPath(centerId, roomId)}/messages`, {
      body: { clientId: operation.clientId, body: operation.body,
        ...(operation.replyTo === undefined ? {} : { replyTo: operation.replyTo }),
        ...(operation.expectedReplyRevision === undefined ? {} : { expectedReplyRevision: operation.expectedReplyRevision }),
        ...(operation.expectedReplyVersion === undefined ? {} : { expectedReplyVersion: operation.expectedReplyVersion }),
        ...(attachments === undefined ? {} : { attachments }),
      }, signal,
    });
    const m = message(result?.message); if (m.conversationId !== roomId) invalid(); return m;
  }
  async message(centerId, roomId, messageId, signal) {
    const result = await this.request(`${this.roomPath(centerId, roomId)}/messages/${pathId(messageId)}`, { signal });
    const m = message(result?.message); if (m.id !== messageId || m.conversationId !== roomId) invalid(); return m;
  }
  async messageEdit(centerId, roomId, messageId, operation, signal) {
    return changeReceipt(await this.request(`${this.roomPath(centerId, roomId)}/messages/${pathId(messageId)}/edit`, {
      body: { clientId: operation.clientId, expectedRevision: operation.expectedRevision, body: operation.body }, signal,
    }), messageId, 'edit');
  }
  async messageDelete(centerId, roomId, messageId, operation, signal) {
    if (!['self', 'all'].includes(operation.scope)) throw new LocalApiError('INVALID_INPUT');
    return changeReceipt(await this.request(`${this.roomPath(centerId, roomId)}/messages/${pathId(messageId)}/delete`, {
      body: { clientId: operation.clientId, scope: operation.scope, confirmed: operation.confirmed,
        ...(operation.expectedRevision === undefined ? {} : { expectedRevision: operation.expectedRevision }) }, signal,
    }), messageId, operation.scope);
  }
  async markRead(centerId, roomId, messageId, signal) {
    const result = await this.request(`${this.roomPath(centerId, roomId)}/read`, { body: { messageId }, signal });
    if (!count(result?.lastRead)) invalid(); return result;
  }
}

// Replace a projection only after all pages belong to one revision. Never
// merge an invalidated old history range into a new relationship boundary.
export async function collectPages(loadPage, { maxPages = 20, maxRestarts = 2 } = {}) {
  return (await collectPageSnapshot(loadPage, { maxPages, maxRestarts })).items;
}
async function collectPageSnapshot(loadPage, { maxPages = 20, maxRestarts = 2 } = {}) {
  for (let restart = 0; restart <= maxRestarts; restart++) {
    let cursor = 0, snapshot; const items = [];
    for (let page = 0; page < maxPages; page++) {
      const result = await loadPage(cursor, snapshot);
      if (result.reset) break;
      if (snapshot !== undefined && result.snapshot !== snapshot) invalid();
      snapshot = result.snapshot;
      items.push(...result.items);
      if (!result.more) return { items, snapshot };
      if (!count(result.cursor) || result.cursor <= cursor || !result.items.length) invalid();
      cursor = result.cursor;
      if (page === maxPages - 1) throw new LocalApiError('TOO_MUCH_DATA');
    }
  }
  throw new LocalApiError('SNAPSHOT_CHANGED');
}

// An ambiguous response must reuse body, attachment IDs and clientId. Drafts exist only
// in this tab's memory; explicit logout, account change or reload drops them.
export class MessageDrafts {
  #drafts = new Map();
  #ambiguous = new WeakSet();
  constructor(createId = () => crypto.randomUUID()) { this.createId = createId; }
  get(key) { return this.#drafts.get(key) ?? { body: '', operation: null, sending: false, uncertain: false }; }
  edit(key, body) {
    const draft = this.get(key); if (draft.operation) return false;
    this.#drafts.set(key, { ...draft, body, rejected: false }); return true;
  }
  begin(key, attachments = []) {
    const draft = this.get(key);
    if (draft.sending) return null;
    let operation = draft.operation;
    if (!operation) {
      const files = attachmentIds(attachments);
      if (!draft.body.trim() && !files.length) return null;
      operation = Object.freeze({ clientId: this.createId(), body: draft.body,
        ...(files.length ? { attachments: Object.freeze(files.map((file) => Object.freeze(file))) } : {}) });
    }
    this.#drafts.set(key, { ...draft, operation, sending: true, uncertain: false, rejected: false }); return operation;
  }
  failed(key, operation) {
    const draft = this.get(key); if (draft.operation !== operation) return;
    this.#ambiguous.add(operation);
    this.#drafts.set(key, { ...draft, sending: false, uncertain: true });
  }
  rejected(key, operation) {
    const draft = this.get(key); if (draft.operation !== operation) return;
    // A later rejection does not establish that an earlier lost response did
    // not commit. Keep its exact request until an acknowledgement is received.
    if (this.#ambiguous.has(operation)) { this.failed(key, operation); return; }
    // Only use after a definitive HTTP input rejection, never after timeout,
    // malformed response, conflict or transport failure with unknown commit.
    this.#drafts.set(key, { ...draft, operation: null, sending: false, uncertain: false, rejected: true });
  }
  suspend() {
    for (const [key, draft] of this.#drafts) if (draft.operation) this.failed(key, draft.operation);
  }
  // Only a complete authenticated workspace read can prove that a room is no
  // longer authorized. Offline/partial reads must never call this method.
  retainRooms(userId, centerId, allowedRoomIds) {
    if (!id(userId) || !id(centerId) || !Array.isArray(allowedRoomIds)) throw new LocalApiError('INVALID_INPUT');
    const allowed = new Set();
    // Validate the entire list before deleting anything. Sparse/accessor
    // entries are not an authoritative list of room IDs.
    for (let index = 0; index < allowedRoomIds.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(allowedRoomIds, index);
      if (!entry || !Object.hasOwn(entry, 'value') || !id(entry.value) || allowed.has(entry.value)) throw new LocalApiError('INVALID_INPUT');
      allowed.add(entry.value);
    }
    let removed = 0;
    for (const key of this.#drafts.keys()) {
      let scope; try { scope = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(scope) || scope.length !== 3 || !scope.every(id) ||
          scope[0] !== userId || scope[1] !== centerId || allowed.has(scope[2])) continue;
      this.#drafts.delete(key); removed++;
    }
    return removed;
  }
  accepted(key, operation) { if (this.get(key).operation === operation) this.#drafts.delete(key); }
  clear() { this.#drafts.clear(); }
}
