import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPrototypeSandbox } from '../server/prototype-sandbox.mjs';
import { verifyPrototypeHomeAi } from '../scripts/lib/prototype-home-ai-check.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';

const options = messageBrowserOptions(process.argv.slice(2));
const folder = fileURLToPath(new URL('../test-results/prototype-home-ai-mock-' + randomUUID() + '/', import.meta.url));
const calls = [];
const aiProviders = {
  chatProvider: { mode: 'openai', model: 'offline-openai-contract', async respond({ messages }) {
    assert.equal(messages.length, 1); assert(messages[0].content.startsWith('가상 자료 연결 시험입니다.'));
    calls.push('chat');
    return { text: '가상 관찰 기록에 따르면 두 블록 중 파란 블록을 골랐어요.', usage: { inputTokens: 1, outputTokens: 1 } };
  } },
  summaryProvider: { mode: 'openai', model: 'offline-openai-contract', async generate(source) {
    assert.deepEqual(source, { performed: '가상 사례: 파란 블록과 노란 블록 중 고르는 놀이를 했습니다.', response: '가상 사례: 하루가 파란 블록을 골랐습니다.' });
    calls.push('summary');
    return { summary: '가상 사례에서 두 블록 중 파란 블록을 직접 골랐습니다.', reviewNotes: [], usage: { inputTokens: 1, outputTokens: 1 } };
  } },
};
let sandbox, cancelledSandbox;
try {
  sandbox = await createPrototypeSandbox({ aiProviders });
  const result = await verifyPrototypeHomeAi(sandbox, { reportDirectory: folder, playwrightModule: options.module, executablePath: options.executable });
  assert.equal(result.passed, true, 'See safe report: ' + path.join(folder, 'report.json'));
  assert.deepEqual(calls, ['chat', 'summary']);
  assert.equal(sandbox.database.closed, false, 'Checker must preserve the caller session');
  await assert.rejects(verifyPrototypeHomeAi(sandbox, { reportDirectory: folder, playwrightModule: options.module, executablePath: options.executable }), /HOME_AI_CHECK_SCOPE_INVALID/);
  const controller = new AbortController();
  let cancelledChats = 0, cancelledSummaries = 0;
  cancelledSandbox = await createPrototypeSandbox({ aiProviders: {
    chatProvider: { mode: 'openai', model: 'offline-cancellation-contract', async respond() {
      cancelledChats++; controller.abort();
      return { text: '가상 중단 시험 응답', usage: { inputTokens: 1, outputTokens: 1 } };
    } },
    summaryProvider: { mode: 'openai', model: 'offline-cancellation-contract', async generate() {
      cancelledSummaries++; throw new Error('Must not run after cancellation');
    } },
  } });
  const cancelled = await verifyPrototypeHomeAi(cancelledSandbox, { reportDirectory: path.join(folder, 'cancelled'),
    playwrightModule: options.module, executablePath: options.executable, signal: controller.signal });
  assert.equal(cancelled.passed, false); assert.equal(cancelled.cancelled, true);
  assert.deepEqual(cancelled.cleanup, { browserStopped: true, contextsClosed: true });
  assert.equal(cancelledChats, 1); assert.equal(cancelledSummaries, 0);
  assert.equal(cancelledSandbox.database.closed, false);
  console.log(JSON.stringify({ passed: true, providerCalls: calls.length, cancelledChats, cancelledSummaries, actualModelCalls: 0, reportDirectory: folder }));
} finally { await sandbox?.close(); await cancelledSandbox?.close(); }
