import { LocalApiError } from './client.js';
import { appointmentFields, contextDate } from '../src/context-fields.js';

const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const revision = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum && value <= 2147483647;
const fail = (code = 'INVALID_RESPONSE') => { throw new LocalApiError(code); };
const pathId = (value) => { if (!id(value)) fail('INVALID_INPUT'); return value; };
const contentKeys = ['date', 'time', 'duration', 'title', 'room', 'status'];
const appointmentKeys = ['id', 'conversationId', 'childId', 'revision', ...contentKeys, 'updatedAt', 'therapistId'];
const pick = (value, names) => Object.fromEntries(names.map((key) => [key, value[key]]));
const centerPath = (centerId, operational) => `/api/local/centers/${pathId(centerId)}${operational ? '/operations' : ''}`;
const appointmentPath = (centerId, roomId, appointmentId, operational) =>
  `${centerPath(centerId, operational)}/conversations/${pathId(roomId)}/appointments/${pathId(appointmentId)}`;
const cursorKeys = ['date', 'time', 'conversationId', 'appointmentId'];
const exactKeys = (value, names) => object(value) && Reflect.ownKeys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
const scheduleVersion = value => Number.isSafeInteger(value) && value >= 0;

function period(input) {
  if (!exactKeys(input, ['dateFrom', 'dateTo'])) fail('INVALID_INPUT');
  let dateFrom, dateTo;
  try { dateFrom = contextDate(input.dateFrom); dateTo = contextDate(input.dateTo); }
  catch { fail('INVALID_INPUT'); }
  const days = (Date.parse(`${dateTo}T12:00:00Z`) - Date.parse(`${dateFrom}T12:00:00Z`)) / 86400000;
  if (days < 0 || days > 92) fail('INVALID_INPUT');
  return { dateFrom, dateTo };
}
function cursor(value, dateFrom, dateTo) {
  if (!exactKeys(value, cursorKeys) || !id(value.conversationId) || !id(value.appointmentId) ||
      typeof value.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) fail();
  try { contextDate(value.date); } catch { fail(); }
  if (value.date < dateFrom || value.date > dateTo) fail();
  return pick(value, cursorKeys);
}

function content(input, code = 'INVALID_INPUT') {
  if (!object(input) || Reflect.ownKeys(input).length !== contentKeys.length ||
      !contentKeys.every((key) => Object.hasOwn(input, key) &&
        (key === 'duration' ? ['string', 'number'].includes(typeof input[key]) : typeof input[key] === 'string'))) fail(code);
  try { return appointmentFields(input); }
  catch { fail(code); }
}
function appointment(value, roomId, appointmentId) {
  if (!object(value) || !appointmentKeys.every((key) => Object.hasOwn(value, key)) || value.id !== appointmentId ||
      value.conversationId !== roomId || !id(value.childId) || !revision(value.revision, 1) ||
      !(value.therapistId === null || id(value.therapistId)) ||
      typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) ||
      new Date(value.updatedAt).toISOString() !== value.updatedAt) fail();
  const normalized = content(pick(value, contentKeys), 'INVALID_RESPONSE');
  if (contentKeys.some((key) => normalized[key] !== value[key])) fail();
  // Current scheduling data is distinct from a record's historical snapshot.
  // Keep only this contract, never clinical notes, people lists or credentials.
  return pick(value, appointmentKeys);
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
    const value = await api.request(path, { body, signal });
    current(); return value;
  } catch (error) {
    current();
    if (error instanceof LocalApiError) throw error;
    fail('UNAVAILABLE');
  }
}

// The shared transport owns authentication and deadlines. This adapter does not
// grant scheduling permissions, cache current state or retry uncertain writes.
export class AppointmentApiClient {
  #api;
  #operational;
  constructor(api, options = {}) {
    if (!api || typeof api.request !== 'function') throw new TypeError('Local API transport required.');
    if (!object(options) || Reflect.ownKeys(options).some(key => key !== 'operational') ||
        (Object.hasOwn(options, 'operational') && typeof options.operational !== 'boolean'))
      throw new TypeError('Invalid appointment client mode.');
    this.#api = api;
    // A fixed route choice made by the owner UI, never a permission grant or a
    // body/query role override. The server independently checks center access.
    this.#operational = Object.hasOwn(options, 'operational') && options.operational;
  }
  content(input) { return content(input); }
  async list(centerId, input, signal) {
    if (!this.#operational) fail('INVALID_INPUT');
    const path = `${centerPath(centerId, true)}/appointments`, { dateFrom, dateTo } = period(input);
    const current = accountGuard(this.#api, signal), appointments = [], seen = new Set(), cursors = new Set();
    let after, version, lastTime;
    // Never mix two schedule versions or return partial pages. A changed
    // snapshot is an explicit failure; the caller decides when to read again.
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ dateFrom, dateTo, limit: '100',
        ...(after === undefined ? {} : { expectedVersion: String(version), afterAppointment: JSON.stringify(after) }) });
      const value = await request(this.#api, `${path}?${query}`, undefined, signal, current);
      if (!object(value) || !scheduleVersion(value.version) || typeof value.resetRequired !== 'boolean') fail();
      if (value.resetRequired || (version !== undefined && value.version !== version)) fail('SNAPSHOT_CHANGED');
      if (!Array.isArray(value.appointments) || value.appointments.length > 100 || typeof value.hasMore !== 'boolean') fail();
      const rows = Array.from(value.appointments, row => {
        if (!object(row) || !id(row.id) || !id(row.conversationId)) fail();
        const projected = appointment(row, row.conversationId, row.id);
        if (projected.date < dateFrom || projected.date > dateTo) fail();
        const time = `${projected.date}T${projected.time}`, key = JSON.stringify([projected.conversationId, projected.id]);
        if ((lastTime !== undefined && time < lastTime) || seen.has(key)) fail();
        seen.add(key); lastTime = time; return projected;
      });
      const next = value.nextCursor === null ? null : cursor(value.nextCursor, dateFrom, dateTo), last = rows.at(-1);
      const expected = last ? { date: last.date, time: last.time, conversationId: last.conversationId, appointmentId: last.id } : null;
      if (JSON.stringify(next) !== JSON.stringify(expected) || (value.hasMore && !last)) fail();
      const cursorKey = JSON.stringify(next);
      if (next && cursors.has(cursorKey)) fail();
      version = value.version; appointments.push(...rows);
      if (!value.hasMore) { current(); return { appointments, version }; }
      // IDs follow database collation, not JavaScript sorting. Date/time order,
      // unique room/appointment keys and exact last-row cursors prove progress.
      cursors.add(cursorKey); after = next;
    }
    throw new LocalApiError('TOO_MUCH_DATA');
  }
  async appointment(centerId, roomId, appointmentId, signal) {
    const path = appointmentPath(centerId, roomId, appointmentId, this.#operational), current = accountGuard(this.#api, signal);
    const value = await request(this.#api, path, undefined, signal, current);
    return appointment(value?.appointment, roomId, appointmentId);
  }
  async save(centerId, roomId, appointmentId, operation, signal) {
    const path = appointmentPath(centerId, roomId, appointmentId, this.#operational), current = accountGuard(this.#api, signal);
    if (!object(operation) || typeof operation.clientId !== 'string' || !/^[A-Za-z0-9-]{8,100}$/.test(operation.clientId) ||
        !revision(operation.expectedRevision)) fail('INVALID_INPUT');
    // Capture every wire field before the first await. The caller retains this
    // immutable operation for an explicit same-ID retry after response loss.
    const body = { clientId: operation.clientId, expectedRevision: operation.expectedRevision, content: content(operation.content) };
    const value = await request(this.#api, path, body, signal, current), receipt = value?.receipt;
    if (!object(receipt) || receipt.kind !== 'appointment' || receipt.id !== appointmentId || !revision(receipt.revision, 1) ||
        typeof receipt.changed !== 'boolean' || typeof receipt.replayed !== 'boolean' ||
        receipt.revision !== body.expectedRevision + Number(receipt.changed)) fail();
    return pick(receipt, ['kind', 'id', 'revision', 'changed', 'replayed']);
  }
}
