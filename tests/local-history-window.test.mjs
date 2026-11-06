import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { historySelector, stableHistorySelector } from '../local-api/workspace-ui.js';

const window = { startCursor: 101, endCursor: 200, hasOlder: true, hasNewer: true };
test('history controls use exclusive edges and explicit recent mode, never message content', () => {
  assert.deepEqual(historySelector('older', window), { before: 101 });
  assert.deepEqual(historySelector('newer', window), { after: 200 });
  assert.deepEqual(historySelector('latest', window), {});
  assert.equal(historySelector('unknown', window), null);
  assert.equal(historySelector('older', null), null);
  assert.equal(historySelector('older', { ...window, hasOlder: false }), null);
  assert.equal(historySelector('newer', { ...window, endCursor: 0 }), null);
});
test('polling pins historical start, tracks recent end, and never repeats a page turn', () => {
  for (const requested of [{ before: 201 }, { after: 100 }, { from: 101 }, { around: 'synthetic-target' }])
    assert.deepEqual(stableHistorySelector(requested, window), { from: 101 });
  assert.deepEqual(stableHistorySelector({}, window), {});
  assert.deepEqual(stableHistorySelector({ after: 100 }, { ...window, hasNewer: false }), {});
  // Deletion/history-boundary changes can leave an empty page. The explicit
  // latest control can recover it; no former message content is retained.
  const selector = { after: 200 };
  assert.deepEqual(stableHistorySelector(selector, { ...window, startCursor: 0, endCursor: 0, hasNewer: false }), selector);
});

const app = await readFile(new URL('../local-api/app.js', import.meta.url), 'utf8');
const navigation = app.match(/^async function navigateHistory\([^\n]*\) \{[\s\S]*?^\}/m)?.[0];
assert(navigation);
function navigationFixture() {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const calls = [], draft = { sending: false };
  const context = { connected: true, roomId: 'synthetic-room', activeView: 'chat', roomOpen: true,
    historyNavigation: null, historyNotice: '', navigationIntent: 0, timelineWindow: window, refreshing: true,
    document: { visibilityState: 'visible' }, navigator: { onLine: true },
    drafts: { get: () => draft }, draftKey: () => 'synthetic-scope', historySelector,
    historySelectors: new Map(), rememberReadingPosition() { calls.push('bookmark'); },
    care: { suspend() { calls.push('care-suspend'); } }, viewer: { suspend() { calls.push('media-suspend'); } },
    refreshController: { abort() { calls.push('abort-old-read'); } },
    updateComposer() { calls.push(context.historyNavigation ? 'navigation-locked' : 'navigation-unlocked'); },
    announce() {}, refresh: () => pending, focusPage() { calls.push('focus'); }, requestAnimationFrame() {}, tryRead() {},
  };
  const run = (direction, target = null) => runInNewContext(`${navigation}\nnavigateHistory(${JSON.stringify(direction)},${JSON.stringify(target)});`, context);
  return { context, calls, draft, finish, run };
}
test('real navigation locks only the page turn, cancels stale reads and unlocks after coherent refresh', async () => {
  const f = navigationFixture(), run = f.run('older');
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.historySelectors.get('synthetic-scope'))), { before: 101 });
  assert.deepEqual(f.calls, ['bookmark', 'care-suspend', 'media-suspend', 'abort-old-read', 'navigation-locked']);
  assert.equal(await f.run('newer'), false); // No overlapping page request.
  f.finish(true); assert.equal(await run, true);
  assert.equal(f.context.historyNavigation, null); assert(f.calls.includes('navigation-unlocked')); assert(f.calls.includes('focus'));
});
test('late navigation does not reopen chat or steal focus after the user changes view', async () => {
  const f = navigationFixture(), run = f.run('older');
  f.context.activeView = 'home'; f.context.navigationIntent++;
  f.finish(true); assert.equal(await run, false); assert.equal(f.context.historyNavigation, null);
  assert(!f.calls.includes('focus')); assert(f.calls.includes('navigation-unlocked'));
});
test('navigation does not run during an in-flight send or offline, and failed refresh unlocks controls', async () => {
  for (const reason of ['sending', 'offline']) {
    const f = navigationFixture();
    if (reason === 'sending') f.draft.sending = true; else f.context.navigator.onLine = false;
    assert.equal(await f.run('older'), false); assert.deepEqual(f.calls, []); assert.equal(f.context.historySelectors.size, 0);
  }
  const f = navigationFixture(), run = f.run('older');
  f.context.connected = false; f.finish(undefined);
  assert.equal(await run, false); assert.equal(f.context.historyNavigation, null); assert(!f.calls.includes('focus'));
});

test('an explicit activity target supersedes a pending page turn even during an in-flight send', async () => {
  const f = navigationFixture(), older = f.run('older'), previous = f.context.historyNavigation;
  f.context.refreshController = { abort() { f.calls.push('abort-replaced-page'); } };
  f.draft.sending = true;
  const target = f.run('target', 'synthetic-old-activity');
  assert.notEqual(f.context.historyNavigation, previous);
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.historySelectors.get('synthetic-scope'))), { around: 'synthetic-old-activity' });
  assert(f.calls.includes('abort-replaced-page'));
  f.finish(true); assert.equal(await older, false); assert.equal(await target, true);
  assert.equal(f.context.historyNavigation, null);
});

test('opening chat media pins only the current bounded cursor and cancels a pre-opening latest poll', () => {
  const source = app.match(/^function pinHistoryForMedia\([^\n]*\) \{[\s\S]*?^\}/m)?.[0]; assert(source);
  const f = navigationFixture();
  const run = () => runInNewContext(`${source}\npinHistoryForMedia();`, f.context);
  assert.equal(run(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.historySelectors.get('synthetic-scope'))), { from: 101 });
  assert(f.calls.includes('abort-old-read')); assert.equal(f.context.refreshing, false);
  assert.equal(f.context.navigationIntent, 1);
  f.context.historyNavigation = {}; assert.equal(run(), false);
  f.context.historyNavigation = null; f.context.connected = false; assert.equal(run(), false);
  assert.equal(f.context.navigationIntent, 1);
});

test('a send completing after an attachment opens preserves its bounded reading window', async () => {
  const send = app.match(/^async function send\([^\n]*\) \{[\s\S]*?^\}/m)?.[0];
  const pin = app.match(/^function pinHistoryForMedia\([^\n]*\) \{[\s\S]*?^\}/m)?.[0];
  assert(send && pin);
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const f = navigationFixture(), operation = { body: '합성 시험', attachments: [] };
  Object.assign(f.context, {
    phase: 'workspace', generation: 1, centerId: 'synthetic-center', user: { userId: 'synthetic-user' },
    lifetime: { signal: new AbortController().signal }, live: () => true,
    mediaAllowed: () => false, media: { update() {}, forgetSent() {} }, getMediaContext: () => ({}),
    api: { send: () => pending }, readingPositions: new Map([['synthetic-scope', { top: 20 }]]),
    renderKey: 'current-page',
    refresh() { f.calls.push('refresh-pinned-page'); },
  });
  Object.assign(f.context.drafts, {
    begin: () => operation, accepted: () => f.calls.push('accepted'),
    failed: () => assert.fail('send must succeed'), rejected: () => assert.fail('send must succeed'),
  });
  const sending = runInNewContext(`${send}\nsend();`, f.context);
  assert.equal(runInNewContext(`${pin}\npinHistoryForMedia();`, f.context), true);
  finish(); await sending;
  assert(f.calls.includes('accepted')); assert(f.calls.includes('refresh-pinned-page'));
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.historySelectors.get('synthetic-scope'))), { from: 101 });
  assert.equal(f.context.renderKey, 'current-page');
  assert(f.context.readingPositions.has('synthetic-scope'));
});
