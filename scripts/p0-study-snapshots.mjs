import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { BASELINE_COMMIT, PUBLIC_ASSET, sha256, studyChildEnvironment } from './p0-study-policy.mjs';

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function publicSnapshot(entries, label) {
  const files = new Map();
  for (const [name, bytes] of entries) {
    if (!PUBLIC_ASSET.test(name) || files.has(name) || !Buffer.isBuffer(bytes) || bytes.length > 2_000_000)
      throw new Error('Invalid, duplicate or oversized public asset');
    files.set(name, Buffer.from(bytes));
  }
  for (const name of ['index.html', 'favicon.svg', 'src/app.js', 'src/seed.js', 'src/config.js'])
    if (!files.has(name)) throw new Error(`Missing public asset: ${name}`);
  const assets = [...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, bytes]) =>
    Object.freeze({ name, bytes: bytes.length, sha256: sha256(bytes) }));
  const manifest = Object.freeze({ label, sha256: sha256(JSON.stringify(assets)), assets: Object.freeze(assets) });
  return Object.freeze({ manifest, read(name) { const bytes = files.get(name); return bytes ? Buffer.from(bytes) : null; } });
}

export async function captureWorkingSnapshot(root) {
  const currentNames = ['index.html', 'favicon.svg', ...(await readdir(path.join(root, 'src')))
    .map((name) => `src/${name}`).filter((name) => PUBLIC_ASSET.test(name))];
  const canonicalRoot = await realpath(root), entries = [];
  for (const name of currentNames) {
    const file = path.join(root, name), stat = await lstat(file), resolved = await realpath(file);
    const relative = path.relative(canonicalRoot, resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Public source must be a regular file inside the repository');
    entries.push([name, await readFile(file)]);
  }
  return publicSnapshot(entries, 'captured-working-source');
}

export async function captureStudyVersions(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, windowsHide: true,
    env: studyChildEnvironment(), maxBuffer: 2_000_000, timeout: 30_000 });
  const names = git(['ls-tree', '-r', '--name-only', BASELINE_COMMIT]).toString('utf8').trim().split('\n').filter((name) => PUBLIC_ASSET.test(name));
  const baseline = publicSnapshot(names.map((name) => [name, git(['show', `${BASELINE_COMMIT}:${name}`])]), BASELINE_COMMIT);
  const revised = await captureWorkingSnapshot(root);
  const normalSeed = (snapshot) => snapshot.read('src/seed.js').toString('utf8').replaceAll('\r\n', '\n');
  if (normalSeed(baseline) !== normalSeed(revised)) throw new Error('Baseline/revised synthetic seed differs; prepare a reviewed equivalent fixture first');
  return Object.freeze({ baseline, revised });
}

// Read-only public assets, not the product dev/API server. No runtime filesystem
// reads, DB imports, .env loading, SPA fallback or directory route.
export async function serveStudySnapshot(snapshot) {
  let origin;
  const server = createServer((req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const reject = (code) => { res.writeHead(code); res.end(); };
    if (req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return reject(403);
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); return reject(405); }
    const name = req.url === '/' ? 'index.html' : req.url?.slice(1);
    if (!name || !PUBLIC_ASSET.test(name)) return reject(404);
    const bytes = snapshot.read(name);
    if (!bytes) return reject(404);
    res.writeHead(200, { 'Content-Type': mime[path.extname(name)], 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return Object.freeze({ origin, close: () => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
  }) });
}
