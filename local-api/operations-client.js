import { LocalApiError } from './client.js';
import { childProfileFields, memberDisplayName, profileToday, ProfileFieldError } from '../src/profile-fields.js';

const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const fail = (code = 'INVALID_RESPONSE') => { throw new LocalApiError(code); };
const pathId = (value) => { if (!id(value)) fail('INVALID_INPUT'); return value; };
const keys = ['conversationId', 'childId', 'name', 'age', 'ageAsOf', 'revision'];
const pick = (value, names) => Object.fromEntries(names.map((key) => [key, value[key]]));
const operationsPath = (centerId) => `/api/local/centers/${pathId(centerId)}/operations`;
const profilePath = (centerId, roomId) => `${operationsPath(centerId)}/conversations/${pathId(roomId)}/profile`;
const relationshipsPath = (centerId, roomId) => `${operationsPath(centerId)}/conversations/${pathId(roomId)}/relationships`;
const commandId = value => typeof value === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(value);
const exactKeys = (value, names) => object(value) && names.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => names.includes(key));
const relationshipKeys = ['therapist', 'guardians', 'historyConfirmed', 'pastHistoryConfirmed'];

// This validates a submitted choice, not account eligibility or existing
// history. Only the server can decide whether preserve is currently permitted.
export function relationshipFields(input) {
  if (!exactKeys(input, relationshipKeys) || typeof input.historyConfirmed !== 'boolean' ||
      typeof input.pastHistoryConfirmed !== 'boolean' || !Array.isArray(input.guardians) || input.guardians.length > 100)
    fail('INVALID_INPUT');
  if (!input.historyConfirmed) fail('HISTORY_CONFIRMATION_REQUIRED');
  const participant = value => {
    if (!exactKeys(value, ['userId', 'history']) || !id(value.userId) ||
        !['preserve', 'from_now', 'all'].includes(value.history)) fail('INVALID_INPUT');
    return { userId: value.userId, history: value.history };
  };
  const therapist = input.therapist === null ? null : participant(input.therapist);
  const guardians = Array.from(input.guardians, participant).sort((a, b) => a.userId.localeCompare(b.userId, 'en'));
  const selected = [...(therapist ? [therapist] : []), ...guardians];
  if (new Set(selected.map(p => p.userId)).size !== selected.length) fail('INVALID_INPUT');
  if (selected.some(p => p.history === 'all') && !input.pastHistoryConfirmed) fail('PAST_HISTORY_CONFIRMATION_REQUIRED');
  return { therapist, guardians, historyConfirmed: true, pastHistoryConfirmed: input.pastHistoryConfirmed };
}

function member(value) {
  if (!object(value) || !['userId', 'role', 'displayName'].every(key => Object.hasOwn(value, key)) ||
      !id(value.userId) || !['center', 'therapist', 'guardian', 'care_recipient'].includes(value.role)) fail();
  try { if (memberDisplayName(value.displayName) !== value.displayName) fail(); }
  catch (error) { if (error instanceof ProfileFieldError) fail(); throw error; }
  return pick(value, ['userId', 'role', 'displayName']);
}

function relationshipView(value, roomId) {
  if (!object(value) || value.conversationId !== roomId || !id(value.childId) || !revision(value.version) ||
      !Array.isArray(value.participants) || value.participants.length > 102) fail();
  const seen = new Set(); let therapists = 0, guardians = 0, recipients = 0;
  const participants = Array.from(value.participants, p => {
    if (!object(p) || !id(p.userId) || !['therapist', 'guardian', 'care_recipient'].includes(p.role) ||
        !revision(p.firstSequence) || p.firstSequence < 1 || seen.has(p.userId)) fail();
    seen.add(p.userId);
    if (p.role === 'therapist') therapists++; else if (p.role === 'guardian') guardians++; else recipients++;
    return pick(p, ['userId', 'role', 'firstSequence']);
  });
  if (therapists > 1 || guardians > 100 || recipients > 1) fail();
  // Do not filter through the directory: an existing active relationship can
  // outlive an account's eligibility and still requires an explicit decision.
  return { conversationId: roomId, childId: value.childId, version: value.version, participants };
}

function profile(value, roomId) {
  if (!object(value) || !keys.every((key) => Object.hasOwn(value, key)) ||
      !id(value.conversationId) || !id(value.childId) || !revision(value.revision) ||
      (roomId !== undefined && value.conversationId !== roomId)) fail();
  if (value.name === null) {
    // An existing child/room may not have its first profile yet. Do not invent
    // an age, a display name or a version for that initial state.
    if (value.revision !== 0 || value.age !== null || value.ageAsOf !== null) fail();
  } else {
    if (value.revision < 1) fail();
    let normalized;
    try { normalized = childProfileFields(pick(value, ['name', 'age', 'ageAsOf'])); }
    catch (error) { if (error instanceof ProfileFieldError) fail(); throw error; }
    if (normalized.name !== value.name || normalized.age !== value.age || normalized.ageAsOf !== value.ageAsOf) fail();
  }
  // Operational metadata only. Never retain participants, family concerns,
  // clinical notes, message previews or an injected credential field.
  return pick(value, keys);
}

function accountGuard(api, signal) {
  const account = api.expectedUserId;
  return () => {
    if (signal?.aborted) fail('CANCELLED');
    if (!id(account) || api.expectedUserId !== account) throw new LocalApiError('AUTH_REQUIRED', 401);
  };
}
async function request(api, path, body, signal, current) {
  current();
  try {
    const result = await api.request(path, { body, signal });
    current(); return result;
  } catch (error) {
    current();
    if (error instanceof LocalApiError) throw error;
    fail('UNAVAILABLE');
  }
}

// Composition keeps one login identity/transport. This adapter neither accepts
// a caller role nor grants center access; the server checks it on every request.
export class OperationsApiClient {
  #api;
  constructor(api) {
    if (!api || typeof api.request !== 'function') throw new TypeError('Local API transport required.');
    this.#api = api;
  }
  async children(centerId, signal) {
    const path = `${operationsPath(centerId)}/children`, current = accountGuard(this.#api, signal);
    const result = [], childIds = new Set(), roomIds = new Set(), cursors = new Set();
    let after;
    // Unlike the chat workspace, this keyset collection has no atomic snapshot
    // token. Concurrent changes can occur between pages. A complete read is not
    // authority to edit: obtain the current detail again and save with its CAS.
    // No partial list is returned on failure; no automatic restart hides it.
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: '100', ...(after === undefined ? {} : { afterId: after }) });
      const value = await request(this.#api, `${path}?${query}`, undefined, signal, current);
      if (!object(value) || !Array.isArray(value.children) || value.children.length > 100 ||
          typeof value.hasMore !== 'boolean' || !(value.nextCursor === null || id(value.nextCursor))) fail();
      const rows = value.children.map((row) => profile(row));
      if (value.nextCursor !== (rows.at(-1)?.childId ?? null) ||
          (value.hasMore && rows.length === 0) || (value.nextCursor !== null && cursors.has(value.nextCursor))) fail();
      for (const row of rows) {
        if (childIds.has(row.childId) || roomIds.has(row.conversationId)) fail();
        childIds.add(row.childId); roomIds.add(row.conversationId);
      }
      result.push(...rows);
      if (!value.hasMore) { current(); return result; }
      // The database owns the child-ID collation. Check cursor identity and
      // progress without imposing JavaScript's different string sort order.
      cursors.add(value.nextCursor); after = value.nextCursor;
    }
    fail('TOO_MUCH_DATA');
  }
  async childProfile(centerId, roomId, signal) {
    const path = profilePath(centerId, roomId), current = accountGuard(this.#api, signal);
    const value = await request(this.#api, path, undefined, signal, current);
    return profile(value?.profile, roomId);
  }
  async childRegister(centerId, operation, signal) {
    const path = `${operationsPath(centerId)}/children`, current = accountGuard(this.#api, signal);
    if (!exactKeys(operation, ['clientId', 'childId', 'conversationId', 'content']) ||
        !commandId(operation.clientId) || !id(operation.childId) || !id(operation.conversationId) ||
        !exactKeys(operation.content, ['name', 'age', 'ageAsOf']) || operation.content.age === undefined ||
        operation.content.ageAsOf === undefined) fail('INVALID_INPUT');
    let content;
    try { content = childProfileFields(operation.content, { today: profileToday() }); }
    catch (error) { if (error instanceof ProfileFieldError) fail('INVALID_INPUT'); throw error; }
    const body = { clientId: operation.clientId, childId: operation.childId, conversationId: operation.conversationId, content };
    const value = await request(this.#api, path, body, signal, current), r = value?.receipt;
    if (!object(r) || r.operation !== 'child.register' || r.childId !== body.childId ||
        r.conversationId !== body.conversationId || r.appliedVersion !== 1 || r.changed !== true || typeof r.replayed !== 'boolean') fail();
    return pick(r, ['operation', 'childId', 'conversationId', 'appliedVersion', 'changed', 'replayed']);
  }
  async members(centerId, signal) {
    const path = `${operationsPath(centerId)}/members`, current = accountGuard(this.#api, signal);
    const result = [], seen = new Set(), cursors = new Set(); let after;
    // A complete directory is not an atomic relationship/eligibility snapshot.
    // Discard partial results and let the save service recheck current roles.
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ limit: '100', ...(after === undefined ? {} : { afterId: after }) });
      const value = await request(this.#api, `${path}?${query}`, undefined, signal, current);
      if (!object(value) || !Array.isArray(value.members) || value.members.length > 100 || typeof value.hasMore !== 'boolean' ||
          !(value.nextCursor === null || id(value.nextCursor))) fail();
      const rows = Array.from(value.members, member);
      if (value.nextCursor !== (rows.at(-1)?.userId ?? null) || (value.hasMore && !rows.length) ||
          (value.nextCursor !== null && cursors.has(value.nextCursor))) fail();
      for (const row of rows) { if (seen.has(row.userId)) fail(); seen.add(row.userId); }
      result.push(...rows);
      if (!value.hasMore) { current(); return result; }
      cursors.add(value.nextCursor); after = value.nextCursor;
    }
    fail('TOO_MUCH_DATA');
  }
  async relationships(centerId, roomId, signal) {
    const path = relationshipsPath(centerId, roomId), current = accountGuard(this.#api, signal);
    const value = await request(this.#api, path, undefined, signal, current);
    return relationshipView(value?.relationships, roomId);
  }
  async relationshipsSave(centerId, roomId, operation, signal) {
    const path = relationshipsPath(centerId, roomId), current = accountGuard(this.#api, signal);
    if (!exactKeys(operation, ['clientId', 'expectedVersion', ...relationshipKeys]) ||
        !commandId(operation.clientId) || !revision(operation.expectedVersion)) fail('INVALID_INPUT');
    const body = { clientId: operation.clientId, expectedVersion: operation.expectedVersion,
      ...relationshipFields(pick(operation, relationshipKeys)) };
    const value = await request(this.#api, path, body, signal, current), r = value?.receipt;
    if (!object(r) || r.conversationId !== roomId || !revision(r.appliedVersion) ||
        typeof r.changed !== 'boolean' || typeof r.replayed !== 'boolean' ||
        (r.changed ? r.appliedVersion <= body.expectedVersion : r.appliedVersion !== body.expectedVersion)) fail();
    // Several participant changes may advance the relationship version in one
    // transaction. Do not reuse the profile's one-step revision arithmetic.
    return pick(r, ['conversationId', 'appliedVersion', 'changed', 'replayed']);
  }
  async childProfileSave(centerId, roomId, expectedChildId, operation, signal) {
    const path = profilePath(centerId, roomId), current = accountGuard(this.#api, signal);
    if (!id(expectedChildId) || !object(operation) || typeof operation.clientId !== 'string' ||
        !/^[A-Za-z0-9-]{8,100}$/.test(operation.clientId) || !revision(operation.expectedRevision) ||
        !object(operation.content) || !['name', 'age', 'ageAsOf'].every((key) => Object.hasOwn(operation.content, key))) fail('INVALID_INPUT');
    let content;
    try { content = childProfileFields(operation.content, { today: profileToday() }); }
    catch (error) { if (error instanceof ProfileFieldError) fail('INVALID_INPUT'); throw error; }
    // Capture the exact command before awaiting. Response loss is an unknown
    // outcome: only the caller may explicitly retry its original operation.
    const body = { clientId: operation.clientId, expectedRevision: operation.expectedRevision, content };
    const value = await request(this.#api, path, body, signal, current), r = value?.receipt;
    if (!object(r) || r.operation !== 'child.save' || r.childId !== expectedChildId || r.conversationId !== roomId ||
        !revision(r.appliedVersion) || typeof r.changed !== 'boolean' || typeof r.replayed !== 'boolean' ||
        r.appliedVersion !== body.expectedRevision + Number(r.changed)) fail();
    return pick(r, ['operation', 'childId', 'conversationId', 'appliedVersion', 'changed', 'replayed']);
  }
}
