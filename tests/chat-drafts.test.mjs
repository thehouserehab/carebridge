import assert from "node:assert/strict";
import test from "node:test";
import { ChatDrafts, chatDraftValid } from "../src/chat-drafts.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const draft = (body = "가상 소식") => ({ clientId: "draft-client-0001", body, replyTo: null, attachments: [], entries: [] });
function fixture() {
  const records = new Map(), writes = [], events = [], requests = [];
  const db = {
    closes: 0, close() { this.closes++; },
    transaction(name, mode) {
      assert.equal(name, "drafts");
      const tx = { abort() { queueMicrotask(() => tx.onabort?.()); }, objectStore() { return {
        get(key) {
          const r = { result: structuredClone(records.get(key)) };
          queueMicrotask(() => tx.oncomplete?.());
          return r;
        },
        put(value, key) { writes.push({ value, key, tx }); },
      }; } };
      assert.ok(mode === undefined || mode === "readwrite");
      return tx;
    },
  };
  const factory = { open(name, version) {
    assert.equal(name, "carebridge-chat-drafts-v1"); assert.equal(version, 1);
    const r = { result: db }; requests.push(r);
    queueMicrotask(() => r.onsuccess()); return r;
  } };
  const storage = new Map();
  const options = { factory, id: () => "tab-test-0001", tabStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    onStatus: (key, phase) => events.push([key, phase]) };
  const store = new ChatDrafts(options);
  const finish = (ok = true) => {
    const write = writes.shift(); assert.ok(write);
    if (ok) { records.set(write.key, structuredClone(write.value)); write.tx.oncomplete(); }
    else write.tx.onabort();
  };
  return { store, records, writes, events, requests, db, factory, options, finish };
}
test("초안은 타입·답변 ID·첨부 원본 쌍·중복과 손상 튜플을 안전하게 검사한다", () => {
  assert.equal(chatDraftValid(draft()), true);
  const blob = new Blob(["synthetic"], { type: "image/png" });
  const withFile = { ...draft(), attachments: [{ id: "file-1", name: "가상.png", type: blob.type, size: blob.size, share: true }], entries: [["file-1", blob]] };
  assert.equal(chatDraftValid(withFile), true);
  for (const value of [null, false, [], {}, { ...draft(), body: 3 }, { ...draft(), body: "x".repeat(2001) },
    { ...draft(), replyTo: {} }, { ...draft(), replyTo: "bad/ID" }, { ...draft(), password: "not-allowed" },
    { ...withFile, entries: [null] }, { ...withFile, entries: [{}] }, { ...withFile, entries: [["file-1"]] },
    { ...withFile, entries: [["other", blob]] }, { ...withFile, entries: [["file-1", blob], ["file-1", blob]] },
    { ...withFile, entries: Array(1) }, { ...draft(), attachments: Array(1) }, { ...withFile, entries: [["file-1", new Blob(["short"], { type: blob.type })]] }])
    assert.equal(chatDraftValid(value), false);
});
test("저장 완료 표시는 request가 아닌 transaction 커밋 뒤에만 나오며 스냅샷을 보존한다", async () => {
  const f = fixture(), value = draft();
  const save = f.store.save("room-a", value); await flush();
  assert.equal(f.store.status("room-a"), "saving"); assert.equal(f.store.pendingCount, 1);
  value.body = "나중 입력"; f.finish(); await save;
  assert.equal(f.records.get("room-a").body, "가상 소식");
  assert.equal(f.store.status("room-a"), "saved"); assert.equal(f.store.pendingCount, 0);
  assert.deepEqual(f.events, [["room-a", "saving"], ["room-a", "saved"]]);
});
test("앞선 커밋/실패가 최신 입력의 저장 상태를 완료로 바꾸지 않고 순서대로 처리한다", async () => {
  const f = fixture();
  const one = f.store.save("a", draft("가상 첫 입력")), two = f.store.save("a", draft("가상 최신 입력"));
  await flush(); f.finish(); await one; await flush();
  assert.equal(f.store.status("a"), "saving"); assert.equal(f.store.pendingCount, 1);
  f.finish(false); await assert.rejects(two, /초안을 저장하지/);
  assert.equal(f.store.status("a"), "failed"); assert.equal(f.store.failed, true);
  assert.equal((await f.store.read("a")).body, "가상 최신 입력");
  assert.equal(f.records.get("a").body, "가상 첫 입력");
  const retry = f.store.save("a", await f.store.read("a")); await flush(); f.finish(); await retry;
  assert.equal(f.store.failed, false); assert.equal(f.records.get("a").body, "가상 최신 입력");
  const older = f.store.save("a", draft("가상 이전 실패"));
  const rejected = assert.rejects(older);
  const latest = f.store.save("a", draft("가상 뒤이은 성공"));
  await flush(); f.finish(false); await rejected; await flush();
  assert.equal(f.store.status("a"), "saving"); assert.equal(f.store.failed, false);
  f.finish(); await latest; assert.equal(f.store.status("a"), "saved");
  assert.equal(f.records.get("a").body, "가상 뒤이은 성공");
});
test("초안 실패/대기는 방별로 분리하며 다른 방 성공이 실패와 종료 경고를 없애지 않는다", async () => {
  const f = fixture();
  const a = f.store.save("a", draft()); await flush(); f.finish(false); await assert.rejects(a);
  const b = f.store.save("b", draft("가상 다른 방")); await flush(); f.finish(); await b;
  assert.equal(f.store.status("a"), "failed"); assert.equal(f.store.status("b"), "saved"); assert.equal(f.store.failed, true);
  assert.equal(f.store.pendingCount, 0);
});
test("전송 성공은 해당 방의 발신 ID만 정리하고 뒤이어 작성한 초안·다른 방은 보존한다", async () => {
  const f = fixture();
  const first = f.store.save("a", draft()); await flush(); f.finish(); await first;
  const other = f.store.save("b", draft("가상 다른 방")); await flush(); f.finish(); await other;
  const clear = f.store.clearSent("a", "draft-client-0001"); await flush(); f.finish(); await clear;
  assert.equal(f.records.get("a").body, "");
  assert.notEqual(f.records.get("a").clientId, "draft-client-0001");
  assert.equal(f.records.get("b").body, "가상 다른 방");
  const newer = { ...draft("가상 다음 입력"), clientId: "draft-client-0002" };
  const save = f.store.save("a", newer); await flush(); f.finish(); await save;
  assert.equal(await f.store.clearSent("a", "draft-client-0001"), false);
  assert.equal(await f.store.clearSent("missing", "draft-client-0001"), false);
  assert.equal(f.writes.length, 0); assert.deepEqual(f.records.get("a"), newer);
});
test("전송 후 초안 디스크 정리가 실패해도 메모리는 빈 새 ID로 바뀌고 실패 상태를 유지한다", async () => {
  const f = fixture();
  const save = f.store.save("a", draft()); await flush(); f.finish(); await save;
  const clear = f.store.clearSent("a", "draft-client-0001");
  const rejected = assert.rejects(clear, /초안을 저장하지/);
  await flush(); f.finish(false); await rejected;
  assert.equal(f.records.get("a").clientId, "draft-client-0001");
  assert.equal((await f.store.read("a")).body, "");
  assert.notEqual((await f.store.read("a")).clientId, "draft-client-0001");
  assert.equal(f.store.status("a"), "failed"); assert.equal(f.store.failed, true);
});
test("기존 형식·가상 파일을 복원하며 손상된 저장 원문은 초기화/덮어쓰기 없이 거부한다", async () => {
  const f = fixture(), blob = new Blob(["synthetic"], { type: "image/png" });
  const old = { ...draft(), replyTo: "publication-pub1", attachments: [{ id: "file-1", name: "가상.png", type: blob.type, size: blob.size, share: true }], entries: [["file-1", blob]] };
  f.records.set("old", old); assert.deepEqual(await f.store.read("old"), old); assert.equal(f.store.status("old"), "saved");
  f.records.set("damaged", { ...old, entries: [null] }); const raw = f.records.get("damaged");
  await assert.rejects(f.store.read("damaged"), /기존 저장 내용은 변경하지/);
  assert.strictEqual(f.records.get("damaged"), raw); assert.equal(f.store.memory.has("damaged"), false); assert.equal(f.writes.length, 0);
  assert.equal(f.store.status("damaged"), "unavailable");
  assert.equal((await f.store.read("new")).body, ""); assert.equal(f.store.status("new"), "empty");
});
test("저장소의 동기 오류는 원문 비노출·대기 해제·입력 보존 뒤 재시도할 수 있다", async () => {
  const f = fixture(), original = f.db.transaction;
  f.db.transaction = () => { throw new Error("PRIVATE-DRAFT-CONTENT internal path"); };
  await assert.rejects(f.store.save("a", draft()), (error) => !error.message.includes("PRIVATE") && /초안을 저장하지/.test(error.message));
  assert.equal(f.store.pendingCount, 0); assert.equal((await f.store.read("a")).body, "가상 소식");
  f.db.transaction = original;
  const retry = f.store.save("a", await f.store.read("a")); await flush(); f.finish(); await retry;
  assert.equal(f.store.failed, false);
  const invalid = f.store.save("a", { ...draft(), extra: () => {} });
  await assert.rejects(invalid); assert.equal(f.store.pendingCount, 0); assert.equal(f.store.status("a"), "failed");
  assert.equal(f.records.get("a").body, "가상 소식");
});
test("blocked 이후 늦게 열린 연결은 닫고, versionchange는 연결을 닫은 뒤 새로 연다", async () => {
  const f = fixture();
  f.factory.open = () => { const r = { result: f.db }; f.requests.push(r); queueMicrotask(() => r.onblocked()); return r; };
  await assert.rejects(f.store.read("a"));
  const blocked = f.requests.at(-1); blocked.onsuccess(); assert.equal(f.db.closes, 1);
  f.factory.open = () => { const r = { result: f.db }; f.requests.push(r); queueMicrotask(() => r.onsuccess()); return r; };
  await f.store.read("a"); f.db.onversionchange(); assert.equal(f.db.closes, 2); assert.equal(f.store.connection, null);
  await f.store.read("b"); assert.equal(f.requests.length, 3);
});
test("화면 알림 오류는 커밋 결과를 바꾸지 않으며 탭 키 재사용/저장 불가 시 독립 키를 유지한다", async () => {
  const f = fixture(); f.store.onStatus = () => { throw new Error("synthetic UI failure"); };
  const save = f.store.save("a", draft()); await flush(); f.finish(); await save;
  assert.equal(f.store.status("a"), "saved"); assert.equal(f.store.failed, false);
  const same = new ChatDrafts(f.options); assert.equal(same.tabId, f.store.tabId);
  const independent = new ChatDrafts({ ...f.options, id: () => "tab-other-0001", tabStorage: { getItem() { throw new Error("synthetic denied"); } } });
  assert.notEqual(independent.key("t1", "c1"), f.store.key("t1", "c1"));
  assert.equal(independent.tabPersistent, false); assert.equal(independent.failed, false);
  const fallback = independent.save("fallback", draft()); await flush(); f.finish(); await fallback;
  assert.equal(independent.status("fallback"), "saved"); assert.equal(independent.failed, true);
  const cleared = independent.save("fallback", { ...draft(), body: "" }); await flush(); f.finish(); await cleared;
  assert.equal(independent.failed, false);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  try {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() { throw new Error("PRIVATE unavailable storage"); } });
    const unsupported = new ChatDrafts({ id: f.options.id, tabStorage: f.options.tabStorage });
    await assert.rejects(unsupported.read("a"), (error) => !error.message.includes("PRIVATE"));
    assert.equal(unsupported.status("a"), "unavailable");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
    else delete globalThis.indexedDB;
  }
});
