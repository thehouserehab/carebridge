import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createLocalApiSandbox } from '../server/local-api-sandbox.mjs';

export function parseLocalApiArguments(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('Invalid local arguments.');
  let confirmed = false;
  let port = 4180;
  let portSeen = false;
  for (const arg of args) {
    if (arg === '--confirm-synthetic-local' && !confirmed) { confirmed = true; continue; }
    if (/^--port=(0|[1-9][0-9]{0,4})$/.test(arg) && !portSeen) {
      port = Number(arg.slice('--port='.length));
      if (port !== 0 && (port < 1024 || port > 65535)) throw new TypeError('Local port must be 0 or 1024..65535.');
      portSeen = true;
      continue;
    }
    throw new TypeError('Unsupported local argument.');
  }
  if (!confirmed) throw new TypeError('Synthetic-only confirmation is required.');
  return { port };
}

async function main() {
  let options;
  try { options = parseLocalApiArguments(process.argv.slice(2)); }
  catch {
    process.stderr.write('사용법: node scripts/local-api.mjs --confirm-synthetic-local [--port=4180]\n포트는 0(임시 포트) 또는 1024~65535만 허용합니다.\n');
    process.exitCode = 1;
    return;
  }
  // Do not start an unattended server or send even synthetic passwords to a pipe/log.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('가상 계정은 직접 사용하는 대화형 터미널에서만 표시합니다. 자동 검증은 sandbox factory를 사용하세요.\n');
    process.exitCode = 1;
    return;
  }
  let sandbox;
  let stopping;
  let mailboxInput;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      mailboxInput?.close();
      try { await sandbox?.close(); process.stdout.write('\n로컬 시험 서버를 종료했습니다. 메모리 시험 자료·계정과 소유한 임시 업로드 파일을 정리했습니다.\n'); }
      catch { process.stderr.write('\n로컬 시험 서버 종료 확인에 실패했습니다. 이 프로세스를 종료해 주세요.\n'); process.exitCode = 1; }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    })();
    return stopping;
  };
  try {
    sandbox = await createLocalApiSandbox(options);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.stdout.write(`Carebridge 합성 자료 전용 로컬 API 시험\n${sandbox.origin}\n`);
    process.stdout.write('실제 아동 정보·사진·영상·실제 비밀번호를 사용하지 마세요. 외부 접속·메일·영속 DB는 사용하지 않습니다.\n');
    process.stdout.write('가상 첨부만 OS 임시 폴더에 비공개 격리 저장합니다. 검사·상대방 전송·파일 열람은 아직 연결되지 않았습니다.\n');
    process.stdout.write('정상 종료 시 소유한 임시 파일을 정리합니다. 강제 종료 시 잔여 파일이 남을 수 있습니다.\n');
    process.stdout.write('서버를 종료하면 시험 계정과 모든 대화가 사라집니다. 종료: Ctrl+C\n\n');
    for (const account of sandbox.credentials) {
      process.stdout.write(`${({ therapist: '가상 치료사', guardian: '가상 보호자', center: '가상 센터 관리자' })[account.role]}\n이메일: ${account.email}\n시험 비밀번호: ${account.password}\n\n`);
    }
    process.stdout.write('가상 이메일 로그인: 화면에서 인증번호 요청 후 여기서 mail guardian / mail therapist / mail center 입력\n');
    mailboxInput = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    mailboxInput.on('SIGINT', () => { void stop(); });
    // EOF must not leave the synthetic server running unattended. Defer the
    // callback so stop() can install its idempotent promise before close emits.
    mailboxInput.on('close', () => { queueMicrotask(() => { void stop(); }); });
    mailboxInput.on('line', async line => {
      if (stopping) return;
      const role = /^mail (guardian|therapist|center)$/.exec(line.trim())?.[1];
      if (!role) { process.stdout.write('시험 메일함 명령: mail guardian / mail therapist / mail center\n'); return; }
      try {
        const account = sandbox.credentials.find(item => item.role === role);
        const delivery = await sandbox.takeEmailLogin(account.email);
        if (!stopping) process.stdout.write(delivery ? `가상 인증번호: ${delivery.code} (만료: ${delivery.expiresAt})\n` : '새 시험 인증번호가 없습니다. 발급 제한 또는 만료일 수 있습니다.\n');
      } catch { if (!stopping) process.stdout.write('시험 메일함을 확인하지 못했습니다.\n'); }
    });
  } catch {
    await sandbox?.close().catch(() => {});
    process.stderr.write('로컬 시험 서버를 시작하지 못했습니다. 파일 준비 상태와 포트 사용 여부를 확인하세요.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
