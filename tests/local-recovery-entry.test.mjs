import test from 'node:test';
import assert from 'node:assert/strict';
import { startRecoveryPage } from '../local-api/recovery-entry.js';

// Browser lifecycle ports only. No page, storage, network or real credentials.
function fixture(mode = 'complete') {
  const window = new EventTarget(), document = new EventTarget(), calls = [], instances = [], gate = Promise.withResolvers();
  const host = { innerHTML: 'initial' }, navigator = { onLine: true };
  document.visibilityState = 'visible'; document.querySelector = () => host;
  const location = { pathname: mode === 'request' ? '/account/password-recovery/request' : '/account/password-recovery',
    search: '', hash: mode === 'request' ? '' : '#token=cr1.' + 's'.repeat(43), replace: path => calls.push(['replace', path]) };
  const history = { replaceState: (_state, _title, path) => { calls.push(['scrub', path]); location.hash = ''; location.search = ''; } };
  class RecoveryUi {
    constructor(options) { this.options = options; instances.push(this); }
    mount(token) { calls.push(['mount', token]); }
    resume() { calls.push(['resume']); }
    suspend() { calls.push(['suspend']); }
    destroy() { calls.push(['destroy']); }
  }
  return { host, calls, instances, window, document, location, navigator,
    begin: () => startRecoveryPage({ window, document, location, history, navigator, load: () => { calls.push(['load']); return gate.promise; } }),
    ready: () => gate.resolve([{ RecoveryUi }, { LocalApiClient: class {} }]), fail: () => gate.reject(new Error('private capability')),
    visibility(value) { document.visibilityState = value; document.dispatchEvent(new Event('visibilitychange')); },
    online(value) { navigator.onLine = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); },
    cached() { const event = new Event('pageshow'); event.persisted = true; window.dispatchEvent(event); },
  };
}

test('complete scrubs before dynamic import, passes only memory token, and mounts once', async () => {
  const f = fixture(), work = f.begin(); assert.deepEqual(f.calls.map(c => c[0]), ['scrub', 'load']); assert.equal(f.location.hash, '');
  f.ready(); await work; assert.equal(f.instances[0].options.mode, 'complete');
  assert.deepEqual(f.calls.find(c => c[0] === 'mount'), ['mount', 'cr1.' + 's'.repeat(43)]);
  f.visibility('visible'); f.online(true); assert.equal(f.calls.filter(c => c[0] === 'mount').length, 1);
  f.window.dispatchEvent(new Event('pagehide'));
});
test('request route mounts without a token and never requires a fragment', async () => {
  const f = fixture('request'), work = f.begin(); f.ready(); await work;
  assert.equal(f.instances[0].options.mode, 'request'); assert.deepEqual(f.calls.find(c => c[0] === 'mount'), ['mount', null]);
  f.window.dispatchEvent(new Event('pagehide'));
});
test('malformed complete and request query/hash scrub without loading any account module', async () => {
  for (const [mode, change] of [['complete', { hash: '' }], ['complete', { hash: '#token=cr1.' + 's'.repeat(43) + '\n' }], ['request', { search: '?email=private' }], ['request', { hash: '#token=private' }]]) {
    const f = fixture(mode); Object.assign(f.location, change); await f.begin(); assert.deepEqual(f.calls.map(c => c[0]), ['scrub']);
    assert.equal(f.location.hash, ''); assert.equal(f.location.search, ''); assert.match(f.host.innerHTML, /재설정 링크를 사용할 수 없어요/); assert(!f.host.innerHTML.includes('private'));
  }
});
test('hidden during import defers first mount even if online event fires', async () => {
  const f = fixture(), work = f.begin(); f.visibility('hidden'); f.ready(); await work; f.online(true);
  assert.equal(f.calls.some(c => c[0] === 'mount'), false); f.visibility('visible'); assert.equal(f.calls.filter(c => c[0] === 'mount').length, 1);
  f.window.dispatchEvent(new Event('pagehide'));
});
test('offline during import defers mount until online and visible together', async () => {
  const f = fixture(), work = f.begin(); f.online(false); f.ready(); await work; f.visibility('visible'); assert.equal(f.calls.some(c => c[0] === 'mount'), false);
  f.online(true); assert.equal(f.calls.filter(c => c[0] === 'mount').length, 1); f.online(false); assert.equal(f.calls.at(-1)[0], 'suspend');
  f.visibility('visible'); assert.equal(f.calls.at(-1)[0], 'suspend'); f.window.dispatchEvent(new Event('pagehide'));
});
test('pagehide during load prevents construction and all resume events', async () => {
  const f = fixture(), work = f.begin(); f.window.dispatchEvent(new Event('pagehide')); f.ready(); await work;
  f.visibility('visible'); f.online(true); assert.equal(f.instances.length, 0); assert.equal(f.host.innerHTML, 'initial');
});
test('pagehide after mount destroys and unregisters transient events; bfcache returns to normal root', async () => {
  const f = fixture(), work = f.begin(); f.ready(); await work; f.window.dispatchEvent(new Event('pagehide')); const count = f.calls.length;
  f.visibility('visible'); f.online(true); f.online(false); assert.equal(f.calls.length, count);
  f.cached(); assert.deepEqual(f.calls.at(-1), ['replace', '/']);
});
test('late import failure after exit never repaints the departed page', async () => {
  const f = fixture(), work = f.begin(); f.window.dispatchEvent(new Event('pagehide')); f.fail(); await work; assert.equal(f.host.innerHTML, 'initial');
});
test('load failure offers only fixed links and disables further automatic work', async () => {
  const f = fixture(), work = f.begin(); f.fail(); await work; assert.match(f.host.innerHTML, /복구 화면을 불러오지 못했어요/); assert(!f.host.innerHTML.includes('private'));
  const count = f.calls.length; f.visibility('visible'); f.online(true); assert.equal(f.calls.length, count);
});
test('only explicit exit navigates root; controller receives no authentication callback', async () => {
  const f = fixture(), work = f.begin(); f.ready(); await work;
  assert.equal(f.instances[0].options.onAuthenticated, undefined); assert.equal(f.calls.some(c => c[0] === 'replace'), false);
  f.instances[0].options.onExit(); assert.deepEqual(f.calls.at(-1), ['replace', '/']); assert(f.calls.some(c => c[0] === 'destroy'));
});
