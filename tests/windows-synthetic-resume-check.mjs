// Full shutdown -> fresh Node process -> new browser, using disk custody only.
// This test retains its NEW synthetic session. Never prints/persists passwords.
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {windowsPostgresOptions,postgresCheckPaths} from '../server/windows-postgres-policy.mjs';
import {studyChildEnvironment} from '../scripts/p0-study-policy.mjs';
import {exerciseFeedbackAttachmentsBrowser,feedbackAttachmentSamples} from './native-feedback-attachments-browser-helper.mjs';
import {exerciseApiRestartBrowser} from './native-api-restart-browser-helper.mjs';
const args=process.argv.slice(2),options=windowsPostgresOptions(args),runId=randomUUID();
const report={runId,mode:'full-session-resume',startedAt:new Date().toISOString(),passed:false,phase:'START',failure:null,
  create:null,resume:null,browser:null,resumeBrowser:null,checks:{wholeProcessClosed:false,plaintextTlsRemoved:false,
    retainedKeysPresent:false,sameSession:false,noCredentialsOnResume:false,secondCleanStop:false},
  limitations:['Synthetic loopback only; not independent devices, power-loss recovery, real data approval or backup.',
    'Retained synthetic TLS expires two days after original creation; no automatic renewal.']};
const children=[],browserOwners=[];let credentials=[],checkpoint;
function childSession(selection){
  const child=fork(fileURLToPath(new URL('./synthetic-resume-process.mjs',import.meta.url)),[...selection,...args],
    {env:studyChildEnvironment(),execArgv:[],stdio:['ignore','pipe','pipe','ipc'],windowsHide:true,serialization:'json'});
  const ready=Promise.withResolvers(),closed=Promise.withResolvers();ready.promise.catch(()=>{});
  const value={pid:child.pid,status:null,exitCode:null,signal:null,actualClose:false,unexpectedOutput:false};let sentStop=false;
  child.stdout.on('data',()=>{value.unexpectedOutput=true;});child.stderr.on('data',()=>{value.unexpectedOutput=true;});
  child.on('error',()=>ready.reject(Error('CHILD_UNAVAILABLE')));
  child.on('message',message=>{
    if(message?.type==='ready')ready.resolve(message);
    else if(message?.type==='stopped')value.status=message.status;
    else if(message?.type==='unavailable'){value.failurePhase=message.phase;ready.reject(Error('CHILD_UNAVAILABLE'));}
    else if(message?.type==='stop-unconfirmed'){value.failurePhase=message.phase;ready.reject(Error('CHILD_STOP_UNCONFIRMED'));}
  });
  child.once('close',(code,signal)=>{value.exitCode=code;value.signal=signal;value.actualClose=true;
    value.stdioClosed=child.stdout.closed&&child.stderr.closed;ready.reject(Error('CHILD_CLOSED'));closed.resolve();});
  const owned={value,ready:ready.promise,async stop(){if(child.connected&&!sentStop){sentStop=true;child.send({type:'stop'});}
    await closed.promise;return value;}};children.push(owned);return owned;
}
const clean=value=>value.actualClose&&value.exitCode===0&&value.signal===null&&value.stdioClosed&&!value.unexpectedOutput&&
  value.status?.phase==='stopped'&&!value.status.failed&&value.status.storage.secretsRetained&&value.status.storage.resumable&&!value.status.storage.secretsDisposed;
const timer=setInterval(()=>process.stdout.write(`RESUME_PHASE=${report.phase}\n`),10000);timer.unref();
try{
  report.phase='CREATE_READY';const first=childSession(['--create-resumable']),created=await first.ready;
  credentials=created.credentials;const {seed}=created,room=seed.rooms[0],sessionId=created.status.storage.runId;
  report.sessionId=sessionId;assert.equal(credentials.length,2);
  report.phase='CREATE_BROWSER';
  const browser=await exerciseFeedbackAttachmentsBrowser({origin:created.origin,centerId:seed.centerId,conversationId:room.conversationId,
    careContext:{goalId:room.goalId,appointmentId:room.appointmentId,guardianId:seed.guardian.userId},
    credentials:credentials.map(item=>({...item})),samples:feedbackAttachmentSamples(),prepareRestart:true,
    evidenceDirectory:fileURLToPath(new URL(`../test-results/native-feedback-attachments-${runId}`,import.meta.url)),
    browserRuntime:{module:process.env.PLAYWRIGHT_MODULE,executable:process.env.STUDY_CHROMIUM_EXECUTABLE},onOwned:owner=>browserOwners.push(owner)});
  report.browser=structuredClone(browser);checkpoint=browser.restartCheckpoint;assert(browser.passed&&checkpoint);
  report.phase='FULL_SHUTDOWN';report.create=await first.stop();assert(clean(report.create));report.checks.wholeProcessClosed=true;
  const paths=postgresCheckPaths(options.privateRoot,sessionId);
  await assert.rejects(lstat(join(paths.root,'tls')),{code:'ENOENT'});
  await assert.rejects(lstat(join(options.privateRoot,'checks','.carebridge-interactive-session.json')),{code:'ENOENT'});
  report.checks.plaintextTlsRemoved=true;
  for(const name of [`session-vault-${sessionId}`,`credential-check-${sessionId}`])assert((await lstat(join(options.privateRoot,'checks',name))).isDirectory());
  report.checks.retainedKeysPresent=true;
  report.phase='FRESH_PROCESS_RESUME';const second=childSession(['--resume-session',sessionId]),resumed=await second.ready;
  assert.notEqual(second.value.pid,first.value.pid);assert.equal(resumed.status.storage.runId,sessionId);assert.deepEqual(resumed.seed,seed);
  report.checks.sameSession=true;assert.deepEqual(resumed.credentials,[]);report.checks.noCredentialsOnResume=true;
  report.phase='FRESH_BROWSER_RELOGIN';
  report.resumeBrowser=await exerciseApiRestartBrowser({origin:resumed.origin,apiGeneration:resumed.status.apiGeneration,restartKind:'session',
    centerId:seed.centerId,conversationId:room.conversationId,credentials,checkpoint,
    evidenceDirectory:fileURLToPath(new URL(`../test-results/native-session-resume-${runId}`,import.meta.url)),
    browserRuntime:{module:process.env.PLAYWRIGHT_MODULE,executable:process.env.STUDY_CHROMIUM_EXECUTABLE},onOwned:owner=>browserOwners.push(owner)});
  assert(report.resumeBrowser.passed);report.phase='SECOND_SHUTDOWN';report.resume=await second.stop();assert(clean(report.resume));
  await assert.rejects(lstat(join(paths.root,'tls')),{code:'ENOENT'});report.checks.secondCleanStop=true;
}catch(error){report.failure={code:'SYNTHETIC_RESUME_CHECK_FAILED',phase:report.phase};
  if(error.browserObservation){if(report.phase==='FRESH_BROWSER_RELOGIN')report.resumeBrowser=error.browserObservation;else report.browser=error.browserObservation;}
}finally{
  for(const item of credentials){item.email='';item.password='';}credentials=[];checkpoint=null;
  for(const owner of browserOwners.reverse())try{await owner.close();}catch{report.failure??={code:'BROWSER_CLOSE_UNCONFIRMED'};}
  for(const child of children)await child.stop();
  report.processes=children.map(item=>item.value);clearInterval(timer);report.finishedAt=new Date().toISOString();
  report.passed=!report.failure&&Object.values(report.checks).every(Boolean)&&report.processes.every(clean);
  await writeFile(new URL(`../test-results/synthetic-resume-${runId}.json`,import.meta.url),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({runId,passed:report.passed,phase:report.phase,failure:report.failure,
    processes:report.processes.map(item=>({pid:item.pid,exitCode:item.exitCode,phase:item.failurePhase,storage:item.status?.storage}))})+'\n');
  if(!report.passed)process.exitCode=1;
}
