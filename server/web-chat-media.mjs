import { createHash, randomUUID } from 'node:crypto';
import { Conversations } from './conversations.mjs';
import { messageVisibleSql } from './conversation-visibility.mjs';
import { fail } from './errors.mjs';
import { validateWebChatMedia } from './web-chat-media-validation.mjs';
import { WEB_CHAT_MEDIA_MAX_BYTES, WEB_CHAT_MEDIA_MAX_FILES, WEB_CHAT_MEDIA_TYPES,
  webChatMediaName, webChatMediaCaption } from '../src/shared-chat-media-policy.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT'); return value; };
const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) fail('INVALID_INPUT'); return value; };
const requestId = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(value)) fail('INVALID_INPUT'); return value; };
const keys = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_INPUT');
};
const requireRole = scope => { if (!['therapist','guardian'].includes(scope.role)) fail('FORBIDDEN'); };
const metadataColumns = 'id,type,size,width,height,duration';
const project = row => ({ id:row.id,name:webChatMediaName(row.type),type:row.type,size:Number(row.size),
  width:Number(row.width),height:Number(row.height),...(row.duration === null || row.duration === undefined ? {} : {duration:Number(row.duration)}) });
const filesInput = (value = []) => {
  if (!Array.isArray(value) || value.length > WEB_CHAT_MEDIA_MAX_FILES) fail('MEDIA_LIMIT');
  const result = value.map(file => { keys(file,['id']); return {id:uuid(file.id)}; });
  if (new Set(result.map(file => file.id)).size !== result.length) fail('INVALID_INPUT');
  return result;
};
const bodyInput = value => {
  if (typeof value !== 'string' || value.length > 2000 || !value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) fail('INVALID_INPUT');
  return value.trim();
};

/** Small private prototype files. No scanner/decoder approval is represented. */
export class WebChatMedia {
  constructor(database) { this.database=database; this.conversations=new Conversations(database); }
  async inRoom(identity, conversationId, work) {
    return this.conversations.inRoom(identity,id(conversationId),async (tx,scope) => {
      requireRole(scope); return work(tx,scope);
    });
  }
  async quotaLock(tx, centerId) {
    // All uploads and releases share a center lock, including different rooms.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('carebridge-web-media:' || $1,0))",[centerId]);
    const {rows}=await tx.query('SELECT limit_bytes FROM carebridge_web.center_limits WHERE center_id=$1',[centerId]);
    if (rows.length!==1) fail('CHAT_UNAVAILABLE');
    return Number(rows[0].limit_bytes);
  }
  async upload(identity,input) {
    keys(input,['conversationId','clientId','type','bytes']); requestId(input.clientId);
    if (!Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length>WEB_CHAT_MEDIA_MAX_BYTES) fail('MEDIA_LIMIT');
    if (!WEB_CHAT_MEDIA_TYPES.includes(input.type)) fail('INVALID_MEDIA');
    const bytes=Buffer.from(input.bytes);
    try {
      return await this.inRoom(identity,input.conversationId,async (tx,scope) => {
        const checked=await validateWebChatMedia(bytes,input.type);
        if (checked.type!==input.type || checked.size!==bytes.length || checked.sha256!==hash(bytes)) fail('INVALID_MEDIA');
        const limit=await this.quotaLock(tx,scope.centerId);
        await tx.query("UPDATE carebridge_web.attachments SET state='expired',content=NULL WHERE center_id=$1 AND state='pending' AND expires_at<=clock_timestamp()",[scope.centerId]);
        const prior=await tx.query(`SELECT ${metadataColumns},conversation_id,sha256,state,created_sequence FROM carebridge_web.attachments WHERE center_id=$1 AND owner_id=$2 AND client_id=$3`,[scope.centerId,scope.userId,input.clientId]);
        if (prior.rows.length) {
          const row=prior.rows[0];
          if (row.conversation_id!==scope.roomId || row.type!==input.type || row.size!==bytes.length || row.sha256!==checked.sha256) fail('IDEMPOTENCY_CONFLICT');
          if (Number(row.created_sequence)<scope.firstSequence) fail('ATTACHMENT_NOT_FOUND');
          if (['expired','discarded'].includes(row.state)) fail('UPLOAD_EXPIRED');
          return project(row);
        }
        const {rows:[usage]}=await tx.query(`SELECT COALESCE(sum(size) FILTER (WHERE content IS NOT NULL),0) AS bytes,count(*) AS receipts,
          count(*) FILTER (WHERE owner_id=$2 AND state='pending') AS pending FROM carebridge_web.attachments WHERE center_id=$1`,[scope.centerId,scope.userId]);
        if (Number(usage.bytes)+bytes.length>limit || Number(usage.receipts)>=5000) fail('MEDIA_STORAGE_FULL');
        if (Number(usage.pending)>=8) fail('MEDIA_LIMIT');
        const attachmentId=randomUUID();
        const {rows:[boundary]}=await tx.query('SELECT last_sequence+1 AS next_sequence FROM public.cb_conversations WHERE center_id=$1 AND id=$2',[scope.centerId,scope.roomId]);
        const {rows:[row]}=await tx.query(`INSERT INTO carebridge_web.attachments
          (center_id,conversation_id,id,owner_id,client_id,type,size,sha256,width,height,duration,content,created_sequence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${metadataColumns}`,
        [scope.centerId,scope.roomId,attachmentId,scope.userId,input.clientId,input.type,checked.size,checked.sha256,checked.width,checked.height,checked.duration??null,bytes,boundary.next_sequence]);
        return project(row);
      });
    } finally { bytes.fill(0); }
  }
  async decorateInRoom(tx,scope,messages) {
    const candidates=[];
    for (const message of messages) {
      if (message.conversationId!==scope.roomId) fail('INVALID_INPUT');
      if (message.hidden || message.deleted) continue;
      if (message.type==='text') candidates.push(id(message.id));
    }
    const byMessage=new Map();
    if (candidates.length) {
      // The message envelopes already come from Conversations. Reauthorize only
      // web-file metadata in one batch, using the current text/hide/history state.
      const {rows}=await tx.query(`SELECT a.bound_message_id,a.id,a.type,a.size,a.width,a.height,a.duration FROM carebridge_web.attachments a
        JOIN public.cb_messages m ON (m.center_id,m.conversation_id,m.id)=(a.center_id,a.conversation_id,a.bound_message_id)
        JOIN public.cb_message_text_heads th ON (th.center_id,th.conversation_id,th.message_id)=(m.center_id,m.conversation_id,m.id)
        JOIN public.cb_message_text_revisions tv ON (tv.center_id,tv.conversation_id,tv.message_id,tv.revision)=(th.center_id,th.conversation_id,th.message_id,th.current_revision)
        WHERE a.center_id=$1 AND a.conversation_id=$2 AND a.state='bound' AND a.bound_message_id=ANY($3::text[])
          AND m.kind='text' AND m.sequence >= $4 AND tv.operation<>'all' AND ${messageVisibleSql('$6')}
          AND NOT EXISTS (SELECT 1 FROM public.cb_message_hides hidden WHERE
            (hidden.center_id,hidden.conversation_id,hidden.message_id,hidden.user_id)=(m.center_id,m.conversation_id,m.id,$5))
        ORDER BY a.bound_message_id,a.ordinal`,[scope.centerId,scope.roomId,candidates,scope.firstSequence,scope.userId,scope.role]);
      for (const row of rows) {
        if (!byMessage.has(row.bound_message_id)) byMessage.set(row.bound_message_id,[]);
        byMessage.get(row.bound_message_id).push(project(row));
      }
    }
    return messages.map(message => ({...message,webAttachments:byMessage.get(message.id)??[]}));
  }
  async decorate(identity,input) {
    keys(input,['conversationId','messages']);
    if (!Array.isArray(input.messages) || input.messages.length>100) fail('INVALID_INPUT');
    return this.inRoom(identity,input.conversationId,(tx,scope)=>this.decorateInRoom(tx,scope,input.messages));
  }
  async send(identity,input) {
    keys(input,['conversationId','clientId','body','attachments']); requestId(input.clientId);
    const attachments=filesInput(input.attachments),body=bodyInput(input.body??'');
    if (!body && !attachments.length) fail('INVALID_INPUT');
    const fingerprint=hash(JSON.stringify({body,attachments}));
    return this.inRoom(identity,input.conversationId,async (tx,scope) => {
      const {rows:receipts}=await tx.query('SELECT conversation_id,request_hash,message_id FROM carebridge_web.message_requests WHERE center_id=$1 AND owner_id=$2 AND client_id=$3',[scope.centerId,scope.userId,input.clientId]);
      const receipt=receipts[0];
      if (receipt && (receipt.conversation_id!==scope.roomId || receipt.request_hash!==fingerprint)) fail('IDEMPOTENCY_CONFLICT');
      const {rows:prior}=await tx.query('SELECT id FROM public.cb_messages WHERE center_id=$1 AND author_id=$2 AND client_id=$3',[scope.centerId,scope.userId,input.clientId]);
      if (prior.length && !receipt && attachments.length) fail('IDEMPOTENCY_CONFLICT');
      const files=[];
      if (attachments.length) {
        const {rows}=await tx.query(`SELECT ${metadataColumns},owner_id,state,bound_message_id,created_sequence,expires_at<=clock_timestamp() AS expired FROM carebridge_web.attachments
          WHERE center_id=$1 AND conversation_id=$2 AND id=ANY($3::text[]) ORDER BY id FOR UPDATE`,[scope.centerId,scope.roomId,attachments.map(file=>file.id)]);
        if (rows.length!==attachments.length) fail('ATTACHMENT_NOT_FOUND');
        const byId=new Map(rows.map(row=>[row.id,row]));
        for (const item of attachments) {
          const row=byId.get(item.id);
          if (row.owner_id!==scope.userId) fail('ATTACHMENT_NOT_FOUND');
          if (Number(row.created_sequence)<scope.firstSequence) fail('ATTACHMENT_NOT_FOUND');
          if (row.state==='bound') {
            if (!receipt || row.bound_message_id!==receipt.message_id) fail('IDEMPOTENCY_CONFLICT');
          } else if (row.state!=='pending' || row.expired) fail('UPLOAD_EXPIRED');
          files.push(row);
        }
      }
      const nested=new Conversations({transaction:work=>work(tx)});
      const message=await nested.sendText(identity,{conversationId:scope.roomId,clientId:input.clientId,body:body||webChatMediaCaption(files)});
      if (receipt && receipt.message_id!==message.id) fail('IDEMPOTENCY_CONFLICT');
      if (!receipt && attachments.length) {
        for (const [ordinal,file] of files.entries()) await tx.query(`UPDATE carebridge_web.attachments SET state='bound',bound_message_id=$4,ordinal=$5
          WHERE center_id=$1 AND conversation_id=$2 AND id=$3 AND state='pending'`,[scope.centerId,scope.roomId,file.id,message.id,ordinal]);
        await tx.query(`INSERT INTO carebridge_web.message_requests(center_id,conversation_id,owner_id,client_id,request_hash,message_id)
          VALUES ($1,$2,$3,$4,$5,$6)`,[scope.centerId,scope.roomId,scope.userId,input.clientId,fingerprint,message.id]);
      }
      return (await this.decorateInRoom(tx,scope,[message]))[0];
    });
  }
  async content(identity,input) {
    keys(input,['conversationId','attachmentId']); uuid(input.attachmentId);
    return this.inRoom(identity,input.conversationId,async (tx,scope) => {
      const {rows}=await tx.query(`SELECT bound_message_id FROM carebridge_web.attachments WHERE center_id=$1 AND conversation_id=$2 AND id=$3 AND state='bound'`,[scope.centerId,scope.roomId,input.attachmentId]);
      if (!rows.length) fail('ATTACHMENT_NOT_FOUND');
      const row=await this.conversations.row(tx,scope,rows[0].bound_message_id);
      if (row.kind!=='text' || row.text_operation==='all') fail('ATTACHMENT_NOT_FOUND');
      const {rows:[file]}=await tx.query(`SELECT type,size,sha256,content FROM carebridge_web.attachments WHERE center_id=$1 AND conversation_id=$2 AND id=$3 AND state='bound'`,[scope.centerId,scope.roomId,input.attachmentId]);
      const bytes=Buffer.from(file.content);
      if (bytes.length!==file.size || hash(bytes)!==file.sha256) {bytes.fill(0);fail('CHAT_UNAVAILABLE');}
      return {bytes,type:file.type,size:file.size,sha256:file.sha256};
    });
  }
  async discard(identity,input) {
    keys(input,['conversationId','attachmentId']); uuid(input.attachmentId);
    return this.inRoom(identity,input.conversationId,async (tx,scope) => {
      await this.quotaLock(tx,scope.centerId);
      const {rows}=await tx.query('SELECT owner_id,state FROM carebridge_web.attachments WHERE center_id=$1 AND conversation_id=$2 AND id=$3 FOR UPDATE',[scope.centerId,scope.roomId,input.attachmentId]);
      if (!rows.length || rows[0].owner_id!==scope.userId) fail('ATTACHMENT_NOT_FOUND');
      if (rows[0].state==='bound') fail('IDEMPOTENCY_CONFLICT');
      if (rows[0].state==='pending') await tx.query("UPDATE carebridge_web.attachments SET state='discarded',content=NULL WHERE center_id=$1 AND conversation_id=$2 AND id=$3",[scope.centerId,scope.roomId,input.attachmentId]);
      return {discarded:true};
    });
  }
}
