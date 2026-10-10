import assert from "node:assert/strict";
import test from "node:test";
import { MediaStore } from "../src/media-store.js";

function fixture() {
  const files = new Map();
  const db = { failOn: 0, aborts: 0, transaction() {
    let aborted = false, writes = 0;
    const staged = new Map(files), tx = { abort() { aborted = true; db.aborts++; queueMicrotask(() => tx.onabort()); }, objectStore() { return {
      get(id) { return { result: staged.get(id) }; },
      add(value) { if (++writes === db.failOn) throw new Error("PRIVATE-media-detail"); staged.set(value.id, value); },
      delete(id) { if (++writes === db.failOn) throw new Error("PRIVATE-media-detail"); staged.delete(id); },
    }; } };
    queueMicrotask(() => {
      if (aborted) return;
      files.clear(); for (const [id, value] of staged) files.set(id, value); tx.oncomplete();
    });
    return tx;
  } };
  const factory = { open() { const r = { result: db }; queueMicrotask(() => r.onsuccess()); return r; } };
  return { files, db, store: new MediaStore(factory) };
}
test("파일 저장소는 지연 연결하며 접근 거부 원문을 감추고 환경 복구 후 재시도한다", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  try {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, get() { throw new Error("PRIVATE-storage-permission"); } });
    const store = new MediaStore();
    await assert.rejects(store.open(), (error) => /파일 저장소를 열지/.test(error.message) && !error.message.includes("PRIVATE"));
    assert.equal(store.connection, null);
    const f = fixture();
    store.factory = { open() { const r = { result: f.db }; queueMicrotask(() => r.onsuccess()); return r; } };
    assert.strictEqual(await store.open(), f.db);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor); else delete globalThis.indexedDB;
  }
});
test("읽기·쓰기·삭제의 동기 저장소 오류는 올바른 공개 안내만 반환한다", async () => {
  const f = fixture(); f.db.transaction = () => { throw new Error("PRIVATE-media-path"); };
  for (const [operation, message] of [
    [() => f.store.read("file-1"), /첨부파일을 읽지/],
    [() => f.store.write([["file-1", new Blob(["synthetic"])]]) , /첨부파일을 저장하지/],
    [() => f.store.remove(["file-1"]), /미완료 파일을 정리하지/],
  ]) await assert.rejects(operation(), (error) => message.test(error.message) && !error.message.includes("PRIVATE"));
});
test("부분 추가/삭제 중 동기 오류는 트랜잭션 전체를 취소하고 기존 원본을 보존한다", async () => {
  const f = fixture(), blob = new Blob(["synthetic"], { type: "image/png" });
  f.files.set("old", { id: "old", blob }); f.db.failOn = 2;
  await assert.rejects(f.store.write([["new-one", blob], ["new-two", blob]]), /첨부파일을 저장하지/);
  assert.deepEqual([...f.files.keys()], ["old"]); assert.equal(f.db.aborts, 1);
  f.db.failOn = 0; await f.store.write([["new-one", blob], ["new-two", blob]]);
  assert.strictEqual(await f.store.read("old"), blob);
  f.db.failOn = 2; await assert.rejects(f.store.remove(["new-one", "new-two"]), /미완료 파일/);
  assert.deepEqual([...f.files.keys()], ["old", "new-one", "new-two"]); assert.equal(f.db.aborts, 2);
});
