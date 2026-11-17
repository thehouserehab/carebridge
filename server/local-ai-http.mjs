import { fail } from './errors.mjs';
import { AiRecordDrafts } from './ai-record-drafts.mjs';
import { AiConversations } from './ai-conversations.mjs';

const ID = '[A-Za-z0-9_-]{1,100}';
const pattern = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/records/(${ID})/ai-summary$`);
const conversationPattern = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/ai-conversation$`);
export function localAiRoute(url, method) {
  const match = pattern.exec(url.pathname);
  const chat = conversationPattern.exec(url.pathname);
  if (!match && !chat) return null;
  if (!['GET', 'POST'].includes(method)) fail('NOT_FOUND');
  const entries = [...url.searchParams];
  if (chat) {
    if (entries.length) fail('INVALID_INPUT');
    return { kind: 'conversation', centerId: chat[1], conversationId: chat[2], method };
  }
  let expectedRevision;
  if (method === 'GET') {
    if (entries.length !== 1 || entries[0][0] !== 'revision' || !/^[1-9][0-9]{0,9}$/.test(entries[0][1]))
      fail('INVALID_INPUT');
    expectedRevision = Number(entries[0][1]);
    if (expectedRevision > 2147483647) fail('INVALID_INPUT');
  } else if (entries.length) fail('INVALID_INPUT');
  return { kind: 'summary', centerId: match[1], conversationId: match[2], recordId: match[3], method, expectedRevision };
}
export async function executeLocalAi(route, identity, body, { aiDrafts, aiConversations }, { signal } = {}) {
  if (route.kind === 'conversation') {
    if (!(aiConversations instanceof AiConversations)) fail('AI_UNAVAILABLE');
    const selection = { conversationId: route.conversationId };
    if (route.method === 'GET') return { status: 200, body: { conversation: await aiConversations.get(identity, selection) } };
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).length !== 3 || Object.keys(body).some(key => !['requestId', 'expectedRevision', 'message'].includes(key)))
      fail('INVALID_INPUT');
    return { status: 200, body: { conversation: await aiConversations.send(identity, { ...selection, ...body }, { signal }) } };
  }
  if (!(aiDrafts instanceof AiRecordDrafts)) fail('AI_UNAVAILABLE');
  const selection = { conversationId: route.conversationId, recordId: route.recordId };
  if (route.method === 'GET') return { status: 200, body: { preview: await aiDrafts.preview(identity,
    { ...selection, expectedRevision: route.expectedRevision }) } };
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 3 || Object.keys(body).some(key => !['expectedRevision', 'sourceHash', 'requestId'].includes(key)))
    fail('INVALID_INPUT');
  return { status: 200, body: { draft: await aiDrafts.generate(identity, { ...selection, ...body }, { signal }) } };
}
