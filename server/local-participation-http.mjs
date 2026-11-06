import { fail } from './errors.mjs';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const endpoint = /^\/api\/local\/centers\/([A-Za-z0-9_-]{1,100})\/(care-recipient-link|primary-communicator)(\/disconnect)?$/;
const keys = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
};
const linkView = value => ({ conversationId: value.conversationId, childId: value.childId,
  userId: value.userId, active: value.active, version: value.version });
const primaryView = value => ({ conversationId: value.conversationId, userId: value.userId, revision: value.revision });

// A closed, local-only route description. The common handler owns session,
// account precondition, origin/CSRF checks; services recheck current authority.
export function localParticipationRoute(url, method) {
  const match = endpoint.exec(url.pathname);
  if (!match) return null;
  const kind = match[2] === 'care-recipient-link' ? 'link' : 'primary';
  const disconnect = match[3] !== undefined;
  if (!['GET', 'POST'].includes(method) || (disconnect && (kind !== 'link' || method !== 'POST'))) fail('NOT_FOUND');
  let conversationId;
  if (method === 'GET') {
    if (url.searchParams.size !== 1 || !url.searchParams.has('conversationId')) fail('INVALID_INPUT');
    conversationId = url.searchParams.get('conversationId');
    if (!ID.test(conversationId)) fail('INVALID_INPUT');
  } else if (url.searchParams.size !== 0) fail('INVALID_INPUT');
  return { centerId: match[1], kind, method, disconnect, conversationId,
    managerOnly: kind === 'link' || method === 'POST' };
}

export async function executeLocalParticipation(route, identity, body, services) {
  const service = route.kind === 'link' ? services.careRecipientLinks : services.primaryCommunicators;
  const method = route.method === 'GET' ? 'get' : route.kind === 'primary' ? 'save' : route.disconnect ? 'disconnect' : 'connect';
  if (typeof service?.[method] !== 'function') fail('LOCAL_API_UNAVAILABLE');
  if (method === 'get') {
    const value = await service.get(identity, { conversationId: route.conversationId });
    return { status: 200, body: route.kind === 'link' ? { link: linkView(value) } : { primary: primaryView(value) } };
  }
  keys(body, ['conversationId', 'userId', 'clientId', route.kind === 'link' ? 'expectedVersion' : 'expectedRevision']);
  if (typeof body.conversationId !== 'string' || !ID.test(body.conversationId) ||
      (!(route.kind === 'primary' && body.userId === null) && (typeof body.userId !== 'string' || !ID.test(body.userId)))) fail('INVALID_INPUT');
  const saved = await service[method](identity, body);
  return { status: 200, body: { receipt: { conversationId: saved.conversationId,
    ...(route.kind === 'link' ? { appliedVersion: saved.appliedVersion } : { appliedRevision: saved.appliedRevision }),
    changed: saved.changed, replayed: saved.replayed } } };
}
