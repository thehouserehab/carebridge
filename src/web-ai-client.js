const errors = new Set(['AUTH_REQUIRED','INVALID_ACCESS_CODE','AI_UNAVAILABLE','INVALID_INPUT','AI_PROVIDER_UNAVAILABLE','AI_OUTPUT_INVALID','AI_RATE_LIMITED','CROSS_ORIGIN_DENIED','AI_CANCELLED']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const text = (value, max) => typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
export class WebAiError extends Error {
  constructor(code) { super('AI 요청을 완료하지 못했습니다.'); this.code=errors.has(code)?code:'AI_UNAVAILABLE'; }
}
function invalid() { throw new WebAiError('AI_OUTPUT_INVALID'); }
function session(value) {
  if (!exact(value,['authenticated','enabled','mode']) || typeof value.authenticated !== 'boolean' || typeof value.enabled !== 'boolean' || value.mode !== 'openai') invalid();
  return value;
}
export function boundedWebAiMessages(history, message) {
  if (!text(message,2000) || !message.trim() || !Array.isArray(history) || history.length%2) throw new WebAiError('INVALID_INPUT');
  const messages=history.map((item,index)=>{
    if (!exact(item,['role','content']) || item.role !== (index%2?'assistant':'user') || !text(item.content,index%2?6000:2000) || !item.content.trim()) throw new WebAiError('INVALID_INPUT');
    return {...item};
  });
  messages.push({role:'user',content:message.trim()});
  while (messages.length>11 || messages.reduce((total,item)=>total+item.content.length,0)>16000) messages.splice(0,2);
  return messages;
}
export class WebAiClient {
  constructor({fetch:request=globalThis.fetch.bind(globalThis),timeoutMs=25000}={}) { this.fetch=request;this.timeoutMs=timeoutMs; }
  async request(path,{method='GET',body,signal}={}) {
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),this.timeoutMs);
    try {
      const response=await this.fetch(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',
        headers:{Accept:'application/json',...(method==='GET'?{}:{'Content-Type':'application/json','X-Carebridge-AI':'1'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([signal,timeout.signal]):timeout.signal});
      if(response.status===429)throw new WebAiError('AI_RATE_LIMITED');
      if(response.redirected || !response.headers.get('content-type')?.includes('application/json')) throw new WebAiError('AI_UNAVAILABLE');
      const raw=await response.text();if(raw.length>40000)invalid();
      let value;try{value=JSON.parse(raw);}catch{invalid();}
      if(!response.ok)throw new WebAiError(value?.error?.code);
      return value;
    } catch(error) {
      if(signal?.aborted)throw new WebAiError('AI_CANCELLED');
      if(error instanceof WebAiError)throw error;
      throw new WebAiError('AI_UNAVAILABLE');
    } finally {clearTimeout(timer);}
  }
  async session(signal) {return session(await this.request('/api/ai/session',{signal}));}
  async login(accessCode,signal) {
    if(!text(accessCode,256)||!accessCode.trim())throw new WebAiError('INVALID_INPUT');
    return session(await this.request('/api/ai/session',{method:'POST',body:{accessCode,syntheticConfirmed:true},signal}));
  }
  async logout(signal) {return session(await this.request('/api/ai/session',{method:'DELETE',signal}));}
  async chat(messages,signal) {
    const value=await this.request('/api/ai/respond',{method:'POST',body:{kind:'chat',messages,syntheticConfirmed:true},signal});
    if(!exact(value,['kind','text','mode','model'])||value.kind!=='chat'||value.mode!=='openai'||!text(value.text,6000)||!value.text.trim()||!text(value.model,128)||!value.model.trim())invalid();
    return value;
  }
  async summary(source,signal) {
    if(!exact(source,['performed','response'])||!text(source.performed,2000)||!text(source.response,2000)||!Object.values(source).some(x=>x.trim()))throw new WebAiError('INVALID_INPUT');
    const value=await this.request('/api/ai/respond',{method:'POST',body:{kind:'summary',source,syntheticConfirmed:true},signal});
    if(!exact(value,['kind','summary','reviewNotes','mode','model'])||value.kind!=='summary'||value.mode!=='openai'||!text(value.summary,1200)||!value.summary.trim()||!text(value.model,128)||!Array.isArray(value.reviewNotes)||value.reviewNotes.length>4||value.reviewNotes.some(note=>!text(note,200)||!note.trim()))invalid();
    return value;
  }
}
