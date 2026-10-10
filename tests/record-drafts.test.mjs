import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordDetails, recordActivity, hasRecordContent, isCompleteAssessment } from '../src/record-fields.js';
import { mutate, validateState, project } from '../src/domain.js';
import { load, persist } from '../src/repository.js';
import { STORAGE_KEY, today } from '../src/config.js';
const row = { tool: '가상 관찰', item: '시도', value: 0, unit: '회', context: '가상 조건' };
const t = { role: 'therapist', id: 't1' };
const base = { childId: 'c1', goalId: 'g1', date: today(), status: 'draft' };

test('draft assessment rows preserve blanks, explicit zero, metadata and order without counting empty values', () => {
  const assessments = [{ ...row, value: '' }, { ...row, item: '', value: 0 }, {}];
  const draft = recordDetails({ status: 'draft', assessments });
  assert.deepEqual(draft.assessments, [{ ...row, value: null }, { ...row, item: '' }, { tool: '', item: '', unit: '', context: '', value: null }]);
  assert.equal(hasRecordContent(draft), false);
  assert.equal(isCompleteAssessment(draft.assessments[1]), false);
  assert.equal(hasRecordContent(recordDetails({ assessments: [row] })), true);
  for (const value of ['', '  ', null, undefined]) assert.equal(recordDetails({ status: 'draft', assessments: [{ ...row, value }] }).assessments[0].value, null);
});
test('formal measurements remain complete and finite; even drafts reject fabricated/coercible numeric values and over-limit input', () => {
  for (const status of ['draft', 'saved']) {
    for (const value of [false, true, {}, [], NaN, Infinity, -Infinity, 'not-a-number'])
      assert.throws(() => recordDetails({ status, assessments: [{ ...row, value }] }));
    for (const assessments of [Array(21).fill(row), [{ ...row, context: 'x'.repeat(301) }], [null]])
      assert.throws(() => recordDetails({ status, assessments }));
  }
  for (const value of ['', null, undefined]) assert.throws(() => recordDetails({ assessments: [{ ...row, value }] }));
  for (const key of ['tool', 'item', 'unit', 'context']) assert.throws(() => recordDetails({ assessments: [{ ...row, [key]: '' }] }));
  assert.equal(recordDetails({ assessments: [{ ...row, value: '0' }] }).assessments[0].value, 0);
});
test('unfinished observation and activity survive drafts but explicit contradictions and incomplete formal inputs do not', () => {
  const observation = { status: '', task: '작성 중인 가상 과제' };
  assert.equal(recordDetails({ status: 'draft', observation }).observation.task, observation.task);
  assert.throws(() => recordDetails({ observation }));
  for (const status of ['draft', 'saved']) for (const o of ['not-observed', 'not-applicable'])
    assert.throws(() => recordDetails({ status, observation: { ...observation, status: o } }));
  assert.deepEqual(recordActivity({ title: '작성 중' }, 'draft'), { title: '작성 중', instruction: '', frequency: '', caution: '' });
  assert.throws(() => recordActivity({ title: '작성 중' }, 'saved'));
});
test('local draft reload preserves partial fields and original record; formal save and sharing cannot bypass completion', () => {
  const values = new Map();
  const storage = { getItem: (k) => values.get(k) ?? null, setItem: (k,v) => values.set(k,v) };
  const initial = load(storage).db, originals = structuredClone(initial.records);
  const db = mutate(initial, t, 'record', { ...base, assessments: [{ ...row, value: '' }, { ...row, value: 2, unit: '' }],
    observation: { status: '', task: '작성 중' }, activity: { title: '작성 중' }, privateNote: '가상 내부 초안' });
  const draft = db.records.at(-1), id = draft.id;
  assert.equal(validateState(db), true);
  persist(storage, db, initial.revision);
  assert.deepEqual(load(storage).db.records.at(-1), draft);
  assert.deepEqual(load(storage).db.records.slice(0,-1), originals);
  assert.throws(() => mutate(db, t, 'publish', { childId:'c1', id }), /초안/);
  assert.throws(() => mutate(db, t, 'record', { ...draft, status: 'saved' }));
  const corrupted = structuredClone(db); corrupted.records.at(-1).status = 'saved';
  assert.equal(validateState(corrupted), false);
  const saved = mutate(db, t, 'record', { ...draft, status: 'saved', assessments: [row, { ...row, value: 2 }],
    observation: { status: 'observed', task: '직접 관찰' }, activity: { title:'가상 활동', instruction:'가상 안내', frequency:'가상 빈도' }, summary:'가상 공유 요약' });
  const published = mutate(saved, t, 'publish', { childId:'c1', id });
  const guardian = project(published, { role:'guardian', id:'p1' }, 'c1');
  assert.ok(!JSON.stringify(guardian).includes('가상 내부 초안'));
  assert.ok(!JSON.stringify(guardian).includes('가상 관찰'));
  assert.ok(values.has(STORAGE_KEY));
});

test('new draft rules do not reject or rewrite previously accepted legacy activity text', () => {
  const storage = { getItem:() => null };
  const db = load(storage).db;
  const legacy = db.records.find((r) => r.format === 'legacy');
  legacy.activity = { title:'  이전 원문  ', instruction:'', frequency:'  ', caution:'가상 원문' };
  assert.equal(validateState(db),true);
  const raw = JSON.stringify(db);
  assert.deepEqual(load({ getItem:() => raw }).db.records.find((r) => r.id === legacy.id).activity,legacy.activity);
});
