import assert from "node:assert/strict";
import test from "node:test";
import { seed } from "../src/seed.js";
import { mutate, validateState } from "../src/domain.js";
import { upgradeState, conversationView, conversationList } from "../src/conversations.js";
import { messagePreview } from "../src/message-preview.js";
import { messageVersion } from "../src/message-lifecycle.js";
import { communicationHome } from "../src/home-ui.js";
import { conversationRows, chatScreen } from "../src/chat-ui.js";
import { ChatController } from "../src/chat-controller.js";

// Synthetic metadata only. These tests do not open a browser, read files,
// authenticate users, or create media bytes or external resources.
const therapist = { id: "t1", role: "therapist" };
const guardian = { id: "p1", role: "guardian" };
const manager = { id: "m1", role: "center" };
const peer = { id: "p2", role: "guardian" };
const at = "2026-10-08T00:00:00.000Z", later = "2026-10-08T01:00:00.000Z";
const start = () => upgradeState(seed());
const photo = (id = "preview-photo-01") => ({ id, name: "SYNTHETIC_PRIVATE_PHOTO.png", type: "image/png", size: 42, share: true });
const video = (id = "preview-video-01") => ({ id, name: "SYNTHETIC_PRIVATE_VIDEO.webm", type: "video/webm", size: 84, share: true });
const send = (db, actor = guardian, extra = {}) => mutate(db, actor, "message", {
  childId: "c1", clientId: crypto.randomUUID(), body: "", attachments: [photo()], ...extra,
}, at);
const edit = (db, id, body) => mutate(db, guardian, "message-edit", {
  childId: "c1", id, body, clientId: crypto.randomUUID(),
  expectedVersion: messageVersion(db.messages.find((message) => message.id === id)),
}, later);
const remove = (db, actor, id, scope) => mutate(db, actor, "message-delete", {
  childId: "c1", id, scope, confirmed: true, clientId: crypto.randomUUID(),
  expectedVersion: messageVersion(db.messages.find((message) => message.id === id)),
}, later);
const row = (db, actor, id) => conversationView(db, actor, "c1").messages.find((message) => message.id === id);
function composer(db, actor, replyTo, expectedReplyVersion) {
  const slot = { innerHTML: "" };
  ChatController.prototype.quote.call({
    form: { querySelector(selector) { assert.equal(selector, "#reply-preview"); return slot; } },
    draft: { replyTo, ...(expectedReplyVersion === undefined ? {} : { expectedReplyVersion }) },
    context: { actor, childId: "c1" }, getState: () => ({ db }),
  });
  return slot.innerHTML;
}
function quoteHtml(db, actor, id) {
  const html = chatScreen(db, actor, "c1", true);
  const card = html.match(new RegExp(`<article id="message-${id}"[\\s\\S]*?</article>`));
  assert.ok(card, "the independent reply remains visible");
  const quote = card[0].match(/class="message-quote"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(quote, "the reply has an identifiable original-message button");
  return quote[1];
}
function homeRow(html) {
  const found = html.match(/<button[^>]*class="conversation-row[^\"]*"[^>]*data-id="c1"[\s\S]*?<\/button>/);
  assert.ok(found);
  return found[0];
}

test("attachment preview distinguishes an empty room from a present empty message and preserves authored text", () => {
  assert.equal(messagePreview(null), "첫 소식을 남겨 보세요.");
  assert.equal(messagePreview(undefined), "첫 소식을 남겨 보세요.");
  assert.equal(messagePreview({ body: "", attachments: [] }), "소식이 도착했어요.");
  assert.equal(messagePreview({ body: " \n\t ", attachments: [photo()] }), "사진 1장");
  const body = "  합성 본문 <표현> & 그대로  ";
  assert.equal(messagePreview({ body, attachments: [photo(), video()] }), body);
});

test("visible photo, video, mixed and unknown metadata receive short counts without filenames or mutation", () => {
  const cases = [
    [[photo()], "사진 1장"],
    [[photo(), photo("preview-photo-02")], "사진 2장"],
    [[video()], "동영상 1개"],
    [[video(), video("preview-video-02")], "동영상 2개"],
    [[video(), photo(), photo("preview-photo-02")], "사진 2장 · 동영상 1개"],
    [[{ type: "application/octet-stream", name: "SYNTHETIC_UNKNOWN.bin" }], "첨부파일 1개"],
  ];
  for (const [attachments, expected] of cases) {
    const message = { body: "", attachments }, before = structuredClone(message);
    assert.equal(messagePreview(message), expected);
    assert.doesNotMatch(messagePreview(message), /SYNTHETIC_|preview-photo|preview-video/);
    assert.deepEqual(message, before);
  }
});

test("hidden and deleted projections keep redaction text and never reveal attachment counts", () => {
  for (const state of [{ hidden: true }, { deleted: true }]) {
    assert.equal(messagePreview({ ...state, body: "열람 범위 밖의 대화입니다.", attachments: [photo(), video()] }), "열람 범위 밖의 대화입니다.");
    assert.equal(messagePreview({ ...state, body: "", attachments: [photo(), video()] }), "열람할 수 없는 소식입니다.");
    assert.equal(messagePreview({ ...state, body: " \t", attachments: [photo()] }), "열람할 수 없는 소식입니다.");
  }
});

test("home and conversation rows summarize attachment-only news without altering its target, unread or stored body", () => {
  const db = send(start(), guardian, { attachments: [photo(), video()] });
  const id = db.messages.at(-1).id, before = structuredClone(db);
  const room = conversationList(db, therapist).find((entry) => entry.childId === "c1");
  assert.equal(room.targetId, id); assert.equal(room.latest.body, "");
  const html = communicationHome(db, therapist, { heading: (title) => `<h2>${title}</h2>`, appointmentRows: () => "" });
  for (const content of [homeRow(html), homeRow(conversationRows(db, therapist))]) {
    assert.match(content, /사진 1장 · 동영상 1개/);
    assert.ok(content.includes(`data-message="${id}"`));
    assert.doesNotMatch(content, /첫 소식을 남겨|SYNTHETIC_PRIVATE|media-preview|<img|<video/);
  }
  assert.equal(conversationView(db, therapist, "c1").unread, room.unread);
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});

test("body text still wins and is escaped in home, compose preview and the sent quote", () => {
  const body = '<img src=x onerror="synthetic()"> & 합성 본문';
  let db = send(start(), guardian, { body }); const sourceId = db.messages.at(-1).id;
  const home = homeRow(conversationRows(db, therapist));
  const composing = composer(db, therapist, sourceId, 1);
  db = send(db, therapist, { body: "합성 답변", attachments: [], replyTo: sourceId, expectedReplyVersion: 1 });
  const replyId = db.messages.at(-1).id, before = structuredClone(db);
  for (const html of [home, composing, quoteHtml(db, therapist, replyId)]) {
    assert.match(html, /&lt;img/); assert.match(html, /&amp;/);
    assert.doesNotMatch(html, /<img|사진 1장|SYNTHETIC_PRIVATE_PHOTO/);
  }
  assert.equal(row(db, therapist, replyId).quote.body, body);
  assert.equal(row(db, therapist, replyId).quote.preview, body);
  assert.deepEqual(db, before);
});

test("compose and sent quotes identify an attachment-only original while its body stays empty", () => {
  let db = send(start(), guardian, { attachments: [photo(), video()] });
  const sourceId = db.messages.at(-1).id;
  assert.match(composer(db, therapist, sourceId, 1), /답변할 소식 · 사진 1장 · 동영상 1개/);
  db = send(db, therapist, { body: "합성 첨부 답변", attachments: [], replyTo: sourceId, expectedReplyVersion: 1 });
  const replyId = db.messages.at(-1).id, before = structuredClone(db);
  const quote = row(db, therapist, replyId).quote;
  assert.equal(quote.body, ""); assert.equal(quote.preview, "사진 1장 · 동영상 1개");
  assert.equal(quoteHtml(db, therapist, replyId), "사진 1장 · 동영상 1개");
  assert.equal(db.messages.find((message) => message.id === sourceId).body, "");
  assert.equal(db.messages.find((message) => message.id === replyId).replyTo, sourceId);
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});

test("editing an attachment-only original to text does not rewrite its older reply or clinical snapshot", () => {
  let db = send(start()); const sourceId = db.messages.at(-1).id;
  db = send(db, therapist, { body: "합성 답변", attachments: [], replyTo: sourceId, expectedReplyVersion: 1 });
  const replyId = db.messages.at(-1).id;
  db = mutate(db, therapist, "record", { childId: "c1", goalId: "g1", date: "2026-10-08", performed: "가상 관찰",
    referenceMessageIds: [sourceId], expectedReferenceVersions: [{ messageId: sourceId, version: 1 }] }, later);
  const recordId = db.records.at(-1).id, sources = structuredClone(db.records.at(-1).referenceSources);
  db = edit(db, sourceId, "수정 후 합성 본문");
  const before = structuredClone(db), quote = row(db, therapist, replyId).quote;
  assert.equal(quote.changed, true); assert.equal(quote.body, ""); assert.equal(quote.preview, "사진 1장");
  assert.match(quoteHtml(db, therapist, replyId), /사진 1장/);
  assert.doesNotMatch(quoteHtml(db, therapist, replyId), /수정 후 합성 본문/);
  assert.match(composer(db, therapist, sourceId, 1), /원문이 수정됐어요/);
  assert.match(composer(db, therapist, sourceId, 2), /수정 후 합성 본문/);
  assert.deepEqual(db.records.find((record) => record.id === recordId).referenceSources, sources);
  assert.equal(sources[0].body, ""); assert.deepEqual(sources[0].attachments, [photo()]);
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});

test("editing text to attachment-only preserves the old reply text and summarizes only new replies", () => {
  let db = send(start(), guardian, { body: "답변 당시 합성 본문" }); const sourceId = db.messages.at(-1).id;
  db = send(db, therapist, { body: "이전 답변", attachments: [], replyTo: sourceId, expectedReplyVersion: 1 });
  const oldReply = db.messages.at(-1).id;
  db = edit(db, sourceId, "");
  assert.equal(row(db, therapist, oldReply).quote.body, "답변 당시 합성 본문");
  assert.equal(row(db, therapist, oldReply).quote.preview, "답변 당시 합성 본문");
  assert.match(quoteHtml(db, therapist, oldReply), /답변 당시 합성 본문/);
  assert.match(composer(db, therapist, sourceId, 2), /답변할 소식 · 사진 1장/);
  db = send(db, therapist, { body: "새 답변", attachments: [], replyTo: sourceId, expectedReplyVersion: 2 });
  const latest = db.messages.at(-1).id, before = structuredClone(db);
  assert.equal(row(db, therapist, latest).quote.body, "");
  assert.equal(row(db, therapist, latest).quote.preview, "사진 1장");
  assert.equal(quoteHtml(db, therapist, latest), "사진 1장");
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});

test("self-hide redacts only that viewer's quote without recovering attachment details", () => {
  let db = send(start()); const sourceId = db.messages.at(-1).id;
  db = send(db, therapist, { body: "합성 답변", attachments: [], replyTo: sourceId, expectedReplyVersion: 1 });
  const replyId = db.messages.at(-1).id;
  db = remove(db, therapist, sourceId, "self"); const before = structuredClone(db);
  assert.equal(row(db, therapist, sourceId), undefined);
  const hidden = row(db, therapist, replyId).quote;
  assert.equal(hidden.hidden, true); assert.equal(hidden.body, "열람 범위 밖의 대화입니다.");
  assert.doesNotMatch(quoteHtml(db, therapist, replyId), /사진|동영상|SYNTHETIC_PRIVATE/);
  assert.match(composer(db, therapist, sourceId, 1), /열람할 수 없는 소식/);
  assert.equal(row(db, guardian, replyId).quote.preview, "사진 1장");
  assert.equal(quoteHtml(db, guardian, replyId), "사진 1장");
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});

test("all-delete redacts every quote and compose preview while retaining original metadata internally", () => {
  let db = send(start(), guardian, { attachments: [photo(), video()] }); const sourceId = db.messages.at(-1).id;
  db = send(db, therapist, { body: "합성 독립 답변", attachments: [], replyTo: sourceId, expectedReplyVersion: 1 });
  const replyId = db.messages.at(-1).id;
  db = remove(db, guardian, sourceId, "all"); const before = structuredClone(db);
  for (const actor of [guardian, therapist]) {
    const source = row(db, actor, sourceId), quote = row(db, actor, replyId).quote;
    assert.equal(messagePreview(source), "삭제된 소식입니다.");
    assert.deepEqual(source.attachments, []); assert.equal(quote.hidden, true);
    assert.equal(quote.body, "삭제된 소식입니다.");
    assert.doesNotMatch(quoteHtml(db, actor, replyId), /사진|동영상|SYNTHETIC_PRIVATE/);
    assert.doesNotMatch(composer(db, actor, sourceId, 1), /사진|동영상|SYNTHETIC_PRIVATE/);
    assert.match(composer(db, actor, sourceId, 1), /삭제되었거나 공유가 종료/);
  }
  assert.deepEqual(db.messages.find((message) => message.id === sourceId).attachments, [photo(), video()]);
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});

test("a newly connected viewer can read a later reply but not the older attachment-only quote", () => {
  let db = send(start(), guardian, { attachments: [photo(), video()] }); const sourceId = db.messages.at(-1).id;
  db = mutate(db, manager, "relationships", { childId: "c1", therapistId: "t1", guardianIds: ["p1", "p2"], historyConfirmed: true }, later);
  db = send(db, therapist, { body: "연결 후 독립 답변", attachments: [], replyTo: sourceId, expectedReplyVersion: 1 });
  const replyId = db.messages.at(-1).id, before = structuredClone(db);
  assert.equal(row(db, peer, sourceId), undefined);
  assert.equal(row(db, peer, replyId).body, "연결 후 독립 답변");
  assert.equal(row(db, peer, replyId).quote.hidden, true);
  assert.equal(row(db, peer, replyId).quote.body, "열람 범위 밖의 대화입니다.");
  assert.doesNotMatch(quoteHtml(db, peer, replyId), /사진|동영상|SYNTHETIC_PRIVATE/);
  assert.match(composer(db, peer, sourceId, 1), /열람할 수 없는 소식/);
  assert.equal(row(db, guardian, replyId).quote.preview, "사진 1장 · 동영상 1개");
  assert.deepEqual(db, before); assert.equal(validateState(db), true);
});
