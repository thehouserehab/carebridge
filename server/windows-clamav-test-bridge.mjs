// Explicit synthetic-only Windows transport rehearsal. Not an operating AV
// service, auth boundary or production worker adapter. Local users can reach
// its temporary loopback listener; never submit real/clinical files here.
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {access} from 'node:fs/promises';
import {createServer} from 'node:net';
import {Transform} from 'node:stream';
import {finished} from 'node:stream/promises';
import {localDockerTestConfiguration} from './local-docker-test-environment.mjs';
import {resourceReceipt,assertContainerOwner,assertContainerIsolation} from './clamav-container-policy.mjs';
import {clamAvRelayArguments,assertClamAvRelayIsolation} from './clamav-relay-test-policy.mjs';
const unavailable=() => new Error('CLAMAV_RELAY_TEST_UNAVAILABLE');
const imageId=(value)=>typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value);

export async function startWindowsClamAvTestBridge(options) {
  const keys=['runtime','engineIdentity','scannerReceipt','scannerImageId','relayImageId'];
  if(process.platform!=='win32'||!options||Object.keys(options).length!==keys.length||!keys.every(key=>Object.hasOwn(options,key)))throw unavailable();
  const {runtime,engineIdentity,scannerReceipt,scannerImageId,relayImageId}=options;
  if(!runtime||!['docker','inspect','identity'].every(key=>typeof runtime[key]==='function')||
      typeof engineIdentity!=='string'||!imageId(scannerImageId)||!imageId(relayImageId)||scannerReceipt?.role!=='scanner')throw unavailable();
  const scanner=resourceReceipt(scannerReceipt.id,'scanner',scannerReceipt.run);
  if(scannerReceipt.name!==scanner.name)throw unavailable();
  const configuration=localDockerTestConfiguration(process.env);await access(configuration.cli);
  async function scannerReady() {
    if(await runtime.identity()!==engineIdentity)throw unavailable();
    assertContainerIsolation(await runtime.inspect('container',scanner.id),scanner,scannerImageId,{running:true});
  }
  await scannerReady();
  const relayImage=await runtime.inspect('image',relayImageId);
  if(relayImage.Id!==relayImageId||relayImage.Os!=='linux'||relayImage.Architecture!=='amd64'||relayImage.Config?.User!=='node'||
      Object.keys(relayImage.Config.Volumes??{}).length||Object.keys(relayImage.Config.ExposedPorts??{}).length||
      JSON.stringify(relayImage.Config.Entrypoint)!=='["/usr/local/bin/node"]'||
      JSON.stringify(relayImage.Config.Cmd)!=='["/app/server/clamav-relay-peer-test.mjs"]')throw unavailable();
  const tasks=new Set(),sockets=new Set(),relays=new Map();let closing=false,uncertain=false,created=0,removed=0,closePromise;
  const server=createServer({pauseOnConnect:true},socket=>{
    socket.on('error',()=>{});
    if(closing||uncertain||tasks.size>=2){socket.destroy();return;}
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    const task=serve(socket).catch(()=>{uncertain=true;socket.destroy();});
    tasks.add(task);void task.finally(()=>tasks.delete(task));
  });
  server.maxConnections=2;server.on('error',()=>{uncertain=true;for(const socket of sockets)socket.destroy();});
  async function dispose(entry) {
    // CLI close is not container termination evidence. Recheck the exact
    // engine/full-ID/name/label/image, stop that relay only, then confirm gone.
    if(!entry.receipt)throw unavailable();
    if(await runtime.identity()!==engineIdentity)throw unavailable();
    let state=await runtime.inspect('container',entry.receipt.id);
    assertContainerOwner(state,entry.receipt,relayImageId);
    if(state.State.Running) {
      await runtime.docker(['kill','--signal','KILL',entry.receipt.id]);
      state=await runtime.inspect('container',entry.receipt.id);assertContainerOwner(state,entry.receipt,relayImageId);
    }
    if(state.State.Running||!['created','exited','dead'].includes(state.State.Status))throw unavailable();
    const normal=state.State.Status==='exited'&&state.State.ExitCode===0&&state.State.OOMKilled===false;
    await runtime.docker(['rm',entry.receipt.id]);
    if(await runtime.docker(['ps','--all','--no-trunc','--filter',`id=${entry.receipt.id}`,'--format','{{.ID}}'])!=='')throw unavailable();
    relays.delete(entry.run);removed++;return normal;
  }
  async function serve(socket) {
    let child,closed,entry,input,output,normal=false,cancelled=false,inputBytes=0,outputBytes=0,timer;
    const stop=()=>{
      cancelled=true;socket.destroy();input?.destroy();output?.destroy();
      if(child){child.stdin.destroy();child.kill('SIGKILL');}
    };
    socket.once('close',()=>{if(!normal)stop();});
    try {
      await scannerReady();if(socket.destroyed||closing)return;
      const run=randomUUID();entry={run,receipt:null};relays.set(run,entry);
      const id=await runtime.docker(clamAvRelayArguments(run,scanner.id,relayImageId));
      entry.receipt=resourceReceipt(id,'worker',run);created++;
      assertClamAvRelayIsolation(await runtime.inspect('container',id),entry.receipt,relayImageId,scanner.id);
      if(socket.destroyed||closing)return;
      const args=['start','--attach','--interactive',id];
      child=spawn(configuration.cli,['--host','npipe:////./pipe/dockerDesktopLinuxEngine',...args],
        {env:configuration.environmentFor(args),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
      closed=new Promise(yes=>child.once('close',(code,signal)=>yes({code,signal})));
      child.once('error',stop);child.stdin.on('error',stop);child.stdout.on('error',stop);child.stderr.on('error',stop);child.stderr.on('data',stop);
      input=new Transform({transform(bytes,encoding,done){inputBytes+=bytes.length;done(inputBytes>53*1024*1024?unavailable():null,bytes);}});
      output=new Transform({transform(bytes,encoding,done){outputBytes+=bytes.length;done(outputBytes>4096?unavailable():null,bytes);}});
      input.on('error',stop);output.on('error',stop);
      const outputDone=finished(output,{cleanup:true}).then(()=>true,()=>false);
      // A killed CLI may close its stdout without an end event. pipe() then
      // unpipes, leaving the Transform unfinished. Cancel that observer too;
      // actual native ownership/termination is still checked independently.
      child.stdout.once('close',()=>{if(!child.stdout.readableEnded)stop();});
      socket.pipe(input).pipe(child.stdin);child.stdout.pipe(output).pipe(socket,{end:false});
      timer=setTimeout(stop,120000);
      const result=await closed;normal=(await outputDone)&&!cancelled&&result.code===0&&result.signal===null;
    } catch {socket.destroy();}
    finally {
      clearTimeout(timer);
      if(child&&child.exitCode===null&&child.signalCode===null){child.stdin.destroy();child.kill('SIGKILL');}
      if(closed)await closed;
      if(entry)try {normal=(await dispose(entry))&&normal;}catch {uncertain=true;normal=false;}
      // LocalClamAvClient requires EOF. Do not deliver it as a healthy result
      // until the actual owned relay namespace is terminal AND removed.
      if(normal&&!socket.destroyed)socket.end();else socket.destroy();
      if(uncertain)for(const pending of sockets)pending.destroy();
    }
  }
  await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',no);yes();});});
  const endpoint=Object.freeze({host:'127.0.0.1',port:server.address().port});
  async function idle() {await Promise.all([...tasks]);if(uncertain)throw unavailable();}
  function close() {
    if(closePromise)return closePromise;
    closing=true;const listenerClosed=new Promise(yes=>server.close(yes));for(const socket of sockets)socket.destroy();
    closePromise=(async()=>{await idle();await listenerClosed;if(relays.size||uncertain)throw unavailable();return Object.freeze({closed:true});})();
    return closePromise;
  }
  return Object.freeze({endpoint,close,idle,status:()=>Object.freeze({closing,uncertain,active:tasks.size,created,removed}),
    retainedRelays:()=>[...relays.values()].map(entry=>Object.freeze({run:entry.run,id:entry.receipt?.id??null}))});
}
