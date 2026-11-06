import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goalFields, appointmentFields } from '../src/context-fields.js';

test('goal fields trim safe strings, retain description line breaks and return only the shared goal fields', () => {
  assert.deepEqual(goalFields({ title: ' 가상 목표 ', description: ' 가상 설명\n두 번째\t줄\r\n ', status: 'paused', privateNote: 'not copied' }),
    { title: '가상 목표', description: '가상 설명\n두 번째\t줄', status: 'paused' });
  assert.deepEqual(goalFields({ title: '가상 목표' }), { title: '가상 목표', description: '', status: 'active' });
  assert.deepEqual(goalFields({ title: '가상 목표', description: ' \r\n\t ', status: 'achieved' }),
    { title: '가상 목표', description: '', status: 'achieved' });
});

test('goal raw length is checked before trimming; exactly bounded Unicode strings survive unchanged', () => {
  assert.equal(goalFields({ title: '가'.repeat(100), description: '설'.repeat(2000) }).title.length, 100);
  assert.equal(goalFields({ title: '😀'.repeat(50), description: '😀'.repeat(1000) }).description.length, 2000);
  for (const title of [' '.repeat(100) + 'x', 'x' + ' '.repeat(100), '가'.repeat(101)]) assert.throws(() => goalFields({ title }));
  for (const description of [' '.repeat(2000) + 'x', 'x' + ' '.repeat(2000), '가'.repeat(2001)])
    assert.throws(() => goalFields({ title: '목표', description }));
});

test('goals reject malformed Unicode and controls rather than silently changing them', () => {
  for (const value of ['\ud800', '\udc00', 'x\0', 'x\u0001', 'x\u000b', 'x\u000c', 'x\u001f', 'x\u007f', 'x\u0085', 'x\u009f']) {
    assert.throws(() => goalFields({ title: value }));
    assert.throws(() => goalFields({ title: '목표', description: value }));
  }
  for (const title of ['목표\n', '\t목표', '목표\r']) assert.throws(() => goalFields({ title }));
});

test('goal scalar validation rejects explicit nulls/coercion while absent optional fields retain their legacy defaults', () => {
  for (const title of [null, undefined, 0, false, {}, [], '', ' ']) assert.throws(() => goalFields({ title }));
  for (const description of [null, 0, false, {}, []]) assert.throws(() => goalFields({ title: '목표', description }));
  for (const status of [null, 0, false, {}, [], '', 'ACTIVE', 'archived']) assert.throws(() => goalFields({ title: '목표', status }));
  for (const status of ['active', 'achieved', 'paused']) assert.equal(goalFields({ title: '목표', status }).status, status);
});

test('shared appointment normalization retains duration coercion and absent status without accepting explicit null', () => {
  const input = { date: '2026-10-09', time: '23:20', duration: '40', title: ' 가상 일정 ', room: ' 가상 장소 ' };
  assert.deepEqual(appointmentFields(input), { date: '2026-10-09', time: '23:20', duration: 40,
    title: '가상 일정', room: '가상 장소', status: 'scheduled' });
  assert.throws(() => appointmentFields({ ...input, status: null }));
  assert.throws(() => appointmentFields({ ...input, time: '23:21' }));
});
