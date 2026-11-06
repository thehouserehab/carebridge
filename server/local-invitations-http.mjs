import { AUTH_LIMITS, INVITATION_ROLES, authFail, normalizeEmail } from './auth.mjs';

const ID = '[A-Za-z0-9_-]{1,100}';
const collectionPath = new RegExp(`^/api/local/centers/(${ID})/operations/invitations$`);
const revokePath = new RegExp(`^/api/local/centers/(${ID})/operations/invitations/(inv_[a-f0-9]{32})/revoke$`);
const receiverPath = /^\/api\/local\/auth\/invitations\/(preview|accept|accept-existing)$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.test$/i;
const invitationView = value => ({ id: value.id, centerId: value.centerId, role: value.role });
const listedView = value => ({ ...invitationView(value), email: value.email, status: value.status,
  createdAt: value.createdAt, expiresAt: value.expiresAt, acceptedAt: value.acceptedAt, revokedAt: value.revokedAt });

function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) authFail('INVALID_INPUT');
}
function method(service, name) {
  if (typeof service?.[name] !== 'function') authFail('LOCAL_API_UNAVAILABLE', 503);
}
function confirmation(body) {
  if (typeof body.centerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.centerId) ||
      !INVITATION_ROLES.includes(body.role)) authFail('INVALID_INPUT');
}

// Called only for a trusted, explicitly configured synthetic AccountDelivery.
// Tokens stay in JSON POST bodies, never query strings, paths or responses.
export function localInvitationsRoute(url, requestMethod) {
  const collection = collectionPath.exec(url.pathname), revoke = revokePath.exec(url.pathname);
  const receiver = receiverPath.exec(url.pathname);
  if (!collection && !revoke && !receiver) return null;
  if ((collection ? !['GET', 'POST'].includes(requestMethod) : requestMethod !== 'POST')) authFail('NOT_FOUND', 404);
  if ([...url.searchParams].length) authFail('INVALID_INPUT');
  return receiver ? { action: receiver[1], protected: receiver[1] === 'accept-existing' }
    : { action: revoke ? 'revoke' : requestMethod === 'GET' ? 'list' : 'issue',
      centerId: (collection ?? revoke)[1], invitationId: revoke?.[2], protected: true };
}

export async function executeLocalInvitation(route, { auth, accountDelivery, identity, sessionToken }, body) {
  if (route.action === 'list') {
    method(auth, 'listInvitations');
    const values = await auth.listInvitations(identity, { centerId: route.centerId, limit: 100 });
    return { status: 200, body: { invitations: values.map(listedView) } };
  }
  if (route.action === 'issue') {
    keys(body, ['email', 'role']);
    if (typeof body.email !== 'string' || !body.email.isWellFormed() || body.email.length > 254 ||
        /[\x00-\x1f\x7f-\x9f]/.test(body.email) || !EMAIL.test(body.email.trim()) ||
        !INVITATION_ROLES.includes(body.role)) authFail('INVALID_INPUT');
    // .test is reserved synthetic data. The fixed envelope origin alone would
    // not prevent a real recipient from being submitted to this local screen.
    const result = await accountDelivery.invite(identity,
      { centerId: route.centerId, email: normalizeEmail(body.email), role: body.role });
    // No issuance/transport result is a public proof of delivery. A lost
    // response is reconciled through the list, never an automatic re-issue.
    return { status: 202, body: { message: result.publicResponse.message } };
  }
  if (route.action === 'revoke') {
    keys(body, []); method(auth, 'revokeInvitation');
    await auth.revokeInvitation(identity, { centerId: route.centerId, invitationId: route.invitationId });
    return { status: 200, body: { revoked: true } };
  }
  if (route.action === 'preview') {
    keys(body, ['token']); method(auth, 'inspectInvitation');
    const value = await auth.inspectInvitation(body);
    return { status: 200, body: { invitation: { ...invitationView(value), expiresAt: value.expiresAt } } };
  }
  if (route.action === 'accept') {
    keys(body, ['token', 'centerId', 'role', 'password', 'confirmation']); confirmation(body);
    for (const value of [body.password, body.confirmation])
      if (typeof value !== 'string' || !value.isWellFormed() || value.length < AUTH_LIMITS.passwordMin ||
          value.length > AUTH_LIMITS.passwordMax) authFail('INVALID_INPUT');
    if (body.password !== body.confirmation) authFail('PASSWORD_CONFIRMATION_MISMATCH');
    method(auth, 'acceptInvitation');
    const result = await auth.acceptInvitation({ token: body.token, centerId: body.centerId, role: body.role, password: body.password });
    return { status: 200, user: result.user, sessionToken: result.token, invitation: invitationView(result.invitation) };
  }
  if (route.action === 'accept-existing') {
    keys(body, ['token', 'centerId', 'role']); confirmation(body); method(auth, 'acceptExistingInvitation');
    const result = await auth.acceptExistingInvitation(sessionToken, body);
    return { status: 200, user: result.user, invitation: invitationView(result.invitation), linked: true, replayed: result.replayed };
  }
  authFail('NOT_FOUND', 404);
}
