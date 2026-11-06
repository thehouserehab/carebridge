// Explicit native-PC preverification of the approved synthetic Wi-Fi service.
// No browser/physical-phone claim, firewall lease, UAC, certificate export,
// system trust change, direct SQL mutation, or TLS-verification bypass.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { syntheticWifiCliOptions } from '../scripts/synthetic-wifi-api.mjs';
import { generateSyntheticWifiCertificate } from '../server/synthetic-wifi-certificate.mjs';
import { createWindowsSyntheticWifiSession } from '../server/windows-synthetic-wifi-session.mjs';
import { wifiOrigin } from '../server/synthetic-wifi-network.mjs';

const runId = randomUUID();
const report = {
  schema: 1, runId, mode: 'synthetic-wifi-native-preverification', passed: false,
  startedAt: new Date().toISOString(), phase: 'CONFIGURATION', failure: null,
  checks: { tlsIdentity: false, preparedScreen: false, unauthenticatedRejected: false,
    twoRoleLogin: false, secureCookies: false, messageDelivered: false, idempotentRetry: false,
    oldApiTerminated: false, stableOrigin: false, blankCookieRejectedAfterRestart: false,
    oldCookieRejectedAfterRestart: false, freshLoginAfterRestart: false, messagePersisted: false },
  cleanup: null,
  limitations: ['Synthetic data and native PC HTTPS requests only; no browser or physical-phone verification.',
    'No firewall, OS trust, UAC, certificate export, or public internet setup performed.',
    'Fresh ephemeral session with API-only restart; not full-session or power-loss recovery.'],
};
const failure = () => new Error('SYNTHETIC_WIFI_NATIVE_CHECK_FAILED');
const requests = new Set(), actors = [];
let material, session, options, credentials = [], cancelled = false;
const checkpoint = () => { if (cancelled) throw failure(); };
const terminalApi = state => state?.terminal === true && state.stopped === true && state.stopRequested === true &&
  state.closeObserved === true && state.stdioClosed === true && state.exitCode === 0 && state.signalCode === null &&
  state.failureCode === null && state.spawnFailed === false && state.observationTimedOut === false;
const terminalWorker = state => state?.terminal === true && state.stopRequested === true && state.stopAccepted === true &&
  state.drainReported === true && state.closeObserved === true && state.stdioClosed === true && state.exitCode === 0 &&
  state.signalCode === null && state.failureCode === null && state.spawnFailed === false && state.observationTimedOut === false;

function stop() {
  cancelled = true;
  for (const pending of requests) pending.destroy(failure());
  // Request owned shutdown immediately, but the outer finally still awaits
  // the same actual drain/exit/secret-cleanup result. Never force process exit.
  void session?.close().catch(() => {});
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);

function call(origin, path, { method = 'GET', body, actor, json = true } = {}) {
  checkpoint();
  wifiOrigin(origin, options.network);
  assert(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//'));
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (payload && payload.length > 16384) { payload.fill(0); throw failure(); }
  return new Promise((resolveResponse, reject) => {
    const chunks = []; let size = 0, settled = false, response, requestHandle, timer;
    const complete = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      for (const chunk of chunks) chunk.fill(0); chunks.length = 0;
      // end's callback also erases this buffer after the write is flushed.
      // On failure, destroy the owned request before releasing its contents.
      if (error) { response?.destroy(); requestHandle?.destroy(); payload?.fill(0); reject(failure()); }
      else resolveResponse(value);
      requests.delete(requestHandle);
    };
    try {
      requestHandle = request({ hostname: options.network.host, localAddress: options.network.host,
        port: options.network.port, path, method, agent: false, servername: '',
        ca: material.ca, rejectUnauthorized: true, checkServerIdentity, minVersion: 'TLSv1.2',
        headers: { Origin: origin, 'X-Carebridge-Request': '1', Connection: 'close',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(actor ? { Cookie: actor.cookie, 'X-Carebridge-Account': actor.userId } : {}) },
      }, incoming => {
        response = incoming;
        try {
          assert.equal(incoming.socket.authorized, true);
          assert(['TLSv1.2', 'TLSv1.3'].includes(incoming.socket.getProtocol()));
          assert.equal(incoming.socket.localAddress, options.network.host);
          assert.equal(incoming.socket.getPeerX509Certificate().checkIP(options.network.host), options.network.host);
        } catch { complete(failure()); return; }
        incoming.on('data', chunk => {
          size += chunk.length;
          if (settled || size > 2 * 1024 * 1024) { chunk.fill(0); complete(failure()); }
          else chunks.push(chunk);
        });
        incoming.on('aborted', () => complete(failure())); incoming.on('error', () => complete(failure()));
        incoming.on('end', () => {
          let bytes;
          try {
            if (!incoming.complete) throw failure();
            bytes = Buffer.concat(chunks);
            const result = { status: incoming.statusCode, headers: incoming.headers,
              body: json ? JSON.parse(bytes.toString('utf8')) : null, bytes: bytes.length };
            if (!json) assert(/<html[\s>]/i.test(bytes.toString('utf8')));
            complete(undefined, result);
          } catch { complete(failure()); }
          finally { bytes?.fill(0); }
        });
      });
      requests.add(requestHandle);
      requestHandle.on('error', () => complete(failure()));
      requestHandle.setTimeout(10000, () => complete(failure()));
      timer = setTimeout(() => complete(failure()), 15000);
      requestHandle.end(payload, error => { payload?.fill(0); if (error) complete(failure()); });
    } catch { complete(failure()); }
  });
}

function unauthorized(result) {
  assert.equal(result.status, 401); assert.equal(result.body?.error, 'AUTH_REQUIRED');
  assert.equal(result.headers['set-cookie'], undefined);
}
async function login(origin, role, centerId) {
  const credential = credentials.find(value => value.role === role);
  assert(credential && typeof credential.password === 'string' && credential.password.length > 0);
  const result = await call(origin, '/api/local/auth/login', {
    method: 'POST', body: { email: credential.email, password: credential.password },
  });
  assert.equal(result.status, 200);
  const user = result.body?.user;
  assert(typeof user?.userId === 'string' && user.userId === credential.userId);
  assert(user.centers.some(value => value.id === centerId && value.role === role));
  const cookies = result.headers['set-cookie'];
  assert(Array.isArray(cookies) && cookies.length === 1);
  const parts = cookies[0].split(';').map(value => value.trim());
  assert(parts.includes('Secure') && parts.includes('HttpOnly') && parts.includes('SameSite=Strict'));
  assert(parts.includes('Path=/api/local/') && !parts.some(value => /^Domain=/i.test(value)));
  assert(/^cb_local_[a-f0-9]{32}=[A-Za-z0-9_-]+$/.test(parts[0]));
  // No account identity is guessed from the role: subsequent requests use the
  // identity returned by this actual authenticated login response.
  const actor = { cookie: parts[0], userId: user.userId }; actors.push(actor);
  const current = await call(origin, '/api/local/auth/session', { actor });
  assert.equal(current.status, 200); assert.equal(current.body?.user?.userId, actor.userId);
  return actor;
}
async function expectMessage(origin, path, actor, id, body) {
  const result = await call(origin, path, { actor });
  assert.equal(result.status, 200);
  assert.equal(result.body?.message?.id, id); assert.equal(result.body?.message?.body, body);
}

try {
  options = syntheticWifiCliOptions(process.argv.slice(2)); checkpoint();
  report.phase = 'CERTIFICATE';
  material = await generateSyntheticWifiCertificate({ host: options.network.host, powershell: options.powershell }); checkpoint();
  report.phase = 'SESSION_READY';
  session = createWindowsSyntheticWifiSession({ postgresArgs: options.postgresArgs, network: options.network,
    cert: material.cert, key: material.key });
  material.key.fill(0); // The session owns its separate restart-lifetime copy.
  const ready = await session.ready; checkpoint(); assert.equal(session.status().ready, true);
  const origin = wifiOrigin(ready.origin, options.network), seed = session.seed, room = seed.rooms[0];
  credentials = session.credentials.map(value => ({ ...value }));
  session.forgetCredentials(); assert.equal(session.credentials.length, 0);
  assert.equal(credentials.length, 2);
  assert(['guardian', 'therapist'].every(role => credentials.filter(value => value.role === role).length === 1));
  const base = `/api/local/centers/${seed.centerId}/conversations/${room.conversationId}/messages`;

  report.phase = 'HTTPS_AND_LOGIN';
  const screen = await call(origin, '/', { json: false }); assert.equal(screen.status, 200); assert(screen.bytes > 0);
  report.checks.tlsIdentity = true; report.checks.preparedScreen = true;
  unauthorized(await call(origin, '/api/local/auth/session')); report.checks.unauthenticatedRejected = true;
  const therapist = await login(origin, 'therapist', seed.centerId), guardian = await login(origin, 'guardian', seed.centerId);
  report.checks.twoRoleLogin = true; report.checks.secureCookies = true;

  report.phase = 'MESSAGE_DELIVERY';
  const outgoing = { clientId: randomUUID(), body: '가상 Wi-Fi 네이티브 연결 검증 메시지입니다.' };
  const created = await call(origin, base, { method: 'POST', body: outgoing, actor: therapist });
  assert.equal(created.status, 201);
  const id = created.body?.message?.id; assert(typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id));
  assert.equal(created.body.message.body, outgoing.body);
  await expectMessage(origin, `${base}/${id}`, guardian, id, outgoing.body); report.checks.messageDelivered = true;
  const replay = await call(origin, base, { method: 'POST', body: outgoing, actor: therapist });
  assert.equal(replay.status, 201); assert.equal(replay.body?.message?.id, id); assert.equal(replay.body.message.body, outgoing.body);
  report.checks.idempotentRetry = true;

  report.phase = 'API_RESTART'; checkpoint(); assert.equal(session.status().apiGeneration, 1);
  const next = await session.restartApi(); checkpoint();
  assert.equal(next.apiGeneration, 2); assert.equal(session.status().apiGeneration, 2); assert.equal(session.status().ready, true);
  const retired = session.status().apiRestarts;
  assert.equal(retired.length, 1); assert.equal(retired[0].generation, 1); assert(terminalApi(retired[0].status));
  report.checks.oldApiTerminated = true;
  assert.equal(next.origin, origin); report.checks.stableOrigin = true;
  unauthorized(await call(origin, '/api/local/auth/session')); report.checks.blankCookieRejectedAfterRestart = true;
  for (const actor of [therapist, guardian]) unauthorized(await call(origin, '/api/local/auth/session', { actor }));
  report.checks.oldCookieRejectedAfterRestart = true;

  report.phase = 'RELOGIN_AND_PERSISTENCE';
  const freshGuardian = await login(origin, 'guardian', seed.centerId); report.checks.freshLoginAfterRestart = true;
  await expectMessage(origin, `${base}/${id}`, freshGuardian, id, outgoing.body); report.checks.messagePersisted = true;
  report.phase = 'CLEANUP';
} catch {
  report.failure = { phase: report.phase, code: 'SYNTHETIC_WIFI_NATIVE_CHECK_FAILED' };
} finally {
  for (const credential of credentials) for (const key of Object.keys(credential)) credential[key] = '';
  credentials.length = 0;
  for (const actor of actors) { actor.cookie = ''; actor.userId = ''; } actors.length = 0;
  material?.key.fill(0);
  for (const pending of requests) pending.destroy(failure());
  try { session?.forgetCredentials(); await session?.close(); }
  catch { report.failure ??= { phase: 'CLEANUP', code: 'SYNTHETIC_WIFI_NATIVE_CLEANUP_UNCONFIRMED' }; }
  const state = session?.status();
  report.cleanup = { sessionCreated: Boolean(session), stopped: state?.phase === 'stopped',
    failed: state?.failed === true, apiTerminated: terminalApi(state?.api), workerTerminated: terminalWorker(state?.worker),
    secretsDisposed: state?.storage?.secretsDisposed === true, originalKeyCleared: material ? material.key.every(byte => byte === 0) : true };
  const clean = report.cleanup.stopped && !report.cleanup.failed && report.cleanup.apiTerminated &&
    report.cleanup.workerTerminated && report.cleanup.secretsDisposed && report.cleanup.originalKeyCleared;
  if (!clean) report.failure ??= { phase: 'CLEANUP', code: 'SYNTHETIC_WIFI_NATIVE_CLEANUP_UNCONFIRMED' };
  report.finishedAt = new Date().toISOString();
  report.passed = !report.failure && !cancelled && clean && Object.values(report.checks).every(value => value === true);
  let reportSaved = false;
  try {
    await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
    await writeFile(new URL(`../test-results/synthetic-wifi-native-${runId}.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    reportSaved = true;
  } catch { report.passed = false; report.failure ??= { phase: 'REPORT', code: 'SYNTHETIC_WIFI_NATIVE_REPORT_UNAVAILABLE' }; }
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  // One redacted JSON line only. Neither raw errors nor nested runtime status,
  // paths, actual IPs, accounts, messages, cookies or certificates are emitted.
  process.stdout.write(JSON.stringify({ runId, passed: report.passed, failure: report.failure, cleanup: report.cleanup, reportSaved }) + '\n');
  if (!report.passed) process.exitCode = 1;
}
