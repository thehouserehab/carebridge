// Reviewed contract for migrations 001-023, not a grant-on-all/future-objects
// policy. Application DB roles are trusted server identities, NOT tenant roles.
const fail = () => { throw new Error('DATABASE_PRIVILEGE_POLICY_UNAVAILABLE'); };
const words = (value) => Object.freeze(value.trim().split(/\s+/).sort());
export const DATABASE_TABLES = words(`
  cb_account_security_events cb_activity_feedback cb_appointment_revisions cb_appointments cb_audit_events cb_auth_accounts cb_auth_audit_events
  cb_auth_invitations cb_auth_password_resets cb_auth_sessions cb_center_bootstraps cb_centers cb_child_family_plans cb_child_profiles cb_children
  cb_care_recipient_links cb_primary_communicators cb_primary_communicator_requests
  cb_context_requests cb_conversations cb_decoder_engines cb_decoder_jobs cb_feedback_attachments cb_feedback_requests
  cb_feedback_reviews cb_feedback_revisions cb_goal_revisions cb_goals cb_media_events cb_media_objects cb_media_preparations
  cb_media_resource_events cb_media_resource_limits cb_media_uploads cb_media_work_queue cb_media_work_reviews cb_member_profiles
  cb_memberships cb_message_attachments cb_message_change_requests cb_message_hides cb_message_reply_versions cb_message_review_requests
  cb_message_reviews cb_message_text_heads cb_message_text_revisions cb_messages cb_participants cb_profile_requests
  cb_publication_attachments cb_publications cb_read_states cb_record_assessments cb_record_attachments cb_record_publications
  cb_record_recipients cb_record_references cb_record_requests cb_record_revisions cb_record_text_sources cb_records cb_recovery_quarantine
  cb_relationship_changes cb_relationship_requests cb_schema_migrations cb_users
`);
export const DATABASE_FUNCTIONS = words(`
  cb_account_security_event_guard cb_assert_room_schedule cb_attachment_insert_guard cb_bootstrap_receipt_guard cb_check_record_detail_insert
  cb_care_recipient_participant_guard cb_care_recipient_link_guard cb_primary_communicator_guard
  cb_communication_qualification_generation
  cb_context_capture cb_context_root_guard cb_current_profile_guard cb_decoder_engine_guard cb_decoder_job_guard
  cb_feedback_head_guard cb_feedback_reference_guard cb_immutable_feedback_data cb_immutable_publication cb_immutable_record_data
  cb_media_capture_event cb_media_capture_work cb_media_clean_scan cb_media_lock_resources cb_media_object_guard
  cb_media_preparation_insert_guard cb_media_resource_admission cb_media_resource_capture cb_media_resource_center
  cb_media_resource_check cb_media_resource_policy_guard cb_media_resource_usage cb_media_review_committed cb_media_review_guard
  cb_message_hide_guard cb_message_review_guard cb_message_text_capture cb_message_text_head_guard cb_message_text_reference_guard cb_message_text_revision_guard
  cb_media_root_guard cb_media_work_guard cb_participant_revision cb_participant_schedule_check cb_password_reset_guard cb_password_reset_invalidate cb_recovery_receipt_guard
  cb_recovery_write_guard cb_require_active_media_object cb_require_attachments_sealed cb_require_media_binding
  cb_require_media_preparation cb_require_message_text_head cb_require_sealed_revision cb_require_text_reference
  cb_seal_attachments_only cb_seal_record_revision cb_valid_draft_assessments
`);
export const DATABASE_SEQUENCES = words('cb_audit_events_id_seq cb_auth_audit_events_id_seq');
// Signatures of all reviewed ordinary helpers, not an access grant.
export const RUNTIME_HELPERS = Object.freeze({
  cb_assert_room_schedule:'text, text',cb_media_clean_scan:'jsonb, integer, text',
  cb_media_lock_resources:'text',cb_media_resource_usage:'text',cb_valid_draft_assessments:'jsonb',
});
export const RUNTIME_HELPER_RESULTS = Object.freeze({
  cb_assert_room_schedule:'void',cb_media_clean_scan:'boolean',cb_media_lock_resources:'cb_media_resource_limits',
  cb_media_resource_usage:'TABLE(reserved_bytes bigint, pending_count bigint)',cb_valid_draft_assessments:'boolean',
});
const privateTables = words('cb_center_bootstraps cb_recovery_quarantine cb_schema_migrations cb_decoder_engines cb_decoder_jobs');
const insertOnly = words('cb_account_security_events cb_audit_events cb_auth_audit_events cb_media_events cb_media_resource_events cb_relationship_changes');
const updateTables = words(`cb_activity_feedback cb_appointments cb_auth_accounts cb_auth_invitations cb_auth_sessions
  cb_child_family_plans cb_child_profiles cb_conversations cb_feedback_revisions cb_goals cb_media_objects
  cb_media_resource_limits cb_media_uploads cb_media_work_queue cb_member_profiles cb_message_reviews cb_messages
  cb_participants cb_primary_communicators cb_publications cb_read_states cb_record_publications cb_record_revisions cb_records`);
const bootstrapTables = words('cb_centers cb_users cb_auth_accounts cb_memberships cb_center_bootstraps');
export const DATABASE_ROLE_KINDS = Object.freeze(['owner','runtime','bootstrap','backup','worker']);
export const DATABASE_SERVICE_ROLE_KINDS = Object.freeze(DATABASE_ROLE_KINDS.filter((kind) => kind !== 'owner'));
export const DATABASE_PRIVILEGE_POLICY_VERSION = 7;
const roleKinds = DATABASE_ROLE_KINDS;
const workerReads = words('cb_media_uploads cb_media_objects cb_media_preparations cb_media_work_queue cb_media_resource_limits cb_decoder_engines cb_decoder_jobs');
const workerInserts = words('cb_media_objects cb_media_preparations cb_media_events cb_decoder_engines cb_decoder_jobs');
const appHelpers = words('cb_assert_room_schedule cb_media_lock_resources cb_media_resource_usage cb_valid_draft_assessments');
const workerHelpers = words('cb_media_clean_scan cb_media_lock_resources cb_media_resource_usage');
export const TABLE_PRIVILEGES = Object.freeze(['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']);
const exact = (value,keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
};
const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(value) || /^(pg_|postgres$|public$)/.test(value)) fail();
  return value;
};
export function expectedTablePrivileges(kind,table) {
  if (!roleKinds.includes(kind) || !DATABASE_TABLES.includes(table)) fail();
  if (kind === 'owner') return [...TABLE_PRIVILEGES];
  if (kind === 'backup') return ['SELECT'];
  if (kind === 'bootstrap') return bootstrapTables.includes(table) ? ['SELECT','INSERT'] : table === 'cb_media_resource_limits' ? ['INSERT'] : [];
  if (kind === 'worker') return [...(workerReads.includes(table) ? ['SELECT'] : []),...(workerInserts.includes(table) ? ['INSERT'] : [])];
  if (privateTables.includes(table)) return [];
  if (insertOnly.includes(table)) return ['INSERT'];
  const privileges = ['SELECT'];
  if (!['cb_centers','cb_media_preparations'].includes(table)) privileges.push('INSERT');
  if (updateTables.includes(table)) privileges.push('UPDATE');
  if (table === 'cb_read_states') privileges.push('DELETE');
  return privileges;
}
// Row-level FOR SHARE/FOR UPDATE needs UPDATE on at least one column. Grant
// only the identifier (or the schedule counter actually changed by triggers),
// not password_hash/active/member role. This is not an invocation-only sandbox.
export function expectedUpdateColumns(kind,table) {
  if (!roleKinds.includes(kind) || !DATABASE_TABLES.includes(table)) fail();
  if (kind === 'runtime') return ({cb_centers:['schedule_version'],cb_users:['id'],cb_memberships:['center_id'],cb_message_text_heads:['current_revision'],
    cb_auth_password_resets:['consumed_at','revoked_at']})[table] ?? [];
  if (kind === 'bootstrap') return ({cb_centers:['id'],cb_users:['id'],cb_auth_accounts:['user_id'],cb_memberships:['center_id']})[table] ?? [];
  if (kind === 'worker') return ({
    cb_conversations:['id'],cb_participants:['user_id'],cb_memberships:['center_id'],cb_users:['id'],
    cb_media_resource_limits:['center_id'],cb_decoder_engines:['id'],
    cb_media_uploads:['version','state','object_key','lease_id','lease_until','scan_report','failure_code','candidate_key','preparation_id','prepared_size','prepared_sha256'],
    cb_media_objects:['state'],cb_media_work_queue:['state','attempts','upload_version','lease_id','lease_until'],
    cb_decoder_jobs:['owner_id','generation','phase','container_id','requires_recovery','lease_until','updated_at','closed_at'],
  })[table] ?? [];
  return [];
}
export function expectedColumnPrivileges(kind,table,permission) {
  if (!roleKinds.includes(kind) || !DATABASE_TABLES.includes(table) || !['SELECT','INSERT','UPDATE','REFERENCES'].includes(permission)) fail();
  if (permission === 'UPDATE') return expectedUpdateColumns(kind,table);
  if (kind === 'worker' && permission === 'SELECT') return ({
    cb_conversations:['center_id','id','child_id','revision'],cb_participants:['center_id','conversation_id','user_id','role','active','first_sequence'],
    cb_memberships:['center_id','user_id','role','active'],cb_users:['id','active'],
  })[table] ?? [];
  return [];
}
export function expectedFunctionExecution(kind,name) {
  if (!roleKinds.includes(kind) || !DATABASE_FUNCTIONS.includes(name)) fail();
  return kind === 'owner' || kind === 'runtime' && appHelpers.includes(name) || kind === 'worker' && workerHelpers.includes(name);
}
export function databasePrivilegePlan(input) {
  exact(input,['roles','target']); exact(input.roles,roleKinds); exact(input.target,['name','oid','ownerOid','confirm']);
  const roles = Object.fromEntries(roleKinds.map((kind) => [kind,identifier(input.roles[kind])]));
  if (new Set(Object.values(roles)).size !== roleKinds.length) fail();
  const target = {...input.target}; identifier(target.name);
  if (target.confirm !== target.name || [target.oid,target.ownerOid].some((value) => !Number.isInteger(value) || value < 1 || value > 4294967295)) fail();
  const statements = [
    `REVOKE ALL ON DATABASE "${target.name}" FROM PUBLIC`,
    `REVOKE ALL ON SCHEMA public FROM PUBLIC`,
    `REVOKE ALL ON TABLE ${DATABASE_TABLES.map((name) => `public.${name}`).join(',')} FROM PUBLIC`,
    `REVOKE ALL ON SEQUENCE ${DATABASE_SEQUENCES.map((name) => `public.${name}`).join(',')} FROM PUBLIC`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC`,
  ];
  // A schema-local REVOKE cannot cancel global default EXECUTE. Both levels
  // are explicit, and no automatic grant to any runtime/future object is made.
  for (const location of ['', ' IN SCHEMA public']) for (const type of ['TABLES','SEQUENCES','FUNCTIONS'])
    statements.push(`ALTER DEFAULT PRIVILEGES FOR ROLE "${roles.owner}"${location} REVOKE ALL ON ${type} FROM PUBLIC`);
  for (const kind of DATABASE_SERVICE_ROLE_KINDS) {
    const role = `"${roles[kind]}"`;
    statements.push(`GRANT CONNECT ON DATABASE "${target.name}" TO ${role}`,`GRANT USAGE ON SCHEMA public TO ${role}`);
    for (const table of DATABASE_TABLES) {
      const permissions = expectedTablePrivileges(kind,table);
      if (permissions.length) statements.push(`GRANT ${permissions.join(',')} ON TABLE public.${table} TO ${role}`);
      for (const permission of ['SELECT','INSERT','UPDATE','REFERENCES']) {
        const columns = expectedColumnPrivileges(kind,table,permission);
        if (columns.length) statements.push(`GRANT ${permission} (${columns.join(',')}) ON TABLE public.${table} TO ${role}`);
      }
    }
    if (['runtime','backup'].includes(kind)) statements.push(`GRANT ${kind === 'runtime' ? 'USAGE' : 'SELECT'} ON SEQUENCE ${DATABASE_SEQUENCES.map((name) => `public.${name}`).join(',')} TO ${role}`);
    for (const [name,args] of Object.entries(RUNTIME_HELPERS)) if (expectedFunctionExecution(kind,name))
      statements.push(`GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO ${role}`);
  }
  return Object.freeze({roles:Object.freeze(roles),target:Object.freeze(target),statements:Object.freeze(statements)});
}
