// Explicit real-E verification of the exact human launcher composition.
// No TTY credential output, HTTP bypass, media approval double or SQL mutations.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createWindowsSyntheticSession} from '../server/windows-synthetic-session.mjs';
import {exercisePreparedMediaBrowser} from './native-prepared-media-browser-helper.mjs';
import {exerciseRecordAttachmentsBrowser} from './native-record-attachments-browser-helper.mjs';
import {exerciseFeedbackAttachmentsBrowser,feedbackSessionCheckOptions,feedbackAttachmentSamples} from './native-feedback-attachments-browser-helper.mjs';
import {exerciseApiRestartBrowser} from './native-api-restart-browser-helper.mjs';
import {syntheticPng} from '../server/image-metadata-test-fixtures.mjs';
import {nativeSyntheticVideoBytes} from './native-video-fixture.mjs';

const {args,recordAttachments,feedbackAttachments,apiRestart=false,replyAttachments=false}=feedbackSessionCheckOptions(process.argv.slice(2));
const runId=randomUUID(),report={runId,mode:replyAttachments?'reply-attachments':apiRestart?'api-restart':feedbackAttachments?'feedback-attachments':recordAttachments?'record-attachments':'prepared-messages',startedAt:new Date().toISOString(),passed:false,
  runtime:{node:process.versions.node,v8:process.versions.v8,uv:process.versions.uv,platform:process.platform,arch:process.arch},
  phase:'START',failure:null,browser:null,...(apiRestart?{restartBrowser:null}:{}),cleanup:null,phases:[],
  limitations:['Synthetic accounts/data only; loopback and isolated Chromium contexts, not independent devices or actual beta users.',
    apiRestart?'Fresh session; planned API-only restart, not PostgreSQL/worker/power-loss recovery. No real-child-data approval.'
      :'Fresh session per invocation. This mode does not exercise same-session restart; no real-child-data approval.']};
let session,duplicate,timer,credentials=[];
const browserOwners=[];
const observe=()=>{const current=session?.status().phase;if(current&&report.phases.at(-1)!==current){report.phases.push(current);process.stdout.write(`SESSION_PHASE=${current}\n`);}};
try{
  report.phase='SESSION_READY';session=createWindowsSyntheticSession(args);timer=setInterval(observe,10000);timer.unref();
  const ready=await session.ready;observe();assert.equal(session.status().ready,true);
  report.phase='EXCLUSIVE_SESSION';duplicate=createWindowsSyntheticSession(args);
  await assert.rejects(duplicate.ready);await duplicate.close();
  assert.equal(duplicate.status().storage.secretsDisposed,true);assert.equal(session.status().ready,true);
  report.exclusiveSession=true;
  const seed=session.seed,room=seed.rooms[0];credentials=session.credentials.map(value=>({...value}));
  session.forgetCredentials();assert.equal(session.credentials.length,0);
  report.phase='BROWSER_FLOW';
  const exercise=feedbackAttachments?exerciseFeedbackAttachmentsBrowser:recordAttachments?exerciseRecordAttachmentsBrowser:exercisePreparedMediaBrowser;
  const firstBrowser=await exercise({origin:ready.origin,centerId:seed.centerId,conversationId:room.conversationId,
    careContext:{goalId:room.goalId,appointmentId:room.appointmentId,guardianId:seed.guardian.userId,
      ...(replyAttachments?{otherConversationId:seed.rooms[1].conversationId}:{})},
    ...(replyAttachments?{replyAttachments:true}:{}),
    credentials:apiRestart?credentials.map(value=>({...value})):credentials,...(apiRestart?{prepareRestart:true}:{}),
    samples:feedbackAttachments?feedbackAttachmentSamples():[{type:'image/png',bytes:syntheticPng()},{type:'video/mp4',bytes:nativeSyntheticVideoBytes()}],
    evidenceDirectory:fileURLToPath(new URL(`../test-results/${feedbackAttachments?'native-feedback-attachments':recordAttachments?'native-record-attachments':'native-prepared'}-${runId}`,import.meta.url)),
    browserRuntime:{module:process.env.PLAYWRIGHT_MODULE,executable:process.env.STUDY_CHROMIUM_EXECUTABLE},
    onOwned:value=>{browserOwners.push(value);}});
  // structuredClone drops the deliberately non-enumerable memory handoff.
  // Never spread checkpoint/request/credential data into persisted reports.
  report.browser=structuredClone(firstBrowser);
  assert(report.browser.passed&&Object.values(recordAttachments||feedbackAttachments?report.browser.checks:report.browser.care).every(Boolean));
  if(apiRestart){
    report.phase='API_RESTART';assert(firstBrowser.restartCheckpoint);
    assert.equal(firstBrowser.cleanup.contextsClosed,true);assert.equal(firstBrowser.cleanup.browserStopped,true);
    assert.equal(firstBrowser.cleanupObservationTimedOut,false);
    assert.equal(browserOwners.at(-1).status().contextsClosed,true);assert.equal(browserOwners.at(-1).status().browserStopped,true);
    assert.equal(session.status().apiGeneration,1);
    const next=await session.restartApi();
    assert.equal(next.apiGeneration,2);assert.equal(session.status().apiGeneration,2);assert.equal(session.status().ready,true);
    const retired=session.status().apiRestarts;
    assert.equal(retired.length,1);assert.equal(retired[0].generation,1);
    const old=retired[0].status;
    assert(old.terminal&&old.stopped&&old.closeObserved&&old.stdioClosed&&old.exitCode===0&&old.signalCode===null&&!old.observationTimedOut&&!old.failureCode);
    report.phase='RESTART_BROWSER_FLOW';
    report.restartBrowser=await exerciseApiRestartBrowser({origin:next.origin,apiGeneration:next.apiGeneration,
      centerId:seed.centerId,conversationId:room.conversationId,credentials,checkpoint:firstBrowser.restartCheckpoint,
      evidenceDirectory:fileURLToPath(new URL(`../test-results/native-api-restart-${runId}`,import.meta.url)),
      browserRuntime:{module:process.env.PLAYWRIGHT_MODULE,executable:process.env.STUDY_CHROMIUM_EXECUTABLE},
      onOwned:value=>{browserOwners.push(value);}});
    assert(report.restartBrowser.passed&&Object.values(report.restartBrowser.checks).every(Boolean));
    assert.equal(report.restartBrowser.source.sha256,report.browser.source.sha256);
  }
  report.phase='CLEANUP';
}catch(error){
  report.failure={phase:report.phase,code:'SYNTHETIC_SESSION_CHECK_FAILED'};
  if(error.browserObservation){if(report.phase==='RESTART_BROWSER_FLOW')report.restartBrowser=error.browserObservation;else report.browser=error.browserObservation;}
}finally{
  clearInterval(timer);
  for(const credential of credentials){credential.email='';credential.password='';}credentials.length=0;
  try{for(const owner of [...browserOwners].reverse())await owner.close();await duplicate?.close();await session?.close();}
  catch{report.failure??={phase:'CLEANUP',code:'SYNTHETIC_SESSION_CLEANUP_UNCONFIRMED'};}
  report.cleanup=session?.status()??null;
  report.finishedAt=new Date().toISOString();
  report.passed=!report.failure&&report.cleanup?.phase==='stopped'&&!report.cleanup.failed&&report.cleanup.storage.secretsDisposed===true;
  await writeFile(new URL(`../test-results/synthetic-e-session-${runId}.json`,import.meta.url),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({runId,passed:report.passed,failure:report.failure,cleanup:report.cleanup,browserFailure:report.browser?.failure,
    ...(apiRestart?{restartBrowserFailure:report.restartBrowser?.failure}:{})})+'\n');
  if(!report.passed)process.exitCode=1;
}
