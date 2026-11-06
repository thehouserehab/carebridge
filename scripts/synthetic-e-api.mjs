import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {syntheticSessionOptions} from '../server/synthetic-e-session-options.mjs';

export async function runSyntheticEApi(args,{input=process.stdin,output=process.stdout,diagnostic=process.stderr,target=process,create,
  loadRuntime=()=>import('../server/windows-synthetic-session.mjs')}={}) {
  let captured,options;
  try{captured=Array.isArray(args)?[...args]:args;options=syntheticSessionOptions(captured);if(!input.isTTY||!output.isTTY)throw Error();}
  catch{
    if([undefined,null,0].includes(target.exitCode))target.exitCode=1;
    try{diagnostic.write('가상 E 실행기는 직접 사용하는 대화형 터미널에서만 시작할 수 있습니다.\n사용법: npm run dev:synthetic-e -- --base E:\\CarebridgeBeta --powershell <pwsh.exe 절대경로> --confirm-synthetic-e-drive\n보존 세션 생성은 --create-resumable, 정상 종료한 세션 재개는 --resume-session <세션 UUID>를 --base 앞에 붙이세요.\n');}catch{/* No resource was allocated. */}
    return;
  }
  let session,stopRequested=false,closeAttempt,credentialsForgotten=false,stopReported=false,keepAlive,restartAttempt;
  let inputOwned=false,command='',discardCommand=false;
  const fail=()=>{if([undefined,null,0].includes(target.exitCode))target.exitCode=1;};
  const warn=text=>{fail();try{diagnostic.write(text);}catch{/* A broken terminal is not permission to abandon owned resources. */}};
  const releaseInput=()=>{
    if(!inputOwned)return;inputOwned=false;command='';discardCommand=false;
    input.off('data',readCommand);input.off('end',inputEnded);input.off('error',inputFailed);
    if(input.listenerCount?.('data')===0)input.pause?.();
  };
  const releaseLifetime=()=>{releaseInput();clearInterval(keepAlive);keepAlive=undefined;target.off('SIGINT',stop);target.off('SIGTERM',stop);};
  const forget=()=>{if(session&&!credentialsForgotten){credentialsForgotten=true;session.forgetCredentials();}};
  const retainedId=state=>{
    const storage=state?.storage,id=storage?.runId;
    if(storage?.mode!==options.mode||typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)||
      options.mode==='resume'&&id!==options.sessionId)throw Error();
    return id;
  };
  const retentionLimit='동일 Windows 계정에서 정상 종료한 가상 세션만 재개합니다. TLS 인증서는 최초 발급 후 2일 동안만 유효하며, 강제 종료·정전 복구나 실제 자료 운영을 보장하지 않습니다.\n';
  const reportStopped=result=>{
    const state=session.status();
    if(result?.stopped!==true||state.phase!=='stopped')throw Error();
    if(result.failed)fail();
    releaseLifetime();
    if(!stopReported){
      stopReported=true;
      try{
        if(options.mode==='ephemeral')output.write('\n시험 API·작업자·DB를 종료했습니다. E 가상 진단 자료는 보존하며, 이번 실행의 키와 임시 검사 자원은 정리했습니다.\n');
        else{
          const id=retainedId(state);
          if(result.failed||state.failed||state.storage.secretsRetained!==true||state.storage.resumable!==true||state.storage.secretsDisposed===true)throw Error();
          output.write(`\n시험 API·작업자·DB를 종료했습니다. 가상 자료와 재개에 필요한 키를 Windows 계정으로 보호하여 보존했습니다.\n세션 UUID: ${id}\n`);
          output.write(`재개: npm run dev:synthetic-e -- --resume-session ${id} --base <이전 E 기본 경로> --powershell <이전 pwsh.exe 절대경로> --confirm-synthetic-e-drive\n`);
          output.write(retentionLimit);
        }
      }
      catch{warn(options.mode==='ephemeral'?'종료 안내를 출력하지 못했습니다.\n':'실행 자원은 종료했지만 가상 세션의 재개 가능 상태를 확인하거나 안내하지 못했습니다. 새 실행으로 덮어쓰지 말고 상태를 확인하세요.\n');}
    }
  };
  const closeSession=()=>{
    if(!session)return Promise.resolve(false);
    if(closeAttempt)return closeAttempt;
    let pending;
    try{pending=session.close();}catch{pending=Promise.reject(Error());}
    closeAttempt=Promise.resolve(pending).then(result=>{reportStopped(result);return true;}).catch(()=>{
      warn('종료를 확인하지 못했습니다. 자원을 보존합니다. 이 터미널에서 Ctrl+C로 같은 종료 작업을 다시 확인하세요.\n');
      return false;
    }).finally(()=>{closeAttempt=undefined;});
    return closeAttempt;
  };
  const stop=()=>{stopRequested=true;void closeSession();};
  const inputEnded=()=>stop();
  const inputFailed=()=>{warn('터미널 입력을 확인하지 못해 가상 환경을 종료합니다.\n');stop();};
  const writeInstruction=()=>output.write('API만 재시작: r 입력 후 Enter. 같은 가상 계정으로 새 주소에서 다시 로그인하세요. 종료: Ctrl+C.\n');
  const restart=()=>{
    if(stopRequested||restartAttempt)return;
    try{
      if(!input.isTTY||!output.isTTY)throw Error();
      if(session.status().ready!==true){writeInstruction();return;}
      output.write('기존 API의 실제 종료를 확인한 뒤 같은 가상 DB로 다시 시작합니다.\n');
      restartAttempt=Promise.resolve().then(()=>{
        if(stopRequested)return;
        return session.restartApi();
      }).then(result=>{
        if(stopRequested)return;
        try{
          if(!input.isTTY||!output.isTTY)throw Error();
          if(session.status().ready!==true)throw Error();
          // Only the trusted owned session supplies this address. Credentials
          // have already been forgotten and must never be re-read or reprinted.
          output.write(`\nAPI 재시작 완료: ${result.origin}\n처음 안내한 가상 계정으로 다시 로그인하세요. DB와 첨부는 같은 가상 세션에 유지됩니다.\n`);
        }catch{inputFailed();}
      }).catch(()=>{
        if(!stopRequested){warn('API 재시작을 확인하지 못했습니다. 새 실행을 만들지 말고 현재 상태와 종료 안내를 확인하세요.\n');
          if(!input.isTTY||!output.isTTY)stop();}
      }).finally(()=>{restartAttempt=undefined;});
    }catch{inputFailed();}
  };
  function readCommand(chunk){
    if(stopRequested)return;
    try{
      if(!input.isTTY||!output.isTTY)throw Error();
      const bytes=typeof chunk==='string'?Buffer.from(chunk):chunk;
      if(!Buffer.isBuffer(bytes))throw Error();
      for(const byte of bytes){
        if(stopRequested)break;
        if(byte===10||byte===13){
          const accepted=!discardCommand&&command.trim().toLowerCase()==='r',notice=discardCommand||command.trim().length>0;
          command='';discardCommand=false;
          if(accepted)restart();else if(notice)writeInstruction();
        }else if(!discardCommand){
          // Bounded ASCII command only: never retain/echo arbitrary pasted
          // text, terminal escape sequences or accidentally entered secrets.
          if(![32,82,114].includes(byte)||command.length>=16){command='';discardCommand=true;}
          else command+=String.fromCharCode(byte);
        }
      }
    }catch{inputFailed();}
  }
  try{
    // Register before the first asynchronous resource allocation, not after ready.
    target.on('SIGINT',stop);target.on('SIGTERM',stop);
    output.write('Carebridge 가상 자료 전용 E 실행기를 준비합니다. 실제 아동 자료를 입력하지 마세요.\n검사 환경 준비에는 몇 분이 걸릴 수 있습니다. Ctrl+C는 안전한 준비 취소/종료 요청입니다.\n');
    // Signals and pending promises do not retain Node's event loop. Keep
    // ownership alive even when only failed final cleanup remains. This
    // referenced timer performs no work, retries, timeout or forced exit.
    keepAlive=setInterval(()=>{},60_000);
    // The static site's pure CLI tests must not import PostgreSQL or Windows
    // runtime dependencies. Load them only for an actual, confirmed TTY run.
    const createSession=create??(await loadRuntime()).createWindowsSyntheticSession;
    if(stopRequested)return;
    if(!input.isTTY||!output.isTTY)throw Error();
    session=createSession(captured);if(stopRequested)stop();
    const ready=await session.ready;
    if(stopRequested){await closeSession();return;}
    try{
      if(!input.isTTY||!output.isTTY)throw Error();
      const id=options.mode==='ephemeral'?null:retainedId(session.status());
      output.write(`\n준비 완료: ${ready.origin}\n같은 PC의 일반 창과 별도 프로필/시크릿 창에서 각각 로그인하세요.\n`);
      if(options.mode==='ephemeral')output.write('가상 사진·영상만 첨부하세요. E 저장 자료는 이 실행 중 새로고침/재접속으로 유지됩니다.\n이 기본 임시 모드는 종료 뒤 같은 세션을 재개할 수 없습니다. 새 실행은 새 가상 계정입니다.\n');
      else{
        output.write(`가상 자료 전용 보존 세션 UUID: ${id}\n${options.mode==='resume'?'처음 발급받은 가상 계정으로 다시 로그인하세요. 계정이나 비밀번호를 새로 만들거나 다시 출력하지 않습니다.':'아래 가상 로그인 정보를 별도로 안전하게 보관하세요. 이 터미널에서 한 번만 표시하며, 재개할 때는 다시 출력하지 않습니다.'}\n`);
        output.write(retentionLimit);
      }
      // Resume must not even read the credentials getter. Authentication uses
      // the original account, not a newly seeded or recovered password.
      for(const account of options.mode==='resume'?[]:session.credentials){
        if(stopRequested)break;
        if(!input.isTTY||!output.isTTY)throw Error();
        output.write(`\n${account.role==='therapist'?'가상 치료사':'가상 보호자'}\n이메일: ${account.email}\n시험 비밀번호: ${account.password}\n`);
      }
    }finally{forget();}
    if(typeof session.restartApi==='function'){
      if(typeof input.on!=='function'||typeof input.off!=='function')throw Error();
      inputOwned=true;input.on('data',readCommand);input.on('end',inputEnded);input.on('error',inputFailed);
      writeInstruction();
    }
    output.write('\n종료: Ctrl+C. 외부 접속·실제 자료·자동 시작은 활성화하지 않았습니다.\n');
    reportStopped(await session.waitForStop());
  }catch{
    if(!stopRequested||session?.status().failed)warn('가상 E 실행을 완료하지 못했습니다. 기존 실행/미확인 종료 잠금, 로컬 런타임 및 Docker 준비 상태를 확인하세요.\n');
    try{forget();}catch{fail();}
    await closeSession();
  }finally{
    try{forget();}catch{fail();}
    if(!session||session.status().phase==='stopped')releaseLifetime();
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runSyntheticEApi(process.argv.slice(2));
