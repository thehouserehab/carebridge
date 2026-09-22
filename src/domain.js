import { THERAPISTS } from "./config.js";
import { accessibleChildren } from "./access.js";
export { accessibleChildren } from "./access.js";
import { normalizeAttachments, attachmentListValid } from "./media-policy.js";
import {
  upgradeState,
  synchronizeEvents,
  changeConversation,
  validConversations,
} from "./conversations.js";
import { recordFields, validRecordFields } from "./record-fields.js";
const fail = (message) => {
  throw new Error(message);
};
const text = (value, label, required = true, max = 2000) => {
  const s = String(value ?? "").trim();
  if (required && !s) fail(`${label}을(를) 입력해 주세요.`);
  if (s.length > max) fail(`${label}은(는) ${max}자 이내로 입력해 주세요.`);
  return s;
};
const oneOf = (v, options, label) =>
  options.includes(v) ? v : fail(`${label}을(를) 확인해 주세요.`);
const validDate = (v) => {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    Number.isNaN(Date.parse(`${v}T12:00:00Z`)) ||
    new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) !== v
  )
    fail("날짜를 확인해 주세요.");
  return v;
};
const uid = () => globalThis.crypto.randomUUID();
function childAccess(db, actor, id, roles) {
  if (!roles.includes(actor.role))
    fail("이 역할에서 사용할 수 없는 작업입니다.");
  const c = accessibleChildren(db, actor).find((c) => c.id === id);
  if (!c) fail("접근할 수 없는 아동입니다.");
  return c;
}
function linked(db, collection, id, childId, label) {
  const entry = db[collection].find(
    (x) => x.id === id && x.childId === childId,
  );
  if (!entry) fail(`${label} 연결을 확인해 주세요.`);
  return entry;
}
export function currentPublications(db, childId) {
  return db.records
    .filter((r) => r.childId === childId && r.publicationId)
    .map((r) => db.publications.find((p) => p.id === r.publicationId))
    .filter(Boolean);
}
export function project(db, actor, childId) {
  const children = accessibleChildren(db, actor).map((c) =>
    actor.role === "center"
      ? {
          id: c.id,
          name: c.name,
          age: c.age,
          therapistId: c.therapistId,
          color: c.color,
        }
      : structuredClone(c),
  );
  const c = children.find((c) => c.id === childId);
  if (!c) fail("접근할 수 없는 아동입니다.");
  const base = {
    children,
    child: c,
    appointments: db.appointments.filter((a) => a.childId === childId),
    goals: [],
    records: [],
    publications: [],
    feedback: [],
  };
  if (actor.role === "center")
    return {
      ...base,
      recordCount: db.records.filter((r) => r.childId === childId).length,
    };
  const publications =
    actor.role === "guardian"
      ? currentPublications(db, childId)
      : db.publications.filter((p) => p.childId === childId);
  const pubIds = new Set(publications.map((p) => p.id));
  return structuredClone({
    ...base,
    goals: db.goals.filter((g) => g.childId === childId),
    records:
      actor.role === "therapist"
        ? db.records.filter((r) => r.childId === childId)
        : [],
    publications,
    feedback: db.feedback
      .filter((f) => pubIds.has(f.publicationId))
      .map((f) =>
        actor.role === "guardian"
          ? {
              id: f.id,
              publicationId: f.publicationId,
              childId: f.childId,
              date: f.date,
              result: f.result,
              reaction: f.reaction,
              difficulty: f.difficulty,
              reviewed: f.reviewed,
              attachments: f.attachments ?? [],
            }
          : f,
      ),
  });
}
export function mutate(
  db,
  actor,
  action,
  input,
  now = new Date().toISOString(),
) {
  const next = structuredClone(upgradeState(db));
  if (["message", "read", "message-review"].includes(action)) {
    changeConversation(next, actor, action, input, now);
  } else if (action === "child") {
    if (actor.role !== "center") fail("센터 화면에서 아동을 등록해 주세요.");
    const age = Number(input.age);
    if (!Number.isInteger(age) || age < 0 || age > 26)
      fail("연령은 0~26세로 입력해 주세요.");
    oneOf(
      input.therapistId,
      THERAPISTS.map((t) => t.id),
      "담당 치료사",
    );
    next.children.push({
      id: uid(),
      name: text(input.name, "이름", true, 30),
      age,
      therapistId: input.therapistId,
      guardianIds: [],
      concern: "",
      color: "green",
    });
  } else {
    const roles = {
      concern: ["guardian"],
      goal: ["therapist"],
      record: ["therapist"],
      publish: ["therapist"],
      unpublish: ["therapist"],
      feedback: ["guardian"],
      review: ["therapist"],
      appointment: ["therapist", "center"],
    };
    if (!roles[action]) fail("알 수 없는 작업입니다.");
    const child = childAccess(next, actor, input.childId, roles[action]);
    if (action === "concern")
      child.concern = text(input.concern, "관심사", false, 1000);
    if (action === "goal") {
      const old = input.id
        ? linked(next, "goals", input.id, child.id, "목표")
        : null;
      const goal = {
        id: old?.id ?? uid(),
        childId: child.id,
        title: text(input.title, "목표", true, 100),
        description: text(input.description, "설명", false),
        status: oneOf(
          input.status ?? "active",
          ["active", "achieved", "paused"],
          "목표 상태",
        ),
        updatedAt: now,
      };
      if (old) Object.assign(old, goal);
      else next.goals.push(goal);
    }
    if (action === "record") {
      linked(next, "goals", input.goalId, child.id, "목표");
      if (input.appointmentId)
        linked(next, "appointments", input.appointmentId, child.id, "일정");
      const old = input.id
        ? linked(next, "records", input.id, child.id, "기록")
        : null;
      if (
        input.appointmentId &&
        next.records.some(
          (r) => r.appointmentId === input.appointmentId && r.id !== old?.id,
        )
      )
        fail("이 일정의 기록이 이미 있습니다. 기존 기록을 수정해 주세요.");
      const structured = recordFields(input, old, next, child.id);
      let activity = null;
      if (input.activity)
        activity = {
          title: text(input.activity.title, "활동 이름", true, 100),
          instruction: text(input.activity.instruction, "활동 안내"),
          frequency: text(input.activity.frequency, "활동 빈도", true, 100),
          caution: text(input.activity.caution, "유의사항", false, 500),
        };
      const row = {
        id: old?.id ?? uid(),
        childId: child.id,
        goalId: input.goalId,
        date: validDate(input.date),
        title: text(
          input.title ||
            `${input.date} ${structured.performed.slice(0, 50) || "세션 기록"}`,
          "기록 제목",
          true,
          100,
        ),
        summary: text(input.summary, "보호자 공유 내용", false),
        privateNote: text(input.privateNote, "내부 메모", false),
        nextPlan: text(input.nextPlan, "다음 회기 메모", false),
        ...structured,
        activity,
        attachments: normalizeAttachments(
          input.attachments ?? old?.attachments ?? [],
        ),
        appointmentId: input.appointmentId ?? "",
        publicationId: old?.publicationId ?? null,
        updatedAt: now,
      };
      if (
        row.status !== "draft" &&
        !row.summary &&
        !row.privateNote &&
        !row.performed &&
        !row.response &&
        !row.nextPlan &&
        !row.assessments.length &&
        !(
          row.observation?.status === "observed" &&
          Object.entries(row.observation).some(
            ([key, value]) => key !== "status" && value.trim(),
          )
        )
      )
        fail(
          "정식 기록에는 활동·반응·계획이나 관찰 내용을 작성해 주세요. 빈 기록은 초안으로 저장할 수 있어요.",
        );
      if (old) Object.assign(old, row);
      else next.records.push(row);
    }
    if (action === "publish" || action === "unpublish") {
      const r = linked(next, "records", input.id, child.id, "기록");
      if (action === "unpublish") {
        r.publicationId = null;
      } else {
        if (r.status === "draft")
          fail("초안을 정식 기록으로 저장한 뒤 공유해 주세요.");
        if (!child.guardianIds.length)
          fail("연결된 보호자가 없어 공유할 수 없어요.");
        const summary = text(r.summary, "보호자 공유 내용");
        const id = uid();
        next.publications.push({
          id,
          recordId: r.id,
          childId: r.childId,
          goalId: r.goalId,
          date: r.date,
          title: r.title,
          summary,
          activity: structuredClone(r.activity),
          attachments: normalizeAttachments(r.attachments ?? []).filter(
            (file) => file.share,
          ),
          sharedAt: now,
        });
        r.publicationId = id;
      }
    }
    if (action === "feedback") {
      const pub = linked(
        next,
        "publications",
        input.publicationId,
        child.id,
        "공유 기록",
      );
      if (
        !currentPublications(next, child.id).some((p) => p.id === pub.id) ||
        !pub.activity
      )
        fail("현재 공유 중인 활동이 아닙니다.");
      const old = input.id
        ? linked(next, "feedback", input.id, child.id, "피드백")
        : null;
      if (old && (old.publicationId !== pub.id || old.authorId !== actor.id))
        fail("수정할 수 없는 피드백입니다.");
      const row = {
        id: old?.id ?? uid(),
        childId: child.id,
        publicationId: pub.id,
        authorId: actor.id,
        date: validDate(input.date),
        result: oneOf(
          input.result,
          ["done", "partial", "skipped"],
          "수행 상태",
        ),
        reaction: text(input.reaction, "아이 반응", true, 1000),
        difficulty: text(input.difficulty, "어려움", false, 1000),
        reviewed: false,
        reviewNote: "",
        attachments: normalizeAttachments(
          input.attachments ?? old?.attachments ?? [],
        ).map((file) => ({ ...file, share: true })),
        updatedAt: now,
      };
      if (old) Object.assign(old, row);
      else next.feedback.push(row);
    }
    if (action === "review") {
      const f = linked(next, "feedback", input.id, child.id, "피드백");
      f.reviewed = true;
      f.reviewNote = text(input.reviewNote, "다음 회기 반영 메모", true);
      f.reviewedAt = now;
    }
    if (action === "appointment") {
      const old = input.id
        ? linked(next, "appointments", input.id, child.id, "일정")
        : null;
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))
        fail("시간을 확인해 주세요.");
      const duration = Number(input.duration);
      if (!Number.isInteger(duration) || duration < 10 || duration > 180)
        fail("진행 시간은 10~180분으로 입력해 주세요.");
      const row = {
        id: old?.id ?? uid(),
        childId: child.id,
        date: validDate(input.date),
        time: input.time,
        duration,
        title: text(input.title, "일정 이름", true, 100),
        room: text(input.room, "장소", true, 60),
        status: oneOf(
          input.status ?? "scheduled",
          ["scheduled", "attended", "absent", "cancelled"],
          "일정 상태",
        ),
      };
      const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      if (mins(row.time) + duration > 1440)
        fail("일정은 같은 날 안에 끝나야 합니다.");
      if (
        row.status !== "cancelled" &&
        next.appointments.some(
          (a) =>
            a.id !== row.id &&
            a.date === row.date &&
            a.status !== "cancelled" &&
            (a.childId === child.id ||
              a.room === row.room ||
              next.children.find((c) => c.id === a.childId)?.therapistId ===
                child.therapistId) &&
            mins(a.time) < mins(row.time) + duration &&
            mins(row.time) < mins(a.time) + a.duration,
        )
      )
        fail("아동·담당 치료사·장소의 다른 일정과 시간이 겹칩니다.");
      if (old) Object.assign(old, row);
      else next.appointments.push(row);
    }
  }
  synchronizeEvents(next);
  next.revision = db.revision + 1;
  return next;
}
export function validateState(db) {
  if (
    !db ||
    ![2, 3].includes(db.schema) ||
    !Number.isInteger(db.revision) ||
    db.revision < 0
  )
    return false;
  const keys = [
    "children",
    "goals",
    "records",
    "publications",
    "feedback",
    "appointments",
  ];
  if (
    !keys.every(
      (k) =>
        Array.isArray(db[k]) &&
        db[k].every((x) => x && typeof x.id === "string") &&
        new Set(db[k].map((x) => x.id)).size === db[k].length,
    )
  )
    return false;
  const childIds = new Set(db.children.map((c) => c.id));
  const strings = (row, fields) =>
    fields.every((k) => typeof row[k] === "string");
  const dateOK = (v) => {
    try {
      return typeof v === "string" && validDate(v) === v;
    } catch {
      return false;
    }
  };
  const activityOK = (a) =>
    a === null ||
    (a && strings(a, ["title", "instruction", "frequency", "caution"]));
  const assessmentOK = (a) =>
    a === null ||
    (a &&
      strings(a, ["tool", "item", "unit", "context"]) &&
      Number.isFinite(a.value));
  if (
    !db.children.length ||
    !db.children.every(
      (c) =>
        strings(c, ["name", "therapistId", "concern", "color"]) &&
        Array.isArray(c.guardianIds) &&
        c.guardianIds.every((x) => typeof x === "string") &&
        Number.isInteger(c.age) &&
        c.age >= 0 &&
        c.age <= 26 &&
        THERAPISTS.some((t) => t.id === c.therapistId),
    )
  )
    return false;
  if (!keys.slice(1).every((k) => db[k].every((x) => childIds.has(x.childId))))
    return false;
  if (
    !db.goals.every(
      (g) =>
        strings(g, ["title", "description", "updatedAt"]) &&
        ["active", "achieved", "paused"].includes(g.status),
    )
  )
    return false;
  if (
    !db.records.every(
      (r) =>
        strings(r, [
          "title",
          "summary",
          "privateNote",
          "nextPlan",
          "updatedAt",
          "appointmentId",
        ]) &&
        dateOK(r.date) &&
        activityOK(r.activity) &&
        assessmentOK(r.assessment) &&
        attachmentListValid(r.attachments ?? []) &&
        db.goals.some((g) => g.id === r.goalId && g.childId === r.childId) &&
        (!r.appointmentId ||
          db.appointments.some(
            (a) => a.id === r.appointmentId && a.childId === r.childId,
          )) &&
        (r.publicationId === null ||
          db.publications.some(
            (p) =>
              p.id === r.publicationId &&
              p.recordId === r.id &&
              p.childId === r.childId,
          )),
    )
  )
    return false;
  if (
    !db.publications.every(
      (p) =>
        strings(p, ["title", "summary", "sharedAt"]) &&
        dateOK(p.date) &&
        activityOK(p.activity) &&
        attachmentListValid(p.attachments ?? []) &&
        db.records.some(
          (r) => r.id === p.recordId && r.childId === p.childId,
        ) &&
        db.goals.some((g) => g.id === p.goalId && g.childId === p.childId),
    )
  )
    return false;
  if (
    !db.appointments.every(
      (a) =>
        strings(a, ["title", "room"]) &&
        dateOK(a.date) &&
        typeof a.time === "string" &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(a.time) &&
        Number.isInteger(a.duration) &&
        a.duration >= 10 &&
        a.duration <= 180 &&
        ["scheduled", "attended", "absent", "cancelled"].includes(a.status),
    )
  )
    return false;
  if (
    db.schema === 3 &&
    (!validConversations(db) ||
      !db.records.every((r) => validRecordFields(r, db)))
  )
    return false;
  return db.feedback.every(
    (f) =>
      strings(f, [
        "authorId",
        "reaction",
        "difficulty",
        "reviewNote",
        "updatedAt",
      ]) &&
      dateOK(f.date) &&
      typeof f.reviewed === "boolean" &&
      attachmentListValid(f.attachments ?? []) &&
      ["done", "partial", "skipped"].includes(f.result) &&
      db.publications.some(
        (p) => p.id === f.publicationId && p.childId === f.childId,
      ),
  );
}
