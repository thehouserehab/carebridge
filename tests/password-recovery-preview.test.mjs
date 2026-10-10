import assert from "node:assert/strict";
import { test } from "node:test";
import { RecoveryPreview, OnboardingDemo } from "../src/onboarding-demo.js";
import { OnboardingController } from "../src/onboarding-controller.js";
import { recoveryRequestForm, recoveryRequestedScreen, recoveryResetForm,
  recoveryUnavailableScreen, recoveryCompletedScreen } from "../src/onboarding-ui.js";

const password = "Synthetic preview password";
const valid = () => ({ password, confirmation: password, understood: true });
function fixture() {
  let now = 1_000_000;
  const preview = new RecoveryPreview({ now: () => now });
  return { preview, advance: (ms) => { now += ms; }, reset: (email = "unknown@example.test") => {
    preview.begin(); preview.request(email); assert.equal(preview.openReset(), true);
  } };
}

test("복구 체험은 등록 계정 여부를 조회하지 않고 동일한 상태로 이동하며 주소를 보관하지 않는다", () => {
  const states = [];
  for (const email of ["guardian@example.test", "existing.guardian@example.test", "unknown@example.test"]) {
    const { preview } = fixture(); preview.begin();
    assert.equal(preview.request(email), undefined);
    states.push(JSON.stringify(preview));
    assert.equal(JSON.stringify(preview).includes(email), false);
  }
  assert.equal(new Set(states).size, 1);
  const f = fixture(); f.preview.begin();
  for (const email of ["synthetic@real-domain.invalid", "not-an-email", "<script>@example.test"])
    assert.throws(() => f.preview.request(email), /체험용 주소/);
  assert.equal(f.preview.stage, "request");
  assert.equal(f.preview.expiresAt, null);
});

test("요청 전이나 완료 후에는 재설정 체험을 건너뛰거나 다시 완료할 수 없다", () => {
  const { preview, reset } = fixture();
  assert.equal(preview.openReset(), false);
  assert.equal(preview.stage, "unavailable");
  assert.equal(preview.complete(valid()), false);
  reset(); assert.equal(preview.complete(valid()), true);
  assert.equal(preview.stage, "complete"); assert.equal(preview.expiresAt, null);
  assert.equal(preview.complete(valid()), false);
  assert.equal(preview.openReset(), false);
  assert.throws(() => preview.request("unknown@example.test"), /다시 복구 안내/);
});

test("입력 오류는 재설정 단계만 유지하고 비밀번호·확인·추가 값을 모델에 남기지 않는다", () => {
  const { preview, reset } = fixture(); reset();
  const before = JSON.stringify(preview);
  for (const value of [null, [], {}, { ...valid(), token: "must-not-store" },
    { ...valid(), password: "short" }, { ...valid(), password: "a".repeat(129) },
    { ...valid(), confirmation: "different synthetic value" },
    { ...valid(), understood: false }, { ...valid(), understood: "true" }]) {
    assert.throws(() => preview.complete(value));
    assert.equal(JSON.stringify(preview), before);
  }
  assert.equal(preview.complete(valid()), true);
  for (const text of [password, "password", "confirmation", "understood", "token", "must-not-store"])
    assert.equal(JSON.stringify(preview).includes(text), false);
});

test("비밀번호 공백을 바꾸지 않고 12~128자와 정확한 확인 일치를 검사한다", () => {
  for (const value of ["a".repeat(12), "a".repeat(128), "  합성 비밀번호 그대로 유지  "]) {
    const { preview, reset } = fixture(); reset();
    if (value !== value.trim()) assert.throws(() => preview.complete({ ...valid(), password: value, confirmation: value.trim() }), /일치/);
    assert.equal(preview.complete({ ...valid(), password: value, confirmation: value }), true);
  }
});

test("시연의 15분 경계는 열기와 제출에서 재확인하며 만료 뒤 입력 단계로 돌아가지 않는다", () => {
  const first = fixture(); first.preview.begin(); first.preview.request("unknown@example.test");
  first.advance(15 * 60 * 1000);
  assert.equal(first.preview.openReset(), false); assert.equal(first.preview.stage, "unavailable");
  const second = fixture(); second.reset(); second.advance(15 * 60 * 1000 - 1);
  assert.equal(second.preview.live("reset"), true); second.advance(1);
  assert.equal(second.preview.complete(valid()), false); assert.equal(second.preview.stage, "unavailable");
  assert.equal(second.preview.expiresAt, null);
});

test("만료 안내·취소·로그인 이동은 시연 상태를 버리고 새 요청에서만 재시작한다", () => {
  const { preview, reset } = fixture(); reset();
  preview.unavailable(); assert.equal(preview.complete(valid()), false);
  preview.leave(); assert.equal(preview.stage, "idle"); assert.equal(preview.expiresAt, null);
  assert.equal(preview.openReset(), false);
  reset(); assert.equal(preview.complete(valid()), true);
  preview.begin(); assert.equal(preview.stage, "request"); assert.equal(preview.expiresAt, null);
});

test("복구 체험은 기존 초대·구성원·계정 역할과 독립적이며 자동 로그인 데이터를 만들지 않는다", () => {
  const demo = new OnboardingDemo(), before = JSON.stringify(demo);
  const { preview, reset } = fixture(); reset(); preview.complete(valid());
  assert.equal(JSON.stringify(demo), before);
  assert.deepEqual(Object.keys(preview).sort(), ["expiresAt", "now", "stage"]);
  assert.deepEqual(Object.keys(new OnboardingDemo()).sort(), Object.keys(demo).sort());
});

test("복구 화면은 비어 있는 입력·비인증 안내·분리된 표시 버튼과 재요청 경로를 제공한다", () => {
  const request = recoveryRequestForm(), reset = recoveryResetForm();
  assert.match(request, /name="email"/); assert.match(request, /example\.test/);
  assert.match(reset, /id="recovery-password"/); assert.match(reset, /id="recovery-confirmation"/);
  assert.equal((reset.match(/autocomplete="off"/g) || []).length, 2);
  assert.equal((reset.match(/minlength="12" maxlength="128"/g) || []).length, 2);
  assert.equal((reset.match(/aria-pressed="false"/g) || []).length, 2);
  assert.match(reset, /name="understood"/);
  assert.match(reset, /data-onboarding="recovery-unavailable"/);
  assert.match(recoveryRequestedScreen(), /data-onboarding="recovery-reset"/);
  assert.match(recoveryUnavailableScreen(), /data-onboarding="recovery"/);
  assert.match(recoveryCompletedScreen(), /data-onboarding="login"/);
  for (const html of [request, reset, recoveryRequestedScreen(), recoveryUnavailableScreen(), recoveryCompletedScreen()]) {
    assert.equal(/value="[^\"]+"/.test(html), false);
    assert.equal(html.includes("cr1."), false);
    assert.equal(/<script|<iframe|<img|https?:\/\//.test(html), false);
  }
});

test("비밀번호 폐기는 표시된 text 입력도 비우며 다른 필드와 저장소는 건드리지 않는다", () => {
  const fields = [{ value: password, type: "text" }, { value: password, type: "password" }];
  const dialog = { querySelectorAll(selector) {
    assert.equal(selector, 'input[name="password"], input[name="confirmation"]'); return fields;
  } };
  OnboardingController.prototype.clearPasswords.call({ dialog });
  assert.deepEqual(fields.map(field => field.value), ["", ""]);
});

test("만료된 재설정 제출은 빈 입력의 native 검증보다 먼저 종료 안내로 이동한다", () => {
  const { preview, reset, advance } = fixture(); reset(); advance(15 * 60 * 1000);
  let unavailable = 0, prevented = 0;
  const form = { dataset: { intent: "recovery-reset" }, reportValidity() {
    assert.fail("Expired input must not request correction before clearing the screen");
  } };
  OnboardingController.prototype.submit.call({
    dialog: { open: true, querySelector: () => form }, recovery: preview,
    openRecoveryUnavailable() { unavailable++; },
  }, { target: form, preventDefault() { prevented++; } });
  assert.equal(prevented, 1); assert.equal(unavailable, 1);
  assert.equal(preview.stage, "unavailable"); assert.equal(preview.expiresAt, null);
});

test("지연된 닫기 이벤트는 다시 열린 계정 화면을 지우지 않고 실제 종료만 정리한다", () => {
  const previous = globalThis.document, listeners = new Map();
  const input = { value: password }; let replaced = 0, focused = 0;
  const dialog = { open: true, setAttribute() {}, addEventListener(name, handler) { listeners.set(name, handler); },
    querySelectorAll: () => [input], replaceChildren() { replaced++; } };
  try {
    globalThis.document = { createElement: () => dialog, body: { append() {} }, addEventListener() {} };
    const controller = new OnboardingController({ getActor: () => ({ id: "p1", role: "guardian" }) });
    controller.returnFocus = { isConnected: true, focus() { focused++; } };
    controller.recovery.begin();
    listeners.get("close")();
    assert.equal(input.value, password); assert.equal(replaced, 0); assert.equal(focused, 0);
    assert.equal(controller.recovery.stage, "request");
    dialog.open = false; listeners.get("close")();
    assert.equal(input.value, ""); assert.equal(replaced, 1); assert.equal(focused, 1);
    assert.equal(controller.recovery.stage, "idle");
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("이미 교체되거나 닫힌 폼의 늦은 제출은 새 복구 단계를 변경하지 않는다", () => {
  const stale = { reportValidity() { assert.fail("Detached form must not be processed"); } };
  for (const open of [true, false]) {
    let prevented = 0;
    OnboardingController.prototype.submit.call({ dialog: { open, querySelector: () => ({}) } },
      { target: stale, preventDefault() { prevented++; } });
    assert.equal(prevented, 1);
  }
});
