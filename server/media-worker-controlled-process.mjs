// Opt-in adapter for an already inherited Node IPC channel. No named pipe,
// socket listener, process launch, service install, restart or force exit.
import {controlUnavailable,mediaWorkerControlId,mediaWorkerControlMessage,parseMediaWorkerControlMessage} from './media-worker-control-protocol.mjs';
import {runWindowsMediaWorkerProcess} from './windows-media-worker-process.mjs';
const active = new WeakSet();
const events = ['message','disconnect'];
export async function runMediaWorkerControlledProcess(work,options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      !Object.hasOwn(options,'instanceId') || Object.keys(options).some((key) => !['instanceId','targetProcess'].includes(key))) throw controlUnavailable();
  const instanceId=mediaWorkerControlId(options.instanceId),target=Object.hasOwn(options,'targetProcess') ? options.targetProcess : process;
  if (typeof work !== 'function' || !target || target.connected !== true || !target.channel ||
      !['on','removeListener','listenerCount','send','disconnect'].every((key) => typeof target[key] === 'function') ||
      active.has(target) || events.some((name) => target.listenerCount(name))) throw controlUnavailable();
  const send=target.send.bind(target),disconnect=target.disconnect.bind(target),controller=new AbortController(),registered=[];
  let failed=false,finishing=false,requestId=null,chain=Promise.resolve();
  const fault=() => {failed=true;controller.abort();};
  const notify=(kind) => {
    // At most ready, one acceptance, one terminal report. Duplicate stops do
    // not grow the queue; send(false) is backpressure, not delivery failure.
    chain=chain.then(() => new Promise((yes,no) => {
      if (target.connected !== true) return no(controlUnavailable());
      try {send(mediaWorkerControlMessage(instanceId,kind,kind==='control-ready' ? null : requestId),(error) => error ? no(controlUnavailable()) : yes());}
      catch {no(controlUnavailable());}
    })).catch(fault);
  };
  const message=(value,handle) => {
    try {
      const parsed=parseMediaWorkerControlMessage(value,instanceId,'parent',handle);
      // Seal the bounded send queue before its terminal report. A late new
      // command cannot append acceptance behind drain or outlive cleanup.
      if (finishing) {if(requestId!==parsed.requestId)fault();return;}
      if (requestId !== null) {if (parsed.requestId !== requestId) fault();return;}
      requestId=parsed.requestId;controller.abort();notify('stop-accepted');
    } catch {fault();}
  };
  active.add(target);
  try {
    for (const [name,listener] of [['message',message],['disconnect',fault]]) {target.on(name,listener);registered.push([name,listener]);}
    notify('control-ready');await chain;
    if (!failed) {
      try {
        const result=await work(controller.signal);
        if (!result || result.stopped !== true || !Number.isSafeInteger(result.processed) || result.processed<0) fault();
      } catch {fault();}
    }
    // A disconnect/protocol fault never returns early while owned work drains.
    await chain;finishing=true;notify(failed ? 'failed' : 'drained');await chain;
  } catch {fault();}
  finally {
    for (const [name,listener] of registered) target.removeListener(name,listener);
    active.delete(target);
    if (target.connected === true) try {disconnect();} catch {fault();}
    if (failed && [undefined,null,0].includes(target.exitCode)) target.exitCode=1;
  }
  if (failed) throw controlUnavailable();
  return Object.freeze({drained:true});
}

export function runWindowsMediaWorkerControlledProcess(input,options) {
  const targetProcess=options && Object.hasOwn(options,'targetProcess') ? options.targetProcess : process;
  return runMediaWorkerControlledProcess((signal) => runWindowsMediaWorkerProcess(input,{signal,targetProcess}),options);
}
