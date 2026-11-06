// Run the actual local-api controller/render tests under isolated device clocks.
// No browser, server, database, account credentials or system settings are used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const timeZone of ['Asia/Seoul', 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
  test(`local-api Seoul calendar remains consistent on a ${timeZone} device`, () => {
    const env = { TZ: timeZone };
    for (const name of ['SystemRoot', 'WINDIR'])
      if (typeof process.env[name] === 'string') env[name] = process.env[name];
    const result = spawnSync(process.execPath, ['--test',
      '--test-name-pattern=Seoul calendar|reuse exact-reads',
      'tests/local-care-ui.test.mjs', 'tests/local-product-ui.test.mjs',
      'tests/local-chat-layout.test.mjs', 'tests/local-record-template.test.mjs'],
    { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 512 * 1024 });
    assert.equal(result.error, undefined, 'Isolated clock tests must finish within their deadline.');
    assert.equal(result.signal, null, 'Isolated clock tests must exit normally.');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const name of ['Seoul calendar defaults reach the record form',
      'Seoul calendar defaults reach the feedback form', 'Seoul calendar chat timestamps',
      'Seoul calendar time formatting', 'reuse exact-reads'])
      assert(result.stdout.includes(name), `The isolated run must actually select: ${name}`);
  });
}
