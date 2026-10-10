import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Separate processes make the timezone explicit without changing the test
// runner or passing application credentials to a child. No browser/DB/files.
const root = fileURLToPath(new URL('../', import.meta.url));
function inTimezone(timeZone, body) {
  const env = { TZ: timeZone };
  for (const name of ['SystemRoot', 'WINDIR'])
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import * as ui from './src/ui.js';
    import { chatScreen, conversationRows, timeLabel } from './src/chat-ui.js';
    import { seed } from './src/seed.js';
    import { upgradeState, conversationView } from './src/conversations.js';
    import { mutate } from './src/domain.js';
    const actor = { id: 'p1', role: 'guardian' };
    const label = (day, options) => new Intl.DateTimeFormat('ko-KR', options ??
      { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(day + 'T12:00:00'));
    function fixture(times) {
      let db = upgradeState(seed());
      db.messages = []; db.records = []; db.publications = []; db.feedback = [];
      for (const [index, at] of times.entries()) db = mutate(db, actor, 'message', {
        childId: 'c1', clientId: 'synthetic-clock-' + index, body: '합성 시계 ' + index,
      }, at);
      return db;
    }
    const dividers = html => [...html.matchAll(/<p class="chat-date">([^<]*)<\\/p>/g)].map(match => match[1]);
    ${body}
  `], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
  assert.equal(result.error, undefined, 'timezone child must start and finish within the observation deadline');
  assert.equal(result.signal, null, 'timezone child must exit normally');
  assert.equal(result.status, 0, result.stderr || 'timezone assertion failed');
}

test('KST instant labels follow the displayed clock across the UTC day boundary', () => {
  inTimezone('Asia/Seoul', `
    const instant = '2026-10-09T18:01:00.000Z';
    assert.equal(ui.dateLabel(instant), label('2026-10-10'));
    assert.equal(ui.dateLabel(instant, { month: 'numeric', day: 'numeric' }), label('2026-10-10', { month: 'numeric', day: 'numeric' }));
    assert.equal(timeLabel(instant), new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date('2026-10-10T03:01:00+09:00')));
    assert.equal(ui.localCalendarDay(instant), '2026-10-10');
    assert.equal(ui.dateLabel('2026-10-10T03:01:00+09:00'), ui.dateLabel(instant));
  `);
});

test('KST midnight changes the calendar key even when the UTC date is unchanged', () => {
  inTimezone('Asia/Seoul', `
    assert.equal(ui.localCalendarDay('2026-10-09T14:59:59.999Z'), '2026-10-09');
    assert.equal(ui.localCalendarDay('2026-10-09T15:00:00.000Z'), '2026-10-10');
    assert.equal(ui.dateLabel('2026-10-09T15:00:00.000Z'), label('2026-10-10'));
  `);
});

for (const [zone, before, after, firstDay, secondDay] of [
  ['Asia/Seoul', '2026-10-09T14:59:59.999Z', '2026-10-09T15:00:00.000Z', '2026-10-09', '2026-10-10'],
  ['UTC', '2026-10-09T23:59:59.999Z', '2026-10-10T00:00:00.000Z', '2026-10-09', '2026-10-10'],
  ['America/Los_Angeles', '2026-10-10T06:59:59.999Z', '2026-10-10T07:00:00.000Z', '2026-10-09', '2026-10-10'],
]) {
  test(`${zone}: each displayed calendar day gets a divider without changing messages or read state`, () => {
    inTimezone(zone, `
      const db = fixture(${JSON.stringify([before, after])});
      const original = structuredClone(db);
      const visible = conversationView(db, actor, 'c1').messages;
      const html = chatScreen(db, actor, 'c1', true);
      assert.deepEqual(dividers(html), [label('${firstDay}'), label('${secondDay}')]);
      assert.ok(html.indexOf('id="message-' + visible[0].id + '"') < html.indexOf('id="message-' + visible[1].id + '"'));
      assert.deepEqual(visible.map(message => message.createdAt), ${JSON.stringify([before, after])});
      const rows = conversationRows(db, actor, 'c1');
      assert.ok(rows.includes('<time>' + label('${secondDay}', { month: 'numeric', day: 'numeric' }) + ' ' + timeLabel('${after}') + '</time>'));
      assert.deepEqual(db, original);
    `);
  });
}

for (const [zone, times, day] of [
  ['Asia/Seoul', ['2026-10-09T15:00:00.000Z', '2026-10-10T14:59:59.999Z'], '2026-10-10'],
  ['UTC', ['2026-10-10T00:00:00.000Z', '2026-10-10T23:59:59.999Z'], '2026-10-10'],
  ['America/Los_Angeles', ['2026-10-09T07:00:00.000Z', '2026-10-10T06:59:59.999Z'], '2026-10-09'],
]) {
  test(`${zone}: a same-day message pair has only one separator, including different UTC dates`, () => {
    inTimezone(zone, `
      const db = fixture(${JSON.stringify(times)}), original = structuredClone(db);
      assert.deepEqual(dividers(chatScreen(db, actor, 'c1', true)), [label('${day}')]);
      assert.deepEqual(db, original);
    `);
  });
}

test('date-only record and appointment values remain calendar dates in every tested timezone', () => {
  for (const zone of ['Asia/Seoul', 'UTC', 'America/Los_Angeles']) inTimezone(zone, `
    for (const date of ['2026-01-01', '2026-10-10', '2024-02-29', '2026-12-31']) {
      assert.equal(ui.dateLabel(date), label(date));
      assert.equal(ui.dateLabel(date, { year: 'numeric', month: '2-digit', day: '2-digit' }), label(date, { year: 'numeric', month: '2-digit', day: '2-digit' }));
      assert.equal(ui.localCalendarDay(date), date);
      assert.equal(timeLabel(date), '');
    }
  `);
});
