// Synthetic recipient delivery -> invitation -> authenticated account ->
// separate child relationship. No real mail, existing browser, E or native DB.
// Tokens are obtained only by the harness's recipient channel and never by
// the manager UI/API. No request body, credential or delivery link is reported.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceView, workspaceRoom, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), code = 'LOCAL_INVITATIONS_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const assets = new Set(['/', '/account/invitation', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/account-input.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/goal-client.js',
  '/local-api/appointment-client.js', '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js',
  '/local-api/operations-client.js', '/local-api/operations-ui.js', '/local-api/operations-recipient.js', '/local-api/operations-onboarding.js', '/local-api/operations-schedule.js',
  '/local-api/invitation-client.js', '/local-api/invitation-token.js', '/local-api/invitation-ui.js', '/local-api/invitation-entry.js', '/local-api/operations-invitations.js',
  '/src/context-fields.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js', '/src/profile-fields.js']);
const clinicalTables = ['cb_messages', 'cb_records', 'cb_record_revisions', 'cb_record_requests', 'cb_record_assessments',
  'cb_publications', 'cb_activity_feedback', 'cb_feedback_revisions', 'cb_feedback_reviews', 'cb_feedback_requests',
  'cb_child_family_plans', 'cb_goals', 'cb_goal_revisions', 'cb_appointments', 'cb_appointment_revisions', 'cb_audit_events'];
const invitationKeys = ['id', 'centerId', 'email', 'role', 'status', 'createdAt', 'expiresAt', 'acceptedAt', 'revokedAt'].sort();
const previewKeys = ['id', 'centerId', 'role', 'expiresAt'].sort();
const acceptedKeys = ['id', 'centerId', 'role'].sort();
const userKeys = ['userId', 'email', 'centers', 'expiresAt'].sort();
const requestNotice = '요청을 확인했어요. 안내가 가능한 경우 등록된 주소로 보내드립니다.';

async function sources() {
  const names = ['tests/local-invitations-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
    'tests/message-browser-policy.mjs', 'scripts/p0-study-policy.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations']) for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (entry.isDirectory() || !/\.(?:mjs|js|css|html|sql)$/.test(entry.name)) continue;
    assert(entry.isFile() && !entry.isSymbolicLink(), code); names.push(`${directory}/${entry.name}`);
  }
  assert.equal(new Set(names).size, names.length, code);
  const files = [];
  for (const name of names.sort()) files.push({ name, sha256: hash(await readFile(path.join(root, name))) });
  return { sha256: hash(JSON.stringify(files)), files };
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
      const r = node.getBoundingClientRect(), nav = document.querySelector('.main-nav');
      const n = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
      const x = Math.min(6, r.width / 4), y = Math.min(6, r.height / 4), modal = !!node.closest('dialog')?.open;
      const viewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      const outsideNav = modal || !n || r.bottom <= n.top || r.top >= n.bottom || r.right <= n.left || r.left >= n.right;
      const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.top + y],
        [r.left + x, r.bottom - y], [r.right - x, r.bottom - y]].map(([px, py]) => node.contains(document.elementFromPoint(px, py)));
      const rect = v => v ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(k => [k, v[k]])) : null;
      return { connected: node.isConnected, bounds: rect(r), viewport: { width: innerWidth, height: innerHeight }, fixedNav: rect(n),
        withinViewport: viewport, outsideNav, hits, passed: viewport && outsideNav && hits.every(Boolean) };
    }, undefined, { timeout: timeout() });
    if (observation.passed) return;
    if (observation.connected) break;
  }
  const error = new Error(code); error.name = 'AssertionError'; error.reachability = observation; throw error;
}

export async function runLocalInvitationsBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const name of [options.module, options.executable]) { const stat = await lstat(name); assert(stat.isFile() && !stat.isSymbolicLink(), code); }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-invitations-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Owned Chromium and fresh memory-only PGlite. Synthetic .test recipients only; no email ownership or real delivery proof, E/native or existing browser.',
      'The harness alone consumes recipient-scoped in-memory delivery. No manager token response, public mailbox endpoint or fabricated authentication response.',
      'Successful account, invitation, relationship and message writes use UI. Final synthetic manager membership revocation alone uses fixture SQL.',
      'Real HTTP responses are discarded or held to test uncertainty and late delivery. No request payload, token, password or raw exception is serialized.',
      'New-account acceptance has no idempotent write receipt. A committed but lost response is confirmed through normal login, not assumed rollback or automatic reissue.',
      'Viewport and browser-storage observations are not physical-device, human-usability, secure-memory-erasure or production-mail claims.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, sourceSha256: source.sha256, sandboxes: [], finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (list, value) => { if (list.length < 32) list.push(value); };
  const contexts = new Set(), sandboxes = new Set(), ownedSandboxes = new Map(), pages = new Map(), releases = new Set(), routeWork = new Set(), secretSets = new Set();
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
      const { ids, origin } = sandbox, url = new URL(origin);
      assert(url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !url.username && !url.password, code);
      assert.equal(typeof sandbox.takeInvitation, 'function', code);
      assert.equal(Object.getOwnPropertyDescriptor(sandbox, 'takeInvitation')?.enumerable, false, code);
      const result = { width, managerMinimalDto: false, recipientIsolation: false, fragmentRemoved: false, newAccount: false,
        noImplicitChildAccess: false, explicitFromNow: false, subsequentNews: false, wrongExistingSession: false,
        existingAcceptanceRetry: false, noDuplicateMembership: false, newCommitLossLogin: false, revokedInvite: false,
        lateAccountDiscarded: false, managerRevoked: false, noAutomaticClinicalWrites: false, secretsNotExposed: false,
        browserStorageEmpty: false, keyboard: false, reachability: false, layout: false, cleanup: false };
      report.currentCheck = result;
      const secrets = new Set(sandbox.credentials.map(item => item.password)), emails = new Set(sandbox.credentials.map(item => item.email));
      secretSets.add(secrets);
      const actors = [], operations = [], managerClinicalRequests = [];
      const ops = `/api/local/centers/${ids.centerId}/operations`, invitePath = ops + '/invitations';
      const roomPath = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const authPath = '/api/local/auth/invitations/';
      const advance = name => { phase = `${width}:${name}`; };
      const gate = () => {
        const g = { entered: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers() };
        const release = () => g.release.resolve(); releases.add(release);
        return { ...g, finish: () => { release(); releases.delete(release); } };
      };
      const snapshot = async tables => {
        const out = {}; for (const table of tables) out[table] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
        return out;
      };
      const capture = async (who, name) => {
        await checkSecrets(who);
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        const modal = who.page.getByTestId('care-dialog');
        if (await modal.isVisible()) assert.equal(await modal.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, code);
        const filename = `${width}-${name}.png`; assert(!report.screenshots.some(item => item.filename === filename), code);
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account'),
            ...[...emails].map(email => who.page.getByText(email, { exact: true }))] });
        report.screenshots.push({ width, filename, syntheticOnly: true });
      };
      const checkSecrets = async who => {
        const state = await who.page.evaluate(() => ({ html: document.documentElement.outerHTML, text: document.body.innerText,
          plainInputs: [...document.querySelectorAll('input:not([type="password"]),textarea')].map(node => node.value),
          url: location.href, local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
        assert.equal(state.local, 0, code); assert.equal(state.session, 0, code); assert.equal(state.cookie, '', code);
        assert.equal(new URL(state.url).hash, '', code);
        for (const secret of secrets) assert(![state.html, state.text, state.url, ...state.plainInputs].some(value => value.includes(secret)), code);
      };
      const validate = (pathname, method, body, status) => {
        const text = JSON.stringify(body);
        for (const secret of secrets) assert(!text.includes(secret), code);
        if (status >= 400) {
          assert([400, 401, 404, 409, 410].includes(status), code);
          assert.deepEqual(Object.keys(body).sort(), ['error', 'message'], code); return;
        }
        if (pathname === invitePath) {
          if (method === 'POST') { assert.equal(status, 202, code); assert.deepEqual(body, { message: requestNotice }, code); }
          else {
            assert.equal(status, 200, code); assert.deepEqual(Object.keys(body), ['invitations'], code);
            for (const invitation of body.invitations) assert.deepEqual(Object.keys(invitation).sort(), invitationKeys, code);
          }
        } else if (pathname.startsWith(invitePath + '/')) {
          assert.equal(status, 200, code); assert.deepEqual(body, { revoked: true }, code);
        } else if (pathname === authPath + 'preview') {
          assert.equal(status, 200, code); assert.deepEqual(Object.keys(body), ['invitation'], code);
          assert.deepEqual(Object.keys(body.invitation).sort(), previewKeys, code);
        } else {
          assert.equal(status, 200, code);
          assert.deepEqual(Object.keys(body).sort(), (pathname.endsWith('/accept-existing') ? ['user', 'invitation', 'linked', 'replayed'] : ['user', 'invitation']).sort(), code);
          assert.deepEqual(Object.keys(body.user).sort(), userKeys, code); assert.deepEqual(Object.keys(body.invitation).sort(), acceptedKeys, code);
          for (const center of body.user.centers) assert.deepEqual(Object.keys(center).sort(), ['id', 'role'], code);
        }
      };
      const actor = async label => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', isMobile: width <= 640,
          hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
        const who = { label, context, page: null, userId: null, fault: { losePath: null, losses: 0, nextGet: null } }; actors.push(who);
        await context.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url()), method = request.method(), entryPhase = phase;
          const primaryRead = method === 'GET' && target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...target.searchParams].length === 1 && target.searchParams.get('conversationId') === ids.conversationId;
          const allowed = /^\/api\/local\/(?:auth\/(?:login|session|logout|invitations\/(?:preview|accept|accept-existing))|centers\/[A-Za-z0-9_-]+\/(?:operations\/(?:children|members|invitations(?:\/inv_[a-f0-9]{32}\/revoke)?|conversations\/[A-Za-z0-9_-]+\/(?:profile|relationships))|inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|family-plan|read|goals(?:\/[A-Za-z0-9_-]+)?|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+)?)))$/.test(target.pathname);
          if (target.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(target.pathname) && ['GET', 'HEAD'].includes(method)) || allowed || primaryRead)) {
            note(report.unexpectedRequests, { width, label, phase: entryPhase, sameOrigin: target.origin === origin,
              method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' }); return route.abort().catch(() => {});
          }
          for (const secret of secrets) if ([target.href, request.headers().referer ?? ''].some(value => value.includes(secret))) {
            note(report.errors, { width, label, phase: entryPhase, type: 'secret-request-url' }); return route.abort().catch(() => {});
          }
          const headers = request.headers();
          if (headers['x-carebridge-account'] === ids.managerId && target.pathname.startsWith('/api/local/centers/') && !target.pathname.startsWith(ops + '/'))
            managerClinicalRequests.push({ label, phase: entryPhase });
          const invitationRequest = target.pathname === invitePath || target.pathname.startsWith(invitePath + '/') || target.pathname.startsWith(authPath);
          if (!invitationRequest) return route.continue().catch(() => {});
          // These bodies are intentionally memory-only to compare exact real
          // retry payloads; they are not attached to report or thrown errors.
          const item = { label, pathname: target.pathname, method, body: method === 'POST' ? structuredClone(request.postDataJSON()) : null };
          operations.push(item);
          const lost = who.fault.losePath === target.pathname; if (lost) who.fault.losePath = null;
          const held = method === 'GET' && target.pathname === invitePath ? who.fault.nextGet : null; if (held) who.fault.nextGet = null;
          const work = (async () => {
            let response;
            try {
              if (target.pathname === authPath + 'preview') assert.equal(new URL(who.page.url()).hash, '', code);
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
              const body = await response.json(); validate(target.pathname, method, body, response.status());
              assert.equal(response.headers()['cache-control'], 'no-store', code);
              item.status = response.status(); item.response = structuredClone(body);
              if (lost) {
                assert.equal(response.status(), 200, code); who.fault.losses++;
                await route.abort('failed').catch(() => {}); return;
              }
              if (held) { held.entered.resolve(); await held.release.promise; }
              await route.fulfill({ response }).catch(() => {});
            } catch { note(report.errors, { width, label, phase: entryPhase, type: 'invitation-response-contract' }); await route.abort().catch(() => {}); }
            finally { await response?.dispose().catch(() => {}); held?.done.resolve(); }
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
      const login = async (who, credential, { existingPage = false } = {}) => {
        assert(credential?.email.endsWith('.test'), code); emails.add(credential.email); secrets.add(credential.password);
        if (!existingPage) await who.page.goto(origin);
        await who.page.getByTestId('login-form').waitFor();
        await who.page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await who.page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === '/api/local/auth/login' && r.request().method() === 'POST'),
          who.page.getByRole('button', { name: '로그인', exact: true }).click()]);
        assert.equal(response.status(), 200, code); const body = await response.json(); who.userId = body.user.userId;
        await who.page.getByTestId(body.user.centers.some(c => c.role === 'center') ? 'operations-children' : 'home').waitFor(); await checkSecrets(who);
      };
      const request = async (who, pathname) => {
        const response = await who.context.request.get(origin + pathname, { timeout: 15_000, maxRedirects: 0, headers: { 'X-Carebridge-Account': who.userId } });
        try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
      };
      const recipientLink = async email => {
        assert(email.endsWith('.test'), code); const link = await sandbox.takeInvitation(email);
        assert.equal(typeof link, 'string', code); const target = new URL(link);
        assert.equal(target.origin, origin, code); assert.equal(target.pathname, '/account/invitation', code);
        assert.equal(target.search, '', code); assert(/^#token=[A-Za-z0-9_-]{40,100}$/.test(target.hash), code);
        secrets.add(target.hash.slice(7)); assert.equal(await sandbox.takeInvitation(email), null, code);
        return link;
      };
      const center = await actor('center'), therapist = await actor('therapist');
      await login(center, sandbox.credentials.find(item => item.role === 'center'));
      await login(therapist, sandbox.credentials.find(item => item.role === 'therapist'));
      const panel = who => who.page.getByTestId('operations-invitations');
      const landing = who => who.page.getByTestId('invitation');
      const form = (who, mode) => who.page.locator(`[data-invitation-form="${mode}"]`);
      const openInvitations = async who => {
        await who.page.bringToFront();
        if (await panel(who).isVisible()) return;
        await who.page.locator('[data-ops-action="invitations"]').click(); await panel(who).waitFor();
      };
      const refreshInvitations = async who => {
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === invitePath && r.request().method() === 'GET'),
          panel(who).getByRole('button', { name: '초대 목록 새로고침', exact: true }).click()]);
        assert.equal(response.status(), 200, code); return (await response.json()).invitations;
      };
      const invite = async (email, role = 'guardian') => {
        emails.add(email); await openInvitations(center); const f = form(center, 'invite');
        await f.locator('[name="email"]:not([disabled])').waitFor(); await f.locator('[name="email"]').fill(email);
        await f.locator('[name="role"]').selectOption(role);
        const [response] = await Promise.all([center.page.waitForResponse(r => new URL(r.url()).pathname === invitePath && r.request().method() === 'POST'),
          f.getByRole('button', { name: '초대 요청', exact: true }).click()]);
        assert.equal(response.status(), 202, code); assert.deepEqual(await response.json(), { message: requestNotice }, code);
        const rows = await refreshInvitations(center), match = rows.filter(item => item.email === email && item.status === 'pending');
        assert.equal(match.length, 1, code); await panel(center).locator(`article[data-invitation-id="${match[0].id}"]`).waitFor();
        await checkSecrets(center); return match[0];
      };
      const arrive = async (who, link, { valid = true } = {}) => {
        await who.page.goto(link); await landing(who).waitFor();
        await who.page.waitForFunction(() => location.pathname === '/account/invitation' && location.hash === '' && location.search === '');
        await checkSecrets(who);
        if (valid) await who.page.locator('[data-invitation-action="new"], [data-invitation-form="existing"]').first().waitFor();
      };
      const createAccount = async (who, credential, { lost = false } = {}) => {
        secrets.add(credential.password); emails.add(credential.email);
        await landing(who).locator('[data-invitation-action="new"]').click(); const f = form(who, 'new'); await f.waitFor();
        if (!lost) await capture(who, 'new-account-password-form');
        await f.locator('[name="password"]').fill(credential.password); await f.locator('[name="confirmation"]').fill(credential.password);
        await f.locator('[name="confirmed"]').check(); await reachable(f.locator('button[type="submit"]'));
        if (lost) {
          who.fault.losePath = authPath + 'accept'; await f.locator('button[type="submit"]').click();
          await landing(who).getByRole('button', { name: '로그인으로 결과 확인', exact: true }).waitFor();
          assert.equal(who.fault.losses, 1, code); assert.equal(await form(who, 'new').count(), 0, code);
          assert.equal(await landing(who).locator('[data-invitation-action="retry-existing"]').count(), 0, code);
          return operations.findLast(item => item.label === who.label && item.pathname === authPath + 'accept').response;
        }
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === authPath + 'accept' && r.request().method() === 'POST'),
          f.locator('button[type="submit"]').click()]);
        assert.equal(response.status(), 200, code); const body = await response.json(); who.userId = body.user.userId;
        await who.page.getByTestId('home').waitFor(); await checkSecrets(who); return body;
      };
      const send = async text => {
        await therapist.page.bringToFront(); await workspaceRoom(therapist.page, ids.conversationId);
        await therapist.page.getByLabel('메시지', { exact: true }).fill(text);
        const [response] = await Promise.all([therapist.page.waitForResponse(r => new URL(r.url()).pathname === roomPath + '/messages' && r.request().method() === 'POST'),
          therapist.page.locator('.composer').getByRole('button', { name: '보내기', exact: true }).click()]);
        assert.equal(response.status(), 201, code); return (await response.json()).message;
      };
      const clinicalBefore = await snapshot(clinicalTables);
      const relationBefore = await snapshot(['cb_participants', 'cb_relationship_requests', 'cb_relationship_changes']);
      advance('MANAGER_REQUEST_AND_RECIPIENT_CHANNEL');
      await reachable(center.page.locator('[data-ops-action="invitations"]'));
      await center.page.locator('[data-ops-action="invitations"]').focus(); await center.page.keyboard.press('Enter'); await panel(center).waitFor();
      const recipientCredential = { email: `recipient.${randomUUID()}@carebridge.test`, password: randomBytes(24).toString('base64url') };
      const firstInvitation = await invite(recipientCredential.email);
      assert.equal(await sandbox.takeInvitation(`other.${randomUUID()}@carebridge.test`), null, code);
      const firstLink = await recipientLink(recipientCredential.email); await checkSecrets(center);
      assert.equal(Object.keys(sandbox).includes('takeInvitation'), false, code);
      await capture(center, 'manager-list-no-token'); result.managerMinimalDto = result.recipientIsolation = result.keyboard = result.reachability = true;

      advance('NEW_RECIPIENT_FRAGMENT_AND_ACCEPT');
      const recipient = await actor('recipient'); await arrive(recipient, firstLink); await capture(recipient, 'recipient-confirmation');
      const accepted = await createAccount(recipient, recipientCredential);
      assert.deepEqual(accepted.invitation, { id: firstInvitation.id, centerId: ids.centerId, role: 'guardian' }, code);
      assert.equal(accepted.user.email, recipientCredential.email, code); result.newAccount = result.fragmentRemoved = true;
      const initialInbox = await request(recipient, `/api/local/centers/${ids.centerId}/inbox`);
      assert.equal(initialInbox.status, 200, code); assert.deepEqual(initialInbox.body.rooms, [], code);
      for (const suffix of ['/profile', '/messages']) assert.equal((await request(recipient, roomPath + suffix)).status, 404, code);
      assert.deepEqual(await snapshot(clinicalTables), clinicalBefore, code); assert.deepEqual(await snapshot(['cb_participants', 'cb_relationship_requests', 'cb_relationship_changes']), relationBefore, code);
      const account = await sandbox.database.query('SELECT user_id FROM cb_auth_accounts WHERE email=$1', [recipientCredential.email]);
      assert.deepEqual(account.rows.map(row => row.user_id), [recipient.userId], code);
      assert.equal(await recipient.page.getByTestId('inbox').locator('[data-room-id]').count(), 0, code);
      await capture(recipient, 'accepted-no-child-access'); result.noImplicitChildAccess = true;

      advance('SEPARATE_FROM_NOW_RELATIONSHIP');
      // Current seed messages exist before admission. No account acceptance is
      // permitted to make these visible automatically.
      const previousMessages = await request(therapist, roomPath + '/messages'); assert.equal(previousMessages.status, 200, code);
      assert(previousMessages.body.messages.length > 0, code);
      await center.page.goto(origin); await center.page.getByTestId('operations-children').waitFor();
      await center.page.locator(`[data-ops-relationships="${ids.conversationId}"]`).click();
      const relationshipForm = center.page.getByTestId('operations-relationships-form'); await relationshipForm.waitFor();
      const newParticipant = relationshipForm.locator(`[name="guardian"][value="${recipient.userId}"]`);
      assert.equal(await newParticipant.isChecked(), false, code); await newParticipant.check();
      assert.equal(await relationshipForm.locator(`[data-guardian-history="${recipient.userId}"]`).inputValue(), 'from_now', code);
      await relationshipForm.locator('[name="historyConfirmed"]').check();
      const [relationshipResponse] = await Promise.all([center.page.waitForResponse(r => new URL(r.url()).pathname === `${ops}/conversations/${ids.conversationId}/relationships` && r.request().method() === 'POST'),
        relationshipForm.getByRole('button', { name: '관계 저장', exact: true }).click()]);
      assert.equal(relationshipResponse.status(), 200, code); await center.page.getByTestId('operations-children').waitFor();
      const afterAdmission = await request(recipient, roomPath + '/messages'); assert.equal(afterAdmission.status, 200, code);
      assert.deepEqual(afterAdmission.body.messages, [], code); assert.equal(afterAdmission.body.lastRead, 0, code);
      result.explicitFromNow = true;
      const future = await send(`가상 초대 연결 이후 소식 ${width}`);
      await recipient.page.bringToFront(); await workspaceView(recipient.page, 'home');
      await workspaceAccountAction(recipient.page, 'refresh');
      await workspaceRoom(recipient.page, ids.conversationId, { keyboard: true });
      await recipient.page.locator(`[data-message-id="${future.id}"]`).first().waitFor();
      for (const old of previousMessages.body.messages) assert.equal(await recipient.page.locator(`[data-message-id="${old.id}"]`).count(), 0, code);
      const visible = await request(recipient, roomPath + '/messages'); assert.deepEqual(visible.body.messages.map(item => item.id), [future.id], code);
      await capture(recipient, 'newly-connected-news-only'); result.subsequentNews = true;
      const afterExplicitMessage = await snapshot(clinicalTables);
      for (const table of clinicalTables.filter(table => !['cb_messages', 'cb_audit_events'].includes(table))) assert.deepEqual(afterExplicitMessage[table], clinicalBefore[table], code);
      assert.equal(afterExplicitMessage.cb_messages.length, clinicalBefore.cb_messages.length + 1, code);

      advance('EXISTING_RECIPIENT_WRONG_SESSION');
      const guardianCredential = sandbox.credentials.find(item => item.role === 'guardian');
      const existingInvitation = await invite(guardianCredential.email), existingLink = await recipientLink(guardianCredential.email);
      const existing = await actor('existing'); await login(existing, sandbox.credentials.find(item => item.role === 'therapist'));
      await arrive(existing, existingLink); await form(existing, 'existing').locator('[name="confirmed"]').check();
      const [wrongResponse] = await Promise.all([existing.page.waitForResponse(r => new URL(r.url()).pathname === authPath + 'accept-existing' && r.request().method() === 'POST'),
        form(existing, 'existing').locator('button[type="submit"]').click()]);
      assert.equal(wrongResponse.status(), 410, code); assert.equal((await wrongResponse.json()).error, 'INVITATION_INVALID', code);
      assert.equal((await sandbox.database.query('SELECT accepted_at FROM cb_auth_invitations WHERE id=$1', [existingInvitation.id])).rows[0].accepted_at, null, code);
      await capture(existing, 'wrong-existing-account'); result.wrongExistingSession = true;
      await landing(existing).locator('[data-invitation-action="logout"]').click(); await form(existing, 'login').waitFor();
      await form(existing, 'login').locator('[name="email"]').fill(guardianCredential.email);
      await form(existing, 'login').locator('[name="password"]').fill(guardianCredential.password);
      await form(existing, 'login').locator('button[type="submit"]').click(); await form(existing, 'existing').waitFor(); existing.userId = ids.guardianId;

      advance('EXISTING_COMMIT_LOSS_EXACT_RETRY');
      const existingState = await snapshot(['cb_users', 'cb_memberships', 'cb_auth_accounts', 'cb_participants', 'cb_relationship_requests']);
      await form(existing, 'existing').locator('[name="confirmed"]').check(); existing.fault.losePath = authPath + 'accept-existing';
      await form(existing, 'existing').locator('button[type="submit"]').click();
      await landing(existing).locator('[data-invitation-action="retry-existing"]:not([disabled])').waitFor();
      assert.equal(existing.fault.losses, 1, code);
      const firstExisting = structuredClone(operations.findLast(item => item.label === existing.label && item.pathname === authPath + 'accept-existing'));
      assert.equal(firstExisting.response.replayed, false, code);
      const committedExisting = await snapshot(['cb_auth_invitations', 'cb_auth_audit_events', 'cb_auth_sessions']);
      await capture(existing, 'existing-result-unknown');
      const [retryResponse] = await Promise.all([existing.page.waitForResponse(r => new URL(r.url()).pathname === authPath + 'accept-existing' && r.request().method() === 'POST'),
        landing(existing).locator('[data-invitation-action="retry-existing"]').click()]);
      assert.equal(retryResponse.status(), 200, code); assert.equal((await retryResponse.json()).replayed, true, code);
      assert.deepEqual(operations.findLast(item => item.label === existing.label && item.pathname === authPath + 'accept-existing').body, firstExisting.body, code);
      await existing.page.getByTestId('home').waitFor();
      assert.deepEqual(await snapshot(['cb_users', 'cb_memberships', 'cb_auth_accounts', 'cb_participants', 'cb_relationship_requests']), existingState, code);
      // Authentication can update last_seen, but acceptance/replay must not
      // create a new session or duplicate invitation/audit writes.
      const replayedExisting = await snapshot(['cb_auth_invitations', 'cb_auth_audit_events', 'cb_auth_sessions']);
      assert.deepEqual(replayedExisting.cb_auth_invitations, committedExisting.cb_auth_invitations, code);
      assert.deepEqual(replayedExisting.cb_auth_audit_events, committedExisting.cb_auth_audit_events, code);
      assert.equal(replayedExisting.cb_auth_sessions.length, committedExisting.cb_auth_sessions.length, code);
      result.existingAcceptanceRetry = result.noDuplicateMembership = true;

      advance('NEW_COMMIT_LOSS_REQUIRES_NORMAL_LOGIN');
      const lostCredential = { email: `lost.${randomUUID()}@carebridge.test`, password: randomBytes(24).toString('base64url') };
      const lostInvitation = await invite(lostCredential.email), lostLink = await recipientLink(lostCredential.email);
      const lost = await actor('new-unknown'); await arrive(lost, lostLink); const lostAccepted = await createAccount(lost, lostCredential, { lost: true });
      assert.equal(lostAccepted.invitation.id, lostInvitation.id, code);
      const acceptedCount = operations.filter(item => item.label === lost.label && item.pathname === authPath + 'accept').length;
      assert.equal(acceptedCount, 1, code); await capture(lost, 'new-account-result-unknown');
      await landing(lost).locator('[data-invitation-action="exit"]').click();
      await lost.page.waitForURL(target => target.origin === origin && target.pathname === '/' && target.hash === '');
      // route.fetch may apply Set-Cookie even though the page's response was
      // dropped. A genuinely fresh context proves normal credentials work
      // without depending on that transport implementation detail.
      const confirmed = await actor('normal-login'); await login(confirmed, lostCredential);
      assert.equal(confirmed.userId, lostAccepted.user.userId, code);
      assert.equal((await sandbox.database.query('SELECT user_id FROM cb_auth_accounts WHERE email=$1', [lostCredential.email])).rows.length, 1, code);
      assert.equal(operations.filter(item => item.label === lost.label && item.pathname === authPath + 'accept').length, 1, code);
      assert.deepEqual((await request(confirmed, `/api/local/centers/${ids.centerId}/inbox`)).body.rooms, [], code);
      await capture(confirmed, 'unknown-confirmed-by-normal-login'); result.newCommitLossLogin = true;

      advance('REVOKED_RECIPIENT_LINK');
      const revokedEmail = `revoked.${randomUUID()}@carebridge.test`, revoked = await invite(revokedEmail), revokedLink = await recipientLink(revokedEmail);
      const revokedRow = panel(center).locator(`article[data-invitation-id="${revoked.id}"]`);
      await revokedRow.locator('[name="confirmed"]').check();
      const [revokeResponse] = await Promise.all([center.page.waitForResponse(r => new URL(r.url()).pathname === `${invitePath}/${revoked.id}/revoke` && r.request().method() === 'POST'),
        revokedRow.locator('[data-revoke-invitation]').click()]);
      assert.equal(revokeResponse.status(), 200, code);
      const revokedRecipient = await actor('revoked');
      const invalidPreview = revokedRecipient.page.waitForResponse(r => new URL(r.url()).pathname === authPath + 'preview'); void invalidPreview.catch(() => {});
      await arrive(revokedRecipient, revokedLink, { valid: false }); assert.equal((await invalidPreview).status(), 410, code);
      await landing(revokedRecipient).locator('[data-invitation-action="exit"]').waitFor();
      assert.equal(await form(revokedRecipient, 'new').count(), 0, code);
      await capture(revokedRecipient, 'revoked-link-safe-error'); result.revokedInvite = true;

      advance('LATE_MANAGER_LIST_AFTER_ACCOUNT_CHANGE');
      await openInvitations(center); const heldList = gate(); center.fault.nextGet = heldList; let otherPage;
      try {
        await panel(center).getByRole('button', { name: '초대 목록 새로고침', exact: true }).click(); await bounded(heldList.entered.promise, 5000);
        otherPage = await center.context.newPage(); otherPage.setDefaultTimeout(15_000); await otherPage.goto(origin);
        await workspaceAccountAction(otherPage, 'logout');
        const switched = { ...center, page: otherPage }; await login(switched, guardianCredential, { existingPage: true });
        await center.page.bringToFront(); await center.page.getByTestId('login-form').waitFor();
        await center.page.evaluate(() => {
          window.__invitationLate = false;
          window.__invitationObserver = new MutationObserver(changes => {
            if (changes.some(change => [...change.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE &&
              (node.matches('[data-testid="operations-invitations"]') || node.querySelector('[data-testid="operations-invitations"]'))))) window.__invitationLate = true;
          }); window.__invitationObserver.observe(document.body, { subtree: true, childList: true });
        });
        heldList.finish(); await bounded(heldList.done.promise, 5000);
        await center.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await center.page.evaluate(() => window.__invitationLate), false, code);
        await center.page.evaluate(() => window.__invitationObserver.disconnect());
        assert.equal(await panel(center).count(), 0, code); await capture(center, 'late-account-list-cleared'); result.lateAccountDiscarded = true;
      } finally { heldList.finish(); await otherPage?.close(); }

      advance('MANAGER_AUTHORITY_REVOKED');
      // The preceding other-tab test intentionally left this context's cookie
      // authenticated as the guardian. Bootstrap that actual identity and use
      // its visible logout; a fresh navigation is not an anonymous session.
      await center.page.goto(origin); await center.page.getByTestId('home').waitFor();
      await workspaceAccountAction(center.page, 'logout');
      await login(center, sandbox.credentials.find(item => item.role === 'center'), { existingPage: true });
      await openInvitations(center); await form(center, 'invite').locator('[name="email"]').fill(`unsent.${randomUUID()}@carebridge.test`);
      await sandbox.database.query('UPDATE cb_memberships SET active=false WHERE center_id=$1 AND user_id=$2', [ids.centerId, ids.managerId]);
      await panel(center).getByRole('button', { name: '초대 목록 새로고침', exact: true }).click();
      await center.page.getByTestId('login-form').waitFor(); assert.equal(await panel(center).count(), 0, code);
      assert.equal(await form(center, 'invite').count(), 0, code);
      assert.equal((await request(center, invitePath)).status, 404, code);
      await capture(center, 'manager-authority-cleared'); result.managerRevoked = true;
      assert.equal(managerClinicalRequests.length, 0, code);
      assert.deepEqual(await snapshot(clinicalTables), afterExplicitMessage, code);
      result.noAutomaticClinicalWrites = result.secretsNotExposed = result.browserStorageEmpty = result.layout = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);

      // Kept adjacent to the per-width scenario so normal and failed runs use
      // the same actual owner cleanup and source-fingerprint requirements.
      for (const who of actors) { await checkSecrets(who); await who.context.close(); }
      pages.clear(); secrets.clear(); secretSets.delete(secrets);
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code); sandboxes.delete(sandbox);
      owned.closed = true; await save('ownership.json', ownership); result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: Object.values(result).filter(value => value === true).length - 1 }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-invitations-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    if (error?.reachability) report.failure.reachability = error.reachability;
    const failurePages = /MANAGER|LATE_MANAGER/.test(phase) ? [...pages].filter(([label]) => label === 'center') : [...pages].slice(-2);
    for (const [label, page] of failurePages) try {
      // If a privacy assertion itself fails, do not turn that failure into a
      // durable screenshot of a bearer. Report only that capture was withheld.
      const sensitive = await page.evaluate(values => {
        const text = [document.documentElement.outerHTML, document.body.innerText,
          ...[...document.querySelectorAll('input:not([type="password"]),textarea')].map(node => node.value)].join('\n');
        return values.some(value => text.includes(value));
      }, [...secretSets].flatMap(values => [...values]));
      if (sensitive) { note(report.errors, { phase, type: 'failure-sensitive-screenshot-suppressed' }); continue; }
      const filename = `failure-${label}.png`; await page.screenshot({ path: path.join(folder, filename), fullPage: false,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] });
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
  } finally {
    for (const release of releases) release();
    try { await bounded(Promise.all([...routeWork])); } catch { report.cleanupObservationTimedOut = true; }
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch { report.cleanupObservationTimedOut = true; }
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browser?.close()); await bounded(browserServer.close()); await bounded(browserLife.done); }
      catch { report.cleanupObservationTimedOut = true; try { await bounded(browserServer.kill()); await bounded(browserLife.done); } catch {} }
      report.cleanup.browserStopped = browserLife?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    if (report.cleanup.browserStopped) for (const sandbox of sandboxes) try {
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox); ownedSandboxes.get(sandbox).closed = true;
    } catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
    report.cleanup.sandboxesClosed = sandboxes.size === 0; report.finishedAt = new Date().toISOString();
    for (const values of secretSets) values.clear(); secretSets.clear();
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
  try { if (!await runLocalInvitationsBrowser()) process.exitCode = 1; }
  catch { console.error(code); process.exitCode = 1; }
}
