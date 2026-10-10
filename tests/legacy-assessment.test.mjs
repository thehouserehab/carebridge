import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "../src/seed.js";
import { ACCOUNTS, STORAGE_KEY, today } from "../src/config.js";
import { mutate, validateState } from "../src/domain.js";
import { upgradeState } from "../src/conversations.js";
import { BACKUP_KEY, load, persist } from "../src/repository.js";

// Synthetic metadata only. These tests never open browser storage or media files.
const attachment = {
  id: "synthetic-legacy-photo",
  name: "synthetic-legacy-photo.png",
  type: "image/png",
  size: 24,
  share: true,
};
const measurement = {
  tool: "합성 도구",
  item: "합성 항목",
  value: 0,
  unit: "회",
  context: "합성 조건",
};
function legacyFixture(assessment = measurement) {
  const source = seed();
  const record = source.records.find((r) => r.assessment !== null);
  record.assessment = structuredClone(assessment);
  record.attachments = [{ ...attachment, id: "synthetic-private-video", name: "synthetic-private-video.mp4", type: "video/mp4", share: false }];
  source.records[0].attachments = [structuredClone(attachment)];
  source.publications[0].attachments = [structuredClone(attachment)];
  return { source, recordId: record.id };
}
function memoryStorage(source, { failKey } = {}) {
  const raw = JSON.stringify(source);
  const entries = new Map([[STORAGE_KEY, raw]]);
  const writes = [];
  return {
    raw, entries, writes,
    storage: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => {
        writes.push(key);
        if (key === failKey) throw new Error("synthetic quota failure");
        entries.set(key, value);
      },
    },
  };
}

test("accepted schema 2 legacy measurement with a blank condition migrates without losing its original fields", () => {
  const { source, recordId } = legacyFixture({ ...measurement, context: "" });
  const original = structuredClone(source);
  const memory = memoryStorage(source);
  assert.equal(validateState(source), true);
  const loaded = load(memory.storage);
  assert.equal(loaded.error, null);
  assert.equal(validateState(loaded.db), true);
  assert.deepEqual(loaded.db.records.find((r) => r.id === recordId).assessments, [original.records.find((r) => r.id === recordId).assessment]);
  assert.equal(memory.entries.get(BACKUP_KEY), memory.raw);
  assert.deepEqual(source, original);
});

const historicalMeasurements = [
  ["blank-condition", { ...measurement, context: "" }],
  ...["tool", "item", "unit"].map((key) => [`blank-${key}`, { ...measurement, [key]: "" }]),
  ["padded-text", { ...measurement, tool: "  도구  ", item: "  항목  ", unit: "  회  ", context: "  합성 조건  " }],
  ["whitespace-only", { ...measurement, tool: " ", item: "\t", unit: "  ", context: "\n" }],
  ["historical-lengths", { ...measurement, tool: "도".repeat(101), item: "항".repeat(101), unit: "회".repeat(101), context: "가".repeat(301) }],
];

test("schema 2 migration and schema 3 legacy reload preserve accepted raw text, zero, dates, attachment metadata and publications", () => {
  for (const [name, assessment] of historicalMeasurements) {
    const { source, recordId } = legacyFixture(assessment);
    const original = structuredClone(source);
    const memory = memoryStorage(source);
    assert.equal(validateState(source), true, name);
    const expected = upgradeState(source);
    const loaded = load(memory.storage);
    assert.equal(loaded.error, null, name);
    assert.deepEqual(loaded.db, expected, name);
    assert.deepEqual(source, original, name);
    assert.equal(memory.entries.get(BACKUP_KEY), memory.raw, name);
    assert.deepEqual(memory.writes, [BACKUP_KEY, STORAGE_KEY], name);
    const migratedRecord = loaded.db.records.find((r) => r.id === recordId);
    assert.equal(migratedRecord.assessments[0].value, 0, name);
    for (const before of original.records) {
      const after = loaded.db.records.find((r) => r.id === before.id);
      for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key], `${name}: ${key}`);
    }
    assert.deepEqual(loaded.db.publications, original.publications, name);
    const savedRaw = memory.entries.get(STORAGE_KEY);
    memory.writes.length = 0;
    assert.deepEqual(load(memory.storage).db, expected, name);
    assert.equal(memory.entries.get(STORAGE_KEY), savedRaw, name);
    assert.equal(memory.entries.get(BACKUP_KEY), memory.raw, name);
    assert.deepEqual(memory.writes, [], name);
  }
});

test("migration backup or replacement failure keeps the old workspace and attachments intact", () => {
  for (const failKey of [BACKUP_KEY, STORAGE_KEY]) {
    const { source } = legacyFixture({ ...measurement, context: "" });
    const memory = memoryStorage(source, { failKey });
    const before = structuredClone(source);
    const failed = load(memory.storage);
    assert.equal(failed.db, null);
    assert.equal(typeof failed.error, "string");
    assert.equal(memory.entries.get(STORAGE_KEY), memory.raw);
    assert.deepEqual(source, before);
    if (failKey === BACKUP_KEY) {
      assert.equal(memory.entries.has(BACKUP_KEY), false);
      assert.deepEqual(memory.writes, [BACKUP_KEY]);
    } else {
      assert.equal(memory.entries.get(BACKUP_KEY), memory.raw);
      assert.deepEqual(memory.writes, [BACKUP_KEY, STORAGE_KEY]);
    }
  }
});

test("an existing migration backup is never overwritten", () => {
  const { source } = legacyFixture({ ...measurement, context: "" });
  const memory = memoryStorage(source);
  const priorBackup = JSON.stringify(seed());
  memory.entries.set(BACKUP_KEY, priorBackup);
  assert.equal(load(memory.storage).error, null);
  assert.equal(memory.entries.get(BACKUP_KEY), priorBackup);
  assert.deepEqual(memory.writes, [STORAGE_KEY]);
});

test("an unrelated message can be saved and reloaded without rewriting a legacy assessment or its media references", () => {
  for (const [name, assessment] of historicalMeasurements) {
    const { source } = legacyFixture(assessment);
    const memory = memoryStorage(source);
    const initial = load(memory.storage).db;
    assert.ok(initial, name);
    const before = structuredClone(initial);
    const next = mutate(initial, ACCOUNTS.therapist, "message", {
      childId: "c1", clientId: crypto.randomUUID(), body: "합성 일반 소식",
    });
    persist(memory.storage, next, initial.revision);
    assert.equal(validateState(next), true, name);
    assert.deepEqual(initial, before, name);
    assert.deepEqual(next.records, before.records, name);
    assert.deepEqual(next.publications, before.publications, name);
    assert.deepEqual(load(memory.storage).db, next, name);
    assert.equal(memory.entries.get(BACKUP_KEY), memory.raw, name);
  }
});

test("invalid legacy values and non-object assessments fail validation without changing persisted input", () => {
  const invalidAssessments = [
    ...[null, "0", false, [], {}, NaN, Infinity, -Infinity].map((value) => ({ ...measurement, value })),
    [], [measurement], "measurement", false,
    ...["tool", "item", "unit", "context"].map((key) => ({ ...measurement, [key]: null })),
  ];
  for (const assessment of invalidAssessments) {
    const { source } = legacyFixture(assessment);
    assert.doesNotThrow(() => assert.equal(validateState(source), false));
    const upgraded = upgradeState(source);
    assert.doesNotThrow(() => assert.equal(validateState(upgraded), false));
    for (const db of [source, upgraded]) {
      const memory = memoryStorage(db);
      assert.equal(load(memory.storage).db, null);
      assert.equal(memory.entries.get(STORAGE_KEY), memory.raw);
      assert.deepEqual(memory.writes, []);
    }
  }
});

test("legacy compatibility requires exactly one faithful copy of every original measurement field", () => {
  const { source, recordId } = legacyFixture({ ...measurement, context: "" });
  const initial = upgradeState(source);
  const alter = (change) => {
    const db = structuredClone(initial);
    change(db.records.find((r) => r.id === recordId));
    assert.doesNotThrow(() => assert.equal(validateState(db), false));
    const memory = memoryStorage(db);
    assert.equal(load(memory.storage).db, null);
    assert.equal(memory.entries.get(STORAGE_KEY), memory.raw);
    assert.deepEqual(memory.writes, []);
  };
  for (const key of ["tool", "item", "unit", "context", "value"])
    alter((record) => { record.assessments[0][key] = key === "value" ? 1 : "바뀐 원문"; });
  for (const assessments of [[], null, {}, [null], [measurement, measurement]])
    alter((record) => { record.assessments = structuredClone(assessments); });
  alter((record) => { record.assessment = null; });
  alter((record) => { record.format = "structured"; });
  for (const key of ["tool", "item", "unit", "context", "value"])
    alter((record) => { delete record.assessments[0][key]; });
});

test("new records cannot use legacy format to bypass current complete measurement validation", () => {
  const initial = upgradeState(seed());
  const before = structuredClone(initial);
  const input = {
    childId: "c1", goalId: "g1", date: today(), status: "saved", format: "legacy",
    performed: "합성 새 활동", referenceMessageIds: [],
  };
  const invalid = [
    ...["tool", "item", "unit", "context"].map((key) => ({ ...measurement, [key]: "" })),
    { ...measurement, tool: "도".repeat(101) },
    { ...measurement, context: "가".repeat(301) },
    { ...measurement, value: "" },
  ];
  for (const assessment of invalid) {
    assert.throws(() => mutate(initial, ACCOUNTS.therapist, "record", { ...input, assessment }));
    assert.throws(() => mutate(initial, ACCOUNTS.therapist, "record", { ...input, assessment, assessments: [assessment] }));
    assert.deepEqual(initial, before);
  }
  const padded = { ...measurement, context: "  합성 조건  " };
  const saved = mutate(initial, ACCOUNTS.therapist, "record", { ...input, assessment: padded });
  assert.equal(saved.records.at(-1).assessment, null);
  assert.deepEqual(saved.records.at(-1).assessments, [measurement]);
  assert.equal(validateState(saved), true);
});

test("editing a historical record still requires completing or removing its incomplete measurement", () => {
  const { source, recordId } = legacyFixture({ ...measurement, context: "" });
  const initial = load(memoryStorage(source).storage).db;
  assert.ok(initial);
  const record = initial.records.find((r) => r.id === recordId);
  const before = structuredClone(initial);
  assert.throws(() => mutate(initial, ACCOUNTS.therapist, "record", { ...record, performed: "합성 새 관찰" }));
  assert.deepEqual(initial, before);
  for (const assessments of [[measurement], []]) {
    const saved = mutate(initial, ACCOUNTS.therapist, "record", {
      ...record, performed: "합성 새 관찰", assessments,
    });
    const edited = saved.records.find((r) => r.id === recordId);
    assert.equal(edited.assessment, null);
    assert.deepEqual(edited.assessments, assessments);
    assert.deepEqual(edited.attachments, record.attachments);
    assert.deepEqual(saved.publications, before.publications);
    assert.equal(validateState(saved), true);
  }
});
