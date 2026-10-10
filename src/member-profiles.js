import { ACCOUNTS, DEMO_CENTER, GUARDIANS, THERAPISTS } from "./config.js";
import { memberDisplayName } from "./profile-fields.js";

// A local fixture registry, NOT authentication or a server roster. New invite
// rehearsal accounts do not acquire child access or a persisted profile here.
const registry = new Map([
  ...THERAPISTS.map((member) => [member.id, { ...member, role: "therapist" }]),
  ...GUARDIANS.map((member) => [member.id, { ...member, role: "guardian" }]),
  [ACCOUNTS.center.id, ACCOUNTS.center],
]);
export function demoMember(db, userId) {
  const member = registry.get(userId);
  if (!member) return null;
  const displayName = db.memberProfiles?.find((row) => row.centerId === DEMO_CENTER.id && row.userId === userId)?.displayName ?? null;
  return { id: member.id, role: member.role, name: displayName ?? member.name, defaultName: member.name, displayName };
}
export function memberName(db, userId) {
  return demoMember(db, userId)?.name ?? "이전 참여자";
}
export function validMemberProfiles(db) {
  if (!Object.hasOwn(db, "memberProfiles")) return true; // Old data is not rewritten on load.
  const rows = db.memberProfiles;
  if (!Array.isArray(rows) || rows.length > registry.size || Object.keys(rows).length !== rows.length ||
      Object.keys(rows).some((key, index) => key !== String(index))) return false;
  const seen = new Set();
  return rows.every((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 3 ||
        Object.keys(row).some((key) => !["centerId", "userId", "displayName"].includes(key)) ||
        row.centerId !== DEMO_CENTER.id || !registry.has(row.userId) || seen.has(row.userId)) return false;
    seen.add(row.userId);
    try { return memberDisplayName(row.displayName) === row.displayName; }
    catch { return false; }
  });
}
export function saveDemoSelfProfile(db, actor, input) {
  const known = registry.get(actor?.id);
  if (!known || known.role !== actor.role || !input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== 1 || !Object.hasOwn(input, "displayName"))
    throw new Error("현재 체험 계정의 표시 이름만 변경할 수 있어요.");
  const displayName = memberDisplayName(input.displayName);
  db.memberProfiles ??= [];
  const current = db.memberProfiles.find((row) => row.centerId === DEMO_CENTER.id && row.userId === actor.id);
  if (current) current.displayName = displayName;
  else db.memberProfiles.push({ centerId: DEMO_CENTER.id, userId: actor.id, displayName });
}
