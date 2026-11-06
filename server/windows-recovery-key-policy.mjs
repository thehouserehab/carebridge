import { win32 } from 'node:path';
import { privateSecretWindowsPath, privateSecretEnvironment, encodePrivateSecretFrame, decodePrivateSecretFrame } from './windows-private-secret-io.mjs';

export const KEY_STORE_LIMIT = 16384;
export const KEY_STORE_PURPOSE = 'carebridge-recovery-key';
export const keyStoreFailure = () => { const error = new Error('WINDOWS_RECOVERY_KEY_UNAVAILABLE'); error.code = error.message; throw error; };
export function recoveryKeyId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) keyStoreFailure();
  return value;
}
function windowsPath(value, drive) {
  try { return privateSecretWindowsPath(value,drive); } catch { keyStoreFailure(); }
}
export function recoveryKeyStoreOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((name) => !['base', 'powershell', 'syntheticRunId'].includes(name))) keyStoreFailure();
  const base = windowsPath(options.base, 'E'), powershell = windowsPath(options.powershell);
  if (base === win32.parse(base).root || win32.basename(powershell).toLowerCase() !== 'pwsh.exe') keyStoreFailure();
  const syntheticRunId = options.syntheticRunId === undefined ? null : recoveryKeyId(options.syntheticRunId);
  const privateRoot = win32.join(base, 'private');
  const root = syntheticRunId ? win32.join(privateRoot, 'checks', `key-check-${syntheticRunId}`) : win32.join(privateRoot, 'secrets', 'recovery-keys');
  return Object.freeze({ base, powershell, syntheticRunId, privateRoot, root });
}
export function recoveryKeyEnvironment(environment, powershell) {
  try { return privateSecretEnvironment(environment,powershell); } catch { keyStoreFailure(); }
}
export function canonicalKeyBase64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > 12000) keyStoreFailure();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64') !== value) { bytes.fill(0); keyStoreFailure(); }
  return bytes;
}
function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...names].sort().join(',')) keyStoreFailure();
}
export function validateProtectedRecoveryKey(value, keyId) {
  exact(value, ['schema', 'purpose', 'scope', 'keyId', 'createdAt', 'ownerSid', 'value']);
  if (value.schema !== 1 || value.purpose !== KEY_STORE_PURPOSE || value.scope !== 'CurrentUser' ||
      value.keyId !== recoveryKeyId(keyId) || typeof value.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt ||
      typeof value.ownerSid !== 'string' || !/^S-1-5-21-(\d{1,10}-){3}\d{1,10}$/.test(value.ownerSid)) keyStoreFailure();
  canonicalKeyBase64(value.value, 64, 8192).fill(0);
  return Object.freeze(value);
}
export function encodeKeyStoreFrame(value) {
  try { return encodePrivateSecretFrame(value); } catch { keyStoreFailure(); }
}
export function decodeKeyStoreFrame(frame) {
  try { return decodePrivateSecretFrame(frame); } catch { keyStoreFailure(); }
}
export function validateKeyStoreResponse(response, operation, keyId) {
  if (operation === 'protect') return validateProtectedRecoveryKey(response, keyId);
  exact(response, operation === 'check' ? ['schema','keyId','verified'] : ['schema','keyId','value']);
  if (response.schema !== 1 || response.keyId !== recoveryKeyId(keyId)) keyStoreFailure();
  if (operation === 'check') { if (response.verified !== true) keyStoreFailure(); return true; }
  if (operation !== 'unprotect') keyStoreFailure();
  return canonicalKeyBase64(response.value, 32, 32);
}
