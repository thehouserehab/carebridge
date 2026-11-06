// Pure helpers and actual app functions with small DOM doubles. No browser,
// native layout, network, authentication or physical-device evidence is claimed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as workspaceUi from '../local-api/workspace-ui.js';
import { renderCareMessage } from '../local-api/care-ui.js';
import { captureMessagePosition, restoreMessagePosition, scrollMessageTarget,
  roomParticipantsMarkup, reconcilePrimaryCommunicator, visibleMessageRows } from '../local-api/workspace-ui.js';

const appSource = await readFile(new URL('../local-api/app.js', import.meta.url), 'utf8');
const rowSelector = '[data-testid="message-row"][data-message-id]';
function appFunction(name) {
  const source = appSource.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert(source, `Missing real app function: ${name}`);
  return source;
}
function runApp(name, context, dependencies = []) {
  return runInNewContext(`'use strict';\n${[...dependencies, name].map(appFunction).join('\n')}\n${name}();`, context, { timeout: 1000 });
}

function messagePane({ top = 100, border = 4, height = 300, scrollTop = 250 } = {}) {
  const queries = [], writes = [], outerScroll = () => assert.fail('Message targeting must not scroll an ancestor.');
  const list = { clientHeight: height, clientTop: border, scrollHeight: 1400, scrollTop,
    getBoundingClientRect() { return { top, bottom: top + this.clientHeight, height: this.clientHeight }; },
    scrollIntoView: outerScroll };
  let styledHeight = '';
  list.style = { get height() { return styledHeight; }, set height(value) {
    styledHeight = value; writes.push(value); if (value) list.clientHeight = Number.parseFloat(value);
  } };
  const node = (offset, id, children = {}) => ({
    dataset: { testid: 'message-row', messageId: id },
    getBoundingClientRect: () => ({ top: top + border + offset - list.scrollTop,
      bottom: top + border + offset - list.scrollTop + 120, height: 120 }),
    scrollIntoView: outerScroll,
    querySelector(selector) {
      assert(['.care-activity h3', '.bubble'].includes(selector));
      return children[selector] ?? null;
    },
  });
  const bubble = node(420), activity = node(460);
  const target = node(400, 'target', { '.bubble': bubble, '.care-activity h3': activity });
  const decoy = node(-900, 'target'); decoy.dataset = { messageId: 'target' };
  const rows = [node(0, 'first'), node(200, 'history'), target];
  list.querySelectorAll = (selector) => {
    queries.push(selector);
    if (selector === rowSelector) return rows;
    if (selector === '[data-message-id]') return [decoy, ...rows];
    assert.fail(`Unexpected pane selector: ${selector}`);
  };
  return { list, rows, queries, writes, node, target, bubble, activity, decoy };
}

test('explicit targets use message rows rather than same-ID nested controls and scroll only the pane', () => {
  const f = messagePane();
  assert.equal(scrollMessageTarget(f.list, 'target'), true);
  assert.equal(f.list.scrollTop, 420);
  assert.deepEqual(f.queries, [rowSelector]);
  assert.equal(f.list.style.height, '');
  assert.equal(scrollMessageTarget(f.list, 'target'), true);
  assert.equal(f.list.scrollTop, 420, 'Repeated targeting must not drift.');
});

test('activity targets prefer their heading, fall back to the bubble, then to the row', () => {
  for (const [children, expected] of [
    [{ activity: 460, bubble: 420 }, 460], [{ bubble: 420 }, 420], [{}, 400],
  ]) {
    const f = messagePane();
    f.rows[2] = f.node(400, 'target', {
      ...(children.activity ? { '.care-activity h3': f.node(children.activity) } : {}),
      ...(children.bubble ? { '.bubble': f.node(children.bubble) } : {}),
    });
    assert.equal(scrollMessageTarget(f.list, 'target', true), true);
    assert.equal(f.list.scrollTop, expected);
  }
  const normal = messagePane();
  assert.equal(scrollMessageTarget(normal.list, 'target', false), true);
  assert.equal(normal.list.scrollTop, 420, 'A normal target must not jump to an activity heading.');
});

test('target geometry accounts for pane borders and does not interpolate IDs into selectors', () => {
  const f = messagePane({ top: -80, border: 7, scrollTop: 310 });
  const id = 'synthetic-\"] [data-private]';
  f.rows[2] = f.node(400, id, { '.bubble': f.node(435) });
  assert.equal(scrollMessageTarget(f.list, id), true);
  assert.equal(f.list.scrollTop, 435);
  assert.deepEqual(f.queries, [rowSelector]);
});

test('missing, removed or hidden targets leave the pane untouched and return false', () => {
  assert.equal(scrollMessageTarget(null, 'target'), false);
  for (const alter of [f => { f.list.clientHeight = 0; }, f => { f.list.clientHeight = -1; },
    f => { f.rows.splice(2, 1); }]) {
    const f = messagePane(); alter(f); const before = f.list.scrollTop;
    assert.equal(scrollMessageTarget(f.list, 'target', true), false);
    assert.equal(f.list.scrollTop, before); assert.deepEqual(f.writes, []);
    if (f.list.clientHeight <= 0) assert.deepEqual(f.queries, []);
  }
  const f = messagePane();
  assert.equal(scrollMessageTarget(f.list, 'no-such-message'), false);
  assert.equal(f.list.scrollTop, 250);
});

test('participant markup escapes names and presents only display name and a public role label', () => {
  const accesses = [];
  const person = new Proxy({ displayName: '<가상 & "이름">', role: 'therapist' }, { get(target, key) {
    accesses.push(key); assert(['displayName', 'role'].includes(key), 'Do not read other participant fields.');
    return target[key];
  } });
  assert.equal(roomParticipantsMarkup([person]),
    '<li><span>&lt;가상 &amp; &quot;이름&quot;&gt;</span><span class="muted">치료사</span></li>');
  assert.deepEqual([...new Set(accesses)].sort(), ['displayName', 'role']);
  assert.equal(roomParticipantsMarkup([]), '');
});

test('participant fallback labels and long Unicode names preserve inputs without exposing IDs or unknown roles', () => {
  const name = '가상 긴 이름 👨‍👩‍👧‍👦 '.repeat(12);
  const participants = Object.freeze([
    Object.freeze({ userId: 'PRIVATE-ID', email: 'PRIVATE-EMAIL', displayName: name, role: 'guardian' }),
    Object.freeze({ displayName: null, role: 'center' }),
    Object.freeze({ role: '<PRIVATE-ROLE>' }),
  ]);
  const before = JSON.stringify(participants), html = roomParticipantsMarkup(participants);
  assert(html.includes(name)); assert(html.includes('보호자')); assert(html.includes('센터 관리자'));
  assert(html.includes('<span>사용자</span>')); assert(!html.includes('PRIVATE-'));
  assert.equal(JSON.stringify(participants), before);
});

function focusFixture(changes = {}, { position = 'fixed', headerTop = 266, navHeight = 64, scrollY = 80 } = {}) {
  const calls = [], title = { focus(options) { calls.push(['focus', options.preventScroll]); } };
  const documentTop = headerTop + scrollY;
  const header = { scrollIntoView(options) { calls.push(['outer', options.block, options.inline, options.behavior]); },
    getBoundingClientRect: () => ({ top: documentTop - context.window.scrollY }) };
  const nav = { getBoundingClientRect: () => ({ height: navHeight }) };
  const context = { activeView: 'chat', roomOpen: true, connected: true, profile: {},
    app: { querySelector(selector) {
      if (selector === '#room-title' || selector.includes('[data-page-title]')) return title;
      if (selector === '.room-head') return header;
      if (selector === '.main-nav') return nav;
      assert.fail(`Unexpected focus selector: ${selector}`);
    } },
    getComputedStyle: value => { assert.equal(value, nav); return { position }; },
    window: { scrollY, scrollTo(options) {
      calls.push(['desktop-outer', options.top, options.behavior]); this.scrollY = options.top;
    } },
    fitChatViewport() { calls.push(['fit']); }, rememberReadingPosition() { calls.push(['remember']); },
    tryRead() {}, requestAnimationFrame(callback) { assert.equal(callback, context.tryRead); calls.push(['read-frame']); },
    ...changes };
  return { context, calls };
}

test('only explicit connected mobile chat focus aligns its header and preserves the read-position flow', () => {
  const f = focusFixture(); runApp('focusPage', f.context);
  assert.deepEqual(f.calls, [['focus', true], ['outer', 'start', 'nearest', 'instant'], ['fit'], ['remember'], ['read-frame']]);
});

test('static navigation, non-chat, closed, disconnected and unselected views never align the outer document', () => {
  for (const changes of [
    { getComputedStyle: () => ({ position: 'static' }) }, { activeView: 'home' },
    { activeView: 'records' }, { roomOpen: false }, { connected: false }, { profile: null },
  ]) {
    const f = focusFixture(changes); runApp('focusPage', f.context);
    assert.deepEqual(f.calls, [['focus', true]]);
  }
});

test('explicit desktop chat focus aligns below the measured sticky menu without repeated drift', () => {
  for (const navHeight of [64, 112]) {
    const f = focusFixture({}, { position: 'sticky', headerTop: 266, navHeight, scrollY: 80 });
    const expected = 266 + 80 - navHeight - 8;
    runApp('focusPage', f.context);
    assert.deepEqual(f.calls, [['focus', true], ['desktop-outer', expected, 'instant'], ['fit'], ['remember'], ['read-frame']]);
    assert.equal(f.context.window.scrollY, expected);
    runApp('focusPage', f.context);
    assert.equal(f.calls.filter(call => call[0] === 'desktop-outer').length, 2);
    assert.equal(f.context.window.scrollY, expected, 'Repeated explicit entry must not subtract the menu height twice.');
  }
  const top = focusFixture({}, { position: 'sticky', headerTop: 10, scrollY: 0 });
  runApp('focusPage', top.context);
  assert.deepEqual(top.calls[1], ['desktop-outer', 0, 'instant']);
});

function layoutFixture({ mobile = true, viewportHeight = 800, innerHeight = 1100, scrollY = 80,
  gridTop = 240, navHeight = 64, navigationPosition = mobile ? 'fixed' : 'sticky',
  heights = [90, 40, 100, 20], hidden = false, changes = {} } = {}) {
  const pane = messagePane({ height: hidden ? 0 : 300 }), captures = [], restores = [], reads = [];
  const noOuterScroll = () => assert.fail('Layout/polling must not move the outer document.');
  const properties = new Map();
  const grid = { getBoundingClientRect: () => ({ top: gridTop }), getClientRects: () => hidden ? [] : [{}],
    style: { getPropertyValue: key => properties.get(key) ?? '',
      setProperty(key, value) { properties.set(key, value); pane.list.clientHeight = Math.max(0, Number.parseFloat(value) - heights.reduce((sum, height) => sum + height, 0)); },
      removeProperty: key => properties.delete(key) } }, nav = { getBoundingClientRect: () => ({ height: navHeight }) };
  const room = { children: [pane.list, ...heights.map(height => ({ getBoundingClientRect: () => ({ height }), scrollIntoView: noOuterScroll }))] };
  const context = { phase: 'workspace', activeView: 'chat', roomOpen: true, connected: true,
    app: { querySelector(selector) { reads.push(selector); return new Map([
      ['[data-testid="message-list"]', pane.list], ['.workspace-grid', grid], ['[data-testid="room"]', room], ['.main-nav', nav],
    ]).get(selector) ?? null; } },
    window: { visualViewport: viewportHeight === null ? null : { height: viewportHeight }, innerHeight, scrollY, scrollTo: noOuterScroll, scrollBy: noOuterScroll },
    getComputedStyle: value => { assert.equal(value, nav); return { position: navigationPosition }; },
    captureMessagePosition(list) { assert.equal(list, pane.list); const position = captureMessagePosition(list); captures.push(position); return position; },
    restoreMessagePosition(list, position) { assert.equal(list, pane.list); restores.push(position); restoreMessagePosition(list, position); },
    ...changes };
  return { ...pane, context, captures, restores, reads, grid, room, nav };
}

test('actual mobile viewport resize aligns the room without stealing focus or moving a modal background', () => {
  for (const modalOpen of [false, true]) {
    const f = focusFixture();
    Object.assign(f.context, { phase: 'workspace',
      document: { querySelector(selector) { assert.equal(selector, 'dialog[open]'); return modalOpen ? {} : null; } },
      fitChatViewport() { f.calls.push(['fit']); } });
    runApp('resizeChatViewport', f.context);
    assert.deepEqual(f.calls, modalOpen ? [['fit']] : [['fit'], ['outer', 'start', 'nearest', 'instant']]);
  }
  const desktop = focusFixture({}, { position: 'sticky' });
  Object.assign(desktop.context, { phase: 'workspace', document: { querySelector: () => null }, fitChatViewport() {} });
  runApp('resizeChatViewport', desktop.context); assert.deepEqual(desktop.calls, []);
});

function disclosurePositionFixture({ summaryScope = '.room-head summary', atEnd = false } = {}) {
  const pane = messagePane({ scrollTop: atEnd ? 1100 : 250 });
  pane.list.isConnected = true;
  let currentList = pane.list;
  const captures = [], restores = [], frames = [], selectors = [];
  const noOuterChange = () => assert.fail('Disclosure layout must not change focus or scroll the outer document.');
  const target = { closest(selector) {
    selectors.push(selector);
    return selector.split(',').map(value => value.trim()).includes(summaryScope) ? target : null;
  }, focus: noOuterChange, scrollIntoView: noOuterChange };
  const context = { phase: 'workspace', activeView: 'chat', roomOpen: true, connected: true,
    generation: 7, roomId: 'synthetic-room', event: { target, preventDefault: () => assert.fail('Keep the native details toggle.') },
    app: { querySelector(selector) { assert.equal(selector, '[data-testid="message-list"]'); return currentList; } },
    document: { activeElement: target }, window: { scrollTo: noOuterChange, scrollBy: noOuterChange },
    focusPage: noOuterChange, fitChatViewport: noOuterChange,
    captureMessagePosition(list) { const position = captureMessagePosition(list); captures.push({ list, position }); return position; },
    restoreMessagePosition(list, position) { restores.push({ list, position }); },
    requestAnimationFrame(callback) { frames.push(callback); },
  };
  return { ...pane, context, captures, restores, frames, selectors,
    replaceList(value) { currentList = value; },
    invoke() { runInNewContext(`'use strict';\n${appFunction('preserveChatDisclosurePosition')}\npreserveChatDisclosurePosition(event);`, context, { timeout: 1000 }); },
  };
}

test('room, tools and media disclosures restore the original end or reading anchor after their native toggle', () => {
  for (const summaryScope of ['.room-head summary', '.chat-tools summary', '[data-chat-media] summary']) {
    for (const atEnd of [false, true]) {
      const f = disclosurePositionFixture({ summaryScope, atEnd }), active = f.context.document.activeElement;
      f.invoke();
      assert.equal(f.captures.length, 1); assert.equal(f.captures[0].list, f.list);
      assert.equal(f.captures[0].position.atEnd, atEnd);
      if (!atEnd) { assert.equal(f.captures[0].position.messageId, 'history'); assert.equal(f.captures[0].position.offset, -50); }
      assert.equal(f.restores.length, 0, 'Restore must wait until after the native details toggle.');
      assert.equal(f.frames.length, 1);
      // Simulate a disclosure changing flex layout before the queued frame.
      f.list.clientHeight = 180; f.list.scrollTop += 76;
      f.frames.shift()();
      assert.equal(f.restores.length, 1); assert.equal(f.restores[0].list, f.list);
      assert.equal(f.restores[0].position, f.captures[0].position, 'Do not capture a new position after layout has moved.');
      assert.equal(f.context.document.activeElement, active);
    }
  }
});

test('queued disclosure restoration is discarded after generation, room, view or message DOM invalidation', () => {
  for (const [label, invalidate] of [
    ['generation', f => { f.context.generation++; }],
    ['room', f => { f.context.roomId = 'another-synthetic-room'; }],
    ['phase', f => { f.context.phase = 'login'; }],
    ['view', f => { f.context.activeView = 'home'; }],
    ['closed room', f => { f.context.roomOpen = false; }],
    ['connection', f => { f.context.connected = false; }],
    ['detached list', f => { f.list.isConnected = false; }],
    ['replaced list', f => { f.replaceList({ ...f.list }); }],
    ['removed list', f => { f.replaceList(null); }],
  ]) {
    const f = disclosurePositionFixture(); f.invoke();
    assert.equal(f.frames.length, 1, label); invalidate(f); f.frames.shift()();
    assert.equal(f.restores.length, 0, label);
  }
});

test('unrelated clicks, message summaries and inactive chat scopes never capture a disclosure bookmark', () => {
  for (const summaryScope of [null, '.message-list summary', '.account-panel summary', '.chat-tools button']) {
    const f = disclosurePositionFixture({ summaryScope }); f.invoke();
    assert.equal(f.captures.length, 0); assert.equal(f.frames.length, 0); assert.equal(f.restores.length, 0);
  }
  for (const changes of [{ phase: 'login' }, { activeView: 'home' }, { roomOpen: false }, { connected: false }]) {
    const f = disclosurePositionFixture(); Object.assign(f.context, changes); f.invoke();
    assert.equal(f.selectors.length, 0); assert.equal(f.captures.length, 0); assert.equal(f.frames.length, 0);
  }
});

test('mobile layout bounds the whole room and lets messages use remaining space without outer scrolling', () => {
  const f = layoutFixture(), before = captureMessagePosition(f.list);
  runApp('fitChatViewport', f.context);
  assert.equal(f.grid.style.getPropertyValue('--mobile-chat-height'), '720px');
  assert.equal(f.list.style.height, '');
  assert.equal(f.list.clientHeight, 470);
  assert.deepEqual(captureMessagePosition(f.list), before);
  assert.equal(f.captures.length, 1); assert.equal(f.restores[0], f.captures[0]);
  f.context.window.scrollY = 900;
  for (let poll = 0; poll < 3; poll++) runApp('fitChatViewport', f.context);
  assert.deepEqual(f.writes, ['']); assert.equal(f.captures.length, 1);
  assert.deepEqual(captureMessagePosition(f.list), before);
});

test('desktop retains its reading minimum while short mobile rooms do not force an overflowing message minimum', () => {
  const desktop = layoutFixture({ mobile: false }), before = captureMessagePosition(desktop.list);
  desktop.grid.getBoundingClientRect = () => assert.fail('Sticky fitting must not use a scrolling grid origin.');
  runApp('fitChatViewport', desktop.context);
  assert.equal(desktop.list.style.height, '462px');
  desktop.context.window.scrollY = 900;
  for (let poll = 0; poll < 3; poll++) runApp('fitChatViewport', desktop.context);
  assert.deepEqual(desktop.writes, ['462px']);
  assert.deepEqual(captureMessagePosition(desktop.list), before);
  const wrappedNav = layoutFixture({ mobile: false, navHeight: 112 });
  runApp('fitChatViewport', wrappedNav.context);
  assert.equal(wrappedNav.list.style.height, '414px');
  for (const mobile of [true, false]) {
    const short = layoutFixture({ mobile, viewportHeight: 180 }); runApp('fitChatViewport', short.context);
    assert.equal(short.list.style.height, mobile ? '' : '320px'); assert.equal(short.list.scrollTop, 250);
    if (mobile) { assert.equal(short.grid.style.getPropertyValue('--mobile-chat-height'), '100px'); assert.equal(short.list.clientHeight, 0); }
  }
});

test('viewport fallback and desktop disclosure growth preserve the reading anchor', () => {
  const mobile = layoutFixture({ viewportHeight: null }); runApp('fitChatViewport', mobile.context);
  assert.equal(mobile.grid.style.getPropertyValue('--mobile-chat-height'), '1020px');
  assert.equal(mobile.list.style.height, '');
  for (const mobile of [false]) {
    const large = layoutFixture({ mobile, viewportHeight: null }); runApp('fitChatViewport', large.context);
    assert.equal(large.list.style.height, mobile ? '560px' : '720px');
    const f = layoutFixture({ mobile }), before = captureMessagePosition(f.list);
    runApp('fitChatViewport', f.context);
    f.room.children.push({ getBoundingClientRect: () => ({ height: 180 }) });
    runApp('fitChatViewport', f.context);
    assert.deepEqual(f.writes, ['462px', mobile ? '282px' : '320px']);
    assert.deepEqual(captureMessagePosition(f.list), before);
    f.room.children.pop(); runApp('fitChatViewport', f.context);
    assert.equal(f.list.style.height, '462px');
    assert.deepEqual(captureMessagePosition(f.list), before);
  }
  const staticNav = layoutFixture({ mobile: false, navigationPosition: 'static', viewportHeight: 1200 });
  runApp('fitChatViewport', staticNav.context);
  assert.equal(staticNav.list.style.height, '614px', 'Non-sticky fallback retains its document-space origin.');
});

test('a zero-height mobile message pane can recover when the visual viewport grows', () => {
  const f = layoutFixture({ viewportHeight: 180 });
  runApp('fitChatViewport', f.context); assert.equal(f.list.clientHeight, 0);
  f.context.window.visualViewport.height = 800;
  runApp('fitChatViewport', f.context);
  assert.equal(f.grid.style.getPropertyValue('--mobile-chat-height'), '720px');
  assert.equal(f.list.clientHeight, 470);
});

test('returning to desktop clears the mobile room constraint and restores desktop fitting', () => {
  const f = layoutFixture(); runApp('fitChatViewport', f.context);
  f.context.getComputedStyle = () => ({ position: 'sticky' });
  runApp('fitChatViewport', f.context);
  assert.equal(f.grid.style.getPropertyValue('--mobile-chat-height'), '');
  assert.equal(f.list.style.height, '462px');
});

test('hidden panes and inactive chat scopes do not change layout or inspect message contents', () => {
  const hidden = layoutFixture({ hidden: true }); runApp('fitChatViewport', hidden.context);
  assert.deepEqual(hidden.writes, []); assert.deepEqual(hidden.queries, []);
  for (const changes of [{ phase: 'login' }, { activeView: 'home' }, { roomOpen: false }, { connected: false }]) {
    const f = layoutFixture({ changes }); runApp('fitChatViewport', f.context);
    assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []); assert.deepEqual(f.captures, []);
  }
});

for (const mobile of [true, false]) test(`the real ${mobile ? 'mobile' : 'desktop'} surface-render path never invokes outer focus during polling or explicit message targeting`, () => {
  const f = layoutFixture({ mobile }), context = f.context, query = context.app.querySelector;
  const selector = { innerHTML: '', value: '', disabled: false }, position = captureMessagePosition(f.list);
  const selected = { conversationId: 'synthetic-room', profile: { name: '가상 아동' } };
  context.app.querySelector = name => name === '#child-select' ? selector : query(name);
  Object.assign(context, { committedPeriod: {}, rooms: [selected], roomId: selected.conversationId,
    profile: selected.profile, targetId: null, targetActivity: false,
    readingPositions: new Map([['synthetic-key', position]]),
    getContext: () => ({ role: 'therapist' }), getMediaContext: () => ({}), recipientRole: () => false,
    renderInbox() {}, renderHome() {}, paint() {}, homeMarkup: () => '', childMarkup: () => '',
    childName: room => room.profile.name, escape: value => value,
    renderRoom() {}, applyView(focus) { assert.notEqual(focus, true); },
    care: { update() {} }, media: { update() {} }, updateComposer() {},
    focusPage() { assert.fail('Routine surface rendering must not align the outer page.'); },
    draftKey: () => 'synthetic-key', scrollMessageTarget,
    rememberReadingPosition() { context.readingPositions.set('synthetic-key', captureMessagePosition(f.list)); },
    tryRead() {}, requestAnimationFrame() {},
  });
  for (let poll = 0; poll < 3; poll++) runApp('renderSurfaces', context, ['fitChatViewport']);
  assert.deepEqual(captureMessagePosition(f.list), position);
  assert.deepEqual(f.writes, [mobile ? '' : '462px']); assert.equal(context.window.scrollY, 80);
  context.targetId = 'target'; context.targetActivity = true;
  runApp('renderSurfaces', context, ['fitChatViewport']);
  assert.equal(f.list.scrollTop, 460); assert.equal(context.targetId, null); assert.equal(context.targetActivity, false);
  assert.equal(context.window.scrollY, 80);
  const afterTarget = captureMessagePosition(f.list);
  context.targetId = 'removed-message';
  runApp('renderSurfaces', context, ['fitChatViewport']);
  assert.deepEqual(captureMessagePosition(f.list), afterTarget); assert.equal(context.targetId, null);
});

function readFixture({ position = 'sticky', navTop = 0, navHeight = 64,
  viewport = { offsetTop: 0, height: 768 }, innerHeight = 768,
  listTop = 0, listHeight = 768, bounds = [[10, 60]], changes = {} } = {}) {
  const calls = [], queries = [], signal = {}, rows = bounds.map(([top, bottom], index) => ({
    dataset: { testid: 'message-row', messageId: `synthetic-${index + 1}`, sequence: String(index + 1) },
    getBoundingClientRect: () => ({ top, bottom, height: bottom - top }),
  }));
  const list = { clientHeight: listHeight,
    getBoundingClientRect: () => ({ top: listTop, bottom: listTop + listHeight, height: listHeight }),
    querySelectorAll(selector) { assert.equal(selector, rowSelector); queries.push(selector); return rows; },
  };
  const nav = { getBoundingClientRect: () => ({ top: navTop, bottom: navTop + navHeight, height: navHeight }) };
  const context = {
    phase: 'workspace', activeView: 'chat', roomOpen: true, connected: true,
    historyNavigation: false, readBusy: false, roomId: 'synthetic-room', centerId: 'synthetic-center',
    generation: 7, readThrough: 0, care: { dialog: null }, viewer: { dialog: null }, lifetime: { signal },
    document: { visibilityState: 'visible', querySelector(selector) {
      assert.equal(selector, '#self-profile-dialog'); return null;
    } }, navigator: { onLine: true }, window: { visualViewport: viewport, innerHeight },
    app: { querySelector(selector) {
      if (selector === '[data-testid="message-list"]') return list;
      if (selector === '.main-nav') return position === null ? null : nav;
      assert.fail(`Unexpected read selector: ${selector}`);
    } },
    getComputedStyle(node) { assert.equal(node, nav); return { position }; }, visibleMessageRows,
    live: token => token === context.generation,
    api: { async markRead(center, room, id, requestSignal) {
      assert.equal(requestSignal, signal); calls.push([center, room, id]);
      return { lastRead: Number(rows.find(row => row.dataset.messageId === id).dataset.sequence) };
    } },
    denied: error => assert.fail(`Unexpected access denial: ${error.code}`),
    ...changes,
  };
  return { context, calls, queries, rows, list };
}

test('sticky menu coverage excludes fully hidden rows and reads only the last intersecting message row', async () => {
  const covered = readFixture({ bounds: [[10, 64]] });
  await runApp('tryRead', covered.context);
  assert.deepEqual(covered.calls, []); assert.equal(covered.context.readThrough, 0);
  const f = readFixture({ viewport: { offsetTop: 0, height: 200 }, bounds: [[10, 64], [60, 65], [200, 240]] });
  await runApp('tryRead', f.context);
  assert.deepEqual(f.calls, [['synthetic-center', 'synthetic-room', 'synthetic-2']]);
  assert.equal(f.context.readThrough, 2); assert.equal(f.context.readBusy, false);
  assert.deepEqual(f.queries, [rowSelector]);
  await runApp('tryRead', f.context);
  assert.equal(f.calls.length, 1, 'Polling must not mark an already acknowledged row again.');
});

test('sticky read clipping respects a panned visual viewport and menus outside its visible bounds', async () => {
  const panned = readFixture({ viewport: { offsetTop: 200, height: 200 },
    bounds: [[180, 200], [200, 220], [400, 420]] });
  await runApp('tryRead', panned.context);
  assert.deepEqual(panned.calls, [['synthetic-center', 'synthetic-room', 'synthetic-2']]);
  const overlap = readFixture({ viewport: { offsetTop: 30, height: 200 }, bounds: [[40, 64]] });
  await runApp('tryRead', overlap.context); assert.deepEqual(overlap.calls, []);
  for (const navTop of [-80, 200, 240]) {
    const outside = readFixture({ navTop, viewport: { offsetTop: 0, height: 200 } });
    await runApp('tryRead', outside.context);
    assert.deepEqual(outside.calls, [['synthetic-center', 'synthetic-room', 'synthetic-1']],
      `A sticky menu outside the viewport (top=${navTop}) must not hide visible rows.`);
  }
});

test('mobile bottom navigation, viewport fallback and offscreen message panes retain their read boundaries', async () => {
  const mobile = readFixture({ position: 'fixed', navTop: 650, bounds: [[640, 650], [650, 680]] });
  await runApp('tryRead', mobile.context);
  assert.deepEqual(mobile.calls, [['synthetic-center', 'synthetic-room', 'synthetic-1']]);
  for (const position of ['static', null]) {
    const fallback = readFixture({ position, viewport: null, innerHeight: 240, bounds: [[230, 240], [240, 260]] });
    await runApp('tryRead', fallback.context);
    assert.deepEqual(fallback.calls, [['synthetic-center', 'synthetic-room', 'synthetic-1']]);
  }
  for (const listTop of [-300, 768]) {
    const outside = readFixture({ listTop, listHeight: 200 });
    await runApp('tryRead', outside.context); assert.deepEqual(outside.calls, []);
  }
});

test('read clipping cannot bypass inactive scope, hidden page, open dialog or disconnected guards', async () => {
  for (const changes of [{ phase: 'login' }, { activeView: 'home' }, { roomOpen: false }, { connected: false },
    { historyNavigation: true }, { readBusy: true }, { roomId: null }, { care: { dialog: { open: true } } },
    { viewer: { dialog: { open: true } } }, { navigator: { onLine: false } },
    { document: { visibilityState: 'hidden', querySelector: () => null } },
    { document: { visibilityState: 'visible', querySelector: () => ({ open: true }) } }]) {
    const f = readFixture({ changes });
    f.context.app.querySelector = () => assert.fail('Inactive read scopes must not inspect message geometry.');
    await runApp('tryRead', f.context); assert.deepEqual(f.calls, []); assert.deepEqual(f.queries, []);
  }
});

function roomFixture({ open = true, fresh = false } = {}) {
  const counts = { mount: 0, summary: 0, people: 0, messages: 0, observed: 0, disconnect: 0, composer: 0, remembered: 0 };
  const containerListeners = [];
  let disclosureOpen = open;
  const disclosure = { get open() { return disclosureOpen; }, set open(value) { disclosureOpen = value; } };
  const summary = { textContent: '참여자 2명', matches: () => false };
  let summaryText = summary.textContent;
  Object.defineProperty(summary, 'textContent', { get: () => summaryText, set(value) { summaryText = value; counts.summary++; } });
  let peopleHtml = '';
  const people = { contains: () => false, get innerHTML() { return peopleHtml; }, set innerHTML(value) { peopleHtml = value; counts.people++; } };
  let messagesHtml = '';
  const list = { addEventListener() {}, contains: () => false,
    querySelectorAll: () => [], get innerHTML() { return messagesHtml; },
    set innerHTML(value) { assert.equal(typeof value, 'string'); messagesHtml = value; counts.messages++; },
    matches: selector => selector === '.message-list' };
  const title = { textContent: '' }, passive = { addEventListener() {}, matches: () => false };
  const document = { activeElement: summary };
  const primary = { innerHTML: '', firstChild: null, ownerDocument: document, contains: () => false };
  let mounted = !fresh, mountHtml = '';
  const container = { children: [passive, list, passive],
    addEventListener(type, handler, options) { containerListeners.push({ type, handler, options }); },
    querySelector(selector) {
      if (selector === '[data-testid="message-list"]') return mounted ? list : null;
      return new Map([['#room-title', title], ['.room-participants', disclosure], ['.room-participants > summary', summary],
        ['#participants', people], ['[data-primary-communicator]', primary], ['form', passive], ['textarea', passive]]).get(selector) ?? null;
    },
    set innerHTML(value) { assert.equal(mounted, false, 'A normal refresh must not replace the room/disclosure.'); mounted = true; mountHtml = value; counts.mount++; },
  };
  const context = { roomId: 'synthetic-room', profile: { name: '가상 아동', participants: [
    { displayName: '가상 치료사', role: 'therapist' }, { displayName: '가상 보호자', role: 'guardian' },
  ] }, messages: [], renderKey: '',
    app: { querySelector: selector => { assert.equal(selector, '[data-testid="room"]'); return container; } },
    document, painted: new WeakMap(), careHost: null,
    chatLayout: { disconnect() { counts.disconnect++; }, observe() { counts.observed++; } },
    roomParticipantsMarkup, reconcilePrimaryCommunicator,
    recipientRole: () => false, rememberReadingPosition() { counts.remembered++; },
    // History navigation is verified separately; this fixture isolates room
    // disclosure, message painting and viewport behavior.
    renderHistoryControls() {}, updateComposer() { counts.composer++; }, tryRead() {}, requestAnimationFrame() {},
    preserveChatDisclosurePosition() {},
  };
  return { context, counts, containerListeners, disclosure, summary, people, primary, title, container, list, get mountHtml() { return mountHtml; } };
}

test('Seoul calendar chat timestamps agree with the home preview without changing the stored instant', () => {
  const f = roomFixture();
  const message = { id: 'synthetic-clock-message', authorId: 'synthetic-guardian', sequence: 1,
    type: 'text', body: '가상 시각 확인', createdAt: '2026-12-31T15:00:00.000Z', attachmentCount: 0 };
  Object.assign(f.context, { messages: [message], user: { userId: 'synthetic-therapist' }, targetId: null,
    escape: workspaceUi.escapeHtml, roleName: workspaceUi.roleName, renderCareMessage,
    formatWorkspaceTime: workspaceUi.formatWorkspaceTime, deliveryEnabled: false,
    getContext: () => ({ role: 'therapist' }) });
  const before = structuredClone(message);
  runApp('renderRoom', f.context, ['paint']);
  assert.match(f.list.innerHTML, /<time datetime="2026-12-31T15:00:00.000Z">1\. 1\. 오전 12:00<\/time>/);
  const news = workspaceUi.newsMarkup([{ conversationId: 'synthetic-room', unread: 1,
    profile: f.context.profile, latest: message }], null, true);
  assert(news.includes('1. 1. 오전 12:00'));
  assert.deepEqual(message, before);
});

test('ordinary room refresh preserves the participant disclosure, focused summary and unchanged list DOM', () => {
  for (const open of [false, true]) {
    const f = roomFixture({ open });
    runApp('renderRoom', f.context, ['paint']);
    const before = { ...f.counts };
    runApp('renderRoom', f.context, ['paint']);
    assert.equal(f.counts.mount, 0); assert.equal(f.counts.summary, 0);
    assert.equal(f.counts.people, before.people); assert.equal(f.counts.messages, before.messages);
    assert.equal(f.disclosure.open, open); assert.equal(f.context.document.activeElement, f.summary);
    f.context.profile.participants[0].displayName = '<갱신한 가상 치료사>';
    runApp('renderRoom', f.context, ['paint']);
    assert(f.people.innerHTML.includes('&lt;갱신한 가상 치료사&gt;'));
    assert.equal(f.counts.people, before.people + 1); assert.equal(f.counts.summary, 0);
    f.context.profile.participants.pop(); runApp('renderRoom', f.context, ['paint']);
    assert.equal(f.summary.textContent, '참여자 1명'); assert(!f.people.innerHTML.includes('가상 보호자'));
    assert.equal(f.disclosure.open, open); assert.equal(f.context.document.activeElement, f.summary);
  }
});

test('a newly mounted room uses a native initially closed participant disclosure and observes its header', () => {
  const f = roomFixture({ fresh: true, open: false }); runApp('renderRoom', f.context, ['paint']);
  const tag = f.mountHtml.match(/<details\b[^>]*class="room-participants"[^>]*>/)?.[0];
  assert(tag); assert.doesNotMatch(tag, /\bopen(?:\s|=|>)/);
  assert.match(f.mountHtml, /<summary><\/summary><ul id="participants">/);
  assert.match(f.mountHtml, /id="room-title" tabindex="-1"/);
  assert.equal(f.counts.mount, 1); assert.equal(f.counts.disconnect, 1); assert.equal(f.counts.observed, 2);
  assert.deepEqual(f.containerListeners, [{ type: 'click', handler: f.context.preserveChatDisclosurePosition, options: true }]);
  runApp('renderRoom', f.context, ['paint']);
  assert.equal(f.containerListeners.length, 1, 'Polling must not add another capture listener.');
});

test('removing a focused primary disclosure returns focus only to the current room heading without scrolling', () => {
  const f = roomFixture(), removedSummary = { matches: () => false }, calls = [];
  f.primary.firstChild = {}; f.primary.contains = node => node === removedSummary;
  f.primary.replaceChildren = () => { f.primary.firstChild = null; f.context.document.activeElement = null; calls.push('clear'); };
  f.title.focus = options => { f.context.document.activeElement = f.title; calls.push(['focus', options.preventScroll]); };
  f.context.document.activeElement = removedSummary;
  runApp('renderRoom', f.context, ['paint']);
  assert.deepEqual(calls, ['clear', ['focus', true]]);
  assert.equal(f.primary.firstChild, null); assert.equal(f.context.document.activeElement, f.title);
  assert.equal(f.counts.mount, 0);
});
