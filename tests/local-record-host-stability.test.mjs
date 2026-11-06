// Execute actual app functions with a narrow DOM double. Moving a focused
// subtree models focus loss, but this is not evidence of native browser focus,
// layout, networking or assistive-technology behavior.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const appSource = await readFile(new URL('../local-api/app.js', import.meta.url), 'utf8');
const functionSource = name => {
  const source = appSource.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert(source, `The app must still define ${name}.`);
  return source;
};
const recipientRoleSource = appSource.match(/^const recipientRole = [^\r\n]+;$/m)?.[0];
assert(recipientRoleSource, 'Use the actual app role predicate, not a fixed false fixture.');
const functions = [recipientRoleSource, ...['parkCare', 'applyView', 'paint', 'renderSurfaces', 'resetProjections'].map(functionSource)].join('\n');

class Element {
  constructor(document, label, { tag = 'div', dataset = {}, hidden = false } = {}) {
    Object.assign(this, { ownerDocument: document, label, tagName: tag.toUpperCase(), dataset, hidden,
      children: [], parentElement: null, html: '', textContent: '', disabled: false, writes: 0 });
    this.classList = { toggle() {} };
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  get isConnected() { return this.ownerDocument.body.contains(this); }
  focus(options) { this.ownerDocument.activeElement = this; this.lastFocus = options; }
  matches(selector) {
    if (selector === 'button') return this.tagName === 'BUTTON';
    const attribute = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) {
      const key = attribute[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return Object.hasOwn(this.dataset, key) && (attribute[2] === undefined || this.dataset[key] === attribute[2]);
    }
    return selector === `#${this.label}` || selector === `.${this.label}`;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  detach() {
    if (!this.parentElement) return;
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  append(node) {
    node.detach(); node.parentElement = this; this.children.push(node);
    if (node === this.ownerDocument.careHost) this.ownerDocument.moves.push(this.label);
  }
  replaceChildren(...nodes) { for (const node of [...this.children]) node.detach(); for (const node of nodes) this.append(node); }
  get innerHTML() { return this.html; }
  set innerHTML(html) {
    this.replaceChildren(); this.html = html; this.writes++;
    // These are the only slots this test needs from generated HTML. Do not
    // pretend to parse clinical markup or implement a browser HTML parser.
    for (const [marker, dataset, label] of [
      ['data-record-care', { recordCare: '' }, 'record-slot'],
      ['data-chat-care', { chatCare: '' }, 'chat-slot'],
      ['data-testid="message-list"', { testid: 'message-list' }, 'message-list'],
    ]) if (html.includes(marker)) this.append(new Element(this.ownerDocument, label, { dataset }));
  }
}

const emptyChat = '<div class="empty room-empty"><h2>아이의 대화를 선택해 주세요</h2><p>소식과 기록을 한곳에서 이어갈 수 있어요.</p></div>';
const recordMarkup = name => `<h2 class="context-title">${name}</h2><div data-record-care></div>`;
function fixture(role = 'therapist') {
  const document = { moves: [], activeElement: null, careHost: null };
  document.body = new Element(document, 'body'); document.activeElement = document.body;
  const app = new Element(document, 'app'); document.body.append(app);
  const add = (label, options = {}, parent = app) => { const node = new Element(document, label, options); parent.append(node); return node; };
  const pages = Object.fromEntries(['home', 'chat', 'records', 'child'].map(name => [name, add(`page-${name}`, { dataset: { page: name } })]));
  const home = add('home', { dataset: { testid: 'home' } }, pages.home);
  const grid = add('workspace-grid', {}, pages.chat);
  const chat = add('room', { dataset: { testid: 'room' } }, grid);
  const inbox = add('inbox', { dataset: { testid: 'inbox' } }, grid);
  const records = add('records-content', { dataset: { testid: 'records-content' } }, pages.records);
  const child = add('child-content', { dataset: { testid: 'child-content' } }, pages.child);
  add('child-toolbar'); const selector = add('child-select', { tag: 'select' });
  const parking = add('care-parking', { dataset: { careParking: '' }, hidden: true });
  const careHost = new Element(document, 'care-host'); document.careHost = careHost;
  const fillCare = () => {
    if (careHost.children.length) return;
    const button = new Element(document, 'record-action', { tag: 'button', dataset: { careAction: 'new-record' } });
    button.textContent = 'synthetic authorized record action'; careHost.append(button);
  };
  const selected = { conversationId: 'synthetic-room', profile: { name: 'synthetic child' } };
  records.innerHTML = recordMarkup(selected.profile.name); records.querySelector('[data-record-care]').append(careHost); fillCare();
  chat.innerHTML = emptyChat; child.innerHTML = 'synthetic child panel';
  const painted = new WeakMap([[records, records.innerHTML], [child, child.innerHTML], [chat, emptyChat]]);
  const calls = { suspended: 0, viewerSuspended: 0, renders: 0, remembered: 0 };
  const user = { centers: [{ id: 'synthetic-center', role }] };
  const context = { document, app, painted, careHost, mediaHost: null,
    user, centerId: 'synthetic-center',
    phase: 'workspace', connected: true, projectionRecovery: 'checking', activeView: 'records', roomOpen: false,
    roomId: selected.conversationId, rooms: [selected], profile: selected.profile,
    messages: [{ id: 'synthetic-message' }], timelineWindow: null, historyNotice: '', committedPeriod: {}, renderKey: '', targetId: null,
    getContext: () => ({ role: user.centers[0].role, connected: context.connected }), getMediaContext: () => ({}),
    escape: String, childName: room => room.profile.name, childMarkup: () => 'synthetic child panel',
    renderInbox() {}, renderHome() {}, announce() {}, loadingMarkup: name => `loading ${name}`,
    care: { update() { calls.renders++; if (context.connected) fillCare(); }, suspend() { calls.suspended++; careHost.replaceChildren(); } },
    viewer: { suspend() { calls.viewerSuspended++; } }, media: { update() {} },
    chatLayout: { disconnect() {} }, parkMedia() {}, updateComposer() {}, fitChatViewport() {},
    restoreMessagePosition() {}, readingPositions: new Map(), draftKey: () => 'synthetic-scope',
    rememberReadingPosition() { calls.remembered++; }, tryRead() {}, requestAnimationFrame() {},
    renderRoom() { if (!chat.querySelector('[data-testid="message-list"]'))
      chat.innerHTML = '<div data-chat-care></div><ol data-testid="message-list"></ol>'; },
  };
  const run = expression => runInNewContext(`'use strict';\n{\n${functions}\n${expression}\n}`, context, { timeout: 1000 });
  document.moves.length = 0;
  return { document, app, context, careHost, records, chat, child, home, inbox, parking, selector, calls, run };
}

test('recipient rendering clears a pre-existing clinical host and does not update or mount it', () => {
  const f = fixture('care_recipient'), oldButton = f.careHost.children[0];
  f.context.activeView = 'home'; f.run('renderSurfaces();');
  assert.equal(f.records.innerHTML, ''); assert.equal(f.careHost.children.length, 0);
  assert.equal(f.careHost.parentElement, f.parking); assert.equal(oldButton.isConnected, false);
  assert.equal(f.calls.renders, 0); assert.equal(f.calls.suspended, 1);
  f.run('renderSurfaces();'); assert.equal(f.calls.renders, 0); assert.equal(f.careHost.children.length, 0);
});

test('unchanged authorized records polling keeps its host in place and preserves its focused button', () => {
  const f = fixture(), slot = f.careHost.parentElement, button = f.careHost.children[0], writes = f.records.writes;
  button.focus({ preventScroll: true });
  for (let poll = 0; poll < 3; poll++) {
    f.run('renderSurfaces();');
    assert.deepEqual(f.document.moves, [], 'An unchanged visible records host must never visit hidden parking.');
    assert.equal(f.careHost.parentElement, slot); assert.equal(f.careHost.children[0], button);
    assert.equal(f.document.activeElement, button); assert.equal(f.records.writes, writes);
  }
  assert.equal(f.calls.renders, 3); assert.equal(f.calls.suspended, 0);
});

test('records to chat and back preserves the single host while safely clearing the old chat subtree', () => {
  const f = fixture(); f.context.activeView = 'chat'; f.context.roomOpen = true;
  f.run('renderSurfaces();');
  const oldChatSlot = f.careHost.parentElement;
  assert.equal(oldChatSlot.dataset.chatCare, ''); assert.equal(f.careHost.isConnected, true);
  assert.deepEqual(f.document.moves, ['chat-slot']);
  f.document.moves.length = 0; f.context.activeView = 'records'; f.context.roomOpen = false;
  f.run('renderSurfaces();');
  assert.deepEqual(f.document.moves, ['care-parking', 'record-slot']);
  assert.equal(oldChatSlot.isConnected, false); assert.equal(f.careHost.isConnected, true);
  assert.equal(f.careHost.parentElement, f.records.querySelector('[data-record-care]'));
  assert.equal(f.chat.querySelector('[data-testid="message-list"]'), null);
});

test('a changed records slot parks the owned host before replacement and reattaches it exactly once', () => {
  const f = fixture(), oldSlot = f.careHost.parentElement, button = f.careHost.children[0];
  f.context.rooms[0].profile.name = 'updated synthetic child';
  f.run('renderSurfaces();');
  assert.deepEqual(f.document.moves, ['care-parking', 'record-slot']);
  assert.equal(oldSlot.isConnected, false); assert.notEqual(f.careHost.parentElement, oldSlot);
  assert.equal(f.careHost.children[0], button); assert.equal(f.careHost.isConnected, true);
  assert(f.records.innerHTML.includes('updated synthetic child'));
});

test('leaving records for a page without a care slot parks once and ordinary hidden-page polling does not move it', () => {
  const f = fixture(); f.context.activeView = 'home';
  f.run('renderSurfaces();'); assert.equal(f.careHost.parentElement, f.parking);
  assert.deepEqual(f.document.moves, ['care-parking']); f.document.moves.length = 0;
  f.run('renderSurfaces();renderSurfaces();'); assert.deepEqual(f.document.moves, []);
  assert.equal(f.careHost.parentElement, f.parking); assert.equal(f.parking.hidden, true);
});

test('permission reset still clears sensitive projections and reconnect creates controls only after new authorized data', () => {
  const f = fixture(), oldButton = f.careHost.children[0]; oldButton.focus();
  f.run('resetProjections();');
  assert.equal(f.context.connected, false); assert.equal(f.context.profile, null);
  assert.equal(f.context.rooms.length, 0); assert.equal(f.context.messages.length, 0);
  assert.equal(f.careHost.children.length, 0); assert.equal(oldButton.isConnected, false);
  assert.equal(f.document.activeElement, f.document.body); assert.equal(f.careHost.parentElement, f.parking);
  assert.equal(f.calls.suspended, 1); assert.equal(f.calls.viewerSuspended, 1);
  for (const node of [f.records, f.child, f.home, f.inbox, f.chat]) {
    assert(node.innerHTML.startsWith('loading ')); assert.equal(f.context.painted.has(node), false);
  }
  f.run('renderSurfaces();'); assert.equal(f.careHost.children.length, 0);
  const next = { conversationId: 'synthetic-room', profile: { name: 'reauthorized synthetic child' } };
  Object.assign(f.context, { connected: true, rooms: [next], profile: next.profile });
  f.run('renderSurfaces();');
  assert.equal(f.careHost.parentElement, f.records.querySelector('[data-record-care]'));
  assert.notEqual(f.careHost.children[0], oldButton); assert.equal(oldButton.isConnected, false);
});
