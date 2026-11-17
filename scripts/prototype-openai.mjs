import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runPrototype, parsePrototypeArguments } from './prototype.mjs';
import { readLocalAiConfig } from './local-ai-api.mjs';
import { createOpenAiChatProvider, createOpenAiSummaryProvider } from '../server/ai-summary-provider.mjs';

// Defer optional server dependencies until an explicit local session is created.
async function createPrototypeSandbox(options) {
  const { createPrototypeSandbox: create } = await import('../server/prototype-sandbox.mjs');
  return create(options);
}

export function parseOpenAiPrototypeArguments(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new TypeError('INVALID_ARGUMENTS');
  const external = args.filter(value => value === '--enable-external-ai');
  const verify = args.filter(value => value === '--verify-synthetic-home');
  if (external.length !== 1 || verify.length > 1) throw new TypeError('EXPLICIT_EXTERNAL_AI_REQUIRED');
  const baseArgs = args.filter(value => !['--enable-external-ai', '--verify-synthetic-home'].includes(value));
  parsePrototypeArguments(baseArgs);
  return { baseArgs, verify: verify.length === 1 };
}

// Records only transport status, never headers, prompts, model output or keys.
export function createPrototypeTransportAudit(fetchImpl = globalThis.fetch) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      if (url !== 'https://api.openai.com/v1/responses' || init?.method !== 'POST') throw new Error('UNEXPECTED_AI_TRANSPORT');
      const call = { status: null, completed: false };
      calls.push(call);
      try {
        const response = await fetchImpl(url, init);
        call.status = response.status; call.completed = true;
        return response;
      } catch { throw new Error('AI_TRANSPORT_FAILED'); }
    },
  };
}

export async function runOpenAiPrototype(args, {
  env = process.env, input = process.stdin, output = process.stdout, diagnostic = process.stderr, target = process,
  createSandbox = createPrototypeSandbox, runSession = runPrototype, fetchImpl = globalThis.fetch,
  verifyHome, openBrowser,
} = {}) {
  let options, config;
  try {
    options = parseOpenAiPrototypeArguments(args);
    if (input.isTTY !== true || output.isTTY !== true) throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
    config = readLocalAiConfig(env);
  } catch {
    diagnostic.write('OpenAI 프로토타입을 시작하지 못했습니다. 전용 입력창에서 유효한 키를 입력하세요.\n');
    target.exitCode = 1; return;
  } finally { delete env.CAREBRIDGE_OPENAI_API_KEY; }
  const audit = createPrototypeTransportAudit(fetchImpl);
  const providers = {
    chatProvider: createOpenAiChatProvider({ ...config, fetchImpl: audit.fetch }),
    summaryProvider: createOpenAiSummaryProvider({ ...config, fetchImpl: audit.fetch }),
  };
  const model = config.model; config = undefined;
  await runSession(options.baseArgs, {
    input, output, diagnostic, target, ...(openBrowser ? { openBrowser } : {}),
    createSandbox: options => createSandbox({ ...options, aiProviders: providers }),
    onReady: async (sandbox, { signal } = {}) => {
      output.write(`OpenAI 모델: ${model}\n`);
      if (!options.verify) return;
      const reportDirectory = fileURLToPath(new URL('../test-results/prototype-openai-live-' + randomUUID() + '/', import.meta.url));
      output.write('새 가상 자료로 홈 질문 1회와 기록 요약 1회를 검증합니다. API 비용이 발생하며 자동 재시도하지 않습니다.\n');
      const before = audit.calls.length;
      let result;
      try {
        const verify = verifyHome ?? (await import('./lib/prototype-home-ai-check.mjs')).verifyPrototypeHomeAi;
        result = await verify(sandbox, { reportDirectory, signal });
      } catch { result = { passed: false, error: 'HOME_AI_CHECK_FAILED' }; }
      const calls = audit.calls.slice(before).map(value => ({ ...value }));
      const passed = result.passed === true && calls.length === 2 && calls.every(call => call.status === 200 && call.completed);
      await mkdir(reportDirectory, { recursive: true });
      await writeFile(path.join(reportDirectory, 'live-result.json'), JSON.stringify({
        passed, model, origin: sandbox.origin, syntheticOnly: true, actualModelCalls: calls.length,
        calls, browserPassed: result.passed === true,
      }, null, 2) + '\n');
      output.write(signal?.aborted ? '요청에 따라 검증을 중단했습니다. 추가 호출 없이 종료합니다.\n' : passed ? '홈 AI 실제 응답·기록 요약·PC/모바일 확인을 통과했습니다.\n' : '실제 응답 검증을 통과하지 못했습니다. 예시 답변으로 대체하지 않았으며 상세 결과를 확인하세요.\n');
      output.write(`검증 결과: ${reportDirectory}\n`);
    },
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runOpenAiPrototype(process.argv.slice(2));
