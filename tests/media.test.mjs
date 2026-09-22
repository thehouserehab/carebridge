import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/seed.js";
import { ACCOUNTS, today } from "../src/config.js";
import { mutate, project, validateState } from "../src/domain.js";
import {
  inspectFile,
  normalizeAttachments,
  MEDIA_LIMITS,
} from "../src/media-policy.js";
import { saveWithMedia } from "../src/media-store.js";
const photo = {
  id: "photo-private",
  name: "private.png",
  type: "image/png",
  size: 100,
  share: false,
};
const video = {
  id: "video-shared",
  name: "shared.webm",
  type: "video/webm",
  size: 100,
  share: true,
};
const input = {
  childId: "c1",
  goalId: "g1",
  date: today(),
  title: "첨부 시험",
  summary: "가상 관찰",
  attachments: [photo, video],
};
test("첨부 공유는 선택한 파일만 포함하며 초안 제거 후에도 공유본을 보존한다", () => {
  let db = mutate(seed(), ACCOUNTS.therapist, "record", input);
  const id = db.records.at(-1).id;
  db = mutate(db, ACCOUNTS.therapist, "publish", { childId: "c1", id });
  assert.deepEqual(db.publications.at(-1).attachments, [video]);
  assert.ok(
    !JSON.stringify(project(db, ACCOUNTS.guardian, "c1")).includes(photo.name),
  );
  assert.ok(
    !JSON.stringify(project(db, ACCOUNTS.center, "c1")).includes(video.name),
  );
  db = mutate(db, ACCOUNTS.therapist, "record", {
    ...input,
    id,
    attachments: [],
  });
  assert.deepEqual(
    project(db, ACCOUNTS.guardian, "c1").publications.at(-1).attachments,
    [video],
  );
  db = mutate(db, ACCOUNTS.therapist, "publish", { childId: "c1", id });
  assert.deepEqual(
    project(db, ACCOUNTS.guardian, "c1").publications.at(-1).attachments,
    [],
  );
  assert.deepEqual(db.publications.at(-2).attachments, [video]);
  assert.throws(() => project(db, ACCOUNTS.guardian, "c2"));
  validateState(db);
  validateState(seed());
});
test("보호자 피드백 첨부는 담당 치료사에게 전달된다", () => {
  const source = seed();
  const publicationId = source.publications[0].id;
  const db = mutate(source, ACCOUNTS.guardian, "feedback", {
    childId: "c1",
    publicationId,
    date: today(),
    result: "done",
    reaction: "가상 경험",
    attachments: [photo],
  });
  assert.equal(
    project(db, ACCOUNTS.therapist, "c1").feedback.at(-1).attachments[0].id,
    photo.id,
  );
  assert.equal(
    project(db, ACCOUNTS.guardian, "c1").feedback.at(-1).attachments[0].share,
    true,
  );
});
test("첨부 개수·용량·형식·중복·파일 시그니처를 검증한다", async () => {
  assert.throws(() => normalizeAttachments([photo, photo]));
  assert.throws(() =>
    normalizeAttachments([{ ...photo, size: MEDIA_LIMITS.image + 1 }]),
  );
  assert.throws(() =>
    normalizeAttachments([{ ...photo, type: "image/svg+xml" }]),
  );
  assert.throws(() =>
    normalizeAttachments(
      Array.from({ length: 7 }, (_, i) => ({ ...photo, id: `id-${i}` })),
    ),
  );
  assert.throws(() =>
    normalizeAttachments(
      [0, 1, 2].map((i) => ({ ...video, id: `v-${i}`, size: 40 * 1024 ** 2 })),
    ),
  );
  await assert.rejects(
    inspectFile(new File(["not png"], "test.png", { type: "image/png" })),
  );
  await assert.rejects(
    inspectFile(new File([], "empty.png", { type: "image/png" })),
  );
  const png = new File(
    [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
    "test.png",
    { type: "image/png" },
  );
  assert.equal((await inspectFile(png)).share, false);
});
test("파일 저장 실패 시 기록 미저장, 기록 실패 시 새 파일만 롤백한다", async () => {
  const calls = [];
  const entries = [["new", new Blob(["data"])]];
  await assert.rejects(
    saveWithMedia(
      {
        write: async () => {
          throw Error("quota");
        },
      },
      entries,
      () => calls.push("saved"),
    ),
  );
  assert.deepEqual(calls, []);
  await assert.rejects(
    saveWithMedia(
      {
        write: async () => calls.push("blob"),
        remove: async (ids) => calls.push(ids),
      },
      entries,
      () => {
        throw Error("conflict");
      },
    ),
    /conflict/,
  );
  assert.deepEqual(calls, ["blob", ["new"]]);
});
