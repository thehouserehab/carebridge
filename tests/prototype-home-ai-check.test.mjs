import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPrototypeHomeAi } from '../scripts/lib/prototype-home-ai-check.mjs';

test('home AI live checker rejects unknown, fixture, and external sessions before reading credentials or data', async () => {
  const forbidden = () => assert.fail('No credentials or database access before scope validation');
  for (const sandbox of [null, {}, { mode: 'synthetic-prototype', aiMode: 'fixture' },
    { mode: 'synthetic-prototype', aiMode: 'openai', origin: 'https://example.com', get database() { return forbidden(); } },
    { mode: 'synthetic-prototype', aiMode: 'openai', origin: 'http://127.0.0.1:55100/?key=forbidden', get database() { return forbidden(); } }]) {
    await assert.rejects(verifyPrototypeHomeAi(sandbox), /^Error: HOME_AI_CHECK_SCOPE_INVALID$/);
  }
});

test('home AI live checker rejects absent local tool paths before reading credentials or data', async () => {
  const sandbox = { mode: 'synthetic-prototype', aiMode: 'openai', origin: 'http://127.0.0.1:55100', database: {},
    ids: { recordId: 'prototype-record-test' }, get credentials() { assert.fail('No credential read'); } };
  await assert.rejects(verifyPrototypeHomeAi(sandbox, { reportDirectory: 'relative', playwrightModule: 'relative', executablePath: 'relative' }),
    /^Error: HOME_AI_CHECK_CONFIGURATION_INVALID$/);
});
