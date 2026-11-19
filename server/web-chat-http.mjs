import { AuthError } from './auth.mjs';
import { RepositoryError } from './errors.mjs';
import { localMessageView } from './local-care-http.mjs';
import { readWebChatConfig, webChatServices } from './web-chat-runtime.mjs';
import { WEB_CHAT_MEDIA_MAX_BYTES, WEB_CHAT_MEDIA_MAX_FILES, WEB_CHAT_MEDIA_TYPES, webChatMediaName } from '../src/shared-chat-media-policy.js';

export const WEB_CHAT_COOKIE = '__Secure-carebridge-chat';
const MAX_BODY_BYTES = 24 * 1024;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const TOKEN = /^[A-Za-z0-9_-]{40,100}$/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const statuses = { AUTH_REQUIRED: 401, AUTH_INVALID: 401, SESSION_PRESENT: 409,
  INVALID_INPUT: 400, CROSS_ORIGIN_DENIED: 403, NOT_FOUND: 404, FORBIDDEN: 403,
  IDEMPOTENCY_CONFLICT: 409, SEQUENCE_LIMIT: 409, CHAT_UNAVAILABLE: 503,
  METHOD_NOT_ALLOWED: 405, TOO_MANY_ROOMS: 409, MEDIA_LIMIT: 413, INVALID_MEDIA: 415,
  MEDIA_STORAGE_FULL: 409, UPLOAD_EXPIRED: 409, ATTACHMENT_NOT_FOUND: 404 };
class BoundaryError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new BoundaryError(code); };
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validText = (value, max) => typeof value === 'string' && value.length <= max && value.isWellFormed() && !CONTROL.test(value);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const anonymous = enabled => ({ enabled, authenticated: false, user: null });

function json(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store',
    'Vary': 'Origin, Cookie', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra } });
}
function denied(code) { return json({ error: { code } }, statuses[code] ?? 503); }
function cookie(value = '', maxAge = 0) {
  return `${WEB_CHAT_COOKIE}=${value}; Path=/api/chat; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}
function tokenFrom(request) {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  if (header.length > 8192) fail('INVALID_INPUT');
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(WEB_CHAT_COOKIE + '='));
  if (values.length > 1) fail('AUTH_REQUIRED');
  if (!values.length) return null;
  const token = values[0].slice(WEB_CHAT_COOKIE.length + 1);
  if (!TOKEN.test(token)) fail('AUTH_REQUIRED');
  return token;
}
function source(config, request) {
  const url = new URL(request.url), origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
  const mutation = request.method !== 'GET';
  if (url.protocol !== 'https:' || !config.origins.has(url.origin) ||
      (origin !== null && origin !== url.origin) ||
      (site !== null && site !== 'same-origin' && !(site === 'none' && !mutation)) ||
      (mutation && (origin !== url.origin || request.headers.get('x-carebridge-chat') !== '1'))) fail('CROSS_ORIGIN_DENIED');
}
async function readBytes(request, maxBytes, deadlineMs = 5000, overflowCode = 'INVALID_INPUT') {
  if (!request.body || request.signal.aborted) fail('INVALID_INPUT');
  const reader = request.body.getReader(), chunks = [];
  let bytes = 0, timedOut = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const timer = setTimeout(() => { timedOut = true; cancel(); }, deadlineMs);
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (timedOut || request.signal.aborted) fail('INVALID_INPUT');
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) fail(overflowCode);
      chunks.push(part.value);
    }
    if (timedOut || request.signal.aborted) fail('INVALID_INPUT');
    return Buffer.concat(chunks);
  } catch (error) { if (error instanceof BoundaryError) throw error; fail('INVALID_INPUT'); }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function readBody(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') ||
      request.headers.has('content-encoding')) fail('INVALID_INPUT');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail('INVALID_INPUT');
  const bytes = await readBytes(request, MAX_BODY_BYTES);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('INVALID_INPUT'); }
}
async function requireEmptyBody(request) {
  const length = request.headers.get('content-length');
  if (length !== null && length !== '0') fail('INVALID_INPUT');
  // The Vercel Fetch adapter supplies a stream for DELETE even when the
  // IncomingMessage has no bytes. Verify emptiness within the same read deadline.
  if (request.body !== null) await readBytes(request, 0);
}
function query(url, fields) {
  const result = {};
  for (const [name, value] of url.searchParams) {
    if (!fields.includes(name) || Object.hasOwn(result, name)) fail('INVALID_INPUT');
    if (name === 'expectedSnapshot') {
      if (!/^[a-f0-9]{32}$/.test(value)) fail('INVALID_INPUT');
      result[name] = value;
    } else {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_INPUT');
      result[name] = Number(value);
    }
  }
  return result;
}
function userView(user, config) {
  const membership = user?.centers?.find(value => value.id === config.centerId && ['therapist', 'guardian'].includes(value.role));
  if (!membership || !ID.test(user?.userId ?? '')) fail('AUTH_REQUIRED');
  return { userId: user.userId, email: user.email, role: membership.role, centerId: config.centerId, expiresAt: user.expiresAt };
}
function expectedUser(request, user, required = true) {
  const expected = request.headers.get('x-carebridge-chat-user');
  if ((required || expected !== null) && expected !== user.userId) fail('AUTH_REQUIRED');
}
function publicError(error) {
  if ((error instanceof BoundaryError || error instanceof AuthError || error instanceof RepositoryError) &&
      Object.hasOwn(statuses, error.code)) return error.code;
  return 'CHAT_UNAVAILABLE';
}

// Web attachments have their own explicitly bounded storage and validation.
// Never claim the local quarantine/AV worker has inspected these uploads.
function publicAttachment(file) {
  return pick(file, ['id', 'name', 'type', 'size', 'width', 'height', 'duration']);
}
function publicMessage(message) {
  const result = localMessageView(message);
  if (Array.isArray(message.webAttachments)) {
    result.attachments = message.hidden || message.deleted ? [] : message.webAttachments.map(publicAttachment);
    result.attachmentCount = result.attachments.length;
  }
  return result;
}
function uploadQuery(url) {
  const values = [...url.searchParams];
  if (values.length !== 1 || values[0][0] !== 'clientId' || !/^[A-Za-z0-9-]{8,100}$/.test(values[0][1])) fail('INVALID_INPUT');
  return values[0][1];
}
async function uploadBytes(request) {
  const type = request.headers.get('content-type');
  if (!WEB_CHAT_MEDIA_TYPES.includes(type) || request.headers.has('content-encoding')) fail('INVALID_MEDIA');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^[1-9][0-9]*$/.test(length) || Number(length) > WEB_CHAT_MEDIA_MAX_BYTES)) fail('MEDIA_LIMIT');
  const bytes = await readBytes(request, WEB_CHAT_MEDIA_MAX_BYTES, 20000, 'MEDIA_LIMIT');
  if (!bytes.length || (length !== null && Number(length) !== bytes.length)) fail('INVALID_INPUT');
  return { bytes, type };
}
function mediaResponse(value) {
  if (!WEB_CHAT_MEDIA_TYPES.includes(value.type) || !(value.bytes instanceof Uint8Array) ||
      value.bytes.length < 1 || value.bytes.length > WEB_CHAT_MEDIA_MAX_BYTES || value.bytes.length !== value.size) fail('CHAT_UNAVAILABLE');
  return new Response(value.bytes, { headers: {
    'Content-Type': value.type, 'Content-Length': String(value.size),
    'Content-Disposition': `inline; filename="${webChatMediaName(value.type)}"`,
    'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store', 'Vary': 'Origin, Cookie, X-Carebridge-Chat-User',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}

/** Public HTTPS transport, deliberately separate from the loopback-only local API. */
export function createWebChatHandler({ env = process.env, getServices = webChatServices, now = Date.now } = {}) {
  return async function handle(request) {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (!path.startsWith('/api/chat/')) return denied('NOT_FOUND');
      let config;
      try { config = readWebChatConfig(env); }
      catch { return path === '/api/chat/session' && request.method === 'GET' ? json(anonymous(false)) : denied('CHAT_UNAVAILABLE'); }
      source(config, request);
      const sessionRoute = path === '/api/chat/session';
      const roomsRoute = path === '/api/chat/rooms';
      const roomRoute = /^\/api\/chat\/rooms\/([A-Za-z0-9_-]{1,100})\/(messages|read)$/.exec(path);
      const mediaRoute = /^\/api\/chat\/rooms\/([A-Za-z0-9_-]{1,100})\/media(?:\/([A-Za-z0-9_-]{1,100}))?$/.exec(path);
      if (!sessionRoute && !roomsRoute && !roomRoute && !mediaRoute) return denied('NOT_FOUND');
      const allowed = sessionRoute ? ['GET', 'POST', 'DELETE'] : roomsRoute ? ['GET'] : mediaRoute ? (mediaRoute[2] ? ['GET', 'DELETE'] : ['POST']) : roomRoute[2] === 'messages' ? ['GET', 'POST'] : ['POST'];
      if (!allowed.includes(request.method)) return denied('METHOD_NOT_ALLOWED');
      if (sessionRoute && url.search) fail('INVALID_INPUT');
      if (request.method !== 'POST') await requireEmptyBody(request);
      const token = tokenFrom(request), services = await getServices();
      if (sessionRoute && request.method === 'POST') {
        const prior = token ? await services.auth.authenticate(token) : null;
        if (prior) {
          let allowed = false;
          try { userView(prior, config); allowed = true; } catch { /* Current membership is no longer usable here. */ }
          if (allowed) fail('SESSION_PRESENT');
          await services.auth.logout(token);
        }
        const body = await readBody(request);
        if (!exact(body, ['email', 'password', 'syntheticConfirmed']) || body.syntheticConfirmed !== true ||
            !validText(body.email, 254) || !validText(body.password, 128) || !body.password) fail('INVALID_INPUT');
        const result = await services.auth.login({ email: body.email, password: body.password });
        let user;
        try { user = userView(result.user, config); }
        catch { await services.auth.logout(result.token); fail('AUTH_INVALID'); }
        const seconds = Math.max(0, Math.min(3600, Math.floor((Date.parse(user.expiresAt) - now()) / 1000)));
        if (!TOKEN.test(result.token) || !Number.isFinite(seconds) || seconds < 1) fail('CHAT_UNAVAILABLE');
        return json({ enabled: true, authenticated: true, user }, 200, { 'Set-Cookie': cookie(result.token, seconds) });
      }
      const authenticated = token ? await services.auth.authenticate(token) : null;
      if (!authenticated) {
        if (sessionRoute && request.method === 'GET') return json(anonymous(true));
        // An already expired token needs no cookie mutation. A delayed logout
        // response must not erase a newer account's cookie set by another tab.
        if (sessionRoute && request.method === 'DELETE') return json(anonymous(true));
        fail('AUTH_REQUIRED');
      }
      if (sessionRoute && request.method === 'DELETE') {
        // A revoked center membership must not prevent its account signing out.
        expectedUser(request, authenticated);
        await services.auth.logout(token);
        return json(anonymous(true), 200, { 'Set-Cookie': cookie() });
      }
      const user = userView(authenticated, config);
      expectedUser(request, user, !sessionRoute);
      if (sessionRoute && request.method === 'GET') return json({ enabled: true, authenticated: true, user });
      const identity = { userId: user.userId, centerId: config.centerId };
      if (mediaRoute) {
        if (!services.media) fail('CHAT_UNAVAILABLE');
        const conversationId = mediaRoute[1], attachmentId = mediaRoute[2];
        if (request.method === 'POST') {
          const clientId = uploadQuery(url);
          // Authorize the room before reading or decoding the file body.
          await services.conversations.inRoom(identity, conversationId, async () => {});
          const input = await uploadBytes(request);
          const attachment = await services.media.upload(identity, { conversationId, clientId, ...input });
          return json({ attachment: publicAttachment(attachment) }, 201);
        }
        if (url.search) fail('INVALID_INPUT');
        if (request.method === 'DELETE') {
          await services.media.discard(identity, { conversationId, attachmentId });
          return json({ discarded: true });
        }
        return mediaResponse(await services.media.content(identity, { conversationId, attachmentId }));
      }
      if (roomsRoute) {
        const page = await services.conversations.inbox(identity, query(url, ['offset', 'limit', 'expectedSnapshot']));
        if (page.resetRequired) return json({ snapshot: page.snapshot, resetRequired: true });
        const rooms = [];
        for (const room of page.rooms) {
          const profile = await services.profiles.get(identity, { conversationId: room.conversationId });
          rooms.push({ ...pick(room, ['conversationId', 'childId', 'revision', 'lastRead', 'unread', 'targetId']), name: profile.name,
            participants: profile.participants.map(value => pick(value, ['userId', 'role', 'displayName'])),
            latest: room.latest ? pick(room.latest, ['id', 'sequence', 'authorId', 'type', 'createdAt', 'body', 'hidden', 'deleted', 'edited']) : null });
        }
        return json({ rooms, snapshot: page.snapshot, resetRequired: false, nextOffset: page.nextOffset, hasMore: page.hasMore });
      }
      const conversationId = roomRoute[1];
      if (request.method === 'GET') {
        const page = await services.conversations.list(identity, { conversationId, ...query(url, ['after', 'limit', 'expectedRevision']) });
        if (page.resetRequired) return json({ revision: page.revision, resetRequired: true });
        const messages = services.media ? await services.media.decorate(identity, { conversationId, messages: page.messages }) : page.messages;
        return json({ messages: messages.map(publicMessage),
          ...pick(page, ['lastRead', 'unread', 'revision', 'nextCursor', 'hasMore']), resetRequired: false });
      }
      if (url.search) fail('INVALID_INPUT');
      const body = await readBody(request);
      if (roomRoute[2] === 'read') {
        if (!exact(body, ['messageId']) || !ID.test(body.messageId ?? '')) fail('INVALID_INPUT');
        const result = await services.conversations.markRead(identity, { conversationId, messageId: body.messageId });
        return json({ lastRead: result.lastRead });
      }
      if (!(exact(body, ['clientId', 'body']) || exact(body, ['clientId', 'body', 'attachments'])) ||
          typeof body.clientId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(body.clientId) || !validText(body.body, 2000)) fail('INVALID_INPUT');
      const attachments = body.attachments ?? [];
      if (!Array.isArray(attachments) || attachments.length > WEB_CHAT_MEDIA_MAX_FILES ||
          attachments.some(file => !exact(file, ['id']) || !ID.test(file.id)) ||
          new Set(attachments.map(file => file.id)).size !== attachments.length || (!body.body.trim() && !attachments.length)) fail('INVALID_INPUT');
      const input = { conversationId, clientId: body.clientId, body: body.body };
      if (attachments.length && !services.media) fail('CHAT_UNAVAILABLE');
      const message = services.media ? await services.media.send(identity, { ...input, attachments }) : await services.conversations.sendText(identity, input);
      return json({ message: publicMessage(message) }, 201);
    } catch (error) { return denied(publicError(error)); }
  };
}
