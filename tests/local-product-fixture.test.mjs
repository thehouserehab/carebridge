import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { waitForProductReadingFixture } from './local-product-browser.mjs';

// DOM doubles exercise the actual serialized browser predicate, not a copy.
// No browser, HTTP, database, credentials or application state is created.
const roomId = 'synthetic-room';
const messageIds = ['fixture-1', 'fixture-2', 'fixture-3', 'fixture-4'];
function documentFor({ rows = messageIds, actionIds = [], selected = [roomId], chat = true,
  visible = true, hasList = true } = {}) {
  const list = {
    getClientRects: () => visible ? [{}] : [],
    querySelectorAll(selector) {
      assert.equal(selector, '[data-testid="message-row"][data-message-id]');
      // Nested actions may have the same data-message-id but are not rows.
      return [...rows.map((id) => ({ row: true, dataset: { messageId: id } })),
        ...actionIds.map((id) => ({ row: false, dataset: { messageId: id } }))]
        .filter((node) => node.row);
    },
  };
  return {
    querySelector(selector) {
      assert.equal(selector, '[data-testid="room"] [data-testid="message-list"]');
      return hasList ? list : null;
    },
    querySelectorAll(selector) {
      if (selector === 'button[data-view="chat"][aria-current="page"]')
        return [{ getClientRects: () => [] }, { getClientRects: () => chat ? [{}] : [] }];
      assert.equal(selector, '[data-testid="inbox"] [data-room-id][aria-current="true"]');
      return selected.map((id) => ({ dataset: { roomId: id } }));
    },
  };
}
function harness(frames, { jsonFailure } = {}) {
  const timeout = Object.assign(new Error('synthetic readiness timeout'), { name: 'TimeoutError' });
  let disposed = false, observations = 0;
  const page = {
    async waitForFunction(predicate, expected, options) {
      assert.deepEqual(expected, { roomId, messageIds });
      assert.deepEqual(options, { timeout: 15_000 });
      for (const frame of frames) {
        observations++;
        const value = runInNewContext(`(${predicate.toString()})(expected)`,
          { document: documentFor(frame), expected });
        if (value) return {
          jsonValue: async () => { if (jsonFailure) throw jsonFailure; return structuredClone(value); },
          dispose: async () => { disposed = true; },
        };
      }
      throw timeout;
    },
  };
  return { page, timeout, state: () => ({ disposed, observations }) };
}

test('reading setup waits for all four exact rows in one current-room DOM snapshot', async () => {
  const h = harness([{ rows: messageIds.slice(0, 2) }, { rows: messageIds.slice(2) },
    { rows: ['unrelated', ...messageIds] }]);
  assert.deepEqual(await waitForProductReadingFixture(h.page, roomId, messageIds),
    { expected: 4, received: 4, rowCount: 5 });
  assert.deepEqual(h.state(), { disposed: true, observations: 3 });
});

for (const [name, frame] of Object.entries({
  'wrong room': { selected: ['other-room'] },
  'ambiguous selection': { selected: [roomId, 'other-room'] },
  'no selected room': { selected: [] },
  'inactive chat': { chat: false },
  'hidden timeline': { visible: false },
  'absent timeline': { hasList: false },
  'duplicate row': { rows: [...messageIds, messageIds[0]] },
  'same count but wrong ID': { rows: [...messageIds.slice(0, 3), 'other'] },
  'missing row present only as menu action': { rows: messageIds.slice(0, 3), actionIds: [messageIds[3]] },
})) test(`reading setup rejects ${name} and propagates the bounded wait failure`, async () => {
  const h = harness([frame]);
  await assert.rejects(waitForProductReadingFixture(h.page, roomId, messageIds), (error) => error === h.timeout);
  assert.deepEqual(h.state(), { disposed: false, observations: 1 });
});

test('invalid or repeated fixture IDs fail before requesting any browser action', async () => {
  for (const ids of [[], messageIds.slice(0, 3), [...messageIds.slice(0, 3), ''],
    [...messageIds.slice(0, 3), messageIds[0]]]) {
    const h = harness([]);
    await assert.rejects(waitForProductReadingFixture(h.page, roomId, ids), /LOCAL_PRODUCT_READING_FIXTURE_IDS/);
    assert.equal(h.state().observations, 0);
  }
});

test('readiness handle is disposed even if observation serialization fails', async () => {
  const failure = new Error('synthetic serialization failure');
  const h = harness([{}], { jsonFailure: failure });
  await assert.rejects(waitForProductReadingFixture(h.page, roomId, messageIds), (error) => error === failure);
  assert.equal(h.state().disposed, true);
});
