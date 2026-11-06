import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readdir,lstat,unlink,rmdir,link,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,basename} from 'node:path';
import {captureSyntheticMedia} from '../windows-postgres-media-fixture.mjs';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const source = Buffer.from('synthetic-source'),derivative = Buffer.from('synthetic-derivative');
const row = (key,data = source,extra = {}) => ({key,state:'active',object_key:key,candidate_key:null,type:'image/png',size:data.length,
  sha256:hash(data),prepared_size:null,prepared_sha256:null,...extra});
async function fixture(rows,files,work) {
  const root = await mkdtemp(join(tmpdir(),'carebridge-media-inventory-'));
  const db = {transaction:(callback) => callback({query:async () => ({rows})})};
  try {
    for (const [name,data] of Object.entries(files)) await writeFile(join(root,name),data,{flag:'wx'});
    return await work({root,capture:() => captureSyntheticMedia(db,{root})});
  } finally {
    const target = resolve(root),rel = relative(resolve(tmpdir()),target);
    assert.ok(rel && !isAbsolute(rel) && !rel.startsWith('..') && basename(target).startsWith('carebridge-media-inventory-'));
    // Only direct fixture files and deliberately empty test directories. No
    // recursive delete or adoption of external/unknown directory contents.
    for (const name of await readdir(root)) {
      const path = join(root,name),info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) await rmdir(path); else await unlink(path);
    }
    await rmdir(root);
  }
}
test('synthetic inventory captures every ledger original/derivative and deleted/standalone fence',async () => {
  const a = randomUUID(),b = randomUUID(),c = randomUUID(),d = randomUUID();
  const rows = [row(a,source,{candidate_key:b,prepared_size:derivative.length,prepared_sha256:hash(derivative)}),
    row(b,source,{object_key:a,candidate_key:b,prepared_size:derivative.length,prepared_sha256:hash(derivative)}),row(c,source,{state:'deleted'})];
  await fixture(rows,{[a+'.blob']:source,[b+'.blob']:derivative,[c+'.blocked']:Buffer.alloc(0),[d+'.blocked']:Buffer.alloc(0)},async ({capture}) => {
    const files = await capture(); assert.equal(files.length,4); assert.equal(files.filter((file) => file.manifest).length,2);
    assert.deepEqual(files.find((file) => file.name === b+'.blob').manifest,{type:'image/png',size:derivative.length,sha256:hash(derivative)});
    assert.deepEqual(files.find((file) => file.name === a+'.blob').data,source);
  });
});
test('missing active originals/derivatives or deleted fences cannot produce a complete fixture inventory',async () => {
  const a = randomUUID(),b = randomUUID();
  for (const rows of [[row(a),row(b,source,{object_key:a,candidate_key:b,prepared_size:derivative.length,prepared_sha256:hash(derivative)})],
    [row(a),row(b,source,{state:'deleted'})]])
    await fixture(rows,{[a+'.blob']:source},async ({capture}) => {
      await assert.rejects(capture);
    });
  await fixture([row(a)],{},async ({capture}) => assert.rejects(capture));
});
test('wrong byte hash/size, unproven candidate, nonempty fence, orphan blob and unknown state are refused',async () => {
  const a = randomUUID(),b = randomUUID();
  const cases = [
    {rows:[row(a)],files:{[a+'.blob']:Buffer.from('wrong-source')}},
    {rows:[row(a)],files:{[a+'.blob']:Buffer.alloc(source.length,120)}},
    {rows:[row(a,source,{size:source.length+1})],files:{[a+'.blob']:source}},
    {rows:[row(a,source,{object_key:b,candidate_key:a})],files:{[a+'.blob']:source}},
    {rows:[row(a,source,{state:'deleted'})],files:{[a+'.blocked']:source}},
    {rows:[],files:{[a+'.blob']:source}},
    {rows:[row(a,source,{state:'delete_pending'})],files:{[a+'.blocked']:Buffer.alloc(0)}},
    {rows:[row(a)],files:{[a+'.blob']:source,[a+'.blocked']:Buffer.alloc(0)}},
  ];
  for (const data of cases) await fixture(data.rows,data.files,async ({capture}) => assert.rejects(capture));
});
test('partial/arbitrary names, directories and hard-linked fixture files are not silently included',async () => {
  const a = randomUUID(),b = randomUUID();
  await fixture([],{unexpected:source},async ({capture}) => assert.rejects(capture));
  await fixture([],{},async ({root,capture}) => { await mkdir(join(root,a+'.blob')); await assert.rejects(capture); });
  await fixture([row(a)],{[a+'.blob']:source},async ({root,capture}) => {
    await link(join(root,a+'.blob'),join(root,b+'.blob')); await assert.rejects(capture);
  });
});
