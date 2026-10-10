import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedbackFields } from '../src/feedback-fields.js';

test('shared feedback fields normalize only public content and preserve each supported activity result', () => {
  for (const result of ['done', 'partial', 'skipped']) {
    assert.deepEqual(feedbackFields({ date: '2026-10-01', result, reaction: ' 가상 반응 ', reviewed: true, reviewNote: 'not public' }),
      { date: '2026-10-01', result, reaction: '가상 반응', difficulty: '' });
  }
  assert.equal(feedbackFields({ date: '2024-02-29', result: 'done', reaction: '확인', difficulty: ' 가상 어려움 ' }).difficulty, '가상 어려움');
});

test('shared feedback fields reject missing/coercible reactions, invalid states, dates and oversized content', () => {
  const base = { date: '2026-10-01', result: 'done', reaction: '가상 반응' };
  for (const extra of [{ date: '2026-02-29' }, { date: '0000-01-01' }, { date: null }, { result: 'unknown' },
    { reaction: '' }, { reaction: null }, { reaction: {} }, { reaction: 'x'.repeat(1001) },
    { difficulty: false }, { difficulty: 'x'.repeat(1001) }]) assert.throws(() => feedbackFields({ ...base, ...extra }));
});
