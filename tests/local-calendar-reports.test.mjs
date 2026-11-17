import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarReportsMarkup, childMarkup } from '../local-api/workspace-ui.js';

const period = { dateFrom: '2026-11-01', dateTo: '2026-11-30', label: '2026년 11월' };
const publication = (id, changes = {}) => ({ id, conversationId: 'room-a', type: 'publication',
  publication: { date: '2026-11-16', title: '검토한 가상 수업 보고서', summary: '공유된 활동' }, ...changes });
const room = publications => ({ conversationId: 'room-a', profile: { name: '가상 아동', participants: [] },
  care: { records: [{ id: 'private-record', privateNote: 'PRIVATE-NEVER-EXPOSE' }], publications, goals: [], appointments: [] } });

test('calendar displays only current same-room shared reports within the selected month', () => {
  const current = publication('allowed');
  const html = calendarReportsMarkup(room([current, publication('hidden', { hidden: true }), publication('deleted', { deleted: true }),
    publication('archived', { archived: true }), publication('foreign', { conversationId: 'room-b' }),
    publication('text-only', { type: 'text' }), publication('old', { publication: { date: '2026-10-31', title: 'past' } }),
    publication('future', { publication: { date: '2026-12-01', title: 'next' } })]), period);
  assert.match(html, /data-target-id="allowed"/);
  for (const id of ['hidden', 'deleted', 'archived', 'foreign', 'text-only', 'old', 'future'])
    assert(!html.includes(`data-target-id="${id}"`));
  assert(!html.includes('PRIVATE-NEVER-EXPOSE'));
});
test('calendar never invents appointment association and supports multiple reports on the same date', () => {
  const html = calendarReportsMarkup(room([publication('a'), publication('b')]), period);
  assert.equal((html.match(/data-calendar-report /g) ?? []).length, 2);
  assert(!html.includes('data-appointment-record'));
  assert.match(html, /같은 날짜에 여러 수업/);
});
test('calendar report labels are escaped and source arrays remain unchanged', () => {
  const messages = [publication('later', { publication: { date: '2026-11-20', title: '<script>가상</script>' } }), publication('earlier')];
  const before = structuredClone(messages);
  const html = calendarReportsMarkup(room(messages), period);
  assert.match(html, /&lt;script&gt;/); assert(!html.includes('<script>')); assert.deepEqual(messages, before);
});
test('calendar reports disappear when withdrawn and are never rendered for independent recipient or center roles', () => {
  const state = room([publication('allowed')]);
  assert.match(childMarkup(state, 'guardian', period), /data-calendar-report/);
  state.care.publications = [];
  assert(!calendarReportsMarkup(state, period).includes('data-target-id="allowed"'));
  for (const role of ['therapist', 'center', 'care_recipient'])
    assert(!childMarkup(room([publication('allowed')]), role, period).includes('data-calendar-report'));
  assert.equal(calendarReportsMarkup(state, { label: 'unknown period' }), '');
});
