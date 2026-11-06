// Parser and CLI lifetime doubles only. No E files, DPAPI, database, browser,
// Docker or native process is opened. Credentials are synthetic sentinels.
import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {cp,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {syntheticSessionOptions} from '../server/synthetic-e-session-options.mjs';
import {runSyntheticEApi} from '../scripts/synthetic-e-api.mjs';

const postgres=['--base','E:\\SyntheticOnly','--powershell','C:\\SyntheticOnly\\pwsh.exe','--confirm-synthetic-e-drive'];
const id='12345678-1234-4234-8234-123456789abc',otherId='12345678-1234-4234-8234-123456789abd';
const secret='SYNTHETIC_ONE_TIME_PASSWORD',privateError='PRIVATE_PATH_OR_ERROR_MUST_NOT_APPEAR';
const argsFor=mode=>mode==='ephemeral'?[...postgres]:mode==='create-resumable'?['--create-resumable',...postgres]:['--resume-session',id,...postgres];
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{const value=Promise.withResolvers();value.promise.catch(()=>{});return value;};
const limits={timeout:3000};

test('CLI import and non-TTY rejection work without the server runtime or installed packages',async t=>{
  const isolated=await mkdtemp(join(tmpdir(),'carebridge-cli-import-'));
  t.after(()=>rm(isolated,{recursive:true,force:true}));
  await mkdir(join(isolated,'scripts'));await mkdir(join(isolated,'server'));
  for(const relative of ['scripts/synthetic-e-api.mjs','server/synthetic-e-session-options.mjs','server/windows-postgres-policy.mjs'])
    await cp(new URL('../'+relative,import.meta.url),join(isolated,relative));
  const {runSyntheticEApi:runIsolated}=await import(pathToFileURL(join(isolated,'scripts/synthetic-e-api.mjs')).href);
  const diagnostics=[],target={};
  await runIsolated(postgres,{input:{isTTY:false},output:{isTTY:false},target,diagnostic:{write:value=>diagnostics.push(value)}});
  assert.equal(target.exitCode,1);assert.match(diagnostics.join(''),/대화형 터미널/);
});

test('options preserve the original five-argument policy and return only a frozen mode, session ID and cloned arguments',()=>{
  for(const mode of ['ephemeral','create-resumable','resume']){
    const input=argsFor(mode),parsed=syntheticSessionOptions(input);
    assert.deepEqual(parsed,{mode,sessionId:mode==='resume'?id:null,postgresArgs:postgres});
    assert(Object.isFrozen(parsed));assert(Object.isFrozen(parsed.postgresArgs));
    input[input.length-4]='E:\\MutatedAfterCapture';assert.equal(parsed.postgresArgs[1],'E:\\SyntheticOnly');
    assert.throws(()=>parsed.postgresArgs.push('ignored'));assert.throws(()=>{parsed.mode='resume';});
  }
});

test('options reject arbitrary resume paths, combined/misplaced flags and invalid original policy with one fixed error',()=>{
  const bad=[null,{},'--create-resumable',[],['--resume-session',...postgres],['--resume-session','E:\\SyntheticOnly',...postgres],
    ['--resume-session','../'+id,...postgres],['--resume-session',id.toUpperCase(),...postgres],['--resume-session',id+'\n',...postgres],
    ['--resume-session','12345678-1234-5234-8234-123456789abc',...postgres],
    ['--create-resumable','--resume-session',id,...postgres],['--resume-session',id,'--create-resumable',...postgres],
    [...postgres,'--create-resumable'],[...postgres,'--resume-session',id],['--persistent',...postgres],
    ['--create-resumable','--create-resumable',...postgres],['--create-resumable',...postgres,'--password',secret],
    ['--resume-session',id,'--base','C:\\SyntheticOnly','--powershell',postgres[3],postgres[4]],
    ['--create-resumable','--base','E:\\','--powershell',postgres[3],postgres[4]],
    ['--create-resumable','--base',postgres[1],'--powershell','C:\\bad.exe',postgres[4]],
    ['--create-resumable','--base',postgres[1],'--powershell',postgres[3],null]];
  for(const value of bad)assert.throws(()=>syntheticSessionOptions(value),error=>error.message==='SYNTHETIC_SESSION_CONFIGURATION'&&!error.cause);
  const throwing=[...postgres];Object.defineProperty(throwing,1,{get(){throw Error(privateError);}});
  assert.throws(()=>syntheticSessionOptions(throwing),{message:'SYNTHETIC_SESSION_CONFIGURATION'});
});

function fixture(t,mode='resume'){
  const outputLines=[],diagnostics=[],input=new EventEmitter(),target=new EventEmitter(),timers=new Set();input.isTTY=true;
  let phase='starting',failed=false,reads=0,forgotten=0,closes=0,creates=0,run,passedArgs,closeWork;
  let storage={mode,runId:id,secretsRetained:false,resumable:false,secretsDisposed:false};
  const ready=deferred(),stopped=deferred(),restarts=[];
  const output={isTTY:true,write(value){outputLines.push(String(value));return true;}};
  const diagnostic={write(value){diagnostics.push(String(value));return true;}};
  input.pause=()=>{};
  const session={ready:ready.promise,status:()=>({phase,ready:phase==='ready',failed,storage:{...storage}}),
    close(){closes++;return closeWork?closeWork():stopped.promise;},waitForStop:()=>stopped.promise,
    forgetCredentials(){forgotten++;},restartApi(){const task=deferred();restarts.push(task);return task.promise;}};
  Object.defineProperty(session,'credentials',{get(){reads++;if(mode==='resume')throw Error('RESUME_MUST_NOT_READ_CREDENTIALS');
    return[{role:'therapist',email:'therapist@synthetic.test',password:secret},{role:'guardian',email:'guardian@synthetic.test',password:secret+'_GUARDIAN'}];}});
  t.mock.method(globalThis,'setInterval',(callback,delay)=>{const timer={callback,delay};timers.add(timer);return timer;});
  t.mock.method(globalThis,'clearInterval',timer=>{if(timer!==undefined){assert(timers.has(timer));timers.delete(timer);}});
  const finish=({failure=false,retained=true,resumable=true,changes={}}={})=>{
    phase='stopped';failed=failure;storage={...storage,secretsRetained:retained,resumable,...changes};
    stopped.resolve({stopped:true,failed});
  };
  t.after(async()=>{
    closeWork=null;for(const restart of restarts)restart.resolve({origin:'http://127.0.0.1:4102'});
    ready.resolve({origin:'http://127.0.0.1:4101'});finish();target.emit('SIGINT');await tick();await run;
    assert.equal(timers.size,0,'Owned lifetime anchor must be released after confirmed stop.');
  });
  return{input,output,diagnostic,target,session,ready,stopped,restarts,timers,
    text:()=>outputLines.join(''),errors:()=>diagnostics.join(''),reads:()=>reads,forgotten:()=>forgotten,closes:()=>closes,creates:()=>creates,passedArgs:()=>passedArgs,
    start(args=argsFor(mode),extra={}){run=runSyntheticEApi(args,{input,output,diagnostic,target,create:received=>{creates++;passedArgs=received;return session;},...extra});return run;},
    prepare(){phase='ready';ready.resolve({origin:'http://127.0.0.1:4101'});},finish,
    reject(){failed=true;ready.reject(Error(privateError));},storage(value){storage={...storage,...value};},
    closeWith(value){closeWork=value;},setPhase(value){phase=value;},
    clean(){assert.equal(target.listenerCount('SIGINT'),0);assert.equal(target.listenerCount('SIGTERM'),0);
      for(const event of ['data','end','error'])assert.equal(input.listenerCount(event),0);assert.equal(timers.size,0);},
    safe(){assert(!diagnostics.join('').includes(secret));assert(!diagnostics.join('').includes(privateError));
      assert(!outputLines.join('').includes(privateError));assert(!outputLines.join('').includes(postgres[1]));assert(!outputLines.join('').includes(postgres[3]));},
  };
}

test('each new mode refuses non-TTY use before creation or signal/keepalive ownership',limits,async t=>{
  for(const mode of ['create-resumable','resume'])for(const stream of ['input','output']){
    const f=fixture(t,mode);f[stream].isTTY=false;await f.start();
    assert.equal(f.creates(),0);assert.equal(f.reads(),0);assert.equal(f.text(),'');assert.equal(f.target.exitCode,1);f.clean();f.safe();
  }
});

test('injected CLI factories never load the native runtime',limits,async t=>{
  const f=fixture(t),run=f.start(undefined,{loadRuntime:()=>{throw Error('UNEXPECTED_NATIVE_IMPORT');}});
  f.prepare();await tick();f.finish();await run;assert.equal(f.creates(),1);f.clean();f.safe();
});

test('actual CLI factory is resolved lazily after TTY confirmation and retains normal cleanup',limits,async t=>{
  const f=fixture(t),loading=deferred();let created=0;
  const run=f.start(undefined,{create:undefined,loadRuntime:()=>loading.promise});
  assert.equal(f.timers.size,1);assert.equal(created,0);
  loading.resolve({createWindowsSyntheticSession:args=>{assert.deepEqual(args,argsFor('resume'));created++;return f.session;}});
  f.prepare();await tick();assert.equal(created,1);f.finish();await run;
  assert.equal(f.target.exitCode,undefined);assert.equal(f.forgotten(),1);f.clean();f.safe();
});

test('cancellation during native import allocates no session and releases lifetime ownership',limits,async t=>{
  const f=fixture(t),loading=deferred();let created=0;
  const run=f.start(undefined,{create:undefined,loadRuntime:()=>loading.promise});
  f.target.emit('SIGINT');loading.resolve({createWindowsSyntheticSession:()=>{created++;return f.session;}});
  await run;assert.equal(created,0);assert.equal(f.closes(),0);assert.equal(f.reads(),0);
  assert.equal(f.target.exitCode,undefined);f.clean();f.safe();
});

test('native import failure stays sanitized and releases ownership without a session',limits,async t=>{
  const f=fixture(t);
  await f.start(undefined,{create:undefined,loadRuntime:async()=>{throw Error(privateError);}});
  assert.equal(f.target.exitCode,1);assert.equal(f.creates(),0);assert.equal(f.closes(),0);
  assert.match(f.errors(),/완료하지 못했습니다/);f.clean();f.safe();
});

test('TTY loss during native import prevents allocation and credentials',limits,async t=>{
  const f=fixture(t),loading=deferred();let created=0;
  const run=f.start(undefined,{create:undefined,loadRuntime:()=>loading.promise});
  f.output.isTTY=false;loading.resolve({createWindowsSyntheticSession:()=>{created++;return f.session;}});
  await run;assert.equal(created,0);assert.equal(f.reads(),0);assert.equal(f.target.exitCode,1);f.clean();f.safe();
});

test('invalid CLI arguments do not echo arbitrary path or secret and never create a session',limits,async t=>{
  const f=fixture(t);await f.start(['--resume-session',privateError,...postgres,'--password',secret]);
  assert.equal(f.creates(),0);assert.equal(f.target.exitCode,1);assert.equal(f.text(),'');f.safe();f.clean();
});

test('resumable creation retains exact input arguments and displays credentials once only after readiness',limits,async t=>{
  const f=fixture(t,'create-resumable'),args=argsFor('create-resumable'),expected=[...args],run=f.start(args);
  args[2]='E:\\ChangedAfterStart';await tick();
  assert.deepEqual(f.passedArgs(),expected);assert.equal(f.reads(),0);assert(!f.text().includes(id));assert(!f.text().includes('http://'));
  f.prepare();await tick();assert.equal(f.reads(),1);assert.equal(f.forgotten(),1);
  assert.equal(f.text().split('시험 비밀번호:').length-1,2);assert.match(f.text(),/한 번만 표시/);
  assert.match(f.text(),/최초 발급 후 2일/);assert.match(f.text(),/정상 종료/);assert.match(f.text(),/강제 종료·정전/);
  assert(!f.text().includes('보호하여 보존했습니다'));assert(!f.text().includes('재개: npm'));
  f.finish();await run;assert.match(f.text(),/Windows 계정으로 보호하여 보존했습니다/);
  assert.match(f.text(),new RegExp('--resume-session '+id));assert(!f.text().includes('이번 실행의 키와 임시 검사 자원은 정리'));
  assert.equal(f.reads(),1);assert.equal(f.forgotten(),1);f.clean();f.safe();
});

test('resume never reads credentials and announces the original account without email/password output',limits,async t=>{
  const f=fixture(t),run=f.start();f.prepare();await tick();
  assert.deepEqual(f.passedArgs(),argsFor('resume'));assert.equal(f.reads(),0);assert.equal(f.forgotten(),1);
  assert.match(f.text(),/처음 발급받은 가상 계정으로 다시 로그인/);
  for(const value of ['시험 비밀번호:','이메일:',secret,'@synthetic.test','새 가상 계정입니다'])assert(!f.text().includes(value));
  f.finish();await run;assert.equal(f.reads(),0);assert.equal(f.target.exitCode,undefined);f.clean();f.safe();
});

test('resumed API-only r restart keeps the original session and never touches the credentials getter',limits,async t=>{
  const f=fixture(t),run=f.start();f.prepare();await tick();
  f.input.emit('data','r\r\n');await tick();assert.equal(f.restarts.length,1);
  f.restarts[0].resolve({origin:'http://127.0.0.1:4102'});await tick();assert.match(f.text(),/API 재시작 완료: http:\/\/127\.0\.0\.1:4102/);
  assert.equal(f.reads(),0);assert.equal(f.forgotten(),1);assert.equal(f.creates(),1);
  f.finish();await run;f.clean();f.safe();
});

test('resumed preparation cancellation does not print an address, account or a premature resumable success',limits,async t=>{
  const f=fixture(t),run=f.start();f.target.emit('SIGINT');f.prepare();await tick();
  assert.equal(f.closes(),1);assert(!f.text().includes('http://'));assert(!f.text().includes('보호하여 보존했습니다'));assert.equal(f.reads(),0);
  assert.equal(f.timers.size,1);assert.equal(f.target.listenerCount('SIGINT'),1);
  f.finish();await run;assert.match(f.text(),/Windows 계정으로 보호하여 보존했습니다/);f.clean();f.safe();
});

test('normal stop is observed before retained-key success and repeated signals share the same attempt',limits,async t=>{
  const f=fixture(t),run=f.start();f.prepare();await tick();
  f.target.emit('SIGINT');f.target.emit('SIGTERM');await tick();assert.equal(f.closes(),1);assert.equal(f.creates(),1);
  assert.equal(f.timers.size,1);assert(!f.text().includes('DB를 종료했습니다'));assert(!f.text().includes('보호하여 보존했습니다'));
  f.finish();await run;assert.equal(f.text().split('보호하여 보존했습니다').length-1,1);f.clean();f.safe();
});

test('unconfirmed stop keeps ownership and fixed retry notice without promising a resumable checkpoint',limits,async t=>{
  const f=fixture(t);f.closeWith(()=>{f.setPhase('stop-unconfirmed');throw Error(privateError);});
  const run=f.start();f.reject();await run;
  assert.equal(f.target.exitCode,1);assert.equal(f.creates(),1);assert.equal(f.closes(),1);assert.equal(f.timers.size,1);
  assert.equal(f.target.listenerCount('SIGINT'),1);assert.match(f.errors(),/Ctrl\+C/);assert(!f.text().includes('재개: npm'));
  for(const timer of f.timers)timer.callback();await tick();assert.equal(f.closes(),1,'The keepalive must not retry automatically.');
  f.closeWith(()=>{f.finish();return f.stopped.promise;});f.target.emit('SIGINT');await tick();
  assert.equal(f.closes(),2);assert.equal(f.creates(),1);f.clean();f.safe();
});

test('stopped process with unverified, contradictory or failed retention cannot announce successful resume',limits,async t=>{
  for(const options of [{retained:false},{resumable:false},{failure:true},{changes:{secretsDisposed:true}},
    {changes:{runId:otherId}},{changes:{runId:privateError}},{changes:{mode:'create-resumable'}}]){
    const f=fixture(t),run=f.start();f.prepare();await tick();f.finish(options);await run;
    assert.equal(f.target.exitCode,1);assert(!f.text().includes('보호하여 보존했습니다'));assert(!f.text().includes('재개: npm'));
    assert.match(f.errors(),/재개 가능 상태/);f.clean();f.safe();
  }
});

test('ready identity mismatch is rejected before address or credentials and still awaits owned close',limits,async t=>{
  for(const storage of [{runId:otherId},{runId:privateError},{mode:'ephemeral'}]){
    const f=fixture(t),run=f.start();f.storage(storage);f.prepare();await tick();
    assert.equal(f.closes(),1);assert.equal(f.reads(),0);assert(!f.text().includes('준비 완료:'));assert.equal(f.timers.size,1);
    f.finish({failure:true});await run;f.clean();f.safe();
  }
});

test('TTY loss after preparation prevents new credentials and uses the same owned cleanup',limits,async t=>{
  for(const mode of ['create-resumable','resume']){
    const f=fixture(t,mode),run=f.start();f.output.isTTY=false;f.prepare();await tick();
    assert.equal(f.reads(),0);assert.equal(f.closes(),1);assert(!f.text().includes(secret));
    f.finish({failure:true});await run;assert.equal(f.target.exitCode,1);f.clean();f.safe();
  }
});

test('credential output failure forgets credentials once and does not abandon resumable creation resources',limits,async t=>{
  const f=fixture(t,'create-resumable'),original=f.output.write;
  f.output.write=value=>{if(value.includes('시험 비밀번호:'))throw Error(privateError);return original(value);};
  const run=f.start();f.prepare();await tick();assert.equal(f.reads(),1);assert.equal(f.forgotten(),1);assert.equal(f.closes(),1);
  assert.equal(f.timers.size,1);f.finish({failure:true});await run;assert.equal(f.target.exitCode,1);f.clean();f.safe();
});

test('default temporary mode retains its original key-disposal completion message',limits,async t=>{
  const f=fixture(t,'ephemeral'),run=f.start();f.prepare();await tick();f.finish({retained:false,resumable:false,changes:{secretsDisposed:true}});await run;
  assert.match(f.text(),/이번 실행의 키와 임시 검사 자원은 정리했습니다/);
  assert(!f.text().includes('보호하여 보존했습니다'));assert(!f.text().includes('재개: npm'));assert.equal(f.reads(),1);f.clean();f.safe();
});
