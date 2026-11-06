// Visible self-name editing -> protected HTTP -> fresh memory-only PGlite.
// Invented memberships plus a service-created record/publication are setup;
// the name flow itself is UI-only. One revocation uses explicit fixture SQL.
// No real person, native/E database, shared browser, delivery or external access.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRoom, workspaceAccountAction, workspaceAccountButton } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), code = 'LOCAL_SELF_PROFILE_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const profileKeys = ['userId', 'role', 'displayName', 'revision', 'updatedAt'].sort();
const receiptKeys = ['operation', 'userId', 'childId', 'conversationId', 'appliedVersion', 'changed', 'replayed'].sort();
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/account-input.js',
  '/local-api/care-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css',
  '/local-api/goal-client.js', '/local-api/appointment-client.js', '/local-api/media-client.js', '/local-api/media-ui.js',
  '/local-api/media-viewer.js', '/local-api/operations-client.js', '/local-api/operations-ui.js', '/local-api/operations-recipient.js',
  '/local-api/operations-onboarding.js', '/local-api/operations-schedule.js', '/local-api/self-profile-client.js',
  '/local-api/self-profile-ui.js', '/src/context-fields.js', '/src/media-policy.js', '/src/record-fields.js',
  '/src/feedback-fields.js', '/src/profile-fields.js']);
const unchangedTables = ['cb_messages', 'cb_read_states', 'cb_message_text_revisions', 'cb_message_text_heads',
  'cb_message_reviews', 'cb_records', 'cb_record_revisions', 'cb_record_requests', 'cb_record_assessments',
  'cb_publications', 'cb_activity_feedback', 'cb_feedback_revisions', 'cb_feedback_reviews', 'cb_feedback_requests',
  'cb_child_family_plans', 'cb_child_profiles', 'cb_goals', 'cb_goal_revisions', 'cb_appointments',
  'cb_appointment_revisions', 'cb_participants', 'cb_audit_events', 'cb_auth_accounts'];

async function sources() {
  const names = ['tests/local-self-profile-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
    'tests/message-browser-policy.mjs', 'scripts/p0-study-policy.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations'])
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
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
async function fixture(sandbox) {
  const centerId = `self-other-${randomUUID()}`;
  await sandbox.database.transaction(async tx => {
    await tx.query('INSERT INTO cb_centers(id) VALUES ($1)', [centerId]);
    await tx.query(`INSERT INTO cb_memberships(center_id,user_id,role,active)
      VALUES ($1,$2,'guardian',true),($1,$3,'therapist',true),($1,$4,'center',true)`,
    [centerId, sandbox.ids.guardianId, sandbox.ids.therapistId, sandbox.ids.managerId]);
  });
  // Nonempty immutable clinical context is baseline data, not evidence that
  // this browser created a record. Only the actual self-name flow is under test.
  const { Records } = await import('../server/records.mjs');
  const records = new Records(sandbox.database), recordId = `self-record-${randomUUID()}`;
  const identity = { centerId: sandbox.ids.centerId, userId: sandbox.ids.therapistId };
  await records.save(identity, { conversationId: sandbox.ids.conversationId, recordId, clientId: randomUUID(), expectedRevision: 0,
    content: { date: '2026-10-01', goalId: sandbox.ids.goalId, title: '가상 표시 이름 보존 기록',
      performed: '가상 놀이 관찰', response: '가상 반응', nextPlan: '가상 다음 계획', summary: '가상 공개 요약',
      privateNote: '가상 내부 메모 — 표시 이름 변경으로 수정하지 않음',
      assessments: [{ tool: '가상 관찰', item: '횟수', value: 0, unit: '회', context: '가상 동일 조건' }] } });
  const preview = await records.preview(identity, { conversationId: sandbox.ids.conversationId, recordId });
  await records.publish(identity, { conversationId: sandbox.ids.conversationId, recordId, clientId: randomUUID(),
    expectedRevision: preview.recordRevision, expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds });
  return { centerId, recordId };
}

export async function runLocalSelfProfileBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) { const stat = await lstat(filename); assert(stat.isFile() && !stat.isSymbolicLink(), code); }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-self-profile-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Fresh synthetic memory-only PGlite and owned Chromium. No E/native storage, real people, external access, delivery or deployment.',
      'Names and comparison messages use visible UI. A nonempty synthetic record/publication is setup through existing Records services, not claimed as browser record-creation coverage. SQL only creates second-center memberships and revokes one membership.',
      'Actual responses are held/discarded for conflicts, commit loss and late delivery. No fake API success, identity, authority or version is injected.',
      'Current display names may change existing message labels; persisted author IDs and clinical contents must not change.',
      'Viewport, DOM and web-storage checks are not physical-device, human usability or secure memory erasure evidence.'] };
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
      const extra = await fixture(sandbox), { origin, ids } = sandbox, originUrl = new URL(origin);
      assert(originUrl.origin === origin && originUrl.protocol === 'http:' && originUrl.hostname === '127.0.0.1' && originUrl.port && !originUrl.username && !originUrl.password, code);
      const endpoint = center => `/api/local/centers/${center}/account/profile`;
      const roomPath = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const secrets = new Set(sandbox.credentials.map(item => item.password)); secretSets.add(secrets);
      const actors = [], operations = [], forbiddenWrites = [], managerClinical = [], readRequests = [];
      const result = { width, allRoleEntry: false, navigationUnchanged: false, minimalDto: false, savedName: false,
        senderPropagation: false, operationsPropagation: false, clearFallback: false, noOp: false, messageDraftPreserved: false, modalDoesNotReadIncoming: false,
        actualConflict: false, explicitKeep: false, explicitReplace: false, committedResponseLoss: false, exactRetry: false,
        centerScoped: false, lateCenterDiscarded: false, lateAccountDiscarded: false, revokedInputCleared: false,
        unchangedClinicalAndAuthorIds: false, noManagerClinicalAccess: false, noWebStorageOrSecrets: false,
        keyboardFocus: false, reachability: false, layout: false, cleanup: false };
      report.currentCheck = result;
      let stage = 0;
      const advance = name => { phase = `${width}:${name}`; console.log(JSON.stringify({ width, stage: ++stage })); };
      const snapshot = async tables => {
        const out = {}; for (const table of tables) out[table] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
        return out;
      };
      const profileState = () => snapshot(['cb_member_profiles', 'cb_profile_requests']);
      const gate = () => {
        const g = { entered: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers() };
        const release = () => g.release.resolve(); releases.add(release);
        return { ...g, finish: () => { release(); releases.delete(release); } };
      };
      const panel = who => who.page.getByTestId('self-profile');
      const messageRow = (who, messageId) => who.page.locator(`[data-testid="message-row"][data-message-id="${messageId}"]`);
      const input = who => panel(who).locator('[name="displayName"]');
      const action = (who, name) => panel(who).locator(`[data-self-profile-action="${name}"]`);
      const opener = who => who.page.locator(who.role === 'center' ? '[data-ops-action="self-profile"]' : '[data-action="self-profile"]');
      const submit = who => panel(who).getByRole('button', { name: '표시 이름 저장', exact: true });
      const checkSecrets = async who => {
        const value = await who.page.evaluate(() => ({ html: document.documentElement.outerHTML, text: document.body.innerText,
          inputs: [...document.querySelectorAll('input:not([type="password"]),textarea')].map(node => node.value),
          url: location.href, local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
        assert.equal(value.local, 0, code); assert.equal(value.session, 0, code); assert.equal(value.cookie, '', code);
        for (const secret of secrets) assert(![value.html, value.text, value.url, ...value.inputs].some(text => text.includes(secret)), code);
      };
      const capture = async (who, name) => {
        await who.page.bringToFront(); await checkSecrets(who);
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        if (await panel(who).isVisible()) assert.equal(await panel(who).evaluate(node => {
          const dialog = node.closest('dialog'); return node.scrollWidth <= node.clientWidth + 1 && (!dialog || dialog.scrollWidth <= dialog.clientWidth + 1);
        }), true, code);
        const filename = `${width}-${name}.png`;
        // Only invented .test accounts are visible. Do not mask content behind
        // the native dialog, or inject styles rejected by the real strict CSP.
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]')] });
        report.screenshots.push({ width, filename, syntheticOnly: true });
      };
      const actor = async label => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', isMobile: width <= 640,
          hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
        const who = { label, context, page: null, userId: null, role: null, fault: { nextGet: null, nextPost: null, loseNext: false, losses: 0, lost: null } }; actors.push(who);
        await context.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url()), method = request.method(), entryPhase = phase;
          const primaryRead = method === 'GET' && target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...target.searchParams].length === 1 && target.searchParams.get('conversationId') === ids.conversationId;
          const allowed = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:account\/profile|operations\/(?:children|members|appointments|conversations\/[A-Za-z0-9_-]+\/(?:profile|relationships))|inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|family-plan|read|goals(?:\/[A-Za-z0-9_-]+)?|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+)?)))$/.test(target.pathname);
          if (target.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(target.pathname) && ['GET', 'HEAD'].includes(method)) || allowed || primaryRead)) {
            note(report.unexpectedRequests, { width, label, phase: entryPhase, sameOrigin: target.origin === origin,
              method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' }); return route.abort().catch(() => {});
          }
          for (const secret of secrets) if ([target.href, request.headers().referer ?? ''].some(text => text.includes(secret))) {
            note(report.errors, { width, label, phase: entryPhase, type: 'secret-url' }); return route.abort().catch(() => {});
          }
          const selfProfile = target.pathname.endsWith('/account/profile');
          if (method === 'POST' && target.pathname.endsWith('/read')) readRequests.push({ label, phase: entryPhase });
          if (request.headers()['x-carebridge-account'] === ids.managerId && target.pathname.includes('/conversations/') && !target.pathname.includes('/operations/'))
            managerClinical.push({ label, phase: entryPhase });
          if (method === 'POST' && target.pathname.startsWith('/api/local/centers/') && !selfProfile &&
              !target.pathname.endsWith('/read') && !(target.pathname === roomPath + '/messages' && [':SOURCE_MESSAGE', ':MODAL_READ_GUARD'].some(suffix => phase.endsWith(suffix))))
            forbiddenWrites.push({ label, phase: entryPhase });
          if (!selfProfile) return route.continue().catch(() => {});
          const item = { label, method, pathname: target.pathname, body: method === 'POST' ? structuredClone(request.postDataJSON()) : null };
          operations.push(item);
          const heldGet = method === 'GET' ? who.fault.nextGet : null; if (heldGet) who.fault.nextGet = null;
          const heldPost = method === 'POST' ? who.fault.nextPost : null; if (heldPost) who.fault.nextPost = null;
          const lost = method === 'POST' && who.fault.loseNext; if (lost) who.fault.loseNext = false;
          const work = (async () => {
            let response;
            try {
              if (item.body) assert.deepEqual(Object.keys(item.body).sort(), ['clientId', 'displayName', 'expectedRevision'], code);
              if (heldPost) { heldPost.entered.resolve(); await heldPost.release.promise; }
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
              item.status = response.status(); item.response = await response.json();
              assert.equal(response.headers()['cache-control'], 'no-store', code);
              if (item.status === 200) {
                assert.deepEqual(Object.keys(item.response), [method === 'GET' ? 'profile' : 'receipt'], code);
                assert.deepEqual(Object.keys(item.response[method === 'GET' ? 'profile' : 'receipt']).sort(), method === 'GET' ? profileKeys : receiptKeys, code);
                if (method === 'POST') assert.equal(item.response.receipt.operation, 'member.save', code);
              } else { assert([400, 401, 404, 409, 503].includes(item.status), code); assert.deepEqual(Object.keys(item.response).sort(), ['error', 'message'], code); }
              for (const secret of secrets) assert(!JSON.stringify(item.response).includes(secret), code);
              if (heldGet) { heldGet.entered.resolve(); await heldGet.release.promise; }
              if (lost) { assert.equal(item.status, 200, code); who.fault.losses++; await route.abort('failed').catch(() => {}); return; }
              await route.fulfill({ response }).catch(() => {});
            } catch { note(report.errors, { width, label, phase: entryPhase, type: 'profile-response-contract' }); await route.abort().catch(() => {}); }
            finally { await response?.dispose().catch(() => {}); heldGet?.done.resolve(); heldPost?.done.resolve(); if (lost) who.fault.lost?.resolve(); }
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
      const login = async (who, role, existing = false) => {
        const credential = sandbox.credentials.find(item => item.role === role); assert(credential.email.endsWith('.test'), code);
        if (!existing) await who.page.goto(origin);
        await who.page.getByTestId('login-form').waitFor();
        await who.page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await who.page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === '/api/local/auth/login' && r.request().method() === 'POST'),
          who.page.getByRole('button', { name: '로그인', exact: true }).click()]);
        assert.equal(response.status(), 200, code); who.userId = (await response.json()).user.userId; who.role = role;
        await who.page.getByTestId(role === 'center' ? 'operations-children' : 'home').waitFor();
        const center = who.page.locator(role === 'center' ? '[data-ops-center]' : '#center');
        if (await center.count() && await center.inputValue() !== ids.centerId) await center.selectOption(ids.centerId);
        await opener(who).waitFor({ state: 'attached' }); await checkSecrets(who);
      };
      const open = async who => {
        await who.page.bringToFront();
        const button = await workspaceAccountButton(who.page, 'self-profile'); await reachable(button);
        await button.click(); await input(who).waitFor();
        await panel(who).getByRole('heading', { name: '내 표시 이름', exact: true }).waitFor();
      };
      const close = async (who, focus = false) => {
        await action(who, 'close').click(); await panel(who).waitFor({ state: 'hidden' });
        if (focus) assert.equal(await opener(who).evaluate(node => node === document.activeElement), true, code);
      };
      const write = async (who, value, { keyboard = false } = {}) => {
        await input(who).fill(value); await reachable(submit(who));
        const waiting = who.page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/account/profile') && r.request().method() === 'POST');
        if (keyboard) { await submit(who).focus(); await submit(who).press('Enter'); } else await submit(who).click();
        const response = await waiting; assert.equal(response.status(), 200, code);
        const receipt = (await response.json()).receipt; await panel(who).waitFor({ state: 'hidden' }); return receipt;
      };
      const getProfile = async (who, center = ids.centerId) => {
        const response = await who.context.request.get(origin + endpoint(center), { timeout: 15_000, maxRedirects: 0,
          headers: { 'X-Carebridge-Account': who.userId } });
        try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
      };
      const guardian = await actor('guardian'), therapist = await actor('therapist'), center = await actor('center'), peer = await actor('same-guardian');
      for (const [who, role] of [[guardian, 'guardian'], [therapist, 'therapist'], [center, 'center'], [peer, 'guardian']]) await login(who, role);
      advance('ALL_ROLE_ENTRY');
      for (const who of [guardian, therapist, center]) {
        const selector = who.role === 'center' ? 'button[data-ops-view]:visible' : 'button[data-view]:visible';
        assert.equal(await who.page.locator(selector).count(), who.role === 'center' ? 3 : 4, code);
        await open(who); await capture(who, `${who.role}-editor`); await close(who, true);
        assert.equal(await who.page.locator(selector).count(), who.role === 'center' ? 3 : 4, code);
      }
      result.allRoleEntry = result.navigationUnchanged = result.keyboardFocus = true;

      advance('SOURCE_MESSAGE');
      await workspaceRoom(guardian.page, ids.conversationId, { keyboard: true });
      await guardian.page.getByLabel('메시지', { exact: true }).fill(`가상 표시 이름 확인 소식 ${width}`);
      const [sent] = await Promise.all([guardian.page.waitForResponse(r => new URL(r.url()).pathname === roomPath + '/messages' && r.request().method() === 'POST'),
        guardian.page.locator('.composer button[type="submit"]').click()]);
      assert.equal(sent.status(), 201, code); const sourceMessage = (await sent.json()).message;
      await messageRow(guardian, sourceMessage.id).scrollIntoViewIfNeeded();
      await workspaceRoom(therapist.page, ids.conversationId); await messageRow(therapist, sourceMessage.id).waitFor();
      await messageRow(therapist, sourceMessage.id).scrollIntoViewIfNeeded();
      const readRows = () => sandbox.database.query('SELECT user_id,sequence FROM cb_read_states WHERE center_id=$1 AND conversation_id=$2 ORDER BY user_id', [ids.centerId, ids.conversationId]);
      // Await the real read POST/DB state; do not mistake initial render for persistence.
      const readDeadline = Date.now() + 15000;
      while (true) {
        const rows = (await readRows()).rows;
        if ([ids.guardianId, ids.therapistId].every(id => rows.some(row => row.user_id === id && Number(row.sequence) >= sourceMessage.sequence))) break;
        assert(Date.now() < readDeadline, code); await new Promise(resolve => setTimeout(resolve, 50));
      }
      advance('MODAL_READ_GUARD');
      await open(therapist);
      const readBeforeModal = (await readRows()).rows.find(row => row.user_id === ids.therapistId);
      const beforeModalReadRequests = readRequests.filter(item => item.label === therapist.label).length;
      await guardian.page.getByLabel('메시지', { exact: true }).fill(`가상 설정 중 새 소식 ${width}`);
      const [incomingResponse] = await Promise.all([guardian.page.waitForResponse(r => new URL(r.url()).pathname === roomPath + '/messages' && r.request().method() === 'POST'),
        guardian.page.locator('.composer button[type="submit"]').click()]);
      assert.equal(incomingResponse.status(), 201, code); const incoming = (await incomingResponse.json()).message;
      await messageRow(guardian, incoming.id).scrollIntoViewIfNeeded();
      await therapist.page.bringToFront();
      await therapist.page.waitForFunction(id => !!document.querySelector(`[data-testid="message-row"][data-message-id="${id}"]`), incoming.id);
      assert.equal(await panel(therapist).isVisible(), true, code);
      assert.deepEqual((await readRows()).rows.find(row => row.user_id === ids.therapistId), readBeforeModal, code);
      assert.equal(readRequests.filter(item => item.label === therapist.label).length, beforeModalReadRequests, code);
      await capture(therapist, 'modal-incoming-not-read'); await close(therapist);
      await messageRow(therapist, incoming.id).scrollIntoViewIfNeeded();
      const afterModalDeadline = Date.now() + 15000;
      while (true) {
        const rows = (await readRows()).rows;
        if ([ids.guardianId, ids.therapistId].every(id => rows.some(row => row.user_id === id && Number(row.sequence) >= incoming.sequence))) break;
        assert(Date.now() < afterModalDeadline, code); await new Promise(resolve => setTimeout(resolve, 50));
      }
      result.modalDoesNotReadIncoming = true;
      const unchanged = await snapshot(unchangedTables);
      assert(unchanged.cb_records.length > 0 && unchanged.cb_record_revisions.length > 0 && unchanged.cb_publications.length > 0 && unchanged.cb_participants.length > 0, code);
      const draftText = `가상 전송하지 않은 초안 ${width}`; await therapist.page.getByLabel('메시지', { exact: true }).fill(draftText);

      advance('SAVE_AND_PROPAGATE');
      const guardianName = `가상 <보호자> & ${width}`;
      await open(guardian); const saved = await write(guardian, guardianName, { keyboard: true }); assert.equal(saved.changed, true, code);
      await therapist.page.bringToFront(); await workspaceAccountAction(therapist.page, 'refresh');
      const author = messageRow(therapist, sourceMessage.id).locator('.author');
      await therapist.page.waitForFunction(({ id, name }) => document.querySelector(`[data-testid="message-row"][data-message-id="${id}"] .author`)?.textContent === name,
        { id: sourceMessage.id, name: guardianName });
      assert.equal(await author.textContent(), guardianName, code); assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).inputValue(), draftText, code);
      await capture(therapist, 'current-name-original-message'); result.savedName = result.senderPropagation = true;
      await center.page.bringToFront(); await center.page.locator(`[data-ops-relationships="${ids.conversationId}"]`).click();
      const relationship = center.page.getByTestId('operations-relationships-form'); await relationship.waitFor();
      assert((await relationship.locator(`input[name="guardian"][value="${ids.guardianId}"]`).locator('..').textContent()).includes(guardianName), code);
      await capture(center, 'center-member-current-name'); await center.page.locator('[data-ops-action="back"]').click();
      await center.page.getByTestId('operations-children').waitFor(); result.operationsPropagation = true;
      await open(therapist); await write(therapist, `가상 치료 이름 ${width}`);
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).inputValue(), draftText, code); result.messageDraftPreserved = true;
      await open(center); const centerReceipt = await write(center, `가상 센터 이름 ${width}`); assert.equal(centerReceipt.changed, true, code);

      advance('CLEAR_AND_NO_OP');
      await open(guardian); const cleared = await write(guardian, ''); assert.equal(cleared.changed, true, code);
      assert.equal((await getProfile(guardian)).body.profile.displayName, null, code);
      await therapist.page.bringToFront(); await workspaceAccountAction(therapist.page, 'refresh');
      await therapist.page.waitForFunction(id => document.querySelector(`[data-testid="message-row"][data-message-id="${id}"] .author`)?.textContent === '보호자', sourceMessage.id);
      await capture(therapist, 'cleared-name-role-fallback'); result.clearFallback = true;
      await open(guardian); const noop = await write(guardian, ''); assert.equal(noop.changed, false, code); assert.equal(noop.appliedVersion, cleared.appliedVersion, code); result.noOp = true;

      advance('REAL_CONFLICT_KEEP');
      await open(guardian); await open(peer);
      const keepName = `가상 보존할 입력 ${width}`, peerName = `가상 다른 창 이름 ${width}`;
      await input(guardian).fill(keepName); const firstGate = gate(); guardian.fault.nextPost = firstGate;
      const firstConflict = guardian.page.waitForResponse(r => new URL(r.url()).pathname === endpoint(ids.centerId) && r.request().method() === 'POST');
      await submit(guardian).click(); await bounded(firstGate.entered.promise, 15000);
      try { await write(peer, peerName); } finally { firstGate.finish(); }
      const conflictResponse = await firstConflict; assert.equal(conflictResponse.status(), 409, code); assert.equal((await conflictResponse.json()).error, 'PROFILE_CONFLICT', code);
      await panel(guardian).locator('[data-self-profile-conflict]').waitFor(); assert.equal(await input(guardian).inputValue(), keepName, code);
      assert.equal(await submit(guardian).isDisabled(), true, code); await action(guardian, 'refresh').click();
      await panel(guardian).locator('[data-self-profile-latest]').waitFor();
      assert.equal(await panel(guardian).locator('[data-self-profile-latest]').textContent(), `최신 이름: ${peerName}`, code);
      const beforeChoice = await profileState(); const postsBeforeChoice = operations.filter(item => item.method === 'POST').length;
      await action(guardian, 'keep').click(); assert.equal(await input(guardian).inputValue(), keepName, code);
      assert.deepEqual(await profileState(), beforeChoice, code); assert.equal(operations.filter(item => item.method === 'POST').length, postsBeforeChoice, code);
      await capture(guardian, 'conflict-keep-explicit-save'); await write(guardian, keepName); result.actualConflict = result.explicitKeep = true;

      advance('REAL_CONFLICT_REPLACE');
      await open(guardian); await open(peer); await input(guardian).fill(`가상 교체 전 입력 ${width}`);
      const replacementName = `가상 최신 선택 ${width}`, secondGate = gate(); guardian.fault.nextPost = secondGate;
      const secondConflict = guardian.page.waitForResponse(r => new URL(r.url()).pathname === endpoint(ids.centerId) && r.request().method() === 'POST');
      await submit(guardian).click(); await bounded(secondGate.entered.promise, 15000);
      try { await write(peer, replacementName); } finally { secondGate.finish(); }
      assert.equal((await secondConflict).status(), 409, code); await panel(guardian).locator('[data-self-profile-conflict]').waitFor();
      await action(guardian, 'refresh').click(); await panel(guardian).locator('[data-self-profile-latest]').waitFor();
      assert.equal(await panel(guardian).locator('[data-self-profile-latest]').textContent(), `최신 이름: ${replacementName}`, code);
      const beforeReplace = await profileState(); await action(guardian, 'replace').click();
      assert.equal(await input(guardian).inputValue(), replacementName, code); assert.deepEqual(await profileState(), beforeReplace, code);
      const replacement = await write(guardian, replacementName); assert.equal(replacement.changed, false, code); result.explicitReplace = true;

      advance('COMMITTED_RESPONSE_LOSS_EXACT_RETRY');
      await open(guardian); await input(guardian).fill(`가상 유실 후 확인 ${width}`);
      guardian.fault.loseNext = true; guardian.fault.lost = Promise.withResolvers(); await submit(guardian).click();
      await bounded(guardian.fault.lost.promise, 15000); await panel(guardian).locator('[data-self-profile-action="retry"]:not([disabled])').waitFor();
      assert.equal(guardian.fault.losses, 1, code); assert.equal(await input(guardian).getAttribute('readonly') !== null, true, code);
      assert.equal(await submit(guardian).count(), 0, code); await capture(guardian, 'unknown-frozen-retry');
      const lostOperation = operations.findLast(item => item.label === guardian.label && item.method === 'POST');
      const committedState = await profileState(); const priorPostCount = operations.filter(item => item.method === 'POST').length;
      await close(guardian); await open(guardian); assert.equal(operations.filter(item => item.method === 'POST').length, priorPostCount, code);
      const [retryResponse] = await Promise.all([guardian.page.waitForResponse(r => new URL(r.url()).pathname === endpoint(ids.centerId) && r.request().method() === 'POST'), action(guardian, 'retry').click()]);
      assert.equal(retryResponse.status(), 200, code); assert.equal((await retryResponse.json()).receipt.replayed, true, code); await panel(guardian).waitFor({ state: 'hidden' });
      const retried = operations.findLast(item => item.label === guardian.label && item.method === 'POST');
      assert.deepEqual(retried.body, lostOperation.body, code); assert.deepEqual(await profileState(), committedState, code);
      result.committedResponseLoss = result.exactRetry = true;

      advance('CENTER_SCOPE_AND_LATE_GET');
      const mainProfile = (await getProfile(guardian)).body.profile;
      await guardian.page.locator('#center').selectOption(extra.centerId); await opener(guardian).waitFor({ state: 'attached' });
      await open(guardian); assert.equal(await input(guardian).inputValue(), '', code); await write(guardian, `가상 별도센터 이름 ${width}`);
      assert.deepEqual((await getProfile(guardian)).body.profile, mainProfile, code);
      const otherProfile = (await getProfile(guardian, extra.centerId)).body.profile; assert.notEqual(otherProfile.displayName, mainProfile.displayName, code); result.centerScoped = true;
      const centerGate = gate(); guardian.fault.nextGet = centerGate;
      await workspaceAccountAction(guardian.page, 'self-profile'); await bounded(centerGate.entered.promise, 15000);
      if (await action(guardian, 'close').isVisible()) await action(guardian, 'close').click();
      await guardian.page.locator('#center').selectOption(ids.centerId);
      assert.equal(await guardian.page.locator('#center').inputValue(), ids.centerId, code);
      await guardian.page.getByTestId('inbox').locator(`[data-room-id="${ids.conversationId}"]`).waitFor();
      centerGate.finish(); await bounded(centerGate.done.promise, 15000);
      assert.equal(await panel(guardian).isVisible(), false, code); await open(guardian);
      assert.equal(await input(guardian).inputValue(), mainProfile.displayName, code); await close(guardian); result.lateCenterDiscarded = true;

      advance('CLINICAL_DATA_AND_IDENTITY_UNCHANGED');
      assert.deepEqual(await snapshot(unchangedTables), unchanged, code); assert.equal(forbiddenWrites.length, 0, code);
      assert.equal(managerClinical.length, 0, code); result.unchangedClinicalAndAuthorIds = result.noManagerClinicalAccess = true;
      assert(operations.some(item => item.method === 'GET' && item.status === 200) && operations.some(item => item.method === 'POST' && item.status === 200), code); result.minimalDto = true;

      advance('LATE_ACCOUNT_RESPONSE');
      const accountGate = gate(); guardian.fault.nextGet = accountGate;
      await guardian.page.bringToFront(); await workspaceAccountAction(guardian.page, 'self-profile'); await bounded(accountGate.entered.promise, 15000);
      // A second real page in the SAME browser context changes its server cookie.
      // The original expected-account binding must reject the late old projection.
      const accountPage = await guardian.context.newPage(); accountPage.setDefaultTimeout(15000);
      const switcher = { ...guardian, label: 'account-switch', page: accountPage }; pages.set(switcher.label, accountPage);
      await accountPage.goto(origin); await accountPage.getByTestId('home').waitFor();
      await workspaceAccountAction(accountPage, 'logout'); await accountPage.getByTestId('login-form').waitFor(); await login(switcher, 'therapist', true);
      accountGate.finish(); await bounded(accountGate.done.promise, 15000); await guardian.page.bringToFront();
      await guardian.page.getByTestId('login-form').waitFor(); assert.equal(await panel(guardian).isVisible(), false, code);
      assert.equal(await guardian.page.locator('[name="displayName"]').count(), 0, code); result.lateAccountDiscarded = true;
      await accountPage.close(); pages.delete(switcher.label);

      advance('MEMBERSHIP_REVOKED_INPUT_DISPOSAL');
      await peer.page.bringToFront(); await open(peer); const revokedInput = `가상 권한 종료 입력 ${width}`; await input(peer).fill(revokedInput);
      await sandbox.database.query('UPDATE cb_memberships SET active=false WHERE center_id=$1 AND user_id=$2', [ids.centerId, ids.guardianId]);
      await peer.page.waitForFunction(value => !document.querySelector('[data-testid="self-profile"]')?.checkVisibility() &&
        ![...document.querySelectorAll('input,textarea')].some(node => node.value === value), revokedInput, { timeout: 15000 });
      assert.equal((await getProfile(peer)).status, 404, code); await capture(peer, 'membership-revoked-input-cleared'); result.revokedInputCleared = true;
      for (const who of actors) await checkSecrets(who); result.noWebStorageOrSecrets = result.reachability = result.layout = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      for (const who of actors) await who.context.close(); pages.clear();
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code);
      sandboxes.delete(sandbox); owned.closed = true; ownedSandboxes.delete(sandbox); assert.equal(ownedSandboxes.size, 0, code);
      secrets.clear(); secretSets.delete(secrets); operations.length = 0; await save('ownership.json', ownership);
      result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: Object.values(result).filter(value => value === true).length }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-self-profile-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      strictLocator: /strict mode violation/i.test(error?.message ?? '') };
    if (error?.reachability) report.failure.reachability = error.reachability;
    for (const [label, page] of [...pages].slice(-2)) try {
      const sensitive = await page.evaluate(values => {
        const text = [document.documentElement.outerHTML, document.body.innerText, location.href,
          ...[...document.querySelectorAll('input:not([type="password"]),textarea')].map(node => node.value)].join('\n');
        return values.some(value => text.includes(value));
      }, [...secretSets].flatMap(values => [...values]));
      if (sensitive) { note(report.errors, { phase, type: 'failure-sensitive-screenshot-suppressed' }); continue; }
      const filename = `failure-${label}.png`; await page.screenshot({ path: path.join(folder, filename), fullPage: false,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]')] });
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
  } finally {
    for (const release of releases) release(); releases.clear();
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
  try { if (!await runLocalSelfProfileBrowser()) process.exitCode = 1; }
  catch { console.error(code); process.exitCode = 1; }
}
