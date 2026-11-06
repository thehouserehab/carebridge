import test from 'node:test';
import assert from 'node:assert/strict';
import { startInvitationPage } from '../local-api/invitation-entry.js';

// Pure browser-port doubles: no DOM, network, account or database is created.
function fixture() {
  const window = new EventTarget(), document = new EventTarget(), calls = [], instances = [];
  const gate = Promise.withResolvers(), host = { innerHTML: 'initial' }, navigator = { onLine: true };
  document.visibilityState = 'visible'; document.querySelector = () => host;
  const location = { pathname: '/account/invitation', search: '', hash: '#token=' + 'a'.repeat(43), replace: value => calls.push(['replace', value]) };
  const history = { replaceState: (_state, _title, value) => { calls.push(['scrub', value]); location.hash = ''; } };
  class InvitationUi {
    constructor(options) { this.options = options; instances.push(this); }
    mount(token) { calls.push(['mount', token]); }
    resume() { calls.push(['resume']); }
    suspend() { calls.push(['suspend']); }
    destroy() { calls.push(['destroy']); }
  }
  const begin = () => startInvitationPage({ window, document, location, history, navigator,
    load: () => { calls.push(['load']); return gate.promise; } });
  return { begin, host, document, navigator, window, calls, location, instances,
    ready: () => gate.resolve([{ InvitationUi }, { LocalApiClient: class {} }]), fail: () => gate.reject(new Error('private')),
    visibility(value) { document.visibilityState = value; document.dispatchEvent(new Event('visibilitychange')); },
    online(value) { navigator.onLine = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); } };
}
test('entry scrubs before module load and mounts once only when visible and online', async () => {
  const f = fixture(), task = f.begin(); assert.deepEqual(f.calls.map(c => c[0]), ['scrub', 'load']);
  f.ready(); await task; assert.equal(f.calls.filter(c => c[0] === 'mount').length, 1);
  assert.equal(f.location.hash, ''); assert.equal(f.host.innerHTML, 'initial');
  f.visibility('visible'); assert.equal(f.calls.at(-1)[0], 'resume');
});
test('visibility lost during import defers first mount until a visible online event', async () => {
  const f = fixture(), task = f.begin(); f.visibility('hidden'); f.ready(); await task;
  assert.equal(f.calls.some(c => c[0] === 'mount'), false);
  f.online(true); assert.equal(f.calls.some(c => c[0] === 'mount'), false);
  f.visibility('visible'); assert.equal(f.calls.filter(c => c[0] === 'mount').length, 1);
});
test('offline during import cannot start requests when visibility alone resumes', async () => {
  const f = fixture(), task = f.begin(); f.online(false); f.ready(); await task;
  f.visibility('visible'); assert.equal(f.calls.some(c => c[0] === 'mount'), false);
  f.online(true); assert.equal(f.calls.filter(c => c[0] === 'mount').length, 1);
  f.online(false); assert.equal(f.calls.at(-1)[0], 'suspend');
  f.visibility('visible'); assert.equal(f.calls.at(-1)[0], 'suspend');
});
test('pagehide during import permanently fences construction and resumption', async () => {
  const f = fixture(), task = f.begin(); f.window.dispatchEvent(new Event('pagehide')); f.ready(); await task;
  f.visibility('visible'); f.online(true); assert.equal(f.instances.length, 0); assert.equal(f.host.innerHTML, 'initial');
});
test('pagehide after mount destroys and blocks all subsequent resume events', async () => {
  const f = fixture(), task = f.begin(); f.ready(); await task;
  f.window.dispatchEvent(new Event('pagehide')); const length = f.calls.length;
  f.visibility('visible'); f.online(true); assert.equal(f.calls.length, length); assert.equal(f.calls.at(-1)[0], 'destroy');
});
test('malformed fragment is scrubbed without loading modules or rendering capability', async () => {
  const f = fixture(); f.location.hash += '&unknown=1'; await f.begin();
  assert.deepEqual(f.calls.map(c => c[0]), ['scrub']); assert.equal(f.location.hash, '');
  assert.match(f.host.innerHTML, /초대 링크를 다시 확인/); assert(!f.host.innerHTML.includes('a'.repeat(43)));
});
test('late loader failure after exit cannot repaint an error in the old page', async () => {
  const f = fixture(), task = f.begin(); f.window.dispatchEvent(new Event('pagehide')); f.fail(); await task;
  assert.equal(f.host.innerHTML, 'initial');
});
test('success and explicit exit use the normal session bootstrap without query credentials', async () => {
  const f = fixture(), task = f.begin(); f.ready(); await task;
  f.instances[0].options.onAuthenticated({ userId: 'synthetic-user' }, 'synthetic-center');
  assert.deepEqual(f.calls.at(-1), ['replace', '/']);
  f.instances[0].options.onExit(); assert.deepEqual(f.calls.at(-1), ['replace', '/']);
});
