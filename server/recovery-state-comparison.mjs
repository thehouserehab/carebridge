// Internal operator inspection ONLY. Never a release token, HTTP handler,
// repair script or writer shutdown assertion. External media is inspected only
// when separately approved directory receipts are supplied.
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {DATABASE_TABLES,DATABASE_FUNCTIONS} from './database-privilege-policy.mjs';
import {approveRecoveryMediaRoots,compareRecoveryMediaState} from './recovery-media-comparison.mjs';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const oid=value=>Number.isSafeInteger(value)&&value>0&&value<=4294967295;
const receipt=value=>exact(value,['name','oid','ownerOid'])&&typeof value.name==='string'&&value.name.length>0&&
  Buffer.byteLength(value.name)<=63&&!/[\x00-\x1f\x7f]/.test(value.name)&&
  !['postgres','template0','template1'].includes(value.name)&&oid(value.oid)&&oid(value.ownerOid);
export class RecoveryStateComparisonError extends Error {
  constructor(code){super(code);this.name='RecoveryStateComparisonError';this.code=code;}
}
const fail=(code='RECOVERY_STATE_UNAVAILABLE')=>{throw new RecoveryStateComparisonError(code);};
const failSchema=component=>{
  const error=new RecoveryStateComparisonError('RECOVERY_STATE_SCHEMA_MISMATCH');
  error.component=component;throw error; // Fixed category only, never definitions.
};
const comparedTables=DATABASE_TABLES.filter(name=>name!=='cb_recovery_quarantine');
// Quarantine deliberately makes these fields MORE restrictive. All other
// columns/rows, including password state and security events, must still match.
const omittedColumns=Object.freeze({cb_auth_sessions:['revoked_at'],cb_auth_invitations:['revoked_at'],
  cb_auth_password_resets:['revoked_at']});
// Fixed SQL shared with parser regression tests. Quarantine deactivates only
// active users: migration 023 then increments THEIR qualification generation
// exactly once. Normalize the source's expected result, never the restored
// value. Membership/participant generations and primary-contact snapshots are
// not rewritten, omitted or otherwise normalized by this comparison.
export const RECOVERY_USER_STATE_EXPRESSIONS=Object.freeze({
  source:`(to_jsonb(t) || jsonb_build_object('communication_generation',
    t.communication_generation + CASE WHEN t.active THEN 1::bigint ELSE 0::bigint END)) - ARRAY['active']::text[]`,
  target:`to_jsonb(t) - ARRAY['active']::text[]`,
});
export const RECOVERY_CONSTRAINT_QUERY=`SELECT c.relname,k.conname,k.contype,k.conenforced,k.convalidated,
    k.condeferrable,k.condeferred,k.connoinherit,pg_catalog.pg_get_constraintdef(k.oid,true) AS definition
  FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  ORDER BY c.relname COLLATE "C",k.conname COLLATE "C"`;

async function reviewedMigrations(){
  const directory=new URL('./migrations/',import.meta.url);
  const names=(await readdir(directory)).filter(name=>/^\d{3}-[a-z-]+\.sql$/.test(name)).sort();
  return Promise.all(names.map(async name=>({name,checksum:createHash('sha256').update(await readFile(new URL(name,directory))).digest('hex')})));
}
async function identity(tx,approved,current){
  await tx.query('SET LOCAL search_path = pg_catalog,pg_temp');
  await tx.query("SET LOCAL timezone = 'UTC'");
  await tx.query("SET LOCAL datestyle = 'ISO, YMD'");
  await tx.query('SET LOCAL extra_float_digits = 3');
  await tx.query("SET LOCAL transaction_timeout = '30s'");
  const rows=(await tx.query(`SELECT d.datname,d.oid::bigint AS oid,d.datdba::bigint AS owner_oid,
      r.oid::bigint AS role_oid,current_database() AS current_database,current_user=session_user AS direct_role
    FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname=current_user
    WHERE d.datname IN ($1,$2) AND NOT d.datistemplate AND d.datallowconn`,
  [approved.sourceReceipt.name,approved.targetReceipt.name])).rows;
  for(const expected of [approved.sourceReceipt,approved.targetReceipt]){
    const row=rows.find(value=>value.datname===expected.name);
    if(!row||Number(row.oid)!==expected.oid||Number(row.owner_oid)!==expected.ownerOid||
      row.current_database!==current.name||row.direct_role!==true||Number(row.role_oid)!==current.ownerOid)
      fail('RECOVERY_STATE_TARGET_MISMATCH');
  }
  // Fixed, reviewed names only. SHARE blocks INSERT/UPDATE/DELETE/TRUNCATE and
  // table DDL until BOTH snapshots have been compared. No application writes.
  await tx.query(`LOCK TABLE ${DATABASE_TABLES.map(name=>`public."${name}"`).join(',')} IN SHARE MODE`);
  const tables=(await tx.query(`SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
      c.relowner::bigint AS owner_oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname COLLATE "C"`)).rows;
  if(tables.length!==DATABASE_TABLES.length||tables.some((row,index)=>row.relname!==DATABASE_TABLES[index]||
    row.relkind!=='r'||row.relpersistence!=='p'||row.relrowsecurity!==false||row.relforcerowsecurity!==false||
    Number(row.owner_oid)!==current.ownerOid))failSchema('inventory');
  return (await tx.query('SELECT * FROM public.cb_recovery_quarantine')).rows;
}
async function shape(tx,expectedMigrations){
  const migrations=(await tx.query('SELECT name,checksum FROM public.cb_schema_migrations ORDER BY name COLLATE "C"')).rows;
  if(JSON.stringify(migrations)!==JSON.stringify(expectedMigrations))failSchema('migrations');
  const columns=(await tx.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name COLLATE "C",ordinal_position`)).rows;
  // The pretty deparser removes redundant same-operator parentheses produced
  // by reparsing BETWEEN in pg_dump. No regex erases predicates/precedence.
  // Enforcement/validation/deferral/inheritance remain explicit comparisons.
  const constraints=(await tx.query(RECOVERY_CONSTRAINT_QUERY)).rows;
  const triggers=(await tx.query(`SELECT c.relname,t.tgname,t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid) AS definition
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C"`)).rows;
  const functions=(await tx.query(`SELECT p.proname,pg_catalog.pg_get_functiondef(p.oid) AS definition
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' ORDER BY p.proname COLLATE "C",p.oid`)).rows;
  if(functions.length!==DATABASE_FUNCTIONS.length||functions.some((row,index)=>row.proname!==DATABASE_FUNCTIONS[index]))
    failSchema('functions');
  const indexes=(await tx.query(`SELECT tablename,indexname,indexdef FROM pg_catalog.pg_indexes
    WHERE schemaname='public' ORDER BY tablename COLLATE "C",indexname COLLATE "C"`)).rows;
  return {columns,constraints,triggers,functions,indexes};
}
async function digestTable(tx,table,key,side){
  // One bounded page at a time; no raw row, identifier, credential hash or
  // reusable table digest is returned/logged/persisted. One random HMAC key
  // per comparison, destroyed below. Canonical DB text sorted with C collation.
  const omission=omittedColumns[table];
  const expression=table==='cb_users'?RECOVERY_USER_STATE_EXPRESSIONS[side]:
    `to_jsonb(t)${omission?` - ARRAY[${omission.map(name=>`'${name}'`).join(',')}]::text[]`:''}`;
  await tx.query(`DECLARE cb_recovery_compare NO SCROLL CURSOR FOR SELECT (${expression})::text AS row
    FROM public."${table}" t ORDER BY (${expression})::text COLLATE "C"`);
  const hmac=createHmac('sha256',key);let count=0;
  try{
    while(true){
      const rows=(await tx.query('FETCH FORWARD 128 FROM cb_recovery_compare')).rows;
      if(rows.length>128)fail();
      for(const {row}of rows){
        if(typeof row!=='string')fail();
        hmac.update(`${Buffer.byteLength(row)}:`).update(row).update('\n');count++;
        if(!Number.isSafeInteger(count))fail();
      }
      if(rows.length<128)break;
    }
    return {count,digest:hmac.digest('hex')};
  }finally{await tx.query('CLOSE cb_recovery_compare');}
}

export async function compareRestoredDatabaseState(sourceDatabase,targetDatabase,input){
  const withMedia=input&&Object.hasOwn(input,'mediaRoots');
  if(!sourceDatabase?.transaction||!targetDatabase?.transaction||sourceDatabase===targetDatabase||
    !exact(input,['operationId','bundleId','sourceReceipt','targetReceipt','confirmTarget',...(withMedia?['mediaRoots']:[])])||
    typeof input.operationId!=='string'||!uuid.test(input.operationId)||typeof input.bundleId!=='string'||!uuid.test(input.bundleId)||
    !receipt(input.sourceReceipt)||!receipt(input.targetReceipt)||input.confirmTarget!==input.targetReceipt.name||
    input.sourceReceipt.name===input.targetReceipt.name||input.sourceReceipt.oid===input.targetReceipt.oid)
    fail('RECOVERY_STATE_INVALID_INPUT');
  const approved={operationId:input.operationId,bundleId:input.bundleId,sourceReceipt:{...input.sourceReceipt},targetReceipt:{...input.targetReceipt}};
  // Capture nested paths/identities before the first await too. These receipts
  // identify dedicated caller-owned roots; they do not attest to Windows ACLs.
  let mediaRoots;
  if(withMedia){
    try{mediaRoots=approveRecoveryMediaRoots(input.mediaRoots);}
    catch{fail('RECOVERY_STATE_MEDIA_INVALID_INPUT');}
  }
  const key=randomBytes(32),challenge=randomBytes(8).readBigInt64BE().toString();
  try{
    const migrations=await reviewedMigrations();
    return await sourceDatabase.transaction(async source=>{
      if((await identity(source,approved,approved.sourceReceipt)).length)fail('RECOVERY_STATE_SOURCE_QUARANTINED');
      const sourceShape=await shape(source,migrations);
      const locked=(await source.query('SELECT pg_catalog.pg_try_advisory_xact_lock($1::bigint) AS locked,pg_catalog.pg_backend_pid() AS pid',[challenge])).rows[0];
      if(locked?.locked!==true||!Number.isInteger(locked.pid)||locked.pid<1||locked.pid>2147483647)fail();
      return targetDatabase.transaction(async target=>{
        const gates=await identity(target,approved,approved.targetReceipt),gate=gates[0];
        if(gates.length!==1||gate.operation_id!==approved.operationId||gate.bundle_id!==approved.bundleId||
          gate.source_name!==approved.sourceReceipt.name||Number(gate.source_oid)!==approved.sourceReceipt.oid||
          Number(gate.source_owner_oid)!==approved.sourceReceipt.ownerOid||gate.target_name!==approved.targetReceipt.name||
          Number(gate.target_oid)!==approved.targetReceipt.oid||Number(gate.owner_oid)!==approved.targetReceipt.ownerOid)
          fail('RECOVERY_STATE_QUARANTINE_MISMATCH');
        // Advisory keys are DATABASE-local, not cluster-global. Observe the
        // source's random key/PID/database via cluster-wide pg_locks instead
        // of trying the same key in another DB (which would always succeed).
        // Never wait for, release, or adopt another session's lock.
        const bits=BigInt.asUintN(64,BigInt(challenge));
        const peer=(await target.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE locktype='advisory'
          AND database=$1::oid AND pid=$2::integer AND classid=$3::oid AND objid=$4::oid
          AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS shared_source_lock`,
        [approved.sourceReceipt.oid,locked.pid,Number(bits>>32n),Number(bits&0xffffffffn)])).rows[0];
        if(peer?.shared_source_lock!==true)fail('RECOVERY_STATE_CLUSTER_MISMATCH');
        const targetShape=await shape(target,migrations);
        for(const component of ['columns','constraints','triggers','functions','indexes'])
          if(JSON.stringify(sourceShape[component])!==JSON.stringify(targetShape[component]))failSchema(component);
        const posture=(await target.query(`SELECT NOT EXISTS(SELECT 1 FROM public.cb_users WHERE active) AND
          NOT EXISTS(SELECT 1 FROM public.cb_auth_sessions WHERE revoked_at IS NULL) AND
          NOT EXISTS(SELECT 1 FROM public.cb_auth_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL) AND
          NOT EXISTS(SELECT 1 FROM public.cb_auth_password_resets WHERE consumed_at IS NULL AND revoked_at IS NULL) AS closed`)).rows[0];
        if(posture?.closed!==true)fail('RECOVERY_STATE_AUTH_OPEN');
        const differences=[];
        for(const table of comparedTables){
          const current=await digestTable(source,table,key,'source'),restored=await digestTable(target,table,key,'target');
          if(current.count!==restored.count||current.digest!==restored.digest)differences.push(table);
        }
        let media={externalFilesChecked:false};
        if(withMedia){
          // Both DB snapshots remain SHARE-locked while their manifests and
          // private bytes are inspected. Filesystem writers are NOT locked by
          // PostgreSQL: even an exact observation never permits service release.
          try{media=await compareRecoveryMediaState(source,target,mediaRoots);}
          catch{fail('RECOVERY_STATE_MEDIA_UNAVAILABLE');}
        }
        return {policyVersion:1,operationId:approved.operationId,bundleId:approved.bundleId,comparedTables:comparedTables.length,
          dataMatches:differences.length===0,differences,authClosed:true,...media,serviceReleaseAllowed:false};
      });
    });
  }catch(error){
    if(error instanceof RecoveryStateComparisonError)throw error;
    // Includes unknown COMMIT/connection outcomes. No retry, raw error/cause,
    // partial match report or accidental success on target/source close failure.
    fail();
  }finally{key.fill(0);}
}
