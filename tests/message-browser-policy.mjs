import path from 'node:path';
import {studyChildEnvironment} from '../scripts/p0-study-policy.mjs';

const fail=()=>{throw new Error('MESSAGE_BROWSER_TEST_CONFIGURATION');};
const loopback=new Set(['127.0.0.1','localhost','[::1]']);
const runIdPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function endpoint(value,protocols){
  if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f]/.test(value))fail();
  let url;try{url=new URL(value);}catch{fail();}
  if(!loopback.has(url.hostname)||!protocols.includes(url.protocol)||url.username||url.password||url.search||url.hash||!url.port)fail();
  return url.href;
}
export function messageBrowserConnection({wsEndpoint,cdpUrl}={}){
  const useWs=wsEndpoint!==undefined;
  if(useWs===(cdpUrl!==undefined))fail();
  return Object.freeze(useWs
    ? {kind:'playwright',url:endpoint(wsEndpoint,['ws:'])}
    : {kind:'cdp',url:endpoint(cdpUrl,['http:','ws:'])});
}
export function messageBrowserOptions(args,env=process.env){
  if(!Array.isArray(args)||args.length!==1||args[0]!=='--confirm-synthetic-local')fail();
  const module=env.PLAYWRIGHT_MODULE,executable=env.STUDY_CHROMIUM_EXECUTABLE;
  for(const value of [module,executable])if(typeof value!=='string'||!path.isAbsolute(value)||/[\x00-\x1f\x7f]/.test(value))fail();
  return Object.freeze({module,executable});
}
export function messageBrowserRunId(value){if(typeof value!=='string'||!runIdPattern.test(value))fail();return value;}
export function messageBrowserEnvironment(env,{module,wsEndpoint,origin,runId}){
  const connection=messageBrowserConnection({wsEndpoint});
  const app=endpoint(origin,['http:']);
  if(new URL(app).pathname!=='/'||typeof module!=='string'||!path.isAbsolute(module))fail();
  return {...studyChildEnvironment(env),PLAYWRIGHT_MODULE:module,PLAYWRIGHT_WS_ENDPOINT:connection.url,
    APP_URL:app,MESSAGE_TEST_RUN_ID:messageBrowserRunId(runId)};
}
