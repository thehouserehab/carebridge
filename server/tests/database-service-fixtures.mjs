// Catalog protocol double ONLY. Real PostgreSQL/role behavior is separately
// checked by the opt-in fresh Windows/E fixture; these rows are not that proof.
import {DATABASE_TABLES,DATABASE_FUNCTIONS,DATABASE_SEQUENCES,RUNTIME_HELPERS,RUNTIME_HELPER_RESULTS,
  DATABASE_SERVICE_ROLE_KINDS,expectedTablePrivileges,expectedColumnPrivileges,expectedFunctionExecution,TABLE_PRIVILEGES} from '../database-privilege-policy.mjs';
export const serviceInput = () => ({roles:{owner:'cb_owner',runtime:'cb_runtime',bootstrap:'cb_bootstrap',backup:'cb_backup',worker:'cb_worker'},
  target:{name:'cb_synthetic',confirm:'cb_synthetic',oid:12345,ownerOid:12346}});
export function serviceCatalog() {
  const input = serviceInput(),calls = [],state = {kind:'worker',transactions:0,grantedBody:false,missingWorkerRead:false,before:null,commitError:null};
  const rowsFor = (sql) => {
    if (sql.startsWith('SET LOCAL')) return [];
    if (sql.includes('FROM pg_catalog.pg_database d')) return [{datname:input.target.name,oid:input.target.oid,owner_oid:input.target.ownerOid,
      current_role:input.roles[state.kind],session_role:input.roles[state.kind],version:180006}];
    if (sql.includes('rolname=ANY')) return Object.entries(input.roles).map(([kind,rolname]) => ({rolname,oid:kind === 'owner' ? input.target.ownerOid : 20000+Object.keys(input.roles).indexOf(kind),
      rolcanlogin:true,rolsuper:false,rolinherit:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,rolconfig:null}));
    if (sql.includes('pg_auth_members') || sql.includes('datdba=ANY')) return [];
    if (sql.includes("relkind NOT IN")) return [...DATABASE_TABLES.map((relname) => ({relname,relkind:'r',owner_oid:input.target.ownerOid})),
      ...DATABASE_SEQUENCES.map((relname) => ({relname,relkind:'S',owner_oid:input.target.ownerOid}))];
    if (sql.includes('p.proowner::bigint')) return DATABASE_FUNCTIONS.map((proname) => ({proname,owner_oid:input.target.ownerOid,
      args:RUNTIME_HELPERS[proname] ?? '',result:RUNTIME_HELPER_RESULTS[proname] ?? 'trigger',prosecdef:false,proconfig:null}));
    if (sql.includes('pg_default_acl')) return [{defaclobjtype:'f',namespace:0,grantee:input.target.ownerOid,privilege_type:'EXECUTE'}];
    if (sql.includes('has_table_privilege')) return DATABASE_SERVICE_ROLE_KINDS.flatMap((kind) => DATABASE_TABLES.flatMap((relname) => TABLE_PRIVILEGES.map((permission) => ({
      role:input.roles[kind],relname,permission,allowed:expectedTablePrivileges(kind,relname).includes(permission) && !(state.missingWorkerRead && kind === 'worker' && relname === 'cb_media_uploads' && permission === 'SELECT'),grantable:false}))));
    if (sql.includes('has_column_privilege')) return DATABASE_SERVICE_ROLE_KINDS.flatMap((kind) => DATABASE_TABLES.flatMap((relname) => {
      const permissions = ['SELECT','INSERT','UPDATE','REFERENCES'];
      const columns = new Set(['body',...permissions.flatMap((permission) => expectedColumnPrivileges(kind,relname,permission))]);
      return [...columns].flatMap((attname) => permissions.map((permission) => ({role:input.roles[kind],relname,attname,permission,grantable:false,
        allowed:expectedTablePrivileges(kind,relname).includes(permission) || expectedColumnPrivileges(kind,relname,permission).includes(attname) ||
          state.grantedBody && kind === 'worker' && relname === 'cb_messages' && attname === 'body' && permission === 'SELECT'})));
    }));
    if (sql.includes('has_sequence_privilege')) return DATABASE_SERVICE_ROLE_KINDS.flatMap((kind) => DATABASE_SEQUENCES.flatMap((relname) => ['SELECT','USAGE','UPDATE'].map((permission) => ({
      role:input.roles[kind],relname,permission,grantable:false,allowed:kind === 'runtime' && permission === 'USAGE' || kind === 'backup' && permission === 'SELECT'}))));
    if (sql.includes('has_function_privilege')) return DATABASE_SERVICE_ROLE_KINDS.flatMap((kind) => DATABASE_FUNCTIONS.map((proname) => ({
      role:input.roles[kind],proname,grantable:false,allowed:expectedFunctionExecution(kind,proname),direct:expectedFunctionExecution(kind,proname)})));
    if (sql.includes('has_database_privilege')) return DATABASE_SERVICE_ROLE_KINDS.map((kind) => ({name:input.roles[kind],connect:true,usage:true,create_db:false,temporary:false,create_schema:false}));
    throw new Error('UNEXPECTED_CATALOG_QUERY');
  };
  const database = {async transaction(work) {
    state.transactions++; await state.before?.();
    const tx = {query:async (sql,params) => { calls.push({sql,params}); return {rows:rowsFor(sql)}; }};
    const result = await work(tx); if (state.commitError) throw state.commitError; return result;
  }};
  return {input,state,calls,database};
}
