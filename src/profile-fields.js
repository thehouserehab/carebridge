// Shared, strict profile content rules. No credentials or clinical fields.
export class ProfileFieldError extends Error {}
const fail = (message) => { throw new ProfileFieldError(message); };
// null explicitly clears a center-scoped display name. Empty/control-bearing
// strings are not silently converted into a different identity label.
export function memberDisplayName(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !value.isWellFormed() || value.length > 30 || !value.trim() ||
      /[\x00-\x1f\x7f-\x9f]/.test(value)) fail("표시 이름은 줄바꿈 없이 1~30자로 입력하거나 비워 주세요.");
  return value.trim();
}
export function memberDisplayNameForm(value) {
  return memberDisplayName(value === "" ? null : value);
}
const ageValid = (value) => Number.isInteger(value) && value >= 0 && value <= 26;
function basisDate(value) {
  if (typeof value !== "string" || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) || value < "1900-01-01" ||
      Number.isNaN(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value)
    fail("연령 기준일을 확인해 주세요.");
  return value;
}
export function childProfileFields(input, { today = null } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !["name", "age", "ageAsOf"].includes(key))) fail("기본정보를 확인해 주세요.");
  const name = input.name;
  if (typeof name !== "string" || !name.isWellFormed() || name.length > 30 || !name.trim() ||
      /[\x00-\x1f\x7f-\x9f]/.test(name)) fail("이름은 줄바꿈 없이 1~30자로 입력해 주세요.");
  const age = input.age ?? null, ageAsOf = input.ageAsOf ?? null;
  if ((age === null) !== (ageAsOf === null)) fail("연령과 기준일을 함께 입력하거나 두 칸 모두 비워 주세요.");
  if (age !== null && !ageValid(age)) fail("연령은 0~26세 정수로 입력해 주세요.");
  if (ageAsOf !== null) {
    basisDate(ageAsOf);
    if (today !== null && ageAsOf > basisDate(today)) fail("연령 기준일은 오늘 이후로 정할 수 없어요.");
  }
  return { name: name.trim(), age, ageAsOf };
}
// Only the form adapter converts strings; shared/server content never coerces.
export function childProfileFormValues(input) {
  if (typeof input.age !== "string" || (input.age !== "" && !/^\d{1,2}$/.test(input.age)) ||
      typeof input.ageAsOf !== "string") fail("연령과 기준일 입력을 확인해 주세요.");
  return { name: input.name, age: input.age === "" ? null : Number(input.age), ageAsOf: input.ageAsOf || null };
}
export function profileToday(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return ["year", "month", "day"].map((key) => parts.find((part) => part.type === key).value).join("-");
}
export function validChildAge(child) {
  // Legacy integer ages have no known basis date. Never invent one at load.
  if (!Object.hasOwn(child, "ageAsOf")) return ageValid(child.age);
  if (child.age === null && child.ageAsOf === null) return true;
  try { return ageValid(child.age) && basisDate(child.ageAsOf) === child.ageAsOf; }
  catch { return false; }
}
