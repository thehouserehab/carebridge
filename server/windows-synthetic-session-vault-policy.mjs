import { win32 } from 'node:path';
import { privateSecretWindowsPath, encodePrivateSecretFrame, decodePrivateSecretFrame } from './windows-private-secret-io.mjs';

export const SESSION_VAULT_PURPOSE = 'carebridge-synthetic-session';
export const SESSION_VAULT_PAYLOAD_LIMIT = 8192;
export const SESSION_VAULT_CIPHERTEXT_LIMIT = 9216;
export const sessionVaultFailure = () => {
  const error = new Error('WINDOWS_SYNTHETIC_SESSION_VAULT_UNAVAILABLE'); error.code = error.message; throw error;
};
export function sessionVaultId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) sessionVaultFailure();
  return value;
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) sessionVaultFailure();
}
export function syntheticSessionVaultOptions(input) {
  try {
    exact(input,['base','powershell','syntheticRunId']);
    const base = privateSecretWindowsPath(input.base,'E'), powershell = privateSecretWindowsPath(input.powershell);
    if (base === win32.parse(base).root || win32.basename(powershell).toLowerCase() !== 'pwsh.exe') sessionVaultFailure();
    const syntheticRunId = sessionVaultId(input.syntheticRunId), privateRoot = win32.join(base,'private');
    return Object.freeze({base,powershell,syntheticRunId,privateRoot,root:win32.join(privateRoot,'checks',`session-vault-${syntheticRunId}`)});
  } catch { sessionVaultFailure(); }
}
export function canonicalVaultBase64(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length > 12288) sessionVaultFailure();
  const bytes = Buffer.from(value,'base64');
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64') !== value) {
    bytes.fill(0); sessionVaultFailure();
  }
  return bytes;
}
export function validateProtectedSessionVault(value, vaultId, options) {
  exact(value,['schema','purpose','scope','syntheticRunId','vaultId','root','createdAt','ownerSid','value']);
  if (value.schema !== 1 || value.purpose !== SESSION_VAULT_PURPOSE || value.scope !== 'CurrentUser' ||
      value.vaultId !== sessionVaultId(vaultId) || value.syntheticRunId !== sessionVaultId(options?.syntheticRunId) ||
      value.root !== options?.root || typeof value.root !== 'string' ||
      typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt ||
      typeof value.ownerSid !== 'string' || !/^S-1-5-21-(\d{1,10}-){3}\d{1,10}$/.test(value.ownerSid)) sessionVaultFailure();
  canonicalVaultBase64(value.value,64,SESSION_VAULT_CIPHERTEXT_LIMIT).fill(0);
  return Object.freeze(value);
}
export function validateSessionVaultResponse(value, operation, vaultId, options) {
  if (operation === 'protect') return validateProtectedSessionVault(value,vaultId,options);
  if (!['check','unprotect'].includes(operation)) sessionVaultFailure();
  exact(value,operation === 'check' ? ['schema','vaultId','verified'] : ['schema','vaultId','value']);
  if (value.schema !== 1 || value.vaultId !== sessionVaultId(vaultId)) sessionVaultFailure();
  if (operation === 'check') { if (value.verified !== true) sessionVaultFailure(); return true; }
  return canonicalVaultBase64(value.value,32,SESSION_VAULT_PAYLOAD_LIMIT);
}
export function encodeSessionVaultFrame(value) {
  try { return encodePrivateSecretFrame(value); } catch { sessionVaultFailure(); }
}
export function decodeSessionVaultFrame(value) {
  try { return decodePrivateSecretFrame(value); } catch { sessionVaultFailure(); }
}
