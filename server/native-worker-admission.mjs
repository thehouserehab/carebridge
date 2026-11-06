// Fresh native test child only. Bootstrap delivery/control-ready do not mean
// that DB privilege validation and worker admission have actually completed.
import {ChildProcess} from 'node:child_process';
import {syntheticWorkerAdmissionFrame} from './windows-synthetic-worker-policy.mjs';
const unavailable=()=>new Error('NATIVE_WORKER_ADMISSION_FAILED');

export function observeNativeWorkerAdmission(child,control,{instanceId,mode,observationMilliseconds=30000}={}) {
  const frame=syntheticWorkerAdmissionFrame(instanceId);
  if(!(child instanceof ChildProcess)||!child.stdout||!control||
      typeof control.status!=='function'||typeof control.requestStop!=='function'||typeof control.waitForExit!=='function'||
      !['complete','hold-input'].includes(mode)||!Number.isInteger(observationMilliseconds)||
      observationMilliseconds<1||observationMilliseconds>30000)throw unavailable();
  const admittedBytes=Buffer.byteLength(frame),expected=Buffer.from(frame+(mode==='hold-input'?'NATIVE_PREPARING\n':''));
  const readiness=Promise.withResolvers(),listeners=[];readiness.promise.catch(()=>{});
  let offset=0,admitted=false,invalid=false,failed=false,timedOut=false,ended=false,disposed=false,timer;
  const fault=(badOutput=false)=>{
    failed=true;invalid ||= badOutput;readiness.reject(unavailable());clearTimeout(timer);
    try {void control.requestStop().catch(()=>{});} catch {}
  };
  const inspect=()=>{
    const state=control.status();
    if(state.failureCode||state.terminal||state.stopRequested){failed=true;readiness.reject(unavailable());clearTimeout(timer);return;}
    if(!admitted&&offset>=admittedBytes&&state.controlReady&&!failed){
      admitted=true;readiness.resolve();clearTimeout(timer);
    }
  };
  const output=bytes=>{
    if(invalid)return;
    if(!(bytes instanceof Uint8Array)||ended||offset+bytes.length>expected.length){fault(true);return;}
    for(const byte of bytes)if(byte!==expected[offset++]){fault(true);return;}
    inspect();
  };
  const end=()=>{
    ended=true;
    if(offset!==admittedBytes&&offset!==expected.length)fault(true);
    else inspect();
  };
  const stop=()=>{failed=true;readiness.reject(unavailable());clearTimeout(timer);};
  const dispose=()=>{
    if(disposed)return;disposed=true;stop();
    for(const [target,name,listener] of listeners)target.removeListener(name,listener);
  };
  for(const [target,name,listener] of [[child.stdout,'data',output],[child.stdout,'end',end],
    [child.stdout,'error',()=>fault()],[child,'message',inspect],[child,'error',()=>fault()],
    [child,'disconnect',stop],[child,'exit',stop],[child,'close',dispose]]){
    target.on(name,listener);listeners.push([target,name,listener]);
  }
  void control.waitForExit().then(dispose,dispose);
  timer=setTimeout(()=>{timedOut=true;fault();},observationMilliseconds);timer.unref?.();
  inspect();
  return Object.freeze({ready:readiness.promise,status:()=>Object.freeze({admitted,
    preparing:mode==='hold-input'&&offset===expected.length&&!invalid,
    invalidOutput:invalid,observationTimedOut:timedOut})});
}
