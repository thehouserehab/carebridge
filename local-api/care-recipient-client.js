import { LocalApiError } from './client.js';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const version = value => Number.isSafeInteger(value) && value >= 0;
const command = value => typeof value === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(value);
const exact = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const fail = (code = 'INVALID_RESPONSE', status = 0) => { throw new LocalApiError(code, status); };
const path = (center, resource) => { if (!id(center)) fail('INVALID_INPUT'); return `/api/local/centers/${center}/${resource}`; };

// One cookie transport and account precondition. No role, password or source
// metadata is sent as authorization and no result is kept in browser storage.
export class CareRecipientApiClient {
  constructor(transport) { this.transport = transport; }
  async request(url, body, signal) {
    const account = this.transport.expectedUserId;
    const current = () => {
      if (signal?.aborted) fail('CANCELLED');
      if (!id(account) || this.transport.expectedUserId !== account) fail('AUTH_REQUIRED', 401);
    };
    current();
    try { const value = await this.transport.request(url, { body, signal }); current(); return value; }
    catch (error) { current(); if (error instanceof LocalApiError) throw error; fail('UNAVAILABLE'); }
  }
  async link(centerId, roomId, signal) {
    if (!id(roomId)) fail('INVALID_INPUT');
    const value = (await this.request(`${path(centerId, 'care-recipient-link')}?conversationId=${roomId}`, undefined, signal))?.link;
    if (!exact(value, ['conversationId', 'childId', 'userId', 'active', 'version']) || value.conversationId !== roomId ||
      !id(value.childId) || !(value.userId === null || id(value.userId)) || typeof value.active !== 'boolean' ||
      (value.active && !value.userId) || !version(value.version)) fail();
    return Object.freeze({ ...value });
  }
  async primary(centerId, roomId, signal) {
    if (!id(roomId)) fail('INVALID_INPUT');
    const value = (await this.request(`${path(centerId, 'primary-communicator')}?conversationId=${roomId}`, undefined, signal))?.primary;
    if (!exact(value, ['conversationId', 'userId', 'revision']) || value.conversationId !== roomId ||
      !(value.userId === null || id(value.userId)) || !version(value.revision)) fail();
    return Object.freeze({ ...value });
  }
  async save(centerId, kind, input, signal) {
    if (!['connect', 'disconnect', 'primary'].includes(kind)) fail('INVALID_INPUT');
    const revisionKey = kind === 'primary' ? 'expectedRevision' : 'expectedVersion';
    if (!exact(input, ['conversationId', 'userId', revisionKey, 'clientId']) || !id(input.conversationId) ||
      !(id(input.userId) || (kind === 'primary' && input.userId === null)) || !version(input[revisionKey]) || !command(input.clientId)) fail('INVALID_INPUT');
    const body = Object.freeze({ ...input });
    const resource = kind === 'primary' ? 'primary-communicator' : `care-recipient-link${kind === 'disconnect' ? '/disconnect' : ''}`;
    const value = (await this.request(path(centerId, resource), body, signal))?.receipt;
    const appliedKey = kind === 'primary' ? 'appliedRevision' : 'appliedVersion';
    if (!exact(value, ['conversationId', appliedKey, 'changed', 'replayed']) || value.conversationId !== body.conversationId ||
      typeof value.changed !== 'boolean' || typeof value.replayed !== 'boolean' || !version(value[appliedKey]) ||
      value[appliedKey] !== body[revisionKey] + Number(value.changed)) fail();
    return Object.freeze({ ...value });
  }
}

// Defensive UI projection, not a replacement for the server's access rules.
// A recipient cannot recover clinical/attachment metadata from a renderer.
export function recipientTextMessage(message) {
  if (message?.type !== 'text' || (!message.hidden && !message.deleted && !message.body?.trim())) return null;
  const keys = ['id', 'conversationId', 'childId', 'sequence', 'authorId', 'body', 'type', 'read', 'createdAt', 'hidden', 'deleted', 'edited', 'version'];
  return Object.fromEntries(keys.filter(key => Object.hasOwn(message, key)).map(key => [key, message[key]]));
}
