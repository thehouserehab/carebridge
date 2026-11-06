// Import this small, dependency-free module before loading any account UI.
// The fragment is transiently present on arrival, never an HTTP query token.
export function takeInvitationToken(location, history) {
  if (location.pathname !== '/account/invitation') return null;
  const fragment = location.hash, search = location.search;
  // Scrub even malformed or missing capabilities before reporting an error.
  history.replaceState(null, '', '/account/invitation');
  if (search || typeof fragment !== 'string' || !/^#token=[A-Za-z0-9_-]{40,100}$/.test(fragment))
    throw new Error('INVITATION_INVALID');
  return fragment.slice(7);
}
