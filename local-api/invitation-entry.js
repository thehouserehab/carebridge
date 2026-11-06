import { takeInvitationToken } from './invitation-token.js';

// Inject browser ports for deterministic lifetime tests. The real entry loads
// only the token parser before scrubbing; account/UI imports follow afterwards.
export async function startInvitationPage({ window, document, location, history, navigator,
  load = () => Promise.all([import('./invitation-ui.js'), import('./client.js')]) }) {
  let token = null, malformed = false;
  try { token = takeInvitationToken(location, history); } catch { malformed = true; }
  const host = document.querySelector('#app');
  let controller = null, closed = false, started = false;
  const unavailable = () => {
    token = null; controller?.destroy();
    if (!closed) host.innerHTML = '<section class="login"><h1>초대 화면을 불러오지 못했어요</h1><p>전달받은 원래 링크를 다시 열어 주세요.</p><a href="/">로그인으로 이동</a></section>';
  };
  const resume = () => {
    if (closed || !controller || document.visibilityState !== 'visible' || !navigator.onLine) return;
    try {
      if (!started) {
        started = true; const value = token; token = null;
        void Promise.resolve(controller.mount(value)).catch(unavailable);
      } else void Promise.resolve(controller.resume()).catch(unavailable);
    } catch { unavailable(); }
  };
  window.addEventListener('pagehide', () => { closed = true; token = null; controller?.destroy(); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.replace('/'); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') controller?.suspend(); else resume();
  });
  window.addEventListener('offline', () => controller?.suspend());
  window.addEventListener('online', resume);
  if (malformed || !token) {
    host.innerHTML = '<section class="login"><h1>초대 링크를 다시 확인해 주세요</h1><p>링크가 올바르지 않거나 이 화면을 새로고침했습니다. 전달받은 원래 링크를 다시 열어 주세요.</p><a href="/">로그인으로 이동</a></section>';
    return;
  }
  try {
    const [{ InvitationUi }, { LocalApiClient }] = await load();
    if (closed) return;
    controller = new InvitationUi({ host, transport: new LocalApiClient(),
      onAuthenticated: () => { token = null; location.replace('/'); },
      onExit: () => { token = null; controller?.destroy(); location.replace('/'); } });
    resume();
  } catch { unavailable(); }
}

if (typeof document !== 'undefined') void startInvitationPage({ window, document, location, history, navigator });
