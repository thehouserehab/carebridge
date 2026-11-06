import { fail } from './errors.mjs';

const ID = '[A-Za-z0-9_-]{1,100}';
const pathPattern = new RegExp(`^/api/local/centers/(${ID})/conversations/(${ID})/(goals|appointments|records|feedback|publications|measurements|family-plan)(?:/(${ID}))?(?:/(preview|publish|review|withdraw))?$`);
const pick = (value, keys) => Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, required = allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) fail('INVALID_INPUT');
}
const activity = (value) => value == null ? null : pick(value, ['title', 'instruction', 'frequency', 'caution']);
const attachmentCount = (value) => Array.isArray(value) ? value.length : 0;
function noAttachmentInput(content) {
  if (!object(content)) fail('INVALID_INPUT');
  if (Object.hasOwn(content, 'attachments') && (!Array.isArray(content.attachments) || content.attachments.length)) fail('ATTACHMENTS_NOT_CONNECTED');
}
function noAttachments(files) { if (attachmentCount(files)) fail('ATTACHMENTS_NOT_CONNECTED'); }
const receipt = (value) => pick(value, ['recordId', 'feedbackId', 'revision', 'reviewVersion', 'operation', 'messageId', 'replayed']);
const appointmentView = (value) => pick(value, ['id', 'conversationId', 'childId', 'revision', 'title', 'status', 'updatedAt', 'date', 'time', 'duration', 'room', 'therapistId']);
const goalView = (value) => pick(value, ['id', 'conversationId', 'childId', 'revision', 'title', 'status', 'description', 'updatedAt']);

// Input is already a role/history-filtered service projection. Public chat
// never inherits a therapist's private review fields, even for that therapist.
export function localMessageView(message, { mediaDelivery = false } = {}) {
  const result = {
    ...pick(message, ['id', 'conversationId', 'childId', 'sequence', 'authorId', 'createdAt', 'type', 'body']),
    read: message.read === true, edited: message.edited === true, hidden: message.hidden === true,
    deleted: message.deleted === true, archived: message.archived === true, version: message.version ?? null,
    canReply: message.canReply === true, reviewed: message.reviewed === true,
    canEdit: message.canEdit === true, canDeleteAll: message.canDeleteAll === true, canHide: message.canHide === true,
    attachmentCount: message.hidden ? 0 : attachmentCount(message.attachments),
  };
  if (message.hidden) return result;
  if (mediaDelivery && !message.deleted) result.attachments = (message.attachments ?? []).map((file) => pick(file, ['id', 'name', 'type', 'size']));
  if (message.publication) result.publication = {
    ...pick(message.publication, ['id', 'recordId', 'version', 'recordRevision', 'date', 'title', 'summary', 'sharedAt']),
    activity: activity(message.publication.activity),
  };
  if (message.feedback) result.feedback = pick(message.feedback, ['id', 'publicationId', 'revision', 'date', 'result', 'reaction', 'difficulty', 'reviewed', 'updatedAt']);
  if (message.quote) result.quote = message.quote.hidden
    ? pick(message.quote, ['id', 'hidden', 'body'])
    : pick(message.quote, ['id', 'hidden', 'authorId', 'body', 'preview', 'version', 'changed', 'feedbackId', 'feedbackRevision']);
  return result;
}
function recordView(record, { mediaDelivery = false } = {}) {
  return {
    ...pick(record, ['id', 'conversationId', 'childId', 'revision', 'authorId', 'goalId', 'appointmentId', 'goalRevision',
      'appointmentRevision', 'date', 'format', 'status', 'title', 'performed', 'response', 'nextPlan', 'summary', 'privateNote', 'createdAt']),
    goalSnapshot: record.goalSnapshot == null ? null : pick(record.goalSnapshot, ['revision', 'title', 'description', 'status']),
    appointmentSnapshot: record.appointmentSnapshot == null ? null : pick(record.appointmentSnapshot, ['revision', 'date', 'time', 'duration', 'title', 'room', 'status']),
    observation: record.observation == null ? null : pick(record.observation, ['status', 'task', 'assistance', 'amount', 'repetitions', 'duration', 'context']),
    assessments: record.assessments.map((row) => pick(row, ['tool', 'item', 'value', 'unit', 'context'])),
    activity: activity(record.activity), attachmentCount: attachmentCount(record.attachments),
    ...(mediaDelivery ? { attachments: (record.attachments ?? []).map((file) => pick(file, ['id', 'name', 'type', 'size', 'share'])) } : {}),
    referenceMessageIds: [...record.referenceMessageIds], referenceSources: record.referenceSources.map((source) => ({
      ...pick(source, ['messageId', 'messageRevision', 'body', 'changed', 'deleted', 'hidden', 'feedbackId', 'feedbackRevision']),
      ...(Array.isArray(source.attachments) ? { attachmentCount: source.attachments.length } : {}),
      ...(mediaDelivery && Array.isArray(source.attachments) ? {
        attachments: source.attachments.map((file) => pick(file, ['id', 'name', 'type', 'size'])),
      } : {}),
    })),
  };
}
function query(url, allowed) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) fail('INVALID_INPUT');
    if (['dateFrom', 'dateTo', 'afterId', 'afterAppointment', 'afterMeasurement'].includes(key)) result[key] = value;
    else {
      if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) fail('INVALID_INPUT');
      result[key] = Number(value);
    }
  }
  return result;
}

// A descriptor only. Authentication/source/expected-account checks stay in the
// single local-api-http entry point; this helper never mounts its own routes.
export function localCareRoute(url, method) {
  const match = pathPattern.exec(url.pathname);
  if (!match) return null;
  const [, centerId, conversationId, collection, targetId, action] = match;
  let methods, allowed = [];
  if (['goals', 'appointments'].includes(collection) && !targetId && !action) {
    methods = ['GET']; allowed = collection === 'goals' ? ['afterId', 'limit', 'expectedRevision']
      : ['dateFrom', 'dateTo', 'limit', 'expectedVersion', 'afterAppointment'];
  } else if (collection === 'family-plan' && !targetId && !action) methods = ['GET', 'POST'];
  else if (collection === 'goals' && targetId && !action) methods = ['GET', 'POST'];
  else if (collection === 'appointments' && targetId && !action) methods = ['GET', 'POST'];
  else if (collection === 'measurements' && !targetId && !action) { methods = ['GET']; allowed = ['afterMeasurement', 'limit', 'expectedRevision']; }
  else if (collection === 'records' && !targetId && !action) { methods = ['GET']; allowed = ['after', 'limit', 'expectedRevision']; }
  else if (collection === 'records' && targetId && !action) { methods = ['GET', 'POST']; if (method === 'GET') allowed = ['revision']; }
  else if (collection === 'records' && targetId && ['preview', 'publish'].includes(action)) methods = [action === 'preview' ? 'GET' : 'POST'];
  else if (collection === 'feedback' && targetId && !action) { methods = ['GET', 'POST']; if (method === 'GET') allowed = ['revision']; }
  else if (collection === 'feedback' && targetId && action === 'review') methods = ['GET', 'POST'];
  else if (collection === 'publications' && targetId && action === 'withdraw') methods = ['POST'];
  else return null;
  if (!methods.includes(method)) fail('NOT_FOUND');
  const params = query(url, allowed);
  if (params.afterId !== undefined) { params.after = params.afterId; delete params.afterId; }
  if (params.afterAppointment !== undefined) {
    try { params.after = JSON.parse(params.afterAppointment); } catch { fail('INVALID_INPUT'); }
    delete params.afterAppointment;
  }
  if (params.afterMeasurement !== undefined) {
    try { params.after = JSON.parse(params.afterMeasurement); } catch { fail('INVALID_INPUT'); }
    delete params.afterMeasurement;
    keys(params.after, ['sequence', 'ordinal']);
    if (!Number.isSafeInteger(params.after.sequence) || params.after.sequence < 0 ||
        !Number.isInteger(params.after.ordinal) || params.after.ordinal < 0 || params.after.ordinal > 19) fail('INVALID_INPUT');
  }
  return { centerId, conversationId, collection, targetId, action, method, params };
}
function service(services, name, methods) {
  const value = services?.[name];
  if (!methods.every((method) => typeof value?.[method] === 'function')) fail('LOCAL_API_UNAVAILABLE');
  return value;
}

export async function executeLocalCare(route, identity, body, services, { mediaDelivery = false } = {}) {
  const { conversationId, collection, targetId, action, method, params } = route;
  if (collection === 'family-plan') {
    if (method === 'GET') {
      const profile = await service(services, 'profiles', ['get']).get(identity, { conversationId });
      if (!object(profile.familyPlan)) fail('FORBIDDEN');
      return { status: 200, body: { familyPlan: { ...pick(profile, ['conversationId', 'childId']),
        ...pick(profile.familyPlan, ['revision', 'concern']) } } };
    }
    keys(body, ['clientId', 'expectedRevision', 'concern']);
    // The existing service validates/captures fields before awaiting, checks
    // current guardian authority, and acknowledges a prior immutable receipt.
    // Do not add a preliminary read that could prevent a committed retry.
    const saved = await service(services, 'profiles', ['saveFamilyPlan']).saveFamilyPlan(identity, { conversationId, ...body });
    return { status: 200, body: { receipt: pick(saved,
      ['operation', 'childId', 'conversationId', 'appliedVersion', 'changed', 'replayed']) } };
  }
  if (collection === 'measurements') {
    const page = await service(services, 'records', ['measurements']).measurements(identity, { conversationId, ...params });
    return { status: 200, body: page.resetRequired ? pick(page, ['revision', 'resetRequired']) : {
      ...pick(page, ['revision', 'resetRequired', 'hasMore']),
      nextCursor: page.nextCursor == null ? null : pick(page.nextCursor, ['sequence', 'ordinal']),
      measurements: page.measurements.map((row) => pick(row, ['recordId', 'recordRevision', 'date', 'title', 'goalId', 'goalTitle',
        'ordinal', 'tool', 'item', 'value', 'unit', 'context'])),
    } };
  }
  if (collection === 'goals') {
    if (targetId) {
      const goals = service(services, 'goals', [method === 'GET' ? 'get' : 'save']);
      if (method === 'GET') return { status: 200, body: { goal: goalView(await goals.get(identity, { conversationId, goalId: targetId })) } };
      keys(body, ['clientId', 'expectedRevision', 'content']);
      keys(body.content, ['title', 'description', 'status']);
      // The existing service checks current therapist authority, then exact
      // receipts before CAS. No preliminary GET can block a committed retry.
      const saved = await goals.save(identity, { conversationId, goalId: targetId, ...body });
      return { status: 200, body: { receipt: pick(saved, ['kind', 'id', 'revision', 'changed', 'replayed']) } };
    }
    const page = await service(services, 'goals', ['list']).list(identity, { conversationId, ...params });
    return { status: 200, body: page.resetRequired ? pick(page, ['revision', 'resetRequired']) : {
      ...pick(page, ['revision', 'resetRequired', 'nextCursor', 'hasMore']),
      goals: page.goals.map(goalView),
    } };
  }
  if (collection === 'appointments') {
    const appointments = service(services, 'appointments', [targetId ? (method === 'GET' ? 'get' : 'save') : 'list']);
    if (targetId) {
      if (method === 'GET') return { status: 200, body: { appointment: appointmentView(await appointments.get(identity,
        { conversationId, appointmentId: targetId }, { clinicalOnly: true })) } };
      keys(body, ['clientId', 'expectedRevision', 'content']);
      keys(body.content, ['date', 'time', 'duration', 'title', 'room', 'status']);
      // A retry must reach the existing receipt check without a preliminary
      // read or a new client ID. Schedule allocation and CAS stay atomic there.
      const saved = await appointments.save(identity, { conversationId, appointmentId: targetId, ...body }, { clinicalOnly: true });
      return { status: 200, body: { receipt: pick(saved, ['kind', 'id', 'revision', 'changed', 'replayed']) } };
    }
    const page = await appointments.list(identity, { conversationId, ...params }, { clinicalOnly: true });
    return { status: 200, body: page.resetRequired ? pick(page, ['version', 'resetRequired']) : {
      ...pick(page, ['version', 'resetRequired', 'hasMore']),
      nextCursor: page.nextCursor == null ? null : pick(page.nextCursor, ['date', 'time', 'conversationId', 'appointmentId']),
      appointments: page.appointments.map(appointmentView),
    } };
  }
  if (collection === 'records') {
    const records = service(services, 'records', ['list', 'get', 'save', 'preview', 'publish']);
    if (!targetId) {
      const page = await records.list(identity, { conversationId, ...params });
      return { status: 200, body: page.resetRequired ? pick(page, ['revision', 'resetRequired']) : {
        ...pick(page, ['revision', 'resetRequired', 'nextCursor', 'hasMore']), records: page.records.map((record) => pick(record, ['id', 'revision', 'date', 'title', 'status', 'appointmentId'])) } };
    }
    if (action === 'preview') {
      const preview = await records.preview(identity, { conversationId, recordId: targetId });
      return { status: 200, body: { preview: { ...pick(preview, ['recordId', 'recordRevision', 'relationshipsVersion', 'recipientIds', 'date', 'title', 'summary']),
        activity: activity(preview.activity), attachmentCount: attachmentCount(preview.attachments),
        ...(mediaDelivery ? { attachments: (preview.attachments ?? []).filter((file) => file.share === true)
          .map((file) => pick(file, ['id', 'name', 'type', 'size', 'share'])) } : {}) } } };
    }
    if (action === 'publish') {
      keys(body, ['clientId', 'expectedRevision', 'expectedRelationshipsVersion', 'recipientIds']);
      // Inspect the exact immutable version the caller confirmed, not a newer
      // head that could race this check. Publish rechecks that version and peers.
      if (!mediaDelivery) {
        const record = await records.get(identity, { conversationId, recordId: targetId, revision: body.expectedRevision });
        noAttachments(record.attachments?.filter((file) => file.share));
      }
      return { status: 201, body: { receipt: receipt(await records.publish(identity, { conversationId, recordId: targetId, ...body })) } };
    }
    if (method === 'GET') return { status: 200, body: { record: recordView(await records.get(identity, { conversationId, recordId: targetId, ...params }), { mediaDelivery }) } };
    keys(body, ['clientId', 'expectedRevision', 'expectedGoalRevision', 'expectedAppointmentRevision', 'content'], ['clientId', 'expectedRevision', 'content']);
    if (!mediaDelivery) {
      noAttachmentInput(body.content);
      if (body.expectedRevision !== 0) {
        const old = await records.get(identity, { conversationId, recordId: targetId, revision: body.expectedRevision });
        noAttachments(old.attachments);
      }
    }
    return { status: 201, body: { receipt: receipt(await records.save(identity, { conversationId, recordId: targetId, ...body })) } };
  }
  if (collection === 'feedback') {
    const feedback = service(services, 'feedback', ['get', 'save', 'review']);
    if (action === 'review') {
      if (method === 'POST') {
        keys(body, ['clientId', 'expectedRevision', 'expectedReviewVersion', 'note']);
        return { status: 200, body: { receipt: receipt(await feedback.review(identity, { conversationId, feedbackId: targetId, ...body })) } };
      }
      // Use the existing room transaction and projection, with a role check
      // inside that same transaction. No pre-read role grants private access.
      const conversations = service(services, 'conversations', ['inRoom', 'view']);
      const review = await conversations.inRoom(identity, conversationId, async (tx, scope) => {
        if (scope.role !== 'therapist') fail('FORBIDDEN');
        const card = await conversations.view(tx, scope, await feedback.message(tx, scope, targetId));
        return { feedbackId: targetId, revision: card.feedback.revision, reviewVersion: card.feedback.reviewVersion ?? 0,
          note: card.feedback.reviewNote ?? '', reviewed: card.feedback.reviewed === true, reviewedAt: card.feedback.reviewedAt ?? null };
      });
      return { status: 200, body: { review } };
    }
    if (method === 'GET') return { status: 200, body: { message: localMessageView(await feedback.get(identity, { conversationId, feedbackId: targetId, ...params }), { mediaDelivery }) } };
    keys(body, ['sourceMessageId', 'clientId', 'expectedRevision', 'content']);
    if (!mediaDelivery) noAttachmentInput(body.content);
    if (!mediaDelivery && body.expectedRevision !== 0) {
      const current = await feedback.get(identity, { conversationId, feedbackId: targetId });
      if (!(current.archived && current.hidden)) {
        if (!current.feedback || body.expectedRevision > current.feedback.revision) fail('FEEDBACK_CONFLICT');
        // Existing feedback media cannot silently disappear through a text-only
        // editor. A racing new version also fails the service's revision check.
        noAttachments(current.attachments);
      }
      // A withdrawn guardian projection conceals media. Do not treat it as an
      // empty attachment list: only the existing service decides this branch.
      // It acknowledges an exact prior receipt first; all new mutations then
      // fail the permanently revoked source or immutable source-relation check.
    }
    return { status: 201, body: { receipt: receipt(await feedback.save(identity, { conversationId, feedbackId: targetId, ...body })) } };
  }
  keys(body, []);
  const message = await service(services, 'conversations', ['withdraw']).withdraw(identity, { conversationId, messageId: targetId });
  return { status: 200, body: { message: localMessageView(message, { mediaDelivery }) } };
}
