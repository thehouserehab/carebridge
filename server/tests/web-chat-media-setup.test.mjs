import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {newWebChatDemo,setupWebChatDemo} from '../web-chat-setup.mjs';
import {setupWebChatMedia,inspectWebChatMedia,webChatMediaPrivileges} from '../web-chat-media-setup.mjs';

test('additive installation preserves public migrations, accounts and messages, and is an inspected no-op on retry',async()=>{
  const db=await PGlite.create();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    const demo=newWebChatDemo();await setupWebChatDemo(db,demo);
    const snapshot=async()=>{
      const result={};for(const table of ['cb_schema_migrations','cb_auth_accounts','cb_messages','cb_users','cb_memberships','cb_participants']) {
        result[table]=(await db.query(`SELECT md5(COALESCE(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text),'')) AS hash FROM public.${table} t`)).rows[0].hash;
      }return result;
    };
    const before=await snapshot(),input={centerId:demo.centerId,runtimeRole:demo.role};
    const first=await setupWebChatMedia(db,input);assert.equal(first.installed,true);assert.equal(first.security.passed,true);
    assert.deepEqual(await snapshot(),before);
    const second=await setupWebChatMedia(db,input);assert.equal(second.installed,false);assert.deepEqual(await snapshot(),before);
    assert.equal((await inspectWebChatMedia(db,input)).passed,true);
    await db.exec(`GRANT UPDATE (type) ON carebridge_web.attachments TO "${demo.role}"`);
    assert.equal((await inspectWebChatMedia(db,input)).passed,false);
    await db.exec(`REVOKE UPDATE (type) ON carebridge_web.attachments FROM "${demo.role}"`);
    await db.exec('GRANT INSERT (id) ON carebridge_web.attachments TO anon');
    assert.equal((await inspectWebChatMedia(db,input)).passed,false);
    await db.exec('REVOKE INSERT (id) ON carebridge_web.attachments FROM anon');
    assert.equal((await inspectWebChatMedia(db,input)).passed,true);
    await db.exec("UPDATE carebridge_web.schema_version SET checksum=repeat('0',64)");
    await assert.rejects(setupWebChatMedia(db,input),/WEB_CHAT_MEDIA_SETUP_UNAVAILABLE/);
  } finally {await db.close();}
});

test('invalid scope and an unknown existing schema never get overwritten',async()=>{
  assert.throws(()=>webChatMediaPrivileges('postgres; DROP SCHEMA public'),/WEB_CHAT_MEDIA_SETUP_UNAVAILABLE/);
  const db=await PGlite.create();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    const demo=newWebChatDemo();await setupWebChatDemo(db,demo);
    await db.exec('CREATE SCHEMA carebridge_web; CREATE TABLE carebridge_web.unrelated(id integer); INSERT INTO carebridge_web.unrelated VALUES(7);');
    await assert.rejects(setupWebChatMedia(db,{centerId:demo.centerId,runtimeRole:demo.role}));
    assert.equal((await db.query('SELECT id FROM carebridge_web.unrelated')).rows[0].id,7);
    assert.equal((await db.query("SELECT count(*) AS n FROM pg_tables WHERE schemaname='carebridge_web'")).rows[0].n,1);
  } finally {await db.close();}
});
