import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/seed.js";
import { ACCOUNTS, STORAGE_KEY, today } from "../src/config.js";
import { mutate, validateState } from "../src/domain.js";
import {
  upgradeState,
  conversationView,
  conversationList,
} from "../src/conversations.js";
import { load, BACKUP_KEY } from "../src/repository.js";
const t = ACCOUNTS.therapist,
  p = ACCOUNTS.guardian;
const start = () => upgradeState(seed());
const send = (db, actor, body, extra = {}) =>
  mutate(db, actor, "message", {
    childId: "c1",
    clientId: crypto.randomUUID(),
    body,
    ...extra,
  });
test("대화 권한·홈 집계·사용자별 읽음과 임상 반영을 분리한다", () => {
  let db = start();
  db = send(db, p, "가정 소식");
  const id = db.messages.at(-1).id;
  db = send(db, { id: "p2", role: "guardian" }, "나무 소식", { childId: "c2" });
  assert.equal(conversationList(db, t).length, 2);
  assert.equal(conversationList(db, p).length, 1);
  assert.equal(conversationList(db, ACCOUNTS.center).length, 0);
  assert.throws(() => conversationView(db, p, "c2"));
  assert.throws(() => send(db, ACCOUNTS.center, "운영자 임상 접근"));
  assert.equal(conversationView(db, t, "c1").unread, 1);
  db = mutate(db, t, "read", { childId: "c1", id });
  assert.equal(conversationView(db, t, "c1").unread, 0);
  assert.equal(conversationView(db, t, "c2").unread, 1);
  assert.equal(db.messages.find((m) => m.id === id).reviewed, undefined);
  db = mutate(db, t, "message-review", {
    childId: "c1",
    id,
    reviewNote: "PRIVATE CLINICAL PLAN",
  });
  assert.ok(
    !JSON.stringify(conversationView(db, p, "c1")).includes(
      "PRIVATE CLINICAL PLAN",
    ),
  );
  assert.equal(conversationView(db, p, "c1").messages.at(-1).read, true);
  assert.equal(validateState(db), true);
});
test("전송 재시도는 같은 ID로 한 번만 저장하고 충돌·다른 방 인용은 거부한다", () => {
  let db = start();
  const input = {
    childId: "c1",
    clientId: crypto.randomUUID(),
    body: "같은 발신",
  };
  db = mutate(db, p, "message", input);
  db = mutate(db, p, "message", input);
  assert.equal(db.messages.filter((m) => m.id === input.clientId).length, 1);
  assert.throws(() => mutate(db, p, "message", { ...input, body: "변경" }));
  assert.throws(() =>
    send(db, t, "잘못된 방 인용", { childId: "c2", replyTo: input.clientId }),
  );
  assert.throws(() => send(db, p, "접근 불가", { childId: "c2" }));
  assert.equal(validateState(db), true);
});
test("재공유·철회 후 기존 답변 연결과 독립 메시지는 보존하고 공유 내용은 가린다", () => {
  let db = send(start(), p, "이 기록 질문", { replyTo: "publication-pub1" });
  const reply = db.messages.at(-1).id;
  db = send(db, t, "공개 답변", { replyTo: reply });
  db = mutate(db, t, "publish", { childId: "c1", id: "r1" });
  const newer = db.publications.at(-1).id;
  const guardian = conversationView(db, p, "c1");
  assert.equal(
    guardian.messages.find((m) => m.id === "publication-pub1").publication,
    undefined,
  );
  assert.equal(
    guardian.messages.find((m) => m.id === reply).quote.hidden,
    true,
  );
  assert.equal(
    guardian.messages.find((m) => m.id === reply).body,
    "이 기록 질문",
  );
  assert.equal(
    db.messages.find((m) => m.id === reply).replyTo,
    "publication-pub1",
  );
  assert.throws(() =>
    send(db, p, "늦은 답변", { replyTo: "publication-pub1" }),
  );
  assert.ok(
    conversationView(db, t, "c1").messages.find(
      (m) => m.id === "publication-pub1",
    ).publication,
  );
  db = mutate(db, t, "unpublish", { childId: "c1", id: "r1" });
  assert.equal(
    conversationView(db, p, "c1").messages.find(
      (m) => m.id === `publication-${newer}`,
    ).hidden,
    true,
  );
  assert.equal(
    conversationView(db, p, "c1").messages.filter((m) => m.type === "text")
      .length,
    2,
  );
  assert.equal(validateState(db), true);
});
test("활동 피드백 수정은 원본 참조 카드를 중복 생성하지 않는다", () => {
  const input = {
    childId: "c1",
    publicationId: "pub1",
    date: today(),
    result: "done",
    reaction: "해봤어요",
  };
  let db = mutate(start(), p, "feedback", input);
  db = mutate(db, p, "feedback", {
    ...input,
    id: db.feedback[0].id,
    reaction: "바꾼 반응",
  });
  const messages = conversationView(db, t, "c1").messages.filter(
    (m) => m.type === "feedback",
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "바꾼 반응");
});
test("빈 초안·기본3항목·복수 평가·대화 참고 저장과 공유 경계를 검증한다", () => {
  let db = send(start(), p, "기록 참고 소식");
  const reference = db.messages.at(-1).id;
  const blank = { childId: "c1", goalId: "g1", date: today(), status: "draft" };
  db = mutate(db, t, "record", blank);
  const id = db.records.at(-1).id;
  assert.throws(() => mutate(db, t, "publish", { childId: "c1", id }), /초안/);
  assert.throws(
    () => mutate(db, t, "record", { ...blank, status: "saved" }),
    /정식/,
  );
  assert.throws(
    () =>
      mutate(db, t, "record", {
        ...blank,
        status: "saved",
        observation: { status: "observed" },
      }),
    /정식/,
  );
  const a = {
    tool: "직접 관찰",
    item: "횟수",
    value: 0,
    unit: "회",
    context: "동일한 조건",
  };
  db = mutate(db, t, "record", {
    ...blank,
    id,
    status: "saved",
    performed: "가상 활동",
    response: "가상 반응",
    nextPlan: "PRIVATE PLAN",
    summary: "공유 요약",
    assessments: [a, { ...a, item: "시간", value: 2, unit: "분" }],
    referenceMessageIds: [reference],
    observation: { status: "not-observed" },
  });
  assert.equal(db.records.at(-1).assessments.length, 2);
  assert.equal(db.records.at(-1).assessments[0].value, 0);
  assert.equal(db.records.at(-1).observation.repetitions, "");
  db = mutate(db, t, "publish", { childId: "c1", id });
  assert.ok(
    !JSON.stringify(conversationView(db, p, "c1")).includes("PRIVATE PLAN"),
  );
  assert.equal(db.records.at(-1).referenceMessageIds[0], reference);
  assert.throws(() =>
    mutate(db, t, "record", { ...blank, assessments: [{ ...a, value: "" }] }),
  );
  assert.throws(() =>
    mutate(db, t, "record", {
      ...blank,
      observation: { status: "not-observed", task: "모순된 내용" },
    }),
  );
  assert.equal(validateState(db), true);
});
test("기존 저장 형식 전환은 원문·측정값·첨부 ID와 백업을 보존한다", () => {
  const source = seed();
  const raw = JSON.stringify(source);
  const map = new Map([[STORAGE_KEY, raw]]);
  const storage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
  const result = load(storage);
  assert.equal(result.error, null);
  assert.equal(result.db.schema, 3);
  assert.equal(map.get(BACKUP_KEY), raw);
  assert.deepEqual(result.db.records[1].assessments, [
    source.records[1].assessment,
  ]);
  assert.equal(result.db.records[0].performed, "");
  assert.equal(result.db.records[0].summary, source.records[0].summary);
  assert.equal(result.db.records[0].format, "legacy");
  assert.deepEqual(load(storage).db, result.db);
  for (const failKey of [BACKUP_KEY, STORAGE_KEY]) {
    const failedMap = new Map([[STORAGE_KEY, raw]]);
    const failed = load({
      getItem: (k) => failedMap.get(k) ?? null,
      setItem: (k, v) => {
        if (k === failKey) throw Error("quota");
        failedMap.set(k, v);
      },
    });
    assert.equal(failed.db, null);
    assert.equal(failedMap.get(STORAGE_KEY), raw);
  }
});
