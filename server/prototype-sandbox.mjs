import { randomUUID } from 'node:crypto';
import { createLocalPrototypeApiSandbox } from './local-api-sandbox.mjs';
import { createPrototypeProviders, readPrototypeAudioSample, prototypeAudioSample } from './prototype-ai-fixtures.mjs';
import { prototypeMediaFiles } from './prototype-media-assets.mjs';
import { Children, MemberProfiles } from './profiles.mjs';
import { Goals, Appointments } from './care-contexts.mjs';
import { Records } from './records.mjs';
import { createOwnedCleanupError } from './local-sandbox-cleanup.mjs';

/** Synthetic presentation data; external text AI is an explicit trusted capability. */
export async function createPrototypeSandbox({ port = 0, aiProviders } = {}) {
  const providers = createPrototypeProviders();
  if (aiProviders !== undefined) {
    if (!aiProviders || typeof aiProviders !== 'object' || Array.isArray(aiProviders) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(aiProviders)) ||
        Reflect.ownKeys(aiProviders).some(key => !['summaryProvider', 'chatProvider'].includes(key)) ||
        !['summaryProvider', 'chatProvider'].every(key => {
          const descriptor = Object.getOwnPropertyDescriptor(aiProviders, key);
          return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.value?.mode === 'openai';
        })) throw new TypeError('Both explicit OpenAI text providers are required.');
    providers.summaryProvider = aiProviders.summaryProvider;
    providers.chatProvider = aiProviders.chatProvider;
  }
  const aiMode = aiProviders === undefined ? 'fixture' : 'openai';
  const sandbox = await createLocalPrototypeApiSandbox({ port, ...providers, enableExternalAi: aiMode === 'openai' });
  try {
    const { ids, database } = sandbox;
    const therapist = { centerId: ids.centerId, userId: ids.therapistId };
    const guardian = { centerId: ids.centerId, userId: ids.guardianId };
    const manager = { centerId: ids.centerId, userId: ids.managerId };
    const profiles = new Children(database), members = new MemberProfiles(database);
    const goals = new Goals(database), appointments = new Appointments(database), records = new Records(database);
    const existing = await appointments.get(therapist, { conversationId: ids.conversationId, appointmentId: ids.appointmentId });
    const day = existing.date;
    const nextDay = new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    await profiles.save(manager, { conversationId: ids.conversationId, clientId: randomUUID(), expectedRevision: 1,
      content: { name: '하루', age: 5, ageAsOf: day } });
    await members.saveSelf(therapist, { clientId: randomUUID(), expectedRevision: 1, displayName: '담당 치료사' });
    await members.saveSelf(guardian, { clientId: randomUUID(), expectedRevision: 1, displayName: '하루 보호자' });
    await profiles.saveFamilyPlan(guardian, { conversationId: ids.conversationId, clientId: randomUUID(), expectedRevision: 0,
      concern: '가상 사례: 하루가 좋아하는 놀이를 함께 찾아보고 싶어요.' });
    await goals.save(therapist, { conversationId: ids.conversationId, goalId: ids.goalId, clientId: randomUUID(), expectedRevision: 1,
      content: { title: '좋아하는 놀이를 함께 찾기', description: '가상 사례: 어떤 놀이를 골랐는지와 함께한 경험을 나눠요.', status: 'active' } });
    await appointments.save(therapist, { conversationId: ids.conversationId, appointmentId: ids.appointmentId,
      clientId: randomUUID(), expectedRevision: existing.revision,
      content: { date: nextDay, time: '14:00', duration: 30, title: '놀이 참여 수업', room: '1번 치료실', status: 'scheduled' } });
    const recordId = 'prototype-record-' + randomUUID();
    await records.save(therapist, { conversationId: ids.conversationId, recordId, clientId: randomUUID(), expectedRevision: 0,
      content: { date: day, title: '놀이 참여 관찰', goalId: ids.goalId, status: 'saved',
        performed: '가상 사례: 파란 블록과 노란 블록 중 고르는 놀이를 했습니다.',
        response: '가상 사례: 하루가 파란 블록을 골랐습니다.',
        privateNote: '시연용 내부 메모입니다. 보호자 공유 보고서에는 포함되지 않습니다.',
        nextPlan: '가상 사례: 다음 수업에는 같은 블록을 준비합니다.',
        summary: '가상 사례입니다. 하루가 두 블록 중 파란 블록을 직접 골랐어요. 어떤 놀이를 골랐는지와 함께한 경험을 이 기록에 답장으로 남겨 주세요.',
        assessments: [],
        activity: { title: '좋아하는 놀이 함께 고르기', instruction: '시연용 예시: 두 블록을 나란히 놓고 하나를 골라 보는 활동입니다. 제공된 샘플 사진·영상을 첨부하고 가상의 반응을 남겨 보세요.',
          frequency: '시연에서 한 번', caution: '가상 체험 자료입니다. 실제 아동 활동 안내가 아닙니다.' } } });
    const preview = await records.preview(therapist, { conversationId: ids.conversationId, recordId });
    const publication = await records.publish(therapist, { conversationId: ids.conversationId, recordId,
      clientId: randomUUID(), expectedRevision: preview.recordRevision, expectedRelationshipsVersion: preview.relationshipsVersion,
      recipientIds: preview.recipientIds });
    const demoFiles = [...prototypeMediaFiles(), { ...prototypeAudioSample, mimeType: prototypeAudioSample.type,
      bytes: await readPrototypeAudioSample() }];
    const result = { origin: sandbox.origin, ids: Object.freeze({ ...ids, recordId, publicationMessageId: publication.messageId }), close: sandbox.close,
      demoFiles, mode: 'synthetic-prototype', aiMode };
    Object.defineProperties(result, { credentials: { value: sandbox.credentials }, database: { value: database }, mediaRoot: { value: sandbox.mediaRoot } });
    return Object.freeze(result);
  } catch (error) {
    try { await sandbox.close(); }
    catch (cleanupError) { throw createOwnedCleanupError(error, cleanupError, sandbox.close); }
    throw error;
  }
}
