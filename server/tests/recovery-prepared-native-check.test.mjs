import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertPreparedRecoverySamples, capturePreparedRecoverySamples } from '../recovery-prepared-native-check.mjs';

const id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = { message:'RECOVERY_PREPARED_SAMPLES_INVALID' };
function fixture(videoType = 'video/mp4') {
  const samples = [], rows = [], files = [];
  for (const [index, type] of ['image/png', videoType].entries()) {
    // Fake bytes only: this suite proves linkage, not native decoding.
    const source = Buffer.from(`synthetic ${type} original`), derivative = Buffer.from(`synthetic ${type} prepared`);
    const sample = { uploadId:id(index * 10 + 1), type, sourceKey:id(index * 10 + 2), derivativeKey:id(index * 10 + 3),
      sourceSize:source.length, derivativeSize:derivative.length, sourceSha256:hash(source), derivativeSha256:hash(derivative) };
    const row = { center_id:'synthetic-center', conversation_id:'synthetic-room', upload_id:sample.uploadId,
      state:'bound', preparation_required:true, preparation_id:id(index * 10 + 4), preparation_row_id:id(index * 10 + 4),
      type, source_key:sample.sourceKey, derivative_key:sample.derivativeKey, source_size:sample.sourceSize,
      derivative_size:sample.derivativeSize, source_sha256:sample.sourceSha256, derivative_sha256:sample.derivativeSha256 };
    for (const key of ['type', 'source_key', 'derivative_key', 'source_size', 'derivative_size', 'source_sha256', 'derivative_sha256'])
      row[`preparation_${key}`] = row[key];
    for (const prefix of ['preparation', 'source_object', 'derivative_object']) {
      row[`${prefix}_center_id`] = row.center_id;
      row[`${prefix}_conversation_id`] = row.conversation_id;
      row[`${prefix}_upload_id`] = sample.uploadId;
    }
    for (const part of ['source', 'derivative']) {
      row[`${part}_object_key`] = sample[`${part}Key`]; row[`${part}_object_state`] = 'active';
      files.push({ name:`${sample[`${part}Key`]}.blob`, data:part === 'source' ? source : derivative,
        manifest:{ type, size:sample[`${part}Size`], sha256:sample[`${part}Sha256`] } });
    }
    samples.push(sample); rows.push(row);
  }
  return { samples, rows, files };
}
function fakeDatabase(f) {
  const calls = [];
  return { calls, async transaction(work) {
    calls.push('transaction');
    return work({ async query(sql, params) {
      calls.push({ sql, params });
      if (calls.length === 2) { assert.equal(sql, 'SET TRANSACTION READ ONLY'); assert.equal(params, undefined); return { rows:[] }; }
      assert.equal(calls.length, 3);
      assert.match(sql, /WHERE u\.state='bound' AND u\.id=ANY\(\$1::text\[\]\) ORDER BY u\.id$/);
      for (const [alias, table, key] of [['p', 'cb_media_preparations', 'preparation_id'], ['s', 'cb_media_objects', 'object_key'], ['d', 'cb_media_objects', 'candidate_key']]) {
        assert.ok(sql.includes(`JOIN ${table} ${alias} ON (${alias}.center_id,${alias}.conversation_id,${alias}.upload_id,${alias}.${alias === 'p' ? 'id' : 'key'})=`));
        assert.ok(sql.includes(`(u.center_id,u.conversation_id,u.id,u.${key})`));
      }
      assert.deepEqual(params, [f.samples.map(sample => sample.uploadId)]);
      return { rows:[...f.rows].reverse() };
    } });
  } };
}

test('capture uses one read-only, bound-ID query and returns only copied PNG/video candidates', async () => {
  for (const type of ['video/mp4', 'video/webm']) {
    const f = fixture(type), db = fakeDatabase(f);
    const result = await capturePreparedRecoverySamples(db, f.samples, f.files);
    assert.equal(db.calls.length, 3); assert.equal(result.length, 2);
    for (const [index, candidate] of result.entries()) {
      assert.deepEqual(Object.keys(candidate).sort(), ['bytes', 'object', 'type']);
      assert.equal(candidate.type, f.samples[index].type); assert.equal(candidate.object, f.samples[index].derivativeKey);
      const stored = f.files.find(file => file.name === `${candidate.object}.blob`);
      assert.deepEqual(candidate.bytes, stored.data); assert.notEqual(candidate.bytes, stored.data);
      candidate.bytes.fill(0); assert.notDeepEqual(candidate.bytes, stored.data);
    }
  }
});

test('sample contract rejects absent, extra, duplicate, invalid-UUID and invalid-manifest inputs before SQL', async () => {
  const changes = [
    f => { f.samples = []; }, f => { f.samples.pop(); }, f => { f.samples.push({ ...f.samples[0] }); },
    f => { f.samples[1].type = 'image/png'; }, f => { f.samples[0].type = 'image/jpeg'; },
    f => { f.samples[1].uploadId = f.samples[0].uploadId; },
    f => { f.samples[0].sourceKey = f.samples[0].uploadId; },
    f => { f.samples[1].derivativeKey = f.samples[0].sourceKey; },
    f => { f.samples[0].uploadId = id(1).replace('-4000-', '-1000-'); },
    f => { f.samples[0].sourceSize = 0; }, f => { f.samples[0].derivativeSize = 1.5; },
    f => { f.samples[0].sourceSize = Number.MAX_SAFE_INTEGER + 1; },
    f => { f.samples[0].derivativeSha256 = 'a'.repeat(63); }, f => { f.samples[0].sourceSha256 = 'A'.repeat(64); },
    f => { delete f.samples[0].sourceSha256; }, f => { f.samples[0].unreviewed = true; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f); let opened = false;
    await assert.rejects(capturePreparedRecoverySamples({ transaction() { opened = true; } }, f.samples, f.files), invalid);
    assert.equal(opened, false);
  }
});

test('every selected row field is pinned to its sample, preparation, scope and two active objects', () => {
  const original = fixture();
  for (const column of Object.keys(original.rows[0])) {
    const f = fixture(), value = f.rows[0][column];
    f.rows[0][column] = typeof value === 'boolean' ? false : typeof value === 'number' ? value + 1 : `changed-${value}`;
    assert.throws(() => assertPreparedRecoverySamples(f.rows, f.samples, f.files), invalid, column);
  }
  for (const change of [
    f => { f.rows = []; }, f => { f.rows.pop(); }, f => { f.rows.push({ ...f.rows[0] }); },
    f => { f.rows[1] = { ...f.rows[0] }; }, f => { f.rows[0].upload_id = id(99); },
    f => { f.rows[0].state = 'ready'; }, f => { f.rows[0].source_object_state = 'deleted'; },
    f => { f.rows[0].derivative_object_state = 'delete_pending'; },
    f => { f.rows[0].preparation_id = f.rows[1].preparation_id; f.rows[0].preparation_row_id = f.rows[1].preparation_row_id; },
  ]) {
    const f = fixture(); change(f);
    assert.throws(() => assertPreparedRecoverySamples(f.rows, f.samples, f.files), invalid);
  }
});

test('both original and candidate blobs require exact inventories, manifests, byte lengths and hashes', () => {
  for (let index = 0; index < 4; index++) {
    for (const change of [
      f => { f.files.splice(index, 1); },
      f => { f.files.push({ ...f.files[index] }); },
      f => { f.files.push({ name:f.files[index].name.replace('.blob', '.blocked'), manifest:null, data:Buffer.alloc(0) }); },
      f => { f.files[index].manifest.type = 'image/jpeg'; },
      f => { f.files[index].manifest.size++; },
      f => { f.files[index].manifest.sha256 = 'a'.repeat(64); },
      f => { f.files[index].manifest = null; },
      f => { f.files[index].manifest.extra = true; },
      f => { f.files[index].data = Buffer.concat([f.files[index].data, Buffer.from('x')]); },
      f => { f.files[index].data[0] ^= 1; },
      f => { f.files[index].data = new Uint8Array(f.files[index].data); },
      f => { f.files[index].name = `${id(99)}.blob`; },
    ]) {
      const f = fixture(); change(f);
      assert.throws(() => assertPreparedRecoverySamples(f.rows, f.samples, f.files), invalid);
    }
  }
  for (const files of [null, [], [{ name:'../outside.blob', manifest:null, data:Buffer.alloc(0) }]]) {
    const f = fixture(); assert.throws(() => assertPreparedRecoverySamples(f.rows, f.samples, files), invalid);
  }
});

test('candidate replacement cannot borrow another upload or the original bytes', () => {
  for (const replacement of [0, 3]) {
    const f = fixture(); f.files[1] = { ...f.files[replacement], name:f.files[1].name };
    assert.throws(() => assertPreparedRecoverySamples(f.rows, f.samples, f.files), invalid);
  }
  const f = fixture();
  f.files.push({ name:`${id(99)}.blocked`, manifest:null, data:Buffer.alloc(0) });
  assert.equal(assertPreparedRecoverySamples(f.rows, f.samples, f.files).length, 2);
});

test('capture snapshots sample manifests and propagates transaction failures without fallback evidence', async () => {
  const f = fixture(), expected = f.samples.map(sample => ({ ...sample }));
  const db = { async transaction(work) { return work({ async query(sql, params) {
    if (sql === 'SET TRANSACTION READ ONLY') { f.samples[0].sourceSha256 = 'b'.repeat(64); return { rows:[] }; }
    assert.deepEqual(params, [expected.map(sample => sample.uploadId)]); return { rows:f.rows };
  } }); } };
  assert.equal((await capturePreparedRecoverySamples(db, f.samples, f.files)).length, 2);
  const denied = new Error('SYNTHETIC_READ_ONLY_REJECTED');
  await assert.rejects(capturePreparedRecoverySamples({ async transaction() { throw denied; } }, expected, f.files), error => error === denied);
});
