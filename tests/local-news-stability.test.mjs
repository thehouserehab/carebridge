// Actual presentation/activation helpers with deliberately small DOM doubles.
// The template double parses only newsMarkup's top-level buttons/empty notice;
// this is not browser parsing, native focus, pointer or assistive-device proof.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { orderedNews, reconcileNewsList, bindNewsActivation } from '../local-api/workspace-ui.js';

const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g,
  (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]);
class Element {
  constructor(document, tag = 'div') {
    this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = [];
    this.parentElement = null; this.attrs = new Map(); this.events = new Map(); this.html = '';
    this.writes = 0; this.moves = 0; this.focusCalls = []; this.bounds = { top: 40, left: 20, width: 300, height: 120 };
  }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get dataset() { return Object.fromEntries([...this.attrs].filter(([name]) => name.startsWith('data-'))
    .map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  hasAttribute(name) { return this.attrs.has(name); }
  removeAttribute(name) { this.attrs.delete(name); }
  toggleAttribute(name, force) { if (force) this.setAttribute(name, ''); else this.removeAttribute(name); return !!force; }
  matches(selector) { assert.equal(selector, 'button[data-news-room]'); return this.tagName === 'BUTTON' && this.hasAttribute('data-news-room'); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  contains(node) { return !!node && (node === this || this.children.some(child => child.contains(node))); }
  focus(options) { this.focusCalls.push({ preventScroll: options?.preventScroll }); this.ownerDocument.activeElement = this; }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null;
    }
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  append(node) {
    if (node.tagName === '#FRAGMENT') { for (const child of [...node.children]) this.append(child); return; }
    node.remove(); this.children.push(node); node.parentElement = this; this.moves++;
  }
  insertBefore(node, cursor) {
    if (node === cursor) return;
    node.remove(); const index = cursor === null ? this.children.length : this.children.indexOf(cursor);
    assert(index >= 0); this.children.splice(index, 0, node); node.parentElement = this; this.moves++;
  }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); for (const node of nodes) this.append(node); }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
  get innerHTML() { return this.html; }
  set innerHTML(value) { for (const child of [...this.children]) child.remove(); this.html = value; this.writes++; }
  getBoundingClientRect() { return { ...this.bounds }; }
  addEventListener(type, callback, capture) {
    assert.equal(capture, true, 'Activation checks must precede bubbling app handlers.');
    const listeners = this.events.get(type) ?? []; listeners.push(callback); this.events.set(type, listeners);
  }
}
function documentDouble() {
  const document = { activeElement: null };
  document.body = new Element(document, 'body'); document.activeElement = document.body;
  document.createElement = tag => {
    if (tag !== 'template') return new Element(document, tag);
    const content = new Element(document, '#fragment');
    return { content, set innerHTML(html) {
      content.replaceChildren();
      const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
      for (const match of buttons) {
        const button = new Element(document, 'button');
        for (const attribute of match[1].matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/g))
          button.setAttribute(attribute[1], decode(attribute[2]));
        button.innerHTML = match[2]; content.append(button);
      }
      if (!buttons.length) {
        assert.match(html, /^<p class="empty">[\s\S]*<\/p>$/);
        const notice = new Element(document, 'p'); notice.innerHTML = html; content.append(notice);
      }
    } };
  };
  return document;
}
const room = (id, overrides = {}) => ({ conversationId: id, unread: 0, targetId: `message-${id}`,
  profile: { name: `가상 ${id}`, participants: [{ userId: 'author', displayName: '가상 치료사', role: 'therapist' }] },
  latest: { authorId: 'author', body: `가상 소식 ${id}`, createdAt: '2026-10-14T00:00:00Z' },
  ...overrides });
const order = host => host.children.map(node => node.dataset.newsRoom).filter(Boolean);
function listFixture(rooms = [room('a'), room('b')], options = {}) {
  const document = documentDouble(), host = new Element(document);
  host.setAttribute('tabindex', '-1'); document.body.append(host);
  assert.equal(reconcileNewsList(host, rooms, options), false);
  return { document, host, rooms, buttons: [...host.children] };
}
function frozen(value) { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }

test('news ordering groups unread rooms stably without changing its source or copying private data', () => {
  const rooms = frozen([room('a'), room('b', { unread: 2 }), room('c'), room('d', { unread: 1 })]);
  const before = JSON.stringify(rooms), result = orderedNews(rooms);
  assert.notEqual(result, rooms); assert.deepEqual(result.map(item => item.conversationId), ['b', 'd', 'a', 'c']);
  assert.equal(result[0], rooms[1]); assert.equal(result[1], rooms[3]);
  assert.equal(JSON.stringify(rooms), before); assert.deepEqual(orderedNews([]), []);
});

test('keyed updates retain the same focused button while replacing current author/body/unread/home target', () => {
  const f = listFixture(undefined, { home: true }), button = f.buttons[0]; button.focus({ preventScroll: true });
  const changed = room('a', { unread: 7, targetId: 'new-target',
    profile: { name: '<갱신 아동>', participants: [{ userId: 'new-author', displayName: '<새 보호자>', role: 'guardian' }] },
    latest: { authorId: 'new-author', body: '<현재 소식> & 확인', createdAt: '2026-10-14T01:02:00Z' } });
  const data = frozen([changed, room('b')]), before = JSON.stringify(data), oldHtml = button.innerHTML;
  assert.equal(reconcileNewsList(f.host, data, { home: true, preserveOrder: true }), false);
  assert.equal(f.host.children[0], button); assert.equal(f.document.activeElement, button);
  assert.equal(button.dataset.targetId, 'new-target'); assert.equal(button.dataset.openRoom, 'a');
  assert.notEqual(button.innerHTML, oldHtml); assert(button.innerHTML.includes('&lt;새 보호자&gt;'));
  assert(button.innerHTML.includes('&lt;현재 소식&gt; &amp; 확인')); assert(button.innerHTML.includes('새 소식 7'));
  assert(!button.innerHTML.includes('가상 소식 a')); assert(!button.innerHTML.includes('<새 보호자>'));
  assert.equal(JSON.stringify(data), before);
});

test('preserved order reports pending sorting, appends new rooms and still replaces all current content', () => {
  const f = listFixture(), [a, b] = f.buttons; a.focus({ preventScroll: true });
  const desired = frozen([room('c'), room('b', { unread: 2 }), room('a')]);
  assert.equal(reconcileNewsList(f.host, desired, { preserveOrder: true }), true);
  assert.deepEqual(order(f.host), ['a', 'b', 'c']); assert.equal(f.document.activeElement, a);
  assert(b.innerHTML.includes('새 소식 2')); const c = f.host.children[2];
  assert.equal(reconcileNewsList(f.host, desired, { preserveOrder: false }), false);
  assert.deepEqual(order(f.host), ['c', 'b', 'a']);
  assert.equal(f.host.children[0], c); assert.equal(f.host.children[1], b); assert.equal(f.host.children[2], a);
  assert.deepEqual(desired.map(item => item.conversationId), ['c', 'b', 'a']);
});

test('unchanged snapshots avoid content writes or moves and remove obsolete selection/navigation attributes', () => {
  const f = listFixture(undefined, { selectedId: 'a' }), a = f.buttons[0];
  const writes = a.writes, moves = f.host.moves;
  assert.equal(reconcileNewsList(f.host, f.rooms, { selectedId: 'a', preserveOrder: true }), false);
  assert.equal(a.writes, writes); assert.equal(f.host.moves, moves); assert.equal(a.getAttribute('aria-current'), 'true');
  a.setAttribute('data-stale-private', 'PRIVATE');
  reconcileNewsList(f.host, f.rooms, { selectedId: 'b', preserveOrder: true });
  assert.equal(a.hasAttribute('aria-current'), false); assert.equal(a.hasAttribute('data-stale-private'), false);
  reconcileNewsList(f.host, f.rooms, { home: true, preserveOrder: true });
  assert.equal(a.hasAttribute('data-room-id'), false); assert.equal(a.dataset.targetId, 'message-a');
  reconcileNewsList(f.host, f.rooms, { preserveOrder: true });
  assert.equal(a.hasAttribute('data-open-room'), false); assert.equal(a.hasAttribute('data-target-id'), false);
  assert.equal(a.dataset.roomId, 'a');
});

test('revoked and duplicate rooms are removed immediately, moving affected focus to the authorized host', () => {
  const f = listFixture(), [a, b] = f.buttons;
  const nested = new Element(f.document, 'span'); a.append(nested); nested.focus();
  assert.equal(reconcileNewsList(f.host, [room('b')], { preserveOrder: true }), false);
  assert.deepEqual(order(f.host), ['b']); assert.equal(a.parentElement, null); assert.equal(f.host.children[0], b);
  assert.equal(f.document.activeElement, f.host); assert.deepEqual(f.host.focusCalls, [{ preventScroll: true }]);
  const duplicate = new Element(f.document, 'button'); duplicate.setAttribute('data-news-room', 'b'); f.host.append(duplicate); duplicate.focus();
  reconcileNewsList(f.host, [room('b')], { preserveOrder: true });
  assert.deepEqual(f.host.children, [b]); assert.equal(f.document.activeElement, f.host);
});

test('empty permission lists remove every old button and show only the empty notice; reappearance is a new node', () => {
  const f = listFixture(), old = f.buttons[0]; old.focus();
  assert.equal(reconcileNewsList(f.host, [], { preserveOrder: true }), false);
  assert.deepEqual(order(f.host), []); assert.equal(f.host.children.length, 1);
  assert(f.host.children[0].innerHTML.includes('연결된 아동이 없습니다.'));
  assert.equal(f.document.activeElement, f.host); assert.equal(old.parentElement, null);
  assert.equal(reconcileNewsList(f.host, [room('a')], { preserveOrder: true }), false);
  assert.notEqual(f.host.children[0], old); assert.deepEqual(order(f.host), ['a']);
});

function activationFixture() {
  const document = documentDouble(), root = new Element(document), button = new Element(document, 'button');
  document.body.append(root); root.append(button); button.setAttribute('data-news-room', 'a'); button.setAttribute('data-target-id', 'target-a');
  const nested = new Element(document, 'span'); button.append(nested);
  let generation = 3, changes = 0;
  bindNewsActivation(root, () => generation, () => { changes++; });
  const emit = (type, fields = {}) => {
    const event = { target: nested, button: 0, detail: 1, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...fields };
    for (const listener of root.events.get(type) ?? []) { listener(event); if (event.stopped) break; }
    return event;
  };
  return { document, root, button, nested, emit, nextGeneration() { generation++; }, get changes() { return changes; } };
}
function press(f, kind) { f.emit(kind === 'pointer' ? 'pointerdown' : 'keydown', kind === 'pointer' ? {} : { key: kind }); }
const click = (f, kind, extra = {}) => f.emit('click', { detail: kind === 'pointer' ? 1 : 0, ...extra });

test('stable primary pointer and Enter/Space activations pass through nested labels without altering click', () => {
  for (const kind of ['pointer', 'Enter', ' ']) {
    const f = activationFixture(); press(f, kind); const event = click(f, kind);
    assert.equal(event.prevented, false); assert.equal(event.stopped, false); assert.equal(f.changes, 0);
  }
});

test('changed room, target, generation or any rectangle dimension cancels the pending pointer/key activation once', () => {
  const alterations = [f => f.button.setAttribute('data-news-room', 'another-room'),
    f => f.button.setAttribute('data-target-id', 'another-target'), f => f.button.removeAttribute('data-target-id'),
    f => f.nextGeneration(), ...['top', 'left', 'width', 'height'].map(key => f => { f.button.bounds[key] += 1; })];
  for (const kind of ['pointer', 'Enter', ' ']) for (const alter of alterations) {
    const f = activationFixture(); press(f, kind); alter(f); const event = click(f, kind);
    assert.equal(event.prevented, true); assert.equal(event.stopped, true); assert.equal(f.changes, 1);
    press(f, kind); assert.equal(click(f, kind).prevented, false); assert.equal(f.changes, 1);
  }
});

test('removed controls and a click landing on a different news button cannot reuse the original press', () => {
  for (const otherButton of [false, true]) {
    const f = activationFixture(); press(f, 'pointer'); let target = f.nested;
    if (otherButton) { target = new Element(f.document, 'button'); target.setAttribute('data-news-room', 'b'); f.root.append(target); }
    else f.button.remove();
    assert.equal(click(f, 'pointer', { target }).prevented, true); assert.equal(f.changes, 1);
  }
});

test('subpixel geometry jitter stays within tolerance and direct assistive-technology-style clicks remain usable', () => {
  const stable = activationFixture(); press(stable, 'pointer'); stable.button.bounds.top += 0.5;
  assert.equal(click(stable, 'pointer').prevented, false);
  const direct = activationFixture(); direct.nextGeneration();
  assert.equal(direct.emit('click', { detail: 0 }).prevented, false); assert.equal(direct.changes, 0);
  press(direct, 'pointer'); direct.nextGeneration();
  assert.equal(direct.emit('click', { detail: 0 }).prevented, false, 'A pointer snapshot is not an AT click.');
});

test('Escape and Tab cancel the pending same-kind click even without a content change, then allow a fresh press', () => {
  for (const kind of ['pointer', 'Enter', ' ']) for (const key of ['Escape', 'Tab']) {
    const f = activationFixture(); press(f, kind); f.emit('keydown', { key });
    const event = click(f, kind); assert.equal(event.prevented, true); assert.equal(event.stopped, true);
    assert.equal(f.changes, 1);
    press(f, kind); assert.equal(click(f, kind).prevented, false); assert.equal(f.changes, 1);
  }
});

test('pointer cancellation suppresses a residual pointer click and a secondary press cannot seed activation', () => {
  const cancelled = activationFixture(); press(cancelled, 'pointer'); cancelled.emit('pointercancel');
  assert.equal(click(cancelled, 'pointer').prevented, true); assert.equal(cancelled.changes, 1);
  press(cancelled, 'pointer'); assert.equal(click(cancelled, 'pointer').prevented, false);
  const secondary = activationFixture(); press(secondary, 'pointer'); secondary.nextGeneration();
  secondary.emit('pointerdown', { button: 2 });
  assert.equal(secondary.emit('click', { detail: 0 }).prevented, false); assert.equal(secondary.changes, 0);
  press(secondary, ' '); assert.equal(click(secondary, ' ').prevented, false);
});

test('repeated Enter/Space keydowns prevent repeated activation and cannot replace the original press snapshot', () => {
  for (const kind of ['Enter', ' ']) {
    const f = activationFixture(); press(f, kind); f.button.setAttribute('data-target-id', 'updated-while-held');
    assert.equal(f.emit('keydown', { key: kind, repeat: true }).prevented, true);
    assert.equal(click(f, kind).prevented, true); assert.equal(f.changes, 1);
    press(f, kind); assert.equal(click(f, kind).prevented, false);
  }
});

const appSource = await readFile(new URL('../local-api/app.js', import.meta.url), 'utf8');
const recipientRoleSource = appSource.match(/^const recipientRole = [^\r\n]+;$/m)?.[0];
assert(recipientRoleSource, 'Use the actual app role predicate, not a fixed false fixture.');
function runApp(name, context, argument = '') {
  const source = appSource.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert(source); return runInNewContext(`'use strict';\n{\n${recipientRoleSource}\n${source}\n${name}(${argument});\n}`, context, { timeout: 1000 });
}

test('actual inbox rendering holds visible rows, exposes pending order and applies only explicit sorting', () => {
  const f = listFixture(), sort = new Element(f.document, 'button'), nav = {};
  const rooms = frozen([room('b', { unread: 3 }), room('a')]);
  const context = { activeView: 'chat', roomOpen: false, connected: true, roomId: 'a', rooms,
    app: { querySelector: name => ({ '[data-testid="inbox"]': f.host, '[data-news-sort="chat"]': sort, '.main-nav': nav })[name] },
    painted: new WeakMap([[f.host, 'old-markup']]), reconcileNewsList,
    getComputedStyle: () => ({ position: 'fixed' }), paint() { assert.fail('Authorized inbox must reconcile, not replace its host.'); } };
  const a = f.buttons[0]; a.focus(); runApp('renderInbox', context);
  assert.deepEqual(order(f.host), ['a', 'b']); assert.equal(f.document.activeElement, a);
  assert.equal(sort.hasAttribute('data-pending'), true); assert.equal(sort.textContent, '새 순서 적용');
  assert.equal(context.painted.has(f.host), false);
  runApp('renderInbox', context, 'false'); assert.deepEqual(order(f.host), ['b', 'a']);
  assert.equal(sort.hasAttribute('data-pending'), false); assert.equal(sort.textContent, '새 소식순 정렬');
  context.rooms = [room('b')]; runApp('renderInbox', context);
  assert.deepEqual(order(f.host), ['b']); assert.equal(a.parentElement, null);
});

test('actual home rendering updates panels and latest news without replacing the focused news host or input rooms', () => {
  const f = listFixture(undefined, { home: true }), sort = new Element(f.document, 'button');
  const panels = { schedule: new Element(f.document), work: new Element(f.document) };
  const host = { querySelector(name) {
    if (name === '[data-home-news]') return f.host;
    if (name === '[data-news-sort="home"]') return sort;
    return panels[/data-home-panel="(schedule|work)"/.exec(name)?.[1]];
  }, set innerHTML(value) { assert.fail('An established home must not replace its focused news list.'); } };
  const rooms = frozen([room('a'), room('b', { unread: 2, targetId: 'new-b' })]), before = JSON.stringify(rooms);
  const context = { activeView: 'home', connected: true, rooms, committedPeriod: {},
    user: { centers: [{ id: 'synthetic-center', role: 'therapist' }] }, centerId: 'synthetic-center',
    app: { querySelector: name => { assert.equal(name, '[data-testid="home"]'); return host; } },
    getContext: () => ({ role: 'therapist' }), homeMarkup: () => 'synthetic updated home panels',
    document: { createElement: () => ({ innerHTML: '', content: { querySelector: name => ({ innerHTML: `updated ${name}` }) } }) },
    painted: new WeakMap(), orderedNews, reconcileNewsList, paint(node, html) { node.innerHTML = html; } };
  const a = f.buttons[0]; a.focus(); runApp('renderHome', context);
  assert.deepEqual(order(f.host), ['a', 'b']); assert.equal(f.document.activeElement, a);
  assert.equal(f.buttons[1].dataset.targetId, 'new-b'); assert.equal(sort.hasAttribute('data-pending'), true);
  assert.equal(panels.schedule.writes, 1); assert.equal(panels.work.writes, 1);
  runApp('renderHome', context, 'false'); assert.deepEqual(order(f.host), ['b', 'a']);
  assert.equal(sort.hasAttribute('data-pending'), false); assert.equal(JSON.stringify(rooms), before);
});

test('actual recipient home reconciles news without querying absent clinical panels or replacing focused rows', () => {
  const f = listFixture(undefined, { home: true }), sort = new Element(f.document, 'button');
  const host = { querySelector(name) {
    if (name === '[data-home-news]') return f.host;
    if (name === '[data-news-sort="home"]') return sort;
    assert.fail('Recipient home must not query clinical panels.');
  }, set innerHTML(value) { assert.fail('Existing recipient news host must be retained.'); } };
  const user = { centers: [{ id: 'synthetic-center', role: 'care_recipient' }] };
  const context = { activeView: 'home', connected: true, rooms: frozen([room('a'), room('b', { unread: 1 })]), committedPeriod: {},
    user, centerId: 'synthetic-center', getContext: () => ({ role: user.centers[0].role }),
    app: { querySelector: name => { assert.equal(name, '[data-testid="home"]'); return host; } },
    homeMarkup: () => 'synthetic recipient news only',
    document: { createElement: () => ({ innerHTML: '', content: { querySelector() { assert.fail('No clinical template panel.'); } } }) },
    painted: new WeakMap(), orderedNews, reconcileNewsList, paint() { assert.fail('News reconciliation owns the existing rows.'); } };
  const a = f.buttons[0]; a.focus(); runApp('renderHome', context);
  assert.deepEqual(order(f.host), ['a', 'b']); assert.equal(f.document.activeElement, a);
  assert.equal(sort.hasAttribute('data-pending'), true); assert.match(f.buttons[1].innerHTML, /새 소식 1/);
});
