import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goalFields,appointmentFields,intervalsOverlap,contextDate } from '../src/context-fields.js';

const body = (extra = {}) => ({ date:'2026-10-01',time:'10:00',duration:'40',title:' 가상 회기 ',room:' 가상 장소 ',...extra });
test('shared schedule input preserves minute boundaries and normalizes actual form values',() => {
  const a = appointmentFields(body());
  assert.equal(a.duration,40); assert.equal(a.title,'가상 회기'); assert.equal(a.room,'가상 장소');
  assert.equal(intervalsOverlap(a,appointmentFields(body({ time:'10:40' }))),false);
  assert.equal(intervalsOverlap(a,appointmentFields(body({ time:'10:39' }))),true);
  assert.equal(appointmentFields(body({ time:'23:20' })).time,'23:20');
  assert.equal(contextDate('2024-02-29'),'2024-02-29');
  assert.throws(() => appointmentFields(body({ time:'23:21' })));
});
test('shared schedule rules reject coercible values and invalid date/time/status before local or server save',() => {
  for (const extra of [{ date:'2026-02-29' },{ date:'0000-01-01' },{ time:'24:00' },{ time:'10:00:30' },
    { duration:false },{ duration:null },{ duration:{} },{ duration:'4e1' },{ duration:40.1 },{ duration:9 },
    { title:{} },{ room:'' },{ status:'unknown' }]) assert.throws(() => appointmentFields(body(extra)));
});
test('shared goals support family plan state without copying internal input fields',() => {
  assert.deepEqual(goalFields({ title:' 가상 목표 ',description:' 가상 설명 ',privateNote:'not shared' }),
    { title:'가상 목표',description:'가상 설명',status:'active' });
  for (const status of ['active','achieved','paused']) assert.equal(goalFields({ title:'가상 목표',status }).status,status);
  assert.throws(() => goalFields({ title:'가상 목표',status:'unknown' }));
  assert.throws(() => goalFields({ title:{},description:'' }));
});
