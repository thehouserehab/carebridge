import { fileURLToPath } from 'node:url';
import { SESSION_VAULT_PURPOSE, SESSION_VAULT_PAYLOAD_LIMIT, sessionVaultFailure, sessionVaultId,
  syntheticSessionVaultOptions, validateProtectedSessionVault, validateSessionVaultResponse } from './windows-synthetic-session-vault-policy.mjs';
import { invokeWindowsSecretProvider, persistPrivateEnvelope, readPrivateEnvelope } from './windows-private-secret-io.mjs';

const provider = fileURLToPath(new URL('../scripts/windows-synthetic-session-vault-provider.ps1',import.meta.url));
const receipt = '.carebridge-session-vault.json';
const invoke = (options,operation,envelope) => invokeWindowsSecretProvider(options,{
  schema:1,operation,base:options.base,syntheticRunId:options.syntheticRunId,
  purpose:SESSION_VAULT_PURPOSE,scope:'CurrentUser',vaultId:envelope.vaultId,root:options.root,
  createdAt:envelope.createdAt,ownerSid:envelope.ownerSid ?? null,value:envelope.value,
},provider,(response) => validateSessionVaultResponse(response,operation,envelope.vaultId,options));

// Trusted synthetic-session custody only. The caller validates the payload's
// exact JSON schema and lifecycle; this primitive neither adopts nor starts a
// session. No rotation, deletion, plaintext file, HTTP or alternate provider.
export class WindowsSyntheticSessionVault {
  #options;
  constructor(options) {
    if (process.platform !== 'win32') sessionVaultFailure();
    this.#options = syntheticSessionVaultOptions(options);
  }
  async store(vaultId,payload) {
    let snapshot;
    try {
      sessionVaultId(vaultId);
      if (!Buffer.isBuffer(payload) || payload.length < 32 || payload.length > SESSION_VAULT_PAYLOAD_LIMIT) sessionVaultFailure();
      snapshot = Buffer.from(payload);
      const envelope = await invoke(this.#options,'protect',{vaultId,createdAt:new Date().toISOString(),value:snapshot.toString('base64')});
      await persistPrivateEnvelope(this.#options,vaultId,envelope,receipt,() => invoke(this.#options,'check',envelope));
      return Object.freeze({vaultId,scope:'CurrentUser'});
    } catch { sessionVaultFailure(); }
    finally { snapshot?.fill(0); }
  }
  async load(vaultId) {
    try {
      sessionVaultId(vaultId);
      return await readPrivateEnvelope(this.#options,vaultId,receipt,(envelope) => {
        validateProtectedSessionVault(envelope,vaultId,this.#options);
        return invoke(this.#options,'unprotect',envelope);
      }); // Caller owns this Buffer and must clear it in finally.
    } catch { sessionVaultFailure(); }
  }
}
