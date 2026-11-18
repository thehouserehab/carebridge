import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { newWebChatDemo, setupWebChatDemo, webChatPrivilegeStatements, inspectWebChatDatabase } from '../web-chat-setup.mjs';
import { Auth } from '../auth.mjs';
import { Conversations } from '../conversations.mjs';

test('demo setup grants only the reviewed runtime privileges and rejects injected role names', () => {
  const demo = newWebChatDemo(), other = newWebChatDemo();
  assert.notEqual(demo.role, other.role);
  assert.notEqual(demo.databasePassword, other.databasePassword);
  const statements = webChatPrivilegeStatements(demo.role);
  assert(statements.some(sql => sql.includes('ENABLE ROW LEVEL SECURITY')));
  assert(!statements.some(sql => /^GRANT (ALL|CREATE|TRUNCATE)/.test(sql)));
  assert(!statements.some(sql => /^GRANT .* TO (PUBLIC|anon|authenticated)/.test(sql)));
  assert.throws(() => webChatPrivilegeStatements('postgres; DROP SCHEMA public'), /WEB_CHAT_SETUP_UNAVAILABLE/);
});

test('fresh SQL demo keeps API identities out and persists sessions and idempotent messages across service instances', async () => {
  const db = await PGlite.create();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    const demo = newWebChatDemo(), receipt = await setupWebChatDemo(db, demo);
    assert.equal(receipt.appliedMigrations, 23);
    assert.equal(receipt.security.passed, true);
    assert(!JSON.stringify(receipt).includes(demo.databasePassword));
    assert(demo.accounts.every(account => !JSON.stringify(receipt).includes(account.password)));
    const runtime = { transaction: work => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE "${demo.role}"`); return work(tx);
    }) };
    const auth = new Auth(runtime, { sessionTtlSeconds: 3600 });
    const login = await auth.login(demo.accounts[0]);
    const resumed = await new Auth(runtime, { sessionTtlSeconds: 3600 }).authenticate(login.token);
    assert.equal(resumed.userId, demo.accounts[0].userId);
    const input = { conversationId: demo.roomId, clientId: randomUUID(), body: '가상 연결 확인' };
    const actor = { centerId: demo.centerId, userId: resumed.userId };
    const sent = await new Conversations(runtime).sendText(actor, input);
    const replay = await new Conversations(runtime).sendText(actor, input);
    assert.equal(sent.id, replay.id);
    const guardian = { centerId: demo.centerId, userId: demo.accounts[1].userId };
    const page = await new Conversations(runtime).list(guardian, { conversationId: demo.roomId, limit: 50 });
    assert(page.messages.some(value => value.id === sent.id));
    await assert.rejects(() => new Conversations(runtime).list({ ...guardian, userId: 'unassigned-user' }, { conversationId: demo.roomId }), error => error.code === 'NOT_FOUND');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await assert.rejects(() => db.transaction(async tx => {
        await tx.exec(`SET LOCAL ROLE ${role}`); await tx.query('SELECT * FROM cb_messages');
      }), error => error.code === '42501');
    }
    await assert.rejects(() => runtime.transaction(tx => tx.exec('TRUNCATE cb_messages')), error => error.code === '42501');
    assert.equal((await inspectWebChatDatabase(db, demo.role)).passed, true);
    await assert.rejects(() => setupWebChatDemo(db, newWebChatDemo()), /WEB_CHAT_SETUP_UNAVAILABLE/);
    assert.equal((await new Auth(runtime).authenticate(login.token)).userId, actor.userId);
  } finally { await db.close(); }
});

test('a database containing a different application table is rejected without modifying it', async () => {
  const db = await PGlite.create();
  try {
    await db.exec('CREATE TABLE unrelated_application(id integer); INSERT INTO unrelated_application VALUES(7)');
    await assert.rejects(() => setupWebChatDemo(db, newWebChatDemo()), /WEB_CHAT_SETUP_UNAVAILABLE/);
    assert.equal((await db.query('SELECT id FROM unrelated_application')).rows[0].id, 7);
    assert.equal((await db.query("SELECT 1 FROM pg_class WHERE relname='cb_centers'")).rows.length, 0);
  } finally { await db.close(); }
});
