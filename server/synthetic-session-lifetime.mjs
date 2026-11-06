// Trusted composition contract, with deterministic doubles in unit tests.
// No provider input from HTTP/CLI; the Windows factory supplies this plan.
const unavailable=()=>new Error('SYNTHETIC_SESSION_UNAVAILABLE');
const maximumApiRestarts=10;
const terminalApi=state=>state?.terminal===true&&state.stopped===true&&state.stopRequested===true&&
  state.closeObserved===true&&state.stdioClosed===true&&state.exitCode===0&&state.signalCode===null&&
  state.failureCode===null&&state.spawnFailed===false&&state.observationTimedOut===false;
const terminalWorker=state=>state?.terminal===true&&state.stopRequested===true&&state.stopAccepted===true&&state.drainReported===true&&
  state.closeObserved===true&&state.stdioClosed===true&&state.exitCode===0&&state.signalCode===null&&
  state.failureCode===null&&state.spawnFailed===false&&state.observationTimedOut===false;
const freeze=value=>{
  if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}
  return value;
};
function apiSnapshot(child){
  const state=child.status(),keys=['ready','stopRequested','stopped','terminal','closeObserved','spawnFailed','stdioClosed',
    'observationTimedOut','exitCode','signalCode','failureCode','eventTimeline','resourceObservations'];
  return freeze(structuredClone(Object.fromEntries(keys.filter(key=>Object.hasOwn(state,key)).map(key=>[key,state[key]]))));
}
export function ownSyntheticSession(plan) {
  if(!plan||['storage','media','worker','api'].some(key=>typeof plan[key]!=='function'))throw unavailable();
  const controller=new AbortController(),ready=Promise.withResolvers(),stopped=Promise.withResolvers();
  ready.promise.catch(()=>{});stopped.promise.catch(()=>{});
  let storage,media,worker,api,origin,seed,phase='starting',failurePhase=null,failed=false,closing=false,closePromise,startPromise,restartPromise;
  let apiGeneration=0,everReady=false;
  const ownedApis=new Set(),apiRestarts=[];
  const checkpoint=()=>controller.signal.throwIfAborted();
  const healthy=child=>{const state=child?.status();return state?.ready===true&&!state.terminal&&!state.stopRequested&&!state.failureCode;};
  const isReady=()=>phase==='ready'&&!closing&&!failed&&healthy(worker)&&healthy(api?.child);
  const status=()=>Object.freeze({phase,failurePhase,ready:isReady(),stopRequested:closing,failed,apiGeneration,
    api:api?.child.status()??null,apiRestarts:Object.freeze([...apiRestarts]),
    worker:worker?.status()??null,storage:storage?.status()??null,media:media?.diagnostics?.()??null});
  const stopChild=async child=>{
    if(!child)return;
    try{await child.close();}catch{failed=true;if(!child.status().terminal)throw unavailable();}
    if(!child.status().terminal)throw unavailable();
  };
  function close(){
    closing=true;controller.abort();seed?.forgetCredentials();
    if(closePromise)return closePromise;
    closePromise=(async()=>{
      phase='stopping';
      // Interrupt startup admission without awaiting the startup that needs
      // this stop. Storage/engine cleanup still waits for that same startup.
      await stopChild(api?.child??worker);
      await startPromise.catch(()=>{});
      // Restart never awaits this close: this one-way join avoids a shutdown
      // cycle and captures a replacement registered during cancellation.
      await restartPromise?.catch(()=>{});
      for(const child of ownedApis)await stopChild(child);
      await stopChild(worker);
      await storage?.closeConnections();
      await storage?.stopDatabase();
      await media?.close();
      const clean=everReady&&!failed&&[...ownedApis].every(child=>terminalApi(child.status()))&&terminalWorker(worker?.status());
      await storage?.disposeSecrets({clean});
      phase='stopped';stopped.resolve(Object.freeze({stopped:true,failed}));
      return Object.freeze({stopped:true,failed});
    })().catch(()=>{failed=true;phase='stop-unconfirmed';closePromise=undefined;throw unavailable();});
    closePromise.catch(()=>{});return closePromise;
  }
  const observeChild=(child,slot)=>{
    // A planned old generation is retired by restart's stricter close gate.
    // Its late notifications must not close an unrelated replacement.
    const retired=()=>slot&&(slot.retiring||slot.retired);
    child.waitForExit().then(()=>{if(!closing&&!retired()){failed=true;void close();}},()=>{
      if(!retired()){failed=true;void close();}
    });
    child.waitForUnavailable?.().then(()=>{if(!closing&&!retired()){failed=true;void close();}});
    if(closing)void child.close().catch(()=>{});
  };
  const validChild=child=>child&&['close','status','waitForExit'].every(key=>typeof child[key]==='function');
  const ownWorker=child=>{
    if(!validChild(child)||worker)throw unavailable();
    worker=child;observeChild(child);
  };
  const launchApi=async()=>{
    const slot={generation:apiGeneration+1,child:null,retiring:false,retired:false};
    const launched=await plan.api({storage,onOwned:child=>{
      if(!validChild(child))throw unavailable();
      // Register before readiness, including a late callback after whole close.
      ownedApis.add(child);
      if(slot.child){void child.close().catch(()=>{});throw unavailable();}
      slot.child=child;api=slot;apiGeneration=slot.generation;observeChild(child,slot);
    }});
    checkpoint();
    if(failed||!healthy(worker)||api!==slot||!healthy(slot.child)||typeof launched?.origin!=='string')throw unavailable();
    origin=launched.origin;return Object.freeze({origin,apiGeneration});
  };
  function restartApi(...args){
    if(args.length||closing||failed)return Promise.reject(unavailable());
    if(restartPromise)return restartPromise;
    if(!isReady()||apiRestarts.length>=maximumApiRestarts)return Promise.reject(unavailable());
    const previous=api;
    phase='restarting-api';origin=undefined;previous.retiring=true;
    restartPromise=Promise.resolve().then(async()=>{
      await previous.child.close();checkpoint();
      if(!terminalApi(previous.child.status())||!healthy(worker)||api!==previous)throw unavailable();
      apiRestarts.push(Object.freeze({generation:previous.generation,status:apiSnapshot(previous.child)}));
      previous.retired=true;ownedApis.delete(previous.child);
      const result=await launchApi();checkpoint();
      phase='ready';return result;
    }).catch(()=>{
      if(!closing){failurePhase='restarting-api';failed=true;void close();}
      throw unavailable();
    }).finally(()=>{restartPromise=undefined;});
    return restartPromise;
  }
  startPromise=Promise.resolve().then(async()=>{
    checkpoint();phase='storage';
    storage=plan.storage();await storage.initialize(controller.signal);checkpoint();seed=storage.seed;
    phase='media';media=await plan.media({signal:controller.signal,onOwned:value=>{media=value;}});checkpoint();
    const scan=await media.scanner.status({signal:controller.signal});if(scan.available!==true)throw unavailable();checkpoint();
    phase='worker';await plan.worker({storage,media,onOwned:ownWorker});checkpoint();
    if(!healthy(worker))throw unavailable();
    phase='api';await launchApi();checkpoint();
    phase='ready';everReady=true;ready.resolve(Object.freeze({origin}));
  });
  startPromise.catch(()=>{if(!closing)failurePhase=phase;failed=!closing||failed;ready.reject(unavailable());void close();});
  const result={ready:ready.promise,restartApi,close,status,waitForStop:()=>stopped.promise,forgetCredentials:()=>seed?.forgetCredentials()};
  Object.defineProperties(result,{credentials:{get:()=>isReady()?seed?.credentials:[]},
    seed:{get:()=>seed},origin:{get:()=>isReady()?origin:undefined}});
  return Object.freeze(result);
}
