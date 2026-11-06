import { LocalApiError } from './client.js';

// Synthetic local launchers only: this is not a production email policy.
export function syntheticAccountEmail(value) {
  const invalid = () => { throw new LocalApiError('INVALID_INPUT'); };
  if (typeof value !== 'string' || value.length > 254 || !value.isWellFormed() || /[\x00-\x1f\x7f-\x9f]/.test(value)) invalid();
  const email = value.trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.test$/.test(email)) invalid();
  return email;
}
