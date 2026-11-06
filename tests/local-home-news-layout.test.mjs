// Pure markup contracts only. These checks do not prove rendered row height,
// two-line clipping, browser focus, accessibility-tree output or API authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newsMarkup } from '../local-api/workspace-ui.js';

const room = (overrides = {}) => ({
  conversationId: 'synthetic-room', targetId: 'synthetic-message', unread: 2,
  profile: { name: '합성 아동', participants: [
    { userId: 'synthetic-author', displayName: '합성 보호자', role: 'guardian' },
  ] },
  latest: { authorId: 'synthetic-author', body: '합성 소식 본문', createdAt: '2026-10-14T01:02:00Z' },
  ...overrides,
});
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
const openingButton = html => html.match(/^<button\b[\s\S]*?>/)?.[0] ?? '';
const badge = html => html.match(/<span\b[^>]*\bclass="badge(?: [^"]*)?"[^>]*>[\s\S]*?<\/span>/)?.[0] ?? '';
function oneButton(html) {
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.equal((html.match(/<\/button>/g) ?? []).length, 1);
  assert.match(openingButton(html), /\btype="button"/);
  assert.doesNotMatch(html, /<(?:a|input|select|textarea)\b/);
}

test('home keeps one room action and orders identity, sender/time and preview without the inbox footer', () => {
  const source = frozen([room()]), before = JSON.stringify(source);
  const html = newsMarkup(source, 'synthetic-room', true); oneButton(html);
  const opening = openingButton(html);
  assert.match(opening, /class="room-link home-news-row"/);
  assert.match(opening, /data-news-room="synthetic-room"/);
  assert.match(opening, /data-open-room="synthetic-room"/);
  assert.match(opening, /data-target-id="synthetic-message"/);
  assert.doesNotMatch(opening, /\b(?:data-room-id|aria-current)=/);
  const identity = html.indexOf('class="room-name"'), meta = html.indexOf('class="news-meta"');
  const preview = html.indexOf('class="preview"'), counter = html.indexOf('class="badge"');
  assert(identity > 0 && identity < counter && counter < meta && meta < preview);
  assert.match(html, /<strong>합성 아동<\/strong>/);
  assert.match(html, /class="news-sender">합성 보호자<\/span>/);
  assert.match(html, /10\. 14\. 오전 10:02/);
  assert.match(html, /class="preview">합성 소식 본문<\/span>/);
  assert.match(html, /class="room-cta" aria-hidden="true">→<\/span>/);
  assert.doesNotMatch(html, /class="news-footer"|대화 보기/);
  assert.equal((html.match(/합성 소식 본문/g) ?? []).length, 1);
  assert.equal((html.match(/새 소식 2/g) ?? []).length, 1);
  assert.equal(JSON.stringify(source), before);
});

test('home escapes every displayed identity, author, message and navigation attribute', () => {
  const source = room({ conversationId: 'room-<>&"\'', targetId: 'target-<>&"\'',
    profile: { name: '<아동>&"\'', participants: [
      { userId: 'synthetic-author', displayName: '<보호자>&"\'', role: 'guardian' },
    ] },
    latest: { authorId: 'synthetic-author', body: '<img src=x onerror="bad()"> & \'본문\'', createdAt: '2026-10-14T01:02:00Z' },
  });
  const html = newsMarkup([source], null, true); oneButton(html);
  for (const expected of [
    'data-news-room="room-&lt;&gt;&amp;&quot;&#39;"',
    'data-open-room="room-&lt;&gt;&amp;&quot;&#39;"',
    'data-target-id="target-&lt;&gt;&amp;&quot;&#39;"',
    '<strong>&lt;아동&gt;&amp;&quot;&#39;</strong>',
    'class="news-sender">&lt;보호자&gt;&amp;&quot;&#39;</span>',
    '&lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; &#39;본문&#39;',
  ]) assert(html.includes(expected), expected);
  assert.doesNotMatch(html, /<img\b|<아동>|<보호자>/);
});

test('no latest message keeps empty sender/time and an explicit preview without inventing a target', () => {
  const html = newsMarkup([room({ latest: null, targetId: null, unread: 0 })], null, true);
  oneButton(html);
  assert.match(html, /data-target-id=""/);
  assert.match(html, /<span class="news-meta"><span class="news-sender"><\/span><span><\/span><\/span>/);
  assert.match(html, /class="preview">아직 대화가 없어요\.<\/span>/);
  assert.doesNotMatch(html, /이전 참여자|합성 보호자|10\. 14\.|새 소식 \d|>null<|>undefined</);
  assert.match(badge(html), /class="badge badge-empty" aria-hidden="true"><\/span>/);
});

test('a missing current author is labelled as a former participant instead of exposing an unmatched name', () => {
  const html = newsMarkup([room({ latest: { authorId: 'former-author', body: '합성 이전 소식', createdAt: '2026-10-14T01:02:00Z' } })], null, true);
  oneButton(html); assert.match(html, /class="news-sender">이전 참여자<\/span>/);
  assert.match(html, /class="preview">합성 이전 소식<\/span>/);
  assert.doesNotMatch(html, /합성 보호자|former-author/);
});

test('a current author without a display name uses the authorized role label', () => {
  const html = newsMarkup([room({ profile: { name: '합성 아동', participants: [
    { userId: 'synthetic-author', role: 'therapist' },
  ] } })], null, true);
  assert.match(html, /class="news-sender">치료사<\/span>/);
  assert.doesNotMatch(html, /이전 참여자/);
});

test('long names and large unread counts remain complete in markup without duplicating the news action', () => {
  const child = '합성 아동 이름 '.repeat(12), sender = '합성 보호자 이름 '.repeat(12);
  const html = newsMarkup([room({ unread: 123456,
    profile: { name: child, participants: [{ userId: 'synthetic-author', displayName: sender, role: 'guardian' }] },
  })], null, true);
  oneButton(html); assert(html.includes(`<strong>${child}</strong>`));
  assert(html.includes(`<span class="news-sender">${sender}</span>`));
  assert.match(badge(html), />새 소식 123456<\/span>/);
  assert.doesNotMatch(badge(html), /aria-hidden|badge-empty/);
});

test('zero unread retains an empty hidden badge and a deliberately blank message is not replaced', () => {
  for (const home of [true, false]) {
    const html = newsMarkup([room({ unread: 0,
      latest: { authorId: 'synthetic-author', body: '', createdAt: 'invalid-date' },
    })], null, home);
    assert.match(badge(html), /class="badge badge-empty" aria-hidden="true"><\/span>/);
    assert.match(html, /class="preview"><\/span>/);
    assert.doesNotMatch(html, /아직 대화가 없어요|Invalid Date|새 소식 0/);
    assert.match(html, /class="news-sender">합성 보호자<\/span><span><\/span>/);
  }
});

test('inbox preserves name, preview, metadata/footer order and only its selected room has aria-current', () => {
  for (const selected of [true, false]) {
    const html = newsMarkup([room()], selected ? 'synthetic-room' : 'another-room', false); oneButton(html);
    const opening = openingButton(html);
    assert.match(opening, /data-news-room="synthetic-room"/);
    assert.match(opening, /data-room-id="synthetic-room"/);
    assert.doesNotMatch(opening, /home-news-row|data-open-room|data-target-id/);
    if (selected) { assert.match(opening, /class="room-link selected"/); assert.match(opening, /aria-current="true"/); }
    else { assert.doesNotMatch(opening, /\bselected\b|aria-current/); }
    const name = html.indexOf('class="room-name"'), preview = html.indexOf('class="preview"');
    const footer = html.indexOf('class="news-footer"'), meta = html.indexOf('class="news-meta"');
    const counter = html.indexOf('class="badge"');
    assert(name > 0 && name < preview && preview < footer && footer < meta && meta < counter);
    assert.doesNotMatch(html, /room-cta|대화 보기/);
  }
});

test('news does not serialize unrelated clinical, account, attachment or participant fields', () => {
  const source = frozen([room({ privateNote: 'PRIVATE-INTERNAL-NOTE',
    care: { records: [{ title: 'PRIVATE-RECORD', assessments: [{ value: 'PRIVATE-MEASUREMENT' }] }] },
    profile: { name: '합성 아동', birthDate: 'PRIVATE-BIRTH-DATE', privateDiagnosis: 'PRIVATE-DIAGNOSIS',
      participants: [{ userId: 'synthetic-author', displayName: '합성 보호자', role: 'guardian', email: 'PRIVATE-EMAIL' },
        { userId: 'other-participant', displayName: 'PRIVATE-OTHER-PARTICIPANT', role: 'guardian' }] },
    latest: { authorId: 'synthetic-author', body: '허용된 합성 요약', createdAt: '2026-10-14T01:02:00Z',
      attachments: [{ storageKey: 'PRIVATE-STORAGE-KEY', name: 'PRIVATE-FILE-NAME' }], internalBody: 'PRIVATE-RAW-MESSAGE' },
  })]), before = JSON.stringify(source);
  for (const home of [true, false]) {
    const html = newsMarkup(source, null, home); oneButton(html);
    assert.match(html, /허용된 합성 요약/); assert.match(html, /합성 보호자/);
    assert.doesNotMatch(html, /PRIVATE-|other-participant|synthetic-author/);
  }
  assert.equal(JSON.stringify(source), before);
});

test('markup keeps caller room order and returns only the empty notice when no room is authorized', () => {
  const rooms = frozen([room({ conversationId: 'second', targetId: 'second-target', unread: 0 }),
    room({ conversationId: 'first', targetId: 'first-target', unread: 4 })]);
  for (const home of [true, false]) {
    const html = newsMarkup(rooms, null, home);
    assert.deepEqual([...html.matchAll(/data-news-room="([^"]+)"/g)].map(match => match[1]), ['second', 'first']);
    assert.equal(newsMarkup([], null, home), '<p class="empty">연결된 아동이 없습니다.</p>');
  }
});
