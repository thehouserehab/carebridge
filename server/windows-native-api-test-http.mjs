// Explicit synthetic native-fixture HTTP only. Cookie jars stay in this
// closure; no passwords, session headers or response diagnostics are logged.
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {MEDIA_LIMITS} from '../src/media-policy.js';

const unavailable=()=>new Error('NATIVE_API_HTTP_UNAVAILABLE');
export function nativeApiTestHttp(origin) {
  const match=/^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(origin??'');
  if(!match||Number(match[1])<1024||Number(match[1])>65535)throw unavailable();
  const sessions=new Map();
  async function call(path,{method='GET',body,bytes,userId,expectedAccount=userId,headers={}}={}) {
    if(typeof path!=='string'||!path.startsWith('/api/local/')||/[\\#\x00-\x20\x7f]/.test(path)||
        !['GET','POST'].includes(method)||body!==undefined&&bytes!==undefined)throw unavailable();
    const payload=bytes??(body===undefined?undefined:Buffer.from(JSON.stringify(body)));
    const cookie=userId===undefined?undefined:sessions.get(userId);
    if(userId!==undefined&&!cookie)throw unavailable();
    const outgoing={...(method==='POST'?{Origin:origin,'X-Carebridge-Request':'1',
      'Content-Type':bytes?'application/octet-stream':'application/json'}:{}),
      ...(cookie?{Cookie:cookie,'X-Carebridge-Account':expectedAccount}:{}),
      ...(payload?{'Content-Length':String(payload.length)}:{}),...headers};
    return new Promise((resolve,reject)=>{
      let settled=false,timer;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(unavailable()):resolve(value);};
      const req=request({hostname:'127.0.0.1',port:Number(match[1]),method,path,headers:outgoing,agent:false},res=>{
        const chunks=[];let size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>MEDIA_LIMITS.video){req.destroy();finish(unavailable());}else chunks.push(chunk);});
        res.once('aborted',()=>finish(unavailable()));res.once('error',()=>finish(unavailable()));
        res.once('end',()=>{
          try {const buffer=Buffer.concat(chunks),json=res.headers['content-type']?.startsWith('application/json')?JSON.parse(buffer.toString('utf8')):null;
            finish(null,{status:res.statusCode,headers:res.headers,buffer,json});}
          catch{finish(unavailable());}
        });
      });
      req.once('error',()=>finish(unavailable()));
      timer=setTimeout(()=>{req.destroy();finish(unavailable());},30000);
      req.end(payload);
    });
  }
  async function login({email,password,userId,centerId,role}) {
    const result=await call('/api/local/auth/login',{method:'POST',body:{email,password}});
    assert.equal(result.status,200);assert.equal(result.json?.user?.userId,userId);
    assert(result.json.user.centers.some(center=>center.id===centerId&&center.role===role));
    assert.deepEqual(Object.keys(result.json),['user']);
    const cookies=result.headers['set-cookie'];assert.equal(cookies?.length,1);
    const cookie=cookies[0];
    assert(/^cb_local_[a-f0-9]{32}=[A-Za-z0-9_-]{40,100}; Path=\/api\/local\/; HttpOnly; SameSite=Strict; Max-Age=[1-9][0-9]*$/.test(cookie));
    sessions.set(userId,cookie.split(';')[0]);return userId;
  }
  return Object.freeze({call,login,forget:()=>sessions.clear()});
}
