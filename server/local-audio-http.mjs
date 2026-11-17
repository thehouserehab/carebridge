import { fail } from './errors.mjs';
import { AiAudioNotes } from './ai-audio-notes.mjs';
import { AUDIO_NOTE_MAX_BYTES } from '../src/audio-note-contract.js';

const ID = '[A-Za-z0-9_-]{1,100}';
const pattern = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/records/(${ID})/audio-notes(?:/(${ID}))?(?:/(start|cancel|remove|original))?$`);
export const AUDIO_NOTE_JSON_LIMIT = Math.ceil(AUDIO_NOTE_MAX_BYTES / 3) * 4 + 4096;

export function localAudioRoute(url, method) {
  const match = pattern.exec(url.pathname);
  if (!match) return null;
  if ([...url.searchParams].length) fail('INVALID_INPUT');
  const [, centerId, conversationId, recordId, sessionId, action] = match;
  const expected = action === 'original' || (sessionId && !action) ? 'GET'
    : action ? 'POST' : null;
  if (!['GET', 'POST'].includes(method) || (expected && method !== expected)) fail('NOT_FOUND');
  return { centerId, conversationId, recordId, sessionId, action, method };
}

export function audioSelection(route) {
  return { conversationId: route.conversationId, recordId: route.recordId,
    ...(route.sessionId ? { sessionId: route.sessionId } : {}) };
}

export async function executeLocalAudio(route, identity, body, service, authorizeSession) {
  if (!(service instanceof AiAudioNotes)) fail('AI_UNAVAILABLE');
  const selection = audioSelection(route);
  const operation = body !== null && typeof body === 'object' && !Array.isArray(body);
  if (route.method === 'GET') {
    if (route.action === 'original') return { status: 200, original: await service.getOriginal(identity, selection) };
    return { status: 200, body: route.sessionId
      ? { session: await service.get(identity, selection) }
      : { sessions: await service.list(identity, selection) } };
  }
  if (!operation) fail('INVALID_INPUT');
  const keys = route.action === 'remove' ? [] : route.action ? ['expectedRevision', 'requestId']
    : ['expectedRevision', 'requestId', 'filename', 'type', 'base64', 'syntheticConfirmed', 'processingConfirmed'];
  if (Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) fail('INVALID_INPUT');
  if (route.action === 'remove') {
    await service.remove(identity, selection);
    return { status: 204, body: null };
  }
  const input = { ...selection, ...body };
  const session = route.action === 'start' ? await service.start(identity, input, { authorizeSession })
    : route.action === 'cancel' ? await service.cancel(identity, input)
    : await service.upload(identity, input);
  return { status: !route.action ? 201 : route.action === 'start' ? 202 : 200, body: { session } };
}
