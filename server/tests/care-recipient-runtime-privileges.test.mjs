// Real SQL grants in a fresh embedded PostgreSQL database. This verifies the
// feature's SQL under runtime privileges, not native service admission or TLS.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { Auth } from '../auth.mjs';
import { CareRecipientLinks } from '../care-recipient-links.mjs';
import { PrimaryCommunicators } from '../primary-communicators.mjs';
import { Conversations } from '../conversations.mjs';
import { Children } from '../profiles.mjs';
import { DATABASE_TABLES, DATABASE_FUNCTIONS, DATABASE_SEQUENCES, RUNTIME_HELPERS,
  expectedTablePrivileges, expectedColumnPrivileges, expectedFunctionExecution } from '../database-privilege-policy.mjs';

const manager = { centerId: 'synthetic-runtime-center', userId: 'synthetic-manager' };
const roomId = 'synthetic-runtime-room';
let db, runtime, auth, links, primary, subject;
before(async () => {
  db = await PGlite.create(); await migrate(db);
  await db.exec(`INSERT INTO cb_centers(id) VALUES ('synthetic-runtime-center');
    INSERT INTO cb_users(id,active) VALUES ('synthetic-manager',true),('synthetic-guardian',true);
    INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES
      ('synthetic-runtime-center','synthetic-manager','center',true),
      ('synthetic-runtime-center','synthetic-guardian','guardian',true);
    INSERT INTO cb_children(center_id,id) VALUES ('synthetic-runtime-center','synthetic-runtime-child');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES
      ('synthetic-runtime-center','synthetic-runtime-room','synthetic-runtime-child');
    INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence) VALUES
      ('synthetic-runtime-center','synthetic-runtime-room','synthetic-guardian','guardian',true,1);
    CREATE ROLE synthetic_recipient_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO synthetic_recipient_runtime;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;`);
  for (const table of DATABASE_TABLES) {
    const privileges = expectedTablePrivileges('runtime', table);
    if (privileges.length) await db.exec(`GRANT ${privileges.join(',')} ON public.${table} TO synthetic_recipient_runtime`);
    for (const permission of ['SELECT','INSERT','UPDATE','REFERENCES']) {
      const columns = expectedColumnPrivileges('runtime',table,permission);
      if (columns.length) await db.exec(`GRANT ${permission} (${columns.join(',')}) ON public.${table} TO synthetic_recipient_runtime`);
    }
  }
  for (const name of DATABASE_SEQUENCES) await db.exec(`GRANT USAGE ON SEQUENCE public.${name} TO synthetic_recipient_runtime`);
  for (const name of DATABASE_FUNCTIONS) if (expectedFunctionExecution('runtime',name))
    await db.exec(`GRANT EXECUTE ON FUNCTION public.${name}(${RUNTIME_HELPERS[name]}) TO synthetic_recipient_runtime`);
  runtime = { transaction: work => db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE synthetic_recipient_runtime');
    assert.equal((await tx.query('SELECT current_user AS role')).rows[0].role,'synthetic_recipient_runtime');
    return work(tx);
  }) };
  auth = new Auth(runtime, { password: { N:1024,r:8,p:1,maxmem:32*1024**2 } });
  links = new CareRecipientLinks(runtime); primary = new PrimaryCommunicators(runtime);
});
after(async () => { await db?.close(); });

test('ordinary runtime executes invitation, explicit link, text and primary metadata with reviewed grants', async () => {
  const invited = await auth.createInvitation(manager,{ centerId:manager.centerId,email:'recipient@synthetic-runtime.test',role:'care_recipient' });
  const accepted = await auth.acceptInvitation({ token:invited.token,password:'Synthetic runtime password 2026!' });
  subject = { centerId:manager.centerId,userId:accepted.user.userId };
  const state = await links.get(manager,{conversationId:roomId});
  await links.connect(manager,{conversationId:roomId,userId:subject.userId,expectedVersion:state.version,clientId:randomUUID()});
  const message = await new Conversations(runtime).sendText(subject,{conversationId:roomId,clientId:randomUUID(),body:'가상 대상자의 질문'});
  assert.equal((await new Conversations(runtime).get(subject,{conversationId:roomId,messageId:message.id})).body,'가상 대상자의 질문');
  const selected = await primary.get(manager,{conversationId:roomId});
  await primary.save(manager,{conversationId:roomId,userId:subject.userId,expectedRevision:selected.revision,clientId:randomUUID()});
  assert.equal((await primary.get(subject,{conversationId:roomId})).userId,subject.userId);
  assert.equal((await new Children(runtime).get(subject,{conversationId:roomId})).childId,'synthetic-runtime-child');
});

test('runtime cannot rewrite stable identity, receipts, membership roles or account qualification generations', async () => {
  for (const sql of [
    'UPDATE cb_care_recipient_links SET user_id=user_id WHERE false',
    'DELETE FROM cb_care_recipient_links WHERE false',
    'UPDATE cb_primary_communicator_requests SET request_hash=request_hash WHERE false',
    'TRUNCATE cb_primary_communicators',
    'UPDATE cb_memberships SET role=role WHERE false',
    'UPDATE cb_users SET communication_generation=communication_generation WHERE false',
    'UPDATE cb_memberships SET communication_generation=communication_generation WHERE false',
    'SELECT cb_communication_qualification_generation()',
  ]) await assert.rejects(runtime.transaction(tx=>tx.exec(sql)),{code:'42501'});
});

test('runtime disconnect and reconnect do not revive primary designation and require a new explicit save', async () => {
  const state = await links.get(manager,{conversationId:roomId});
  await links.disconnect(manager,{conversationId:roomId,userId:subject.userId,expectedVersion:state.version,clientId:randomUUID()});
  const disconnected = await links.get(manager,{conversationId:roomId});
  await links.connect(manager,{conversationId:roomId,userId:subject.userId,expectedVersion:disconnected.version,clientId:randomUUID()});
  const stale = await primary.get(manager,{conversationId:roomId});
  assert.equal(stale.userId,null);
  await primary.save(manager,{conversationId:roomId,userId:subject.userId,expectedRevision:stale.revision,clientId:randomUUID()});
  assert.equal((await primary.get(subject,{conversationId:roomId})).userId,subject.userId);
});
