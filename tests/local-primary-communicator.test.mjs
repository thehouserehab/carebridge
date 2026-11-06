// Actual exported presentation helpers with a deliberately small DOM double.
// No browser geometry, native disclosure keyboard, network or permission API
// verification is claimed by this file.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PRIMARY_COMMUNICATOR_NOTICE, primaryCommunicatorMarkup,
  reconcilePrimaryCommunicator } from '../local-api/workspace-ui.js';

const profile = (changes = {}) => ({
  primaryCommunicator: { userId: 'guardian' },
  participants: [
    { userId: 'guardian', displayName: '합성 보호자', role: 'guardian' },
    { userId: 'recipient', displayName: '합성 대상자', role: 'care_recipient' },
    { userId: 'therapist', displayName: '합성 치료사', role: 'therapist' },
    { userId: 'manager', displayName: '합성 센터', role: 'center' },
  ], ...changes,
});
const frozen = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
};
const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g,
  (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]);

function domFixture() {
  const document = { activeElement: null, body: { syntheticBody: true } };
  document.activeElement = document.body;
  const counts = { mounts: 0, clears: 0, labelWrites: 0, focus: 0 };
  const createNode = (kind, parentElement = null) => ({ kind, parentElement, ownerDocument: document,
    focus(options) { counts.focus++; this.lastFocusOptions = options; document.activeElement = this; } });
  let section = null, details = null, summary = null, label = null, audience = null, markup = '';
  const host = createNode('host');
  host.contains = node => {
    for (let current = node; current; current = current.parentElement) if (current === host) return true;
    return false;
  };
  host.replaceChildren = () => {
    const removedFocus = host.contains(document.activeElement);
    if (section) section.parentElement = null;
    section = details = summary = label = audience = null; markup = ''; counts.clears++;
    if (removedFocus) document.activeElement = document.body;
  };
  Object.defineProperties(host, {
    firstChild: { get: () => section },
    innerHTML: { get: () => markup, set(value) {
      const labelMatch = value.match(/<span data-primary-person>([\s\S]*?)<\/span>/);
      const detailsMatch = value.match(/<details\b[^>]*class="primary-communicator-details"[^>]*>/);
      assert(labelMatch && detailsMatch, 'The real compact renderer must create its expected native disclosure.');
      if (section) host.replaceChildren();
      counts.mounts++; markup = value;
      section = createNode('section', host); details = createNode('details', section);
      details.open = /\bopen(?:\s|=|>)/.test(detailsMatch[0]);
      summary = createNode('summary', details); label = createNode('label', summary);
      audience = createNode('audience', section);
      let text = decode(labelMatch[1]);
      Object.defineProperty(label, 'textContent', { get: () => text, set(value) { counts.labelWrites++; text = value; } });
    } },
  });
  host.querySelector = selector => {
    assert.equal(selector, '[data-primary-person]', 'Reconciliation should inspect only its dynamic name slot.');
    return label;
  };
  return { document, host, counts, get section() { return section; }, get details() { return details; },
    get summary() { return summary; }, get label() { return label; }, get audience() { return audience; } };
}

test('full mode retains the complete explicit permission notice and does not introduce a disclosure', () => {
  for (const options of [undefined, { compact: false }]) {
    const html = primaryCommunicatorMarkup(profile(), options);
    assert.match(html, /합성 보호자 \(보호자\)/); assert(html.includes(PRIMARY_COMMUNICATOR_NOTICE));
    assert.doesNotMatch(html, /<details\b|<summary\b|primary-communicator-compact/);
  }
});

test('compact mode keeps identity in its summary, permission details closed and the audience outside details', () => {
  const html = primaryCommunicatorMarkup(profile(), { compact: true });
  const detailsTag = html.match(/<details\b[^>]*>/)?.[0]; assert(detailsTag);
  assert.doesNotMatch(detailsTag, /\bopen(?:\s|=|>)/);
  const summary = html.match(/<summary>[\s\S]*?<\/summary>/)?.[0]; assert(summary);
  assert.match(summary, /합성 보호자 \(보호자\)/); assert.match(summary, /주 소통자/);
  assert.match(summary, /안내/); assert.match(summary, /aria-hidden="true"/);
  const detailsEnd = html.indexOf('</details>'), audience = html.indexOf('data-primary-audience');
  assert(detailsEnd > 0 && audience > detailsEnd);
  assert.match(html.slice(audience), /일반 소식은 현재 참여자에게 함께 전달됩니다/);
  assert.match(html.slice(0, detailsEnd), /연락의 우선 대상/);
  assert.match(html.slice(0, detailsEnd), /개인 대화·동의 완료·기록 열람 권한을 뜻하지 않습니다/);
  assert.doesNotMatch(html, /<button\b|<a\b|onclick=|aria-expanded=/);
});

test('both modes escape names and disclose only the eligible current name and public role', () => {
  const current = frozen(profile({ privateNote: 'PRIVATE-NOTE', familyPlan: { concern: 'PRIVATE-FAMILY' },
    primaryCommunicator: { userId: 'guardian', internalApproval: 'PRIVATE-APPROVAL' },
    participants: [{ userId: 'guardian', displayName: '<합성 & "보호자">\'', role: 'guardian', email: 'PRIVATE-EMAIL' },
      { userId: 'other', displayName: 'PRIVATE-OTHER-NAME', role: 'guardian' }] }));
  const before = JSON.stringify(current);
  for (const compact of [false, true]) {
    const html = primaryCommunicatorMarkup(current, { compact });
    assert.match(html, /&lt;합성 &amp; &quot;보호자&quot;&gt;&#39; \(보호자\)/);
    assert.doesNotMatch(html, /<합성|PRIVATE-|userId|internalApproval|email=/);
  }
  assert.equal(JSON.stringify(current), before);
});

test('only current guardian and care-recipient roles can be designated; all other IDs show unassigned', () => {
  for (const compact of [false, true]) {
    for (const [userId, expected] of [['guardian', '합성 보호자 (보호자)'], ['recipient', '합성 대상자 (대상자)']])
      assert(primaryCommunicatorMarkup(profile({ primaryCommunicator: { userId } }), { compact }).includes(expected));
    for (const userId of ['therapist', 'manager', 'missing']) {
      const html = primaryCommunicatorMarkup(profile({ primaryCommunicator: { userId } }), { compact });
      assert.match(html, /미지정/); assert.doesNotMatch(html, /합성 보호자|합성 대상자|합성 치료사|합성 센터/);
    }
    const html = primaryCommunicatorMarkup(profile({ participants: [
      { userId: 'guardian', role: 'guardian' },
    ] }), { compact });
    assert.match(html, /보호자 \(보호자\)/);
  }
});

test('an absent primary designation renders nothing without requiring other profile properties', () => {
  for (const current of [null, undefined, {}, { primaryCommunicator: null }])
    for (const compact of [false, true]) assert.equal(primaryCommunicatorMarkup(current, { compact }), '');
});

test('initial reconciliation mounts a closed native disclosure and unchanged polls do not write or replace nodes', () => {
  const f = domFixture(), current = frozen(profile());
  assert.equal(reconcilePrimaryCommunicator(f.host, current), false);
  assert.equal(f.details.open, false); assert.equal(f.label.textContent, '합성 보호자 (보호자)');
  const before = { ...f.counts }, nodes = [f.section, f.details, f.summary, f.label, f.audience];
  for (const open of [false, true]) {
    f.details.open = open; f.summary.focus({ preventScroll: true });
    const focusCount = f.counts.focus;
    for (let poll = 0; poll < 3; poll++) assert.equal(reconcilePrimaryCommunicator(f.host, current), false);
    assert.deepEqual([f.section, f.details, f.summary, f.label, f.audience], nodes);
    assert.equal(f.details.open, open); assert.equal(f.document.activeElement, f.summary);
    assert.equal(f.counts.focus, focusCount); assert.equal(f.counts.mounts, before.mounts);
    assert.equal(f.counts.labelWrites, before.labelWrites); assert.equal(f.counts.clears, before.clears);
  }
});

test('authorized renaming and designation changes write only text and preserve disclosure identity, open state and focus', () => {
  for (const open of [false, true]) {
    const f = domFixture(); reconcilePrimaryCommunicator(f.host, profile());
    f.details.open = open; f.summary.focus({ preventScroll: true });
    const nodes = [f.section, f.details, f.summary, f.label, f.audience];
    const renamed = frozen(profile({ participants: [
      { userId: 'guardian', role: 'guardian', displayName: '<갱신한 합성 이름 & "따옴표">' },
    ] }));
    assert.equal(reconcilePrimaryCommunicator(f.host, renamed), false);
    assert.equal(f.label.textContent, '<갱신한 합성 이름 & "따옴표"> (보호자)');
    assert.equal(f.counts.labelWrites, 1); assert.equal(f.counts.mounts, 1); assert.equal(f.counts.clears, 0);
    assert.deepEqual([f.section, f.details, f.summary, f.label, f.audience], nodes);
    assert.equal(f.details.open, open); assert.equal(f.document.activeElement, f.summary);
    reconcilePrimaryCommunicator(f.host, profile({ primaryCommunicator: { userId: 'recipient' } }));
    assert.equal(f.label.textContent, '합성 대상자 (대상자)'); assert.equal(f.counts.labelWrites, 2);
    reconcilePrimaryCommunicator(f.host, profile({ primaryCommunicator: { userId: 'missing' } }));
    assert.equal(f.label.textContent, '미지정'); assert.equal(f.counts.labelWrites, 3);
    assert.equal(f.details, nodes[1]); assert.equal(f.details.open, open);
    assert.equal(f.document.activeElement, f.summary); assert.equal(f.counts.mounts, 1);
  }
});

test('null removal clears old names and returns true only when the caller must rescue removed focus', () => {
  for (const focused of [false, true]) {
    const f = domFixture(); reconcilePrimaryCommunicator(f.host, profile());
    const oldLabel = f.label, oldSummary = f.summary;
    if (focused) f.summary.focus({ preventScroll: true });
    assert.equal(reconcilePrimaryCommunicator(f.host, { primaryCommunicator: null }), focused);
    assert.equal(f.host.firstChild, null); assert.equal(f.host.innerHTML, '');
    assert.equal(f.host.contains(oldLabel), false); assert.equal(f.host.contains(oldSummary), false);
    assert.equal(f.document.activeElement, f.document.body); assert.equal(f.counts.clears, 1);
    // The helper reports focus rescue; it must not itself choose another room
    // or recreate a removed identity to restore focus.
    assert.equal(f.counts.focus, focused ? 1 : 0);
    assert.equal(reconcilePrimaryCommunicator(f.host, null), false); assert.equal(f.counts.clears, 1);
  }
});

test('a new mount after removal starts closed instead of reusing the old disclosure preference', () => {
  const f = domFixture(); reconcilePrimaryCommunicator(f.host, profile());
  const oldDetails = f.details, oldSummary = f.summary; oldDetails.open = true; oldSummary.focus({ preventScroll: true });
  assert.equal(reconcilePrimaryCommunicator(f.host, null), true);
  assert.equal(reconcilePrimaryCommunicator(f.host, profile({ primaryCommunicator: { userId: 'recipient' } })), false);
  assert.notEqual(f.details, oldDetails); assert.notEqual(f.summary, oldSummary);
  assert.equal(f.details.open, false); assert.equal(f.label.textContent, '합성 대상자 (대상자)');
  assert.equal(f.document.activeElement, f.document.body); assert.equal(f.counts.mounts, 2);
});
