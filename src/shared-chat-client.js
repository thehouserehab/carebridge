import { WEB_CHAT_MEDIA_MAX_BYTES, WEB_CHAT_MEDIA_MAX_FILES, WEB_CHAT_MEDIA_TYPES, webChatMediaName } from './shared-chat-media-policy.js';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && ID.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const validText = (value, max) => typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value);
const codes = new Set(['AUTH_REQUIRED', 'AUTH_INVALID', 'SESSION_PRESENT', 'NOT_FOUND', 'INVALID_INPUT', 'IDEMPOTENCY_CONFLICT', 'CHAT_UNAVAILABLE', 'CROSS_ORIGIN_DENIED', 'CHAT_LIMIT', 'CHAT_TOO_MUCH', 'CANCELLED', 'MEDIA_LIMIT', 'UPLOAD_EXPIRED', 'ATTACHMENT_NOT_FOUND', 'INVALID_MEDIA', 'MEDIA_STORAGE_FULL']);
export class SharedChatError extends Error {
  constructor(code) { super('대화 요청을 완료하지 못했습니다.'); this.code = codes.has(code) ? code : 'CHAT_UNAVAILABLE'; }
}
const invalid = () => { throw new SharedChatError('CHAT_UNAVAILABLE'); };
export function validateChatText(value) {
  if (!validText(value, 2000) || !value.trim()) throw new SharedChatError('INVALID_INPUT');
  return value.trim();
}
export function chatAttachment(value) {
  if (!isObject(value) || !id(value.id) || !WEB_CHAT_MEDIA_TYPES.includes(value.type) || value.name !== webChatMediaName(value.type) ||
      !Number.isSafeInteger(value.size) || value.size < 1 || value.size > WEB_CHAT_MEDIA_MAX_BYTES ||
      ![value.width, value.height].every(dimension => Number.isSafeInteger(dimension) && dimension > 0 && dimension <= 65535) ||
      (value.type === 'video/mp4' ? !Number.isFinite(value.duration) || value.duration <= 0 : value.duration !== undefined)) invalid();
  return { id: value.id, type: value.type, name: value.name, size: value.size, width: value.width, height: value.height,
    ...(value.type === 'video/mp4' ? { duration: value.duration } : {}) };
}
export function validateChatPayload(body, attachments = []) {
  if (!Array.isArray(attachments) || attachments.length > WEB_CHAT_MEDIA_MAX_FILES ||
      attachments.some(item => !isObject(item) || !id(item.id) || Object.keys(item).length !== 1) ||
      new Set(attachments.map(item => item.id)).size !== attachments.length || !validText(body, 2000) || (!body.trim() && !attachments.length))
    throw new SharedChatError('INVALID_INPUT');
  return { body: body.trim(), attachments: attachments.map(item => ({ id: item.id })) };
}
export function validateChatFile(file) {
  if (!file || !WEB_CHAT_MEDIA_TYPES.includes(file.type) || typeof file.arrayBuffer !== 'function') throw new SharedChatError('INVALID_MEDIA');
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > WEB_CHAT_MEDIA_MAX_BYTES) throw new SharedChatError('MEDIA_LIMIT');
  return file;
}
export function chatMessage(value, roomId) {
  if (!isObject(value) || !id(value.id) || value.conversationId !== roomId || !id(value.childId) || !(id(value.authorId) || value.hidden === true && value.authorId === null) ||
      !count(value.sequence) || value.sequence < 1 || !validText(value.body, 10000) || !validText(value.createdAt, 80) ||
      !Number.isFinite(Date.parse(value.createdAt)) || typeof value.type !== 'string' ||
      !['hidden', 'deleted'].every(key => typeof value[key] === 'boolean')) invalid();
  const attachments = value.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > WEB_CHAT_MEDIA_MAX_FILES ||
      new Set(attachments.map(item => item?.id)).size !== attachments.length || ((value.hidden || value.deleted) && attachments.length)) invalid();
  return { ...value, attachments: attachments.map(chatAttachment) };
}
function session(value) {
  if (!isObject(value) || typeof value.enabled !== 'boolean' || typeof value.authenticated !== 'boolean') invalid();
  if (!value.authenticated) { if (value.user !== null) invalid(); return value; }
  const user = value.user;
  if (!value.enabled || !isObject(user) || !id(user.userId) || !id(user.centerId) || !validText(user.email, 254) || !['therapist', 'guardian'].includes(user.role)) invalid();
  return value;
}
function room(value) {
  if (!isObject(value) || !id(value.conversationId) || !id(value.childId) || !(value.name === null || validText(value.name, 200)) ||
      !count(value.revision) || !count(value.lastRead) || !count(value.unread) || !Array.isArray(value.participants) ||
      !value.participants.every(person => isObject(person) && id(person.userId) && typeof person.role === 'string' &&
        (person.displayName === null || validText(person.displayName, 200))) || !(value.latest === null || isObject(value.latest))) invalid();
  return value;
}
export class SharedChatClient {
  constructor({ fetch: request = globalThis.fetch.bind(globalThis), timeoutMs = 15000 } = {}) {
    this.fetch = request; this.timeoutMs = timeoutMs; this.userId = null;
  }
  async request(path, { method = 'GET', body, signal, publicAuth = false } = {}) {
    if (!path.startsWith('/api/chat/') || path.includes('://')) throw new SharedChatError('INVALID_INPUT');
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), this.timeoutMs), account = this.userId;
    try {
      const response = await this.fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json', ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Carebridge-Chat': '1' }),
          ...(!publicAuth && account ? { 'X-Carebridge-Chat-User': account } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal });
      if (signal?.aborted) throw new SharedChatError('CANCELLED');
      if (account !== this.userId) throw new SharedChatError('AUTH_REQUIRED');
      if (response.status === 429) throw new SharedChatError('CHAT_LIMIT');
      if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) invalid();
      const raw = await response.text();
      if (signal?.aborted) throw new SharedChatError('CANCELLED');
      if (account !== this.userId) throw new SharedChatError('AUTH_REQUIRED');
      if (raw.length > 2 * 1024 * 1024) invalid();
      let result; try { result = JSON.parse(raw); } catch { invalid(); }
      if (!response.ok) throw new SharedChatError(result?.error?.code);
      return result;
    } catch (error) {
      if (signal?.aborted) throw new SharedChatError('CANCELLED');
      if (error instanceof SharedChatError) throw error;
      throw new SharedChatError('CHAT_UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
  async session(signal) {
    const value = session(await this.request('/api/chat/session', { signal }));
    this.userId = value.user?.userId ?? null; return value;
  }
  async login(email, password, signal) {
    if (!validText(email, 254) || !validText(password, 128)) throw new SharedChatError('INVALID_INPUT');
    const value = session(await this.request('/api/chat/session', { method: 'POST', body: { email, password, syntheticConfirmed: true }, signal, publicAuth: true }));
    if (!value.authenticated) invalid(); this.userId = value.user.userId; return value;
  }
  async logout(signal) {
    const value = session(await this.request('/api/chat/session', { method: 'DELETE', signal }));
    if (value.authenticated) invalid(); this.userId = null; return value;
  }
  async rooms(signal) {
    for (let restart = 0; restart < 3; restart++) {
      const result = []; let offset = 0, snapshot;
      for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({ offset, limit: 50, ...(snapshot === undefined ? {} : { expectedSnapshot: snapshot }) });
        const value = await this.request('/api/chat/rooms?' + params, { signal });
        if (!isObject(value) || typeof value.snapshot !== 'string' || typeof value.resetRequired !== 'boolean') invalid();
        if (value.resetRequired) break;
        if (!Array.isArray(value.rooms) || typeof value.hasMore !== 'boolean' || !count(value.nextOffset) || (snapshot && snapshot !== value.snapshot)) invalid();
        value.rooms.forEach(entry => { room(entry); if (result.some(item => item.conversationId === entry.conversationId)) invalid(); result.push(entry); });
        if (!value.hasMore) return result;
        if (value.nextOffset <= offset) invalid(); offset = value.nextOffset; snapshot = value.snapshot;
        if (page === 19) throw new SharedChatError('CHAT_TOO_MUCH');
      }
    }
    throw new SharedChatError('CHAT_UNAVAILABLE');
  }
  async messages(roomId, signal) {
    if (!id(roomId)) throw new SharedChatError('INVALID_INPUT');
    for (let restart = 0; restart < 3; restart++) {
      const result = []; let after = 0, revision;
      for (let page = 0; page < 20; page++) {
        const params = new URLSearchParams({ after, limit: 100, ...(revision === undefined ? {} : { expectedRevision: revision }) });
        const value = await this.request(`/api/chat/rooms/${roomId}/messages?${params}`, { signal });
        if (!isObject(value) || !count(value.revision) || typeof value.resetRequired !== 'boolean') invalid();
        if (value.resetRequired) break;
        if (!Array.isArray(value.messages) || typeof value.hasMore !== 'boolean' || !count(value.nextCursor) || !count(value.lastRead) || !count(value.unread) || (revision !== undefined && revision !== value.revision)) invalid();
        for (const entry of value.messages) {
          chatMessage(entry, roomId);
          if (entry.sequence <= (result.at(-1)?.sequence ?? after) || result.some(item => item.id === entry.id)) invalid(); result.push(entry);
        }
        if (!value.hasMore) return { ...value, messages: result };
        if (value.nextCursor <= after || value.nextCursor !== result.at(-1)?.sequence) invalid(); after = value.nextCursor; revision = value.revision;
        if (page === 19) throw new SharedChatError('CHAT_TOO_MUCH');
      }
    }
    throw new SharedChatError('CHAT_UNAVAILABLE');
  }
  async send(roomId, operation, signal) {
    if (!id(roomId) || !isObject(operation) || typeof operation.clientId !== 'string' || !/^[a-f0-9-]{36}$/i.test(operation.clientId)) throw new SharedChatError('INVALID_INPUT');
    const payload = validateChatPayload(operation.body, operation.attachments ?? []);
    const value = await this.request(`/api/chat/rooms/${roomId}/messages`, { method: 'POST', body: { clientId: operation.clientId, ...payload }, signal });
    return chatMessage(value?.message, roomId);
  }
  async mediaRequest(path, { file, signal, metadata } = {}) {
    if (typeof path !== 'string' || !/^\/api\/chat\/rooms\/[A-Za-z0-9_-]{1,100}\/media(?:\/[A-Za-z0-9_-]{1,100}|\?clientId=[a-f0-9-]{36})$/i.test(path)) throw new SharedChatError('INVALID_INPUT');
    const account = this.userId;
    if (!account) throw new SharedChatError('AUTH_REQUIRED');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 30000));
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const current = () => { if (signal?.aborted) throw new SharedChatError('CANCELLED'); if (account !== this.userId) throw new SharedChatError('AUTH_REQUIRED'); };
    let reader;
    try {
      current();
      const response = await this.fetch(path, { method: file ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: combined,
        headers: { Accept: file ? 'application/json' : metadata.type, 'X-Carebridge-Chat-User': account,
          ...(file ? { 'Content-Type': file.type, 'X-Carebridge-Chat': '1' } : {}) }, ...(file ? { body: file } : {}) });
      current(); if (response.status === 429) throw new SharedChatError('CHAT_LIMIT');
      if (response.redirected) invalid();
      if (!response.ok || file) {
        if (!response.headers.get('content-type')?.includes('application/json')) invalid();
        reader = response.body?.getReader(); if (!reader) invalid();
        const chunks = []; let length = 0;
        for (;;) { const value = await reader.read(); current(); if (value.done) break; length += value.value.byteLength; if (length > 8192) invalid(); chunks.push(value.value); }
        const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let result; try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid(); }
        if (!response.ok) throw new SharedChatError(result?.error?.code);
        if (response.status !== 201) invalid();
        return chatAttachment(result?.attachment);
      }
      const length = response.headers.get('content-length');
      if (response.status !== 200 || response.headers.get('content-type') !== metadata.type || response.headers.has('content-range') ||
          (length !== null && Number(length) !== metadata.size)) invalid();
      reader = response.body?.getReader(); if (!reader) invalid();
      const chunks = []; let size = 0;
      for (;;) { const value = await reader.read(); current(); if (value.done) break; size += value.value.byteLength; if (size > metadata.size) invalid(); chunks.push(value.value); }
      if (size !== metadata.size) invalid(); current();
      return new Blob(chunks, { type: metadata.type });
    } catch (error) {
      current(); if (error instanceof SharedChatError) throw error; throw new SharedChatError('CHAT_UNAVAILABLE');
    } finally { clearTimeout(timer); controller.abort(); try { await reader?.cancel(); } catch {} }
  }
  async upload(roomId, operation, signal) {
    if (!id(roomId) || !isObject(operation) || typeof operation.clientId !== 'string' || !/^[a-f0-9-]{36}$/i.test(operation.clientId)) throw new SharedChatError('INVALID_INPUT');
    validateChatFile(operation.file);
    return this.mediaRequest(`/api/chat/rooms/${roomId}/media?clientId=${encodeURIComponent(operation.clientId)}`, { file: operation.file, signal });
  }
  async attachment(roomId, metadata, signal) {
    if (!id(roomId)) throw new SharedChatError('INVALID_INPUT');
    const checked = chatAttachment(metadata);
    return this.mediaRequest(`/api/chat/rooms/${roomId}/media/${checked.id}`, { metadata: checked, signal });
  }
  async markRead(roomId, messageId, signal) {
    if (!id(roomId) || !id(messageId)) throw new SharedChatError('INVALID_INPUT');
    const value = await this.request(`/api/chat/rooms/${roomId}/read`, { method: 'POST', body: { messageId }, signal });
    if (!count(value?.lastRead)) invalid(); return value;
  }
}
