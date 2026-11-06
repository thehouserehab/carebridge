import { win32 } from 'node:path';
import { databasePrivilegePlan, DATABASE_SERVICE_ROLE_KINDS } from './database-privilege-policy.mjs';
import { privateSecretWindowsPath } from './windows-private-secret-io.mjs';

export const DATABASE_CREDENTIAL_PURPOSE = 'carebridge-database-credential';
export const credentialFailure = () => {
  const error = new Error('WINDOWS_DATABASE_CREDENTIAL_UNAVAILABLE'); error.code = error.message; throw error;
};
const exact = (value,names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...names].sort().join(',')) credentialFailure();
};
export function databaseCredentialId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) credentialFailure();
  return value;
}
export function databaseCredentialOptions(options) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some((key) => !['base','powershell','syntheticRunId'].includes(key))) credentialFailure();
    const base = privateSecretWindowsPath(options.base,'E'), powershell = privateSecretWindowsPath(options.powershell);
    if (base === win32.parse(base).root || win32.basename(powershell).toLowerCase() !== 'pwsh.exe') credentialFailure();
    const syntheticRunId = options.syntheticRunId === undefined ? null : databaseCredentialId(options.syntheticRunId);
    const privateRoot = win32.join(base,'private');
    const root = syntheticRunId ? win32.join(privateRoot,'checks',`credential-check-${syntheticRunId}`) : win32.join(privateRoot,'secrets','database-credentials');
    return Object.freeze({base,powershell,syntheticRunId,privateRoot,root});
  } catch { credentialFailure(); }
}
export function databaseCredentialBinding(privileges,kind) {
  try {
    if (!DATABASE_SERVICE_ROLE_KINDS.includes(kind)) credentialFailure();
    const plan = databasePrivilegePlan(privileges);
    return Object.freeze({kind,roleName:plan.roles[kind],databaseName:plan.target.name,databaseOid:plan.target.oid,ownerOid:plan.target.ownerOid});
  } catch { credentialFailure(); }
}
export function validateDatabasePassword(bytes) {
  // Intended for newly generated service secrets, not human or legacy passwords.
  // Printable ASCII avoids NUL/encoding/whitespace ambiguity in future adapters.
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > 1024 || bytes.some((byte) => byte < 33 || byte > 126)) credentialFailure();
  return bytes;
}
function base64(value,minimum,maximum) {
  if (typeof value !== 'string' || value.length > 12000) credentialFailure();
  const bytes = Buffer.from(value,'base64');
  if (bytes.length < minimum || bytes.length > maximum || bytes.toString('base64') !== value) { bytes.fill(0); credentialFailure(); }
  return bytes;
}
function bindingMatches(value,binding) {
  exact(value,['kind','roleName','databaseName','databaseOid','ownerOid']);
  if (Object.keys(binding).some((key) => value[key] !== binding[key])) credentialFailure();
}
export function validateProtectedDatabaseCredential(value,id,binding) {
  exact(value,['schema','purpose','scope','credentialId','binding','createdAt','ownerSid','value']);
  if (value.schema !== 1 || value.purpose !== DATABASE_CREDENTIAL_PURPOSE || value.scope !== 'CurrentUser' ||
      value.credentialId !== databaseCredentialId(id) || typeof value.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
      !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt ||
      typeof value.ownerSid !== 'string' || !/^S-1-5-21-(\d{1,10}-){3}\d{1,10}$/.test(value.ownerSid)) credentialFailure();
  bindingMatches(value.binding,binding); base64(value.value,64,8192).fill(0);
  return Object.freeze(value);
}
export function validateDatabaseCredentialResponse(value,operation,id,binding) {
  if (operation === 'protect') return validateProtectedDatabaseCredential(value,id,binding);
  exact(value,operation === 'check' ? ['schema','credentialId','binding','verified'] : ['schema','credentialId','binding','value']);
  if (value.schema !== 1 || value.credentialId !== databaseCredentialId(id)) credentialFailure();
  bindingMatches(value.binding,binding);
  if (operation === 'check') { if (value.verified !== true) credentialFailure(); return true; }
  if (operation !== 'unprotect') credentialFailure();
  const password = base64(value.value,32,1024);
  try { return validateDatabasePassword(password); } catch { password.fill(0); credentialFailure(); }
}
