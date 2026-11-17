import { LocalApiError } from './client.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new LocalApiError('INVALID_RESPONSE'); };
const metadata = value => ['openai', 'fixture'].includes(value?.mode) && text(value.model, 128) && value.model.length > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function parseAiConversation(value) {
  if (!exact(value, ['revision','messages','mode','model','contextTruncated']) || !revision(value.revision) ||
      !metadata(value) || typeof value.contextTruncated !== 'boolean' || !Array.isArray(value.messages) ||
      value.messages.length > 12 || value.messages.length % 2 !== 0) invalid();
  for (const [index, message] of value.messages.entries()) {
    if (!exact(message, ['role','content']) || message.role !== (index % 2 ? 'assistant' : 'user') ||
        !text(message.content, index % 2 ? 6000 : 2000) || !message.content.trim()) invalid();
  }
  return structuredClone(value);
}

export function parseAiPreview(value, recordId, expectedRevision) {
  if (!exact(value, ['recordId','revision','source','sourceHash','mode','model']) || value.recordId !== recordId ||
      value.revision !== expectedRevision || !metadata(value) || !hash(value.sourceHash) ||
      !exact(value.source, ['performed','response']) ||
      !['performed','response'].every(key => text(value.source[key], 2000))) invalid();
  return structuredClone(value);
}

export function parseAiDraft(value, preview, requestId) {
  if (!exact(value, ['recordId','revision','sourceHash','requestId','summary','reviewNotes','mode','model']) ||
      !metadata(value) || value.mode !== preview.mode || value.model !== preview.model ||
      value.recordId !== preview.recordId || value.revision !== preview.revision || value.sourceHash !== preview.sourceHash ||
      value.requestId !== requestId || !text(value.summary, 1200) || !value.summary.trim() ||
      !Array.isArray(value.reviewNotes) || value.reviewNotes.length > 4 ||
      !value.reviewNotes.every(note => text(note, 200) && note.trim())) invalid();
  return structuredClone(value);
}

export class AiClient {
  constructor(api) { this.api = api; }
  room(context) {
    if (!id(context?.user?.userId) || !id(context.centerId) || !id(context.roomId) ||
        this.api.expectedUserId !== context.user.userId) throw new LocalApiError('AUTH_REQUIRED');
    return this.api.roomPath(context.centerId, context.roomId);
  }
  async request(context, path, body, signal) {
    this.room(context);
    const value = await this.api.request(path, {body,signal});
    this.room(context);
    if (signal?.aborted) throw new LocalApiError('CANCELLED');
    return value;
  }
  async conversation(context, signal) {
    const value = await this.request(context, this.room(context)+'/ai-conversation', undefined, signal);
    if (!exact(value,['conversation'])) invalid();
    return parseAiConversation(value.conversation);
  }
  async send(context, operation, signal) {
    const value = await this.request(context, this.room(context)+'/ai-conversation', operation, signal);
    if (!exact(value,['conversation'])) invalid();
    return parseAiConversation(value.conversation);
  }
  async preview(context, record, signal) {
    if (!id(record?.id) || !revision(record.revision) || !record.revision) invalid();
    const path = this.room(context)+'/records/'+record.id+'/ai-summary?revision='+record.revision;
    const value = await this.request(context, path, undefined, signal);
    if (!exact(value,['preview'])) invalid();
    return parseAiPreview(value.preview,record.id,record.revision);
  }
  async generate(context, preview, requestId, signal) {
    const body = {expectedRevision:preview.revision,sourceHash:preview.sourceHash,requestId};
    const value = await this.request(context,this.room(context)+'/records/'+preview.recordId+'/ai-summary',body,signal);
    if (!exact(value,['draft'])) invalid();
    return parseAiDraft(value.draft,preview,requestId);
  }
}
