import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createOpenAiSummaryProvider, createOpenAiChatProvider } from '../server/ai-summary-provider.mjs';
import { createOpenAiAudioProvider } from '../server/ai-audio-provider.mjs';

export function parseLocalAiArguments(args) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new TypeError('Invalid arguments.');
  const required = new Set(['--confirm-synthetic-local', '--enable-external-ai']);
  let port = 0, portSeen = false;
  for (const arg of args) {
    if (required.delete(arg)) continue;
    if (!portSeen && /^--port=(0|[1-9][0-9]{3,4})$/.test(arg)) {
      port = Number(arg.slice(7)); portSeen = true;
      if (port !== 0 && (port < 1024 || port > 65535)) throw new TypeError('Invalid port.');
      continue;
    }
    throw new TypeError('Unsupported argument.');
  }
  if (required.size) throw new TypeError('Explicit synthetic and external AI scope is required.');
  return { port };
}

export function readLocalAiConfig(env) {
  const apiKey = env.CAREBRIDGE_OPENAI_API_KEY;
  const model = env.CAREBRIDGE_AI_MODEL ?? 'gpt-6-luna';
  const reasoningEffort = env.CAREBRIDGE_AI_REASONING_EFFORT ?? 'none';
  if (typeof apiKey !== 'string' || !/^sk-[A-Za-z0-9_-]{16,508}$/.test(apiKey) ||
      typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(model) ||
      !['none','low','medium','high','xhigh','max'].includes(reasoningEffort)) {
    throw new TypeError('Carebridge AI configuration is missing or invalid.');
  }
  return { apiKey, model, reasoningEffort, maxOutputTokens: 800, timeoutMs: 8000 };
}

export async function main() {
  let options;
  try { options = parseLocalAiArguments(process.argv.slice(2)); }
  catch {
    process.stderr.write('사용법: node scripts/local-ai-api.mjs --confirm-synthetic-local --enable-external-ai [--port=0]\n');
    process.exitCode = 1; return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('키 입력과 가상 계정 표시는 직접 사용하는 대화형 터미널에서만 지원합니다.\n');
    process.exitCode = 1; return;
  }
  let sandbox, startup, input, deadline, stopping;
  const stop = () => {
    if (stopping) return stopping;
    stopping = Promise.resolve().then(async () => {
      clearTimeout(deadline); input?.close();
      try {
        // Finish ownership acquisition before closing; Ctrl+C during seeding
        // must not abandon an already created temporary quarantine directory.
        if (startup) sandbox = await startup;
        await sandbox?.close();
        process.stdout.write('\nAI 서버와 가상 세션을 종료했습니다. 시험 기록·AI 대화는 보존되지 않습니다.\n');
      } catch {
        process.stderr.write('\n정상 종료를 확인하지 못했습니다. 이 프로세스를 종료해 주세요.\n');
        process.exitCode = 1;
      } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    });
    return stopping;
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    let config;
    try { config = readLocalAiConfig(process.env); }
    finally { delete process.env.CAREBRIDGE_OPENAI_API_KEY; }
    const summaryProvider = createOpenAiSummaryProvider(config);
    const chatProvider = createOpenAiChatProvider(config);
    const audioProvider = createOpenAiAudioProvider({ apiKey: config.apiKey, model: config.model, reasoningEffort: config.reasoningEffort });
    const model = config.model; config = undefined;
    startup = (async () => {
      const { createLocalAiApiSandbox } = await import('../server/local-api-sandbox.mjs');
      if (stopping) return undefined;
      return createLocalAiApiSandbox({ ...options, summaryProvider, chatProvider, audioProvider, maxCalls: 20 });
    })();
    sandbox = await startup;
    if (stopping) { await stopping; return; }
    deadline = setTimeout(() => { process.stdout.write('\n120분 시험 시간이 끝났습니다.\n'); void stop(); }, 120 * 60 * 1000);
    process.stdout.write(`Carebridge AI · 가상 자료 전용\n${sandbox.origin}\n모델: ${model}\n`);
    process.stdout.write('질문·대화와 선택한 기록의 활동/반응을 OpenAI로 전송하며 사용료가 발생할 수 있습니다.\n');
    process.stdout.write('실제 아동·개인정보·사진·영상은 입력하지 마세요. 국내 처리나 무보존을 보장하는 환경이 아닙니다.\n');
    process.stdout.write('호출 한도: 대화 20회 + 기록 요약 20회(실패 포함). 자동 재시도 없음. 종료 시 초기화됩니다.\n');
    process.stdout.write('녹음 정리: 가상 녹음만 파일 업로드 후 명시적으로 시작합니다. 회당 전사+분석 두 호출, 최대 10회이며 원음·전사·초안은 종료 시 사라집니다.\n');
    process.stdout.write('키는 서버 메모리에만 사용합니다. 로컬 접속만 허용하며 DB는 메모리 시험 DB입니다.\n');
    process.stdout.write('종료: q + Enter 또는 Ctrl+C · 자동 종료: 120분\n\n');
    for (const account of sandbox.credentials) {
      process.stdout.write(`${({therapist:'가상 치료사',guardian:'가상 보호자',center:'가상 센터 관리자'})[account.role]}\n이메일: ${account.email}\n시험 비밀번호: ${account.password}\n\n`);
    }
    input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    input.on('SIGINT', () => { void stop(); });
    input.on('close', () => { queueMicrotask(() => { void stop(); }); });
    input.on('line', line => { if (line.trim() === 'q') void stop(); else process.stdout.write('종료하려면 q + Enter를 입력하세요.\n'); });
  } catch {
    // Never reflect provider errors, configuration values or response bodies.
    process.stderr.write('AI 시험 서버를 시작하지 못했습니다. Node 24·서버 의존성·키 입력·포트를 확인해 주세요.\n');
    process.exitCode = 1; await stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
