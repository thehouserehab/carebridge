// Observe one caller-created, directly owned ChildProcess with inherited IPC.
// Sending/accepting stop and reporting drain are NOT terminal OS evidence.
// No kill, disconnect, timeout-success, adoption by PID or automatic restart.
import {ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {controlUnavailable,mediaWorkerControlId,mediaWorkerControlMessage,parseMediaWorkerControlMessage} from './media-worker-control-protocol.mjs';
const active = new WeakSet();
const events=['message','error','disconnect','exit','close'];
export function controlMediaWorkerChild(child,options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).join(',')!=='instanceId') throw controlUnavailable();
  const instanceId=mediaWorkerControlId(options.instanceId);
  if (!(child instanceof ChildProcess) || typeof child.send !== 'function' || child.exitCode!==null || child.signalCode!==null ||
      active.has(child) || events.some((name) => child.listenerCount(name))) throw controlUnavailable();
  const send=child.send.bind(child),terminal=Promise.withResolvers(),registered=[],streamListeners=[];
  // Capture the actual stdio handles before caller mutation. Do not consume,
  // destroy or replace them; their public close state is terminal evidence.
  const streams=Array.isArray(child.stdio) ? [...new Set(child.stdio.filter(Boolean))] : [];
  let ready=false,accepted=false,drained=false,failed=false,exited=false,closed=false,sent=false;
  let requestId=null,stop,exitCode=null,signalCode=null,pendingSends=0,completed=false,channelEnded=false;
  const stdioClosed=() => streams.every((stream)=>stream.closed===true);
  // Node 24.15 can omit ChildProcess.close after caller-initiated disconnect.
  // Only a FAILURE can settle from independently observed OS exit + actual
  // IPC disconnect + every captured pipe closed. Never synthesize close or
  // turn this alternative terminal proof into a successful drain.
  const isTerminal=() => closed || failed && exited && channelEnded && stdioClosed();
  terminal.promise.catch(() => {}); // The caller may first await stop acceptance.
  const markFailure=() => {failed=true;stop?.reject(controlUnavailable());};
  const sendStop=() => {
    if (sent || !requestId || child.connected!==true) return;
    sent=true;pendingSends++;
    try {send(mediaWorkerControlMessage(instanceId,'stop',requestId),(error) => {
      pendingSends--;if(error) markFailure();complete();
    });}
    catch {pendingSends--;markFailure();complete();}
  };
  const fault=() => {
    markFailure();
    // Only a single cooperative stop to this exact owned channel. Unknown
    // delivery is never retried or replaced with process.kill on Windows.
    requestId ??= randomUUID();sendStop();
  };
  const message=(value,handle) => {
    try {
      const parsed=parseMediaWorkerControlMessage(value,instanceId,'child',handle);
      if (parsed.kind==='failed') {fault();return;}
      if (parsed.kind==='control-ready') {
        if (ready || drained) throw controlUnavailable();ready=true;sendStop();return;
      }
      if (!ready || drained || parsed.requestId!==requestId) throw controlUnavailable();
      if (parsed.kind==='stop-accepted') {
        if (!requestId || !sent) throw controlUnavailable();accepted=true;
        if (!failed) stop?.resolve(Object.freeze({accepted:true}));return;
      }
      if (requestId!==null && !accepted) throw controlUnavailable();drained=true;
    } catch {fault();}
  };
  const disconnected=() => {channelEnded=child.connected===false && !child.channel;if (!drained) fault();complete();};
  const exit=(code,signal) => {exited=true;exitCode=code;signalCode=signal;if(code!==0 || signal!==null) markFailure();complete();};
  const complete=() => {
    if(!isTerminal() || pendingSends || completed)return;completed=true;
    for(const [name,listener] of registered) child.removeListener(name,listener);active.delete(child);
    for(const [stream,name,listener] of streamListeners)stream.removeListener(name,listener);
    if(!accepted)stop?.reject(controlUnavailable());
    if (failed) terminal.reject(controlUnavailable());else terminal.resolve(Object.freeze({exited:true,exitCode:0,drained:true}));
  };
  const close=(code,signal) => {
    closed=true;
    if (!exited || code!==exitCode || signal!==signalCode || !drained || code!==0 || signal!==null) markFailure();
    if (!accepted) stop?.reject(controlUnavailable());
    complete();
  };
  active.add(child);
  try {
    for(const [name,listener] of [['message',message],['error',fault],['disconnect',disconnected],['exit',exit],['close',close]]) {
      child.on(name,listener);registered.push([name,listener]);
    }
    for(const stream of streams)for(const [name,listener] of [['close',complete],['error',fault]]) {
      stream.on(name,listener);streamListeners.push([stream,name,listener]);
    }
    if (child.connected!==true) {channelEnded=!child.channel;fault();}
  } catch {
    for(const [name,listener] of registered) child.removeListener(name,listener);
    for(const [stream,name,listener] of streamListeners)stream.removeListener(name,listener);
    active.delete(child);throw controlUnavailable();
  }
  return Object.freeze({
    requestStop() {
      if (stop) return stop.promise;
      stop=Promise.withResolvers();stop.promise.catch(() => {});
      if (isTerminal() || drained || failed) {stop.reject(controlUnavailable());return stop.promise;}
      requestId=randomUUID();if(ready) sendStop();return stop.promise;
    },
    waitForExit:() => terminal.promise,
    status:() => Object.freeze({phase:isTerminal()?'exited':failed?'failed':drained?'drained':accepted?'stop-accepted':requestId?'stop-requested':ready?'control-ready':'awaiting-control',
      controlReady:ready,stopRequested:requestId!==null,stopAccepted:accepted,drainReported:drained,terminal:isTerminal(),closeObserved:closed,stdioClosed:stdioClosed(),
      exitCode,signalCode,failureCode:failed?'MEDIA_WORKER_CONTROL_UNAVAILABLE':null}),
  });
}
