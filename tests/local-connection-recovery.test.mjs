// Pure markup and the actual app denial/suspension branches, with memory-only
// collaborators. These checks do not prove browser layout, automatic retries,
// DOM erasure by resetProjections, or recovery completion after a full refresh.
// Successful refresh resets projectionRecovery in the separate browser test;
// do not substitute a source-text assertion for that asynchronous behavior.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { loadingMarkup } from '../local-api/workspace-ui.js';

const surfaces = ['home', 'inbox', 'room', 'records-content', 'child-content'];
const appSource = await readFile(new URL('../local-api/app.js', import.meta.url), 'utf8');
function functionSource(name) {
  const source = appSource.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0];
  assert(source, `The app must still define ${name}.`);
  return source;
}
const functions = ['denied', 'suspend'].map(functionSource).join('\n');

test('initial checking keeps the nonclinical loading skeleton without promising retained input', () => {
  for (const surface of surfaces) {
    const html = loadingMarkup(surface, 'checking');
    assert.match(html, new RegExp(`class="loading-surface loading-${surface}"`));
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /연결을 확인하고 있어요/);
    assert.doesNotMatch(html, /data-connection-state|data-input-retention-notice|data-action="reconnect"/);
    assert.equal((html.match(/class="loading-row"/g) ?? []).length, surface === 'room' ? 4 : 3);
  }
});

for (const [state, heading, busy] of [
  ['unavailable', '연결을 다시 확인해야 해요', false],
  ['offline', '네트워크 연결을 기다리고 있어요', false],
  ['rechecking', '열람 권한을 다시 확인하고 있어요', true],
]) {
  test(`${state} renders fixed recovery wording and a truthful retry state on every surface`, () => {
    for (const surface of surfaces) {
      const html = loadingMarkup(surface, state);
      assert.match(html, new RegExp(`data-connection-state="${state}"`));
      assert.match(html, new RegExp(`aria-busy="${busy}"`));
      assert(html.includes(`<h2>${heading}</h2>`));
      const retry = html.match(/<button\b[^>]*data-action="reconnect"[^>]*>/)?.[0];
      assert(retry, 'Every recovery surface must offer the reconnect control.');
      assert.equal(/\bdisabled(?:\s|>|=)/.test(retry), state === 'offline');
      assert.doesNotMatch(html, /자동 저장|모든 초안|저장되지 않았|localStorage|indexedDB|<script|<iframe/);
      if (surface === 'inbox') {
        assert.match(html, /connection-recovery-compact/);
        assert.doesNotMatch(html, /data-input-retention-notice/);
      } else {
        assert.match(html, /data-input-retention-notice/);
        assert.match(html, /이 창에 남아 있는 입력은 연결·권한 확인 후 이어 쓸 수 있어요/);
        assert.match(html, /페이지를 새로고침하거나 창을 닫으면 사라질 수 있어요/);
        assert.match(html, /확인이 끝날 때까지 대화와 정보를 잠시 표시하지 않습니다/);
        assert(html.includes(state === 'offline' ? '네트워크 연결 후 자동으로 다시 확인합니다.' : '자동으로도 다시 확인하고 있어요.'));
      }
    }
  });
}

test('unknown recovery and surface values fall back without interpolating caller data', () => {
  const hostile = '"><script>synthetic-sensitive-marker</script><img src=x onerror=alert(1)>';
  for (const recovery of [undefined, null, 'unexpected', hostile, {}, ['offline']]) {
    assert.equal(loadingMarkup('home', recovery), loadingMarkup('home', 'checking'));
  }
  for (const surface of [null, 'unexpected', hostile, {}, ['inbox']]) {
    assert.equal(loadingMarkup(surface, 'unavailable'), loadingMarkup('home', 'unavailable'));
  }
  assert.doesNotMatch(loadingMarkup(hostile, hostile), /synthetic-sensitive-marker|<script|<img|onerror/);
});

function controller({ online = true, phase = 'workspace', operation = null } = {}) {
  const calls = [], draft = { body: 'synthetic unsent input', operation };
  const store = { care: ['synthetic care input'], media: ['synthetic selected file'], drafts: [draft] };
  const context = {
    navigator: { onLine: online }, document: { visibilityState: online ? 'hidden' : 'visible' },
    phase, roomId: 'synthetic-room', targetId: 'synthetic-message', readThrough: 8, roomOpen: true,
    selfProfileOpening: {},
    selfProfile: { suspend() { calls.push('self-profile-suspend'); } },
    emailLoginUi: { suspend() { calls.push('email-login-suspend'); } },
    approvalPending: { suspend() { calls.push('approval-pending-suspend'); } },
    operations: { suspend() { calls.push('operations-suspend'); } },
    care: { clear() { calls.push('care-clear'); store.care.length = 0; } },
    media: { clear() { calls.push('media-clear'); store.media.length = 0; } },
    drafts: {
      clear() { calls.push('drafts-clear'); store.drafts.length = 0; },
      get(key) { assert.equal(key, 'synthetic-scope'); return draft; },
      failed(key, pending) {
        assert.equal(key, 'synthetic-scope'); assert.equal(pending, operation);
        calls.push('draft-outcome-unknown');
      },
    },
    draftKey: () => 'synthetic-scope',
    readingPositions: { clear() { calls.push('positions-clear'); } },
    historySelectors: new Map(),
    invalidate() { calls.push('invalidate'); },
    resetProjections(options) { calls.push(`reset:${options.recovery}`); },
    applyView() { calls.push('apply-view'); },
    announce(message) { calls.push('announce'); context.announcement = message; },
    errorMessage: () => 'synthetic public error',
    showLogin(message) { calls.push('login'); context.loginMessage = message; },
  };
  const run = expression => runInNewContext(`'use strict';\n{\n${functions}\n${expression}\n}`, context, { timeout: 1000 });
  return { context, calls, store, draft, run };
}

for (const online of [true, false]) {
  test(`transient denial while ${online ? 'online' : 'offline'} preserves scoped memory and hides projections through the reset boundary`, () => {
    const f = controller({ online });
    f.run("denied({ code: 'UNAVAILABLE' });");
    assert.deepEqual(f.calls, [`reset:${online ? 'unavailable' : 'offline'}`, 'apply-view', 'announce']);
    assert.equal(f.store.drafts[0], f.draft);
    assert.equal(f.store.care.length, 1); assert.equal(f.store.media.length, 1);
    assert.equal(f.context.roomId, 'synthetic-room'); assert.equal(f.context.targetId, 'synthetic-message');
    assert.equal(f.context.readThrough, 8); assert.equal(f.context.roomOpen, true);
  });
}

for (const code of ['FORBIDDEN', 'NOT_FOUND']) {
  for (const online of [true, false]) {
    test(`${code} while ${online ? 'online' : 'offline'} clears denied input before returning to neutral checking`, () => {
      const f = controller({ online }); f.context.error = { code };
      f.run('denied(error);');
      assert.deepEqual(f.calls, ['self-profile-suspend', 'care-clear', 'media-clear', 'invalidate', 'drafts-clear',
        'positions-clear', 'reset:checking', 'apply-view', 'announce']);
      assert.equal(f.store.care.length, 0); assert.equal(f.store.media.length, 0); assert.equal(f.store.drafts.length, 0);
      assert.equal(f.context.roomId, null); assert.equal(f.context.targetId, null);
      assert.equal(f.context.readThrough, 0); assert.equal(f.context.roomOpen, false);
    });
  }
}

test('authentication denial delegates directly to the login boundary without a retained-input recovery display', () => {
  const f = controller(); f.run("denied({ code: 'AUTH_REQUIRED' });");
  assert.deepEqual(f.calls, ['login']);
  assert.match(f.context.loginMessage, /다시 로그인/);
  // showLogin is a boundary stub here; complete account/session erasure is not
  // inferred from this branch-only test.
});

for (const online of [true, false]) {
  for (const pending of [false, true]) {
    test(`${online ? 'hidden-window' : 'offline'} suspension invalidates before reset and ${pending ? 'retains an unknown operation' : 'keeps unsent input'}`, () => {
      const operation = pending ? Object.freeze({ clientId: 'synthetic-request', body: 'synthetic pending input' }) : null;
      const f = controller({ online, operation }); f.run('suspend();');
      assert.deepEqual(f.calls, ['self-profile-suspend', ...(pending ? ['draft-outcome-unknown'] : []),
        'invalidate', `reset:${online ? 'rechecking' : 'offline'}`, 'announce']);
      assert.equal(f.context.selfProfileOpening, null);
      assert.equal(f.store.drafts[0], f.draft); assert.equal(f.draft.operation, operation);
      assert.equal(f.store.care.length, 1); assert.equal(f.store.media.length, 1);
      assert.match(f.context.announcement, /권한이 유지되는 경우에만 이어 쓸 수/);
    });
  }
}

test('non-workspace suspension delegates to its owner without a workspace recovery banner', () => {
  for (const [phase, event] of [['email-login', 'email-login-suspend'], ['approval-pending', 'approval-pending-suspend'],
    ['operations', 'operations-suspend'], ['login', null]]) {
    const f = controller({ phase }); f.run('suspend();');
    assert.deepEqual(f.calls, ['self-profile-suspend', ...(event ? [event] : [])]);
  }
});
