// Pure assertions shared by the opt-in native recovery runner and no-service
// contract tests. Importing this module never creates a DB, key or listener.
import { createHash } from 'node:crypto';

// Deliberately reviewed names, not whatever happens to be present on disk.
// A new migration requires extending the recovery fixture and this inventory.
export const NATIVE_RECOVERY_MIGRATIONS = Object.freeze([
  '001-conversations.sql', '002-authentication.sql', '003-invitations.sql',
  '004-relationships.sql', '005-records.sql', '006-activity-feedback.sql',
  '007-care-contexts.sql', '008-media-uploads.sql', '009-media-bindings.sql',
  '010-profiles.sql', '011-center-bootstrap.sql', '012-decoder-journal.sql',
  '013-media-preparation-storage.sql', '014-media-work-queue.sql', '015-media-resource-limits.sql',
  '016-media-work-reviews.sql', '017-recovery-quarantine.sql', '018-record-drafts.sql',
  '019-account-security-events.sql', '020-message-lifecycle.sql', '021-password-recovery.sql',
  '022-message-reviews.sql', '023-care-recipient-links.sql',
]);
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const failMigrations = () => { throw new Error('RECOVERY_NATIVE_COMPARE_MIGRATIONS'); };
function assertNames(names) {
  if (names.length !== NATIVE_RECOVERY_MIGRATIONS.length ||
      names.some((name, index) => name !== NATIVE_RECOVERY_MIGRATIONS[index])) failMigrations();
}
export function recoveryMigrationManifest(files) {
  if (!Array.isArray(files) || files.some(file => !file || typeof file.name !== 'string' ||
      !(typeof file.content === 'string' || Buffer.isBuffer(file.content)))) failMigrations();
  const ordered = [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  assertNames(ordered.map(file => file.name));
  return Object.freeze(ordered.map(({ name, content }) => Object.freeze({ name, checksum: bytesHash(content) })));
}
export function assertRecoveryMigrations(actual, expected) {
  for (const rows of [actual, expected]) {
    if (!Array.isArray(rows) || rows.some(row => !row ||
        Object.keys(row).sort().join(',') !== 'checksum,name' || !/^[a-f0-9]{64}$/.test(row.checksum))) failMigrations();
    assertNames(rows.map(row => row.name));
  }
  if (actual.some((row, index) => row.checksum !== expected[index].checksum)) failMigrations();
}
export function assertRecoveryReviewRows(data) {
  // Empty source and target tables must not masquerade as 022 coverage.
  if (!Array.isArray(data)) throw new Error('RECOVERY_NATIVE_COMPARE_REVIEW_ROWS');
  for (const [name, count] of [['cb_message_reviews', 1], ['cb_message_review_requests', 2]]) {
    const rows = data.filter(row => row.name === name);
    if (rows.length !== 1 || rows[0].count !== count) throw new Error('RECOVERY_NATIVE_COMPARE_REVIEW_ROWS');
  }
}
export function assertRecoveryRecipientRows(data) {
  // The independent native fixture must contain the retained link, current
  // designation and both historical requests. Empty matching dumps are not
  // evidence that 023 identity, qualification generations or replay survived.
  if (!Array.isArray(data)) throw new Error('RECOVERY_NATIVE_COMPARE_RECIPIENT_ROWS');
  for (const [name, count] of [['cb_care_recipient_links', 1], ['cb_primary_communicators', 1],
    ['cb_primary_communicator_requests', 2]]) {
    const rows = data.filter(row => row.name === name);
    if (rows.length !== 1 || rows[0].count !== count) throw new Error('RECOVERY_NATIVE_COMPARE_RECIPIENT_ROWS');
  }
}
export function compareRecoveryFingerprint(actual, expected) {
  for (const part of ['data', 'schema', 'columns', 'triggers', 'internalTriggers', 'functions', 'constraints']) {
    if (!Array.isArray(actual?.[part]) || !Array.isArray(expected?.[part]))
      throw new Error(`RECOVERY_NATIVE_COMPARE_${part.toUpperCase()}`);
    if (bytesHash(Buffer.from(JSON.stringify(actual[part]))) !== bytesHash(Buffer.from(JSON.stringify(expected[part])))) {
      if (part === 'schema' && actual.schema.length === expected.schema.length) {
        for (let i = 0; i < expected.schema.length; i++) for (const field of ['relname', 'relkind', 'owner', 'effective_acl'])
          if (JSON.stringify(actual.schema[i][field]) !== JSON.stringify(expected.schema[i][field]))
            throw new Error(`RECOVERY_NATIVE_SCHEMA_${field.toUpperCase()}`);
      }
      if (part === 'constraints' && actual.constraints.length === expected.constraints.length) {
        const i = actual.constraints.findIndex((row, index) => JSON.stringify(row) !== JSON.stringify(expected.constraints[index]));
        if (i >= 0 && /^[a-z]$/.test(expected.constraints[i].contype))
          throw new Error(`RECOVERY_NATIVE_CONSTRAINT_${expected.constraints[i].contype.toUpperCase()}`);
      }
      throw new Error(`RECOVERY_NATIVE_COMPARE_${part.toUpperCase()}`);
    }
  }
}
