import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { MEDIA_LIMITS, MEDIA_TYPES } from '../src/media-policy.js';
import { fail, RepositoryError } from './errors.mjs';

const ID = '[A-Za-z0-9_-]{1,100}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const pattern = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/messages/(${ID})/attachments/(${UUID})/content$`);
const recordPattern = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/records/(${ID})/revisions/([1-9][0-9]{0,9})/attachments/(${UUID})/content$`);
const feedbackPattern = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/messages/(${ID})/feedback-revisions/([1-9][0-9]{0,9})/attachments/(${UUID})/content$`);
const referencePattern = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/records/(${ID})/revisions/([1-9][0-9]{0,9})/references/(${ID})/attachments/(${UUID})/content$`);
const readers = new WeakMap();
const extensions = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' });

function readerState(mediaAccess) {
  if (!mediaAccess || !['object', 'function'].includes(typeof mediaAccess)) fail('LOCAL_API_UNAVAILABLE');
  let state = readers.get(mediaAccess);
  if (!state) {
    state = { closing: false, lifetimes: new Set() };
    readers.set(mediaAccess, state);
  }
  return state;
}

// Closing is permanent for this exact service. Wait for the actual open and
// disposal work, not merely the earlier HTTP timeout/disconnect response.
// A failed request is still drained successfully once its resources settle.
export async function drainLocalMediaContent(mediaAccess) {
  const state = readerState(mediaAccess);
  state.closing = true;
  await Promise.allSettled([...state.lifetimes]);
}

// Descriptor only. The parent handler must perform its existing source,
// session, expected-account and center guards BEFORE calling the streamer.
export function localMediaContentRoute(url, method) {
  const match = pattern.exec(url.pathname), record = recordPattern.exec(url.pathname),
    feedback = feedbackPattern.exec(url.pathname), reference = referencePattern.exec(url.pathname);
  if (!match && !record && !feedback && !reference) return null;
  if (method !== 'GET') fail('NOT_FOUND');
  if (url.searchParams.size) fail('INVALID_INPUT');
  if (record || reference) {
    const [, centerId, conversationId, recordId, number, target, referenceUpload] = record ?? reference;
    const revision = Number(number);
    if (revision > 2147483647) fail('INVALID_INPUT');
    return { centerId, conversationId, recordId, revision,
      ...(reference ? { messageId: target, uploadId: referenceUpload } : { uploadId: target }) };
  }
  if (feedback) {
    const [, centerId, conversationId, messageId, number, uploadId] = feedback;
    const feedbackRevision = Number(number);
    if (feedbackRevision > 2147483647) fail('INVALID_INPUT');
    return { centerId, conversationId, messageId, feedbackRevision, uploadId };
  }
  const [, centerId, conversationId, messageId, uploadId] = match;
  return { centerId, conversationId, messageId, uploadId };
}

function publicError(error) {
  if (error instanceof RepositoryError) {
    if (['NOT_FOUND', 'FORBIDDEN', 'UPLOAD_CONFLICT'].includes(error.code)) return new RepositoryError(error.code);
    if (['CONTENT_UNAVAILABLE', 'INVALID_RANGE'].includes(error.code)) return new RepositoryError('NOT_FOUND');
  }
  return new RepositoryError('LOCAL_API_UNAVAILABLE');
}
async function dispose(stream) {
  if (!(stream instanceof Readable)) return;
  // Keep cleanup observed even for a late open or a malformed manifest. A
  // resource slot is held until the actual stream lifecycle has settled.
  const settled = finished(stream, { cleanup: true }).catch(() => {});
  let onClose;
  const closed = stream.closed ? Promise.resolve() : new Promise((resolve) => {
    onClose = resolve; stream.once('close', onClose);
  });
  try {
    stream.destroy();
    await settled;
    // finished() may resolve at readable end when autoDestroy is disabled,
    // while an asynchronous _destroy is still releasing the resource.
    if (!stream.closed) await closed;
  } finally { if (onClose) stream.off('close', onClose); }
}
function validOpened(opened, uploadId) {
  const file = opened?.attachment, stream = opened?.stream;
  return file?.id === uploadId && MEDIA_TYPES.includes(file.type) && Number.isSafeInteger(file.size) && file.size > 0 &&
    file.size <= (file.type.startsWith('image/') ? MEDIA_LIMITS.image : MEDIA_LIMITS.video) &&
    opened.total === file.size && opened.range?.start === 0 && opened.range?.end === file.size - 1 &&
    stream instanceof Readable && !stream.destroyed && !stream.readableEnded && !stream.readableObjectMode && !stream.readableEncoding;
}

// Full-file fetch only, no original/upload-owner fallback and no filesystem
// path, raw name, hash or token response. Range is deliberately ignored (200).
export async function streamLocalMediaContent(route, identity, { mediaAccess } = {}, request, response, header) {
  if (!mediaAccess || typeof mediaAccess.open !== 'function' || typeof header !== 'function') fail('LOCAL_API_UNAVAILABLE');
  // Read only to enforce the parent's duplicate-header rule, never pass a
  // caller-selected range into the already-authorized serving-file contract.
  header(request, 'range');
  if (request.aborted || response.destroyed || response.writableEnded) return;
  const state = readerState(mediaAccess);
  if (state.closing) fail('LOCAL_API_UNAVAILABLE');
  if (state.lifetimes.size >= 2) fail('MEDIA_READ_BUSY');
  const controller = new AbortController();
  let opened, rejectInterrupted;
  const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
  const stop = (code) => {
    if (controller.signal.aborted) return;
    controller.abort(); rejectInterrupted(new RepositoryError(code));
  };
  const onAborted = () => stop('LOCAL_API_UNAVAILABLE');
  const onClose = () => { if (!response.writableFinished) onAborted(); };
  request.on('aborted', onAborted); request.on('error', onAborted); response.on('close', onClose);
  const timer = setTimeout(() => stop('REQUEST_TIMEOUT'), 30_000);
  timer.unref?.();
  // Register the lifetime below before calling into open(), so a same-turn
  // shutdown cannot miss an admitted request that has not reached its await.
  const work = Promise.resolve().then(async () => {
    try {
      opened = await mediaAccess.open(identity, { conversationId: route.conversationId, uploadId: route.uploadId,
        source: route.recordId === undefined ? { kind: 'message', messageId: route.messageId,
          ...(route.feedbackRevision === undefined ? {} : { feedbackRevision: route.feedbackRevision }) }
          : { kind: route.messageId === undefined ? 'record' : 'record-reference', recordId: route.recordId, revision: route.revision,
            ...(route.messageId === undefined ? {} : { messageId: route.messageId }) } });
      // open() cannot be cancelled midway through its authorization/store
      // check. If it settles late, finally destroys it without sending bytes.
      if (controller.signal.aborted) return;
      if (!validOpened(opened, route.uploadId)) fail('LOCAL_API_UNAVAILABLE');
      let size = 0;
      const exactSize = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(size > opened.total ? new RepositoryError('LOCAL_API_UNAVAILABLE') : null,
            size > opened.total ? undefined : chunk);
        },
        flush(callback) { callback(size !== opened.total ? new RepositoryError('LOCAL_API_UNAVAILABLE') : null); },
      });
      // No cache validators or partial-response metadata survive this route.
      for (const name of ['ETag', 'Last-Modified', 'Content-Range', 'Content-Encoding', 'Access-Control-Allow-Origin']) response.removeHeader(name);
      response.writeHead(200, {
        'Content-Type': opened.attachment.type, 'Content-Length': opened.total,
        'Content-Disposition': `attachment; filename="download.${extensions[opened.attachment.type]}"`,
        'Accept-Ranges': 'none', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
      });
      await pipeline(opened.stream, exactSize, response, { signal: controller.signal });
    } catch (error) { throw publicError(error); }
    finally { await dispose(opened?.stream); }
  });
  // A disconnected/timed-out caller does not release capacity while open()
  // or its stream cleanup is still pending. The late result stays observed.
  const lifetime = work.finally(() => { state.lifetimes.delete(lifetime); });
  state.lifetimes.add(lifetime);
  try { await Promise.race([lifetime, interrupted]); }
  catch (error) {
    if (response.headersSent) { response.destroy(); return; }
    if (!response.destroyed && !response.writableEnded) throw error;
  } finally {
    clearTimeout(timer);
    request.off('aborted', onAborted); request.off('error', onAborted); response.off('close', onClose);
  }
}
