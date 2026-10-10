import assert from "node:assert/strict";
import { test } from "node:test";
import { OnboardingDemo, INVITE_TTL, DEMO_CENTER, demoEmail } from "../src/onboarding-demo.js";
import { membersScreen, acceptForm, existingAcceptForm, existingAcceptedScreen } from "../src/onboarding-ui.js";

const manager = { id: "m1", role: "center" };
const input = { email: "new@example.test", role: "guardian" };
const signup = { name: "체험 보호자", password: "sample-only-password", confirmation: "sample-only-password", understood: true };
function fixture() {
  let clock = 1_000_000, id = 0;
  return { demo: new OnboardingDemo({ now: () => clock, id: () => `invite-${++id}` }), advance: (ms) => { clock += ms; } };
}
test("초대 체험은 관리자 화면과 가상 이메일만 허용하고 중복 역할 초대를 막는다", () => {
  const { demo } = fixture();
  assert.throws(() => demo.create({ id: "p1", role: "guardian" }, input));
  assert.throws(() => demo.create(manager, { ...input, role: "center" }));
  assert.throws(() => demoEmail("person@real-domain.invalid"));
  assert.throws(() => demo.create(manager, { ...input, email: "guardian@example.test" }));
  demo.create(manager, input);
  assert.throws(() => demo.create(manager, { ...input, role: "therapist" }));
  const snapshot = demo.snapshot(manager);
  snapshot.invitations[0].email = "changed@example.test";
  assert.equal(demo.snapshot(manager).invitations[0].email, input.email);
});
test("초대 수락은 한번만 반영하고 비밀번호·추가 입력을 상태에 남기지 않는다", () => {
  const { demo } = fixture();
  const invite = demo.create(manager, input);
  assert.throws(() => demo.accept(invite.id, { ...signup, confirmation: "mismatch" }));
  assert.throws(() => demo.accept(invite.id, { ...signup, understood: false }));
  assert.equal(demo.snapshot(manager).members.length, 4);
  demo.accept(invite.id, { ...signup, token: "must-not-store", unexpected: "extra-value" });
  assert.equal(demo.invitation(invite.id).status, "accepted");
  assert.equal(demo.snapshot(manager).members.length, 5);
  const state = JSON.stringify(demo);
  for (const value of [signup.password, "password", "confirmation", "must-not-store", "extra-value"])
    assert.equal(state.includes(value), false);
  assert.throws(() => demo.accept(invite.id, signup));
  assert.throws(() => demo.revoke(manager, invite.id));
});
test("만료·취소 초대를 수락할 수 없고 재초대는 새로운 수락 흐름이다", () => {
  const { demo, advance } = fixture();
  const first = demo.create(manager, input);
  advance(INVITE_TTL);
  assert.equal(demo.invitation(first.id).status, "expired");
  assert.throws(() => demo.accept(first.id, signup));
  const second = demo.reissue(manager, first.id);
  assert.notEqual(second.id, first.id);
  assert.throws(() => demo.reissue(manager, first.id));
  demo.revoke(manager, second.id);
  assert.throws(() => demo.accept(second.id, signup));
  const third = demo.reissue(manager, second.id);
  assert.equal(third.status, "pending");
});
test("시연 화면은 동적 이름을 이스케이프하고 종료된 초대에 비밀번호 폼을 표시하지 않는다", () => {
  const { demo } = fixture();
  const invite = demo.create(manager, input);
  demo.accept(invite.id, { ...signup, name: '<img src=x onerror="bad">' });
  const html = membersScreen(demo.snapshot(manager));
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes("&lt;img"));
  assert.equal(acceptForm(demo.invitation(invite.id)).includes('name="password"'), false);
});

const existingInput = { accountId: "outside-guardian", centerId: DEMO_CENTER.id, role: "guardian", understood: true };
function existingFixture() {
  const f = fixture();
  const invite = f.demo.create(manager, { email: "existing.guardian@example.test", role: "guardian" });
  return { ...f, invite };
}
test("기존 계정 체험은 기존 ID와 이름을 유지하고 센터 소속만 추가한다", () => {
  const { demo, invite } = existingFixture();
  const accounts = demo.existingAccounts();
  accounts[0].name = "must-not-overwrite";
  assert.throws(() => demo.accept(invite.id, signup), /기존 계정으로 연결/);
  assert.equal(demo.invitation(invite.id).status, "pending");
  const member = demo.acceptExisting(invite.id, existingInput);
  assert.deepEqual(member, { id: "outside-guardian", name: "기존 보호자", email: "existing.guardian@example.test", role: "guardian" });
  member.name = "must-not-overwrite";
  assert.equal(demo.snapshot(manager).members.length, 5);
  assert.equal(demo.snapshot(manager).members.at(-1).name, "기존 보호자");
  assert.equal(demo.existingAccounts().filter((a) => a.id === "outside-guardian").length, 1);
  assert.equal(demo.invitation(invite.id).status, "accepted");
  assert.throws(() => demo.acceptExisting(invite.id, existingInput));
  assert.throws(() => demo.create(manager, { email: "existing.guardian@example.test", role: "therapist" }));
});
test("기존 계정 체험은 이메일·센터·역할·확인 불일치를 저장 없이 거부한다", () => {
  const { demo, invite } = existingFixture();
  const before = JSON.stringify(demo.snapshot(manager));
  for (const value of [
    { accountId: "outside-therapist" }, { accountId: "unknown" }, { accountId: "" },
    { centerId: "other-center" }, { role: "therapist" }, { role: "center" },
    { understood: false }, { understood: "true" }, { password: signup.password }, { email: invite.email },
  ]) {
    assert.throws(() => demo.acceptExisting(invite.id, { ...existingInput, ...value }));
    assert.equal(JSON.stringify(demo.snapshot(manager)), before);
  }
  assert.throws(() => demo.acceptExisting(invite.id, null));
  assert.throws(() => demo.acceptExisting(invite.id, []));
});
test("기존 계정 초대도 제출 시 만료·취소·수락 여부를 다시 확인한다", () => {
  for (const status of ["expired", "revoked", "accepted"]) {
    const { demo, invite, advance } = existingFixture();
    if (status === "expired") advance(INVITE_TTL);
    if (status === "revoked") demo.revoke(manager, invite.id);
    if (status === "accepted") demo.acceptExisting(invite.id, existingInput);
    const before = JSON.stringify(demo.snapshot(manager));
    assert.throws(() => demo.acceptExisting(invite.id, existingInput));
    assert.equal(JSON.stringify(demo.snapshot(manager)), before);
    const html = existingAcceptForm(demo.invitation(invite.id), demo.existingAccounts());
    assert.equal(html.includes('name="accountId"'), false);
    assert.equal(html.includes('name="password"'), false);
  }
});
test("기존 계정 체험은 이미 있는 소속을 중복 생성하거나 변경·재활성화하지 않는다", () => {
  for (const change of [{ role: "therapist" }, { active: false }, { id: "different-user" }]) {
    const { demo, invite } = existingFixture();
    demo.members.push({ id: "outside-guardian", name: "보존할 이름", email: invite.email, role: "guardian", ...change });
    const before = JSON.stringify(demo.snapshot(manager));
    assert.throws(() => demo.acceptExisting(invite.id, existingInput));
    assert.equal(JSON.stringify(demo.snapshot(manager)), before);
  }
  const { demo, invite } = existingFixture();
  demo.members.push({ id: "outside-guardian", name: "보존할 이름", email: invite.email, role: "guardian" });
  assert.equal(demo.acceptExisting(invite.id, existingInput).name, "보존할 이름");
  assert.equal(demo.snapshot(manager).members.length, 5);
});
test("기존 계정 화면은 동적 정보 이스케이프·비밀번호 비수집·서버 인증 경계를 표시한다", () => {
  const { demo, invite } = existingFixture();
  const html = existingAcceptForm(invite, [{ id: '\" autofocus onfocus=bad', name: "<img src=x>", email: "<script>bad</script>" }]);
  assert.equal(html.includes('<img src=x>'), false);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('value="" autofocus'), false);
  assert.equal(html.includes('name="password"'), false);
  assert.ok(html.includes("서버가 확인"));
  assert.ok(html.includes("로그인되지는 않아요"));
  assert.ok(html.includes("아동 열람 권한은 생성되지 않아요"));
  const result = existingAcceptedScreen({ name: "<img src=x>", email: invite.email, role: "guardian" });
  assert.equal(result.includes('<img src=x>'), false);
  assert.ok(result.includes("별도 담당 관계"));
  assert.equal(JSON.stringify(demo).includes(signup.password), false);
});
