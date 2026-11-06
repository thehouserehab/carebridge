import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Auth,AuthError,AUTH_LIMITS } from './auth.mjs';
import { postgresDatabase } from './database.mjs';
import { OperatorInputError,operatorFail,readHiddenLine,requirePrivateTerminal } from './operator-terminal.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CENTER_ID = /^center-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HELP = `Carebridge 최초 센터 관리자 생성 (운영자 전용)
사용법: node server/bootstrap-center.mjs [--local-test]
재시도: node server/bootstrap-center.mjs --center-id <opaque-id> --operation-id <uuid> [--local-test]
도움말: node server/bootstrap-center.mjs --help

DB URL·이메일·비밀번호는 대화형 터미널에서 숨김 입력합니다.
비밀번호/이메일/DB URL 인자, 파이프 입력, 자동 마이그레이션은 지원하지 않습니다.
기본 DB 연결은 인증서 검증 TLS입니다. --local-test는 리터럴 loopback DB에서만 TLS를 끕니다.
운영자 전용 DB 권한과 사전 스키마 적용이 필요하며 실제 센터 생성 전에 대상 DB를 확인하세요.
`;
const MESSAGES = Object.freeze({
  OPERATOR_TTY_REQUIRED:'입력·출력이 연결된 개인 대화형 터미널이 필요합니다. 파이프/리다이렉션은 사용할 수 없습니다.',
  OPERATOR_INPUT_INVALID:'입력 형식/길이를 확인해 주세요. 제어 문자·여러 줄 붙여넣기는 허용하지 않습니다.',
  OPERATOR_INPUT_UNAVAILABLE:'터미널 입력을 처리할 수 없습니다.',
  OPERATOR_INPUT_TIMEOUT:'입력 시간이 초과되었습니다.',
  OPERATOR_CANCELLED:'작업이 중단되었습니다. 생성 결과가 불명확하면 같은 작업 ID로 재확인하세요.',
  BOOTSTRAP_OPTIONS_INVALID:'지원하지 않는 인자입니다. --help를 확인하고 비밀값을 인자로 넣지 마세요.',
  BOOTSTRAP_DB_CONFIGURATION:'DB 연결 설정을 확인해 주세요. URL 쿼리·원격 비TLS·잘못된 형식은 허용하지 않습니다.',
  BOOTSTRAP_PASSWORD_MISMATCH:'비밀번호 확인이 일치하지 않습니다.',
  INVALID_INPUT:'센터 생성 입력값을 확인해 주세요.',
  BOOTSTRAP_FORBIDDEN:'이 DB 계정에는 최초 관리자 생성 권한이 없습니다.',
  BOOTSTRAP_EXISTS:'기존 센터에는 이 절차를 사용할 수 없습니다. 계정 복구/추가 관리자 승인 절차가 필요합니다.',
  BOOTSTRAP_ACCOUNT_EXISTS:'기존 계정 이메일로 새 관리자 권한을 부여하지 않습니다.',
  BOOTSTRAP_CONFLICT:'같은 작업 ID의 대상/자격 증명이 다르거나 생성 요청이 충돌했습니다.',
  BOOTSTRAP_CLOSED:'종료/변경된 관리자 상태를 이 절차로 복구할 수 없습니다.',
  BOOTSTRAP_UNAVAILABLE:'처리 결과를 확인할 수 없습니다. DB 상태를 확인한 뒤 같은 센터/작업 ID로 재확인하세요.',
});

export function parseBootstrapArguments(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) operatorFail('BOOTSTRAP_OPTIONS_INVALID');
  if (argv.length === 1 && argv[0] === '--help') return { help:true };
  const options = { help:false,localTest:false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) operatorFail('BOOTSTRAP_OPTIONS_INVALID');
    seen.add(flag);
    if (flag === '--local-test') options.localTest = true;
    else if (flag === '--center-id' || flag === '--operation-id') {
      const value = argv[++index];
      if (!value || !(flag === '--center-id' ? CENTER_ID : UUID).test(value)) operatorFail('BOOTSTRAP_OPTIONS_INVALID');
      options[flag === '--center-id' ? 'centerId' : 'operationId'] = value;
    } else operatorFail('BOOTSTRAP_OPTIONS_INVALID');
  }
  if (Boolean(options.centerId) !== Boolean(options.operationId)) operatorFail('BOOTSTRAP_OPTIONS_INVALID');
  return options;
}

export function bootstrapDatabaseOptions(connectionString, { localTest = false } = {}) {
  try {
    if (typeof localTest !== 'boolean' || typeof connectionString !== 'string' || connectionString.length > 2048 || /[\x00-\x20\x7f]/.test(connectionString))
      operatorFail('BOOTSTRAP_DB_CONFIGURATION');
    const url = new URL(connectionString);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password ||
        !/^\/[^/]+$/.test(url.pathname) || url.search || url.hash ||
        (url.port && (!Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535)) ||
        [url.username,url.password,url.pathname].some((value) => /[\x00-\x1f\x7f]/.test(decodeURIComponent(value))) ||
        (localTest && !['127.0.0.1','[::1]'].includes(url.hostname))) operatorFail('BOOTSTRAP_DB_CONFIGURATION');
    // URL sslmode/sslcert fields can replace node-postgres's ssl object. Reject
    // all query parameters, then explicitly enforce certificate verification.
    return { connectionString,ssl:localTest ? false : { rejectUnauthorized:true },
      max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,application_name:'carebridge-bootstrap' };
  } catch { operatorFail('BOOTSTRAP_DB_CONFIGURATION'); }
}

export async function runBootstrapCli({ argv = process.argv.slice(2),input = process.stdin,output = process.stderr,
  createDatabase = postgresDatabase,createAuth = (database) => new Auth(database),signal } = {}) {
  let database = null,connectionString = '',email = '',password = '',confirmation = '',exitCode = 0;
  let restoreTerminal = null;
  try {
    const options = parseBootstrapArguments(argv);
    if (options.help) { output.write(HELP); return 0; }
    requirePrivateTerminal(input,output);
    const previousRaw = Boolean(input.isRaw), previouslyFlowing = input.readableFlowing === true;
    // Keep echo disabled across ALL prompts, not just while a prompt listener
    // is attached. Otherwise queued input could echo between secret questions.
    restoreTerminal = () => { input.setRawMode(previousRaw); if (previouslyFlowing) input.resume(); else input.pause(); };
    try { input.setRawMode(true); input.pause(); } catch { operatorFail('OPERATOR_INPUT_UNAVAILABLE'); }
    const centerId = options.centerId ?? `center-${randomUUID()}`, operationId = options.operationId ?? randomUUID();
    output.write(`새 센터 최초 관리자 생성입니다. 운영 전용 DB 계정·대상 DB를 확인하세요.\n센터 ID: ${centerId}\n작업 ID: ${operationId}\n응답 유실 시 이 두 ID를 보존해 재시도하세요. 입력값은 표시하지 않습니다.\n`);
    const ask = (label,maxLength) => readHiddenLine(label,{ input,output,maxLength,signal });
    connectionString = await ask('운영자 DB URL (숨김): ',2048);
    const dbOptions = bootstrapDatabaseOptions(connectionString,options);
    email = await ask('최초 관리자 이메일 (숨김): ',254);
    password = await ask(`관리자 비밀번호 (${AUTH_LIMITS.passwordMin}~${AUTH_LIMITS.passwordMax}자, 숨김): `,AUTH_LIMITS.passwordMax);
    confirmation = await ask('비밀번호 다시 입력 (숨김): ',AUTH_LIMITS.passwordMax);
    if (password !== confirmation) operatorFail('BOOTSTRAP_PASSWORD_MISMATCH');
    confirmation = await ask('이 새 센터의 생성을 승인하면 CREATE NEW CENTER를 입력하세요: ',80);
    if (confirmation !== 'CREATE NEW CENTER' || signal?.aborted) operatorFail('OPERATOR_CANCELLED');
    restoreTerminal(); restoreTerminal = null;
    // No environment-driven DB access, schema mutation, HTTP or auto-login.
    // The only connection is to the operator-entered/confirmed database.
    database = createDatabase(dbOptions);
    const result = await createAuth(database).bootstrapNewCenter({ centerId,operationId,confirmNewCenter:centerId,email,password });
    output.write(result.replayed ? '기존 생성 완료를 확인했습니다. 계정·비밀번호·권한은 변경하지 않았습니다.\n' : '새 센터와 최초 관리자 생성이 완료되었습니다. 자동 로그인·아동 연결은 하지 않았습니다.\n');
    output.write(`센터 ID: ${result.centerId}\n관리자 내부 ID: ${result.userId}\n작업 ID: ${result.operationId}\n`);
    if (signal?.aborted) { output.write('중단 요청 이후 생성 완료가 확인되었습니다. 위 결과를 기준으로 확인하세요.\n'); exitCode = 130; }
  } catch (error) {
    const known = error instanceof OperatorInputError || error instanceof AuthError;
    const code = known && Object.hasOwn(MESSAGES,error.code) ? error.code : 'BOOTSTRAP_UNAVAILABLE';
    output.write(`${code}: ${MESSAGES[code]}\n`);
    exitCode = code === 'OPERATOR_CANCELLED' ? 130 : 1;
  } finally {
    if (restoreTerminal) {
      try { restoreTerminal(); } catch { output.write('OPERATOR_INPUT_UNAVAILABLE: 터미널 상태 복원을 확인할 수 없습니다.\n'); if (!exitCode) exitCode = 1; }
    }
    connectionString = ''; email = ''; password = ''; confirmation = '';
    if (database) {
      try { await database.close(); }
      catch { output.write('DB_CLOSE_UNAVAILABLE: DB 연결 종료를 확인할 수 없습니다. 완료/재시도 영수증을 확인하세요.\n'); if (!exitCode) exitCode = 1; }
    }
  }
  return exitCode;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController(), abort = () => controller.abort();
  process.on('SIGINT',abort); process.on('SIGTERM',abort);
  try { process.exitCode = await runBootstrapCli({ signal:controller.signal }); }
  finally { process.removeListener('SIGINT',abort); process.removeListener('SIGTERM',abort); }
}
