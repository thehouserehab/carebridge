import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/seed.js";
import { ACCOUNTS, today, STORAGE_KEY } from "../src/config.js";
import {
  project,
  mutate,
  accessibleChildren,
  validateState,
} from "../src/domain.js";
import { load, persist } from "../src/repository.js";
const therapist = ACCOUNTS.therapist,
  guardian = ACCOUNTS.guardian,
  center = ACCOUNTS.center;
const record = {
  childId: "c1",
  goalId: "g1",
  date: today(),
  title: "새 기록",
  summary: "공유 내용",
  privateNote: "INTERNAL SECRET",
  nextPlan: "내부 계획",
  assessment: {
    tool: "직접 관찰",
    item: "참여 시간",
    value: 8,
    unit: "분",
    context: "가상 조건",
  },
  activity: {
    title: "가족 놀이",
    instruction: "경험을 남겨 주세요.",
    frequency: "한 번",
    caution: "가상 활동",
  },
  appointmentId: "a1",
};
test("담당 관계와 역할별 읽기 모델이 아동 및 임상 데이터를 분리한다", () => {
  const db = seed();
  assert.equal(accessibleChildren(db, therapist).length, 2);
  assert.equal(accessibleChildren(db, guardian).length, 1);
  assert.throws(() => project(db, guardian, "c2"));
  assert.throws(() => project(db, therapist, "c3"));
  const admin = project(db, center, "c1");
  assert.equal(admin.records.length, 0);
  assert.equal(admin.goals.length, 0);
  assert.equal(admin.publications.length, 0);
  assert.equal(admin.child.concern, undefined);
  const p = project(db, guardian, "c1");
  assert.equal(p.records.length, 0);
  assert.equal(p.publications.length, 1);
  assert.ok(!JSON.stringify(p).includes("가상 내부 메모"));
});
test("작성→공유→피드백→확인→수정→재공유→철회의 전체 관계를 보존한다", () => {
  let db = mutate(seed(), therapist, "record", record);
  const r = db.records.at(-1);
  assert.equal(project(db, guardian, "c1").publications.length, 1);
  db = mutate(db, therapist, "publish", { childId: "c1", id: r.id });
  const pub = db.publications.at(-1);
  assert.equal(pub.privateNote, undefined);
  assert.equal(pub.assessment, undefined);
  assert.equal(pub.nextPlan, undefined);
  db = mutate(db, guardian, "feedback", {
    childId: "c1",
    publicationId: pub.id,
    date: today(),
    result: "partial",
    reaction: "재미있었어요",
    difficulty: "조금 피곤했어요",
  });
  const f = db.feedback.at(-1);
  db = mutate(db, therapist, "review", {
    childId: "c1",
    id: f.id,
    reviewNote: "다음 시간에 난이도 논의",
  });
  assert.equal(
    project(db, guardian, "c1").feedback.at(-1).reviewNote,
    undefined,
  );
  assert.equal(
    project(db, therapist, "c1").feedback.at(-1).reviewNote,
    "다음 시간에 난이도 논의",
  );
  db = mutate(db, therapist, "record", {
    ...record,
    id: r.id,
    summary: "새로운 공유 초안",
  });
  assert.equal(
    project(db, guardian, "c1").publications.at(-1).summary,
    "공유 내용",
  );
  db = mutate(db, therapist, "publish", { childId: "c1", id: r.id });
  const newer = db.publications.at(-1);
  assert.notEqual(newer.id, pub.id);
  assert.equal(db.feedback[0].publicationId, pub.id);
  assert.throws(() =>
    mutate(db, guardian, "feedback", {
      childId: "c1",
      publicationId: pub.id,
      date: today(),
      result: "done",
      reaction: "오래된 활동",
    }),
  );
  db = mutate(db, therapist, "unpublish", { childId: "c1", id: r.id });
  assert.ok(
    !project(db, guardian, "c1").publications.some((p) => p.recordId === r.id),
  );
  assert.equal(db.feedback.length, 1);
  assert.equal(validateState(db), true);
});
test("권한 없는 변경, 다른 아동 목표, 일정 중복 기록을 거부한다", () => {
  const db = seed();
  assert.throws(() => mutate(db, guardian, "record", record));
  assert.throws(() => mutate(db, center, "record", record));
  assert.throws(() =>
    mutate(db, therapist, "record", { ...record, goalId: "g3" }),
  );
  assert.throws(() =>
    mutate(db, therapist, "record", { ...record, childId: "c3" }),
  );
  const withRecord = mutate(db, therapist, "record", record);
  assert.throws(() => mutate(withRecord, therapist, "record", record), /이미/);
  assert.equal(db.records.length, 2);
});
test("평가 숫자·조건·내용 검증을 적용하고 임의 점수를 산정하지 않는다", () => {
  assert.throws(() =>
    mutate(seed(), therapist, "record", {
      ...record,
      assessment: { ...record.assessment, value: "" },
    }),
  );
  assert.throws(() =>
    mutate(seed(), therapist, "record", {
      ...record,
      assessment: { ...record.assessment, value: "Infinity" },
    }),
  );
  assert.throws(() =>
    mutate(seed(), therapist, "record", {
      ...record,
      assessment: { ...record.assessment, context: "" },
    }),
  );
  assert.throws(() =>
    mutate(seed(), therapist, "record", { ...record, date: "2026-02-30" }),
  );
  const db = mutate(seed(), therapist, "record", record);
  assert.deepEqual(db.records.at(-1).assessment, record.assessment);
});
test("보호자 관심사와 치료사의 공동 목표 변경이 연결된다", () => {
  let db = mutate(seed(), guardian, "concern", {
    childId: "c1",
    concern: "함께 산책하고 싶어요",
  });
  assert.equal(
    project(db, therapist, "c1").child.concern,
    "함께 산책하고 싶어요",
  );
  db = mutate(db, therapist, "goal", {
    childId: "c1",
    title: "가족 산책 참여",
    description: "생활 목표",
    status: "active",
  });
  const goal = db.goals.at(-1);
  db = mutate(db, therapist, "goal", { ...goal, status: "achieved" });
  assert.equal(project(db, guardian, "c1").goals.at(-1).status, "achieved");
  assert.throws(() =>
    mutate(db, guardian, "goal", { ...goal, status: "active" }),
  );
});
test("새 아동과 일정, 출결 변경 및 시간 충돌을 검증한다", () => {
  let db = mutate(seed(), center, "child", {
    name: "가상 별",
    age: 6,
    therapistId: "t1",
  });
  const c = db.children.at(-1);
  assert.ok(accessibleChildren(db, therapist).some((x) => x.id === c.id));
  assert.ok(!accessibleChildren(db, guardian).some((x) => x.id === c.id));
  const appt = {
    childId: c.id,
    date: today(),
    time: "16:00",
    duration: 40,
    title: "상담",
    room: "상담실",
    status: "scheduled",
  };
  db = mutate(db, center, "appointment", appt);
  const a = db.appointments.at(-1);
  db = mutate(db, center, "appointment", { ...a, status: "attended" });
  assert.equal(db.appointments.at(-1).status, "attended");
  assert.throws(
    () => mutate(db, center, "appointment", { ...appt, time: "16:20" }),
    /겹칩니다/,
  );
  assert.throws(() =>
    mutate(db, center, "appointment", { ...appt, time: "23:50" }),
  );
  assert.throws(() =>
    mutate(db, center, "appointment", { ...appt, time: "25:00" }),
  );
  assert.throws(() => mutate(db, guardian, "appointment", appt));
});
function memory() {
  let raw = null;
  return {
    getItem: () => raw,
    setItem: (k, v) => {
      raw = v;
    },
    raw: () => raw,
  };
}
test("새로 불러오기·revision 충돌·저장 실패를 처리하며 손상 원본을 덮어쓰지 않는다", () => {
  const store = memory();
  const db = load(store).db;
  const next = mutate(db, guardian, "concern", {
    childId: "c1",
    concern: "기록",
  });
  persist(store, next, 0);
  assert.equal(load(store).db.children[0].concern, "기록");
  assert.throws(() => persist(store, next, 0), /다른 탭/);
  assert.throws(
    () =>
      persist(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
        },
        next,
        0,
      ),
    /저장 공간/,
  );
  store.setItem(STORAGE_KEY, "broken");
  assert.equal(load(store).db, null);
  assert.equal(store.raw(), "broken");
  assert.throws(() => persist(store, next, 0), /손상/);
});
test("연결이 손상된 저장 데이터를 거부한다", () => {
  const db = seed();
  db.records[0].goalId = "missing";
  assert.equal(validateState(db), false);
  const other = seed();
  other.feedback.push({ id: "f1", childId: "c2", publicationId: "pub1" });
  assert.equal(validateState(other), false);
  const missing = seed();
  delete missing.publications[0].summary;
  assert.equal(validateState(missing), false);
  const malformed = seed();
  malformed.records[0].activity = { title: "broken" };
  assert.equal(validateState(malformed), false);
  assert.equal(validateState(seed()), true);
});
