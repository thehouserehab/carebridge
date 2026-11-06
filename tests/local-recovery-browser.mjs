// Synthetic recipient delivery -> password recovery -> ordinary login.
// Real UI/HTTP/Auth/PGlite only. No public mailbox, external mail, E/native,
// existing browser, credential logging or fabricated authentication response.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), code = 'LOCAL_RECOVERY_FAILED';
const digest = value => createHash('sha256').update(value).digest('hex');
const requestPage = '/account/password-recovery/request', completePage = '/account/password-recovery';
const api = '/api/local/auth/password-recovery', requestNotice = '요청을 확인했어요. 안내가 가능한 경우 등록된 주소로 보내드립니다.';
const assets = new Set(['/', requestPage, completePage, '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js',
  '/local-api/care-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css',
  '/local-api/goal-client.js', '/local-api/appointment-client.js', '/local-api/media-client.js', '/local-api/media-ui.js',
  '/local-api/media-viewer.js', '/local-api/operations-client.js', '/local-api/operations-ui.js', '/local-api/operations-recipient.js',
  '/local-api/operations-onboarding.js', '/local-api/operations-schedule.js', '/local-api/recovery-entry.js',
  '/local-api/recovery-token.js', '/local-api/recovery-client.js', '/local-api/recovery-ui.js', '/local-api/account-input.js',
  '/src/context-fields.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js', '/src/profile-fields.js']);
const unchangedTables = ['cb_users', 'cb_memberships', 'cb_children', 'cb_participants', 'cb_relationship_requests',
  'cb_relationship_changes', 'cb_read_states', 'cb_messages', 'cb_records', 'cb_record_revisions', 'cb_record_requests',
  'cb_record_assessments', 'cb_publications', 'cb_activity_feedback', 'cb_feedback_revisions', 'cb_feedback_reviews',
  'cb_feedback_requests', 'cb_child_family_plans', 'cb_goals', 'cb_goal_revisions', 'cb_appointments',
  'cb_appointment_revisions', 'cb_audit_events', 'cb_auth_invitations', 'cb_auth_audit_events'];

async function sources() {
  const names = ['tests/local-recovery-browser.mjs', 'tests/message-browser-policy.mjs', 'scripts/p0-study-policy.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations'])
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory() || !/\.(?:mjs|js|css|html|sql)$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), code); names.push(`${directory}/${entry.name}`);
    }
  assert.equal(new Set(names).size, names.length, code);
  const files = [];
  for (const name of names.sort()) files.push({ name, sha256: digest(await readFile(path.join(root, name))) });
  return { sha256: digest(JSON.stringify(files)), files };
}
async function bounded(work, ms = 30_000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
function lifetime(child) {
  assert(child && Number.isInteger(child.pid), code);
  const streams = [...new Set((child.stdio ?? []).filter(Boolean))], done = Promise.withResolvers();
  let exited = child.exitCode !== null || child.signalCode !== null, closed = false;
  const terminal = () => exited && closed && streams.every(stream => stream.closed === true);
  const changed = () => { if (terminal()) done.resolve(); };
  child.once('exit', () => { exited = true; changed(); }); child.once('close', () => { closed = true; changed(); });
  for (const stream of streams) stream.once('close', changed);
  return { terminal, done: done.promise };
}
async function reachable(button) {
  const deadline = Date.now() + 5000; let observation;
  while (Date.now() < deadline) {
    const timeout = () => Math.max(1, deadline - Date.now());
    await button.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }), undefined, { timeout: timeout() });
    await button.click({ trial: true, timeout: timeout() });
    observation = await button.evaluate(node => {
      const r = node.getBoundingClientRect(), x = Math.min(6, r.width / 4), y = Math.min(6, r.height / 4);
      const nav = document.querySelector('.main-nav'), n = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
      const withinViewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      const outsideNav = !n || r.bottom <= n.top || r.top >= n.bottom || r.right <= n.left || r.left >= n.right;
      const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.top + y],
        [r.left + x, r.bottom - y], [r.right - x, r.bottom - y]].map(([px, py]) => node.contains(document.elementFromPoint(px, py)));
      const rect = value => value ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, value[key]])) : null;
      return { connected: node.isConnected, bounds: rect(r), viewport: { width: innerWidth, height: innerHeight }, fixedNav: rect(n),
        withinViewport, outsideNav, hits, passed: withinViewport && outsideNav && hits.every(Boolean) };
    }, undefined, { timeout: timeout() });
    if (observation.passed) return;
    if (observation.connected) break;
  }
  const error = new Error(code); error.name = 'AssertionError'; error.reachability = observation; throw error;
}

export async function runLocalRecoveryBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const name of [options.module, options.executable]) { const stat = await lstat(name); assert(stat.isFile() && !stat.isSymbolicLink(), code); }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-recovery-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Owned Chromium and fresh memory-only PGlite, synthetic .test recipients only. No actual mail ownership, external delivery, E/native or existing browser.',
      'All successful credential mutations use UI and real HTTP/Auth. The trusted harness alone consumes an in-memory recipient capability; no publicly retrievable mailbox.',
      'A real committed completion response is discarded. Recovery has no replay receipt: ordinary login confirms the new credential, not a fabricated retry success.',
      'Only read-only DB observations are used. Expiration/deactivation/concurrency/queue-source-failure branches belong to separate server tests, not this browser success claim.',
      'Equal public response bodies are verified, not equal network timing. No passwords, raw bearer, URL fragment, HTTP body, account address or raw exception is written to results.',
      'Viewport and browser-storage observations are not physical-device, human-usability or secure-RAM-erasure proof.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, sourceSha256: source.sha256, sandboxes: [], finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (list, value) => { if (list.length < 32) list.push(value); };
  const contexts = new Set(), sandboxes = new Set(), ownedSandboxes = new Map(), pages = new Map(), routeWork = new Set(), secretSets = new Set();
  let browserServer, browser, browserLife, phase = 'STARTUP'; await save('ownership.json', ownership);
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable, host: '127.0.0.1', port: 0,
      env: studyChildEnvironment(), timeout: 30_000 });
    browserLife = lifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 768, 1440]) {
      phase = `${width}:SANDBOX`; const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const owned = { width, mediaDirectoryName: path.basename(sandbox.mediaRoot), closed: false };
      ownedSandboxes.set(sandbox, owned); ownership.sandboxes.push(owned); await save('ownership.json', ownership);
      const { ids, origin } = sandbox, originUrl = new URL(origin);
      assert(originUrl.origin === origin && originUrl.protocol === 'http:' && originUrl.hostname === '127.0.0.1' && originUrl.port && !originUrl.username && !originUrl.password, code);
      assert.equal(typeof sandbox.takeRecovery, 'function', code);
      assert.equal(Object.getOwnPropertyDescriptor(sandbox, 'takeRecovery')?.enumerable, false, code);
      const result = { width, entryLink: false, uniformRequest: false, recipientIsolation: false, requestKeepsSessions: false,
        activeSessionWarning: false, explicitLogout: false, fragmentRemoved: false, normalCompletion: false,
        ownSessionsRevoked: false, otherSessionPreserved: false, noAutoLoginOrCookie: false, ordinaryLogin: false,
        consumedLinkRejected: false, actualCommitLoss: false, noCompletionRetry: false, unknownLoginRecovery: false,
        sourceRejected: false, noPublicMailbox: false, noClinicalMutation: false, secretsNotExposed: false,
        browserStorageEmpty: false, keyboard: false, reachability: false, layout: false, cleanup: false };
      report.currentCheck = result;
      const actors = [], operations = [], clinicalWrites = [];
      const secrets = new Set(sandbox.credentials.map(item => item.password)), emails = new Set(sandbox.credentials.map(item => item.email));
      secretSets.add(secrets);
      const guardianCredential = { ...sandbox.credentials.find(item => item.role === 'guardian') };
      const therapistCredential = { ...sandbox.credentials.find(item => item.role === 'therapist') };
      const managerCredential = { ...sandbox.credentials.find(item => item.role === 'center') };
      const nextGuardian = { email: guardianCredential.email, password: randomBytes(24).toString('base64url') };
      const nextTherapist = { email: therapistCredential.email, password: randomBytes(24).toString('base64url') };
      for (const credential of [nextGuardian, nextTherapist]) secrets.add(credential.password);
      let stage = 0;
      const advance = name => { phase = `${width}:${name}`; console.log(JSON.stringify({ width, stage: ++stage })); };
      const snapshot = async tables => {
        const out = {}; for (const table of tables)
          out[table] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
        return out;
      };
      // Auth last_seen is expected to change during real reads. Session identity,
      // expiry and revocation are compared without that observation timestamp.
      const sessions = async () => (await sandbox.database.query('SELECT token_hash,user_id,expires_at,revoked_at FROM cb_auth_sessions ORDER BY token_hash')).rows;
      const events = async () => (await sandbox.database.query('SELECT id,user_id,action,revoked_sessions FROM cb_account_security_events ORDER BY id')).rows;
      const resets = async () => (await sandbox.database.query('SELECT token_hash,user_id,created_at,expires_at,consumed_at,revoked_at FROM cb_auth_password_resets ORDER BY token_hash')).rows;
      const state = who => who.page.getByTestId('recovery');
      const form = (who, mode) => who.page.locator(`[data-recovery-form="${mode}"]`);
      const checkSecrets = async who => {
        const value = await who.page.evaluate(() => ({ html: document.documentElement.outerHTML, text: document.body.innerText,
          plainInputs: [...document.querySelectorAll('input:not([type="password"]),textarea')].map(node => node.value),
          url: location.href, local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
        assert.equal(value.local, 0, code); assert.equal(value.session, 0, code); assert.equal(value.cookie, '', code);
        assert.equal(new URL(value.url).hash, '', code);
        for (const secret of secrets) assert(![value.html, value.text, value.url, ...value.plainInputs].some(text => text.includes(secret)), code);
      };
      const capture = async (who, name) => {
        await who.page.bringToFront();
        await checkSecrets(who);
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        if (await state(who).isVisible()) assert.equal(await state(who).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, code);
        const filename = `${width}-${name}.png`; assert(!report.screenshots.some(item => item.filename === filename), code);
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account'),
            ...[...emails].map(email => who.page.getByText(email, { exact: true }))] });
        report.screenshots.push({ width, filename, syntheticOnly: true });
      };
      const actor = async label => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', isMobile: width <= 640,
          hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
        const who = { label, context, page: null, userId: null, fault: { loseCompletion: false, losses: 0, done: null } }; actors.push(who);
        await context.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url()), method = request.method(), entryPhase = phase;
          const primaryRead = method === 'GET' && target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...target.searchParams].length === 1 && target.searchParams.get('conversationId') === ids.conversationId;
          const allowed = /^\/api\/local\/(?:auth\/(?:login|session|logout|password-recovery\/(?:request|complete))|centers\/[A-Za-z0-9_-]+\/(?:operations\/(?:children|members|appointments|conversations\/[A-Za-z0-9_-]+\/(?:profile|relationships))|inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|family-plan|read|goals(?:\/[A-Za-z0-9_-]+)?|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+)?)))$/.test(target.pathname);
          if (target.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(target.pathname) && ['GET', 'HEAD'].includes(method)) || allowed || primaryRead)) {
            note(report.unexpectedRequests, { width, label, phase: entryPhase, sameOrigin: target.origin === origin,
              method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' }); return route.abort().catch(() => {});
          }
          for (const secret of secrets) if ([target.href, request.headers().referer ?? ''].some(value => value.includes(secret))) {
            note(report.errors, { width, label, phase: entryPhase, type: 'secret-request-url' }); return route.abort().catch(() => {});
          }
          if (method === 'POST' && target.pathname.startsWith('/api/local/centers/')) clinicalWrites.push({ label, phase: entryPhase });
          if (!target.pathname.startsWith(api + '/')) return route.continue().catch(() => {});
          const action = target.pathname === api + '/request' ? 'request' : 'complete';
          const item = { label, action, status: null }; operations.push(item);
          const lost = action === 'complete' && who.fault.loseCompletion;
          if (lost) who.fault.loseCompletion = false;
          const work = (async () => {
            let response;
            try {
              assert.equal(new URL(who.page.url()).hash, '', code);
              assert.equal(request.headers()['x-carebridge-account'], undefined, code);
              const requestBody = request.postDataJSON();
              assert.deepEqual(Object.keys(requestBody).sort(), (action === 'request' ? ['email'] : ['token', 'newPassword', 'confirmation']).sort(), code);
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
              const body = await response.json(); item.status = response.status();
              assert.equal(response.headers()['cache-control'], 'no-store', code);
              assert.equal(response.headers()['set-cookie'], undefined, code);
              for (const secret of secrets) assert(!JSON.stringify(body).includes(secret), code);
              if (item.status >= 400) {
                assert([400, 409, 410, 503].includes(item.status), code);
                assert.deepEqual(Object.keys(body).sort(), ['error', 'message'], code);
              } else if (action === 'request') {
                assert.equal(item.status, 202, code); assert.deepEqual(body, { message: requestNotice }, code);
              } else {
                assert.equal(item.status, 200, code); assert.deepEqual(body, { passwordChanged: true, reauthenticate: true }, code);
              }
              if (lost) {
                assert.equal(item.status, 200, code); who.fault.losses++;
                await route.abort('failed').catch(() => {}); return;
              }
              await route.fulfill({ response }).catch(() => {});
            } catch { note(report.errors, { width, label, phase: entryPhase, type: 'recovery-response-contract' }); await route.abort().catch(() => {}); }
            finally { await response?.dispose().catch(() => {}); if (lost) who.fault.done?.resolve(); }
          })(); routeWork.add(work); try { await work; } finally { routeWork.delete(work); }
        });
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
          note(report.unexpectedRequests, { width, label, phase, type: 'websocket' }); socket.close();
        });
        who.page = await context.newPage(); who.page.setDefaultTimeout(15_000); pages.set(label, who.page);
        who.page.on('pageerror', () => note(report.errors, { width, label, phase, type: 'pageerror' }));
        who.page.on('console', entry => {
          const text = entry.text();
          if ([...secrets].some(secret => text.includes(secret))) note(report.errors, { width, label, phase, type: 'secret-console' });
          else if (entry.type() === 'error' && !text.startsWith('Failed to load resource:')) note(report.errors, { width, label, phase, type: 'console' });
        });
        return who;
      };
      const login = async (who, credential, { existingPage = false, expectedStatus = 200 } = {}) => {
        assert(credential?.email.endsWith('.test'), code); emails.add(credential.email); secrets.add(credential.password);
        await who.page.bringToFront();
        if (!existingPage) await who.page.goto(origin);
        await who.page.getByTestId('login-form').waitFor();
        await who.page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await who.page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === '/api/local/auth/login' && r.request().method() === 'POST'),
          who.page.getByRole('button', { name: '로그인', exact: true }).click()]);
        assert.equal(response.status(), expectedStatus, code);
        if (expectedStatus !== 200) { assert.equal((await response.json()).error, 'AUTH_INVALID', code); return; }
        const body = await response.json(); who.userId = body.user.userId;
        await who.page.getByTestId(body.user.centers.some(center => center.role === 'center') ? 'operations-children' : 'home').waitFor();
        await checkSecrets(who);
      };
      const readSession = async who => {
        const response = await who.context.request.get(origin + '/api/local/auth/session', { timeout: 15_000, maxRedirects: 0 });
        try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
      };
      const requestRecovery = async (who, email, { fromLogin = false } = {}) => {
        emails.add(email); await who.page.bringToFront();
        if (fromLogin) {
          await who.page.goto(origin); await who.page.getByTestId('login-form').waitFor();
          const link = who.page.getByTestId('recovery-link'); await reachable(link); await link.focus(); await who.page.keyboard.press('Enter');
          result.entryLink = result.keyboard = true;
        } else await who.page.goto(origin + requestPage);
        await form(who, 'request').waitFor();
        assert.equal(new URL(who.page.url()).pathname, requestPage, code);
        await form(who, 'request').locator('[name="email"]').fill(email);
        const submit = form(who, 'request').getByRole('button', { name: '재설정 안내 요청', exact: true }); await reachable(submit);
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === api + '/request' && r.request().method() === 'POST'), submit.click()]);
        assert.equal(response.status(), 202, code); assert.deepEqual(await response.json(), { message: requestNotice }, code);
        await who.page.locator('[data-testid="recovery"][data-recovery-phase="requested"]').waitFor();
        assert.equal(await form(who, 'request').count(), 0, code); await checkSecrets(who);
      };
      const recipientLink = async email => {
        const link = await bounded(sandbox.takeRecovery(email), 15_000); assert.equal(typeof link, 'string', code);
        const target = new URL(link);
        assert.equal(target.origin, origin, code); assert.equal(target.pathname, completePage, code); assert.equal(target.search, '', code);
        assert(/^#token=cr1\.[A-Za-z0-9_-]{43}$/.test(target.hash), code);
        secrets.add(target.hash.slice(7)); assert.equal(await bounded(sandbox.takeRecovery(email), 15_000), null, code);
        return link;
      };
      const arrive = async (who, link) => {
        await who.page.bringToFront(); await who.page.goto(link); await state(who).waitFor();
        await who.page.waitForFunction(() => location.pathname === '/account/password-recovery' && location.hash === '' && location.search === '');
        await checkSecrets(who);
      };
      const fillCompletion = async (who, password) => {
        await who.page.bringToFront();
        await form(who, 'complete').waitFor();
        await form(who, 'complete').locator('[name="newPassword"]').fill(password);
        await form(who, 'complete').locator('[name="confirmation"]').fill(password);
        const submit = form(who, 'complete').getByRole('button', { name: '비밀번호 재설정', exact: true }); await reachable(submit); return submit;
      };
      const assertInvalidatedUi = async who => {
        assert.equal((await readSession(who)).status, 401, code);
        await who.page.bringToFront(); await who.page.getByTestId('login-form').waitFor();
        assert.equal(await who.page.locator('[data-testid="home"],[data-testid="inbox"],[data-testid="operations"]').count(), 0, code);
        await checkSecrets(who);
      };
      const assertEvents = (before, after, userId, revokedCount) => {
        for (const old of before) assert(after.some(row => JSON.stringify(row) === JSON.stringify(old)), code);
        const added = after.filter(row => !before.some(old => old.id === row.id));
        assert.equal(added.length, 1, code); assert.equal(added[0].user_id, userId, code);
        assert.equal(added[0].action, 'password.recovered', code); assert.equal(added[0].revoked_sessions, revokedCount, code);
      };

      advance('BASELINE_AND_UNIFORM_REQUEST');
      const first = await actor('guardian-first'), second = await actor('guardian-second'), peer = await actor('therapist-peer');
      const warning = await actor('recipient-live-session'), requester = await actor('requester');
      await login(first, guardianCredential); await login(second, guardianCredential); await login(peer, therapistCredential); await login(warning, managerCredential);
      const unchangedBefore = await snapshot(unchangedTables), sessionsBefore = await sessions(), eventsBefore = await events();
      const absent = `missing.${randomUUID()}@carebridge.test`;
      await requestRecovery(requester, absent, { fromLogin: true }); await capture(requester, 'unknown-address-uniform-notice');
      assert.equal(await bounded(sandbox.takeRecovery(absent), 15_000), null, code);
      await requestRecovery(requester, guardianCredential.email); const guardianLink = await recipientLink(guardianCredential.email);
      await capture(requester, 'known-address-uniform-notice');
      // An immediate second public request is still uniform; no second token,
      // password change, login lock or session revocation is manufactured.
      const firstResets = await resets(); await requestRecovery(requester, guardianCredential.email);
      assert.equal(await bounded(sandbox.takeRecovery(guardianCredential.email), 15_000), null, code);
      assert.deepEqual(await resets(), firstResets, code); assert.deepEqual(await sessions(), sessionsBefore, code);
      assert.deepEqual(await events(), eventsBefore, code); assert.deepEqual(await snapshot(unchangedTables), unchangedBefore, code);
      assert.equal((await readSession(first)).status, 200, code); assert.equal((await readSession(second)).status, 200, code);
      result.uniformRequest = result.recipientIsolation = result.requestKeepsSessions = true;

      advance('SOURCE_AND_PRIVATE_CHANNEL');
      const sourceBefore = await resets();
      const sourceResponse = await requester.context.request.post(origin + api + '/request', { data: { email: guardianCredential.email },
        headers: { 'Content-Type': 'application/json', 'X-Carebridge-Request': '1' }, timeout: 15_000, maxRedirects: 0 });
      try { assert.equal(sourceResponse.status(), 403, code); assert.equal((await sourceResponse.json()).error, 'SOURCE_REJECTED', code); }
      finally { await sourceResponse.dispose(); }
      for (const suffix of ['/mailbox', '/token', '/status']) {
        const response = await requester.context.request.get(origin + api + suffix, { timeout: 15_000, maxRedirects: 0 });
        try { assert.equal(response.status(), 404, code); assert.deepEqual(Object.keys(await response.json()).sort(), ['error', 'message'], code); }
        finally { await response.dispose(); }
      }
      assert.deepEqual(await resets(), sourceBefore, code); result.sourceRejected = result.noPublicMailbox = true;

      advance('ACTIVE_SESSION_REQUIRES_EXPLICIT_LOGOUT');
      await arrive(warning, guardianLink); await state(warning).locator('[data-recovery-action="logout"]').waitFor();
      assert.equal(await form(warning, 'complete').count(), 0, code);
      const warningText = await state(warning).innerText(); for (const email of emails) assert(!warningText.includes(email), code);
      assert.equal((await readSession(warning)).body.user.userId, ids.managerId, code);
      assert.equal(operations.filter(item => item.action === 'complete').length, 0, code);
      await capture(warning, 'live-session-warning'); result.activeSessionWarning = true;
      await reachable(state(warning).locator('[data-recovery-action="logout"]'));
      await state(warning).locator('[data-recovery-action="logout"]').click(); await form(warning, 'complete').waitFor();
      assert.equal((await readSession(warning)).status, 401, code); result.explicitLogout = result.fragmentRemoved = true;
      await capture(warning, 'empty-new-password-form');

      advance('COMPLETE_AND_REVOKE_ONLY_SUBJECT');
      const beforeCompletion = await sessions(), beforeCompleteEvents = await events();
      const ownLive = beforeCompletion.filter(row => row.user_id === ids.guardianId && !row.revoked_at); assert.equal(ownLive.length, 2, code);
      const submit = await fillCompletion(warning, nextGuardian.password); await submit.focus();
      const [completed] = await Promise.all([warning.page.waitForResponse(r => new URL(r.url()).pathname === api + '/complete' && r.request().method() === 'POST'), warning.page.keyboard.press('Enter')]);
      assert.equal(completed.status(), 200, code); assert.deepEqual(await completed.json(), { passwordChanged: true, reauthenticate: true }, code);
      await warning.page.locator('[data-testid="recovery"][data-recovery-phase="completed"]').waitFor();
      assert.equal(await form(warning, 'complete').count(), 0, code); await capture(warning, 'completed-without-login');
      assert.equal((await readSession(warning)).status, 401, code); assert.deepEqual(await warning.context.cookies(), [], code);
      const afterCompletion = await sessions(); assert.equal(afterCompletion.length, beforeCompletion.length, code);
      assert(afterCompletion.filter(row => row.user_id === ids.guardianId).every(row => row.revoked_at), code);
      assert.deepEqual(afterCompletion.filter(row => row.user_id !== ids.guardianId), beforeCompletion.filter(row => row.user_id !== ids.guardianId), code);
      assertEvents(beforeCompleteEvents, await events(), ids.guardianId, 2);
      assert.equal((await resets()).filter(row => row.user_id === ids.guardianId && row.consumed_at).length, 1, code);
      await assertInvalidatedUi(first); await assertInvalidatedUi(second); await capture(first, 'old-session-cleared');
      assert.equal((await readSession(peer)).body.user.userId, ids.therapistId, code);
      await peer.page.bringToFront(); await peer.page.getByTestId('home').waitFor();
      result.normalCompletion = result.ownSessionsRevoked = result.otherSessionPreserved = result.noAutoLoginOrCookie = true;
      await warning.page.bringToFront(); await warning.page.locator('[data-testid="recovery"][data-recovery-phase="completed"]').waitFor();
      await state(warning).locator('[data-recovery-action="exit"]').click(); await warning.page.getByTestId('login-form').waitFor();
      await login(warning, guardianCredential, { existingPage: true, expectedStatus: 401 });
      await login(warning, nextGuardian, { existingPage: true }); assert.equal(warning.userId, ids.guardianId, code);
      await capture(warning, 'new-password-normal-login'); result.ordinaryLogin = true;

      advance('CONSUMED_TOKEN_IS_NOT_REPLAY');
      const consumed = await actor('consumed-link'); await arrive(consumed, guardianLink);
      const consumedBefore = await snapshot(['cb_auth_accounts', 'cb_auth_password_resets', 'cb_account_security_events']);
      const invalidSubmit = await fillCompletion(consumed, nextGuardian.password);
      const [invalid] = await Promise.all([consumed.page.waitForResponse(r => new URL(r.url()).pathname === api + '/complete' && r.request().method() === 'POST'), invalidSubmit.click()]);
      assert.equal(invalid.status(), 410, code); assert.equal((await invalid.json()).error, 'PASSWORD_RECOVERY_INVALID', code);
      await state(consumed).getByRole('heading', { name: '재설정 링크를 사용할 수 없어요', exact: true }).waitFor();
      assert.equal(await form(consumed, 'complete').count(), 0, code);
      assert.deepEqual(await snapshot(['cb_auth_accounts', 'cb_auth_password_resets', 'cb_account_security_events']), consumedBefore, code);
      await capture(consumed, 'consumed-link-safe-error'); result.consumedLinkRejected = true;

      advance('COMMITTED_RESPONSE_LOSS_REQUIRES_LOGIN');
      await requestRecovery(requester, therapistCredential.email); const therapistLink = await recipientLink(therapistCredential.email);
      const uncertain = await actor('completion-unknown'); await arrive(uncertain, therapistLink);
      const beforeUnknown = await sessions(), beforeUnknownEvents = await events();
      const peerLive = beforeUnknown.filter(row => row.user_id === ids.therapistId && !row.revoked_at).length; assert.equal(peerLive, 1, code);
      const unknownSubmit = await fillCompletion(uncertain, nextTherapist.password);
      uncertain.fault.loseCompletion = true; uncertain.fault.done = Promise.withResolvers(); await unknownSubmit.click();
      await state(uncertain).getByRole('heading', { name: '재설정 결과를 확인할 수 없어요', exact: true }).waitFor();
      await bounded(uncertain.fault.done.promise, 15_000); assert.equal(uncertain.fault.losses, 1, code);
      assert.equal(operations.filter(item => item.label === uncertain.label && item.action === 'complete').length, 1, code);
      assert.equal(await form(uncertain, 'complete').count(), 0, code);
      assert.equal(await state(uncertain).getByRole('button', { name: '비밀번호 재설정', exact: true }).count(), 0, code);
      assert.equal(await state(uncertain).locator('[data-recovery-action*="retry"]').count(), 0, code);
      assert.equal((await readSession(uncertain)).status, 401, code); assert.deepEqual(await uncertain.context.cookies(), [], code);
      const afterUnknown = await sessions(); assert.equal(afterUnknown.length, beforeUnknown.length, code);
      assert(afterUnknown.filter(row => row.user_id === ids.therapistId).every(row => row.revoked_at), code);
      assert.deepEqual(afterUnknown.filter(row => row.user_id !== ids.therapistId), beforeUnknown.filter(row => row.user_id !== ids.therapistId), code);
      assertEvents(beforeUnknownEvents, await events(), ids.therapistId, peerLive);
      await assertInvalidatedUi(peer); assert.equal((await readSession(warning)).body.user.userId, ids.guardianId, code);
      await capture(uncertain, 'unknown-result-no-resubmit'); result.actualCommitLoss = result.noCompletionRetry = true;
      await state(uncertain).locator('[data-recovery-action="exit"]').click(); await uncertain.page.getByTestId('login-form').waitFor();
      await login(uncertain, nextTherapist, { existingPage: true }); assert.equal(uncertain.userId, ids.therapistId, code);
      assert.equal(operations.filter(item => item.label === uncertain.label && item.action === 'complete').length, 1, code);
      assert.equal((await resets()).filter(row => row.user_id === ids.therapistId && row.consumed_at).length, 1, code);
      await capture(uncertain, 'unknown-confirmed-by-normal-login'); result.unknownLoginRecovery = true;

      advance('UNCHANGED_CLINICAL_AND_SECRET_BOUNDARIES');
      assert.deepEqual(await snapshot(unchangedTables), unchangedBefore, code); assert.equal(clinicalWrites.length, 0, code);
      result.noClinicalMutation = true;
      for (const who of actors) await checkSecrets(who);
      result.secretsNotExposed = result.browserStorageEmpty = result.reachability = result.layout = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      for (const who of actors) await who.context.close(); pages.clear();
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code);
      sandboxes.delete(sandbox); owned.closed = true; ownedSandboxes.delete(sandbox); assert.equal(ownedSandboxes.size, 0, code);
      secrets.clear(); secretSets.delete(secrets); operations.length = 0;
      for (const credential of [guardianCredential, therapistCredential, managerCredential, nextGuardian, nextTherapist]) { credential.password = ''; credential.email = ''; }
      await save('ownership.json', ownership); result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: Object.values(result).filter(value => value === true).length }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-recovery-browser\.mjs:(\d+):\d+/)?.[1]) || null };
    if (error?.reachability) report.failure.reachability = error.reachability;
    for (const [label, page] of [...pages].slice(-2)) try {
      const sensitive = await page.evaluate(values => {
        const text = [document.documentElement.outerHTML, document.body.innerText, location.href,
          ...[...document.querySelectorAll('input:not([type="password"]),textarea')].map(node => node.value)].join('\n');
        return values.some(value => text.includes(value));
      }, [...secretSets].flatMap(values => [...values]));
      if (sensitive) { note(report.errors, { phase, type: 'failure-sensitive-screenshot-suppressed' }); continue; }
      const filename = `failure-${label}.png`; await page.screenshot({ path: path.join(folder, filename), fullPage: false,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] });
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
  } finally {
    try { await bounded(Promise.all([...routeWork])); } catch { report.cleanupObservationTimedOut = true; }
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch { report.cleanupObservationTimedOut = true; }
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browser?.close()); await bounded(browserServer.close()); await bounded(browserLife.done); }
      catch { report.cleanupObservationTimedOut = true; try { await bounded(browserServer.kill()); await bounded(browserLife.done); } catch {} }
      report.cleanup.browserStopped = browserLife?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    if (report.cleanup.browserStopped) for (const sandbox of sandboxes) try {
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox);
      ownedSandboxes.get(sandbox).closed = true; ownedSandboxes.delete(sandbox);
    } catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
    report.cleanup.sandboxesClosed = sandboxes.size === 0 && ownedSandboxes.size === 0;
    report.finishedAt = new Date().toISOString(); for (const values of secretSets) values.clear(); secretSets.clear();
    report.passed = !report.failure && !report.cleanupObservationTimedOut && report.checks.length === 3 && report.checks.every(check =>
      Object.entries(check).every(([key, value]) => key === 'width' || value === true)) && report.errors.length === 0 &&
      report.unexpectedRequests.length === 0 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalRecoveryBrowser()) process.exitCode = 1; }
  catch { console.error(code); process.exitCode = 1; }
}
