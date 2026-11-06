import { Conversations } from './conversations.mjs';
import { Records } from './records.mjs';
import { attachmentId, messageAttachments, recordAttachments } from './media-bindings.mjs';
import { fail } from './errors.mjs';
import { servingFile } from './media-serving.mjs';
import { requireSharedCareAccess } from './conversation-visibility.mjs';

const id = (value) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT'); return value; };
const keys = (value,allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail('INVALID_INPUT');
};
const revision = (value) => { if (!Number.isInteger(value) || value < 1 || value > 2147483647) fail('INVALID_INPUT'); return value; };

// Bound-file access always uses an authorized origin/snapshot anchor. Upload
// ownership and knowledge of the UUID are never a fallback sharing grant.
export class MediaAccess {
  constructor(database,store) {
    if (!database?.transaction || !store?.openVerified) throw new TypeError('Transactional database and private store are required.');
    this.conversations = new Conversations(database);
    this.records = new Records(database);
    this.store = store;
  }
  async authorize(tx, scope, input) {
    requireSharedCareAccess(scope);
    let files;
    if (input.source.kind === 'message') {
      const row = await this.conversations.row(tx,scope,input.source.messageId);
      if (row.text_operation==='all') fail('NOT_FOUND');
      if (scope.role === 'guardian' && row.revoked_at && row.kind !== 'text') fail('NOT_FOUND');
      if (input.source.feedbackRevision !== undefined) {
        if (scope.role !== 'therapist') fail('FORBIDDEN');
        if (row.kind !== 'feedback') fail('INVALID_INPUT');
        row.feedback_revision = input.source.feedbackRevision;
      }
      files = (await messageAttachments(tx,scope,[row])).get(row.id) ?? [];
    } else {
      if (scope.role !== 'therapist') fail('FORBIDDEN');
      const header = await this.records.header(tx,scope,input.source.recordId);
      if (input.source.kind==='record-reference') {
        const record=await this.records.readRevision(tx,scope,header.id,input.source.revision ?? header.current_revision);
        files=record.referenceSources.find((source)=>source.messageId===input.source.messageId)?.attachments ?? [];
      } else files = await recordAttachments(tx,scope,header.id,input.source.revision ?? header.current_revision);
    }
    const attachment = files.find((file) => file.id === input.uploadId);
    if (!attachment) fail('NOT_FOUND');
    const { rows } = await tx.query(`SELECT * FROM cb_media_uploads
      WHERE center_id = $1 AND conversation_id = $2 AND id = $3 AND state = 'bound' FOR SHARE`,[scope.centerId,scope.roomId,input.uploadId]);
    if (!rows.length) fail('NOT_FOUND');
    return { file:servingFile(rows[0]),attachment };
  }
  async open(actor, input) {
    keys(input,['conversationId','uploadId','source','range']); attachmentId(input.uploadId); id(input.conversationId);
    if (input.source?.kind === 'message') {
      keys(input.source,['kind','messageId','feedbackRevision']); id(input.source.messageId);
      if (input.source.feedbackRevision !== undefined) revision(input.source.feedbackRevision);
    } else if (['record','record-reference'].includes(input.source?.kind)) {
      keys(input.source,input.source.kind==='record-reference' ? ['kind','recordId','revision','messageId'] : ['kind','recordId','revision']); id(input.source.recordId);
      if (input.source.kind==='record-reference') id(input.source.messageId);
      if (input.source.revision !== undefined) revision(input.source.revision);
    } else fail('INVALID_INPUT');
    if (input.range !== undefined) {
      keys(input.range,['start','end']);
      if (!Number.isSafeInteger(input.range.start) || input.range.start < 0 ||
          (input.range.end !== undefined && (!Number.isSafeInteger(input.range.end) || input.range.end < input.range.start))) fail('INVALID_INPUT');
    }
    const read = () => this.conversations.inRoom(actor,input.conversationId,(tx,scope) => this.authorize(tx,scope,input));
    const original = await read(), start = input.range?.start ?? 0, end = input.range?.end ?? original.file.size - 1;
    if (start >= original.file.size || end >= original.file.size) fail('INVALID_RANGE');
    const handle = await this.store.openVerified(original.file.object_key,original.file);
    try {
      const current = await read();
      if (current.file.version !== original.file.version || current.file.object_key !== original.file.object_key) fail('UPLOAD_CONFLICT');
      return { stream:handle.createReadStream({ start,end,autoClose:true }),attachment:current.attachment,range:{ start,end },total:current.file.size };
    } catch (error) { await handle.close(); throw error; }
  }
}
