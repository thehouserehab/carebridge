// Strict synthetic-only IPC bootstrap. Not operating configuration or a public
// launcher. No passwords, DB URL, host path or arbitrary command in media data.
import {databaseCredentialOptions} from './windows-database-credential-policy.mjs';
import {windowsDatabaseServiceOptions} from './windows-database-service.mjs';
import {win32} from 'node:path';
import {MEDIA_WORKER_STAGE_NAMES} from './media-worker-observation.mjs';
import {WINDOWS_DATABASE_STAGES} from './windows-database-observation.mjs';
const unavailable=()=>new Error('WINDOWS_NATIVE_WORKER_TEST_UNAVAILABLE');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
export function windowsNativeWorkerBootstrap(input) {
  try {
    if(!exact(input,['purpose','database','mediaRoot','nativeMedia','mode'])||input.purpose!=='synthetic-carebridge-native-worker'||
        !['complete','hold-input'].includes(input.mode)||!exact(input.database,['storage','credentialId','privileges','endpoint'])||
        !exact(input.nativeMedia,['engineIdentity','approvedImageId','scannerEndpoint'])||
        !exact(input.nativeMedia.scannerEndpoint,['host','port']))throw unavailable();
    const storage=databaseCredentialOptions(input.database.storage),parsed=windowsDatabaseServiceOptions({...input.database,kind:'worker'});
    const {engineIdentity,approvedImageId,scannerEndpoint}=input.nativeMedia;
    if(!storage.syntheticRunId||parsed.connection.ssl===false||parsed.connection.ssl.ca===undefined||
        input.mediaRoot!==win32.join(storage.privateRoot,'checks',`postgres-check-${storage.syntheticRunId}`,'source-media')||
        typeof engineIdentity!=='string'||!/^[a-zA-Z0-9:_-]{12,80}$/.test(engineIdentity)||
        typeof approvedImageId!=='string'||!/^sha256:[a-f0-9]{64}$/.test(approvedImageId)||
        scannerEndpoint.host!=='127.0.0.1'||!Number.isInteger(scannerEndpoint.port)||scannerEndpoint.port<1||scannerEndpoint.port>65535)throw unavailable();
    return Object.freeze({database:Object.freeze({storage:parsed.storage,credentialId:parsed.credentialId,privileges:parsed.privileges,
      endpoint:Object.freeze({host:parsed.connection.host,port:parsed.connection.port,ca:parsed.connection.ssl.ca})}),
      root:win32.dirname(input.mediaRoot),mediaRoot:input.mediaRoot,mode:input.mode,
      nativeMedia:Object.freeze({engineIdentity,approvedImageId,scannerEndpoint:Object.freeze({...scannerEndpoint})})});
  } catch {throw unavailable();}
}
// Versioned finite diagnostics for this synthetic child only. Polling has its
// own budget so idle loops cannot consume file-processing/lifecycle evidence.
// These are observations, never approval, readiness or OS termination proof.
const pollStages=new Set(['retained-recovery','object-cleanup','queue-claim']);
const lifecycleStages=new Set(['db-open','worker-admission','db-close']);
const stageGroup=stage=>pollStages.has(stage)?'P':lifecycleStages.has(stage)?'L':'W';
const stageBudgets=Object.freeze({P:128,W:1024,L:16});
const stageEdges=Object.freeze({B:'begin',C:'complete',F:'failed'});
const databaseBudget=128;
// Separate finite channel: an observation cannot impersonate worker readiness.
export function nativeDatabaseStageReporter(write) {
  if(typeof write!=='function')throw unavailable();
  let count=0,limited=false;
  return event=>{
    try {
      if(!event||typeof event!=='object')return;
      const fields=Object.getOwnPropertyDescriptors(event);
      if(Reflect.ownKeys(fields).length!==3||['stage','edge','elapsedMs'].some(key=>!fields[key]||!Object.hasOwn(fields[key],'value')))return;
      const index=WINDOWS_DATABASE_STAGES.indexOf(fields.stage.value),edge={begin:'B',complete:'C',failed:'F'}[fields.edge.value],elapsed=fields.elapsedMs.value;
      if(index<0||!['B','C','F'].includes(edge)||!Number.isSafeInteger(elapsed)||elapsed<0||elapsed>999999999)return;
      if(count>=databaseBudget){if(!limited){limited=true;write('NDL1\n');}return;}
      count++;write(`ND1:${String(index+1).padStart(2,'0')}:${edge}:${elapsed}\n`);
    }catch {}
  };
}
export function nativeWorkerStageReporter(write) {
  if(typeof write!=='function')throw unavailable();
  const counts={P:0,W:0,L:0},limited=new Set();
  return event=>{
    try {
      if(!event||typeof event!=='object')return;
      const fields=Object.getOwnPropertyDescriptors(event);
      if(Reflect.ownKeys(fields).length!==2||!Object.hasOwn(fields,'stage')||!Object.hasOwn(fields,'edge')||
          !Object.hasOwn(fields.stage,'value')||!Object.hasOwn(fields.edge,'value'))return;
      const index=MEDIA_WORKER_STAGE_NAMES.indexOf(fields.stage.value),edge={begin:'B',complete:'C',failed:'F'}[fields.edge.value];
      if(index<0||!['B','C','F'].includes(edge))return;
      const group=stageGroup(fields.stage.value);
      if(counts[group]>=stageBudgets[group]){
        if(!limited.has(group)){limited.add(group);write(`NL1:${group}\n`);}
        return;
      }
      counts[group]++;write(`NS1:${String(index+1).padStart(2,'0')}:${edge}\n`);
    } catch { /* Observation failure must not change the worker outcome. */ }
  };
}
// Complete lines are consumed exactly once, including fragmented chunks. Raw
// stderr is never returned; the temporary line prefix and history are bounded.
export function nativeWorkerStderrObserver() {
  let line='',bytes=0,phase=0,category=null,sequence=0,lineTruncated=false;
  const history=[],counts=MEDIA_WORKER_STAGE_NAMES.map(stage=>({stage,begin:0,complete:0,failed:0}));
  const limited={polling:false,work:false,lifecycle:false};
  let databaseSequence=0,databaseLimited=false;
  const databaseHistory=[],databaseCounts=WINDOWS_DATABASE_STAGES.map(stage=>({stage,begin:0,complete:0,failed:0}));
  const classify=value=>{
    if(/Assertion failed|Assertion \S+ failed|AssertionError/i.test(value))category='NATIVE_ASSERTION';
    else if(/FATAL ERROR|Fatal error/i.test(value))category='NATIVE_FATAL';
  };
  const consume=()=>{
    const value=line.endsWith('\r')?line.slice(0,-1):line;
    classify(value);
    if(!lineTruncated&&value==='NATIVE_CAUGHT'&&category===null)category='CAUGHT';
    if(!lineTruncated){
      const phaseMatch=/^NATIVE_PHASE_([1-6])$/.exec(value),stageMatch=/^NS1:(\d{2}):([BCF])$/.exec(value);
      const databaseMatch=/^ND1:(\d{2}):([BCF]):(0|[1-9]\d{0,8})$/.exec(value);
      if(phaseMatch)phase=Math.max(phase,Number(phaseMatch[1]));
      if(stageMatch){
        const item=counts[Number(stageMatch[1])-1],edge=stageEdges[stageMatch[2]];
        if(item){item[edge]++;history.push(Object.freeze({sequence:++sequence,stage:item.stage,edge}));if(history.length>32)history.shift();}
      }
      if(value==='NL1:P')limited.polling=true;
      else if(value==='NL1:W')limited.work=true;
      else if(value==='NL1:L')limited.lifecycle=true;
      if(value==='NDL1')databaseLimited=true;
      if(databaseMatch){
        const item=databaseCounts[Number(databaseMatch[1])-1],edge=stageEdges[databaseMatch[2]];
        if(item){item[edge]++;databaseHistory.push(Object.freeze({sequence:++databaseSequence,stage:item.stage,edge,elapsedMs:Number(databaseMatch[3])}));
          if(databaseHistory.length>64)databaseHistory.shift();}
      }
    }
    line='';lineTruncated=false;
  };
  return Object.freeze({feed(chunk){
    if(!(chunk instanceof Uint8Array))throw unavailable();
    bytes=Math.min(16385,bytes+chunk.length);if(bytes>16384){category='OUTPUT_LIMIT';line='';return;}
    for(const byte of chunk){
      if(byte===10){consume();continue;}
      if(line.length<256)line+=String.fromCharCode(byte);else lineTruncated=true;
    }
    // A native crash can end without a newline. Categorize the bounded prefix
    // but never accept an unfinished stage frame as an observed transition.
    classify(line);
  },snapshot:()=>Object.freeze({phase,category,outputLimitExceeded:bytes>16384,
    stageProtocol:1,stageEventCount:sequence,lastStage:history.at(-1)??null,
    stageHistory:Object.freeze([...history]),stageCounts:Object.freeze(counts.filter(item=>item.begin+item.complete+item.failed>0).map(item=>Object.freeze({...item}))),
    stageLimits:Object.freeze({...limited}),databaseProtocol:1,databaseEventCount:databaseSequence,
    databaseHistory:Object.freeze([...databaseHistory]),databaseCounts:Object.freeze(databaseCounts.filter(item=>item.begin+item.complete+item.failed>0).map(item=>Object.freeze({...item}))),
    databaseLimit:databaseLimited})});
}
