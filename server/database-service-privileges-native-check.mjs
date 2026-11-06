// Fresh synthetic Windows/E fixture only. Actual PostgreSQL login/pool/ACL
// behavior, not credential custody, OS isolation or an operating approval.
import assert from 'node:assert/strict';
import {databaseForService,verifyDatabasePrivileges} from './database-privileges.mjs';
import {syntheticPrivilegeInput,SYNTHETIC_DB_ROLES} from './database-privileges-native-check.mjs';
const denied = (work) => assert.rejects(work,{message:'DATABASE_PRIVILEGES_UNAVAILABLE'});
export async function exerciseServiceDatabasePrivileges({owner,runtime,worker,bootstrap,backup,admin}) {
  const checks = []; let phase = 201;
  try {
    const input = await syntheticPrivilegeInput(owner);
    for (const [kind,db] of Object.entries({runtime,worker,bootstrap,backup})) {
      const guarded = databaseForService(db,input,kind);
      const actual = await guarded.transaction(async (tx) => (await tx.query('SELECT current_user AS role,session_user AS session')).rows[0]);
      assert.deepEqual(actual,{role:SYNTHETIC_DB_ROLES[kind],session:SYNTHETIC_DB_ROLES[kind]});
    }
    for (const db of [owner,runtime,bootstrap,backup]) {
      let entered = false; await denied(databaseForService(db,input,'worker').transaction(() => { entered = true; })); assert.equal(entered,false);
    }
    for (const field of ['oid','ownerOid']) {
      const changed = {...input,target:{...input.target,[field]:input.target[field]+1}};
      await denied(databaseForService(worker,changed,'worker').transaction(() => assert.fail('wrong target must not admit work')));
    }
    checks.push('role-bound service ports admit four direct logins and reject owner/app/other-purpose connections or wrong DB/owner OIDs before work');

    phase = 202;
    let selected = worker,entered = 0;
    const mixed = databaseForService({transaction:(work) => selected.transaction(work)},input,'worker');
    await mixed.transaction(() => ++entered); selected = runtime;
    await denied(mixed.transaction(() => ++entered)); assert.equal(entered,1); selected = worker;
    await owner.transaction((tx) => tx.query(`GRANT SELECT(body) ON cb_messages TO ${SYNTHETIC_DB_ROLES.worker}`));
    try { await denied(mixed.transaction(() => ++entered)); assert.equal(entered,1); }
    finally { await owner.transaction((tx) => tx.query(`REVOKE SELECT(body) ON cb_messages FROM ${SYNTHETIC_DB_ROLES.worker}`)); }
    await mixed.transaction(() => ++entered); assert.equal(entered,2);
    // Distinguish CURRENT_USER from SESSION_USER. A superuser fixture grants
    // this temporary membership only to its own newly created test owner.
    await admin.query(`GRANT ${SYNTHETIC_DB_ROLES.worker} TO ${SYNTHETIC_DB_ROLES.owner} WITH INHERIT FALSE, SET TRUE`);
    try {
      const impersonated = {transaction:(work) => owner.transaction(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${SYNTHETIC_DB_ROLES.worker}`); return work(tx);
      })};
      await denied(databaseForService(impersonated,input,'worker').transaction(() => ++entered)); assert.equal(entered,2);
    } finally { await admin.query(`REVOKE ${SYNTHETIC_DB_ROLES.worker} FROM ${SYNTHETIC_DB_ROLES.owner}`); }
    await verifyDatabasePrivileges(owner,input);
    checks.push('each same-connection transaction refuses a rotated app client, later hidden column grant and owner SET ROLE impersonation without repair/retry');
    return checks;
  } catch {
    const error = new Error('DATABASE_SERVICE_PRIVILEGE_NATIVE_CHECK_FAILED'); error.roleCheckPhase = phase; throw error;
  }
}
