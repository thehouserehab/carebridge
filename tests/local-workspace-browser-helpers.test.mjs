import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceRoom, workspaceView } from './local-workspace-browser-helpers.mjs';

// Pure locator doubles only: no browser, HTTP, PGlite, files, credentials or
// application-state injection. Each pass represents a newly observed DOM.
function harness({ frames = [{}], mobile = false, faults = {}, navigationCount = 1 } = {}) {
  const states = frames.map((frame) => ({ entry: true, composer: false, selected: false, back: false, loading: false, ...frame }));
  let pass = -1, navigationActive = true;
  const calls = [];
  const current = () => states[Math.max(0, Math.min(pass, states.length - 1))];
  const record = (name, options) => {
    calls.push({ name, options });
    const error = faults[name]?.shift();
    if (error) throw error;
  };
  const select = () => {
    current().selected = true; current().composer = true;
    if (mobile) { current().entry = false; current().back = true; }
  };
  const entry = {
    async isVisible() { record('entry.visible'); return current().entry; },
    async getAttribute(name, options) {
      assert.equal(name, 'aria-current'); record('entry.attribute', options);
      return current().selected ? 'true' : null;
    },
    async click(options) { record('entry.click', options); assert.equal(current().entry, true); select(); },
    async focus(options) { record('entry.focus', options); assert.equal(current().entry, true); },
    async press(key, options) { assert.equal(key, 'Enter'); record('entry.press', options); assert.equal(current().entry, true); select(); },
  };
  const navigation = {
    first() { return this; },
    async waitFor(options) { record('nav.wait', options); },
    async count() { record('nav.count'); return navigationCount; },
    async getAttribute(name, options) { assert.equal(name, 'aria-current'); record('nav.attribute', options); return navigationActive ? 'page' : null; },
    async click(options) { record('nav.click', options); navigationActive = true; },
  };
  const back = {
    async isVisible() { record('back.visible'); return current().back; },
    async click(options) {
      record('back.click', options); assert.equal(current().back, true, 'Must never click a hidden desktop back control.');
      current().back = false; current().entry = true; current().composer = false;
    },
  };
  const page = {
    locator(selector) {
      if (selector === 'button[data-view="chat"]:visible') return navigation;
      if (selector === '[data-action="room-list"]:visible') return back;
      if (selector === '.workspace-grid.room-open [data-testid="room"] .loading-surface[aria-busy="true"]:visible')
        return { isVisible: async () => { record('room.loading'); return current().loading; } };
      assert.fail('Unexpected selector.');
    },
    getByTestId(name) {
      assert.equal(name, 'inbox');
      return { locator: (selector) => { assert.equal(selector, '[data-room-id="synthetic-room"]'); return entry; } };
    },
    getByLabel(name, options) {
      assert.equal(name, '메시지'); assert.deepEqual(options, { exact: true });
      return { isVisible: async () => { record('composer.visible'); return current().composer; } };
    },
    async waitForFunction(predicate, view, options) {
      assert.equal(typeof predicate, 'function'); assert.equal(view, 'chat');
      record('nav.active', options); pass++;
    },
  };
  return { page, calls, state: current, deactivateNavigation() { navigationActive = false; } };
}
const named = (h, name) => h.calls.filter((call) => call.name === name);
function boundedActions(h) {
  for (const { options } of h.calls.filter((call) => call.options)) {
    assert(Number.isInteger(options.timeout) && options.timeout > 0 && options.timeout <= 3000);
    assert.equal(Object.hasOwn(options, 'force'), false);
  }
}

test('a temporarily detached desktop entry is re-evaluated without waiting for an invisible back button', async () => {
  const h = harness({ frames: [{ entry: false }, { entry: true }] });
  await workspaceRoom(h.page, 'synthetic-room');
  assert.equal(named(h, 'back.click').length, 0);
  assert.equal(named(h, 'entry.click').length, 1);
  assert.equal(h.state().selected, true); assert.equal(h.state().composer, true);
  assert(named(h, 'nav.active').length >= 3);
  boundedActions(h);
});

test('a mobile room uses an actually visible back control before selecting the requested entry', async () => {
  const h = harness({ frames: [{ entry: false, back: true }], mobile: true });
  await workspaceRoom(h.page, 'synthetic-room');
  assert.equal(named(h, 'back.click').length, 1);
  assert.equal(named(h, 'entry.click').length, 1);
  assert(h.calls.findIndex((c) => c.name === 'back.click') < h.calls.findIndex((c) => c.name === 'entry.click'));
  assert.equal(h.state().selected, true); assert.equal(h.state().composer, true);
  boundedActions(h);
});

test('an already selected room with a visible composer returns without clicking hidden mobile navigation', async () => {
  const h = harness({ frames: [{ entry: false, composer: true, selected: true, back: true }], mobile: true });
  await workspaceRoom(h.page, 'synthetic-room');
  assert.equal(named(h, 'entry.click').length, 0); assert.equal(named(h, 'back.click').length, 0);
  assert.equal(named(h, 'nav.active').length, 1);
  boundedActions(h);
});

test('a visible composer for a different selection is not accepted as success', async () => {
  const h = harness({ frames: [{ composer: true, selected: false }] });
  await workspaceRoom(h.page, 'synthetic-room');
  assert.equal(named(h, 'entry.click').length, 1);
  assert.equal(h.state().selected, true);
  boundedActions(h);
});

test('a selected loading room is observed without repeated clicks that cancel its request', async () => {
  const h = harness({ frames: [{}, { selected: true, loading: true }, { selected: true, loading: true },
    { selected: true, composer: true }] });
  await workspaceRoom(h.page, 'synthetic-room');
  assert.equal(named(h, 'entry.click').length, 1);
  assert.equal(named(h, 'back.click').length, 0);
  assert.equal(named(h, 'nav.active').length, 4);
  assert.equal(h.state().composer, true);
  boundedActions(h);
});

test('loading another room does not prevent selecting the requested room', async () => {
  const h = harness({ frames: [{ selected: false, loading: true }] });
  await workspaceRoom(h.page, 'synthetic-room');
  assert.equal(named(h, 'entry.click').length, 1);
  assert.equal(h.state().selected, true); assert.equal(h.state().composer, true);
  boundedActions(h);
});

test('a selected room list without an active loading surface can still be opened', async () => {
  const h = harness({ frames: [{ selected: true, composer: false, loading: false }] });
  await workspaceRoom(h.page, 'synthetic-room');
  assert.equal(named(h, 'entry.click').length, 1);
  assert.equal(h.state().composer, true);
  boundedActions(h);
});

test('keyboard navigation focuses the visible entry and presses Enter without forced actions', async () => {
  const h = harness();
  await workspaceRoom(h.page, 'synthetic-room', { keyboard: true });
  assert.equal(named(h, 'entry.click').length, 0);
  assert.equal(named(h, 'entry.focus').length, 1); assert.equal(named(h, 'entry.press').length, 1);
  assert.equal(h.state().selected, true); assert.equal(h.state().composer, true);
  boundedActions(h);
});

test('a short action timeout re-observes the DOM instead of treating it as room success', async () => {
  const timeout = Object.assign(new Error('Synthetic transient action timeout.'), { name: 'TimeoutError' });
  const h = harness({ faults: { 'entry.click': [timeout] } });
  await workspaceRoom(h.page, 'synthetic-room');
  assert.equal(named(h, 'entry.click').length, 2);
  assert.equal(h.state().selected, true); assert.equal(h.state().composer, true);
  boundedActions(h);
});

test('transient detachment during a normal click is retried from fresh visible controls', async () => {
  const h = harness({ faults: { 'entry.click': [new Error('locator.click: Element is not attached to the DOM')] } });
  await workspaceRoom(h.page, 'synthetic-room');
  assert.equal(named(h, 'entry.click').length, 2); assert.equal(named(h, 'back.click').length, 0);
  assert.equal(h.state().selected, true); assert.equal(h.state().composer, true);
  boundedActions(h);
});

test('unrelated errors propagate unchanged rather than being retried or counted as a pass', async () => {
  const failure = new Error('Synthetic non-transient locator failure.');
  const h = harness({ faults: { 'entry.click': [failure] } });
  await assert.rejects(workspaceRoom(h.page, 'synthetic-room'), (error) => error === failure);
  assert.equal(named(h, 'entry.click').length, 1);
  assert.equal(h.state().selected, false); assert.equal(h.state().composer, false);
});

test('duplicate active navigation remains an assertion failure, not a transient retry', async () => {
  const h = harness({ navigationCount: 2 });
  await assert.rejects(workspaceRoom(h.page, 'synthetic-room'), /LOCAL_WORKSPACE_VISIBLE_NAV_UNIQUE/);
  assert.equal(named(h, 'entry.click').length, 0);
});

test('ordinary workspaceView retains its existing navigation behavior and default timeout', async () => {
  const h = harness(); h.deactivateNavigation();
  await workspaceView(h.page, 'chat');
  assert.equal(named(h, 'nav.click').length, 1);
  assert.equal(named(h, 'nav.active').length, 1);
  assert.equal(named(h, 'nav.wait')[0].options.timeout, undefined);
});
