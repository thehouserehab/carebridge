// Read-only inventory of an ALREADY OWNED, fresh synthetic fixture directory.
// Not an operating backup tool, private-root initializer or arbitrary importer.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
const hash = (data) => createHash('sha256').update(data).digest('hex');
export async function captureSyntheticMedia(db,store) {
  const {rows} = await db.transaction((tx) => tx.query(`SELECT o.key,o.state,u.object_key,u.candidate_key,u.type,u.size,u.sha256,
    u.prepared_size,u.prepared_sha256 FROM cb_media_objects o JOIN cb_media_uploads u
    ON (o.center_id,o.conversation_id,o.upload_id)=(u.center_id,u.conversation_id,u.id)`));
  const ledger = new Map(rows.map((row) => [row.key,row])),files = [];
  const names = (await readdir(store.root)).sort(),inventory = new Set(names);
  for (const name of names) {
    assert.match(name,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:blob|blocked)$/);
    const path = join(store.root,name),info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
    const data = await readFile(path),key = name.slice(0,36); let manifest = null;
    if (name.endsWith('.blob')) {
      assert.ok(!inventory.has(`${key}.blocked`));
      const row = ledger.get(key); assert.ok(row && row.state === 'active');
      const derivative = key === row.candidate_key; assert.ok(derivative || key === row.object_key);
      manifest = {type:row.type,size:derivative ? row.prepared_size : row.size,sha256:derivative ? row.prepared_sha256 : row.sha256};
      assert.equal(data.length,manifest.size); assert.equal(hash(data),manifest.sha256);
    } else assert.equal(data.length,0);
    files.push({name,manifest,data});
  }
  for (const row of rows) {
    assert.ok(['active','deleted'].includes(row.state));
    assert.ok(inventory.has(`${row.key}.${row.state === 'active' ? 'blob' : 'blocked'}`));
  }
  return files;
}
