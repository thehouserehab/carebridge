import { fail } from './errors.mjs';
import { localMessageView } from './local-care-http.mjs';

const ID = '[A-Za-z0-9_-]{1,100}';
const pathPattern = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/messages/(${ID})(?:/(edit|delete|review))?$`);
function keys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
}

// This is only a closed route descriptor. The sole local-api-http entry point
// verifies source, session and expected account before executing any service.
export function localMessageRoute(url, method) {
  const match = pathPattern.exec(url.pathname);
  if (!match) return null;
  const [, centerId, conversationId, messageId, operation] = match;
  if (operation === 'review' ? !['GET', 'POST'].includes(method) : method !== (operation ? 'POST' : 'GET')) fail('NOT_FOUND');
  if (url.searchParams.size) fail('INVALID_INPUT');
  return { centerId, conversationId, messageId, operation, ...(operation === 'review' ? { method } : {}) };
}

export async function executeLocalMessage(route, identity, body, conversations, viewOptions = {}) {
  const { conversationId, messageId, operation } = route;
  if (operation === 'review') {
    const method = route.method === 'GET' ? 'textReview' : 'textReviewSave';
    if (typeof conversations?.[method] !== 'function') fail('LOCAL_API_UNAVAILABLE');
    if (route.method === 'GET') {
      const review = await conversations.textReview(identity, { conversationId, messageId });
      return { status: 200, body: { review: Object.fromEntries(['messageId', 'conversationId', 'revision', 'reviewVersion',
        'reviewedRevision', 'note', 'body', 'attachmentCount'].map(key => [key, review[key]])) } };
    }
    keys(body, ['clientId', 'expectedRevision', 'expectedReviewVersion', 'note']);
    const receipt = await conversations.textReviewSave(identity, { conversationId, messageId, ...body });
    return { status: 200, body: { receipt: { messageId: receipt.messageId, revision: receipt.revision,
      reviewVersion: receipt.reviewVersion, operation: 'review', replayed: receipt.replayed === true } } };
  }
  const method = operation === 'edit' ? 'editText' : operation === 'delete' ? 'deleteText' : 'get';
  if (typeof conversations?.[method] !== 'function') fail('LOCAL_API_UNAVAILABLE');
  if (!operation) return { status: 200, body: { message: localMessageView(await conversations.get(identity, { conversationId, messageId }), viewOptions) } };
  if (operation === 'edit') {
    keys(body, ['clientId', 'expectedRevision', 'body']);
    if (typeof body.body !== 'string' || !body.body.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(body.body)) fail('INVALID_INPUT');
  } else keys(body, ['clientId', 'expectedRevision', 'scope', 'confirmed'], ['clientId', 'scope', 'confirmed']);
  // Do not pre-read current capability/version here. An exact committed retry
  // must still reach the service receipt after expiry, deletion or self-hide.
  // The existing transactional service owns author, clock, current history,
  // immutable attachment bindings, optimistic version and idempotency checks.
  const receipt = await conversations[method](identity, { conversationId, messageId, ...body });
  return { status: 200, body: { receipt: {
    messageId: receipt.messageId, revision: receipt.revision, operation: receipt.operation, replayed: receipt.replayed === true,
  } } };
}
