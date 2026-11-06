import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appointmentFields, goalFields, intervalsOverlap } from '../src/context-fields.js';

const input = (extra = {}) => ({ date: '2026-10-09', time: '10:00', duration: '40', title: ' 가상 일정 ', room: ' 가상 장소 ', ...extra });

test('appointment fields return exactly six normalized fields and keep only absent status default', () => {
  assert.deepEqual(appointmentFields(input({ privateNote: 'not copied' })), {
    date: '2026-10-09', time: '10:00', duration: 40, title: '가상 일정', room: '가상 장소', status: 'scheduled' });
  for (const status of ['scheduled', 'attended', 'absent', 'cancelled']) assert.equal(appointmentFields(input({ status })).status, status);
  for (const status of [null, false, 0, '', [], {}, 'deleted']) assert.throws(() => appointmentFields(input({ status })));
});

test('appointment title/place raw limits and Unicode are checked before trimming', () => {
  const bounded = appointmentFields(input({ title: '😀'.repeat(50), room: '가'.repeat(60) }));
  assert.equal(bounded.title.length, 100); assert.equal(bounded.room.length, 60);
  for (const [key, max] of [['title', 100], ['room', 60]]) {
    for (const value of ['x'.repeat(max + 1), ' '.repeat(max) + 'x', 'x' + ' '.repeat(max), '\ud800', '\udc00', null, false, 0, [], {}, '', ' '])
      assert.throws(() => appointmentFields(input({ [key]: value })));
    for (const value of ['x\0', 'x\t', 'x\n', 'x\r', 'x\u000b', 'x\u001f', 'x\u007f', 'x\u0085', 'x\u009f'])
      assert.throws(() => appointmentFields(input({ [key]: value })));
  }
});

test('schedule numeric/date/time and overlap boundaries stay unchanged', () => {
  for (const duration of [10, '010', 180, '180']) assert.equal(appointmentFields(input({ duration })).duration, Number(duration));
  for (const extra of [{ duration: 9 }, { duration: 181 }, { duration: 40.1 }, { duration: '4e1' }, { duration: false },
    { duration: null }, { duration: {} }, { duration: ' 40' }, { date: '2026-02-29' }, { date: '0000-01-01' },
    { time: '24:00' }, { time: '10:00:00' }, { time: '23:21' }]) assert.throws(() => appointmentFields(input(extra)));
  assert.equal(appointmentFields(input({ date: '2024-02-29', time: '23:20' })).duration, 40);
  assert.equal(intervalsOverlap(appointmentFields(input()), appointmentFields(input({ time: '10:40' }))), false);
  assert.equal(intervalsOverlap(appointmentFields(input()), appointmentFields(input({ time: '10:39' }))), true);
});

test('sharing context text validation does not change safe goal descriptions or defaults', () => {
  assert.deepEqual(goalFields({ title: ' 가상 목표 ', description: ' 첫줄\n둘째\t줄\r\n ' }),
    { title: '가상 목표', description: '첫줄\n둘째\t줄', status: 'active' });
  assert.throws(() => goalFields({ title: '가상\n목표' }));
  assert.throws(() => goalFields({ title: '가상 목표', description: '\ud800' }));
});
