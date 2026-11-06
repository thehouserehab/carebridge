import { LocalApiError, LOCAL_MEDIA_CONFLICT_CODES } from './client.js';
import { MEDIA_TYPES, MEDIA_LIMITS, matchesMediaSignature } from '../src/media-policy.js';

const messages = Object.freeze({
  MEDIA_INVALID_FILE: '지원 형식·파일 이름·용량을 확인해 주세요. 실제 자료는 선택하지 마세요.',
  MEDIA_LIMIT: '선택 목록마다 최대 6개, 같은 용도의 첨부 선택은 합계 24개·100MB까지 시험할 수 있어요. 먼저 선택 또는 업로드를 취소해 주세요.',
  MEDIA_BUSY: '진행 중인 파일 확인이 끝난 뒤 다시 시도해 주세요.',
});
export class MediaApiError extends LocalApiError {
  constructor(code, status = 0) { super(code, status); if (messages[code]) this.message = messages[code]; }
}
const fail = (code = 'INVALID_RESPONSE') => { throw new MediaApiError(code); };
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).every((key) => keys.includes(key));
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const uuid = (v) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const version = (v) => Number.isInteger(v) && v > 0 && v <= 2147483647;
const states = new Set(['pending', 'receiving', 'quarantined', 'rejected', 'delete_pending', 'deleted']);
const preparedStates = new Set([...states, 'inspecting', 'ready', 'bound']);
const failures = new Set(['UPLOAD_INTERRUPTED', 'SIZE_MISMATCH', 'HASH_MISMATCH', 'FORMAT_MISMATCH', 'SCAN_INVALID', 'SCAN_UNAVAILABLE', 'SCAN_REJECTED']);
function fileMetadata(file) {
  if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 ||
      !file.name.isWellFormed() || /[\x00-\x1f\x7f/\\]/.test(file.name) || !MEDIA_TYPES.includes(file.type) ||
      !Number.isSafeInteger(file.size) || file.size < 1 ||
      file.size > (file.type.startsWith('image/') ? MEDIA_LIMITS.image : MEDIA_LIMITS.video)) fail('MEDIA_INVALID_FILE');
  return { name: file.name.trim(), type: file.type, size: file.size };
}
function manifest(value) {
  if (!exact(value, ['name', 'type', 'size', 'sha256']) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('INVALID_INPUT');
  return Object.freeze({ ...fileMetadata(value), sha256: value.sha256 });
}
const aborted = (signal) => { if (signal?.aborted) fail('CANCELLED'); };

// This is a bounded client-side format hint plus an immutable upload manifest,
// not decoding, malware inspection, approval or permission to send a message.
export async function mediaFileManifest(file, signal) {
  if (!(file instanceof Blob)) fail('MEDIA_INVALID_FILE');
  const metadata = fileMetadata(file); aborted(signal);
  const prefix = new Uint8Array(await file.slice(0, 40).arrayBuffer()); aborted(signal);
  if (!matchesMediaSignature(metadata.type, prefix)) fail('MEDIA_INVALID_FILE');
  const bytes = await file.arrayBuffer(); aborted(signal);
  if (bytes.byteLength !== metadata.size) fail('MEDIA_INVALID_FILE');
  const digest = await crypto.subtle.digest('SHA-256', bytes); aborted(signal);
  return Object.freeze({ ...metadata, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') });
}

function uploadResult(value, roomId, expectedId) {
  const prepared = value?.mode === 'prepared-delivery';
  if (!exact(value, prepared ? ['upload', 'mode', 'source'] : ['upload', 'mode']) ||
      (!prepared && value.mode !== 'quarantine-only')) fail();
  const u = value.upload;
  if (!exact(u, ['id', 'conversationId', 'name', 'type', 'size', 'state', 'version', 'failureCode', 'expiresAt', 'expired', 'replayed']) ||
      !uuid(u.id) || (expectedId && u.id !== expectedId) || u.conversationId !== roomId ||
      !(prepared ? preparedStates : states).has(u.state) || !version(u.version) || typeof u.expired !== 'boolean' ||
      !(u.failureCode === null || failures.has(u.failureCode)) ||
      (u.state === 'bound' ? u.expiresAt !== null || u.expired : typeof u.expiresAt !== 'string' || !Number.isFinite(Date.parse(u.expiresAt))) ||
      (Object.hasOwn(u, 'replayed') && typeof u.replayed !== 'boolean')) fail();
  let metadata; try { metadata = fileMetadata(u); } catch { fail(); }
  if (metadata.name !== u.name) fail();
  let source;
  if (prepared) {
    if (!exact(value.source, ['name', 'type', 'size'])) fail();
    try { source = Object.freeze(fileMetadata(value.source)); } catch { fail(); }
    if (source.name !== value.source.name || source.name !== metadata.name || source.type !== metadata.type ||
        (['pending', 'receiving', 'quarantined', 'inspecting', 'rejected'].includes(u.state) && source.size !== metadata.size)) fail();
    // A cancelled former ready/bound upload may retain its prepared size.
    // Never interpret that size as the immutable source-upload manifest.
  }
  return Object.freeze({ id: u.id, conversationId: roomId, ...metadata, state: u.state, version: u.version,
    failureCode: u.failureCode, expiresAt: u.expiresAt, expired: u.expired,
    ...(Object.hasOwn(u, 'replayed') ? { replayed: u.replayed } : {}),
    ...(prepared ? { mode: 'prepared-delivery', source } : {}) });
}
function sameManifest(upload, file) {
  const source = upload.mode === 'prepared-delivery' ? upload.source : upload;
  if (!source || source.name !== file.name || source.type !== file.type || source.size !== file.size) fail();
  return upload;
}

async function cancelBody(body) {
  try { await body?.cancel?.(); } catch { /* Cancellation errors must never expose transport internals. */ }
}

// Allocate at most the validated format cap, not one retained object per
// arbitrary network chunk. Every exit closes/cancels and unlocks its reader.
async function boundedBody(body, limit, check, signal) {
  let reader, complete = false, cancellation;
  const cancel = () => {
    if (!cancellation) {
      try { cancellation = Promise.resolve(reader.cancel()).catch(() => {}); }
      catch { cancellation = Promise.resolve(); }
    }
    return cancellation;
  };
  try {
    if (!body || typeof body.getReader !== 'function') fail();
    reader = body.getReader();
    signal.addEventListener('abort', cancel, { once: true });
    check();
    const bytes = new Uint8Array(limit); let size = 0;
    while (true) {
      check();
      const chunk = await reader.read();
      check();
      if (chunk.done) { complete = true; break; }
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength > limit - size) fail();
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    return bytes.subarray(0, size);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (reader) {
      if (!complete) await cancel();
      try { reader.releaseLock(); } catch { /* Preserve the fixed operation error. */ }
    } else await cancelBody(body);
  }
}

// Approval is never a client action. Status mode is supplied by the server;
// a file read always requires a bound message or exact record revision anchor
// and fresh authorization. Callers cannot supply an arbitrary content URL.
export class MediaApiClient {
  constructor(api, { timeoutMs = 20000 } = {}) {
    if (!api || typeof api.request !== 'function' || typeof api.fetch !== 'function' ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20000) throw new TypeError('A local API client and bounded timeout are required.');
    this.api = api; this.timeoutMs = timeoutMs;
  }
  scope(input) {
    if (!exact(input, ['userId', 'centerId', 'roomId']) || !id(input.userId) || !id(input.centerId) || !id(input.roomId)) fail('INVALID_INPUT');
    const scope = Object.freeze({ userId: input.userId, centerId: input.centerId, roomId: input.roomId });
    this.current(scope); return scope;
  }
  current(scope, signal) {
    aborted(signal);
    if (this.api.expectedUserId !== scope.userId) fail('AUTH_REQUIRED');
  }
  path(scope) { return `/api/local/centers/${scope.centerId}/conversations/${scope.roomId}/uploads`; }
  async json(scope, path, body, signal, expectedId) {
    this.current(scope, signal);
    try {
      const response = await this.api.request(path, { ...(body === undefined ? {} : { body }), signal });
      this.current(scope, signal); return uploadResult(response, scope.roomId, expectedId);
    } catch (error) {
      this.current(scope, signal);
      if (error instanceof LocalApiError) throw new MediaApiError(error.code, error.status);
      throw new MediaApiError('UNAVAILABLE');
    }
  }
  async reserve(input, operation, signal) {
    const scope = this.scope(input);
    if (!exact(operation, ['clientId', 'file']) || typeof operation.clientId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(operation.clientId)) fail('INVALID_INPUT');
    const body = Object.freeze({ clientId: operation.clientId, file: manifest(operation.file) });
    return sameManifest(await this.json(scope, this.path(scope), body, signal), body.file);
  }
  async get(input, uploadId, signal) {
    const scope = this.scope(input); if (!uuid(uploadId)) fail('INVALID_INPUT');
    return this.json(scope, `${this.path(scope)}/${uploadId}`, undefined, signal, uploadId);
  }
  async cancel(input, upload, signal) {
    const scope = this.scope(input), uploadId = upload?.id, expectedVersion = upload?.version;
    if (!uuid(uploadId) || !version(expectedVersion) || upload.conversationId !== scope.roomId) fail('INVALID_INPUT');
    return this.json(scope, `${this.path(scope)}/${uploadId}/cancel`, Object.freeze({ expectedVersion }), signal, uploadId);
  }
  async receive(input, upload, file, signal) {
    const scope = this.scope(input), uploadId = upload?.id, expectedVersion = upload?.version;
    if (!uuid(uploadId) || !version(expectedVersion) || upload.conversationId !== scope.roomId || upload.state !== 'pending' || upload.expired || !(file instanceof Blob)) fail('INVALID_INPUT');
    const metadata = Object.freeze(fileMetadata(file)); sameManifest(upload, metadata);
    this.current(scope, signal);
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const response = await this.api.fetch(`${this.path(scope)}/${uploadId}/content`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream',
          'X-Carebridge-Request': '1', 'X-Carebridge-Account': scope.userId, 'X-Carebridge-Upload-Version': String(expectedVersion) },
        // The browser supplies Content-Length for the immutable File body.
        body: file, signal: combined,
      });
      this.current(scope, signal); if (timeout.signal.aborted) fail('UNAVAILABLE');
      if (!response.headers.get('content-type')?.startsWith('application/json')) fail();
      let result; try { result = await response.json(); } catch { fail(); }
      this.current(scope, signal); if (timeout.signal.aborted) fail('UNAVAILABLE');
      if (!response.ok) {
        const code = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'FORBIDDEN'
          : response.status === 404 ? 'NOT_FOUND' : [400, 413].includes(response.status) ? 'INVALID_INPUT'
            : response.status === 409 ? (LOCAL_MEDIA_CONFLICT_CODES.includes(result?.error) || result?.error === 'IDEMPOTENCY_CONFLICT' ? result.error : 'UNAVAILABLE') : 'UNAVAILABLE';
        throw new MediaApiError(code, response.status);
      }
      return sameManifest(uploadResult(result, scope.roomId, uploadId), metadata);
    } catch (error) {
      this.current(scope, signal);
      if (error instanceof LocalApiError) throw new MediaApiError(error.code, error.status);
      throw new MediaApiError('UNAVAILABLE');
    } finally { clearTimeout(timer); }
  }
  async openMessageAttachment(input, messageId, attachment, signal) {
    const scope = this.scope(input);
    if (!id(messageId)) fail('INVALID_INPUT');
    return this.#openAttachment(scope, `messages/${messageId}`, attachment, signal);
  }
  async openRecordAttachment(input, recordId, revision, attachment, signal) {
    const scope = this.scope(input);
    if (!id(recordId) || !version(revision)) fail('INVALID_INPUT');
    return this.#openAttachment(scope, `records/${recordId}/revisions/${revision}`, attachment, signal);
  }
  async openFeedbackAttachment(input, messageId, revision, attachment, signal) {
    const scope = this.scope(input);
    if (!id(messageId) || !version(revision)) fail('INVALID_INPUT');
    return this.#openAttachment(scope, `messages/${messageId}/feedback-revisions/${revision}`, attachment, signal);
  }
  async openReferenceAttachment(input, recordId, revision, messageId, attachment, signal) {
    const scope = this.scope(input);
    if (!id(recordId) || !version(revision) || !id(messageId)) fail('INVALID_INPUT');
    return this.#openAttachment(scope, `records/${recordId}/revisions/${revision}/references/${messageId}`, attachment, signal);
  }
  async #openAttachment(scope, anchor, attachment, signal) {
    if (!exact(attachment, ['id', 'name', 'type', 'size']) || !uuid(attachment.id)) fail('INVALID_INPUT');
    let metadata;
    try { metadata = Object.freeze({ id: attachment.id, ...fileMetadata(attachment) }); }
    catch { fail('INVALID_INPUT'); }
    if (metadata.name !== attachment.name) fail('INVALID_INPUT');
    this.current(scope, signal);
    const timeout = new AbortController(), deadline = performance.now() + this.timeoutMs;
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const check = () => {
      this.current(scope, signal);
      if (timeout.signal.aborted || performance.now() >= deadline) { timeout.abort(); fail('UNAVAILABLE'); }
    };
    let response, consumed = false;
    try {
      response = await this.api.fetch(`/api/local/centers/${scope.centerId}/conversations/${scope.roomId}/${anchor}/attachments/${metadata.id}/content`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { Accept: metadata.type, 'X-Carebridge-Account': scope.userId }, signal: combined,
      });
      check();
      if (response.status !== 200) {
        let errorCode = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'FORBIDDEN'
          : response.status === 404 ? 'NOT_FOUND' : [400, 413].includes(response.status) ? 'INVALID_INPUT'
            : response.status === 206 ? 'INVALID_RESPONSE' : 'UNAVAILABLE';
        // Only a small, bounded JSON conflict body can select a known code.
        // Other errors are mapped by status and their raw bodies are cancelled.
        if (response.status === 409 && response.headers.get('content-type')?.startsWith('application/json')) {
          consumed = true;
          const bytes = await boundedBody(response.body, 8192, check, combined);
          try {
            const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            if (LOCAL_MEDIA_CONFLICT_CODES.includes(result?.error)) errorCode = result.error;
          } catch { /* Unknown server details never become an error message. */ }
        }
        throw new MediaApiError(errorCode, response.status);
      }
      const length = response.headers.get('content-length');
      if (response.redirected || response.headers.get('content-type') !== metadata.type ||
          !/^[1-9][0-9]*$/.test(length ?? '') || Number(length) !== metadata.size ||
          response.headers.has('content-range') || response.headers.has('content-encoding')) fail();
      consumed = true;
      const bytes = await boundedBody(response.body, metadata.size, check, combined);
      check(); if (bytes.byteLength !== metadata.size) fail();
      const blob = new Blob([bytes], { type: metadata.type });
      check(); return blob;
    } catch (error) {
      this.current(scope, signal);
      if (error instanceof LocalApiError) throw new MediaApiError(error.code, error.status);
      throw new MediaApiError('UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      if (!consumed) await cancelBody(response?.body);
    }
  }
}
