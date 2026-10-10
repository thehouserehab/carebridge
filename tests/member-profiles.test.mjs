import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNTS, DEMO_CENTER, STORAGE_KEY } from "../src/config.js";
import { memberDisplayName, memberDisplayNameForm, ProfileFieldError } from "../src/profile-fields.js";
import { demoMember, memberName, validMemberProfiles } from "../src/member-profiles.js";
import { memberProfileEditor } from "../src/profile-ui.js";
import { seed } from "../src/seed.js";
import { upgradeState } from "../src/conversations.js";
import { mutate, validateState } from "../src/domain.js";
import { load, persist } from "../src/repository.js";
import { chatScreen, conversationRows, sender } from "../src/chat-ui.js";

const fixture = () => upgradeState(seed());
const edit = (db, actor = ACCOUNTS.therapist, displayName = "가상 새 표시") => mutate(db, actor, "member-profile", { displayName });
test("공통 표시 이름은 명시적 null 해제·양끝 공백 정리를 허용하고 빈 문자열/제어 문자를 거부한다", () => {
  assert.equal(memberDisplayName(null), null);
  assert.equal(memberDisplayName(" 가상 새 이름 "), "가상 새 이름");
  assert.equal(memberDisplayName("가".repeat(30)), "가".repeat(30));
  assert.equal(memberDisplayNameForm(""), null);
  assert.equal(memberDisplayNameForm(" 가상 "), "가상");
  for (const value of [undefined, false, 0, {}, [], "", " ", "가".repeat(31), "\ud800", "\n가상", "가상\t", "가\u0000", "가\u0085"])
    assert.throws(() => memberDisplayName(value), ProfileFieldError);
  assert.throws(() => memberDisplayNameForm(undefined), ProfileFieldError);
});
test("본인 표시 이름 변경은 로컬 센터 범위에만 저장하고 모든 기존 ID/원본/읽음/담당 관계를 유지한다", () => {
  const original = fixture(), next = edit(original);
  assert.equal(validateState(next), true);
  assert.deepEqual(next.memberProfiles, [{ centerId: DEMO_CENTER.id, userId: "t1", displayName: "가상 새 표시" }]);
  const { revision, memberProfiles, ...unchanged } = next;
  const { revision: oldRevision, ...old } = original;
  assert.deepEqual(unchanged, old);
  assert.equal(revision, oldRevision + 1);
  assert.equal(Object.hasOwn(original, "memberProfiles"), false);
  assert.equal(memberName(next, "t1"), "가상 새 표시");
  assert.equal(memberName(next, "p1"), "하루 보호자");
  assert.equal(demoMember(next, "t1").defaultName, "담당 치료사");
  assert.equal(demoMember(edit(next, ACCOUNTS.therapist, null), "t1").displayName, null);
  assert.equal(memberName(edit(next, ACCOUNTS.therapist, null), "t1"), "담당 치료사");
});
test("체험에서 본인 외 대상·추가 역할/권한/인증 필드·알 수 없는 계정·역할 위조는 거부한다", () => {
  const original = fixture(), raw = JSON.stringify(original);
  for (const patch of [{ userId: "p1" }, { centerId: "foreign" }, { role: "center" }, { password: "not-allowed" }, { childId: "c1" }, { guardianIds: ["p1"] }])
    assert.throws(() => mutate(original, ACCOUNTS.center, "member-profile", { displayName: "가상", ...patch }));
  for (const actor of [{ id: "missing", role: "therapist" }, { id: "p1", role: "center" }, null])
    assert.throws(() => edit(original, actor));
  for (const input of [null, [], {}, { displayName: undefined }])
    assert.throws(() => mutate(original, ACCOUNTS.therapist, "member-profile", input));
  assert.equal(JSON.stringify(original), raw);
  assert.equal(memberName(edit(original, ACCOUNTS.center), "t1"), "담당 치료사");
});
test("추가 프로필은 구형 데이터에서 선택 사항이며 잘못된/중복/다른 센터/비정규화/희소 행을 거부한다", () => {
  const original = fixture(), row = { centerId: DEMO_CENTER.id, userId: "p1", displayName: null };
  assert.equal(validMemberProfiles(original), true);
  assert.equal(validateState({ ...original, memberProfiles: [row] }), true);
  const sparse = new Array(1), disguisedSparse = new Array(1); disguisedSparse.extra = row;
  for (const rows of [null, {}, [row, row], [null], [{}], ["wrong"], [[], row], sparse, disguisedSparse,
    [{ ...row, centerId: "other" }], [{ ...row, userId: "unknown" }], [{ ...row, displayName: " trimmed " }],
    [{ ...row, displayName: "" }], [{ ...row, displayName: "\n가상" }], [{ ...row, email: "not-allowed" }],
    [{ centerId: row.centerId, userId: "p1" }]])
    assert.equal(validateState({ ...original, memberProfiles: rows }), false);
});
test("현재 이름은 화면에서 이스케이프하며 과거 발신 ID/공유 스냅샷을 수정하지 않고 이전 치료사를 보호자로 오인하지 않는다", () => {
  const literal = '<img src=x onerror="x">', original = fixture(), next = edit(original, ACCOUNTS.therapist, literal);
  assert.deepEqual(next.messages, original.messages);
  assert.deepEqual(next.publications, original.publications);
  assert.equal(sender(next, "c1", "t1"), `${literal} · 담당 치료사`);
  assert.equal(sender(next, "c1", "t2"), "이전 치료사");
  assert.equal(sender(next, "c1", "unknown"), "이전 참여자");
  for (const markup of [chatScreen(next, ACCOUNTS.guardian, "c1", true), conversationRows(next, ACCOUNTS.therapist), memberProfileEditor(demoMember(next, "t1"))]) {
    assert.equal(markup.includes(literal), false);
    assert.equal(markup.includes("&lt;img"), true);
  }
  assert.ok(memberProfileEditor(demoMember(next, "t1")).includes("기본 표시: <strong>담당 치료사</strong>"));
});
test("저장 실패·다른 탭 충돌·손상 프로필은 이전 원문을 덮어쓰지 않고 내부 IO 오류도 노출하지 않는다", () => {
  const original = fixture(), raw = JSON.stringify(original), store = new Map([[STORAGE_KEY, raw]]);
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const next = edit(original);
  assert.throws(() => persist({ ...storage, setItem() { throw new Error("PRIVATE-IO"); } }, next, original.revision), (error) => !error.message.includes("PRIVATE-IO"));
  assert.equal(store.get(STORAGE_KEY), raw);
  assert.throws(() => persist({ ...storage, getItem() { throw new Error("PRIVATE-READ"); } }, next, original.revision), (error) => !error.message.includes("PRIVATE-READ"));
  persist(storage, next, original.revision);
  const saved = store.get(STORAGE_KEY);
  assert.throws(() => persist(storage, edit(original, ACCOUNTS.guardian), original.revision));
  assert.equal(store.get(STORAGE_KEY), saved);
  assert.deepEqual(load(storage).db, next);
  const invalidRaw = JSON.stringify({ ...next, memberProfiles: [{ userId: "t1", centerId: "foreign", displayName: "가상" }] });
  store.set(STORAGE_KEY, invalidRaw);
  assert.equal(load(storage).db, null);
  assert.equal(store.get(STORAGE_KEY), invalidRaw);
});
