import assert from 'node:assert/strict';
import { PassThrough,Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AuthError } from '../auth.mjs';
import { parseBootstrapArguments,bootstrapDatabaseOptions,runBootstrapCli } from '../bootstrap-center.mjs';
import { OperatorInputError,readHiddenLine } from '../operator-terminal.mjs';

// Synthetic strings and controlled TTY test doubles. No real terminal input,
// production DB, account, environment secret or network connection is used.
const centerId = 'center-9a321d8b-5b60-4b99-831a-114fb087d106';
const operationId = '149f5415-4528-4189-a09f-a0adf6aaf42e';
const retryArgs = ['--center-id',centerId,'--operation-id',operationId];
const dbUrl = 'postgresql://test_operator:synthetic_db_secret@db.example.invalid/test';
const email = 'synthetic.manager@example.com', password = 'synthetic manager credential';
const code = (value) => (error) => error instanceof OperatorInputError && error.code === value && error.message === value;

function terminal(script = []) {
  const input = new PassThrough();
  input.isTTY = true; input.isRaw = false; input.rawModes = [];
  input.setRawMode = (raw) => { input.isRaw = raw; input.rawModes.push(raw); return input; };
  input.pause();
  let written = '';
  const newlineRawModes = [];
  const output = new Writable({ write(chunk,encoding,next) {
    const text = chunk.toString(); written += text;
    if (text === '\n') newlineRawModes.push(input.isRaw);
    if (text.endsWith(': ')) {
      const response = script.shift();
      if (response !== undefined) setImmediate(() => {
        if (typeof response === 'function') response(input);
        else input.write(Buffer.from(`${response}\r`,'utf8'));
      });
    }
    next();
  } });
  output.isTTY = true;
  return { input,output,text:() => written,newlineRawModes };
}
function services(extra = {}) {
  const state = { connected:0,closed:0,options:null,request:null };
  return { state,createDatabase:(options) => { state.connected++; state.options = options;
    return { close:async () => { state.closed++; } }; },
  createAuth:() => ({ bootstrapNewCenter:async (request) => { state.request = request;
    return { centerId:request.centerId,operationId:request.operationId,userId:'synthetic-manager-id',replayed:false }; } }),...extra };
}
const script = () => [dbUrl,email,password,password,'CREATE NEW CENTER'];
const containsNoSecrets = (text) => { for (const secret of [dbUrl,email,password,'synthetic_db_secret']) assert.equal(text.includes(secret),false); };

test('CLI arguments accept only opaque operation identifiers and explicit local-test mode',() => {
  assert.deepEqual(parseBootstrapArguments([]),{ help:false,localTest:false });
  assert.deepEqual(parseBootstrapArguments(['--help']),{ help:true });
  assert.deepEqual(parseBootstrapArguments([...retryArgs,'--local-test']),{ help:false,localTest:true,centerId,operationId });
  for (const args of [['--password',password],['--email',email],['--database-url',dbUrl],['--help','--local-test'],
    ['--center-id',centerId],['--operation-id',operationId],['--center-id','person-name','--operation-id',operationId],
    [...retryArgs,'--operation-id',operationId],['--local-test','--local-test']])
    assert.throws(() => parseBootstrapArguments(args),code('BOOTSTRAP_OPTIONS_INVALID'));
});

test('TLS certificate verification is mandatory unless the operator explicitly selects a literal loopback test DB',() => {
  const options = bootstrapDatabaseOptions(dbUrl);
  assert.deepEqual(options.ssl,{ rejectUnauthorized:true });
  assert.equal(options.max,1); assert.equal(options.connectionTimeoutMillis,5000);
  for (const host of ['127.0.0.1','[::1]']) {
    const url = `postgres://test:synthetic-secret@${host}:5432/test`;
    assert.equal(bootstrapDatabaseOptions(url,{ localTest:true }).ssl,false);
    assert.deepEqual(bootstrapDatabaseOptions(url).ssl,{ rejectUnauthorized:true });
  }
  for (const url of [dbUrl,'postgres://u:p@localhost/test','postgres://u:p@192.0.2.1/test'])
    assert.throws(() => bootstrapDatabaseOptions(url,{ localTest:true }),code('BOOTSTRAP_DB_CONFIGURATION'));
  for (const localTest of ['false',null,1])
    assert.throws(() => bootstrapDatabaseOptions('postgres://u:p@127.0.0.1/test',{ localTest }),code('BOOTSTRAP_DB_CONFIGURATION'));
});

test('URL query overrides, unsafe schemes, fragments, controls and malformed database fields are rejected generically',() => {
  for (const url of [`${dbUrl}?sslmode=no-verify`,`${dbUrl}?ssl=true`,`${dbUrl}?application_name=private`,`${dbUrl}#fragment`,
    'https://db.example.invalid/test','postgres://u:p@host/','postgres://u@host/test','postgres://u:p@host/a/b',
    'postgres://u:p@host:70000/test','postgres://u:p%00@host/test',`${dbUrl}\n`,null])
    assert.throws(() => bootstrapDatabaseOptions(url),code('BOOTSTRAP_DB_CONFIGURATION'));
});

test('secret terminal input is never echoed and raw/paused state is restored',async () => {
  const tty = terminal();
  const pending = readHiddenLine('secret: ',tty);
  assert.equal(tty.input.isRaw,true);
  tty.input.write(Buffer.from(`${password}\r`));
  assert.equal(await pending,password);
  assert.equal(tty.text(),'secret: \n');
  assert.equal(tty.input.isRaw,false); assert.equal(tty.input.isPaused(),true);
  assert.deepEqual(tty.input.rawModes,[true,false]);
  assert.equal(tty.input.listenerCount('data'),0); assert.equal(tty.input.listenerCount('error'),0);
});

test('UTF8 fragments, Unicode backspace, clear-line and spaces preserve the intended secret exactly',async () => {
  const tty = terminal(), pending = readHiddenLine('secret: ',tty);
  const unicode = Buffer.from('가😀','utf8');
  tty.input.write(unicode.subarray(0,2)); tty.input.write(unicode.subarray(2));
  tty.input.write(Buffer.from('\x7f\x15  새 암호  \r','utf8'));
  assert.equal(await pending,'  새 암호  ');
  assert.equal(tty.text().includes('가'),false); assert.equal(tty.text().includes('새 암호'),false);
  assert.equal(tty.input.isRaw,false);
});

test('single CRLF is accepted but multiline paste, escapes, other controls and oversized values fail closed',async () => {
  const valid = terminal(), good = readHiddenLine('secret: ',valid);
  valid.input.write(Buffer.from('synthetic\r\n')); assert.equal(await good,'synthetic');
  for (const value of ['one\rnext','one\nnext','\x1b[200~secret','one\x00','12345\r']) {
    const tty = terminal(), pending = readHiddenLine('secret: ',{ ...tty,maxLength:4 });
    tty.input.write(Buffer.from(value));
    await assert.rejects(pending,code('OPERATOR_INPUT_INVALID'));
    assert.equal(tty.input.isRaw,false); assert.equal(tty.text(),'secret: \n');
  }
});

test('Ctrl-C, Ctrl-D and terminal EOF cancel without leaving raw mode or exposing input',async () => {
  for (const key of ['\x03','\x04']) {
    const tty = terminal(), pending = readHiddenLine('secret: ',tty);
    tty.input.write(Buffer.from(`private${key}`));
    await assert.rejects(pending,code('OPERATOR_CANCELLED')); assert.equal(tty.input.isRaw,false);
    assert.equal(tty.text().includes('private'),false);
  }
  const tty = terminal(), pending = readHiddenLine('secret: ',tty);
  tty.input.end(); await assert.rejects(pending,code('OPERATOR_CANCELLED'));
  assert.equal(tty.input.isRaw,false);
});

test('timeout and abort restore terminal state without leaking arbitrary abort reasons',{ timeout:3000 },async () => {
  const timeout = terminal(), timed = readHiddenLine('secret: ',{ ...timeout,timeoutMilliseconds:100 });
  await assert.rejects(timed,code('OPERATOR_INPUT_TIMEOUT')); assert.equal(timeout.input.isRaw,false);
  const tty = terminal(), controller = new AbortController(), pending = readHiddenLine('secret: ',{ ...tty,signal:controller.signal });
  controller.abort(new Error('SYNTHETIC-PRIVATE-ABORT-DETAIL'));
  await assert.rejects(pending,code('OPERATOR_CANCELLED')); assert.equal(tty.input.isRaw,false);
  assert.equal(tty.text().includes('SYNTHETIC-PRIVATE'),false);
});

test('terminal failures are content-free and preserve prior raw/paused state',async () => {
  const tty = terminal(); tty.input.isRaw = true;
  const pending = readHiddenLine('secret: ',tty);
  tty.input.emit('error',new Error('SYNTHETIC-PRIVATE-INPUT-DETAIL'));
  await assert.rejects(pending,code('OPERATOR_INPUT_UNAVAILABLE'));
  assert.equal(tty.input.isRaw,true); assert.equal(tty.input.isPaused(),true);
  assert.equal(tty.text().includes('SYNTHETIC-PRIVATE'),false);
  assert.throws(() => readHiddenLine('secret: ',{ ...tty,maxLength:0 }),code('OPERATOR_INPUT_INVALID'));
  assert.throws(() => readHiddenLine('secret: ',{ ...tty,signal:AbortSignal.abort() }),code('OPERATOR_CANCELLED'));
});

test('CLI help never opens a DB or asks for credentials, including when output is redirected',async () => {
  const tty = terminal(), service = services(); tty.output.isTTY = false;
  assert.equal(await runBootstrapCli({ argv:['--help'],...tty,...service }),0);
  assert.match(tty.text(),/최초 센터 관리자/); assert.equal(service.state.connected,0);
});

test('CLI refuses piped/redirected secret input before any credential prompt or DB connection',async () => {
  for (const side of ['input','output']) {
    const tty = terminal(script()), service = services(); tty[side].isTTY = false;
    assert.equal(await runBootstrapCli({ argv:[],...tty,...service }),1);
    assert.match(tty.text(),/OPERATOR_TTY_REQUIRED/); assert.equal(service.state.connected,0);
    assert.equal(tty.text().includes('DB URL (숨김)'),false); containsNoSecrets(tty.text());
  }
});

test('CLI submits exact confirmed credentials, uses default TLS and closes the injected DB without logging secrets',async () => {
  const tty = terminal(script()), service = services();
  assert.equal(await runBootstrapCli({ argv:retryArgs,...tty,...service }),0);
  assert.equal(service.state.connected,1); assert.equal(service.state.closed,1);
  assert.deepEqual(service.state.options.ssl,{ rejectUnauthorized:true });
  assert.deepEqual(service.state.request,{ centerId,operationId,confirmNewCenter:centerId,email,password });
  assert.match(tty.text(),/생성이 완료/); assert.match(tty.text(),/자동 로그인·아동 연결은 하지/);
  containsNoSecrets(tty.text()); assert.equal(tty.input.isRaw,false);
  assert.deepEqual(tty.newlineRawModes,[true,true,true,true,true]);
  assert.equal(tty.input.readableFlowing,false);
});

test('new CLI attempts generate opaque IDs while explicit retries preserve both IDs',async () => {
  const tty = terminal(script()), service = services();
  assert.equal(await runBootstrapCli({ argv:[],...tty,...service }),0);
  assert.match(service.state.request.operationId,/^[a-f0-9-]{36}$/);
  assert.match(service.state.request.centerId,/^center-[a-f0-9-]{36}$/);
  assert.equal(service.state.request.confirmNewCenter,service.state.request.centerId);
  containsNoSecrets(tty.text());
});

test('password mismatch or missing explicit creation approval never opens the DB',async () => {
  for (const answers of [[dbUrl,email,password,'other synthetic password'],[dbUrl,email,password,password,'NO']]) {
    const tty = terminal(answers), service = services();
    const status = await runBootstrapCli({ argv:retryArgs,...tty,...service });
    assert.ok(status === 1 || status === 130); assert.equal(service.state.connected,0);
    containsNoSecrets(tty.text()); assert.equal(tty.input.isRaw,false);
  }
});

test('invalid DB URL and remote local-test flags fail before asking for account secrets',async () => {
  for (const argv of [retryArgs,[...retryArgs,'--local-test']]) {
    const tty = terminal([argv.includes('--local-test') ? dbUrl : `${dbUrl}?sslmode=disable`]), service = services();
    assert.equal(await runBootstrapCli({ argv,...tty,...service }),1);
    assert.match(tty.text(),/BOOTSTRAP_DB_CONFIGURATION/); assert.equal(service.state.connected,0);
    assert.equal(tty.text().includes('관리자 이메일 (숨김)'),false); containsNoSecrets(tty.text());
  }
});

test('CLI response-loss and known errors omit private driver details and retain opaque retry instructions',async () => {
  for (const error of [new Error(`SYNTHETIC-DRIVER-DETAIL ${dbUrl} ${password}`),new AuthError('BOOTSTRAP_FORBIDDEN',403)]) {
    const tty = terminal(script()), service = services({ createAuth:() => ({ bootstrapNewCenter:async () => { throw error; } }) });
    assert.equal(await runBootstrapCli({ argv:retryArgs,...tty,...service }),1);
    assert.equal(service.state.closed,1); assert.equal(tty.text().includes('SYNTHETIC-DRIVER-DETAIL'),false);
    assert.equal(tty.text().includes(operationId),true); containsNoSecrets(tty.text());
  }
});

test('CLI replay confirmation describes unchanged credentials and still does not issue a session',async () => {
  const tty = terminal(script()), service = services({ createAuth:() => ({ bootstrapNewCenter:async () => ({ centerId,operationId,userId:'synthetic-manager-id',replayed:true }) }) });
  assert.equal(await runBootstrapCli({ argv:retryArgs,...tty,...service }),0);
  assert.match(tty.text(),/기존 생성 완료/); assert.match(tty.text(),/계정·비밀번호·권한은 변경하지/);
  containsNoSecrets(tty.text()); assert.equal(service.state.closed,1);
});

test('CLI cancellation before creation closes input without opening a database',async () => {
  const tty = terminal([(input) => input.write(Buffer.from('\x03'))]), service = services();
  assert.equal(await runBootstrapCli({ argv:retryArgs,...tty,...service }),130);
  assert.equal(service.state.connected,0); assert.equal(tty.input.isRaw,false); containsNoSecrets(tty.text());
});

test('CLI DB-close failure is redacted and does not reinterpret an already committed creation as rollback',async () => {
  const tty = terminal(script()), service = services({ createDatabase:() => ({ close:async () => { throw new Error(`SYNTHETIC-CLOSE ${dbUrl}`); } }) });
  assert.equal(await runBootstrapCli({ argv:retryArgs,...tty,...service }),1);
  assert.match(tty.text(),/생성이 완료/); assert.match(tty.text(),/DB_CLOSE_UNAVAILABLE/);
  assert.equal(tty.text().includes('SYNTHETIC-CLOSE'),false); containsNoSecrets(tty.text());
});

test('real executable help/non-TTY paths never need a DB environment or print submitted sensitive fields',{ timeout:5000 },() => {
  const executable = fileURLToPath(new URL('../bootstrap-center.mjs',import.meta.url));
  const help = spawnSync(process.execPath,[executable,'--help'],{ encoding:'utf8',timeout:3000 });
  assert.equal(help.status,0); assert.match(help.stderr,/최초 센터 관리자/);
  const pipe = spawnSync(process.execPath,[executable],{ encoding:'utf8',input:password,timeout:3000 });
  assert.equal(pipe.status,1); assert.match(pipe.stderr,/OPERATOR_TTY_REQUIRED/);
  containsNoSecrets(`${pipe.stdout}${pipe.stderr}`);
  const forbidden = spawnSync(process.execPath,[executable,'--password',password],{ encoding:'utf8',timeout:3000 });
  assert.equal(forbidden.status,1); assert.match(forbidden.stderr,/BOOTSTRAP_OPTIONS_INVALID/);
  containsNoSecrets(`${forbidden.stdout}${forbidden.stderr}`);
});
