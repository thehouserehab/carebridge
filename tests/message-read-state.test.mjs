import assert from "node:assert/strict";
import { test } from "node:test";
import { seed } from "../src/seed.js";
import { upgradeState, conversationView } from "../src/conversations.js";
import { mutate, validateState } from "../src/domain.js";

const therapist = { id: "t1", role: "therapist" };
const guardian = { id: "p1", role: "guardian" };
const peer = { id: "p2", role: "guardian" };
const manager = { id: "m1", role: "center" };
const at = "2026-10-08T00:00:00.000Z";
const later = "2026-10-08T01:00:00.000Z";
const start = () => upgradeState(seed());
const send = (db, actor = therapist) => mutate(db, actor, "message", {
  childId: "c1", clientId: crypto.randomUUID(), body: "합성 읽음 확인 소식",
}, at);
const read = (db, actor, id) => mutate(db, actor, "read", { childId: "c1", id }, later);
const connect = (db, guardianIds, extra = {}) => mutate(db, manager, "relationships", {
  childId: "c1", therapistId: "t1", guardianIds, historyConfirmed: true, ...extra,
}, later);
const view = (db, actor, id) => conversationView(db, actor, "c1").messages.find((m) => m.id === id);
const remove = (db, actor, id, scope) => mutate(db, actor, "message-delete", {
  childId: "c1", id, scope, confirmed: true, clientId: crypto.randomUUID(), expectedVersion: 1,
}, later);

test("adding a future-only participant cannot turn already read older news back into unread", () => {
  let db = send(start());
  const id = db.messages.at(-1).id;
  db = read(db, guardian, id);
  assert.equal(view(db, therapist, id).read, true);
  const cursors = structuredClone(db.readStates);
  db = connect(db, [guardian.id, peer.id]);
  assert.equal(view(db, peer, id), undefined);
  assert.equal(view(db, therapist, id).read, true);
  assert.equal(conversationView(db, peer, "c1").unread, 0);
  assert.deepEqual(db.readStates, cursors);
  assert.equal(validateState(db), true);
});

test("later news still waits for every eligible recipient without changing individual unread counts", () => {
  let db = connect(start(), [guardian.id, peer.id]);
  db = send(db);
  const id = db.messages.at(-1).id;
  db = read(db, guardian, id);
  assert.equal(view(db, therapist, id).read, false);
  assert.equal(conversationView(db, guardian, "c1").unread, 0);
  assert.equal(conversationView(db, peer, "c1").unread, 1);
  db = read(db, peer, id);
  assert.equal(view(db, therapist, id).read, true);
  assert.equal(conversationView(db, peer, "c1").unread, 0);
  assert.equal(validateState(db), true);
});

test("explicit past-history sharing adds the new recipient to older news until it is read", () => {
  let db = send(start());
  const id = db.messages.at(-1).id;
  db = read(db, guardian, id);
  db = connect(db, [guardian.id, peer.id]);
  assert.equal(view(db, therapist, id).read, true);
  db = connect(db, [guardian.id, peer.id], {
    historyChoices: { p2: "all" }, pastHistoryConfirmed: true,
  });
  assert.ok(view(db, peer, id));
  assert.equal(view(db, therapist, id).read, false);
  db = read(db, peer, id);
  assert.equal(view(db, therapist, id).read, true);
  assert.equal(validateState(db), true);
});

test("feedback excludes a future-only peer who cannot read its older source publication", () => {
  let db = connect(start(), [guardian.id, peer.id]);
  db = mutate(db, guardian, "feedback", {
    childId: "c1", publicationId: "pub1", date: "2026-10-08", result: "done", reaction: "합성 활동 경험",
  }, later);
  const id = db.messages.at(-1).id;
  assert.equal(db.messages.at(-1).type, "feedback");
  assert.equal(view(db, peer, id), undefined);
  assert.equal(view(db, guardian, id).read, false);
  db = read(db, therapist, id);
  assert.equal(view(db, guardian, id).read, true);
  assert.equal(conversationView(db, peer, "c1").unread, 0);
  assert.equal(validateState(db), true);
});

test("no eligible other participant remains unread after removal or future-only reconnection", () => {
  let db = send(start());
  const id = db.messages.at(-1).id;
  db = read(db, guardian, id);
  assert.equal(view(db, therapist, id).read, true);
  db = connect(db, []);
  assert.equal(view(db, therapist, id).read, false);
  db = connect(db, [guardian.id]);
  assert.equal(view(db, guardian, id), undefined);
  assert.equal(view(db, therapist, id).read, false);
  assert.equal(validateState(db), true);
});

test("self-hiding does not manufacture a read receipt and all-delete keeps existing unread policy", () => {
  let db = send(start());
  const id = db.messages.at(-1).id;
  const unread = conversationView(db, guardian, "c1").unread;
  db = remove(db, guardian, id, "self");
  assert.equal(view(db, guardian, id), undefined);
  assert.equal(view(db, therapist, id).read, false);
  assert.equal(conversationView(db, guardian, "c1").unread, unread - 1);
  db = remove(db, therapist, id, "all");
  assert.equal(view(db, therapist, id).deleted, true);
  assert.equal(view(db, therapist, id).read, false);
  assert.equal(conversationView(db, guardian, "c1").unread, unread - 1);
  assert.equal(validateState(db), true);

  const original = send(start());
  const nextId = original.messages.at(-1).id;
  const nextUnread = conversationView(original, guardian, "c1").unread;
  const deleted = remove(original, therapist, nextId, "all");
  assert.equal(view(deleted, guardian, nextId).deleted, true);
  assert.equal(view(deleted, therapist, nextId).read, false);
  assert.equal(conversationView(deleted, guardian, "c1").unread, nextUnread - 1);
  assert.equal(validateState(deleted), true);
});
