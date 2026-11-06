// Test-only fresh process. Only ephemeral UI credentials leave via inherited
// private IPC; no database configuration, DPAPI plaintext or TLS keys leave.
import {createWindowsSyntheticSession} from '../server/windows-synthetic-session.mjs';
import {retainedSeed} from '../server/synthetic-session-retention.mjs';
if(!process.send||!process.connected)throw Error('SYNTHETIC_RESUME_IPC_REQUIRED');
const session=createWindowsSyntheticSession(process.argv.slice(2));
let closing;
const keepAlive=setInterval(()=>{},1000);
async function close(){
  if(closing)return closing;
  closing=(async()=>{
    try{await session.close();const status=session.status();
      if(status.phase!=='stopped'||status.failed)process.exitCode=1;
      await new Promise(resolve=>process.send({type:'stopped',status},()=>resolve()));
      clearInterval(keepAlive);process.disconnect();
    }catch{process.exitCode=1;process.send({type:'stop-unconfirmed',phase:session.status().phase});closing=undefined;}
  })();return closing;
}
process.on('message',message=>{if(message?.type==='stop'&&Object.keys(message).length===1)void close();});
process.on('disconnect',()=>{if(!closing)void close();});
try{
  const {origin}=await session.ready;
  const credentials=session.credentials.map(value=>({...value}));
  await new Promise((resolve,reject)=>process.send({type:'ready',origin,status:session.status(),seed:retainedSeed(session.seed),credentials},error=>error?reject(error):resolve()));
  for(const item of credentials){item.password='';item.email='';}session.forgetCredentials();
}catch{process.exitCode=1;process.send({type:'unavailable',phase:session.status().storage?.stage??session.status().phase});await close();}
