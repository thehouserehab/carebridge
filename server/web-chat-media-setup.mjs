import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {inspectWebChatDatabase} from './web-chat-setup.mjs';
import {WEB_CHAT_MEDIA_CENTER_BYTES} from '../src/shared-chat-media-policy.js';

const tables=['schema_version','center_limits','attachments','message_requests'];
const functions=['guard_attachment','retain_receipt'];
const unavailable=()=>{throw new Error('WEB_CHAT_MEDIA_SETUP_UNAVAILABLE');};
const quote=value=>'"'+value.replaceAll('"','""')+'"';
function scope(input) {
  if (!input || Object.keys(input).some(key=>!['centerId','runtimeRole'].includes(key)) ||
      !/^web-demo-center-[a-f0-9-]{36}$/.test(input.centerId??'') || !/^cb_web_chat_[a-f0-9]{16}$/.test(input.runtimeRole??'')) unavailable();
  return input;
}
async function schemaSource() {
  const sql=(await readFile(new URL('./web-chat-media-schema.sql',import.meta.url),'utf8')).replaceAll('\r\n','\n');
  return {sql,checksum:createHash('sha256').update(sql).digest('hex')};
}
async function originalSchema(tx) {
  const names=(await readdir(new URL('./migrations/',import.meta.url))).filter(name=>/^\d{3}-[a-z-]+\.sql$/.test(name)).sort();
  if (names.length!==23) unavailable();
  const expected=await Promise.all(names.map(async name=>({name,checksum:createHash('sha256').update(await readFile(new URL('./migrations/'+name,import.meta.url))).digest('hex')})));
  const {rows}=await tx.query('SELECT name,checksum FROM public.cb_schema_migrations ORDER BY name');
  if (JSON.stringify(rows)!==JSON.stringify(expected)) unavailable();
}
async function target(tx,{centerId,runtimeRole}) {
  await originalSchema(tx);
  if (!(await inspectWebChatDatabase({transaction:work=>work(tx)},runtimeRole)).passed) unavailable();
  const {rows}=await tx.query(`SELECT c.id FROM public.cb_centers c WHERE c.id=$1
    AND (SELECT count(*) FROM public.cb_conversations r WHERE r.center_id=c.id)=1
    AND (SELECT count(*) FROM public.cb_memberships m WHERE m.center_id=c.id)=2
    AND (SELECT count(*) FROM public.cb_participants p WHERE p.center_id=c.id)=2
    AND (SELECT count(*) FROM public.cb_participants p JOIN public.cb_memberships m
      ON (m.center_id,m.user_id,m.role)=(p.center_id,p.user_id,p.role)
      JOIN public.cb_users u ON u.id=p.user_id
      WHERE p.center_id=c.id AND p.active AND m.active AND u.active AND p.role='therapist')=1
    AND (SELECT count(*) FROM public.cb_participants p JOIN public.cb_memberships m
      ON (m.center_id,m.user_id,m.role)=(p.center_id,p.user_id,p.role)
      JOIN public.cb_users u ON u.id=p.user_id
      WHERE p.center_id=c.id AND p.active AND m.active AND u.active AND p.role='guardian')=1`,[centerId]);
  if (rows.length!==1) unavailable();
  const {rows:roles}=await tx.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])",[['anon','authenticated','service_role',runtimeRole]]);
  if (roles.length!==4) unavailable();
}
export function webChatMediaPrivileges(runtimeRole) {
  scope({runtimeRole,centerId:'web-demo-center-00000000-0000-4000-8000-000000000000'});
  const role=quote(runtimeRole);
  const statements=[`REVOKE ALL ON SCHEMA carebridge_web FROM PUBLIC,anon,authenticated,service_role`,
    `GRANT USAGE ON SCHEMA carebridge_web TO ${role}`];
  for (const table of tables) {
    statements.push(`REVOKE ALL ON TABLE carebridge_web.${table} FROM PUBLIC,anon,authenticated,service_role`);
    statements.push(`ALTER TABLE carebridge_web.${table} ENABLE ROW LEVEL SECURITY`);
    if (table==='schema_version') continue;
    statements.push(`CREATE POLICY web_chat_runtime ON carebridge_web.${table} TO ${role} USING (true) WITH CHECK (true)`);
    statements.push(`GRANT SELECT ON carebridge_web.${table} TO ${role}`);
  }
  statements.push(`GRANT INSERT ON carebridge_web.attachments,carebridge_web.message_requests TO ${role}`);
  statements.push(`GRANT UPDATE (state,content,bound_message_id,ordinal) ON carebridge_web.attachments TO ${role}`);
  for (const name of functions) statements.push(`REVOKE ALL ON FUNCTION carebridge_web.${name}() FROM PUBLIC,anon,authenticated,service_role`);
  return statements;
}

async function inspect(tx,input,checksum) {
  const {rows:schemas}=await tx.query(`SELECT pg_get_userbyid(n.nspowner)=$1 AS runtime_owner,
    has_schema_privilege($1,n.oid,'USAGE') AS runtime_usage,
    has_schema_privilege($1,n.oid,'CREATE') AS runtime_create,
    has_schema_privilege('anon',n.oid,'USAGE,CREATE') OR has_schema_privilege('authenticated',n.oid,'USAGE,CREATE') OR has_schema_privilege('service_role',n.oid,'USAGE,CREATE') AS direct_usage
    FROM pg_namespace n WHERE n.nspname='carebridge_web'`,[input.runtimeRole]);
  if (schemas.length!==1) return {passed:false};
  const {rows:relations}=await tx.query(`SELECT c.relname,c.relrowsecurity,pg_get_userbyid(c.relowner)=$1 AS runtime_owner,
    has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_any_column_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') OR
      has_any_column_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') OR
      has_any_column_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') AS direct_access,
    has_table_privilege($1,c.oid,'DELETE') OR has_table_privilege($1,c.oid,'TRUNCATE') OR has_table_privilege($1,c.oid,'TRIGGER') AS excessive
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='carebridge_web' AND c.relkind IN ('r','p')`,[input.runtimeRole]);
  const {rows:tablePermissions}=await tx.query(`SELECT c.relname,p.permission,has_table_privilege($1,c.oid,p.permission) AS allowed
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN unnest($2::text[]) p(permission) WHERE n.nspname='carebridge_web' AND c.relkind IN ('r','p')`,
  [input.runtimeRole,['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']]);
  const {rows:columnPermissions}=await tx.query(`SELECT c.relname,a.attname,p.permission,has_column_privilege($1,c.oid,a.attnum,p.permission) AS allowed
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN unnest($2::text[]) p(permission) WHERE n.nspname='carebridge_web' AND c.relkind IN ('r','p')`,
  [input.runtimeRole,['SELECT','INSERT','UPDATE','REFERENCES']]);
  const expected=(table,permission,column)=>permission==='SELECT'&&table!=='schema_version' ||
    permission==='INSERT'&&['attachments','message_requests'].includes(table) ||
    permission==='UPDATE'&&table==='attachments'&&['state','content','bound_message_id','ordinal'].includes(column);
  const exactPrivileges=tablePermissions.length===tables.length*7 && tablePermissions.every(row=>row.allowed===expected(row.relname,row.permission)) &&
    columnPermissions.length>0 && columnPermissions.every(row=>row.allowed===expected(row.relname,row.permission,row.attname));
  const {rows:policies}=await tx.query(`SELECT c.relname,p.polname,p.polcmd,p.polpermissive,
    p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname=$1)]::oid[] AS correct_role,
    pg_get_expr(p.polqual,p.polrelid) AS using_expression,pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='carebridge_web'`,[input.runtimeRole]);
  const exactPolicies=policies.length===3&&policies.every(row=>['center_limits','attachments','message_requests'].includes(row.relname)&&
    row.polname==='web_chat_runtime'&&row.polcmd==='*'&&row.polpermissive&&row.correct_role&&row.using_expression==='true'&&row.check_expression==='true');
  const {rows:procedures}=await tx.query(`SELECT p.proname,has_function_privilege($1,p.oid,'EXECUTE') AS runtime_execute,
    has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR
    has_function_privilege('service_role',p.oid,'EXECUTE') AS direct_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='carebridge_web'`,[input.runtimeRole]);
  const {rows:version}=await tx.query('SELECT version,checksum FROM carebridge_web.schema_version');
  const {rows:limits}=await tx.query('SELECT center_id,limit_bytes FROM carebridge_web.center_limits');
  const schema=schemas[0];
  const passed=!schema.runtime_owner&&schema.runtime_usage&&!schema.runtime_create&&!schema.direct_usage && relations.length===tables.length &&
    relations.every(row=>tables.includes(row.relname)&&row.relrowsecurity&&!row.runtime_owner&&!row.direct_access&&!row.excessive) && exactPrivileges&&exactPolicies &&
    procedures.length===functions.length&&procedures.every(row=>functions.includes(row.proname)&&!row.runtime_execute&&!row.direct_execute) &&
    version.length===1&&version[0].version===1&&version[0].checksum===checksum &&
    limits.length===1&&limits[0].center_id===input.centerId&&limits[0].limit_bytes===WEB_CHAT_MEDIA_CENTER_BYTES;
  return {passed,checkedTables:relations.length,rlsEnabled:relations.every(row=>row.relrowsecurity),
    directDataApiAccess:relations.some(row=>row.direct_access),runtimeOwner:relations.some(row=>row.runtime_owner),runtimeSchemaCreate:schemas[0].runtime_create,
    exactPrivileges,exactPolicies};
}
export async function inspectWebChatMedia(database,input) {
  scope(input); const {checksum}=await schemaSource();
  return database.transaction(tx=>inspect(tx,input,checksum));
}

/** Owner-only additive install. Never rewrites public migrations or user data. */
export async function setupWebChatMedia(database,input) {
  scope(input); const {sql,checksum}=await schemaSource();
  return database.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(724381903)');
    await target(tx,input);
    const {rows}=await tx.query("SELECT 1 FROM pg_namespace WHERE nspname='carebridge_web'");
    const installed=rows.length===0;
    if (installed) {
      await tx.exec(sql);
      await tx.query('INSERT INTO carebridge_web.schema_version(version,checksum) VALUES(1,$1)',[checksum]);
      await tx.query('INSERT INTO carebridge_web.center_limits(center_id,limit_bytes) VALUES($1,$2)',[input.centerId,WEB_CHAT_MEDIA_CENTER_BYTES]);
      for (const statement of webChatMediaPrivileges(input.runtimeRole)) await tx.exec(statement);
    }
    const security=await inspect(tx,input,checksum);
    if (!security.passed) unavailable();
    return {installed,centerId:input.centerId,schemaVersion:1,security};
  });
}
