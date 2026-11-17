import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { getPendingSyntheticCleanup } from '../server/local-sandbox-cleanup.mjs';

// Only a real local launch needs the server's optional database dependencies.
// Argument validation and injected launcher tests also run in the root-only build.
async function createPrototypeSandbox(options) {
  const { createPrototypeSandbox: create } = await import('../server/prototype-sandbox.mjs');
  return create(options);
}

export function parsePrototypeArguments(args) {
  let confirmed = false, port = 0, portSeen = false, open = false;
  for (const arg of args) {
    if (arg === '--confirm-synthetic-local' && !confirmed) { confirmed = true; continue; }
    if (arg === '--open' && !open) { open = true; continue; }
    if (/^--port=(0|[1-9][0-9]{3,4})$/.test(arg) && !portSeen) {
      port = Number(arg.slice(7)); portSeen = true;
      if (port !== 0 && (port < 1024 || port > 65535)) throw new Error('INVALID_PROTOTYPE_ARGUMENTS');
      continue;
    }
    throw new Error('INVALID_PROTOTYPE_ARGUMENTS');
  }
  if (!confirmed) throw new Error('SYNTHETIC_CONFIRMATION_REQUIRED');
  return { port, open };
}
export function openPrototypeBrowser(origin) {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(origin)) throw new Error('INVALID_PROTOTYPE_ORIGIN');
  const [command, args] = process.platform === 'win32' ? ['explorer.exe', [origin]]
    : process.platform === 'darwin' ? ['open', [origin]] : ['xdg-open', [origin]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}
export async function runPrototype(args, {
  input = process.stdin, output = process.stdout, diagnostic = process.stderr, target = process,
  createSandbox = createPrototypeSandbox, openBrowser = openPrototypeBrowser,
  onReady = async () => {},
} = {}) {
  let options;
  try {
    options = parsePrototypeArguments(args);
    if (input.isTTY !== true || output.isTTY !== true) throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
  } catch {
    diagnostic.write('직접 사용하는 터미널에서 npm run prototype을 실행하세요.\n'); target.exitCode = 1; return;
  }
  let sandbox, terminal, pendingCleanup, stopped = false;
  const controller = new AbortController();
  const finished = Promise.withResolvers();
  const stop = () => { stopped = true; controller.abort(); finished.resolve(); };
  target.on('SIGINT', stop); target.on('SIGTERM', stop);
  input.once('end', stop); input.once('error', stop);
  const accounts = () => {
    for (const account of sandbox.credentials) {
      output.write(`\n${({ therapist: '치료사', guardian: '보호자', center: '센터 관리자' })[account.role]} 시연 계정\n이메일: ${account.email}\n비밀번호: ${account.password}\n`);
    }
  };
  try {
    sandbox = await createSandbox({ port: options.port });
    if (!stopped) {
      output.write(`\nCarebridge 프로토타입\n접속 주소: ${sandbox.origin}\n`);
      if (sandbox.aiMode === 'openai') {
        output.write('가상 자료 전용 · 홈 AI 대화와 기록 요약은 실제 OpenAI 응답입니다.\n');
        output.write('질문·최근 AI 대화 또는 직접 선택한 기록의 활동·반응을 OpenAI로 전송하며 비용이 발생합니다.\n');
        output.write('실제 아동·개인정보는 입력하지 마세요. 대화 20회·요약 20회까지이며 실패 시 자동 재시도하지 않습니다.\n');
        output.write('녹음 정리는 제공 샘플의 예시 모드입니다. 키는 이번 서버 메모리에만 유지합니다.\n');
      } else output.write('가상 자료 시연 · AI는 준비된 예시 응답 · 외부 API 비용 없음\n');
      output.write('사진·영상·녹음은 assets/prototype의 제공된 샘플로 시연하세요.\n');
      output.write(`샘플 폴더: ${fileURLToPath(new URL('../assets/prototype/', import.meta.url))}\n`);
      output.write('먼저 치료사로 로그인하세요. 보호자 화면은 로그아웃 후 보호자 계정으로 확인할 수 있어요.\n');
      accounts();
      output.write('\n종료: q + Enter 또는 Ctrl+C · 계정 다시 보기: accounts + Enter\n');
      output.write('시연 중에는 창을 유지하세요. 새로고침해도 내용은 유지되며 종료하면 이번 시연 자료가 초기화됩니다.\n');
      terminal = createInterface({ input, output, terminal: true });
      terminal.on('SIGINT', stop); terminal.on('close', stop);
      terminal.on('line', value => {
        if (stopped) return;
        if (value.trim().toLowerCase() === 'q') stop();
        else if (value.trim() === 'accounts') accounts();
        else output.write('종료하려면 q, 계정을 다시 보려면 accounts를 입력하세요.\n');
      });
      await onReady(sandbox, { signal: controller.signal });
      if (!stopped && options.open) await openBrowser(sandbox.origin).catch(() => output.write('브라우저 주소창에 위 접속 주소를 직접 입력해 주세요.\n'));
      await finished.promise;
    }
  } catch (error) {
    pendingCleanup = getPendingSyntheticCleanup(error);
    diagnostic.write('프로토타입을 준비하지 못했습니다. 의존성 설치와 포트 상태를 확인하세요.\n'); target.exitCode = 1;
  } finally {
    stopped = true; terminal?.close();
    try {
      await sandbox?.close(); await pendingCleanup?.();
      if (sandbox) output.write('\n프로토타입을 종료하고 이번 가상 세션을 정리했습니다.\n');
    } catch {
      diagnostic.write('가상 세션 정리를 확인하지 못했습니다. 임시 파일을 임의로 삭제하지 마세요.\n'); target.exitCode = 1;
    } finally {
      target.off('SIGINT', stop); target.off('SIGTERM', stop);
      input.off('end', stop); input.off('error', stop); input.pause?.();
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runPrototype(process.argv.slice(2));
