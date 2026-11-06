import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordTitleSuggestion } from '../src/record-fields.js';

test('title suggestion uses only the supplied date and directly written activity', () => {
  assert.equal(recordTitleSuggestion('2026-10-13', '블록 옮기기'), '2026-10-13 블록 옮기기');
  assert.equal(recordTitleSuggestion('', '직접 적은 활동'), '직접 적은 활동');
  assert.equal(recordTitleSuggestion('', ''), '세션 기록');
  assert.equal(recordTitleSuggestion('2026-10-13', ''), '2026-10-13 세션 기록');
});

test('only valid canonical Gregorian ISO dates become a prefix', () => {
  for (const date of ['0001-01-01', '0099-12-31', '2000-02-29', '2024-02-29', '9999-12-31'])
    assert.equal(recordTitleSuggestion(date, '활동'), `${date} 활동`);
  for (const date of [
    '', '0000-01-01', '1900-02-29', '2025-02-29', '2026-04-31',
    '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-32',
    '2026-1-03', '26-10-13', '20261013', '2026/10/13',
    '2026-10-13T00:00:00Z', ' 2026-10-13', '2026-10-13 ',
    '10000-01-01', '+010000-01-01', 'not-a-date', '\uD800',
  ]) {
    assert.equal(recordTitleSuggestion(date, '활동'), '활동');
    assert.equal(recordTitleSuggestion(date, ''), '세션 기록');
  }
});

test('whitespace is condensed only in the suggestion, preserving input and line content', () => {
  const fields = Object.freeze({ date: '2026-10-13', performed: ' \t블록\r\n 옮기기\u00a0\u3000연습 \n ' });
  const before = { ...fields };
  assert.equal(recordTitleSuggestion(fields.date, fields.performed), '2026-10-13 블록 옮기기 연습');
  assert.deepEqual(fields, before);
  assert.equal(recordTitleSuggestion('', '\t \n\r\u00a0\u3000'), '세션 기록');
});

test('special characters stay plain text rather than being HTML escaped or interpreted', () => {
  const activity = '<script>alert("가상")</script> & \'기록\' > <';
  assert.equal(recordTitleSuggestion('', activity), activity);
  assert.equal(recordTitleSuggestion('2026-10-13', activity), `2026-10-13 ${activity}`);
});

test('only primitive strings are accepted without coercion or reading object fields', () => {
  let accesses = 0;
  const object = new Proxy({}, { get() { accesses++; throw new Error('unexpected access'); } });
  const rejected = [undefined, null, 0, 42, false, true, [], {}, new String('활동'), Symbol('activity'), object];
  for (const value of rejected) {
    assert.throws(() => recordTitleSuggestion(value, '활동'), TypeError);
    assert.throws(() => recordTitleSuggestion('', value), TypeError);
  }
  assert.equal(accesses, 0);
});

test('the full title has a 100 UTF-16-unit limit including a valid date prefix', () => {
  assert.equal(recordTitleSuggestion('', '가'.repeat(100)), '가'.repeat(100));
  assert.equal(recordTitleSuggestion('', '가'.repeat(101)), '가'.repeat(100));
  const dated = recordTitleSuggestion('2026-10-13', '가'.repeat(100));
  assert.equal(dated, `2026-10-13 ${'가'.repeat(89)}`);
  assert.equal(dated.length, 100);
  assert.equal(recordTitleSuggestion('', `${'가'.repeat(99)} 다음`), '가'.repeat(99));
});

test('surrogate-pair emoji are retained whole at the UTF-16 limit', () => {
  assert.equal(recordTitleSuggestion('', `${'가'.repeat(98)}😀다음`), `${'가'.repeat(98)}😀`);
  assert.equal(recordTitleSuggestion('', `${'가'.repeat(99)}😀다음`), '가'.repeat(99));
  const title = recordTitleSuggestion('2026-10-13', '😀'.repeat(60));
  assert.equal(title, `2026-10-13 ${'😀'.repeat(44)}`);
  assert.ok(title.length <= 100);
  assert.ok(title.isWellFormed());
});

test('ZWJ families and skin-tone emoji are not split or partially retained', () => {
  for (const grapheme of ['👨‍👩‍👧‍👦', '👩🏽‍⚕️', '👍🏽', '🇰🇷']) {
    const fit = '가'.repeat(100 - grapheme.length);
    assert.equal(recordTitleSuggestion('', `${fit}${grapheme}다음`), `${fit}${grapheme}`);
    const overflow = `${fit}가`;
    assert.equal(recordTitleSuggestion('', `${overflow}${grapheme}다음`), overflow);
    const title = recordTitleSuggestion('2026-10-13', grapheme.repeat(30));
    assert.equal(title, `2026-10-13 ${grapheme.repeat(Math.floor(89 / grapheme.length))}`);
    assert.ok(title.length <= 100);
    assert.ok(title.isWellFormed());
  }
});

test('combining accents and decomposed Korean clusters retain their complete graphemes', () => {
  for (const grapheme of ['e\u0301', 'a\u0301\u0323', '\u1112\u1161\u11ab']) {
    const fit = '가'.repeat(100 - grapheme.length);
    assert.equal(recordTitleSuggestion('', `${fit}${grapheme}다음`), `${fit}${grapheme}`);
    const overflow = `${fit}가`;
    assert.equal(recordTitleSuggestion('', `${overflow}${grapheme}다음`), overflow);
  }
  assert.equal(recordTitleSuggestion('', 'e\u0301'), 'e\u0301');
});

test('an over-budget first grapheme falls back without emitting a partial clinical phrase', () => {
  const grapheme = `e${'\u0301'.repeat(100)}`;
  assert.equal(recordTitleSuggestion('', `${grapheme}활동`), '세션 기록');
  assert.equal(recordTitleSuggestion('2026-10-13', `${grapheme}활동`), '2026-10-13 세션 기록');
});

test('malformed UTF-16 is made well formed only in the suggestion copy', () => {
  const original = '\uD800가상\uDC00 기록😀';
  assert.equal(recordTitleSuggestion('', original), '\uFFFD가상\uFFFD 기록😀');
  assert.equal(original, '\uD800가상\uDC00 기록😀');
  assert.equal(original.isWellFormed(), false);
  assert.equal(recordTitleSuggestion('', original).isWellFormed(), true);
});

test('repeated calls remain deterministic and do not retain prior activity or date content', () => {
  const first = recordTitleSuggestion('2026-10-13', '첫 가상 활동');
  assert.equal(recordTitleSuggestion('', ''), '세션 기록');
  assert.equal(recordTitleSuggestion('2026-10-14', '다른 가상 활동'), '2026-10-14 다른 가상 활동');
  assert.equal(recordTitleSuggestion('2026-10-13', '첫 가상 활동'), first);
});
