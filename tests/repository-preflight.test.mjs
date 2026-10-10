import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNTS, STORAGE_KEY } from "../src/config.js";
import { mutate } from "../src/domain.js";
import { assertRevision, load, persist } from "../src/repository.js";

function memory(initial = null) {
  let raw = initial;
  const writes = [];
  return {
    getItem: (key) => key === STORAGE_KEY ? raw : null,
    setItem: (key, value) => { writes.push([key, value]); raw = value; },
    replace: (value) => { raw = value; },
    raw: () => raw,
    writes,
  };
}
test("처음 체험은 샘플을 읽지만 기존 저장소 소실은 새 샘플/쓰기로 숨기지 않는다", () => {
  const store = memory();
  assert.ok(load(store).db);
  const missing = load(store, { requireExisting: true });
  assert.equal(missing.db, null); assert.ok(missing.error);
  assert.equal(store.raw(), null); assert.deepEqual(store.writes, []);
});
test("재조회는 손상 원문과 읽기 실패를 보존하며 내부 오류를 공개하지 않는다", () => {
  const store = memory("synthetic damaged JSON");
  assert.equal(load(store, { requireExisting: true }).db, null);
  assert.equal(store.raw(), "synthetic damaged JSON"); assert.deepEqual(store.writes, []);
  const denied = load({ getItem: () => { throw new Error("PRIVATE-READ"); } }, { requireExisting: true });
  assert.equal(denied.db, null); assert.equal(denied.error.includes("PRIVATE-READ"), false);
});
test("revision 사전 검사는 일치한 저장소만 허용하며 JSON/백업을 쓰지 않는다", () => {
  const store = memory();
  const original = load(store).db;
  store.replace(JSON.stringify(original));
  assert.doesNotThrow(() => assertRevision(store, original.revision));
  assert.equal(store.raw(), JSON.stringify(original)); assert.deepEqual(store.writes, []);
  store.replace(null);
  assert.doesNotThrow(() => assertRevision(store, 0));
  assert.throws(() => assertRevision(store, 1), /저장소가 변경/);
});
test("사전 검사는 충돌·손상·연결 오류·읽기 거부에서 쓰기 없이 안전한 오류를 반환한다", () => {
  const original = load(memory()).db;
  const peer = mutate(original, ACCOUNTS.guardian, "concern", { childId: "c1", concern: "가상 다른 탭" });
  const broken = structuredClone(original); broken.records[0].goalId = "synthetic-missing";
  for (const [raw, message] of [[JSON.stringify(peer), /다른 탭/], ["synthetic damaged JSON", /손상/], [JSON.stringify(broken), /형식/]]) {
    const store = memory(raw);
    assert.throws(() => assertRevision(store, original.revision), message);
    assert.equal(store.raw(), raw); assert.deepEqual(store.writes, []);
  }
  assert.throws(() => assertRevision({ getItem: () => { throw new Error("PRIVATE-IO"); } }, 0), (error) => error.message.includes("브라우저 저장소") && !error.message.includes("PRIVATE-IO"));
});
test("사전 검사 뒤 다른 탭이 변경하면 최종 저장도 다시 거부해 최신 원문을 덮어쓰지 않는다", () => {
  const store = memory(); const original = load(store).db;
  assertRevision(store, original.revision);
  const local = mutate(original, ACCOUNTS.guardian, "concern", { childId: "c1", concern: "가상 보관 입력" });
  const peer = mutate(original, ACCOUNTS.guardian, "concern", { childId: "c1", concern: "가상 최신 입력" });
  store.replace(JSON.stringify(peer));
  assert.throws(() => persist(store, local, original.revision), /다른 탭/);
  assert.equal(store.raw(), JSON.stringify(peer)); assert.deepEqual(store.writes, []);
  assert.deepEqual(load(store, { requireExisting: true }).db, peer);
});
