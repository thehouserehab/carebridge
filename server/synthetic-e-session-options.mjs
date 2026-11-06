import {windowsPostgresOptions} from './windows-postgres-policy.mjs';

const invalid=()=>new Error('SYNTHETIC_SESSION_CONFIGURATION');
const sessionId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

// A session ID is an opaque selection, never an existing directory supplied by
// the caller. Keep the original five-argument PostgreSQL policy unchanged.
export function syntheticSessionOptions(args) {
  try{
    if(!Array.isArray(args))throw invalid();
    const captured=[...args];
    if(captured.some(value=>typeof value!=='string'))throw invalid();
    let mode='ephemeral',id=null,offset=0;
    if(captured[0]==='--create-resumable'){mode='create-resumable';offset=1;}
    else if(captured[0]==='--resume-session'){
      mode='resume';id=captured[1];offset=2;if(!sessionId(id))throw invalid();
    }
    const postgresArgs=captured.slice(offset);
    windowsPostgresOptions(postgresArgs);
    return Object.freeze({mode,sessionId:id,postgresArgs:Object.freeze(postgresArgs)});
  }catch{throw invalid();}
}
