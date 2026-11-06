// Explicit E/Windows service connection, not an operating provisioner or API.
// No caller-supplied pool/store/password/fallback and no automatic role repair.
import { X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { postgresDatabase } from './database.mjs';
import { databaseForService } from './database-privileges.mjs';
import { databasePrivilegePlan } from './database-privilege-policy.mjs';
import { databaseCredentialOptions,databaseCredentialBinding,databaseCredentialId,validateDatabasePassword } from './windows-database-credential-policy.mjs';
import { WindowsDatabaseCredentialStore } from './windows-database-credential-store.mjs';
import { beginWindowsDatabaseStage } from './windows-database-observation.mjs';
export { WINDOWS_DATABASE_STAGES } from './windows-database-observation.mjs';

const fail = () => { const error=new Error('DATABASE_SERVICE_UNAVAILABLE');error.code=error.message;throw error; };
function keys(value,required,optional=[]) {
  if(!value || typeof value!=='object' || Array.isArray(value) ||
    required.some((name) => !Object.hasOwn(value,name)) || Object.keys(value).some((name) => ![...required,...optional].includes(name))) fail();
}
export function windowsDatabaseServiceOptions(input) {
  try {
    keys(input,['storage','credentialId','privileges','kind','endpoint']);
    const storage=databaseCredentialOptions(input.storage),credentialId=databaseCredentialId(input.credentialId);
    const plan=databasePrivilegePlan(input.privileges),privileges=Object.freeze({roles:plan.roles,target:plan.target});
    const binding=databaseCredentialBinding(privileges,input.kind);
    keys(input.endpoint,['host','port'],['transport','ca']);
    const {host,port,ca}=input.endpoint,transport=Object.hasOwn(input.endpoint,'transport') ? input.endpoint.transport : 'tls';
    if(!['127.0.0.1','::1'].includes(host) || !Number.isInteger(port) || port<1 || port>65535 ||
      !['tls','synthetic-loopback'].includes(transport)) fail();
    let ssl;
    if(transport==='synthetic-loopback') {
      if(!storage.syntheticRunId || Object.hasOwn(input.endpoint,'ca')) fail(); ssl=false;
    } else {
      if(Object.hasOwn(input.endpoint,'ca')) {
        if(typeof ca!=='string' || ca.length>65536 || !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----\r?\n?$/.test(ca)) fail();
        new X509Certificate(ca); // Parse before any native/DB IO; TLS checks trust/time.
      }
      ssl=Object.freeze({rejectUnauthorized:true,minVersion:'TLSv1.2',...(ca === undefined ? {} : {ca}),
        // pg's IP-literal socket has no DNS servername. Bind verification to
        // the explicit address rather than an implicit "localhost" identity.
        checkServerIdentity:(_hostname,certificate) => checkServerIdentity(host,certificate)});
    }
    const storageInput=Object.freeze({base:storage.base,powershell:storage.powershell,
      ...(storage.syntheticRunId ? {syntheticRunId:storage.syntheticRunId} : {})});
    return Object.freeze({storage:storageInput,credentialId,privileges,kind:binding.kind,
      connection:Object.freeze({host,port,user:binding.roleName,database:binding.databaseName,ssl,
        sslnegotiation:'postgres',enableChannelBinding:true,client_encoding:'UTF8',replication:'false',
        options:'-c search_path=pg_catalog,public,pg_temp',application_name:`carebridge-${binding.kind}`,
        max:2,connectionTimeoutMillis:25000,idleTimeoutMillis:1000,query_timeout:15000})});
  } catch { fail(); }
}

export async function openWindowsDatabaseService(input,{onStage} = {}) {
  let database,closeService;
  try {
    if(process.platform!=='win32') fail();
    const observer=typeof onStage==='function' ? onStage : undefined;
    const options=windowsDatabaseServiceOptions(input),store=new WindowsDatabaseCredentialStore(options.storage,{onStage:observer});
    const loads=new Set();let closing=false,closePromise;
    const password=() => {
      if(closing) fail();
      const pending=(async () => {
        let bytes;
        try {
          bytes=await store.load(options.credentialId,options.privileges,options.kind);
          validateDatabasePassword(bytes);if(closing) fail();return bytes.toString('ascii');
        } catch { fail(); }
        finally {bytes?.fill(0);}
      })();
      loads.add(pending);pending.then(() => loads.delete(pending),() => loads.delete(pending));return pending;
    };
    database=postgresDatabase({...options.connection,password},observer ? {
      onConnection:()=>beginWindowsDatabaseStage(observer,'connection'),
    } : undefined);
    const guarded=databaseForService(database,options.privileges,options.kind);
    closeService=() => {
      if(closePromise) return closePromise;closing=true;
      closePromise=(async () => {
        let failed=false;
        try {await database.close();} catch {failed=true;}
        // A driver timeout must not abandon an in-flight native secret load.
        await Promise.allSettled([...loads]);if(failed) fail();
      })();return closePromise;
    };
    const unhealthy=() => closing || database.hasBackgroundError();
    const transaction=async (work) => {
      if(unhealthy() || typeof work!=='function') fail();
      if(!observer)return guarded.transaction((tx) => {if(unhealthy()) fail();return work(tx);});
      const finishTransaction=beginWindowsDatabaseStage(observer,'transaction');let finishPrivileges;
      // Observe the existing verifier on the same connection. A new local
      // wrapper per operation keeps concurrent transactions' spans separate;
      // neither SQL nor results are passed to the observer.
      const observed=databaseForService({transaction:check=>database.transaction((tx)=>{
        finishPrivileges=beginWindowsDatabaseStage(observer,'privilege-check');return check(tx);
      })},options.privileges,options.kind);
      try {
        const result=await observed.transaction((tx)=>{
          finishPrivileges('complete');if(unhealthy())fail();return work(tx);
        });
        finishTransaction('complete');return result;
      }catch(error){finishPrivileges?.('failed');finishTransaction('failed');throw error;}
    };
    await transaction((tx) => tx.query('SET TRANSACTION READ ONLY'));
    return Object.freeze({transaction,close:closeService,isAvailable:() => !unhealthy()});
  } catch {
    if(closeService) await closeService().catch(() => {});
    else await database?.close().catch(() => {});
    fail();
  }
}
