// Explicit synthetic E-drive IO probe; never adopts, copies or removes beta data.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { PrivateFileStore } from "../server/private-file-store.mjs";

const args = process.argv.slice(2);
assert.equal(process.platform, "win32", "This explicit beta probe is for the Windows E drive");
assert.equal(args.length, 3, "Use --base E:\\CarebridgeBeta --confirm-synthetic-e-drive");
assert.equal(args[0], "--base");
assert.equal(args[2], "--confirm-synthetic-e-drive");
assert.ok(isAbsolute(args[1]) && /^e:[\\/]/i.test(args[1]), "An explicit E-drive directory is required");
const base = resolve(args[1]);
assert.notEqual(base, parse(base).root, "Never use a drive root as a storage directory");
const runId = randomUUID();
const root = join(base, "checks", `storage-check-${runId}`);
const store = new PrivateFileStore(root);
const key = randomUUID(), badKey = randomUUID();
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64");
const manifest = { type: "image/png", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const checks = [];
let created = false, failure = null, cleanup = false;
const folder = fileURLToPath(new URL("../test-results/", import.meta.url));
try {
  // checkRoot rejects junctions/symlinks along the entire ancestor chain.
  // Require a fresh UUID directory; never adopt an existing test or user root.
  await assert.rejects(lstat(root), { code: "ENOENT" });
  await store.checkRoot();
  created = true;
  assert.deepEqual(await readdir(root), []);
  await store.write(key, Readable.from([bytes]), manifest);
  checks.push("E-drive synthetic PNG write with full byte/hash validation");

  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { PrivateFileStore } from ${JSON.stringify(new URL("../server/private-file-store.mjs", import.meta.url).href)};
    const [root, key, type, size, sha256] = process.argv.slice(1);
    const store = new PrivateFileStore(root);
    const handle = await store.openVerified(key, { type, size: Number(size), sha256 });
    try { const data = await handle.readFile(); if (data.length !== Number(size)) throw new Error('Invalid synthetic object'); }
    finally { await handle.close(); }
    process.stdout.write('BETA_STORAGE_READ_OK');
  `, root, key, manifest.type, String(manifest.size), manifest.sha256], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
    // Do not pass application credentials or a DB endpoint to this probe.
    env: Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
      .filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
  });
  assert.equal(child.error, undefined, "Independent reader must finish");
  assert.equal(child.status, 0, "Independent reader must verify the stored object");
  assert.equal(child.stdout, "BETA_STORAGE_READ_OK");
  checks.push("Fresh Node process verifies the E-drive object, not an in-memory copy");

  await assert.rejects(store.write(key, Readable.from([bytes]), manifest), { code: "EEXIST" });
  assert.deepEqual(await readFile(join(root, `${key}.blob`)), bytes);
  checks.push("Exclusive write refuses overwrite and preserves the original bytes");

  await assert.rejects(store.write(badKey, Readable.from([bytes]), { ...manifest, sha256: "0".repeat(64) }), { code: "HASH_MISMATCH" });
  await assert.rejects(lstat(join(root, `${badKey}.blob`)), { code: "ENOENT" });
  checks.push("Failed synthetic hash verification leaves no partial object");

  await store.remove(key);
  await assert.rejects(lstat(join(root, `${key}.blob`)), { code: "ENOENT" });
  assert.ok((await lstat(join(root, `${key}.blocked`))).isFile());
  await assert.rejects(store.openVerified(key, manifest), { code: "CONTENT_UNAVAILABLE" });
  await assert.rejects(store.write(key, Readable.from([bytes]), manifest), { code: "STORAGE_UNAVAILABLE" });
  checks.push("Deletion fence blocks both reads and resurrection of the removed synthetic object");
} catch (error) {
  failure = { code: error.code || "PROBE_FAILED" };
  console.error("Synthetic beta storage probe failed; no existing beta files were adopted.");
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      const expectedRoot = join(base, "checks", `storage-check-${runId}`);
      assert.equal(resolve(root), resolve(expectedRoot));
      assert.ok(!(await lstat(root)).isSymbolicLink());
      const ownedNames = new Set([`${key}.blob`, `${key}.blocked`, `${badKey}.blob`]);
      const names = await readdir(root);
      for (const name of names) {
        assert.ok(ownedNames.has(name), "Unexpected file: leave the probe directory intact");
        const info = await lstat(join(root, name));
        assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
      }
      // No recursive deletion; only the exact objects of this fresh UUID run.
      for (const name of names) await unlink(join(root, name));
      await rmdir(root);
      cleanup = true;
    } catch {
      failure ??= { code: "PROBE_CLEANUP_UNCONFIRMED" };
      process.exitCode = 1;
    }
  }
  await mkdir(folder, { recursive: true });
  const result = { runId, at: new Date().toISOString(), passed: !failure && cleanup && checks.length === 5,
    base, checks, cleanup, failure,
    limitations: ["Synthetic byte IO only; no production ACL, encryption or power-loss durability proof",
      "No PostgreSQL relocation, browser-data migration, API/server connection or cross-device access",
      "Copies on E are not backups in an independent failure domain"],
  };
  await writeFile(join(folder, "beta-storage-results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
