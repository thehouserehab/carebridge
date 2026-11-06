// No DB, PGlite, auth material, child process, HTTP listener or container.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NATIVE_RECOVERY_MIGRATIONS, recoveryMigrationManifest, assertRecoveryMigrations,
  assertRecoveryReviewRows, assertRecoveryRecipientRows, compareRecoveryFingerprint } from '../recovery-native-contract.mjs';

const files = () => NATIVE_RECOVERY_MIGRATIONS.map(name => ({ name, content: `SYNTHETIC SQL ${name}` }));
const migrationError = { message: 'RECOVERY_NATIVE_COMPARE_MIGRATIONS' };
test('reviewed file manifest is deterministic, hashes actual bytes and does not mutate inputs', () => {
  const input = files().reverse(), before = structuredClone(input), result = recoveryMigrationManifest(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.map(row => row.name), NATIVE_RECOVERY_MIGRATIONS);
  for (const row of result) assert.equal(row.checksum, createHash('sha256').update(`SYNTHETIC SQL ${row.name}`).digest('hex'));
  assert.ok(Object.isFrozen(result)); assert.ok(result.every(Object.isFrozen));
  assertRecoveryMigrations(structuredClone(result), result);
});
test('file inventory refuses missing, extra, duplicate and same-count renamed SQL', () => {
  const original = files();
  for (const candidate of [original.slice(0, -1), [...original, { name: '023-unreviewed.sql', content: 'future' }],
    [...original.slice(0, -1), original[0]], [...original.slice(0, -1), { ...original.at(-1), name: '022-unreviewed.sql' }],
    [...original.slice(0, -1), { ...original.at(-1), content: null }]])
    assert.throws(() => recoveryMigrationManifest(candidate), migrationError);
});
test('applied ledger rejects missing, extra, renamed, duplicate and changed-checksum rows, not merely a wrong count', () => {
  const expected = recoveryMigrationManifest(files());
  for (const rows of [expected.slice(0, -1), [...expected, { name: '023-unreviewed.sql', checksum: 'a'.repeat(64) }],
    [...expected.slice(0, -1), expected[0]], [...expected.slice(0, -1), { ...expected.at(-1), name: '022-unreviewed.sql' }],
    expected.map((row, index) => index === expected.length - 1 ? { ...row, checksum: 'b'.repeat(64) } : row),
    expected.map(row => ({ ...row, extra: true }))])
    assert.throws(() => assertRecoveryMigrations(rows, expected), migrationError);
  const modifiedFiles = files(); modifiedFiles.at(-1).content += '-- changed';
  assert.throws(() => assertRecoveryMigrations(expected, recoveryMigrationManifest(modifiedFiles)), migrationError);
});
test('repository SQL matches the reviewed inventory; native Docker copies and permits the contract helper', async () => {
  const directory = new URL('../migrations/', import.meta.url);
  const actual = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql'))
    .map(async name => ({ name, content: await readFile(new URL(name, directory)) })));
  const manifest = recoveryMigrationManifest(actual);
  assertRecoveryMigrations(manifest, manifest);
  const docker = await readFile(new URL('../recovery-test.Dockerfile', import.meta.url), 'utf8');
  const allowlist = await readFile(new URL('../recovery-test.Dockerfile.dockerignore', import.meta.url), 'utf8');
  assert.match(docker, /^COPY server\/recovery-native-contract\.mjs \.\/$/m);
  assert.ok(allowlist.split(/\r?\n/).includes('!server/recovery-native-contract.mjs'));
});

function fingerprint() {
  return {
    data: [{ name: 'cb_message_reviews', count: 1, hash: 'SYNTHETIC-REVIEW-V2' },
      { name: 'cb_message_review_requests', count: 2, hash: 'SYNTHETIC-RECEIPTS-V1-V2' }],
    schema: [{ relname: 'cb_message_reviews', relkind: 'r', owner: 'synthetic-owner', effective_acl: ['owner'] },
      { relname: 'cb_message_review_requests', relkind: 'r', owner: 'synthetic-owner', effective_acl: ['owner'] }],
    columns: [{ relname: 'cb_message_reviews', attname: 'review_version', attnotnull: true, type: 'integer', default_expression: '1' }],
    triggers: [{ relname: 'cb_message_reviews', tgname: 'cb_message_review_guard', tgenabled: 'O', definition: 'SYNTHETIC-REVIEW-GUARD' },
      { relname: 'cb_message_review_requests', tgname: 'cb_000_recovery_guard', tgenabled: 'O', definition: 'SYNTHETIC-RECOVERY-GUARD' }],
    internalTriggers: [{ relname: 'cb_message_review_requests', conname: 'source-revision-fkey', tgenabled: 'O', count: 2 }],
    functions: [{ proname: 'cb_message_review_guard', owner: 'synthetic-owner', definition: 'SYNTHETIC-REVIEW-FUNCTION' }],
    constraints: [{ relname: 'cb_message_reviews', name: 'review-version-check', contype: 'c', definition: 'CHECK (review_version > 0)' },
      { relname: 'cb_message_review_requests', name: 'source-revision-fkey', contype: 'f',
        definition: 'FOREIGN KEY (center_id,conversation_id,message_id,message_revision) REFERENCES cb_message_text_revisions' }],
  };
}
test('022 coverage refuses absent or empty review data even when two empty snapshots would match', () => {
  const data = fingerprint().data; assertRecoveryReviewRows(data);
  for (const candidate of [[], data.slice(0, 1), data.map(row => ({ ...row, count: 0 })),
    [data[0], { ...data[1], count: 1 }], [...data, data[0]]])
    assert.throws(() => assertRecoveryReviewRows(candidate), { message: 'RECOVERY_NATIVE_COMPARE_REVIEW_ROWS' });
});

const recipientData = () => [
  { name: 'cb_care_recipient_links', count: 1, hash: 'SYNTHETIC-RETAINED-IDENTITY' },
  { name: 'cb_primary_communicators', count: 1, hash: 'SYNTHETIC-PRIMARY-V2-GENERATIONS-2' },
  { name: 'cb_primary_communicator_requests', count: 2, hash: 'SYNTHETIC-PRIMARY-RECEIPTS-V1-V2' },
];
test('023 coverage requires all three nonempty tables with exact fixture counts', () => {
  const data = recipientData(); assertRecoveryRecipientRows(data);
  assertRecoveryRecipientRows([...fingerprint().data, ...data]);
  for (const candidate of [undefined, null, {}, [], data.slice(1),
    data.map(row => ({ ...row, count: 0 })), ...data.map((_, index) =>
      data.map((row, position) => position === index ? { ...row, count: row.count + 1 } : row)),
    ...data.map(row => [...data, row])])
    assert.throws(() => assertRecoveryRecipientRows(candidate), { message: 'RECOVERY_NATIVE_COMPARE_RECIPIENT_ROWS' });
});
test('023 native fingerprints detect same-count identity, generation or historical receipt changes', () => {
  const expected = fingerprint(); expected.data.push(...recipientData());
  compareRecoveryFingerprint(structuredClone(expected), expected);
  for (const row of recipientData()) {
    const actual = structuredClone(expected);
    actual.data.find(value => value.name === row.name).hash = 'SYNTHETIC-CHANGED';
    assert.throws(() => compareRecoveryFingerprint(actual, expected), { message: 'RECOVERY_NATIVE_COMPARE_DATA' });
  }
});
test('native fingerprint comparison detects equal-count review/receipt changes and missing tables', () => {
  const expected = fingerprint(); compareRecoveryFingerprint(structuredClone(expected), expected);
  for (const index of [0, 1]) {
    const actual = structuredClone(expected); actual.data[index].hash = 'SYNTHETIC-CHANGED';
    assert.throws(() => compareRecoveryFingerprint(actual, expected), { message: 'RECOVERY_NATIVE_COMPARE_DATA' });
  }
  const missing = structuredClone(expected); missing.data.pop();
  assert.throws(() => compareRecoveryFingerprint(missing, expected), { message: 'RECOVERY_NATIVE_COMPARE_DATA' });
});
test('native schema comparison rejects missing version column, nullability/default changes and disabled guards', () => {
  const expected = fingerprint();
  for (const change of [actual => { actual.columns = []; }, actual => { actual.columns[0].attnotnull = false; },
    actual => { actual.columns[0].default_expression = '0'; }]) {
    const actual = structuredClone(expected); change(actual);
    assert.throws(() => compareRecoveryFingerprint(actual, expected), { message: 'RECOVERY_NATIVE_COMPARE_COLUMNS' });
  }
  for (const part of ['triggers', 'internalTriggers', 'functions']) {
    const missing = structuredClone(expected); missing[part] = [];
    assert.throws(() => compareRecoveryFingerprint(missing, expected), { message: `RECOVERY_NATIVE_COMPARE_${part.toUpperCase()}` });
  }
  const disabled = structuredClone(expected); disabled.triggers[1].tgenabled = 'D';
  assert.throws(() => compareRecoveryFingerprint(disabled, expected), { message: 'RECOVERY_NATIVE_COMPARE_TRIGGERS' });
});
test('native comparison refuses weakened positive version, mutable-head FK and newly public ACL', () => {
  const expected = fingerprint();
  for (const [index, definition, kind] of [[0, 'CHECK (review_version >= 0)', 'C'],
    [1, 'FOREIGN KEY (message_id) REFERENCES cb_message_reviews', 'F']]) {
    const actual = structuredClone(expected); actual.constraints[index].definition = definition;
    assert.throws(() => compareRecoveryFingerprint(actual, expected), { message: `RECOVERY_NATIVE_CONSTRAINT_${kind}` });
  }
  const publicRead = structuredClone(expected); publicRead.schema[0].effective_acl.push('PUBLIC SELECT');
  assert.throws(() => compareRecoveryFingerprint(publicRead, expected), { message: 'RECOVERY_NATIVE_SCHEMA_EFFECTIVE_ACL' });
  const missing = structuredClone(expected); delete missing.constraints;
  assert.throws(() => compareRecoveryFingerprint(missing, expected), { message: 'RECOVERY_NATIVE_COMPARE_CONSTRAINTS' });
});
