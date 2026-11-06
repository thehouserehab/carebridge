import { LocalApiClient, LocalApiError } from './client.js';
import { attachmentListValid, MEDIA_LIMITS } from '../src/media-policy.js';

const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const revisionValue = (value) => Number.isInteger(value) && value >= 1 && value <= 2147483647;
const invalid = () => { throw new LocalApiError('INVALID_RESPONSE'); };
const pathId = (value) => { if (!id(value)) throw new LocalApiError('INVALID_INPUT'); return value; };
const query = (input) => {
  const q = new URLSearchParams(Object.entries(input).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)]));
  return q.size ? `?${q}` : '';
};
const pick = (input, keys) => Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
const reviewVersion = (value) => Number.isInteger(value) && value >= 0 && value <= 2147483647;
const reviewText = (value) => typeof value === 'string' && value.length <= 2000 && value.isWellFormed() &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value);
const familyConcern = (value) => typeof value === 'string' && value.length <= 1000 && value.isWellFormed() &&
  !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value);
// Keep sensitive reads/receipts local to this call. A changed account must not
// receive late content or treat another account's receipt as its own success.
async function accountRequest(client, path, body, signal) {
  const account = client.expectedUserId;
  const current = () => {
    if (signal?.aborted) throw new LocalApiError('CANCELLED');
    if (!id(account) || client.expectedUserId !== account) throw new LocalApiError('AUTH_REQUIRED', 401);
  };
  current();
  try {
    const value = await client.request(path, { body, signal });
    current(); return value;
  } catch (error) { current(); throw error; }
}
const measurementKeys = ['recordId', 'recordRevision', 'date', 'title', 'goalId', 'goalTitle', 'ordinal', 'tool', 'item', 'value', 'unit', 'context'];
const measurementText = (value, max) => typeof value === 'string' && value.isWellFormed() &&
  value.length > 0 && value.length <= max && value === value.trim();
const measurementOrdinal = (value) => Number.isInteger(value) && value >= 0 && value < 20;
function measurementDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function measurementRow(row) {
  if (!object(row) || !id(row.recordId) || !revisionValue(row.recordRevision) || !measurementDate(row.date) ||
      !measurementText(row.title, 100) || !id(row.goalId) ||
      !(row.goalTitle === null || measurementText(row.goalTitle, 100)) || !measurementOrdinal(row.ordinal) ||
      !['tool', 'item', 'unit'].every((key) => measurementText(row[key], 100)) || !measurementText(row.context, 300) ||
      typeof row.value !== 'number' || !Number.isFinite(row.value)) invalid();
  // Do not retain the full clinical record, injected private fields or references.
  return pick(row, measurementKeys);
}
function measurementCursor(value) {
  if (!object(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'sequence') ||
      !Object.hasOwn(value, 'ordinal') || !count(value.sequence) || value.sequence < 1 || !measurementOrdinal(value.ordinal)) invalid();
  return { sequence: value.sequence, ordinal: value.ordinal };
}
function recordFiles(value, sharedOnly = false) {
  if (!attachmentListValid(value) || !value.every((file) =>
    Object.keys(file).length === 5 && Object.keys(file).every((key) => ['id', 'name', 'type', 'size', 'share'].includes(key)) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(file.id) &&
    file.name === file.name.trim() && !!file.name.trim() && file.name.isWellFormed() && !/[\x00-\x1f\x7f/\\]/.test(file.name) &&
    (!sharedOnly || file.share === true))) invalid();
  return Object.freeze(value.map((file) => Object.freeze(pick(file, ['id', 'name', 'type', 'size', 'share']))));
}
function messageFiles(value) {
  if (!Array.isArray(value) || value.some((file) => !object(file) || Object.keys(file).length !== 4 ||
      !['id', 'name', 'type', 'size'].every((key) => Object.hasOwn(file, key)))) invalid();
  return Object.freeze(recordFiles(value.map((file) => ({ ...file, share: true })))
    .map((file) => Object.freeze(pick(file, ['id', 'name', 'type', 'size']))));
}
const recordReceipt = (value, recordId) => {
  const r = value?.receipt;
  if (!object(r) || r.recordId !== recordId || !count(r.revision) || r.revision < 1 ||
      !['save', 'publish'].includes(r.operation) || typeof r.replayed !== 'boolean') invalid();
  return r;
};
const feedbackReceipt = (value, feedbackId) => {
  const r = value?.receipt;
  if (!object(r) || r.feedbackId !== feedbackId || !count(r.revision) || r.revision < 1 ||
      !id(r.messageId) || !['save', 'review'].includes(r.operation) || typeof r.replayed !== 'boolean') invalid();
  return r;
};

// All collections are assembled from one service revision. No client-side
// cache persists a therapist's private projection between sessions.
export async function carePages(load, { initialCursor, maxPages = 20, maxRestarts = 2 } = {}) {
  for (let restart = 0; restart <= maxRestarts; restart++) {
    let cursor = initialCursor, revision; const items = [], seen = new Set();
    for (let page = 0; page < maxPages; page++) {
      const p = await load(cursor, revision);
      if (!object(p) || !count(p.revision) || typeof p.reset !== 'boolean') invalid();
      if (p.reset) break;
      if (revision !== undefined && p.revision !== revision) invalid();
      if (!Array.isArray(p.items) || typeof p.more !== 'boolean') invalid();
      revision = p.revision; items.push(...p.items);
      if (!p.more) return items;
      const key = JSON.stringify(p.cursor);
      if (!p.items.length || p.cursor == null || key === JSON.stringify(cursor) || seen.has(key)) invalid();
      seen.add(key); cursor = p.cursor;
      if (page === maxPages - 1) throw new LocalApiError('TOO_MUCH_DATA');
    }
  }
  throw new LocalApiError('SNAPSHOT_CHANGED');
}

export class CareApiClient extends LocalApiClient {
  async familyPlan(centerId, roomId, signal) {
    const path = `${this.roomPath(centerId, roomId)}/family-plan`;
    const value = await accountRequest(this, path, undefined, signal), plan = value?.familyPlan;
    if (!object(plan) || plan.conversationId !== roomId || !id(plan.childId) || !count(plan.revision) ||
        !familyConcern(plan.concern) || plan.concern !== plan.concern.trim()) invalid();
    return pick(plan, ['conversationId', 'childId', 'revision', 'concern']);
  }
  async familyPlanSave(centerId, roomId, expectedChildId, operation, signal) {
    const path = `${this.roomPath(centerId, roomId)}/family-plan`;
    if (!id(expectedChildId) || !object(operation) || typeof operation.clientId !== 'string' ||
        !/^[A-Za-z0-9-]{8,100}$/.test(operation.clientId) || !count(operation.expectedRevision) ||
        !familyConcern(operation.concern)) throw new LocalApiError('INVALID_INPUT');
    // Freeze the wire identity/content before awaiting; unknown outcomes are
    // retried explicitly by the caller with its original immutable operation.
    const body = { clientId: operation.clientId, expectedRevision: operation.expectedRevision, concern: operation.concern.trim() };
    const value = await accountRequest(this, path, body, signal), result = value?.receipt;
    if (!object(result) || result.operation !== 'child.concern' || result.childId !== expectedChildId ||
        result.conversationId !== roomId || !count(result.appliedVersion) || typeof result.changed !== 'boolean' ||
        typeof result.replayed !== 'boolean' || result.appliedVersion !== body.expectedRevision + Number(result.changed)) invalid();
    return pick(result, ['operation', 'childId', 'conversationId', 'appliedVersion', 'changed', 'replayed']);
  }
  async careWorkspace(centerId, roomId, { role, dateFrom, dateTo, timeline }, signal) {
    if (!['therapist', 'guardian', 'care_recipient'].includes(role) || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo))
      throw new LocalApiError('INVALID_INPUT');
    return super.workspace(centerId, roomId, signal, { timeline, readRelated: async (room) => {
      if (role === 'care_recipient') return { goals: [], appointments: [], records: [], publications: [] };
      const args = [centerId, room.conversationId];
      const goals = await this.goals(...args, signal);
      const appointments = await this.appointments(...args, { dateFrom, dateTo }, signal);
      // Current shared cards may be older than the bounded chat window. Read
      // their own authorized projection, never private clinical activities or
      // other rooms' general message histories.
      // This role hint never grants access; each endpoint authenticates again.
      const records = role === 'therapist' ? await this.records(...args, signal) : [];
      const publications = role === 'guardian' || room.conversationId === roomId
        ? await this.activePublications(...args, signal) : [];
      if (publications.some(message => message.childId !== room.childId)) invalid();
      return { goals, appointments, records, publications };
    } });
  }
  async goals(centerId, roomId, signal) {
    return carePages(async (after, expectedRevision) => {
      const p = await this.request(`${this.roomPath(centerId, roomId)}/goals${query({ afterId: after, expectedRevision, limit: 100 })}`, { signal });
      if (!p?.resetRequired && (!Array.isArray(p.goals) || !p.goals.every((g) => object(g) && id(g.id) && count(g.revision) && typeof g.title === 'string'))) invalid();
      return { revision: p.revision, reset: p.resetRequired, items: p.goals, cursor: p.nextCursor, more: p.hasMore };
    });
  }
  async appointments(centerId, roomId, { dateFrom, dateTo }, signal) {
    return carePages(async (after, expectedVersion) => {
      const p = await this.request(`${this.roomPath(centerId, roomId)}/appointments${query({ dateFrom, dateTo, afterAppointment: after, expectedVersion, limit: 100 })}`, { signal });
      if (!p?.resetRequired && (!Array.isArray(p.appointments) || !p.appointments.every((a) => object(a) && id(a.id) && count(a.revision) && typeof a.date === 'string'))) invalid();
      return { revision: p.version, reset: p.resetRequired, items: p.appointments, cursor: p.nextCursor, more: p.hasMore };
    });
  }
  async appointment(centerId, roomId, appointmentId, signal) {
    const { appointment: a } = await this.request(`${this.roomPath(centerId, roomId)}/appointments/${pathId(appointmentId)}`, { signal });
    if (!object(a) || a.id !== appointmentId || a.conversationId !== roomId || !count(a.revision) || a.revision < 1 ||
        typeof a.date !== 'string' || typeof a.title !== 'string') invalid();
    return a;
  }
  async records(centerId, roomId, signal) {
    return carePages(async (after, expectedRevision) => {
      const p = await this.request(`${this.roomPath(centerId, roomId)}/records${query({ after, expectedRevision, limit: 100 })}`, { signal });
      if (!p?.resetRequired && (!Array.isArray(p.records) || !p.records.every((r) => object(r) && id(r.id) && count(r.revision) &&
        typeof r.date === 'string' && typeof r.title === 'string' && ['draft', 'saved'].includes(r.status) &&
        (r.appointmentId === undefined || r.appointmentId === null || id(r.appointmentId))))) invalid();
      return { revision: p.revision, reset: p.resetRequired, items: p.records, cursor: p.nextCursor, more: p.hasMore };
    }, { initialCursor: 0 });
  }
  async recordMeasurements(centerId, roomId, signal) {
    const path = `${this.roomPath(centerId, roomId)}/measurements`, account = this.expectedUserId;
    const seen = new Set(), versions = new Map();
    let snapshotRevision;
    const current = () => {
      if (signal?.aborted) throw new LocalApiError('CANCELLED');
      if (this.expectedUserId !== account) throw new LocalApiError('AUTH_REQUIRED', 401);
    };
    const items = await carePages(async (after, expectedRevision) => {
      current();
      // carePages restarts from no cursor/revision; old snapshot identities must
      // not reject or contaminate the replacement snapshot.
      if (expectedRevision === undefined) { seen.clear(); versions.clear(); snapshotRevision = undefined; }
      const p = await this.request(`${path}${query({ afterMeasurement: after, expectedRevision, limit: 100 })}`, { signal });
      current();
      if (!object(p) || !count(p.revision) || typeof p.resetRequired !== 'boolean') invalid();
      if (p.resetRequired) return { revision: p.revision, reset: true };
      if (!Array.isArray(p.measurements) || p.measurements.length > 100 || typeof p.hasMore !== 'boolean') invalid();
      const rows = p.measurements.map(measurementRow);
      const cursor = rows.length ? measurementCursor(p.nextCursor) : null;
      if ((!rows.length && (p.nextCursor !== null || p.hasMore)) ||
          (cursor && cursor.ordinal !== rows.at(-1).ordinal) ||
          (cursor && after && (cursor.sequence < after.sequence || cursor.sequence === after.sequence && cursor.ordinal <= after.ordinal))) invalid();
      for (const row of rows) {
        const key = JSON.stringify([row.recordId, row.recordRevision, row.ordinal]);
        if (seen.has(key) || versions.has(row.recordId) && versions.get(row.recordId) !== row.recordRevision) invalid();
        seen.add(key); versions.set(row.recordId, row.recordRevision);
      }
      snapshotRevision = p.revision;
      return { revision: p.revision, reset: false, items: rows, cursor, more: p.hasMore };
    }, { maxPages: 400 });
    current();
    return { revision: snapshotRevision, measurements: items };
  }
  recordPath(centerId, roomId, recordId) { return `${this.roomPath(centerId, roomId)}/records/${pathId(recordId)}`; }
  async record(centerId, roomId, recordId, signal, revision) {
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 1 || revision > 2147483647)) throw new LocalApiError('INVALID_INPUT');
    const { record: r } = await this.request(`${this.recordPath(centerId, roomId, recordId)}${query({ revision })}`, { signal });
    if (!object(r) || r.id !== recordId || r.conversationId !== roomId || !count(r.revision) ||
      !Array.isArray(r.assessments) || !Array.isArray(r.referenceMessageIds) || !Array.isArray(r.referenceSources) ||
      !['draft', 'saved'].includes(r.status) || (revision !== undefined && r.revision !== revision)) invalid();
    const referenceSources = r.referenceSources.map((source) => {
      if (!object(source) || !id(source.messageId)) invalid();
      if (!Object.hasOwn(source, 'attachments')) return source;
      if (!(revisionValue(source.messageRevision) || id(source.feedbackId) && revisionValue(source.feedbackRevision))) invalid();
      const attachments = messageFiles(source.attachments);
      if (source.attachmentCount !== attachments.length) invalid();
      return { ...source, attachments };
    });
    if (new Set(referenceSources.map((source) => source.messageId)).size !== referenceSources.length) invalid();
    if (Object.hasOwn(r, 'attachments')) {
      const attachments = recordFiles(r.attachments);
      if (r.attachmentCount !== attachments.length) invalid();
      return { ...r, referenceSources, attachments };
    }
    return { ...r, referenceSources };
  }
  async recordSave(centerId, roomId, recordId, operation, signal) {
    return recordReceipt(await this.request(this.recordPath(centerId, roomId, recordId), { signal,
      body: pick(operation, ['clientId', 'expectedRevision', 'expectedGoalRevision', 'expectedAppointmentRevision', 'content']),
    }), recordId);
  }
  async recordPreview(centerId, roomId, recordId, signal) {
    const { preview: p } = await this.request(`${this.recordPath(centerId, roomId, recordId)}/preview`, { signal });
    if (!object(p) || p.recordId !== recordId || !count(p.recordRevision) || !count(p.relationshipsVersion) ||
      !Array.isArray(p.recipientIds) || !p.recipientIds.every(id) || typeof p.title !== 'string' || typeof p.summary !== 'string') invalid();
    if (Object.hasOwn(p, 'attachments')) {
      const attachments = recordFiles(p.attachments, true);
      if (p.attachmentCount !== attachments.length) invalid();
      return { ...p, attachments };
    }
    return p;
  }
  async recordPublish(centerId, roomId, recordId, operation, signal) {
    return recordReceipt(await this.request(`${this.recordPath(centerId, roomId, recordId)}/publish`, { signal,
      body: pick(operation, ['clientId', 'expectedRevision', 'expectedRelationshipsVersion', 'recipientIds']),
    }), recordId);
  }
  async withdraw(centerId, roomId, messageId, signal) {
    const { message } = await this.request(`${this.roomPath(centerId, roomId)}/publications/${pathId(messageId)}/withdraw`, { body: {}, signal });
    if (!object(message) || message.id !== messageId || message.conversationId !== roomId) invalid();
    return message;
  }
  feedbackPath(centerId, roomId, feedbackId) { return `${this.roomPath(centerId, roomId)}/feedback/${pathId(feedbackId)}`; }
  async feedback(centerId, roomId, feedbackId, signal, revision) {
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 1 || revision > 2147483647)) throw new LocalApiError('INVALID_INPUT');
    const { message } = await this.request(`${this.feedbackPath(centerId, roomId, feedbackId)}${query({ revision })}`, { signal });
    if (!object(message) || !id(message.id) || message.conversationId !== roomId || message.type !== 'feedback' ||
      (!message.hidden && (message.feedback?.id !== feedbackId || !revisionValue(message.feedback.revision) ||
        (revision !== undefined && message.feedback.revision !== revision)))) invalid();
    if (Object.hasOwn(message, 'attachments')) {
      const attachments = messageFiles(message.attachments);
      if (message.attachmentCount !== attachments.length || (message.hidden || message.deleted) && attachments.length) invalid();
      return { ...message, attachments };
    }
    return message;
  }
  async feedbackSave(centerId, roomId, feedbackId, operation, signal) {
    return feedbackReceipt(await this.request(this.feedbackPath(centerId, roomId, feedbackId), { signal,
      body: pick(operation, ['sourceMessageId', 'clientId', 'expectedRevision', 'content']),
    }), feedbackId);
  }
  async feedbackReview(centerId, roomId, feedbackId, signal) {
    const { review } = await this.request(`${this.feedbackPath(centerId, roomId, feedbackId)}/review`, { signal });
    if (!object(review) || review.feedbackId !== feedbackId || !count(review.revision) || !count(review.reviewVersion) || typeof review.note !== 'string') invalid();
    return review;
  }
  async feedbackReviewSave(centerId, roomId, feedbackId, operation, signal) {
    return feedbackReceipt(await this.request(`${this.feedbackPath(centerId, roomId, feedbackId)}/review`, { signal,
      body: pick(operation, ['clientId', 'expectedRevision', 'expectedReviewVersion', 'note']),
    }), feedbackId);
  }
  async textReview(centerId, roomId, messageId, signal) {
    const path = `${this.roomPath(centerId, roomId)}/messages/${pathId(messageId)}/review`;
    const value = await accountRequest(this, path, undefined, signal), r = value?.review;
    if (!object(r) || r.messageId !== messageId || r.conversationId !== roomId || !revisionValue(r.revision) ||
        !reviewVersion(r.reviewVersion) || !reviewText(r.body) || !count(r.attachmentCount) || r.attachmentCount > MEDIA_LIMITS.count ||
        (r.reviewVersion === 0 ? r.reviewedRevision !== null || r.note !== '' :
          !revisionValue(r.reviewedRevision) || r.reviewedRevision > r.revision || !reviewText(r.note) || !r.note.trim() || r.note !== r.note.trim())) invalid();
    return pick(r, ['messageId', 'conversationId', 'revision', 'reviewVersion', 'reviewedRevision', 'note', 'body', 'attachmentCount']);
  }
  async textReviewSave(centerId, roomId, messageId, operation, signal) {
    const path = `${this.roomPath(centerId, roomId)}/messages/${pathId(messageId)}/review`;
    if (!object(operation) || typeof operation.clientId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(operation.clientId) ||
        !revisionValue(operation.expectedRevision) || !reviewVersion(operation.expectedReviewVersion) || operation.expectedReviewVersion === 2147483647 ||
        !reviewText(operation.note) || !operation.note.trim()) throw new LocalApiError('INVALID_INPUT');
    // Snapshot only the approved command fields before the first await. Never
    // retain or send user/role, source body, attachments, or other clinical data.
    const body = { clientId: operation.clientId, expectedRevision: operation.expectedRevision,
      expectedReviewVersion: operation.expectedReviewVersion, note: operation.note.trim() };
    const value = await accountRequest(this, path, body, signal), r = value?.receipt;
    if (!object(r) || r.messageId !== messageId || r.revision !== body.expectedRevision ||
        !revisionValue(r.revision) || !revisionValue(r.reviewVersion) || r.reviewVersion !== body.expectedReviewVersion + 1 ||
        r.operation !== 'review' || typeof r.replayed !== 'boolean') invalid();
    return pick(r, ['messageId', 'revision', 'reviewVersion', 'operation', 'replayed']);
  }
}
