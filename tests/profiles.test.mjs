import assert from "node:assert/strict";
import test from "node:test";
import { childProfileFields, childProfileFormValues, profileToday, validChildAge, ProfileFieldError } from "../src/profile-fields.js";
import { childProfileEditor, childAgeLabel } from "../src/profile-ui.js";
import { seed } from "../src/seed.js";
import { upgradeState } from "../src/conversations.js";
import { mutate, project, validateState } from "../src/domain.js";
import { load, persist, BACKUP_KEY } from "../src/repository.js";
import { ACCOUNTS, STORAGE_KEY } from "../src/config.js";

const basis = "2026-01-01", now = "2026-10-01T15:00:00Z";
const content = { name: "가상 새 이름", age: 0, ageAsOf: basis };
const update = { childId: "c1", ...content };
const fixture = () => upgradeState(seed());
test("프로필 공통 규칙은 미입력과 실제 0세를 구분하며 이름·기준일만 정규화한다", () => {
  assert.deepEqual(childProfileFields({ name: " 가상 아동 " }), { name: "가상 아동", age: null, ageAsOf: null });
  assert.deepEqual(childProfileFields(content, { today: basis }), content);
  assert.deepEqual(childProfileFields({ ...content, age: 26 }), { ...content, age: 26 });
  assert.deepEqual(childProfileFields({ ...content, age: null, ageAsOf: null }), { ...content, age: null, ageAsOf: null });
  assert.equal(profileToday(new Date("2026-10-01T14:59:59Z")), "2026-10-01");
  assert.equal(profileToday(new Date(now)), "2026-10-02");
});
test("프로필 공통 규칙은 숫자 강제변환·불완전 쌍·불가능한 날짜·추가 임상/인증 필드를 거부한다", () => {
  for (const patch of [
    { age: "0" }, { age: false }, { age: NaN }, { age: Infinity }, { age: 1.5 }, { age: -1 }, { age: 27 },
    { age: null }, { ageAsOf: null }, { ageAsOf: "" }, { ageAsOf: "1899-12-31" }, { ageAsOf: "2026-02-29" },
    { ageAsOf: "2026-10-03" }, { name: "" }, { name: "x".repeat(31) }, { name: "\ud800" },
    { name: "줄\n바꿈" }, { name: "\n가상" }, { name: "가상\t" }, { name: "x\u0000" }, { name: "x\u0080" },
    { concern: "not-permitted" }, { password: "not-permitted" }, { guardianIds: [] }, { role: "center" },
  ]) assert.throws(() => childProfileFields({ ...content, ...patch }, { today: "2026-10-02" }), ProfileFieldError);
  assert.throws(() => childProfileFields(null), ProfileFieldError);
  assert.throws(() => childProfileFields([]), ProfileFieldError);
});
test("폼 경계에서만 정수 문자열을 변환하고 공백·지수·부분 숫자·누락을 거부한다", () => {
  assert.deepEqual(childProfileFormValues({ name: content.name, age: "0", ageAsOf: basis }), content);
  assert.deepEqual(childProfileFormValues({ name: content.name, age: "", ageAsOf: "" }), { name: content.name, age: null, ageAsOf: null });
  for (const age of [" ", "1e1", "1.5", "6years", "+1", "-1", "０", 0, null, undefined])
    assert.throws(() => childProfileFormValues({ name: content.name, age, ageAsOf: basis }), ProfileFieldError);
});
test("센터 기본정보 수정은 연결·이력·관심사·첨부를 보존하고 연령은 자동으로 증가하지 않는다", () => {
  const before = fixture();
  const next = mutate(before, ACCOUNTS.center, "child-profile", update, now);
  assert.equal(validateState(next), true);
  assert.equal(before.children[0].name, "하루");
  assert.deepEqual(next.children[0], { ...before.children[0], ...content });
  for (const key of ["goals", "records", "publications", "feedback", "appointments", "messages", "conversations", "readStates"])
    assert.deepEqual(next[key], before[key]);
  for (const actor of Object.values(ACCOUNTS)) {
    const view = project(next, actor, "c1");
    assert.equal(view.child.name, content.name);
    assert.equal(view.child.age, 0);
    assert.equal(view.child.ageAsOf, basis);
    assert.equal(view.child.concern === undefined, actor.role === "center");
  }
  const later = mutate(next, ACCOUNTS.center, "child-profile", update, "2027-10-01T15:00:00Z");
  assert.equal(later.children[0].age, 0);
  assert.equal(later.children[0].ageAsOf, basis);
});
test("기본정보 쓰기는 센터만 가능하고 다른 보호자·담당 관계·관심사 변경을 섞을 수 없다", () => {
  const db = fixture(), before = JSON.stringify(db);
  for (const actor of [ACCOUNTS.guardian, ACCOUNTS.therapist])
    assert.throws(() => mutate(db, actor, "child-profile", update, now));
  for (const patch of [{ childId: "missing" }, { concern: "forbidden" }, { therapistId: "t2" }, { guardianIds: ["p2"] }])
    assert.throws(() => mutate(db, ACCOUNTS.center, "child-profile", { ...update, ...patch }, now));
  assert.throws(() => mutate(db, ACCOUNTS.center, "concern", { childId: "c1", concern: "forbidden" }, now));
  assert.equal(JSON.stringify(db), before);
});
test("기존 날짜 없는 연령은 그대로 읽고 이름만 수정할 수 있지만 연령 변경에는 기준일이 필요하다", () => {
  const db = fixture(), child = db.children[0];
  assert.equal(Object.hasOwn(child, "ageAsOf"), false);
  const renamed = mutate(db, ACCOUNTS.center, "child-profile", { childId: child.id, name: "이름만 변경", age: child.age, ageAsOf: null }, now);
  assert.equal(renamed.children[0].age, child.age);
  assert.equal(Object.hasOwn(renamed.children[0], "ageAsOf"), false);
  assert.throws(() => mutate(db, ACCOUNTS.center, "child-profile", { ...update, ageAsOf: null }, now));
  assert.throws(() => mutate(db, ACCOUNTS.center, "child", { name: "가상 새 아동", age: 5, therapistId: "t1" }, now));
  const unknown = mutate(db, ACCOUNTS.center, "child", { name: "가상 새 아동", therapistId: "t1" }, now).children.at(-1);
  assert.equal(unknown.age, null);
  assert.equal(unknown.ageAsOf, null);
  assert.deepEqual(unknown.guardianIds, []);
  const cleared = mutate(renamed, ACCOUNTS.center, "child-profile", { childId: child.id, name: "이름만 변경", age: null, ageAsOf: null }, now);
  assert.equal(cleared.children[0].age, null);
  assert.equal(cleared.children[0].ageAsOf, null);
});
test("저장 검증은 기존 정수와 새 연령 쌍을 허용하되 손상 쌍을 거부하고 실패 원문을 보존한다", () => {
  assert.equal(validChildAge({ age: 5 }), true);
  assert.equal(validChildAge({ age: null, ageAsOf: null }), true);
  for (const child of [{ age: null }, { age: 5, ageAsOf: null }, { age: null, ageAsOf: basis }, { age: 5, ageAsOf: "2026-02-30" }])
    assert.equal(validChildAge(child), false);
  const before = fixture(), next = mutate(before, ACCOUNTS.center, "child-profile", update, now);
  const store = new Map([[STORAGE_KEY, JSON.stringify(before)]]);
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  persist(storage, next, before.revision);
  assert.deepEqual(load(storage).db, next);
  const saved = store.get(STORAGE_KEY);
  assert.throws(() => persist(storage, before, before.revision));
  assert.equal(store.get(STORAGE_KEY), saved);
  assert.throws(() => persist({ ...storage, setItem: () => { throw new Error("synthetic denied"); } },
    mutate(next, ACCOUNTS.center, "child-profile", { ...update, name: "미저장 이름" }, now), next.revision));
  assert.equal(store.get(STORAGE_KEY), saved);
  const legacy = seed(), legacyRaw = JSON.stringify(legacy);
  const legacyStore = new Map([[STORAGE_KEY, legacyRaw]]);
  const migrated = load({ getItem: (key) => legacyStore.get(key) ?? null, setItem: (key, value) => legacyStore.set(key, value) });
  assert.equal(migrated.error, null);
  assert.equal(legacyStore.get(BACKUP_KEY), legacyRaw);
  assert.deepEqual(migrated.db.children, upgradeState(legacy).children);
  assert.ok(migrated.db.children.every((c) => !Object.hasOwn(c, "ageAsOf")));
});
test("프로필 UI는 미입력·0·기준일 미확인·명시적 기준일을 구분하고 동적 이름을 이스케이프한다", () => {
  assert.equal(childAgeLabel({ age: null }), "연령 미입력");
  assert.equal(childAgeLabel({ age: 0, ageAsOf: basis }, true), `0세 · ${basis} 기준`);
  assert.equal(childAgeLabel({ age: 5 }, true), "5세 · 기준일 미확인");
  const empty = childProfileEditor();
  assert.ok(empty.includes('name="age" type="number" min="0" max="26" step="1" value=""'));
  const legacy = childProfileEditor({ name: '\"><img src=x>', age: 5 });
  assert.equal(legacy.includes('<img src=x>'), false);
  assert.ok(legacy.includes("이름만 수정하면 이전 값을 유지"));
});
