// Explicit synthetic check only: a frozen public snapshot and a freshly owned
// headless browser server. No existing tabs/profiles, DB, .env or API activation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {captureWorkingSnapshot,serveStudySnapshot} from '../scripts/p0-study-snapshots.mjs';
import {studyChildEnvironment} from '../scripts/p0-study-policy.mjs';
import {messageBrowserEnvironment,messageBrowserOptions} from './message-browser-policy.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const timeout=(promise,milliseconds)=>{
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('MESSAGE_BROWSER_CLEANUP_TIMEOUT')),milliseconds);})])
    .finally(()=>clearTimeout(timer));
};
export function waitForMessageBrowserChild(child){
  return new Promise(resolve=>{
    let failed=false;
    child.once('error',()=>{failed=true;});
    // An error is not evidence of process/pipe termination. Node emits close
    // after exit or spawn failure; retain ownership until that observation.
    child.once('close',(code,signal)=>resolve({code,signal,failed,closed:true}));
  });
}
export async function runLocalMessageCheck(args=process.argv.slice(2)){
  const options=messageBrowserOptions(args);
  for(const file of [options.module,options.executable])assert((await lstat(file)).isFile(),'Existing local test runtime required; no installation');
  const {chromium}=await import(pathToFileURL(options.module).href);
  const snapshot=await captureWorkingSnapshot(root);
  const runId=randomUUID(),folder=path.join(root,'test-results',`message-check-${runId}`);
  await mkdir(folder);
  const result={runId,at:new Date().toISOString(),passed:false,source:snapshot.manifest,
    check:null,failure:null,cleanup:{browserStopped:false,serverClosed:false},
    limitations:['Synthetic roles and localStorage/IndexedDB only; no actual login, API, cross-device delivery or independent backup.',
      'Chromium viewport emulation is not physical iOS/Android or human usability evidence.']};
  let server,browserServer,browserProcess;
  try{
    server=await serveStudySnapshot(snapshot);
    browserServer=await chromium.launchServer({headless:true,executablePath:options.executable,
      host:'127.0.0.1',port:0,env:studyChildEnvironment(),timeout:30_000});
    browserProcess=browserServer.process();
    result.publicServerStatus=(await fetch(server.origin)).status;
    assert.equal(result.publicServerStatus,200);
    console.log('VERIFY message authoring → clinical reference → edit/delete at 320/390/1440px');
    const child=spawn(process.execPath,[fileURLToPath(new URL('./message-lifecycle-browser.mjs',import.meta.url))],{
        cwd:root,windowsHide:true,stdio:['ignore','inherit','inherit'],timeout:180_000,
        env:messageBrowserEnvironment(process.env,{module:options.module,wsEndpoint:browserServer.wsEndpoint(),origin:server.origin,runId})});
    const outcome=await waitForMessageBrowserChild(child);result.childExit=outcome;
    const check=JSON.parse(await readFile(path.join(root,'test-results',`messages-${runId}`,'results.json'),'utf8'));
    assert.equal(check.runId,runId);result.check=check;result.browserVersion=check.browserVersion;
    assert.equal(outcome.code,0);assert.equal(outcome.signal,null);assert.equal(outcome.failed,false);assert.equal(check.passed,true);
    assert.equal(check.checks.length,3);assert.deepEqual(check.errors,[]);assert.deepEqual(check.unexpectedRequests,[]);
  }catch{
    // Detailed browser failure is in its synthetic report; never log a browser
    // control URL, environment, credentials or arbitrary launcher error text.
    result.failure='MESSAGE_BROWSER_CHECK_FAILED';
  }finally{
    if(browserServer){
      try{await timeout(browserServer.close(),10_000);}catch{
        try{await timeout(browserServer.kill(),10_000);}catch{/* Failed cleanup is not success. */}
      }
      result.cleanup.browserStopped=typeof browserProcess?.exitCode==='number'||typeof browserProcess?.signalCode==='string';
    }
    if(server)try{await timeout(server.close(),10_000);result.cleanup.serverClosed=true;}catch{/* Remains failed. */}
    result.passed=!result.failure&&result.cleanup.browserStopped&&result.cleanup.serverClosed;
    await writeFile(path.join(folder,'results.json'),JSON.stringify(result,null,2));
    await writeFile(path.join(root,'test-results','message-local-results.json'),JSON.stringify(result,null,2));
  }
  console.log(JSON.stringify({runId,passed:result.passed,checks:result.check?.checks.length??0,cleanup:result.cleanup,failure:result.failure}));
  return result.passed;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(!await runLocalMessageCheck())process.exitCode=1;}
  catch{console.error('MESSAGE_BROWSER_TEST_CONFIGURATION_OR_STARTUP_FAILED');process.exitCode=1;}
}
