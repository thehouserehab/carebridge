// Fresh synthetic process fixture only; no DB, storage, engine or user data.
import {runMediaWorkerControlledProcess} from '../../media-worker-controlled-process.mjs';
const release=Promise.withResolvers();let input='';
process.stdin.on('error',()=>release.reject(new Error('SYNTHETIC_INPUT')));
process.stdin.on('data',(bytes)=>{
  input+=bytes.toString('ascii');
  if(input==='RELEASE\n')release.resolve();else if(input.length>=8)release.reject(new Error('SYNTHETIC_INPUT'));
});
process.stdin.on('end',()=>{if(input!=='RELEASE\n')release.reject(new Error('SYNTHETIC_INPUT'));});
release.promise.catch(()=>{});
try {
  await runMediaWorkerControlledProcess(async()=>{
    process.stdout.write('WORK_STARTED\n');await release.promise;return {stopped:true,processed:0};
  },{instanceId:process.argv[2]});
} catch {process.exitCode=1;}
finally {process.stdin.destroy();if(process.connected)process.disconnect();}
