// UX rehearsal only. Nothing is persisted or sent; no authentication is granted.
import { DEMO_CENTER } from "./config.js";
export { DEMO_CENTER } from "./config.js";
export const MEMBER_ROLES = Object.freeze({ therapist: "치료사", guardian: "보호자", center: "센터 관리자" });
export const INVITE_TTL = 48 * 60 * 60 * 1000;
export const INVITE_STATUSES = Object.freeze({ pending: "수락 대기", accepted: "수락 완료", expired: "기간 만료", revoked: "초대 취소" });
// Synthetic identities used only to rehearse an already signed-in account.
// A selection is not authentication; production must use the server session.
const EXISTING_ACCOUNTS = Object.freeze([
  Object.freeze({ id: "outside-guardian", name: "기존 보호자", email: "existing.guardian@example.test" }),
  Object.freeze({ id: "outside-therapist", name: "기존 치료사", email: "existing.therapist@example.test" }),
]);

const fail = (message) => { throw new Error(message); };
export function demoEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@example\.(com|org|net|test)$/.test(email))
    fail("체험용 주소를 입력해 주세요. 예: member@example.test");
  return email;
}
export function validateSignup({ password, confirmation, understood }) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128)
    fail("비밀번호는 12~128자로 입력해 주세요.");
  if (password !== confirmation) fail("두 비밀번호가 일치하지 않아요.");
  if (!understood) fail("체험 안내를 확인해 주세요.");
}
export function inviteStatus(invite, now = Date.now()) {
  if (invite.revokedAt) return "revoked";
  if (invite.acceptedAt) return "accepted";
  return invite.expiresAt <= now ? "expired" : "pending";
}

// Screen sequencing only, never a recovery credential or an account lookup.
// No email, password, token, role, or user ID is retained. The real server's
// clock, single-use proof and request limits remain authoritative after API
// integration; this local deadline only rehearses a form becoming unavailable.
export class RecoveryPreview {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.leave();
  }
  leave() { this.stage = "idle"; this.expiresAt = null; }
  begin() { this.leave(); this.stage = "request"; }
  request(email) {
    if (this.stage !== "request") fail("다시 복구 안내를 요청해 주세요.");
    demoEmail(email);
    this.stage = "requested";
    this.expiresAt = this.now() + 15 * 60 * 1000;
  }
  unavailable() { this.stage = "unavailable"; this.expiresAt = null; }
  live(stage) {
    return this.stage === stage && Number.isFinite(this.expiresAt) && this.now() < this.expiresAt;
  }
  openReset() {
    if (!this.live("requested")) { this.unavailable(); return false; }
    this.stage = "reset";
    return true;
  }
  complete(input) {
    if (!this.live("reset")) { this.unavailable(); return false; }
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(key => !["password", "confirmation", "understood"].includes(key)))
      fail("비밀번호 입력과 체험 안내를 다시 확인해 주세요.");
    if (input.understood !== true) fail("체험 안내를 확인해 주세요.");
    validateSignup(input);
    this.stage = "complete";
    this.expiresAt = null;
    return true;
  }
}

export class OnboardingDemo {
  constructor({ now = () => Date.now(), id = () => crypto.randomUUID() } = {}) {
    this.now = now;
    this.id = id;
    this.members = [
      { id: "m1", name: "센터 매니저", email: "center@example.test", role: "center" },
      { id: "t1", name: "담당 치료사", email: "therapist@example.test", role: "therapist" },
      { id: "t2", name: "다른 치료사", email: "therapist-two@example.test", role: "therapist" },
      { id: "p1", name: "하루 보호자", email: "guardian@example.test", role: "guardian" },
    ];
    this.invitations = [];
  }
  manager(actor) {
    if (actor?.role !== "center" || actor.id !== "m1") fail("센터 화면에서 초대를 관리해 주세요.");
  }
  snapshot(actor) {
    this.manager(actor);
    return structuredClone({ members: this.members, invitations: this.invitations.map((i) => ({ ...i, status: inviteStatus(i, this.now()) })) });
  }
  invitation(id) {
    const found = this.invitations.find((i) => i.id === id);
    if (!found) fail("이 화면에서 만든 초대를 찾을 수 없어요. 센터에 다시 확인해 주세요.");
    return structuredClone({ ...found, status: inviteStatus(found, this.now()) });
  }
  existingAccounts() {
    const accounts = new Map([...EXISTING_ACCOUNTS, ...this.members.map(({ id, name, email }) => ({ id, name, email }))]
      .map((account) => [account.id, account]));
    return structuredClone([...accounts.values()]);
  }
  create(actor, input) {
    this.manager(actor);
    if (!["therapist", "guardian"].includes(input.role)) fail("초대 역할을 선택해 주세요.");
    const email = demoEmail(input.email);
    if (this.members.some((m) => m.email === email)) fail("이미 등록된 구성원이에요. 기존 계정 연결은 별도 확인이 필요해요.");
    if (this.invitations.some((i) => i.email === email && inviteStatus(i, this.now()) === "pending"))
      fail("같은 이메일에 수락 대기 중인 초대가 있어요.");
    const invite = { id: this.id(), centerId: DEMO_CENTER.id, email, role: input.role, createdAt: this.now(), expiresAt: this.now() + INVITE_TTL, revokedAt: null, acceptedAt: null };
    this.invitations.unshift(invite);
    return this.invitation(invite.id);
  }
  revoke(actor, id) {
    this.manager(actor);
    const invite = this.invitation(id);
    if (invite.status !== "pending") fail("수락 대기 중인 초대만 취소할 수 있어요.");
    this.invitations.find((i) => i.id === id).revokedAt = this.now();
  }
  reissue(actor, id) {
    this.manager(actor);
    const invite = this.invitation(id);
    if (!["expired", "revoked"].includes(invite.status)) fail("만료되거나 취소된 초대만 다시 만들 수 있어요.");
    return this.create(actor, invite);
  }
  accept(id, input) {
    const invite = this.invitation(id);
    if (invite.status !== "pending") fail("이미 수락했거나 종료된 초대예요. 센터에 새 초대를 요청해 주세요.");
    const name = String(input.name || "").trim();
    if (!name || name.length > 30) fail("체험 이름을 1~30자로 입력해 주세요.");
    validateSignup(input);
    if (EXISTING_ACCOUNTS.some((a) => a.email === invite.email)) fail("이미 Carebridge 계정이 있어요. ‘기존 계정으로 연결’을 선택해 주세요.");
    if (this.members.some((m) => m.email === invite.email)) fail("이미 계정이 있어요. 센터에 계정 연결을 요청해 주세요.");
    // Explicit allowlist: passwords, confirmations and form contents never enter state.
    const member = { id: this.id(), name, email: invite.email, role: invite.role };
    this.members.push(member);
    this.invitations.find((i) => i.id === id).acceptedAt = this.now();
    return structuredClone(member);
  }
  acceptExisting(id, input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => !["accountId", "centerId", "role", "understood"].includes(key)))
      fail("연결할 계정과 초대를 다시 확인해 주세요.");
    const invite = this.invitation(id);
    if (invite.status !== "pending") fail("이미 수락했거나 종료된 초대예요. 센터에 새 초대를 요청해 주세요.");
    const account = this.existingAccounts().find((a) => a.id === input.accountId);
    if (!account || account.email !== invite.email) fail("초대받은 이메일과 같은 체험 계정을 선택해 주세요.");
    if (input.centerId !== invite.centerId || input.role !== invite.role) fail("센터와 역할이 달라졌어요. 초대 화면을 다시 열어 확인해 주세요.");
    if (input.understood !== true) fail("센터·역할과 체험 안내를 확인해 주세요.");
    const current = this.members.find((m) => m.id === account.id || m.email === account.email);
    if (current && (current.id !== account.id || current.role !== invite.role || current.active === false))
      fail("현재 센터 소속을 이 초대로 변경할 수 없어요. 센터에 확인해 주세요.");
    const member = current || { id: account.id, name: account.name, email: account.email, role: invite.role };
    if (!current) this.members.push(member);
    this.invitations.find((i) => i.id === id).acceptedAt = this.now();
    return structuredClone(member);
  }
}
