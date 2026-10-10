import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNTS, STORAGE_KEY } from "../src/config.js";
import { seed } from "../src/seed.js";
import { upgradeState, conversationView } from "../src/conversations.js";
import { accessibleChildren, mutate, project, validateState } from "../src/domain.js";
import { load, persist } from "../src/repository.js";

function fixture() {
  let db = upgradeState(seed());
  db = mutate(db, ACCOUNTS.guardian, "message", { childId: "c1", clientId: "synthetic-history-message", body: "가상 보존 소식", attachments: [] });
  db = mutate(db, ACCOUNTS.therapist, "read", { childId: "c1", id: "synthetic-history-message" });
  db = mutate(db, ACCOUNTS.guardian, "read", { childId: "c1", id: "publication-pub1" });
  const original = structuredClone(db);
  for (const child of original.children.filter((child) => child.therapistId === "t1" || child.guardianIds.includes("p1")))
    db = mutate(db, ACCOUNTS.center, "relationships", { childId: child.id, therapistId: "t2", guardianIds: child.guardianIds.filter((id) => id !== "p1"), historyConfirmed: true });
  return { db, original };
}
test("관계가 모두 해제된 상태도 유효하게 저장·복원하며 아동별 조회/발신/작성은 계속 거부한다", () => {
  const { db, original } = fixture();
  assert.equal(validateState(db), true);
  for (const actor of [ACCOUNTS.therapist, ACCOUNTS.guardian]) {
    assert.deepEqual(accessibleChildren(db, actor), []);
    assert.throws(() => project(db, actor, "c1"));
    assert.throws(() => conversationView(db, actor, "c1"));
    assert.throws(() => mutate(db, actor, "message", { childId: "c1", clientId: "synthetic-denied-message", body: "가상 거부", attachments: [] }));
  }
  assert.throws(() => mutate(db, ACCOUNTS.therapist, "record", { childId: "c1", goalId: "g1", date: "2026-10-06", status: "draft" }));
  const map = new Map([[STORAGE_KEY, JSON.stringify(original)]]);
  const storage = { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  persist(storage, db, original.revision);
  assert.deepEqual(load(storage).db, db);
  for (const key of ["records", "publications", "messages", "readStates", "feedback", "goals", "appointments"])
    assert.deepEqual(db[key], original[key]);
  const center = project(db, ACCOUNTS.center, "c1");
  for (const key of ["records", "publications", "feedback", "goals"])
    assert.deepEqual(center[key], [], "센터에는 임상 원문을 제공하지 않는다");
  assert.equal(center.recordCount, original.records.filter((record) => record.childId === "c1").length);
});
test("별도 과거 공개 확인으로 이력을 복원하되 새로 보이는 자료를 읽음 처리하지 않는다", () => {
  const f = fixture(); let db = f.db;
  for (const child of f.original.children.filter((child) => child.therapistId === "t1" || child.guardianIds.includes("p1")))
    db = mutate(db, ACCOUNTS.center, "relationships", { childId: child.id, therapistId: child.therapistId, guardianIds: child.guardianIds, historyConfirmed: true,
      historyChoices:Object.fromEntries([child.therapistId,...child.guardianIds].map((id) => [id,"all"])),pastHistoryConfirmed:true });
  assert.equal(validateState(db), true);
  for (const actor of [ACCOUNTS.therapist, ACCOUNTS.guardian]) {
    assert.deepEqual(accessibleChildren(db, actor).map((child) => child.id), accessibleChildren(f.original, actor).map((child) => child.id));
    assert.deepEqual(conversationView(db, actor, "c1").messages.map((m) => m.id), conversationView(f.original, actor, "c1").messages.map((m) => m.id));
    assert.equal(conversationView(db, actor, "c1").lastRead,0);
  }
  for (const key of ["records", "publications", "messages", "feedback", "goals", "appointments"])
    assert.deepEqual(db[key], f.original[key]);
});
