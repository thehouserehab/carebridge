// The only static import of the recovery entry: no network or DOM dependencies.
export const isRecoveryToken = value => typeof value === 'string' && value.length === 47 && /^cr1\.[A-Za-z0-9_-]{43}$/.test(value);

export function takeRecoveryLocation(location, history) {
  const path = location.pathname, query = location.search, fragment = location.hash;
  const request = path === '/account/password-recovery/request';
  const complete = path === '/account/password-recovery';
  // Even malformed capabilities/query parameters disappear before other imports.
  try { history.replaceState(null, '', request ? '/account/password-recovery/request' : '/account/password-recovery'); }
  catch { throw new Error('PASSWORD_RECOVERY_INVALID'); }
  if ((!request && !complete) || query || typeof fragment !== 'string' ||
      (request ? fragment !== '' : !fragment.startsWith('#token=') || !isRecoveryToken(fragment.slice(7))))
    throw new Error('PASSWORD_RECOVERY_INVALID');
  return Object.freeze({ mode: request ? 'request' : 'complete', token: request ? null : fragment.slice(7) });
}
