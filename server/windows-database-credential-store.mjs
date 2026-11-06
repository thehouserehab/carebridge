import { fileURLToPath } from 'node:url';
import { DATABASE_CREDENTIAL_PURPOSE, credentialFailure, databaseCredentialId, databaseCredentialOptions,
  databaseCredentialBinding, validateDatabasePassword, validateProtectedDatabaseCredential,
  validateDatabaseCredentialResponse } from './windows-database-credential-policy.mjs';
import { invokeWindowsSecretProvider, persistPrivateEnvelope, readPrivateEnvelope } from './windows-private-secret-io.mjs';
import { beginWindowsDatabaseStage } from './windows-database-observation.mjs';

const provider = fileURLToPath(new URL('../scripts/windows-database-credential-provider.ps1',import.meta.url));
const receipt = '.carebridge-database-credentials.json';
const invoke = (options,operation,envelope,binding) => invokeWindowsSecretProvider(options,{
  schema:1,operation,base:options.base,syntheticRunId:options.syntheticRunId,purpose:DATABASE_CREDENTIAL_PURPOSE,
  scope:'CurrentUser',credentialId:envelope.credentialId,binding,createdAt:envelope.createdAt,
  ownerSid:envelope.ownerSid ?? null,value:envelope.value,
},provider,(response) => validateDatabaseCredentialResponse(response,operation,envelope.credentialId,binding));

// Internal custody primitive only. Does not generate/issue a DB password,
// connect, alter roles, rotate, export, delete, start a service or read .env.
export class WindowsDatabaseCredentialStore {
  #options; #onStage;
  constructor(options,{onStage} = {}) {
    if (process.platform !== 'win32') credentialFailure();
    this.#options = databaseCredentialOptions(options);
    this.#onStage = typeof onStage === 'function' ? onStage : undefined;
  }
  async store(id,privileges,kind,password) {
    let snapshot;
    try {
      databaseCredentialId(id); const binding = databaseCredentialBinding(privileges,kind);
      validateDatabasePassword(password); snapshot = Buffer.from(password);
      const envelope = await invoke(this.#options,'protect',{
        credentialId:id,createdAt:new Date().toISOString(),value:snapshot.toString('base64'),
      },binding);
      await persistPrivateEnvelope(this.#options,id,envelope,receipt,() => invoke(this.#options,'check',envelope,binding));
      return Object.freeze({credentialId:id,binding,scope:'CurrentUser'});
    } catch { credentialFailure(); }
    finally { snapshot?.fill(0); }
  }
  async load(id,privileges,kind) {
    try {
      databaseCredentialId(id); const binding = databaseCredentialBinding(privileges,kind);
      return await readPrivateEnvelope(this.#options,id,receipt,async (envelope) => {
        const finish=beginWindowsDatabaseStage(this.#onStage,'credential-unprotect');
        try {
          validateProtectedDatabaseCredential(envelope,id,binding);
          const result=await invoke(this.#options,'unprotect',envelope,binding);finish('complete');return result;
        }catch(error){finish('failed');throw error;}
      },{onStage:this.#onStage}); // Caller must zero the returned password Buffer in finally.
    } catch { credentialFailure(); }
  }
}
