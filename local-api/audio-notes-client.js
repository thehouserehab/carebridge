import { LocalApiClient, LocalApiError } from './client.js';
import { AUDIO_NOTE_MAX_BYTES, normalizeAudioNoteFile, validateAudioAnalysisResult } from '../src/audio-note-contract.js';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => { throw new LocalApiError('INVALID_RESPONSE'); };
const text = (value, limit) => typeof value === 'string' && value.length <= limit && value.isWellFormed();
const revision = value => Number.isSafeInteger(value) && value > 0;

export function parseAudioNoteSession(value, recordId) {
  if (!exact(value, ['id','recordId','recordRevision','revision','filename','type','size','sha256','receivedAt',
    'state','mode','model','transcriptionModel','result','events','syntheticOnly']) ||
    !id(value.id) || value.recordId !== recordId || !revision(value.recordRevision) || !revision(value.revision) ||
    !Number.isSafeInteger(value.size) || value.size < 1 || value.size > AUDIO_NOTE_MAX_BYTES ||
    !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isFinite(Date.parse(value.receivedAt)) ||
    !['uploaded','processing','ready','failed','cancelled'].includes(value.state) ||
    !['openai','fixture'].includes(value.mode) || !text(value.model,128) || !value.model ||
    !text(value.transcriptionModel,128) || !value.transcriptionModel || value.syntheticOnly !== true ||
    !Array.isArray(value.events) || value.events.length > 200 || !value.events.every(event =>
      exact(event,['kind','at']) && text(event.kind,100) && event.kind.length > 0 && Number.isFinite(Date.parse(event.at)))) invalid();
  try {
    const file = normalizeAudioNoteFile({ filename:value.filename, type:value.type });
    if (file.filename !== value.filename || file.type !== value.type) invalid();
    if (value.state === 'ready') validateAudioAnalysisResult(value.result);
    else if (value.result !== null) invalid();
  } catch { invalid(); }
  return structuredClone(value);
}

export class AudioNotesClient {
  constructor(api) { this.api = api; }
  path(context, recordId, sessionId) {
    if (context?.role !== 'therapist' || !id(context?.user?.userId) || !id(context.centerId) || !id(context.roomId) ||
      this.api.expectedUserId !== context.user.userId) throw new LocalApiError('AUTH_REQUIRED');
    if (!id(recordId) || (sessionId !== undefined && !id(sessionId))) throw new LocalApiError('INVALID_INPUT');
    return this.api.roomPath(context.centerId, context.roomId) + '/records/' + recordId + '/audio-notes' +
      (sessionId === undefined ? '' : '/' + sessionId);
  }
  async request(context, recordId, suffix = '', { body, signal, upload = false } = {}) {
    const path = this.path(context, recordId) + suffix;
    if (signal?.aborted) throw new LocalApiError('CANCELLED');
    // Only this bounded upload may use a longer timeout. Ordinary API requests
    // retain their existing deadline and the parent account binding is rechecked.
    const api = upload ? new LocalApiClient({fetch:this.api.fetch, timeoutMs:30000}) : this.api;
    if (upload) api.expectedUserId = context.user.userId;
    const value = await api.request(path, {body,signal});
    this.path(context,recordId);
    if (signal?.aborted) throw new LocalApiError('CANCELLED');
    return value;
  }
  async list(context, recordId, signal) {
    const value = await this.request(context,recordId,'',{signal});
    if (!exact(value,['sessions']) || !Array.isArray(value.sessions) || value.sessions.length > 3) invalid();
    const sessions = value.sessions.map(session => parseAudioNoteSession(session,recordId));
    if (new Set(sessions.map(session=>session.id)).size !== sessions.length) invalid();
    return sessions;
  }
  async get(context, recordId, sessionId, signal) {
    this.path(context,recordId,sessionId);
    const value=await this.request(context,recordId,'/'+sessionId,{signal});
    if (!exact(value,['session'])) invalid();
    const session=parseAudioNoteSession(value.session,recordId);
    if (session.id!==sessionId) invalid();
    return session;
  }
  async upload(context, record, file, confirmations, requestId, signal) {
    this.path(context,record.id);
    if (!revision(record.revision) || !file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > AUDIO_NOTE_MAX_BYTES ||
      confirmations.syntheticConfirmed !== true || confirmations.processingConfirmed !== true) throw new LocalApiError('INVALID_INPUT');
    let normalized;
    try { normalized=normalizeAudioNoteFile({filename:file.name,type:file.type}); } catch { throw new LocalApiError('INVALID_INPUT'); }
    const bytes=new Uint8Array(await file.arrayBuffer());
    this.path(context,record.id);
    if(signal?.aborted)throw new LocalApiError('CANCELLED');
    if(bytes.byteLength!==file.size)throw new LocalApiError('INVALID_INPUT');
    let binary='';
    for(let offset=0;offset<bytes.length;offset+=16384) binary+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
    const value=await this.request(context,record.id,'',{signal,upload:true,body:{expectedRevision:record.revision,requestId,
      filename:normalized.filename,type:normalized.type,base64:btoa(binary),syntheticConfirmed:true,processingConfirmed:true}});
    if(!exact(value,['session']))invalid();
    return parseAudioNoteSession(value.session,record.id);
  }
  async change(context,session,action,requestId,signal) {
    if(!['start','cancel'].includes(action))throw new LocalApiError('INVALID_INPUT');
    this.path(context,session.recordId,session.id);
    const value=await this.request(context,session.recordId,'/'+session.id+'/'+action,
      {body:{expectedRevision:session.revision,requestId},signal});
    if(!exact(value,['session']))invalid();
    const changed=parseAudioNoteSession(value.session,session.recordId);
    if(changed.id!==session.id || changed.revision<session.revision)invalid();
    return changed;
  }
  async remove(context,session,signal) {
    this.path(context,session.recordId,session.id);
    const value=await this.request(context,session.recordId,'/'+session.id+'/remove',{body:{},signal});
    if(value!==null)invalid();
  }
  async original(context,session,signal) {
    const path=this.path(context,session.recordId,session.id)+'/original';
    const timeout=AbortSignal.timeout(15000), combined=signal?AbortSignal.any([signal,timeout]):timeout;
    const response=await this.api.fetch(path,{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',
      headers:{Accept:'application/octet-stream','X-Carebridge-Account':context.user.userId},signal:combined});
    this.path(context,session.recordId,session.id);
    if(combined.aborted)throw new LocalApiError('CANCELLED');
    if(!response.ok)throw new LocalApiError(response.status===401?'AUTH_REQUIRED':response.status===404?'NOT_FOUND':'UNAVAILABLE');
    if(response.headers.get('content-type')!=='application/octet-stream' || response.headers.get('content-length')!==String(session.size)) invalid();
    const bytes=await response.arrayBuffer();
    this.path(context,session.recordId,session.id);
    if(combined.aborted)throw new LocalApiError('CANCELLED');
    if(bytes.byteLength!==session.size)invalid();
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
    if(digest!==session.sha256)invalid();
    this.path(context,session.recordId,session.id);
    if(combined.aborted)throw new LocalApiError('CANCELLED');
    return bytes;
  }
}
