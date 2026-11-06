import { DATABASE_TABLES, DATABASE_FUNCTIONS, DATABASE_SEQUENCES, RUNTIME_HELPERS, RUNTIME_HELPER_RESULTS, TABLE_PRIVILEGES,
  DATABASE_ROLE_KINDS,DATABASE_SERVICE_ROLE_KINDS,DATABASE_PRIVILEGE_POLICY_VERSION,
  databasePrivilegePlan, expectedTablePrivileges, expectedColumnPrivileges,expectedFunctionExecution } from './database-privilege-policy.mjs';

const fail = () => { throw new Error('DATABASE_PRIVILEGES_UNAVAILABLE'); };
const equalList = (actual,expected) => actual.slice().sort().join(',') === expected.slice().sort().join(',');
const kinds = DATABASE_SERVICE_ROLE_KINDS;
async function preflight(tx,plan,configured = false,connectedKind = 'owner') {
  const {rows:targets} = await tx.query(`SELECT d.datname,d.oid::bigint AS oid,d.datdba::bigint AS owner_oid,
    current_user AS current_role,session_user AS session_role,current_setting('server_version_num')::integer AS version
    FROM pg_catalog.pg_database d WHERE d.datname=current_database() AND NOT d.datistemplate`);
  const target = targets[0];
  if (!target || target.datname !== plan.target.name || Number(target.oid) !== plan.target.oid ||
      Number(target.owner_oid) !== plan.target.ownerOid || target.current_role !== plan.roles[connectedKind] ||
      target.session_role !== plan.roles[connectedKind] || target.version < 180000 || target.version >= 190000) fail();
  const names = Object.values(plan.roles);
  const {rows:roles} = await tx.query(`SELECT rolname,oid::bigint AS oid,rolsuper,rolinherit,rolcreaterole,
    rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])`,[names]);
  if (roles.length !== DATABASE_ROLE_KINDS.length) fail();
  for (const role of roles) if (!role.rolcanlogin || role.rolsuper || role.rolinherit || role.rolcreaterole ||
      role.rolcreatedb || role.rolreplication || role.rolbypassrls || role.rolconfig !== null ||
      (role.rolname === plan.roles.owner && Number(role.oid) !== plan.target.ownerOid)) fail();
  const ids = roles.map((role) => Number(role.oid));
  const {rows:memberships} = await tx.query(`SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=ANY($1::oid[]) OR member=ANY($1::oid[])`,[ids]);
  const {rows:otherOwners} = await tx.query(`SELECT 1 FROM pg_catalog.pg_database WHERE datdba=ANY($1::oid[]) AND oid<>$2::oid`,[ids,plan.target.oid]);
  if (memberships.length || otherOwners.length) fail();
  const {rows:relations} = await tx.query(`SELECT c.relname,c.relkind,c.relowner::bigint AS owner_oid
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind NOT IN ('i','I') ORDER BY c.relname`);
  if (!equalList(relations.filter((row) => row.relkind === 'r').map((row) => row.relname),DATABASE_TABLES) ||
      !equalList(relations.filter((row) => row.relkind === 'S').map((row) => row.relname),DATABASE_SEQUENCES) ||
      relations.some((row) => !['r','S'].includes(row.relkind) || Number(row.owner_oid) !== plan.target.ownerOid)) fail();
  const {rows:functions} = await tx.query(`SELECT p.proname,p.proowner::bigint AS owner_oid,oidvectortypes(p.proargtypes) AS args,
    pg_get_function_result(p.oid) AS result,p.prosecdef,p.proconfig FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY p.proname`);
  if (!equalList(functions.map((row) => row.proname),DATABASE_FUNCTIONS)) fail();
  for (const fn of functions) {
    if (Number(fn.owner_oid) !== plan.target.ownerOid) fail();
    if (fn.proname in RUNTIME_HELPERS) {
      if (fn.args !== RUNTIME_HELPERS[fn.proname] || fn.result !== RUNTIME_HELPER_RESULTS[fn.proname] || fn.prosecdef) fail();
    }
    else if (fn.args !== '' || fn.result !== 'trigger') fail();
    if (fn.prosecdef && (fn.proname !== 'cb_recovery_write_guard' || fn.proconfig?.length !== 1 ||
        !/^search_path=pg_catalog,\s*pg_temp$/.test(fn.proconfig[0]))) fail();
  }
  const {rows:defaults} = await tx.query(`SELECT d.defaclobjtype,d.defaclnamespace::bigint AS namespace,x.grantee::bigint AS grantee,x.privilege_type
    FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x WHERE d.defaclrole=$1::oid`,[plan.target.ownerOid]);
  if (defaults.some((row) => Number(row.grantee) !== plan.target.ownerOid &&
      !(!configured && Number(row.grantee) === 0 && row.defaclobjtype === 'f' && row.privilege_type === 'EXECUTE'))) fail();
  // Absence of a global function ACL is NOT deny-by-default: PostgreSQL then
  // grants PUBLIC EXECUTE implicitly. Require the explicit closed global entry.
  if (configured && !defaults.some((row) => Number(row.namespace) === 0 && row.defaclobjtype === 'f')) fail();
  return roles;
}
async function assertCapabilities(tx,plan,exact) {
  // Check effective access, including column-level and inherited/public grants.
  // Refuse excess privileges BEFORE changing any grants; never silently repair
  // or adopt an overprivileged role. Missing reviewed grants may be added.
  const roleNames = kinds.map((kind) => plan.roles[kind]);
  const {rows:tables} = await tx.query(`SELECT r.name AS role,c.relname,p.permission,
    has_table_privilege(r.name,c.oid,p.permission) AS allowed,
    has_table_privilege(r.name,c.oid,p.permission||' WITH GRANT OPTION') AS grantable
    FROM unnest($1::text[]) r(name) CROSS JOIN pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($2::text[]) p(permission)
    WHERE n.nspname='public' AND c.relkind='r'`,[roleNames,TABLE_PRIVILEGES]);
  for (const row of tables) {
    const kind = kinds.find((key) => plan.roles[key] === row.role), expected = expectedTablePrivileges(kind,row.relname).includes(row.permission);
    if (row.grantable || (row.allowed && !expected) || (exact && row.allowed !== expected)) fail();
  }
  const {rows:columns} = await tx.query(`SELECT r.name AS role,c.relname,a.attname,p.permission,
    has_column_privilege(r.name,c.oid,a.attnum,p.permission) AS allowed,
    has_column_privilege(r.name,c.oid,a.attnum,p.permission||' WITH GRANT OPTION') AS grantable
    FROM unnest($1::text[]) r(name) CROSS JOIN pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) p(permission)
    WHERE n.nspname='public' AND c.relkind='r'`,[roleNames]);
  for (const row of columns) {
    const kind = kinds.find((key) => plan.roles[key] === row.role), expected = expectedTablePrivileges(kind,row.relname).includes(row.permission) ||
      expectedColumnPrivileges(kind,row.relname,row.permission).includes(row.attname);
    if (row.grantable || (row.allowed && !expected) || (exact && row.allowed !== expected)) fail();
  }
  const {rows:sequences} = await tx.query(`SELECT r.name AS role,c.relname,p.permission,
    has_sequence_privilege(r.name,c.oid,p.permission) AS allowed,
    has_sequence_privilege(r.name,c.oid,p.permission||' WITH GRANT OPTION') AS grantable
    FROM unnest($1::text[]) r(name) CROSS JOIN pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN unnest(ARRAY['SELECT','USAGE','UPDATE']) p(permission) WHERE n.nspname='public' AND c.relkind='S'`,[roleNames]);
  for (const row of sequences) {
    const expected = (row.role === plan.roles.runtime && row.permission === 'USAGE') || (row.role === plan.roles.backup && row.permission === 'SELECT');
    if (row.grantable || (row.allowed && !expected) || (exact && row.allowed !== expected)) fail();
  }
  const {rows:functions} = await tx.query(`SELECT r.name AS role,p.proname,
    has_function_privilege(r.name,p.oid,'EXECUTE') AS allowed,
    has_function_privilege(r.name,p.oid,'EXECUTE WITH GRANT OPTION') AS grantable,
    EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      JOIN pg_catalog.pg_roles gr ON gr.oid=a.grantee WHERE gr.rolname=r.name AND a.privilege_type='EXECUTE') AS direct
    FROM unnest($1::text[]) r(name) CROSS JOIN pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`,[roleNames]);
  for (const row of functions) {
    const kind = kinds.find((key) => plan.roles[key] === row.role), expected = expectedFunctionExecution(kind,row.proname);
    if (row.grantable || (row.direct && !expected) || (exact && row.allowed !== expected)) fail();
  }
  if (exact) {
    const {rows} = await tx.query(`SELECT r.name,
      has_database_privilege(r.name,$2::oid,'CONNECT') AS connect,
      has_database_privilege(r.name,$2::oid,'CREATE') AS create_db,
      has_database_privilege(r.name,$2::oid,'TEMPORARY') AS temporary,
      has_schema_privilege(r.name,'public','USAGE') AS usage,
      has_schema_privilege(r.name,'public','CREATE') AS create_schema
      FROM unnest($1::text[]) r(name)`,[roleNames,plan.target.oid]);
    if (rows.length !== kinds.length || rows.some((row) => !row.connect || !row.usage || row.create_db || row.temporary || row.create_schema)) fail();
  }
}

// Internal operator transaction only. Roles/credentials must already be newly
// provisioned by an authorized cluster operator. Receipt is a trusted target
// identity check, not evidence that an arbitrary dump/operator is trustworthy.
// No CREATE/ALTER ROLE, password handling, automatic startup or HTTP exposure.
export async function configureDatabasePrivileges(database,input) {
  try {
    const plan = databasePrivilegePlan(input);
    return await database.transaction(async (tx) => {
      await tx.query('SET LOCAL search_path=pg_catalog,public,pg_temp');
      await tx.query('SELECT pg_advisory_xact_lock(724381905)');
      await preflight(tx,plan); await assertCapabilities(tx,plan,false);
      for (const sql of plan.statements) await tx.exec(sql);
      await preflight(tx,plan,true);
      await assertCapabilities(tx,plan,true);
      return Object.freeze({applied:true,policyVersion:DATABASE_PRIVILEGE_POLICY_VERSION,roleCount:DATABASE_ROLE_KINDS.length,tableCount:DATABASE_TABLES.length,functionCount:DATABASE_FUNCTIONS.length});
    });
  } catch { fail(); }
}
export async function verifyDatabasePrivileges(database,input) {
  try {
    const plan = databasePrivilegePlan(input);
    return await database.transaction(async (tx) => {
      await tx.query('SET LOCAL search_path=pg_catalog,public,pg_temp');
      await preflight(tx,plan,true); await assertCapabilities(tx,plan,true);
      return Object.freeze({verified:true,policyVersion:DATABASE_PRIVILEGE_POLICY_VERSION,roleCount:DATABASE_ROLE_KINDS.length,tableCount:DATABASE_TABLES.length,functionCount:DATABASE_FUNCTIONS.length});
    });
  } catch { fail(); }
}

// A role-bound PORT over a caller-owned pool, not a pool/credential provider.
// Every actual transaction is verified on the SAME connection before caller
// work, not cached after a startup probe on a possibly different pool client.
// No SET ROLE, grants/repairs, automatic retry, close ownership or env access.
export function databaseForService(database,input,kind) {
  let plan,transaction;
  try {
    if (!DATABASE_SERVICE_ROLE_KINDS.includes(kind) || typeof database?.transaction !== 'function') fail();
    plan = databasePrivilegePlan(input); transaction = database.transaction.bind(database);
  } catch { fail(); }
  return Object.freeze({
    async transaction(work) {
      if (typeof work !== 'function') fail();
      let workFailed = false,workError;
      try {
        return await transaction(async (tx) => {
          try {
            await tx.query('SET LOCAL search_path=pg_catalog,public,pg_temp');
            await preflight(tx,plan,true,kind); await assertCapabilities(tx,plan,true);
          } catch { fail(); }
          // Do not lend the underlying pool client beyond this callback.
          // The caller must still await its own in-scope queries normally.
          let active = true;
          const query = async (sql,params) => { if (!active) fail(); return tx.query(sql,params); };
          const scoped = Object.freeze({query,exec:(sql) => query(sql)});
          try { return await work(scoped); }
          catch (error) { workFailed = true; workError = error; throw error; }
          finally { active = false; }
        });
      } catch (error) {
        // Preserve the existing internal work/rollback contract. Admission,
        // connection and unknown commit outcomes are redacted, never retried.
        if (workFailed && error === workError) throw error;
        fail();
      }
    },
  });
}
