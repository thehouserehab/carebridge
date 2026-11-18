import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from './migrate.mjs';
import { Auth } from './auth.mjs';
import { Conversations } from './conversations.mjs';
import { DATABASE_TABLES, DATABASE_SEQUENCES, DATABASE_FUNCTIONS, RUNTIME_HELPERS,
  expectedTablePrivileges, expectedColumnPrivileges, expectedFunctionExecution } from './database-privilege-policy.mjs';

const unavailable = () => { throw new Error('WEB_CHAT_SETUP_UNAVAILABLE'); };
const runtimeName = value => typeof value === 'string' && /^cb_web_chat_[a-f0-9]{16}$/.test(value);
const identifier = value => '"' + value.replaceAll('"', '""') + '"';

/** This one-time operation only targets an empty, separately provisioned demo DB.
 * It never runs from a request handler and never reads a local user's workspace.
 */
export function newWebChatDemo() {
  const suffix = randomBytes(8).toString('hex');
  return {
    role: 'cb_web_chat_' + suffix,
    databasePassword: randomBytes(32).toString('base64url'),
    centerId: 'web-demo-center-' + randomUUID(),
    childId: 'web-demo-child-' + randomUUID(),
    roomId: 'web-demo-room-' + randomUUID(),
    accounts: [
      { role: 'therapist', userId: 'web-demo-therapist-' + randomUUID(), email: 'therapist@carebridge-demo.invalid', password: randomBytes(24).toString('base64url') },
      { role: 'guardian', userId: 'web-demo-guardian-' + randomUUID(), email: 'guardian@carebridge-demo.invalid', password: randomBytes(24).toString('base64url') },
    ],
  };
}

export function webChatPrivilegeStatements(role) {
  if (!runtimeName(role)) unavailable();
  const quotedRole = identifier(role);
  const statements = [`GRANT USAGE ON SCHEMA public TO ${quotedRole}`];
  for (const table of DATABASE_TABLES) {
    // Supabase's Data API identities must not inherit the SQL server's access.
    statements.push(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated, service_role`);
    statements.push(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    statements.push(`CREATE POLICY cb_web_chat_runtime ON public.${table} TO ${quotedRole} USING (true) WITH CHECK (true)`);
    const permissions = expectedTablePrivileges('runtime', table);
    if (permissions.length) statements.push(`GRANT ${permissions.join(',')} ON TABLE public.${table} TO ${quotedRole}`);
    for (const permission of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
      const columns = expectedColumnPrivileges('runtime', table, permission);
      if (columns.length) statements.push(`GRANT ${permission} (${columns.join(',')}) ON TABLE public.${table} TO ${quotedRole}`);
    }
  }
  for (const sequence of DATABASE_SEQUENCES) {
    statements.push(`REVOKE ALL ON SEQUENCE public.${sequence} FROM PUBLIC, anon, authenticated, service_role`);
    statements.push(`GRANT USAGE ON SEQUENCE public.${sequence} TO ${quotedRole}`);
  }
  for (const [name, args] of Object.entries(RUNTIME_HELPERS)) {
    if (expectedFunctionExecution('runtime', name)) statements.push(`GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO ${quotedRole}`);
  }
  return statements;
}

export async function setupWebChatDemo(database, demo) {
  if (!database?.transaction || !runtimeName(demo?.role) ||
      !/^[A-Za-z0-9_-]{43}$/.test(demo.databasePassword ?? '') ||
      !['centerId', 'childId', 'roomId'].every(key => /^web-demo-[a-z]+-[a-f0-9-]{36}$/.test(demo[key] ?? '')) ||
      !Array.isArray(demo.accounts) || demo.accounts.length !== 2 ||
      demo.accounts.map(value => value.role).join(',') !== 'therapist,guardian') unavailable();
  return database.transaction(async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(724381903)');
    const existing = await tx.query(`SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f') AND NOT EXISTS
      (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e') LIMIT 1`);
    if (existing.rows.length) unavailable();
    const roles = await tx.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [['anon', 'authenticated', 'service_role']]);
    if (roles.rows.length !== 3) unavailable();
    const existingRole = await tx.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [demo.role]);
    if (existingRole.rows.length) unavailable();
    // The password is internally generated from a restricted alphabet, never user SQL.
    await tx.exec(`CREATE ROLE ${identifier(demo.role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 12 PASSWORD '${demo.databasePassword}'`);
    const databaseName = (await tx.query('SELECT current_database() AS name')).rows[0].name;
    await tx.exec(`GRANT CONNECT ON DATABASE ${identifier(databaseName)} TO ${identifier(demo.role)}`);
    const scopedDatabase = { transaction: work => work(tx) };
    const applied = await migrate(scopedDatabase);
    // Revoke only functions created by the checked-in Carebridge migrations.
    const functions = await tx.query(`SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[])`, [DATABASE_FUNCTIONS]);
    if (functions.rows.length !== DATABASE_FUNCTIONS.length) unavailable();
    for (const { signature } of functions.rows) await tx.exec(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated, service_role`);
    for (const sql of webChatPrivilegeStatements(demo.role)) await tx.exec(sql);
    await tx.query('INSERT INTO cb_centers(id) VALUES ($1)', [demo.centerId]);
    for (const account of demo.accounts) {
      await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)', [account.userId]);
      await tx.query('INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,$3,true)', [demo.centerId, account.userId, account.role]);
      await tx.query('INSERT INTO cb_member_profiles(center_id,user_id,display_name,revision) VALUES ($1,$2,$3,1)',
        [demo.centerId, account.userId, account.role === 'therapist' ? '시연 치료사' : '시연 보호자']);
    }
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [demo.centerId, demo.childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [demo.centerId, demo.roomId, demo.childId]);
    for (const account of demo.accounts) await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,$4,true,1)`, [demo.centerId, demo.roomId, account.userId, account.role]);
    await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by)
      VALUES ($1,$2,'시연 아동',NULL,NULL,1,$3)`, [demo.centerId, demo.childId, demo.accounts[0].userId]);
    const auth = new Auth(scopedDatabase, { sessionTtlSeconds: 3600 });
    for (const account of demo.accounts) await auth.provisionAccount(account);
    await new Conversations(scopedDatabase).sendText({ centerId: demo.centerId, userId: demo.accounts[0].userId },
      { conversationId: demo.roomId, clientId: randomUUID(), body: '가상 대화 시연방입니다. 서로 다른 브라우저에서 치료사와 보호자로 로그인해 소식을 주고받아 보세요.' });
    const security = await inspectWebChatDatabase(scopedDatabase, demo.role);
    if (!security.passed) unavailable();
    return { appliedMigrations: applied.length, security, centerId: demo.centerId, roomId: demo.roomId,
      accounts: demo.accounts.map(({ role, userId, email }) => ({ role, userId, email })) };
  });
}

export async function inspectWebChatDatabase(database, role) {
  if (!runtimeName(role)) unavailable();
  return database.transaction(async tx => {
    const { rows: roles } = await tx.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      has_schema_privilege(oid,'public','CREATE') AS schema_create FROM pg_roles WHERE rolname=$1`, [role]);
    const { rows: tables } = await tx.query(`SELECT c.relname, c.relrowsecurity,
      pg_get_userbyid(c.relowner)=$2 AS runtime_owner,
      has_table_privilege('anon',c.oid,'SELECT') OR has_table_privilege('authenticated',c.oid,'SELECT') OR has_table_privilege('service_role',c.oid,'SELECT') AS direct_read
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [DATABASE_TABLES, role]);
    return { passed: roles.length === 1 && Object.values(roles[0]).every(value => value === false) &&
        tables.length === DATABASE_TABLES.length && tables.every(value => value.relrowsecurity && !value.runtime_owner && !value.direct_read),
      checkedTables: tables.length, runtimeOwner: tables.some(value => value.runtime_owner),
      directDataApiRead: tables.some(value => value.direct_read), rlsEnabled: tables.every(value => value.relrowsecurity) };
  });
}
