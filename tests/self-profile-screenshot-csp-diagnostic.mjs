// One isolated screenshot-tool diagnostic, not a third self-profile flow run.
// Reuses the actual pure renderer and exact listener CSP; no auth or database.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selfProfileMarkup, SelfProfileDraft } from '../local-api/self-profile-ui.js';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), failureCode = 'SELF_PROFILE_CSP_DIAGNOSTIC_FAILED';
const names = ['tests/self-profile-screenshot-csp-diagnostic.mjs', 'tests/message-browser-policy.mjs',
  'scripts/p0-study-policy.mjs', 'server/local-api-listener.mjs', 'local-api/self-profile-ui.js',
  'local-api/self-profile-client.js', 'local-api/client.js', 'local-api/account-input.js',
  'src/profile-fields.js', 'local-api/styles.css'];
const hash = value => createHash('sha256').update(value).digest('hex');
async function fingerprint() {
  const files = await Promise.all(names.map(async name => ({ name, sha256: hash(await readFile(path.join(root, name))) })));
  return { sha256: hash(JSON.stringify(files)), files };
}
async function observe(work, ms = 30_000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(failureCode)), ms); })]); }
  finally { clearTimeout(timer); }
}
function lifetime(child) {
  const done = Promise.withResolvers(), streams = [...new Set((child.stdio ?? []).filter(Boolean))];
  let exit = false, close = false;
  const terminal = () => exit && close && streams.every(stream => stream.closed === true);
  const update = () => { if (terminal()) done.resolve(); };
  child.once('exit', () => { exit = true; update(); }); child.once('close', () => { close = true; update(); });
  for (const stream of streams) stream.once('close', update);
  return { terminal, done: done.promise };
}

export async function run(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args), source = await fingerprint();
  const listenerSource = await readFile(path.join(root, 'server/local-api-listener.mjs'), 'utf8');
  const csp = listenerSource.match(/^const CSP = "([^"\r\n]+)";/m)?.[1];
  assert(csp && /(?:^|; )style-src 'self'(?:;|$)/.test(csp), failureCode);
  const css = await readFile(path.join(root, 'local-api/styles.css'));
  const draft = new SelfProfileDraft({ userId: 'synthetic-user', role: 'guardian', displayName: '가상 표시 이름', revision: 1 });
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head>
    <body><header class="workspace-head"><p class="account">synthetic@carebridge.test</p></header>
    <dialog id="self-profile-dialog">${selfProfileMarkup(draft, { role: 'guardian' })}</dialog></body></html>`;
  const runId = randomUUID(), folder = path.join(root, 'test-results', `self-profile-csp-${runId}`); await mkdir(folder);
  const report = { runId, source, passed: false, failure: null, observations: [], unexpectedRequests: 0,
    cspMatchesActualListener: true, actualRenderer: true, databaseUsed: false, authenticated: false,
    cleanupObservationTimedOut: false, cleanup: { contextClosed: false, browserStopped: false, serverClosed: false } };
  const owner = { runId, nodePid: process.pid, browserPid: null, finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  let server, browserServer, browser, context, life, stage = 'startup'; const sockets = new Set();
  await save('ownership.json', owner);
  try {
    server = createServer((req, res) => {
      res.setHeader('Content-Security-Policy', csp); res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.method !== 'GET' || !['/', '/styles.css'].includes(req.url)) { report.unexpectedRequests++; res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', req.url === '/' ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8');
      res.end(req.url === '/' ? html : css);
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = await import(pathToFileURL(options.module).href);
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    life = lifetime(browserServer.process()); owner.browserPid = browserServer.process().pid; await save('ownership.json', owner);
    browser = await chromium.connect(browserServer.wsEndpoint());
    context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin && ['/', '/styles.css'].includes(url.pathname) && !url.search) return route.continue();
      report.unexpectedRequests++; return route.abort();
    });
    const page = await context.newPage();
    page.on('console', entry => {
      if (entry.type() !== 'error') return;
      const message = entry.text();
      if (report.observations.length < 16) report.observations.push({ stage, consoleError: true,
        cspStyleBlocked: /Content Security Policy/i.test(message) && /inline style|style-src/i.test(message) });
    });
    page.on('pageerror', () => { if (report.observations.length < 16) report.observations.push({ stage, pageError: true }); });
    await page.goto(origin); await page.evaluate(() => document.querySelector('dialog').showModal());
    await page.getByTestId('self-profile').waitFor();
    stage = 'without-style'; await page.screenshot({ path: path.join(folder, 'without-style.png'), fullPage: false });
    await page.evaluate(() => document.documentElement.clientWidth);
    const baseline = report.observations.length; assert.equal(baseline, 0, failureCode);
    stage = 'with-style'; await page.screenshot({ path: path.join(folder, 'with-style.png'), fullPage: false,
      style: '.workspace-head .account { visibility: hidden !important; }' });
    await page.evaluate(() => document.documentElement.clientWidth);
    report.withoutStyleErrors = baseline; report.withStyleErrors = report.observations.length - baseline;
    assert.equal(report.withStyleErrors, 1, failureCode);
    assert(report.observations.every(item => item.stage === 'with-style' && item.cspStyleBlocked === true && !item.pageError), failureCode);
    assert.equal(report.unexpectedRequests, 0, failureCode);
    report.finalSource = await fingerprint(); assert.equal(report.finalSource.sha256, source.sha256, failureCode);
  } catch { report.failure = { code: failureCode, stage }; }
  finally {
    try { if (context) await observe(context.close()); report.cleanup.contextClosed = true; }
    catch { report.cleanupObservationTimedOut = true; }
    if (browserServer) {
      try { await observe(browser?.close()); await observe(browserServer.close()); await observe(life.done); }
      catch { report.cleanupObservationTimedOut = true; try { await observe(browserServer.kill()); await observe(life.done); } catch {} }
      report.cleanup.browserStopped = life?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    if (server) try {
      const socketsClosed = [...sockets].map(socket => socket.closed ? Promise.resolve()
        : new Promise(resolve => socket.once('close', resolve)));
      const serverClosed = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve()); for (const socket of sockets) socket.destroy();
      });
      await observe(Promise.all([serverClosed, ...socketsClosed])); report.cleanup.serverClosed = sockets.size === 0 && !server.listening;
    } catch { report.cleanupObservationTimedOut = true; }
    else report.cleanup.serverClosed = true;
    report.passed = !report.failure && !report.cleanupObservationTimedOut && Object.values(report.cleanup).every(Boolean);
    owner.finished = Object.values(report.cleanup).every(Boolean); owner.cleanup = report.cleanup;
    await save('ownership.json', owner); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, failure: report.failure, withoutStyleErrors: report.withoutStyleErrors,
    withStyleErrors: report.withStyleErrors, observations: report.observations, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await run()) process.exitCode = 1; } catch { console.error(failureCode); process.exitCode = 1; }
}
