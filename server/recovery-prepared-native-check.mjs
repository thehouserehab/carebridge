// Opt-in synthetic recovery evidence only. Importing this module opens no
// database, file, socket or worker. Native decoding is proved by the caller;
// this module binds those samples to the captured database and media bytes.
import { createHash } from 'node:crypto';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const filename = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:blob|blocked)$/;
const sampleFields = ['uploadId', 'type', 'sourceKey', 'derivativeKey', 'sourceSize', 'derivativeSize', 'sourceSha256', 'derivativeSha256'];
const ensure = condition => { if (!condition) throw new Error('RECOVERY_PREPARED_SAMPLES_INVALID'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);

function validateSamples(samples) {
  ensure(Array.isArray(samples) && samples.length === 2);
  const identities = new Set();
  for (const sample of samples) {
    ensure(object(sample) && Object.keys(sample).sort().join(',') === [...sampleFields].sort().join(','));
    ensure(['image/png', 'video/mp4', 'video/webm'].includes(sample.type));
    for (const key of ['uploadId', 'sourceKey', 'derivativeKey']) {
      ensure(matches(uuid, sample[key]) && !identities.has(sample[key]));
      identities.add(sample[key]);
    }
    for (const key of ['sourceSize', 'derivativeSize']) ensure(Number.isSafeInteger(sample[key]) && sample[key] > 0);
    for (const key of ['sourceSha256', 'derivativeSha256']) ensure(matches(digest, sample[key]));
  }
  ensure(samples.filter(sample => sample.type === 'image/png').length === 1);
  ensure(samples.filter(sample => sample.type === 'video/mp4' || sample.type === 'video/webm').length === 1);
  return samples;
}

// Pure checks, also used by fake-transaction tests. Rows are deliberately flat
// snake_case aliases from the scoped query below; no row or evidence is logged.
export function assertPreparedRecoverySamples(rows, samples, files) {
  validateSamples(samples);
  ensure(Array.isArray(rows) && rows.length === 2);
  ensure(rows.every(row => object(row) && matches(uuid, row.upload_id)));
  ensure(new Set(rows.map(row => row.upload_id)).size === 2);
  ensure(Array.isArray(files) && files.length > 0);
  const inventory = new Map();
  for (const file of files) {
    ensure(object(file) && matches(filename, file.name) && Buffer.isBuffer(file.data) && !inventory.has(file.name));
    inventory.set(file.name, file);
  }
  const preparationIds = new Set();
  return samples.map(sample => {
    const row = rows.find(value => value.upload_id === sample.uploadId);
    ensure(row && row.state === 'bound' && row.preparation_required === true);
    ensure(typeof row.center_id === 'string' && row.center_id.length > 0);
    ensure(typeof row.conversation_id === 'string' && row.conversation_id.length > 0);
    ensure(matches(uuid, row.preparation_id) && row.preparation_row_id === row.preparation_id && !preparationIds.has(row.preparation_id));
    preparationIds.add(row.preparation_id);
    for (const [column, field] of [['type', 'type'], ['source_key', 'sourceKey'], ['derivative_key', 'derivativeKey'],
      ['source_size', 'sourceSize'], ['derivative_size', 'derivativeSize'],
      ['source_sha256', 'sourceSha256'], ['derivative_sha256', 'derivativeSha256']]) {
      ensure(row[column] === sample[field]);
      ensure(row[`preparation_${column}`] === sample[field]);
    }
    for (const prefix of ['preparation', 'source_object', 'derivative_object']) {
      ensure(row[`${prefix}_center_id`] === row.center_id);
      ensure(row[`${prefix}_conversation_id`] === row.conversation_id);
      ensure(row[`${prefix}_upload_id`] === sample.uploadId);
    }
    for (const [prefix, key] of [['source_object', sample.sourceKey], ['derivative_object', sample.derivativeKey]]) {
      ensure(row[`${prefix}_key`] === key && row[`${prefix}_state`] === 'active');
    }
    let candidate;
    for (const part of ['source', 'derivative']) {
      const key = sample[`${part}Key`], file = inventory.get(`${key}.blob`);
      ensure(file && !inventory.has(`${key}.blocked`));
      ensure(object(file.manifest) && Object.keys(file.manifest).sort().join(',') === 'sha256,size,type');
      ensure(file.manifest.type === sample.type && file.manifest.size === sample[`${part}Size`] &&
        file.manifest.sha256 === sample[`${part}Sha256`]);
      ensure(file.data.length === sample[`${part}Size`] && hash(file.data) === sample[`${part}Sha256`]);
      if (part === 'derivative') candidate = file;
    }
    return { type:sample.type, object:sample.derivativeKey, bytes:Buffer.from(candidate.data) };
  });
}

export async function capturePreparedRecoverySamples(db, samples, files) {
  // Validate before issuing SQL and snapshot the manifest across the await.
  const expected = validateSamples(samples).map(sample => ({ ...sample }));
  ensure(db && typeof db.transaction === 'function');
  const rows = await db.transaction(async tx => {
    await tx.query('SET TRANSACTION READ ONLY');
    const result = await tx.query(`SELECT
      u.center_id,u.conversation_id,u.id AS upload_id,u.state,u.preparation_required,u.preparation_id,u.type,
      u.object_key AS source_key,u.candidate_key AS derivative_key,u.size AS source_size,u.sha256 AS source_sha256,
      u.prepared_size AS derivative_size,u.prepared_sha256 AS derivative_sha256,
      p.id AS preparation_row_id,p.center_id AS preparation_center_id,p.conversation_id AS preparation_conversation_id,
      p.upload_id AS preparation_upload_id,p.type AS preparation_type,p.source_key AS preparation_source_key,
      p.derivative_key AS preparation_derivative_key,p.source_size AS preparation_source_size,
      p.derivative_size AS preparation_derivative_size,p.source_sha256 AS preparation_source_sha256,
      p.derivative_sha256 AS preparation_derivative_sha256,
      s.key AS source_object_key,s.state AS source_object_state,s.center_id AS source_object_center_id,
      s.conversation_id AS source_object_conversation_id,s.upload_id AS source_object_upload_id,
      d.key AS derivative_object_key,d.state AS derivative_object_state,d.center_id AS derivative_object_center_id,
      d.conversation_id AS derivative_object_conversation_id,d.upload_id AS derivative_object_upload_id
      FROM cb_media_uploads u
      JOIN cb_media_preparations p ON (p.center_id,p.conversation_id,p.upload_id,p.id)=
        (u.center_id,u.conversation_id,u.id,u.preparation_id)
      JOIN cb_media_objects s ON (s.center_id,s.conversation_id,s.upload_id,s.key)=
        (u.center_id,u.conversation_id,u.id,u.object_key)
      JOIN cb_media_objects d ON (d.center_id,d.conversation_id,d.upload_id,d.key)=
        (u.center_id,u.conversation_id,u.id,u.candidate_key)
      WHERE u.state='bound' AND u.id=ANY($1::text[]) ORDER BY u.id`, [expected.map(sample => sample.uploadId)]);
    return result.rows;
  });
  return assertPreparedRecoverySamples(rows, expected, files);
}
