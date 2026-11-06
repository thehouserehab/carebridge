import { takeRecoveryLocation } from './recovery-token.js';

export async function startRecoveryPage({ window, document, location, history, navigator,
  load = () => Promise.all([import('./recovery-ui.js'), import('./client.js')]) }) {
  let captured = null, malformed = false;
  try { captured = takeRecoveryLocation(location, history); } catch { malformed = true; }
  const host = document.querySelector('#app');
  let controller = null, closed = false, started = false;
  const events = new AbortController();
  const stop = () => { closed = true; captured = null; controller?.destroy(); events.abort(); };
  const unavailable = () => {
    const show = !closed; stop();
    if (show) host.innerHTML = '<section class="login invitation-card"><h1>복구 화면을 불러오지 못했어요</h1><p>원래 안내 링크를 다시 열거나 새 안내를 요청해 주세요.</p><a href="/account/password-recovery/request">새 재설정 안내 요청</a><a href="/">로그인으로 이동</a></section>';
  };
  const resume = () => {
    if (closed || !controller || document.visibilityState !== 'visible' || !navigator.onLine) return;
    try {
      if (!started) {
        started = true; const token = captured.token; captured = null;
        void Promise.resolve(controller.mount(token)).catch(unavailable);
      } else void Promise.resolve(controller.resume()).catch(unavailable);
    } catch { unavailable(); }
  };
  // pageshow must survive pagehide so a cached page cannot revive a capability.
  window.addEventListener('pageshow', event => { if (event.persisted) { stop(); location.replace('/'); } });
  window.addEventListener('pagehide', stop, { signal: events.signal });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') controller?.suspend(); else resume();
  }, { signal: events.signal });
  window.addEventListener('offline', () => controller?.suspend(), { signal: events.signal });
  window.addEventListener('online', resume, { signal: events.signal });
  if (malformed) {
    stop();
    host.innerHTML = '<section class="login invitation-card"><h1>재설정 링크를 사용할 수 없어요</h1><p>원래 안내 링크를 다시 열거나 새 안내를 요청해 주세요.</p><a href="/account/password-recovery/request">새 재설정 안내 요청</a><a href="/">로그인으로 이동</a></section>';
    return;
  }
  try {
    const [{ RecoveryUi }, { LocalApiClient }] = await load();
    if (closed) return;
    controller = new RecoveryUi({ host, transport: new LocalApiClient(), mode: captured.mode,
      onExit: () => { stop(); location.replace('/'); } });
    resume();
  } catch { unavailable(); }
}
if (typeof document !== 'undefined') void startRecoveryPage({ window, document, location, history, navigator });
