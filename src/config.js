export const BRAND = {
  name: "Carebridge",
  tagline: "함께 이어가는 기록",
  version: "로컬 프로토타입",
};
// Only the local rehearsal center. Never a production membership claim.
export const DEMO_CENTER = Object.freeze({ id: "demo-center", name: "Carebridge 체험 센터" });
export const ACCOUNTS = {
  therapist: {
    id: "t1",
    role: "therapist",
    name: "담당 치료사",
    label: "치료사",
  },
  guardian: {
    id: "p1",
    role: "guardian",
    name: "하루 보호자",
    label: "보호자",
  },
  center: { id: "m1", role: "center", name: "센터 매니저", label: "센터" },
};
export const THERAPISTS = [
  { id: "t1", name: "담당 치료사" },
  { id: "t2", name: "다른 치료사" },
];
export const GUARDIANS = [
  { id: "p1", name: "하루 보호자" },
  { id: "p2", name: "나무 보호자" },
  { id: "p3", name: "여울 보호자" },
];
export const STORAGE_KEY = "child-development-demo-v2";
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
