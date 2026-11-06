import { fail } from './errors.mjs';

const path = /^\/api\/local\/centers\/([A-Za-z0-9_-]{1,100})\/account\/profile$/;
const profileView = value => ({ userId: value.userId, role: value.role, displayName: value.displayName,
  revision: value.revision, updatedAt: value.updatedAt });
const receiptView = value => ({ operation: value.operation, userId: value.userId, childId: value.childId,
  conversationId: value.conversationId, appliedVersion: value.appliedVersion, changed: value.changed, replayed: value.replayed });

// Descriptor only. Common HTTP authentication, cookie-account binding and
// loopback/CSRF checks run before execution. There is no chosen user/role input.
export function localSelfProfileRoute(url, method) {
  const match = path.exec(url.pathname);
  if (!match) return null;
  if (!['GET', 'POST'].includes(method)) fail('NOT_FOUND');
  if ([...url.searchParams].length) fail('INVALID_INPUT');
  return { centerId: match[1], method };
}

export async function executeLocalSelfProfile(route, identity, body, members) {
  const method = route.method === 'GET' ? 'getSelf' : 'saveSelf';
  if (typeof members?.[method] !== 'function') fail('LOCAL_API_UNAVAILABLE');
  // The actor is selected by the common authenticated dispatcher. The service
  // rechecks active membership/user under a DB lock for reads, writes/replays.
  if (method === 'getSelf') return { status: 200, body: { profile: profileView(await members.getSelf(identity)) } };
  const keys = ['clientId', 'expectedRevision', 'displayName'];
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(body, key))) fail('INVALID_INPUT');
  // Reuse MemberProfiles -> memberDisplayName for normalization, explicit null
  // clearing, raw length/Unicode/control checks, CAS and immutable receipts.
  const value = await members.saveSelf(identity, { clientId: body.clientId,
    expectedRevision: body.expectedRevision, displayName: body.displayName });
  return { status: 200, body: { receipt: receiptView(value) } };
}
