import { MEDIA_LIMITS } from '../src/media-policy.js';
import { fail } from './errors.mjs';

const ID = '[A-Za-z0-9_-]{1,100}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const pattern = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/uploads(?:/(${UUID})(?:/(content|cancel))?)?$`);
const receivers = new WeakMap();
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== allowed.length || allowed.some((key) => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
}

// The sole HTTP entry point performs source/session/account checks. No
// inspection, administrative cleanup, approval, or original-byte GET route.
export function localMediaRoute(url, method) {
  const match = pattern.exec(url.pathname);
  if (!match) return null;
  const [, centerId, conversationId, uploadId, action] = match;
  if (method !== (uploadId && !action ? 'GET' : 'POST')) fail('NOT_FOUND');
  if (url.searchParams.size) fail('INVALID_INPUT');
  return { centerId, conversationId, uploadId, action, binary: action === 'content' };
}

export function mediaRequestHeaders(request, header) {
  const length = header(request, 'content-length');
  const version = header(request, 'x-carebridge-upload-version');
  if (header(request, 'transfer-encoding') !== undefined ||
      !/^[1-9][0-9]*$/.test(length ?? '') || !Number.isSafeInteger(Number(length)) ||
      !/^[1-9][0-9]*$/.test(version ?? '') || !Number.isInteger(Number(version)) || Number(version) > 2147483647) fail('INVALID_INPUT');
  if (Number(length) > MEDIA_LIMITS.video) fail('PAYLOAD_TOO_LARGE');
  return { size: Number(length), expectedVersion: Number(version) };
}

export async function executeLocalMedia(route, identity, body, {
  mediaUploads, mediaCleanup, mediaDelivery = false, mediaMaintenance = 'inline',
}, request, header) {
  // The Windows API role cannot perform worker maintenance. In worker mode
  // this adapter records cancel/delete intent only; the separate queue worker
  // performs physical cleanup and a later GET reports its actual outcome.
  if (!mediaUploads || !['inline', 'worker'].includes(mediaMaintenance) ||
      (mediaMaintenance === 'inline' ? typeof mediaCleanup !== 'function'
        : !mediaDelivery || mediaCleanup !== undefined)) fail('LOCAL_API_UNAVAILABLE');
  if (mediaDelivery && typeof mediaUploads.getTransferState !== 'function') fail('LOCAL_API_UNAVAILABLE');
  const { conversationId, uploadId, action } = route;
  let upload;
  if (!uploadId) {
    keys(body, ['clientId', 'file']);
    // Internal bounded maintenance, never an actor-selected target or route.
    if (mediaMaintenance === 'inline') await mediaCleanup();
    upload = await mediaUploads.reserve(identity, { conversationId, ...body });
  } else if (!action) upload = await mediaUploads.get(identity, { conversationId, uploadId });
  else if (action === 'cancel') {
    keys(body, ['expectedVersion']);
    await mediaUploads.cancel(identity, { conversationId, uploadId, ...body });
    if (mediaMaintenance === 'inline') await mediaCleanup();
    upload = await mediaUploads.get(identity, { conversationId, uploadId });
  } else {
    const { size, expectedVersion } = mediaRequestHeaders(request, header);
    // Authenticate and authorize ownership BEFORE consuming any file bytes.
    // receive() then rechecks ownership/version transactionally with its lease.
    const current = mediaDelivery ? await mediaUploads.getTransferState(identity, { conversationId, uploadId })
      : { source: await mediaUploads.get(identity, { conversationId, uploadId }) };
    if (current.source.size !== size) fail('INVALID_INPUT');
    const active = receivers.get(mediaUploads) ?? 0;
    if (active >= 2) fail('UPLOAD_BUSY');
    receivers.set(mediaUploads, active + 1);
    try {
      upload = await mediaUploads.receive(identity, { conversationId, uploadId, expectedVersion }, request);
      if (mediaMaintenance === 'inline') await mediaCleanup();
    } finally { receivers.set(mediaUploads, (receivers.get(mediaUploads) ?? 1) - 1); }
  }
  if (mediaDelivery) {
    const current = await mediaUploads.getTransferState(identity, { conversationId, uploadId: upload.id });
    return { status: 200, body: { mode: 'prepared-delivery', ...current,
      upload: { ...current.upload, ...(Object.hasOwn(upload, 'replayed') ? { replayed: upload.replayed } : {}) } } };
  }
  // The default memory-only sandbox remains quarantine-only. Enabling the
  // delivery adapter never scans or approves an upload; only a configured
  // separate worker can make a candidate ready through the domain service.
  return { status: 200, body: { upload, mode: 'quarantine-only' } };
}
