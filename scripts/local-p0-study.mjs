// PC-only human-study preparation. No task completion, participant answers,
// timings or browser data are collected. The participant owns their browser.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPendingSyntheticCleanup } from '../server/local-sandbox-cleanup.mjs';

export function parseLocalP0StudyArguments(args) {
  if (!Array.isArray(args) || ![2, 3].includes(args.length) || args[0] !== '--confirm-synthetic-local' ||
      !['--task=A', '--task=B', '--task=C'].includes(args[1]) ||
      args.length === 3 && !['--duration-minutes=30', '--duration-minutes=120'].includes(args[2]))
    throw Error('LOCAL_P0_STUDY_CONFIGURATION');
  return Object.freeze({ task: args[1].slice(-1), durationMinutes: args[2] === '--duration-minutes=120' ? 120 : 30 });
}

const prepareDefault = async sourceHash => {
  const { hasLocalP0StudyPreflight } = await import('./local-p0-study-preflight.mjs');
  return hasLocalP0StudyPreflight(sourceHash);
};
const sourceDefault = async () => {
  const { captureLocalP0StudySources } = await import('../tests/local-p0-study-browser.mjs');
  return captureLocalP0StudySources();
};
const fixtureDefault = async (task, options) => {
  const { createLocalP0StudyFixture } = await import('../tests/local-p0-study-fixture.mjs');
  return createLocalP0StudyFixture(task, options);
};

export async function runLocalP0Study(args, { input = process.stdin, output = process.stdout,
  diagnostic = process.stderr, target = process, prepare = prepareDefault,
  createFixture = fixtureDefault, observeSource = sourceDefault } = {}) {
  const warn = text => { target.exitCode = 1; try { diagnostic.write(text); } catch {} };
  let options;
  try {
    options = parseLocalP0StudyArguments(args);
    if (input.isTTY !== true || output.isTTY !== true) throw Error();
  } catch {
    warn('직접 사용하는 터미널에서 실행하세요: node scripts/local-p0-study.mjs --confirm-synthetic-local --task=A (또는 B/C). 마지막에 --duration-minutes=30 또는 --duration-minutes=120을 선택할 수 있습니다. 기본값은 30분입니다.\n');
    return;
  }
  let fixture, sourceHash, pendingCleanup, fixtureOwned = false, stopRequested = false, stopVersion = 0, wake, command = '', discard = false;
  const stop = () => { stopRequested = true; stopVersion++; wake?.(); wake = undefined; };
  const waitForStop = since => stopVersion > since ? Promise.resolve() : new Promise(resolve => { wake = resolve; });
  const check = () => { if (stopRequested || input.isTTY !== true || output.isTTY !== true) throw Error('LOCAL_P0_STUDY_STOPPED'); };
  const source = async () => {
    const result = await observeSource();
    if (!result || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256)) throw Error();
    return result.sha256;
  };
  const onData = chunk => {
    try {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (!Buffer.isBuffer(bytes)) throw Error();
      for (const byte of bytes) {
        if (byte === 10 || byte === 13) {
          if (!discard && ['', 'q', 'Q'].includes(command.trim())) stop();
          command = ''; discard = false;
        } else if (!discard) {
          if (![32, 81, 113].includes(byte) || command.length >= 16) { command = ''; discard = true; }
          else command += String.fromCharCode(byte);
        }
      }
    } catch { warn('터미널 입력을 확인하지 못해 종료를 요청합니다.\n'); stop(); }
  };
  const inputError = () => { warn('터미널 입력이 끊겨 종료를 요청합니다.\n'); stop(); };
  const lifetime = setTimeout(() => {
    warn(`${options.durationMinutes}분 준비·평가 시간이 끝났습니다. 이번 관측을 중단하고 서버를 정리합니다.\n`); stop();
  }, options.durationMinutes * 60 * 1000);
  // Keep cleanup ownership after a failed close; never kill or delete around it.
  const keepAlive = setInterval(() => {}, 60_000);
  target.on('SIGINT', stop); target.on('SIGTERM', stop);
  input.on('data', onData); input.on('end', stop); input.on('error', inputError);
  try {
    output.write('오늘의 A/B/C 합성 사전검사 결과를 현재 소스와 대조합니다. 검사나 서버를 이 단계에서 새로 시작하지 않습니다.\n');
    sourceHash = await source(); check();
    if (await prepare(sourceHash) !== true) throw Error(); check();
    if (await source() !== sourceHash) throw Error(); check();
    fixture = await createFixture(options.task, { port: 0 }); fixtureOwned = true; check();
    if (await source() !== sourceHash) throw Error(); check();
    const sandbox = fixture.sandbox, origin = new URL(sandbox.origin);
    if (fixture.task !== options.task || !/^\d{4}-\d{2}-\d{2}$/.test(fixture.day) ||
        origin.origin !== sandbox.origin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' ||
        !origin.port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error();
    const role = options.task === 'B' ? 'therapist' : 'guardian';
    const accounts = sandbox.credentials.filter(account => account.role === role);
    if (accounts.length !== 1 || !/^[A-Za-z0-9._-]+@carebridge\.test$/.test(accounts[0].email) ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(accounts[0].password)) throw Error();
    check();
    output.write(`\n과제 ${options.task} · 시험일 ${fixture.day} · 소스 SHA-256 ${sourceHash}\n접속 주소: ${sandbox.origin}\n`);
    output.write('새 Chrome 시크릿 창에서 주소를 직접 열고 아래 가상 계정으로 로그인하세요. 기존 탭·저장소를 초기화하지 마세요.\n');
    output.write('이 PC의 현재 앱만 평가합니다. 아이폰·외부 접속·실제 자료·첨부 시험은 제외합니다. 사진/영상은 업로드하지 마세요.\n');
    output.write('진행자가 새 창·해당 역할·하루 홈·과제 초기 상태를 확인하기 전에는 시간 측정을 시작하지 마세요. 로그인/준비 시간은 제외합니다.\n');
    output.write('과제와 관측 규칙: docs/p0-user-validation.md. 사람의 시간·이동·답변은 자동 수집하지 않으며 기존 대비 개선율도 계산하지 않습니다.\n');
    check();
    output.write(`${role === 'therapist' ? '가상 치료사' : '가상 보호자'}\n이메일: ${accounts[0].email}\n시험 비밀번호: ${accounts[0].password}\n`);
    output.write('개발 소스를 편집하지 마세요. 정상 종료하면 이번 계정·기록은 사라집니다. 종료 전에 필요한 비식별 관측값만 별도 기록하세요.\n');
    output.write(`평가용 서버 준비됨. 종료: q + Enter / 빈 Enter / Ctrl+C. 준비를 포함해 최대 ${options.durationMinutes}분입니다.\n`);
    await waitForStop(0);
  } catch (error) {
    pendingCleanup = getPendingSyntheticCleanup(error);
    if (pendingCleanup) fixtureOwned = true;
    if (!stopRequested) warn('평가 준비를 확인하지 못했습니다. 소스 변경·사전검사·터미널 상태를 확인하세요. 필요하면 npm run test:p0-local-api:browser로 사전검사 후 다시 실행하세요. 원본 오류나 계정 정보는 기록하지 않습니다.\n');
  } finally {
    stopRequested = true;
    // Cancelled preparation must settle before adopting and closing its new
    // fixture. No race/timeout is treated as proof the factory has stopped.
    while (fixture || pendingCleanup) {
      const observedStop = stopVersion;
      try {
        if (fixture) {
          await fixture.sandbox.close();
          if (fixture.sandbox.database.closed !== true) throw Error();
          fixture = undefined;
        }
        if (pendingCleanup) { await pendingCleanup(); pendingCleanup = undefined; }
      } catch {
        warn('평가용 서버 종료가 확인되지 않았습니다. 창을 유지하고 Ctrl+C로 정리를 재시도하세요. 파일을 임의 삭제하지 마세요.\n');
        await waitForStop(observedStop);
      }
    }
    try {
      if (sourceHash && await source() !== sourceHash) warn('실행 전후 소스가 달라 이번 관측을 동일 버전 평가에 사용하지 마세요.\n');
    } catch { warn('종료 시 소스 버전을 확인하지 못했습니다. 이번 관측을 동일 버전 평가에 사용하지 마세요.\n'); }
    clearTimeout(lifetime); clearInterval(keepAlive);
    target.off('SIGINT', stop); target.off('SIGTERM', stop);
    input.off('data', onData); input.off('end', stop); input.off('error', inputError);
    if (input.listenerCount('data') === 0) input.pause?.();
    try { output.write(fixtureOwned
      ? '평가용 서버 종료 확인. 사용한 시크릿 창은 직접 닫아 주세요. 사람 과제 완료·평가 결과는 자동 판정하지 않았습니다.\n'
      : '사람 평가용 서버를 준비 완료하지 않았습니다. 사전검사 결과를 확인하세요.\n'); }
    catch { target.exitCode = 1; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runLocalP0Study(process.argv.slice(2));
