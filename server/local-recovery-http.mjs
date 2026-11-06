import { AUTH_LIMITS, authFail } from './auth.mjs';

const path = /^\/api\/local\/auth\/password-recovery\/(request|complete)$/;
function keys(body, names) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(body, key))) authFail('INVALID_INPUT');
}
export function localRecoveryRoute(url, method) {
  const match = path.exec(url.pathname);
  if (!match) return null;
  if (method !== 'POST') authFail('NOT_FOUND', 404);
  if ([...url.searchParams].length) authFail('INVALID_INPUT');
  return { action: match[1] };
}
export async function executeLocalRecovery(route, { auth, passwordRecovery }, body) {
  if (route.action === 'request') {
    keys(body, ['email']);
    return { status: 202, body: passwordRecovery.request(body) };
  }
  if (route.action === 'complete') {
    keys(body, ['token', 'newPassword', 'confirmation']);
    for (const value of [body.newPassword, body.confirmation])
      if (typeof value !== 'string' || !value.isWellFormed() || value.length < AUTH_LIMITS.passwordMin ||
          value.length > AUTH_LIMITS.passwordMax) authFail('INVALID_INPUT');
    if (typeof auth?.completePasswordRecovery !== 'function') authFail('LOCAL_API_UNAVAILABLE', 503);
    const result = await auth.completePasswordRecovery(body);
    if (result?.passwordChanged !== true || result?.reauthenticate !== true) authFail('LOCAL_API_UNAVAILABLE', 503);
    return { status: 200, body: { passwordChanged: true, reauthenticate: true } };
  }
  authFail('NOT_FOUND', 404);
}
