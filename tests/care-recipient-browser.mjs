// One owned memory-only DB and three fresh Chromium contexts. Account creation,
// invitation, linking, contact selection and messages use UI + real HTTP.
// Never connects to an existing browser/server or stores account capabilities.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { workspaceView, workspaceRoom, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), code = 'CARE_RECIPIENT_BROWSER_FAILED';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function sources() {
  const names = ['tests/care-recipient-browser.mjs', 'tests/local-workspace-browser-helpers.mjs', 'tests/message-browser-policy.mjs', 'scripts/p0-study-policy.mjs'];
  for (const dir of ['local-api', 'src', 'server', 'server/migrations', 'server/schema-proposals'])
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory() || !/\.(?:mjs|js|css|html|sql)$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), code); names.push(`${dir}/${entry.name}`);
    }
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
async function reachable(control) {
  await control.scrollIntoViewIfNeeded(); await control.click({ trial: true });
  const state = await control.evaluate(node => {
    const r = node.getBoundingClientRect(), nav = document.querySelector('.main-nav');
    const n = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
    const viewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    const outsideNav = !!node.closest('dialog')?.open || !n || r.bottom <= n.top || r.top >= n.bottom;
    const x = Math.min(6, r.width / 4), y = Math.min(6, r.height / 4);
    const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.bottom - y]]
      .map(([px, py]) => node.contains(document.elementFromPoint(px, py)));
    return { viewport, outsideNav, hits, passed: viewport && outsideNav && hits.every(Boolean) };
  });
  if (!state.passed) { const error = new Error(code); error.reachability = state; throw error; }
}

export async function runCareRecipientBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) { const stat = await lstat(file); assert(stat.isFile() && !stat.isSymbolicLink(), code); }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `care-recipient-${runId}`);
  await mkdir(folder, { recursive: true });
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, setup: { invitationUi: false, independentAccount: false, membershipAloneNoRoom: false, explicitFromNow: false, ownDisplayName: false },
    cleanup: { contextsClosed: false, browserStopped: false, sandboxClosed: false, databaseClosed: false, credentialsReleased: false, quarantineRemoved: false },
    limitations: ['One fresh memory-only PGlite; three fresh owned Chromium contexts reused at 390/1440 pixels. No E/native DB, existing Chrome, real data or external network.',
      'The harness consumes the factory recipient-scoped invitation channel. It is not a public mailbox or evidence of real email delivery/ownership.',
      'All account acceptance, linking, primary designation, own display name and message writes use actual UI and HTTP. SQL is read-only evidence against the new owned fixture.',
      'Clinical/media endpoint rejection is checked through authenticated read-only HTTP. No mock success, fabricated auth, browser security bypass, upload or clinical write.',
      'Viewport screenshots and CTA checks are not physical iPhone, native keyboard, human usability, persistent restart, real consent or production-readiness evidence.'] };
  const ownership = { runId, testProcessId: process.pid, sourceSha256: source.sha256, browserProcessId: null, memoryDatabaseCount: 1,
    maximumContexts: 3, quarantineName: null, finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (list, value) => { if (list.length < 30) list.push(value); };
  const contexts = new Set(), actors = [], secrets = new Set(), emails = new Set();
  let browserServer, browser, browserLife, sandbox, phase = 'STARTUP', width = 390;
  await save('ownership.json', ownership);
  const privacy = async who => {
    const state = await who.page.evaluate(() => ({ html: document.documentElement.outerHTML, text: document.body.innerText,
      values: [...document.querySelectorAll('input:not([type="password"]),textarea')].map(node => node.value),
      url: location.href, local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
    assert.equal(state.local, 0, code); assert.equal(state.session, 0, code); assert.equal(state.cookie, '', code); assert.equal(new URL(state.url).hash, '', code);
    for (const secret of secrets) assert(![state.html, state.text, state.url, ...state.values].some(value => value.includes(secret)), code);
  };
  const capture = async (who, name) => {
    await privacy(who);
    assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
    const filename = `${width}-${name}.png`;
    await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
      mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account'),
        ...[...emails].map(email => who.page.getByText(email, { exact: true }))] });
    report.screenshots.push({ width, filename, syntheticOnly: true });
  };
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable, host: '127.0.0.1', port: 0,
      env: studyChildEnvironment(), timeout: 30_000 });
    browserLife = lifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    sandbox = await createLocalApiSandbox({ port: 0 }); ownership.quarantineName = path.basename(sandbox.mediaRoot); await save('ownership.json', ownership);
    const { ids, origin } = sandbox, url = new URL(origin);
    assert.equal(url.protocol, 'http:', code); assert.equal(url.hostname, '127.0.0.1', code); assert(url.port && url.origin === origin, code);
    assert(!url.username && !url.password && !url.search && !url.hash, code);
    const centerPath = `/api/local/centers/${ids.centerId}`, roomPath = `${centerPath}/conversations/${ids.conversationId}`;
    const invitePath = `${centerPath}/operations/invitations`, linkPath = `${centerPath}/care-recipient-link`, primaryPath = `${centerPath}/primary-communicator`;
    const assets = new Set(['/', '/account/invitation', '/favicon.ico', ...source.files.filter(f => /^(?:local-api|src)\//.test(f.name)).map(f => '/' + f.name)]);
    const reads = [], writes = [];
    for (const account of sandbox.credentials) { secrets.add(account.password); emails.add(account.email); }
    const actor = async label => {
      assert(contexts.size < 3, code);
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', serviceWorkers: 'block', permissions: [], acceptDownloads: false });
      contexts.add(context); context.once('close', () => contexts.delete(context));
      const who = { label, context, page: null, userId: null }; actors.push(who);
      await context.route('**/*', async route => {
        const request = route.request(), target = new URL(request.url()), method = request.method();
        const api = target.pathname.startsWith('/api/local/auth/') || target.pathname.startsWith(centerPath + '/');
        if (target.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !(assets.has(target.pathname) || api)) {
          note(report.unexpectedRequests, { label, phase, sameOrigin: target.origin === origin }); return route.abort().catch(() => {});
        }
        for (const secret of secrets) if ([target.href, request.headers().referer ?? ''].some(text => text.includes(secret))) {
          note(report.errors, { label, phase, type: 'secret-url' }); return route.abort().catch(() => {});
        }
        if (api) (method === 'POST' ? writes : reads).push({ label, path: target.pathname, phase });
        return route.continue().catch(() => {});
      });
      if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
        note(report.unexpectedRequests, { label, phase, type: 'websocket' }); socket.close();
      });
      who.page = await context.newPage(); who.page.setDefaultTimeout(15_000);
      who.page.on('pageerror', () => note(report.errors, { label, phase, type: 'pageerror' }));
      who.page.on('console', entry => {
        if ([...secrets].some(secret => entry.text().includes(secret))) note(report.errors, { label, phase, type: 'secret-console' });
        else if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) note(report.errors, { label, phase, type: 'console' });
      });
      return who;
    };
    const request = async (who, pathname) => {
      const response = await who.context.request.get(origin + pathname, { maxRedirects: 0, timeout: 15_000, headers: { 'X-Carebridge-Account': who.userId } });
      try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
    };
    const postViaUi = async (who, pathname, control, status = 200) => {
      await reachable(control);
      const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === pathname && r.request().method() === 'POST'), control.click()]);
      assert.equal(response.status(), status, code); assert.equal(response.headers()['cache-control'], 'no-store', code);
      return response.json();
    };
    const login = async (who, role) => {
      const credential = sandbox.credentials.find(c => c.role === role);
      await who.page.goto(origin); await who.page.getByTestId('login-form').waitFor();
      await who.page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
      await who.page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
      const body = await postViaUi(who, '/api/local/auth/login', who.page.getByRole('button', { name: '로그인', exact: true }));
      who.userId = body.user.userId;
      await who.page.getByTestId(role === 'center' ? 'operations-children' : 'home').waitFor(); await privacy(who);
    };
    const snapshot = async () => {
      const value = {};
      for (const table of ['cb_memberships', 'cb_participants', 'cb_read_states', 'cb_record_recipients'])
        value[table] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
      return value;
    };
    const center = await actor('center'), guardian = await actor('guardian'), recipient = await actor('recipient');
    await login(center, 'center'); await login(guardian, 'guardian');
    const initialGuardian = (await sandbox.database.query('SELECT * FROM cb_memberships WHERE center_id=$1 AND user_id=$2', [ids.centerId, ids.guardianId])).rows;
    const old = await request(guardian, roomPath + '/messages'); assert.equal(old.status, 200, code); assert(old.body.messages.length > 0, code);
    phase = 'INVITATION_UI'; await center.page.bringToFront();
    await center.page.locator('[data-ops-action="invitations"]').click();
    const invite = center.page.locator('[data-invitation-form="invite"]'); await invite.waitFor();
    const credential = { email: `recipient.${randomUUID()}@carebridge.test`, password: randomBytes(24).toString('base64url') };
    emails.add(credential.email); secrets.add(credential.password);
    await invite.locator('[name="email"]').fill(credential.email); await invite.locator('[name="role"]').selectOption('care_recipient');
    await capture(center, 'recipient-invitation');
    await postViaUi(center, invitePath, invite.getByRole('button', { name: '초대 요청', exact: true }), 202);
    const delivery = await sandbox.takeInvitation(credential.email); assert.equal(typeof delivery, 'string', code);
    const delivered = new URL(delivery); assert.equal(delivered.origin, origin, code); assert.equal(delivered.pathname, '/account/invitation', code);
    assert(/^#token=[A-Za-z0-9_-]{40,100}$/.test(delivered.hash), code); secrets.add(delivered.hash.slice(7));
    assert.equal(await sandbox.takeInvitation(credential.email), null, code); report.setup.invitationUi = true;
    phase = 'INDEPENDENT_ACCEPTANCE'; await recipient.page.bringToFront(); await recipient.page.goto(delivery);
    await recipient.page.locator('[data-invitation-action="new"]').click();
    const accept = recipient.page.locator('[data-invitation-form="new"]');
    await accept.locator('[name="password"]').fill(credential.password); await accept.locator('[name="confirmation"]').fill(credential.password);
    await accept.locator('[name="confirmed"]').check();
    const accepted = await postViaUi(recipient, '/api/local/auth/invitations/accept', accept.locator('button[type="submit"]'));
    recipient.userId = accepted.user.userId; assert.notEqual(recipient.userId, ids.guardianId, code);
    assert.deepEqual(accepted.user.centers, [{ id: ids.centerId, role: 'care_recipient' }], code);
    await recipient.page.getByTestId('home').waitFor(); await privacy(recipient); report.setup.independentAccount = true;
    const beforeLink = await request(recipient, centerPath + '/inbox'); assert.equal(beforeLink.status, 200, code); assert.deepEqual(beforeLink.body.rooms, [], code);
    assert.equal((await request(recipient, roomPath + '/messages')).status, 404, code);
    assert.equal(await recipient.page.getByTestId('inbox').locator('[data-room-id]').count(), 0, code);
    await capture(recipient, 'accepted-no-room'); report.setup.membershipAloneNoRoom = true;
    // Role-specific self-profile uses the existing authenticated UI as well.
    phase = 'RECIPIENT_DISPLAY_NAME'; await workspaceAccountAction(recipient.page, 'self-profile');
    const own = recipient.page.getByTestId('self-profile'); await own.locator('[name="displayName"]').fill('가상 대상자');
    await postViaUi(recipient, centerPath + '/account/profile', own.locator('[data-self-profile-action="save"]'));
    await own.waitFor({ state: 'hidden' }); report.setup.ownDisplayName = true;
    phase = 'EXPLICIT_LINK'; await center.page.bringToFront(); await center.page.goto(origin);
    await center.page.locator(`[data-ops-recipient="${ids.conversationId}"]`).click();
    const linkForm = () => center.page.locator('[data-recipient-form="connect"]');
    await linkForm().locator('[name="recipientUserId"]:not([disabled])').waitFor();
    await linkForm().locator('[name="recipientUserId"]').selectOption(recipient.userId); await linkForm().locator('[name="linkConfirmed"]').check();
    const linked = await postViaUi(center, linkPath, linkForm().locator('button[type="submit"]')); assert.equal(linked.receipt.changed, true, code);
    await center.page.locator('[data-recipient-form="disconnect"]').waitFor();
    const afterLink = await request(recipient, roomPath + '/messages'); assert.equal(afterLink.status, 200, code); assert.deepEqual(afterLink.body.messages, [], code);
    assert.deepEqual((await sandbox.database.query('SELECT * FROM cb_memberships WHERE center_id=$1 AND user_id=$2', [ids.centerId, ids.guardianId])).rows, initialGuardian, code);
    report.setup.explicitFromNow = true;
    const refresh = async who => { await who.page.bringToFront(); await workspaceAccountAction(who.page, 'refresh'); };
    const recipientRoom = async () => {
      await workspaceView(recipient.page, 'chat');
      if (!(await recipient.page.locator('#message').isVisible())) {
        const entry = recipient.page.getByTestId('inbox').locator(`[data-room-id="${ids.conversationId}"]`);
        await entry.waitFor(); await entry.focus(); await entry.press('Enter');
      }
      await recipient.page.locator('#message:not([disabled])').waitFor();
    };
    for (width of [390, 1440]) {
      phase = `${width}:ROLE_BOUNDARIES`;
      for (const who of actors) await who.page.setViewportSize({ width, height: 900 });
      const result = { width, threeMenus: false, clinicalHidden: false, clinicalHttpDenied: false, textSent: false, guardianReceived: false,
        primaryUi: false, permissionUnchanged: false, primaryReload: false, noOverflow: false, reachable: false, privateStorage: false };
      report.currentCheck = result;
      await refresh(recipient); await recipient.page.getByTestId('inbox').locator(`[data-room-id="${ids.conversationId}"]`).waitFor({ state: 'attached' });
      assert.deepEqual(await recipient.page.locator('nav.main-nav button').allTextContents(), ['홈', '대화', '참여 정보']); result.threeMenus = true;
      await workspaceView(recipient.page, 'home'); await capture(recipient, 'recipient-home');
      await workspaceView(recipient.page, 'child'); await recipient.page.getByTestId('child-content').getByText('가상 대상자', { exact: false }).first().waitFor();
      await capture(recipient, 'recipient-participants'); await recipientRoom();
      for (const selector of ['[data-care-action]', '[data-open-attachment]', 'input[type="file"]', '[data-media-action]'])
        assert.equal(await recipient.page.locator(selector + ':visible').count(), 0, code);
      for (const previous of old.body.messages) assert.equal(await recipient.page.locator(`[data-testid="message-row"][data-message-id="${previous.id}"]`).count(), 0, code);
      result.clinicalHidden = true;
      for (const suffix of ['/family-plan', '/goals', '/appointments', '/records']) assert.equal((await request(recipient, roomPath + suffix)).status, 404, code);
      assert.equal((await request(recipient, `${centerPath}/media/uploads`)).status, 404, code); result.clinicalHttpDenied = true;
      phase = `${width}:TEXT_SEND`;
      const text = `가상 대상자 텍스트 소통 ${width}`; await recipient.page.locator('#message').fill(text);
      const sent = await postViaUi(recipient, roomPath + '/messages', recipient.page.locator('.composer button[type="submit"]'), 201);
      assert.equal(sent.message.body, text, code); await recipient.page.getByTestId('message-row').filter({ hasText: text }).waitFor();
      await capture(recipient, 'recipient-text-sent'); result.textSent = true;
      await refresh(guardian); await workspaceRoom(guardian.page, ids.conversationId);
      await guardian.page.getByTestId('message-row').filter({ hasText: text }).waitFor(); await capture(guardian, 'guardian-received'); result.guardianReceived = true;
      phase = `${width}:PRIMARY_COMMUNICATOR`;
      await center.page.bringToFront(); await center.page.locator('[data-recipient-action="refresh"]').click();
      const primaryForm = center.page.locator('[data-recipient-form="primary"]');
      await primaryForm.locator('[name="primaryUserId"]:not([disabled])').waitFor();
      const userId = width === 390 ? recipient.userId : ids.guardianId;
      await primaryForm.locator('[name="primaryUserId"]').selectOption(userId); await primaryForm.locator('[name="primaryConfirmed"]').check();
      const authorityBefore = await snapshot();
      const designation = await postViaUi(center, primaryPath, primaryForm.locator('button[type="submit"]')); assert.equal(designation.receipt.changed, true, code);
      assert.deepEqual(await snapshot(), authorityBefore, code); result.permissionUnchanged = true;
      await primaryForm.locator('[name="primaryUserId"]:not([disabled])').waitFor();
      assert.equal((await request(center, `${primaryPath}?conversationId=${ids.conversationId}`)).body.primary.userId, userId, code);
      await capture(center, 'manager-primary'); result.primaryUi = true;
      await recipient.page.bringToFront(); await recipient.page.reload(); await recipient.page.getByTestId('home').waitFor(); await recipientRoom();
      const contact = recipient.page.locator('[data-primary-communicator]');
      await contact.getByText(width === 390 ? '가상 대상자 (대상자)' : '가상 보호자 (보호자)', { exact: false }).waitFor();
      assert.match(await contact.innerText(), /개인 대화·동의 완료·기록 열람 권한을 뜻하지 않/); result.primaryReload = true;
      // An empty composer intentionally disables sending. Check the reachable
      // enabled CTA with an unsent synthetic draft, then clear it without a write.
      await recipient.page.locator('#message').fill('가상 조작 확인 — 전송하지 않음');
      await reachable(recipient.page.locator('.composer button[type="submit"]'));
      await recipient.page.locator('#message').fill(''); await capture(recipient, 'recipient-primary-reloaded');
      await center.page.bringToFront(); await reachable(primaryForm.locator('button[type="submit"]')); await capture(center, 'manager-primary-cta');
      result.reachable = result.noOverflow = true;
      for (const who of actors) await privacy(who); result.privateStorage = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      report.checks.push(result); delete report.currentCheck;
    }
    assert(!reads.some(r => r.label === 'recipient' && /\/(?:family-plan|goals|appointments|records|media)(?:\/|$)/.test(r.path)), code);
    assert(!reads.some(r => r.label === 'center' && r.path.startsWith(centerPath + '/conversations/')), code);
    assert.equal(writes.filter(r => r.label === 'recipient' && r.path === roomPath + '/messages').length, 2, code);
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/care-recipient-browser\.mjs:(\d+):\d+/)?.[1]) || null };
    if (error?.reachability) report.failure.reachability = error.reachability;
    for (const who of actors) try { await capture(who, `failure-${who.label}`); }
    catch { note(report.errors, { label: who.label, phase, type: 'failure-capture-suppressed' }); }
  } finally {
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch {}
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browser?.close()); await bounded(browserServer.close()); await bounded(browserLife.done); }
      catch { try { await bounded(browserServer.kill()); await bounded(browserLife.done); } catch {} }
      report.cleanup.browserStopped = browserLife?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    if (report.cleanup.browserStopped && sandbox) try {
      await bounded(sandbox.close()); report.cleanup.sandboxClosed = true;
      report.cleanup.databaseClosed = sandbox.database.closed === true; report.cleanup.credentialsReleased = sandbox.credentials.length === 0;
      try { await lstat(sandbox.mediaRoot); } catch (error) { report.cleanup.quarantineRemoved = error.code === 'ENOENT'; }
    } catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
    if (!sandbox) for (const key of ['sandboxClosed', 'databaseClosed', 'credentialsReleased', 'quarantineRemoved']) report.cleanup[key] = true;
    secrets.clear(); emails.clear(); report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && report.checks.length === 2 && report.checks.every(check => Object.entries(check).every(([key, value]) => key === 'width' || value === true)) &&
      Object.values(report.setup).every(Boolean) && Object.values(report.cleanup).every(Boolean) && !report.errors.length && !report.unexpectedRequests.length;
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runCareRecipientBrowser()) process.exitCode = 1; }
  catch { console.error(code); process.exitCode = 1; }
}
