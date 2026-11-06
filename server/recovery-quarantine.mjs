// Internal operator primitive ONLY. No HTTP, env auto-detection, migration
// activation or release. The controller must verify the bundle, restore bytes,
// stop all writers and retain fresh source/target creation receipts first.
// This version supports distinct owned databases in the SAME cluster only.
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value,key));
const validOid = (value) => Number.isSafeInteger(value) && value > 0 && value <= 4294967295;
const validReceipt = (value) => exact(value,['name','oid','ownerOid']) && typeof value.name === 'string' &&
  Buffer.byteLength(value.name) <= 63 && value.name.length > 0 && !/[\x00-\x1f\x7f]/.test(value.name) &&
  !['postgres','template0','template1'].includes(value.name) && validOid(value.oid) && validOid(value.ownerOid);
const fail = (code = 'RECOVERY_QUARANTINE_UNAVAILABLE') => { throw new RecoveryQuarantineError(code); };
export class RecoveryQuarantineError extends Error {
  constructor(code) { super(code); this.name = 'RecoveryQuarantineError'; this.code = code; }
}
const response = (row,replayed) => ({ operationId:row.operation_id,bundleId:row.bundle_id,
  disabledUsers:row.disabled_users,revokedSessions:row.revoked_sessions,revokedInvitations:row.revoked_invitations,
  createdAt:new Date(row.created_at).toISOString(),replayed });
async function assertCredentialsClosed(tx) {
  const row = (await tx.query(`SELECT NOT EXISTS(SELECT 1 FROM public.cb_users WHERE active) AND
    NOT EXISTS(SELECT 1 FROM public.cb_auth_sessions WHERE revoked_at IS NULL) AND
    NOT EXISTS(SELECT 1 FROM public.cb_auth_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL) AND
    NOT EXISTS(SELECT 1 FROM public.cb_auth_password_resets WHERE consumed_at IS NULL AND revoked_at IS NULL) AS closed`)).rows[0];
  if (row?.closed !== true) fail('RECOVERY_QUARANTINE_AUTH_OPEN');
}

export async function quarantineRestoredDatabase(database,input) {
  if (!database?.transaction || !exact(input,['operationId','bundleId','sourceReceipt','targetReceipt','confirmTarget']) ||
      typeof input.operationId !== 'string' || !uuid.test(input.operationId) ||
      typeof input.bundleId !== 'string' || !uuid.test(input.bundleId) || !validReceipt(input.sourceReceipt) ||
      !validReceipt(input.targetReceipt) || input.confirmTarget !== input.targetReceipt.name ||
      input.sourceReceipt.name === input.targetReceipt.name || input.sourceReceipt.oid === input.targetReceipt.oid)
    fail('RECOVERY_QUARANTINE_INVALID_INPUT');
  const { operationId,bundleId } = input;
  // Capture approval/ownership at entry. Caller mutation during connection or
  // lock waits must not change the target that was explicitly confirmed.
  const sourceReceipt = { ...input.sourceReceipt },targetReceipt = { ...input.targetReceipt };
  try {
    return await database.transaction(async (tx) => {
      await tx.query('SET LOCAL search_path = pg_catalog,pg_temp');
      const { rows } = await tx.query(`SELECT d.datname,d.oid::bigint AS oid,d.datdba::bigint AS owner_oid,
          r.oid::bigint AS role_oid,current_database() AS current_database,
          current_user = session_user AS direct_role,has_table_privilege(current_user,'public.cb_recovery_quarantine','INSERT') AS allowed
        FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname=current_user
        WHERE d.datname IN ($1,$2) AND NOT d.datistemplate AND d.datallowconn`,[sourceReceipt.name,targetReceipt.name]);
      const matches = (receipt) => rows.find((r) => r.datname === receipt.name && Number(r.oid) === receipt.oid && Number(r.owner_oid) === receipt.ownerOid);
      const target = matches(targetReceipt);
      if (!matches(sourceReceipt) || !target || target.current_database !== targetReceipt.name ||
          !target.direct_role || !target.allowed || Number(target.role_oid) !== targetReceipt.ownerOid)
        fail('RECOVERY_QUARANTINE_TARGET_MISMATCH');
      // Serialize activation and every affected write, not merely this helper's
      // retries. Lock failure rolls back; no live process is killed or adopted.
      await tx.query(`LOCK TABLE public.cb_recovery_quarantine,public.cb_users,public.cb_auth_accounts,
        public.cb_auth_sessions,public.cb_auth_invitations,public.cb_auth_password_resets,public.cb_decoder_engines,public.cb_decoder_jobs,
        public.cb_media_uploads,public.cb_media_objects,public.cb_media_preparations,public.cb_media_work_queue
        IN SHARE ROW EXCLUSIVE MODE`);
      const existing = (await tx.query('SELECT * FROM public.cb_recovery_quarantine')).rows[0];
      if (existing) {
        if (existing.operation_id !== operationId || existing.bundle_id !== bundleId ||
            existing.source_name !== sourceReceipt.name || Number(existing.source_oid) !== sourceReceipt.oid ||
            Number(existing.source_owner_oid) !== sourceReceipt.ownerOid ||
            existing.target_name !== targetReceipt.name || Number(existing.target_oid) !== targetReceipt.oid ||
            Number(existing.owner_oid) !== targetReceipt.ownerOid) fail('RECOVERY_QUARANTINE_CONFLICT');
        await assertCredentialsClosed(tx);
        return response(existing,true);
      }
      const disabledUsers = (await tx.query('UPDATE public.cb_users SET active=false WHERE active')).rowCount;
      const revokedSessions = (await tx.query('UPDATE public.cb_auth_sessions SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL')).rowCount;
      const revokedInvitations = (await tx.query(`UPDATE public.cb_auth_invitations SET revoked_at=clock_timestamp()
        WHERE accepted_at IS NULL AND revoked_at IS NULL`)).rowCount;
      // Deactivation's trigger closes active users' tokens. Close any remaining
      // pending token too, including already-inactive users and expired tokens.
      // Terminal credentials and the old immutable receipt counts stay intact.
      await tx.query(`UPDATE public.cb_auth_password_resets SET revoked_at=clock_timestamp()
        WHERE consumed_at IS NULL AND revoked_at IS NULL`);
      await assertCredentialsClosed(tx);
      const { rows: inserted } = await tx.query(`INSERT INTO public.cb_recovery_quarantine
        (operation_id,bundle_id,source_name,source_oid,source_owner_oid,target_name,target_oid,owner_oid,disabled_users,revoked_sessions,revoked_invitations)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [operationId,bundleId,sourceReceipt.name,sourceReceipt.oid,sourceReceipt.ownerOid,targetReceipt.name,targetReceipt.oid,targetReceipt.ownerOid,
        disabledUsers,revokedSessions,revokedInvitations]);
      return response(inserted[0],false);
    });
  } catch (error) {
    if (error instanceof RecoveryQuarantineError) throw error;
    // A lost COMMIT acknowledgement is unknown, not success or automatic retry.
    // An explicit same-receipt replay can inspect the committed outcome later.
    fail();
  }
}
