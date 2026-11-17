import { AuthError } from './auth.mjs';
import { RepositoryError } from './errors.mjs';
import { localCareRoute, executeLocalCare, localMessageView } from './local-care-http.mjs';
import { localMessageRoute, executeLocalMessage } from './local-message-http.mjs';
import { localOperationsRoute, executeLocalOperations } from './local-operations-http.mjs';
import { localMediaRoute, executeLocalMedia } from './local-media-http.mjs';
import { MediaAccess } from './media-access.mjs';
import { localMediaContentRoute, streamLocalMediaContent } from './local-media-content-http.mjs';
import { AccountDelivery, AccountDeliveryError } from './account-delivery.mjs';
import { localInvitationsRoute, executeLocalInvitation } from './local-invitations-http.mjs';
import { LocalPasswordRecovery } from './local-password-recovery.mjs';
import { localRecoveryRoute, executeLocalRecovery } from './local-recovery-http.mjs';
import { localSelfProfileRoute, executeLocalSelfProfile } from './local-self-profile-http.mjs';
import { localParticipationRoute, executeLocalParticipation } from './local-participation-http.mjs';
import { LocalEmailLogin, localEmailLoginRoute } from './local-email-login.mjs';
import { isSyntheticHttpsTransport } from './synthetic-https-transport.mjs';
import { AiRecordDrafts } from './ai-record-drafts.mjs';
import { AiConversations } from './ai-conversations.mjs';
import { localAiRoute, executeLocalAi } from './local-ai-http.mjs';
import { AiAudioNotes } from './ai-audio-notes.mjs';
import { localAudioRoute, executeLocalAudio, AUDIO_NOTE_JSON_LIMIT } from './local-audio-http.mjs';

const MAX_BODY_BYTES = 16 * 1024;
const BODY_TIMEOUT_MS = 5000;
// Bound transport copies as well as the service's retained source budget.
// Never queue multi-megabyte bodies or concurrent original exports.
const audioLargePayloads = new WeakSet();
const ID = '[A-Za-z0-9_-]{1,100}';
const roomPath = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/(profile|messages|read)$`);
const inboxPath = new RegExp(`^/api/local/centers/(${ID})/inbox$`);
const TOKEN = /^[A-Za-z0-9_-]{40,100}$/;
const MEDIA_CONFLICTS = ['UPLOAD_CONFLICT', 'UPLOAD_STATE', 'UPLOAD_EXPIRED', 'FILE_IN_USE', 'UPLOAD_QUOTA',
  'MEDIA_RESOURCES_UNCONFIGURED', 'CENTER_MEDIA_PAUSED', 'CENTER_MEDIA_RATE', 'CENTER_MEDIA_CAPACITY', 'CENTER_MEDIA_BACKLOG', 'UPLOAD_BUSY',
  'MEDIA_READ_BUSY', 'ATTACHMENT_NOT_READY', 'ATTACHMENT_ORIGIN_CONFLICT', 'ATTACHMENT_LIMIT'];
const CARE_CONFLICTS = ['RECORD_CONFLICT', 'RECIPIENTS_CHANGED', 'REFERENCE_CHANGED', 'CONTEXT_CHANGED', 'CONTEXT_NOT_FOUND',
  'FEEDBACK_CONFLICT', 'REVIEW_CONFLICT', 'PUBLICATION_CLOSED', 'NO_ACTIVITY', 'NO_RECIPIENT', 'RECORD_NOT_SHAREABLE',
  'ATTACHMENTS_NOT_CONNECTED', 'MESSAGE_CONFLICT', 'MESSAGE_DELETED', 'MESSAGE_CHANGE_EXPIRED', 'APPOINTMENT_RECORD_EXISTS', 'RECORD_IMPORT_REQUIRED',
  'PROFILE_CONFLICT', 'REVISION_LIMIT', 'GOAL_CONFLICT', 'APPOINTMENT_CONFLICT', 'SCHEDULE_CONFLICT', 'THERAPIST_UNAVAILABLE'];
const OPERATIONS_CONFLICTS = ['CHILD_EXISTS', 'RELATIONSHIP_CONFLICT', 'PARTICIPANT_UNAVAILABLE',
  'HISTORY_CONFIRMATION_REQUIRED', 'HISTORY_CHOICE_REQUIRED', 'PAST_HISTORY_CONFIRMATION_REQUIRED', 'SEQUENCE_LIMIT',
  'PRIMARY_COMMUNICATOR_CONFLICT', 'CARE_RECIPIENT_LINK_CONFLICT'];
const INVITATION_CONFLICTS = ['INVITATION_EXISTS', 'INVITATION_NOT_PENDING', 'INVITATION_ACCOUNT_EXISTS',
  'INVITATION_CONFLICT', 'INVITATION_MEMBERSHIP_UNAVAILABLE', 'INVITATION_LIST_LIMIT'];
const AI_ERRORS = ['AI_UNAVAILABLE', 'AI_PROVIDER_UNAVAILABLE', 'AI_BUSY', 'AI_LIMIT', 'AI_REQUEST_FAILED',
  'AI_SOURCE_CHANGED', 'AI_REQUEST_CONFLICT', 'AI_CONVERSATION_CHANGED', 'AI_OUTPUT_INVALID', 'AI_CANCELLED'];
const responses = Object.freeze({
  INVALID_INPUT: [400, '요청 내용을 확인해 주세요.'],
  AUTH_INVALID: [401, '이메일 또는 비밀번호를 확인해 주세요.'],
  EMAIL_LOGIN_INVALID: [401, '인증번호를 확인하거나 새 번호를 요청해 주세요.'],
  AUTH_REQUIRED: [401, '로그인이 필요합니다.'],
  SOURCE_REJECTED: [403, '허용된 로컬 화면에서 다시 시도해 주세요.'],
  NOT_FOUND: [404, '요청한 대상을 찾을 수 없습니다.'],
  REQUEST_TIMEOUT: [408, '요청 전송이 완료되지 않았습니다.'],
  IDEMPOTENCY_CONFLICT: [409, '이미 사용한 발신 번호입니다. 입력 내용을 확인해 주세요.'],
  PAYLOAD_TOO_LARGE: [413, '요청 내용이 너무 큽니다.'],
  UNSUPPORTED_MEDIA_TYPE: [415, '이 요청에 허용된 전송 형식을 사용해 주세요.'],
  LOCAL_API_UNAVAILABLE: [503, '로컬 연결을 처리하지 못했습니다. 입력을 유지하고 다시 확인해 주세요.'],
  AI_UNAVAILABLE: [503, 'AI 연결이 준비되지 않았어요. 직접 작성한 내용은 유지됩니다.'],
  AI_PROVIDER_UNAVAILABLE: [503, 'AI 연결을 사용할 수 없어요. 잠시 후 다시 확인해 주세요.'],
  AI_BUSY: [409, 'AI가 앞선 요청을 처리하고 있어요. 완료 후 다시 시도해 주세요.'],
  AI_LIMIT: [409, '이번 시험의 AI 사용 한도에 도달했어요. 직접 작성할 수 있습니다.'],
  AI_REQUEST_FAILED: [409, 'AI 요청의 완료를 확인하지 못했어요. 자동으로 다시 전송하지 않았습니다.'],
  AI_SOURCE_CHANGED: [409, '기록이 바뀌었어요. 최신 기록을 확인한 뒤 AI 초안을 다시 준비해 주세요.'],
  AI_REQUEST_CONFLICT: [409, '이미 사용한 AI 요청 번호입니다. 내용을 확인해 주세요.'],
  AI_CONVERSATION_CHANGED: [409, 'AI 대화가 바뀌었어요. 최신 대화를 확인해 주세요.'],
  AI_OUTPUT_INVALID: [502, 'AI 응답을 확인하지 못했어요. 작성한 내용은 유지됩니다.'],
  AI_CANCELLED: [409, 'AI 요청을 취소했어요. 작성한 내용은 유지됩니다.'],
  EMPTY_RECORD: [400, '정식 기록에는 작성한 내용이 필요합니다.'],
  ACCOUNT_SESSION_PRESENT: [409, '현재 로그인한 계정이 있어요. 기존 계정 연결을 선택하거나 로그아웃한 뒤 다시 확인해 주세요.'],
  PASSWORD_CONFIRMATION_MISMATCH: [400, '비밀번호 확인이 일치하지 않습니다.'],
  PASSWORD_UNCHANGED: [400, '기존 비밀번호와 다른 비밀번호를 입력해 주세요.'],
  PASSWORD_RECOVERY_INVALID: [410, '사용할 수 없는 복구 안내입니다. 새 안내를 요청해 주세요.'],
  INVITATION_INVALID: [410, '사용할 수 없는 초대입니다. 새 안내를 확인해 주세요.'],
  ...Object.fromEntries(INVITATION_CONFLICTS.map(code => [code, [409, '초대 상태를 확인한 뒤 다시 진행해 주세요.']])),
  ...Object.fromEntries(OPERATIONS_CONFLICTS.map(code => [code, [409, '등록 또는 연결 상태를 확인한 뒤 다시 준비해 주세요.']])),
  ...Object.fromEntries(MEDIA_CONFLICTS.map((code) => [code, [409, '업로드 상태나 시험 용량을 확인한 뒤 다시 시도해 주세요.']])),
  ...Object.fromEntries(CARE_CONFLICTS.map((code) => [code, [409, code === 'ATTACHMENTS_NOT_CONNECTED'
    ? '첨부가 있는 자료는 첨부 연결 이후에 수정·공유할 수 있습니다. 기존 파일은 유지했습니다.'
    : '내용이나 공유 대상이 변경되었어요. 최신 내용을 확인한 뒤 다시 준비해 주세요.']])),
});
class LocalRequestError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const reject = (code) => { throw new LocalRequestError(code); };
const headers = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
});
function respond(res, status, body, extra = {}) {
  res.writeHead(status, { ...headers, ...extra });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
function publicFailure(error) {
  let code = 'LOCAL_API_UNAVAILABLE';
  if (error instanceof LocalRequestError && Object.hasOwn(responses, error.code)) code = error.code;
  else if (error instanceof AuthError) {
    if (['AUTH_INVALID', 'AUTH_REQUIRED', 'EMAIL_LOGIN_INVALID', 'ACCOUNT_SESSION_PRESENT', 'INVALID_INPUT', 'NOT_FOUND', 'INVITATION_INVALID',
      'PASSWORD_CONFIRMATION_MISMATCH', 'PASSWORD_UNCHANGED', 'PASSWORD_RECOVERY_INVALID', ...INVITATION_CONFLICTS].includes(error.code)) code = error.code;
    else if (error.code === 'FORBIDDEN') code = 'NOT_FOUND';
  } else if (error instanceof AccountDeliveryError && error.code === 'INVALID_INPUT') code = error.code;
  else if (error instanceof RepositoryError) {
    if (['INVALID_INPUT', 'PAYLOAD_TOO_LARGE', 'REQUEST_TIMEOUT', 'IDEMPOTENCY_CONFLICT', 'NOT_FOUND', 'EMPTY_RECORD', ...CARE_CONFLICTS, ...MEDIA_CONFLICTS, ...OPERATIONS_CONFLICTS, ...AI_ERRORS].includes(error.code)) code = error.code;
    else if (['FORBIDDEN', 'ATTACHMENT_NOT_FOUND', 'CONTENT_UNAVAILABLE'].includes(error.code)) code = 'NOT_FOUND';
  }
  const [status, message] = responses[code];
  return { status, body: { error: code, message } };
}
function configuration(options) {
  const { auth, conversations, profiles, origin, cookieName, transport } = options ?? {};
  // This is deliberately NOT a general HTTP/production adapter. The caller
  // supplies a loopback origin or the owning synthetic TLS transport, never Host.
  const secure = transport !== undefined;
  if (secure && (!isSyntheticHttpsTransport(transport) || !transport.active || transport.origin !== origin)) reject('LOCAL_API_UNAVAILABLE');
  if (typeof origin !== 'string' || (!secure && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin)) ||
      typeof cookieName !== 'string' || !/^cb_local_[a-f0-9]{16,64}$/.test(cookieName)) reject('LOCAL_API_UNAVAILABLE');
  let url;
  try { url = new URL(origin); } catch { reject('LOCAL_API_UNAVAILABLE'); }
  if (url.origin !== origin || !url.port || Number(url.port) > 65535 ||
      !['login', 'authenticate', 'logout'].every((key) => typeof auth?.[key] === 'function') ||
      !['inbox', 'list', 'sendText', 'markRead'].every((key) => typeof conversations?.[key] === 'function') ||
      typeof profiles?.get !== 'function') reject('LOCAL_API_UNAVAILABLE');
  if (options.mediaAccess !== undefined && !(options.mediaAccess instanceof MediaAccess)) reject('LOCAL_API_UNAVAILABLE');
  if (options.accountDelivery !== undefined && !(options.accountDelivery instanceof AccountDelivery)) reject('LOCAL_API_UNAVAILABLE');
  if (options.passwordRecovery !== undefined && !(options.passwordRecovery instanceof LocalPasswordRecovery)) reject('LOCAL_API_UNAVAILABLE');
  if (options.emailLogin !== undefined && (!(options.emailLogin instanceof LocalEmailLogin) || !options.emailLogin.usesAuth(auth))) reject('LOCAL_API_UNAVAILABLE');
  if (options.aiDrafts !== undefined && !(options.aiDrafts instanceof AiRecordDrafts)) reject('LOCAL_API_UNAVAILABLE');
  if (options.aiConversations !== undefined && !(options.aiConversations instanceof AiConversations)) reject('LOCAL_API_UNAVAILABLE');
  if (options.aiAudioNotes !== undefined && !(options.aiAudioNotes instanceof AiAudioNotes)) reject('LOCAL_API_UNAVAILABLE');
  return { auth, conversations, profiles, origin, cookieName, transport, secure, host: url.host, port: Number(url.port),
    memberProfiles: options.memberProfiles, relationships: options.relationships, appointments: options.appointments,
    careRecipientLinks: options.careRecipientLinks, primaryCommunicators: options.primaryCommunicators,
    accountDelivery: options.accountDelivery, passwordRecovery: options.passwordRecovery, emailLogin: options.emailLogin,
    mediaAccess: options.mediaAccess, mediaDelivery: options.mediaAccess instanceof MediaAccess,
    aiDrafts: options.aiDrafts, aiConversations: options.aiConversations, aiAudioNotes: options.aiAudioNotes };
}
function header(req, name) {
  let occurrences = 0;
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2)
    if (req.rawHeaders[i].toLowerCase() === name) occurrences++;
  const value = req.headers[name];
  if (occurrences > 1 || (value !== undefined && typeof value !== 'string')) reject('INVALID_INPUT');
  return value;
}
function checkSource(req, config, binary = false) {
  const loopback = (address) => address === '127.0.0.1' || address === '::ffff:127.0.0.1';
  if (config.secure ? !config.transport.accepts(req) :
      !loopback(req.socket?.remoteAddress) || !loopback(req.socket?.localAddress) ||
      req.socket.localPort !== config.port || header(req, 'host') !== config.host) reject('SOURCE_REJECTED');
  const origin = header(req, 'origin'), site = header(req, 'sec-fetch-site');
  // Same-site can be a different localhost port; it is not same-origin.
  if ((origin !== undefined && origin !== config.origin) || (site !== undefined && site !== 'same-origin')) reject('SOURCE_REJECTED');
  if (req.method === 'POST') {
    if (origin !== config.origin || header(req, 'x-carebridge-request') !== '1') reject('SOURCE_REJECTED');
    const contentType = binary ? /^application\/octet-stream$/i : /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
    if (!contentType.test(header(req, 'content-type') ?? '') ||
        header(req, 'content-encoding') !== undefined) reject('UNSUPPORTED_MEDIA_TYPE');
  } else if (header(req, 'transfer-encoding') !== undefined ||
      (header(req, 'content-length') !== undefined && header(req, 'content-length') !== '0')) reject('INVALID_INPUT');
}
function sessionToken(req, cookieName) {
  const value = header(req, 'cookie');
  if (value === undefined) return null;
  if (value.length > 8192) reject('INVALID_INPUT');
  const seen = new Set();
  let token = null;
  for (const pair of value.split(';')) {
    const match = /^([^\s=;]+)=([^;]*)$/.exec(pair.trim());
    if (!match || seen.has(match[1])) reject('INVALID_INPUT');
    seen.add(match[1]);
    if (match[1] === cookieName) {
      if (!TOKEN.test(match[2])) reject('AUTH_REQUIRED');
      token = match[2];
    }
  }
  return token;
}
function cookie(name, token, maxAge = 0, secure = false) {
  return `${name}=${token}; Path=/api/local/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const declared = header(req, 'content-length');
  if (declared !== undefined && (!/^(0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared)))) reject('INVALID_INPUT');
  if (Number(declared) > maxBytes) reject('PAYLOAD_TOO_LARGE');
  return new Promise((resolve, fail) => {
    let size = 0, settled = false;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onError);
      if (error) { req.resume(); fail(error); } else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) finish(new LocalRequestError('PAYLOAD_TOO_LARGE'));
      else chunks.push(chunk);
    };
    const onError = () => finish(new LocalRequestError('INVALID_INPUT'));
    const onEnd = () => {
      try {
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!body || typeof body !== 'object' || Array.isArray(body)) reject('INVALID_INPUT');
        finish(null, body);
      } catch { finish(new LocalRequestError('INVALID_INPUT')); }
    };
    const timer = setTimeout(() => finish(new LocalRequestError('REQUEST_TIMEOUT')), BODY_TIMEOUT_MS);
    timer.unref();
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onError);
  });
}
function onlyKeys(value, allowed, required = allowed) {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) reject('INVALID_INPUT');
}
function query(url, allowed) {
  const output = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(output, key)) reject('INVALID_INPUT');
    if (key === 'view') {
      if (!['timeline', 'publications'].includes(value)) reject('INVALID_INPUT');
      output[key] = value;
    } else if (key === 'around') {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) reject('INVALID_INPUT');
      output[key] = value;
    } else if (key === 'expectedSnapshot') {
      if (!/^[a-f0-9]{32}$/.test(value)) reject('INVALID_INPUT');
      output[key] = value;
    } else {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) reject('INVALID_INPUT');
      output[key] = Number(value);
      if (key === 'limit' && (output[key] < 1 || output[key] > 100)) reject('INVALID_INPUT');
    }
  }
  return output;
}
function messagesQuery(url) {
  const params = query(url, ['view', 'before', 'after', 'from', 'around', 'limit', 'expectedRevision']);
  if (params.view === 'timeline') {
    if (['before', 'after', 'from', 'around'].filter(key => Object.hasOwn(params, key)).length > 1) reject('INVALID_INPUT');
  } else onlyKeys(params, ['view', 'after', 'limit', 'expectedRevision'], []);
  return params;
}
const userView = (user) => ({ userId: user.userId, email: user.email,
  centers: user.centers.map(({ id, role }) => ({ id, role })), expiresAt: user.expiresAt });
const messageView = localMessageView;
function inboxView(page) {
  if (page.resetRequired) return { snapshot: page.snapshot, resetRequired: true };
  return { rooms: page.rooms.map((room) => ({
    conversationId: room.conversationId, childId: room.childId, revision: room.revision,
    lastRead: room.lastRead, unread: room.unread, targetId: room.targetId,
    latest: room.latest ? {
      id: room.latest.id, sequence: room.latest.sequence, authorId: room.latest.authorId,
      type: room.latest.type, createdAt: room.latest.createdAt,
      body: room.latest.body,
      hidden: room.latest.hidden === true, deleted: room.latest.deleted === true, edited: room.latest.edited === true,
    } : null,
  })), snapshot: page.snapshot, resetRequired: false, nextOffset: page.nextOffset, hasMore: page.hasMore };
}
function messagesView(page, viewOptions, view) {
  if (page.resetRequired) return { revision: page.revision, resetRequired: true };
  const result = { messages: page.messages.map((message) => messageView(message, viewOptions)), lastRead: page.lastRead, unread: page.unread,
    revision: page.revision, resetRequired: false };
  if (view === 'timeline') return { ...result, window: { hasOlder: page.window.hasOlder, hasNewer: page.window.hasNewer,
    startCursor: page.window.startCursor, endCursor: page.window.endCursor } };
  return { ...result, nextCursor: page.nextCursor, hasMore: page.hasMore };
}

// Synthetic local transport ONLY. No listener, database discovery, external email,
// file path, role-switch authority, production route, or environment fallback.
// All /api/ paths are claimed, so the old auth handler must never be mounted.
export async function handleLocalApiRequest(req, res, options) {
  if (typeof req.url !== 'string' || !req.url.startsWith('/api/')) return false;
  try {
    const config = configuration(options);
    const writeCookie = (name, token, maxAge) => cookie(name, token, maxAge, config.secure);
    if (req.url.length > 2048 || /[\\#\x00-\x20\x7f]/.test(req.url)) reject('INVALID_INPUT');
    const url = new URL(req.url, config.origin);
    // Only the exact, closed descriptor can opt into a binary POST. Its
    // parsing performs no IO; all execution still follows the same guard.
    const media = localMediaRoute(url, req.method);
    const mediaContent = localMediaContentRoute(url, req.method);
    checkSource(req, config, media?.binary === true);
    if (req.url.split('?')[0] !== url.pathname || url.pathname.includes('%')) reject('NOT_FOUND');
    const authRoute = /^\/api\/local\/auth\/(login|session|logout)$/.exec(url.pathname);
    const inbox = inboxPath.exec(url.pathname), room = roomPath.exec(url.pathname);
    const care = localCareRoute(url, req.method);
    const ai = localAiRoute(url, req.method);
    const audio = localAudioRoute(url, req.method);
    const message = localMessageRoute(url, req.method);
    const operations = localOperationsRoute(url, req.method);
    const selfProfile = localSelfProfileRoute(url, req.method);
    const participation = localParticipationRoute(url, req.method);
    const invitation = config.accountDelivery ? localInvitationsRoute(url, req.method) : null;
    const recovery = config.passwordRecovery ? localRecoveryRoute(url, req.method) : null;
    const emailLogin = config.emailLogin ? localEmailLoginRoute(url, req.method) : null;
    const expectedMethod = authRoute ? (authRoute[1] === 'session' ? 'GET' : 'POST')
      : inbox || room?.[3] === 'profile' ? 'GET' : room?.[3] === 'read' ? 'POST' : null;
    if ((!authRoute && !inbox && !room && !care && !ai && !audio && !message && !media && !mediaContent && !operations && !selfProfile && !participation && !invitation && !recovery && !emailLogin) || (expectedMethod && req.method !== expectedMethod) ||
        (!expectedMethod && !['GET', 'POST'].includes(req.method))) reject('NOT_FOUND');
    const params = care ? care.params : ai || audio || message || media || mediaContent || operations || selfProfile || participation || invitation || recovery || emailLogin ? {}
      : room?.[3] === 'messages' && req.method === 'GET' ? messagesQuery(url)
      : query(url, inbox ? ['limit', 'offset', 'expectedSnapshot'] : []);
    const token = sessionToken(req, config.cookieName);
    const emailCookieName = `${config.cookieName}_email`;
    const emailNonce = config.emailLogin ? sessionToken(req, emailCookieName) : null;
    // This is only a precondition, NEVER identity or authorization. It binds
    // old-tab reads and immutable retries to the account that composed them,
    // even if another tab replaced the shared HttpOnly session cookie.
    const expectedAccount = header(req, 'x-carebridge-account');
    if ((authRoute?.[1] === 'login' || invitation?.action === 'accept' || recovery || emailLogin) && expectedAccount !== undefined) reject('INVALID_INPUT');
    if (expectedAccount !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(expectedAccount)) reject('AUTH_REQUIRED');
    // Audio bodies can be much larger than ordinary JSON. Authenticate and
    // authorize the saved record before admitting any file bytes. This route
    // exists only in the explicitly enabled synthetic AI service lifetime.
    if (audio) {
      const authorizeSession = async () => {
        const current = token ? await config.auth.authenticate(token) : null;
        if (!current || current.userId !== expectedAccount) reject('AUTH_REQUIRED');
        if (!current.centers.some(center => center.id === audio.centerId && center.role === 'therapist')) reject('NOT_FOUND');
        return current;
      };
      const current = await authorizeSession();
      if (!(config.aiAudioNotes instanceof AiAudioNotes)) reject('AI_UNAVAILABLE');
      const identity = { userId: current.userId, centerId: audio.centerId };
      await config.aiAudioNotes.assertUsable(identity, { conversationId: audio.conversationId, recordId: audio.recordId });
      const large = audio.action === 'original' || (req.method === 'POST' && !audio.sessionId);
      if (large && audioLargePayloads.has(config.aiAudioNotes)) reject('AI_BUSY');
      if (large) audioLargePayloads.add(config.aiAudioNotes);
      let original, draining = false, releaseExport = null;
      try {
        const audioBody = req.method === 'POST' ? await readJson(req, audio.sessionId ? 1024 : AUDIO_NOTE_JSON_LIMIT) : null;
        await authorizeSession();
        const result = await executeLocalAudio(audio, identity, audioBody, config.aiAudioNotes, authorizeSession);
        original = result.original;
        await authorizeSession();
        // Login membership and the record relationship are distinct. Recheck
        // the latter after the final async login check, including owner/deletion
        // state when returning an existing private session or source copy.
        if (audio.sessionId && audio.action !== 'remove')
          await config.aiAudioNotes.get(identity, { conversationId: audio.conversationId, recordId: audio.recordId, sessionId: audio.sessionId });
        else await config.aiAudioNotes.assertUsable(identity, { conversationId: audio.conversationId, recordId: audio.recordId });
        if (req.aborted || res.destroyed || res.writableEnded) reject('AI_CANCELLED');
        if (original) {
          const extension = { 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/webm': 'webm' }[original.type];
          let finished = false, timer;
          const release = () => {
            if (finished) return; finished = true; clearTimeout(timer);
            original.bytes.fill(0);
            audioLargePayloads.delete(config.aiAudioNotes);
            res.off('finish', release); res.off('close', release);
          };
          releaseExport = release;
          res.once('finish', release); res.once('close', release);
          timer = setTimeout(() => { res.destroy(); release(); }, 10000); timer.unref?.();
          // Deliberately download-only, never a public or playable media URL.
          res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream',
            'Content-Length': original.bytes.length,
            'Content-Disposition': `attachment; filename="carebridge-synthetic-${audio.sessionId}.${extension}"`,
            'X-Content-SHA256': original.sha256 });
          res.end(original.bytes);
          draining = true;
        } else respond(res, result.status, result.body);
      } finally {
        if (!draining) {
          if (releaseExport) releaseExport();
          else {
            original?.bytes.fill(0);
            if (large) audioLargePayloads.delete(config.aiAudioNotes);
          }
        }
      }
      return true;
    }
    const body = req.method === 'POST' && !media?.binary ? await readJson(req, emailLogin ? 1024 : care?.collection === 'records' && care.targetId && !care.action ? 128 * 1024 : MAX_BODY_BYTES) : null;
    if (emailLogin) {
      const current = token ? await config.auth.authenticate(token) : null;
      if (emailLogin.action !== 'verify' && current) reject('ACCOUNT_SESSION_PRESENT');
      if (emailLogin.action === 'start') {
        onlyKeys(body, []);
        const nonce = config.emailLogin.start(emailNonce);
        respond(res, 200, { ready: true }, { 'Set-Cookie': writeCookie(emailCookieName, nonce, 660) });
      } else if (emailLogin.action === 'request') {
        respond(res, 202, config.emailLogin.request(body, emailNonce));
      } else {
        const result = await config.emailLogin.verify(body, emailNonce, current ? token : null);
        const maxAge = Math.max(0, Math.floor((Date.parse(result.user.expiresAt) - Date.now()) / 1000));
        if (!TOKEN.test(result.token) || !Number.isSafeInteger(maxAge)) reject('LOCAL_API_UNAVAILABLE');
        respond(res, 200, { user: userView(result.user) }, { 'Set-Cookie': writeCookie(config.cookieName, result.token, maxAge) });
      }
      return true;
    }
    if (recovery) {
      const current = token ? await config.auth.authenticate(token) : null;
      if (current) reject('ACCOUNT_SESSION_PRESENT');
      const result = await executeLocalRecovery(recovery, config, body);
      // Never clear/set a cookie here: another tab may have logged in during
      // crypto/DB work. Auth revokes the recovered account's sessions itself.
      respond(res, result.status, result.body);
      return true;
    }
    if (invitation && !invitation.protected) {
      const current = token ? await config.auth.authenticate(token) : null;
      if (expectedAccount !== undefined && current?.userId !== expectedAccount) reject('AUTH_REQUIRED');
      // Creating an account must not silently replace another tab's live
      // session. Existing-account linking has its own bound-cookie endpoint.
      if (invitation.action === 'accept' && current) reject('ACCOUNT_SESSION_PRESENT');
      const result = await executeLocalInvitation(invitation, config, body);
      if (invitation.action === 'accept') {
        if (!TOKEN.test(result.sessionToken)) reject('LOCAL_API_UNAVAILABLE');
        const maxAge = Math.max(0, Math.floor((Date.parse(result.user.expiresAt) - Date.now()) / 1000));
        if (!Number.isSafeInteger(maxAge)) reject('LOCAL_API_UNAVAILABLE');
        respond(res, result.status, { user: userView(result.user), invitation: result.invitation },
          { 'Set-Cookie': writeCookie(config.cookieName, result.sessionToken, maxAge) });
      } else respond(res, result.status, result.body);
      return true;
    }
    if (authRoute?.[1] === 'login') {
      onlyKeys(body, ['email', 'password']);
      if (typeof body.email !== 'string' || !body.email.isWellFormed() || body.email.length > 254 ||
          typeof body.password !== 'string' || !body.password.isWellFormed() || body.password.length > 128) reject('INVALID_INPUT');
      if (config.emailLogin) await config.emailLogin.invalidate(emailNonce);
      const result = await config.auth.login(body);
      if (!TOKEN.test(result.token)) reject('LOCAL_API_UNAVAILABLE');
      const maxAge = Math.max(0, Math.floor((Date.parse(result.user.expiresAt) - Date.now()) / 1000));
      if (!Number.isSafeInteger(maxAge)) reject('LOCAL_API_UNAVAILABLE');
      respond(res, 200, { user: userView(result.user) }, { 'Set-Cookie': writeCookie(config.cookieName, result.token, maxAge) });
      return true;
    }
    if (authRoute?.[1] === 'logout') {
      onlyKeys(body, []);
      if (expectedAccount !== undefined && token) {
        const current = await config.auth.authenticate(token);
        if (current && current.userId !== expectedAccount) reject('AUTH_REQUIRED');
      }
      if (config.emailLogin) await config.emailLogin.invalidate(emailNonce);
      if (token) await config.auth.logout(token);
      respond(res, 204, null, { 'Set-Cookie': config.emailLogin
        ? [writeCookie(config.cookieName, ''), writeCookie(emailCookieName, '')] : writeCookie(config.cookieName, '') });
      return true;
    }
    const user = token ? await config.auth.authenticate(token) : null;
    if (!user) reject('AUTH_REQUIRED');
    if ((expectedAccount !== undefined && expectedAccount !== user.userId) ||
        (!authRoute && expectedAccount === undefined)) reject('AUTH_REQUIRED');
    if (authRoute) { respond(res, 200, { user: userView(user) }); return true; }
    if (selfProfile) {
      if (!user.centers.some(center => center.id === selfProfile.centerId && ['center', 'therapist', 'guardian', 'care_recipient'].includes(center.role))) reject('NOT_FOUND');
      const result = await executeLocalSelfProfile(selfProfile,
        { userId: user.userId, centerId: selfProfile.centerId }, body, config.memberProfiles);
      respond(res, result.status, result.body);
      return true;
    }
    if (invitation) {
      if (invitation.centerId && !user.centers.some(center => center.id === invitation.centerId && center.role === 'center')) reject('NOT_FOUND');
      const result = await executeLocalInvitation(invitation,
        { ...config, identity: { userId: user.userId }, sessionToken: token }, body);
      respond(res, result.status, invitation.action === 'accept-existing'
        ? { user: userView(result.user), invitation: result.invitation, linked: result.linked, replayed: result.replayed }
        : result.body);
      return true;
    }
    if (participation) {
      const roles = participation.managerOnly ? ['center'] : ['center', 'therapist', 'guardian', 'care_recipient'];
      if (!user.centers.some(center => center.id === participation.centerId && roles.includes(center.role))) reject('NOT_FOUND');
      const result = await executeLocalParticipation(participation,
        { userId: user.userId, centerId: participation.centerId }, body, config);
      respond(res, result.status, result.body);
      return true;
    }
    if (operations) {
      if (!user.centers.some(center => center.id === operations.centerId && center.role === 'center')) reject('NOT_FOUND');
      const result = await executeLocalOperations(operations, { userId: user.userId, centerId: operations.centerId }, body, config.profiles,
        { members: config.memberProfiles, relationships: config.relationships, appointments: config.appointments });
      respond(res, result.status, result.body);
      return true;
    }
    const centerId = ai?.centerId ?? mediaContent?.centerId ?? media?.centerId ?? care?.centerId ?? message?.centerId ?? (inbox ?? room)[1];
    const membership = user.centers.find(center => center.id === centerId && ['therapist', 'guardian', 'care_recipient'].includes(center.role));
    if (!membership) reject('NOT_FOUND');
    // The first recipient MVP is text-only. Do not opt into clinical or media
    // adapters merely because this account can enter its own conversation.
    if (membership.role === 'care_recipient' && (mediaContent || media || care)) reject('NOT_FOUND');
    const identity = { userId: user.userId, centerId };
    if (ai) {
      if (ai.kind === 'summary' && membership.role !== 'therapist') reject('NOT_FOUND');
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => { if (!res.writableEnded) abort(); };
      req.once('aborted', abort); res.once('close', close);
      if (req.aborted || res.destroyed) abort();
      try {
        const result = await executeLocalAi(ai, identity, body, config, { signal: controller.signal });
        // A model request can outlive logout or membership revocation. Authorize
        // the session again before returning any generated text to this tab.
        const current = await config.auth.authenticate(token);
        if (!current || current.userId !== user.userId || current.userId !== expectedAccount) reject('AUTH_REQUIRED');
        const roles = ai.kind === 'summary' ? ['therapist'] : ['therapist', 'guardian', 'care_recipient'];
        if (!current.centers.some(center => center.id === centerId && roles.includes(center.role))) reject('NOT_FOUND');
        if (controller.signal.aborted) reject('AI_CANCELLED');
        respond(res, result.status, result.body);
      } finally {
        req.off('aborted', abort); res.off('close', close);
      }
      return true;
    }
    if (mediaContent) {
      if (!config.mediaDelivery) reject('NOT_FOUND');
      await streamLocalMediaContent(mediaContent, identity, config, req, res, header);
      return true;
    }
    if (media) {
      const result = await executeLocalMedia(media, identity, body, { ...options, mediaDelivery: config.mediaDelivery }, req, header);
      respond(res, result.status, result.body);
      return true;
    }
    if (message) {
      const result = await executeLocalMessage(message, identity, body, config.conversations, { mediaDelivery: config.mediaDelivery });
      respond(res, result.status, result.body);
      return true;
    }
    if (care) {
      const result = await executeLocalCare(care, identity, body, { ...options, conversations: config.conversations },
        { mediaDelivery: config.mediaDelivery });
      respond(res, result.status, result.body);
      return true;
    }
    if (inbox) respond(res, 200, inboxView(await config.conversations.inbox(identity, params)));
    else {
      const conversationId = room[2], operation = room[3];
      if (operation === 'profile') {
        const profile = await config.profiles.get(identity, { conversationId });
        respond(res, 200, { conversationId: profile.conversationId, childId: profile.childId, name: profile.name,
          age: profile.age, ageAsOf: profile.ageAsOf, revision: profile.revision,
          familyPlan: profile.familyPlan == null ? null : {
            concern: profile.familyPlan.concern, revision: profile.familyPlan.revision, updatedAt: profile.familyPlan.updatedAt,
          },
          participants: profile.participants.map(({ userId, role, displayName }) => ({ userId, role, displayName })) });
      } else if (operation === 'messages' && req.method === 'GET')
        respond(res, 200, messagesView(await config.conversations.list(identity, { conversationId, ...params }), { mediaDelivery: config.mediaDelivery }, params.view));
      else if (operation === 'messages') {
        onlyKeys(body, ['clientId', 'body', 'replyTo', 'expectedReplyRevision', 'expectedReplyVersion', 'attachments'], ['clientId', 'body']);
        if (Object.hasOwn(body, 'attachments') && !Array.isArray(body.attachments)) reject('INVALID_INPUT');
        if (body.attachments?.length && !config.mediaDelivery) reject('ATTACHMENTS_NOT_CONNECTED');
        if (typeof body.body !== 'string' || !body.body.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(body.body)) reject('INVALID_INPUT');
        const message = await config.conversations.sendText(identity, { conversationId, ...body });
        respond(res, 201, { message: messageView(message, { mediaDelivery: config.mediaDelivery }) });
      } else {
        onlyKeys(body, ['messageId']);
        const result = await config.conversations.markRead(identity, { conversationId, messageId: body.messageId });
        respond(res, 200, { lastRead: result.lastRead });
      }
    }
    return true;
  } catch (error) {
    const result = publicFailure(error);
    if (!res.destroyed && !res.writableEnded) {
      // Rejected large requests cannot reuse this socket. Let the HTTP server
      // flush the safe response and close gracefully: destroying the request
      // at 'finish' can reset Windows sockets before a 413 reaches the client.
      // No application data listener buffers the rejected body.
      if (req.complete === false) {
        res.shouldKeepAlive = false;
      }
      if (res.headersSent) res.destroy();
      else respond(res, result.status, result.body, req.complete === false ? { Connection: 'close' } : {});
    }
    return true;
  }
}
