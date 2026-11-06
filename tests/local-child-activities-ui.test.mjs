import assert from 'node:assert/strict';
import test from 'node:test';
import { childMarkup, homeMarkup } from '../local-api/workspace-ui.js';

const period = { label: '2026년 10월' };
const publication = (id = 'shared-one', extra = {}) => ({ id, conversationId: 'room-one', type: 'publication',
  hidden: false, deleted: false, archived: false,
  publication: { activity: { title: `가상 활동 ${id}`, frequency: '가상 빈도', instruction: '전체 안내는 대화에서 확인', caution: '주의사항도 대화에서 확인' } }, ...extra });
const room = (publications = []) => ({ conversationId: 'room-one', profile: { name: '가상 아이', participants: [] },
  unread: 0, targetId: 'unrelated-news', latest: null,
  care: { goals: [], appointments: [], records: [], publications } });

test('child activities link both roles to the exact publication message, never last news or record ID', () => {
  for (const role of ['guardian', 'therapist']) {
    const html = childMarkup(room([publication()]), role, period);
    assert.match(html, /data-testid="child-activities"/);
    assert.match(html, /공유 중인 가정 활동/);
    assert.match(html, /data-activity-link data-open-room="room-one" data-target-id="shared-one"/);
    assert(!html.includes('data-target-id="unrelated-news"'));
    assert.match(html, /가상 활동 shared-one/); assert.match(html, /가상 빈도/);
    assert(!html.includes('전체 안내는 대화에서 확인')); assert(!html.includes('주의사항도 대화에서 확인'));
    assert.match(html, role === 'guardian' ? /활동을 확인하고 경험 남기기/ : /활동 안내와 소식 보기/);
    assert(!html.includes('data-care-action="feedback"'));
  }
});

test('home and child share the visible-current-activity filter with no clinical or cross-child fallback', () => {
  const source = room([publication(), publication('archived', { archived: true }), publication('hidden', { hidden: true }),
    publication('deleted', { deleted: true }), publication('other-child', { conversationId: 'room-two' }),
    publication('text', { type: 'text' }), publication('missing', { publication: null }),
    publication('no-activity', { publication: { activity: null } })]);
  source.care.records = [{ id: 'private-record', status: 'saved', activity: { title: 'PRIVATE-UNSHARED-ACTIVITY' }, privateNote: 'PRIVATE-NOTE' }];
  const before = JSON.stringify(source);
  for (const html of [homeMarkup([source], 'guardian', period), childMarkup(source, 'guardian', period), childMarkup(source, 'therapist', period)]) {
    assert.equal((html.match(/data-activity-link/g) ?? []).length, 1);
    assert.match(html, /data-target-id="shared-one"/);
    for (const forbidden of ['archived', 'hidden', 'deleted', 'other-child', 'text', 'missing', 'no-activity'])
      assert(!html.includes(`data-target-id="${forbidden}"`));
    assert(!html.includes('PRIVATE-')); assert(!html.includes('private-record'));
  }
  assert.equal(JSON.stringify(source), before);
});

test('current sharing is not inferred from a clinical record, and empty or unauthorized role stays explicit', () => {
  const source = room(); source.care.records = [{ id: 'private-record', status: 'saved', activity: { title: 'PRIVATE-ACTIVITY' } }];
  for (const role of ['guardian', 'therapist']) {
    const html = childMarkup(source, role, period);
    assert.match(html, /현재 공유된 가정 활동이 없습니다/); assert(!html.includes('data-activity-link')); assert(!html.includes('PRIVATE-'));
  }
  assert(!childMarkup(room([publication()]), 'center', period).includes('data-testid="child-activities"'));
  assert(!childMarkup(null, 'guardian', period).includes('data-activity-link'));
});

test('activity links escape text and identifiers and preserve multiple exact card targets', () => {
  const attack = '<img src=x onerror="alert(1)">';
  const source = room([publication('one'), publication('two'), publication(attack, {
    publication: { activity: { title: attack, frequency: attack } },
  })]);
  for (const html of [childMarkup(source, 'guardian', period), homeMarkup([source], 'guardian', period)]) {
    assert.equal((html.match(/data-activity-link/g) ?? []).length, 3);
    assert.match(html, /data-target-id="one"/); assert.match(html, /data-target-id="two"/);
    assert(!html.includes('<img')); assert.match(html, /&lt;img/); assert.match(html, /&quot;/);
  }
});
