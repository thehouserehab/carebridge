import { fileURLToPath } from 'node:url';
import { KEY_STORE_PURPOSE, keyStoreFailure, recoveryKeyId, recoveryKeyStoreOptions,
  validateProtectedRecoveryKey, validateKeyStoreResponse } from './windows-recovery-key-policy.mjs';
import { invokeWindowsSecretProvider, persistPrivateEnvelope, readPrivateEnvelope } from './windows-private-secret-io.mjs';

const provider = fileURLToPath(new URL('../scripts/windows-recovery-key-provider.ps1',import.meta.url));
const receipt = '.carebridge-key-store.json';
function requestFor(options,operation,envelope) {
  return {schema:1,operation,base:options.base,syntheticRunId:options.syntheticRunId,
    purpose:KEY_STORE_PURPOSE,scope:'CurrentUser',keyId:envelope.keyId,
    createdAt:envelope.createdAt,ownerSid:envelope.ownerSid ?? null,value:envelope.value};
}
const invoke = (options,operation,envelope) => invokeWindowsSecretProvider(options,requestFor(options,operation,envelope),provider,
  (response) => validateKeyStoreResponse(response,operation,envelope.keyId));

// Internal operator primitive; no generation/rotation/export/delete/API/fallback.
export class WindowsRecoveryKeyStore {
  #options;
  constructor(options) {
    if (process.platform !== 'win32') keyStoreFailure();
    this.#options = recoveryKeyStoreOptions(options);
  }
  async store(keyId,key) {
    let snapshot;
    try {
      recoveryKeyId(keyId);
      if (!Buffer.isBuffer(key) || key.length !== 32) keyStoreFailure();
      snapshot = Buffer.from(key);
      const envelope = await invoke(this.#options,'protect',{keyId,createdAt:new Date().toISOString(),value:snapshot.toString('base64')});
      await persistPrivateEnvelope(this.#options,keyId,envelope,receipt,() => invoke(this.#options,'check',envelope));
      return Object.freeze({keyId,scope:'CurrentUser'});
    } catch { keyStoreFailure(); }
    finally { snapshot?.fill(0); }
  }
  async load(keyId) {
    try {
      recoveryKeyId(keyId);
      return await readPrivateEnvelope(this.#options,keyId,receipt,(envelope) => {
        validateProtectedRecoveryKey(envelope,keyId); return invoke(this.#options,'unprotect',envelope);
      }); // Caller owns returned Buffer and MUST zero it in finally.
    } catch { keyStoreFailure(); }
  }
}
