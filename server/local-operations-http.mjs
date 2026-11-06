import { fail } from './errors.mjs';

const ID = '[A-Za-z0-9_-]{1,100}';
const childrenPath = new RegExp(`^/api/local/centers/(${ID})/operations/children$`);
const membersPath = new RegExp(`^/api/local/centers/(${ID})/operations/members$`);
const profilePath = new RegExp(`^/api/local/centers/(${ID})/operations/conversations/(${ID})/profile$`);
const relationshipsPath = new RegExp(`^/api/local/centers/(${ID})/operations/conversations/(${ID})/relationships$`);
const appointmentsPath = new RegExp(`^/api/local/centers/(${ID})/operations/appointments$`);
const appointmentPath = new RegExp(`^/api/local/centers/(${ID})/operations/conversations/(${ID})/appointments/(${ID})$`);
const profileView = (value) => ({ conversationId: value.conversationId, childId: value.childId,
  name: value.name, age: value.age, ageAsOf: value.ageAsOf, revision: value.revision });
const profileReceipt = (value) => ({ operation: value.operation, childId: value.childId,
  conversationId: value.conversationId, appliedVersion: value.appliedVersion, changed: value.changed, replayed: value.replayed });
const memberView = (value) => ({ userId: value.userId, role: value.role, displayName: value.displayName });
const appointmentView = (value) => ({ id: value.id, conversationId: value.conversationId, childId: value.childId,
  revision: value.revision, title: value.title, status: value.status, updatedAt: value.updatedAt,
  date: value.date, time: value.time, duration: value.duration, room: value.room, therapistId: value.therapistId });
const appointmentCursor = (value) => value === null ? null : ({ date: value.date, time: value.time,
  conversationId: value.conversationId, appointmentId: value.appointmentId });
function relationshipsView(value) {
  if (!Array.isArray(value?.participants)) fail('LOCAL_API_UNAVAILABLE');
  // Keep active relations even when their member/account is no longer active.
  // Omitting them would turn a later full replacement into an implicit removal.
  const active = value.participants.filter(participant => participant.active === true);
  // The extra recipient slot must not enlarge the existing guardian limit or
  // silently accept an invalid set that the replacement command cannot save.
  const limits = { guardian: 100, therapist: 1, care_recipient: 1 }, counts = new Map();
  for (const participant of active) {
    if (!Object.hasOwn(limits, participant.role)) fail('LOCAL_API_UNAVAILABLE');
    const count = (counts.get(participant.role) ?? 0) + 1;
    if (count > limits[participant.role]) fail('LOCAL_API_UNAVAILABLE');
    counts.set(participant.role, count);
  }
  return { conversationId: value.conversationId, childId: value.childId, version: value.version,
    participants: active.map(participant => ({ userId: participant.userId, role: participant.role, firstSequence: participant.firstSequence })) };
}
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
}
function query(url, list) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!list || !['afterId', 'limit'].includes(key) || Object.hasOwn(result, key)) fail('INVALID_INPUT');
    if (key === 'afterId') {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT');
      result.afterId = value;
    } else {
      if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) fail('INVALID_INPUT');
      result.limit = Number(value);
    }
  }
  return result;
}
function appointmentQuery(url) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!['dateFrom', 'dateTo', 'limit', 'expectedVersion', 'afterAppointment'].includes(key) || Object.hasOwn(result, key)) fail('INVALID_INPUT');
    if (key === 'dateFrom' || key === 'dateTo') result[key] = value;
    else if (key === 'afterAppointment') {
      try { result[key] = JSON.parse(value); } catch { fail('INVALID_INPUT'); }
      keys(result[key], ['date', 'time', 'conversationId', 'appointmentId']);
    } else {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_INPUT');
      result[key] = Number(value);
      if (key === 'limit' && (result[key] < 1 || result[key] > 100)) fail('INVALID_INPUT');
    }
  }
  const { afterAppointment, ...params } = result;
  return { ...params, ...(afterAppointment !== undefined ? { after: afterAppointment } : {}) };
}

// Closed descriptor only: authentication, account binding and loopback/CSRF
// protection remain in the common HTTP entry point. No clinical route alias.
export function localOperationsRoute(url, method) {
  const children = childrenPath.exec(url.pathname), members = membersPath.exec(url.pathname);
  const profile = profilePath.exec(url.pathname), relationships = relationshipsPath.exec(url.pathname);
  const appointments = appointmentsPath.exec(url.pathname), appointment = appointmentPath.exec(url.pathname);
  if (appointments || appointment) {
    if (appointments ? method !== 'GET' : !['GET', 'POST'].includes(method)) fail('NOT_FOUND');
    return { centerId: (appointments ?? appointment)[1], conversationId: appointment?.[2], appointmentId: appointment?.[3],
      collection: 'appointments', method, params: appointments ? appointmentQuery(url) : query(url, false) };
  }
  if (!children && !members && !profile && !relationships) return null;
  if (members ? method !== 'GET' : !['GET', 'POST'].includes(method)) fail('NOT_FOUND');
  return { centerId: (children ?? members ?? profile ?? relationships)[1], conversationId: (profile ?? relationships)?.[2],
    collection: children ? 'children' : members ? 'members' : profile ? 'profile' : 'relationships', method,
    params: query(url, method === 'GET' && !!(children || members)) };
}

export async function executeLocalOperations(route, identity, body, profiles, { members, relationships, appointments } = {}) {
  // These service methods re-check the current center role inside their DB
  // transaction; an earlier authenticated membership is not read authority.
  if (route.collection === 'appointments') {
    const method = route.appointmentId ? (route.method === 'GET' ? 'get' : 'save') : 'list';
    if (typeof appointments?.[method] !== 'function') fail('LOCAL_API_UNAVAILABLE');
    // This option is trusted routing configuration, never a body/query role.
    const scope = { operationalOnly: true };
    if (method === 'list') {
      const page = await appointments.list(identity, route.params, scope);
      return { status: 200, body: page.resetRequired ? { version: page.version, resetRequired: true }
        : { appointments: page.appointments.map(appointmentView), version: page.version, resetRequired: false,
          nextCursor: appointmentCursor(page.nextCursor), hasMore: page.hasMore } };
    }
    const target = { conversationId: route.conversationId, appointmentId: route.appointmentId };
    if (method === 'get') return { status: 200, body: { appointment: appointmentView(await appointments.get(identity, target, scope)) } };
    keys(body, ['clientId', 'expectedRevision', 'content']);
    keys(body.content, ['date', 'time', 'duration', 'title', 'room', 'status']);
    const saved = await appointments.save(identity, { ...target, ...body }, scope);
    return { status: 200, body: { receipt: { kind: saved.kind, id: saved.id, revision: saved.revision,
      changed: saved.changed, replayed: saved.replayed } } };
  }
  if (route.collection === 'members') {
    if (typeof members?.listMembers !== 'function') fail('LOCAL_API_UNAVAILABLE');
    const page = await members.listMembers(identity, {
      ...(route.params.afterId !== undefined ? { after: route.params.afterId } : {}),
      ...(route.params.limit !== undefined ? { limit: route.params.limit } : {}),
    });
    // An active center membership is not proof of a provisioned login account.
    // No account/email lookup or implied invitation is performed here.
    return { status: 200, body: { members: page.members.map(memberView), nextCursor: page.nextCursor, hasMore: page.hasMore } };
  }
  if (route.collection === 'relationships') {
    const method = route.method === 'GET' ? 'get' : 'replace';
    if (typeof relationships?.[method] !== 'function') fail('LOCAL_API_UNAVAILABLE');
    if (method === 'get') return { status: 200, body: { relationships: relationshipsView(
      await relationships.get(identity, { conversationId: route.conversationId })) } };
    keys(body, ['clientId', 'expectedVersion', 'therapist', 'guardians', 'historyConfirmed', 'pastHistoryConfirmed']);
    if (typeof body.historyConfirmed !== 'boolean' || typeof body.pastHistoryConfirmed !== 'boolean' || !Array.isArray(body.guardians)) fail('INVALID_INPUT');
    if (body.therapist !== null) keys(body.therapist, ['userId', 'history']);
    for (const guardian of body.guardians) keys(guardian, ['userId', 'history']);
    const saved = await relationships.replace(identity, { conversationId: route.conversationId, ...body });
    return { status: 200, body: { receipt: { conversationId: saved.conversationId,
      appliedVersion: saved.appliedVersion, changed: saved.changed, replayed: saved.replayed } } };
  }
  const method = route.collection === 'children' ? (route.method === 'GET' ? 'listManaged' : 'register')
    : route.method === 'GET' ? 'getManaged' : 'save';
  if (typeof profiles?.[method] !== 'function') fail('LOCAL_API_UNAVAILABLE');
  if (method === 'listManaged') {
    const page = await profiles.listManaged(identity, {
      ...(route.params.afterId !== undefined ? { after: route.params.afterId } : {}),
      ...(route.params.limit !== undefined ? { limit: route.params.limit } : {}),
    });
    return { status: 200, body: { children: page.children.map(profileView), nextCursor: page.nextCursor, hasMore: page.hasMore } };
  }
  if (method === 'getManaged') return { status: 200,
    body: { profile: profileView(await profiles.getManaged(identity, { conversationId: route.conversationId })) } };
  if (method === 'register') {
    keys(body, ['clientId', 'childId', 'conversationId', 'content']);
    keys(body.content, ['name', 'age', 'ageAsOf']);
    return { status: 201, body: { receipt: profileReceipt(await profiles.register(identity, body)) } };
  }
  keys(body, ['clientId', 'expectedRevision', 'content']);
  // Full replacement must explicitly retain or clear the age/date pair. A
  // omitted field must not silently erase data entered in another screen.
  keys(body.content, ['name', 'age', 'ageAsOf']);
  const saved = await profiles.save(identity, { conversationId: route.conversationId,
    clientId: body.clientId, expectedRevision: body.expectedRevision, content: body.content });
  return { status: 200, body: { receipt: profileReceipt(saved) } };
}
