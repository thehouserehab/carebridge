import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';
import { lockCenterSchedule, scheduleError } from './schedule-gate.mjs';

const id = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
const keys = (input, allowed) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some((key) => !allowed.includes(key))) fail('INVALID_INPUT');
};
const version = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INPUT');
  return value;
};
const participant = (input, role) => {
  keys(input, ['userId', 'history']);
  if (!['all', 'from_now', 'preserve'].includes(input.history)) fail('INVALID_INPUT');
  return { userId: id(input.userId), role, history: input.history };
};
const projection = (row) => ({
  userId: row.user_id, role: row.role, active: row.active,
  firstSequence: Number(row.first_sequence),
});
const receipt = (row, replayed) => ({
  conversationId: row.conversation_id,
  appliedVersion: Number(row.applied_version), changed: row.changed, replayed,
});

// Internal server service; no HTTP route or browser connection is provided.
// actor comes from a verified server session. Submitted role fields are never
// authority. A center manager can edit participation without reading messages.
export class Relationships {
  constructor(database) {
    if (!database?.transaction) throw new TypeError('Relationships requires a transactional database.');
    this.database = database;
  }

  async inManagedRoom(actor, roomId, work, { scheduleWrite = false } = {}) {
    const centerId = id(actor?.centerId);
    const userId = id(actor?.userId);
    id(roomId);
    return this.database.transaction(async (tx) => {
      if (scheduleWrite) await lockCenterSchedule(tx, centerId);
      // Allocation writes lock the center gate, then room, memberships/users,
      // and participant rows. Read-only relationship inspection starts at room.
      // The second authorization check locks the manager's current membership
      // so deactivation cannot race the write after the initial EXISTS check.
      const { rows: rooms } = await tx.query(`SELECT c.child_id, c.last_sequence, c.relationships_version
        FROM cb_conversations c WHERE c.center_id = $1 AND c.id = $2 AND EXISTS (
          SELECT 1 FROM cb_memberships m JOIN cb_users u ON u.id = m.user_id
          WHERE m.center_id = c.center_id AND m.user_id = $3
            AND m.role = 'center' AND m.active AND u.active)
        FOR UPDATE OF c`, [centerId, roomId, userId]);
      if (!rooms.length) fail('NOT_FOUND');
      const { rows: managers } = await tx.query(`SELECT m.user_id FROM cb_memberships m
        JOIN cb_users u ON u.id = m.user_id
        WHERE m.center_id = $1 AND m.user_id = $2
          AND m.role = 'center' AND m.active AND u.active FOR SHARE OF m, u`, [centerId, userId]);
      if (!managers.length) fail('NOT_FOUND');
      return work(tx, {
        centerId, roomId, userId, childId: rooms[0].child_id,
        lastSequence: Number(rooms[0].last_sequence),
        relationshipsVersion: Number(rooms[0].relationships_version),
      });
    }).catch((error) => {
      if (error.code === '23505' && error.constraint === 'cb_relationship_requests_pkey')
        fail('IDEMPOTENCY_CONFLICT');
      scheduleError(error);
    });
  }

  async get(actor, input) {
    keys(input, ['conversationId']);
    return this.inManagedRoom(actor, input.conversationId, async (tx, scope) => {
      const { rows } = await tx.query(`SELECT user_id, role, active, first_sequence FROM cb_participants
        WHERE center_id = $1 AND conversation_id = $2 ORDER BY role, user_id`, [scope.centerId, scope.roomId]);
      return {
        conversationId: scope.roomId, childId: scope.childId,
        version: scope.relationshipsVersion, participants: rows.map(projection),
      };
    });
  }

  // Replace the therapist/guardian set in one transaction. Care-recipient
  // identity and its connection belong to their separate manager command;
  // a pre-existing assignment form must never silently disconnect that user.
  // Each new
  // or reactivated participant needs an explicit history decision; preserve is
  // only valid for a currently active relation. No account/center role is created.
  async replace(actor, input) {
    keys(input, ['conversationId', 'clientId', 'expectedVersion', 'therapist', 'guardians', 'historyConfirmed', 'pastHistoryConfirmed']);
    const roomId = id(input.conversationId);
    if (typeof input.clientId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(input.clientId)) fail('INVALID_INPUT');
    const expectedVersion = version(input.expectedVersion);
    if (input.historyConfirmed !== true) fail('HISTORY_CONFIRMATION_REQUIRED');
    if (input.pastHistoryConfirmed !== undefined && typeof input.pastHistoryConfirmed !== 'boolean') fail('INVALID_INPUT');
    if (!Array.isArray(input.guardians) || input.guardians.length > 100) fail('INVALID_INPUT');
    const therapist = input.therapist === null ? null : participant(input.therapist, 'therapist');
    const guardians = input.guardians.map((value) => participant(value, 'guardian'))
      .sort((a, b) => a.userId.localeCompare(b.userId, 'en'));
    const desired = [...(therapist ? [therapist] : []), ...guardians];
    if (new Set(desired.map((p) => p.userId)).size !== desired.length) fail('INVALID_INPUT');
    const requestHash = createHash('sha256').update(JSON.stringify({ roomId, expectedVersion, desired })).digest('hex');

    return this.inManagedRoom(actor, roomId, async (tx, scope) => {
      const { rows: priorRequests } = await tx.query(`SELECT conversation_id, request_hash, applied_version, changed
        FROM cb_relationship_requests WHERE center_id = $1 AND actor_id = $2 AND client_id = $3`,
      [scope.centerId, scope.userId, input.clientId]);
      if (priorRequests.length) {
        const prior = priorRequests[0];
        if (prior.conversation_id !== roomId || prior.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
        return receipt(prior, true);
      }
      if (scope.relationshipsVersion !== expectedVersion) fail('RELATIONSHIP_CONFLICT');

      // Lock selected accounts/memberships while validating their current role.
      // Existing but disabled/foreign users are indistinguishable from missing ones.
      const desiredIds = desired.map((p) => p.userId).sort();
      if (desiredIds.length) {
        const { rows: members } = await tx.query(`SELECT m.user_id, m.role FROM cb_memberships m
          JOIN cb_users u ON u.id = m.user_id
          WHERE m.center_id = $1 AND m.user_id = ANY($2::text[]) AND m.active AND u.active
          ORDER BY m.user_id FOR SHARE OF m, u`, [scope.centerId, desiredIds]);
        if (desired.some((p) => !members.some((m) => m.user_id === p.userId && m.role === p.role)))
          fail('PARTICIPANT_UNAVAILABLE');
      }
      const { rows: previousRows } = await tx.query(`SELECT user_id, role, active, first_sequence
        FROM cb_participants WHERE center_id = $1 AND conversation_id = $2
        ORDER BY user_id FOR UPDATE`, [scope.centerId, roomId]);
      const previous = new Map(previousRows.map((row) => [row.user_id, projection(row)]));
      const desiredSet = new Set(desiredIds);
      const changes = [];
      for (const old of previous.values()) {
        if (old.active && old.role !== 'care_recipient' && !desiredSet.has(old.userId))
          changes.push({ old, next: { ...old, active: false }, history: 'disconnect' });
      }
      for (const selected of desired) {
        const old = previous.get(selected.userId);
        if (old && old.role !== selected.role) fail('PARTICIPANT_UNAVAILABLE');
        if (selected.history === 'preserve' && !old?.active) fail('HISTORY_CHOICE_REQUIRED');
        if (selected.history === 'all' && (!old?.active || old.firstSequence > 1) && input.pastHistoryConfirmed !== true)
          fail('PAST_HISTORY_CONFIRMATION_REQUIRED');
        const firstSequence = selected.history === 'preserve' ? old.firstSequence
          : selected.history === 'all' ? 1 : scope.lastSequence + 1;
        if (!Number.isSafeInteger(firstSequence)) fail('SEQUENCE_LIMIT');
        const next = { userId: selected.userId, role: selected.role, active: true, firstSequence };
        if (!old || !old.active || old.firstSequence !== firstSequence)
          changes.push({ old, next, history: selected.history });
      }

      // Disconnect the old therapist before adding the replacement, preserving
      // the database's one-active-therapist constraint and all authored messages.
      for (const change of changes) {
        const { old, next } = change;
        await tx.query(`INSERT INTO cb_participants
          (center_id, conversation_id, user_id, role, active, first_sequence)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (center_id, conversation_id, user_id)
          DO UPDATE SET active = EXCLUDED.active, first_sequence = EXCLUDED.first_sequence`,
        [scope.centerId, roomId, next.userId, next.role, next.active, next.firstSequence]);
        // Re-entry and newly granted older history must not inherit an old read
        // cursor that silently marks the newly visible material as read.
        if (next.active && (!old?.active || next.firstSequence < old.firstSequence))
          await tx.query(`DELETE FROM cb_read_states
            WHERE center_id = $1 AND conversation_id = $2 AND user_id = $3`,
          [scope.centerId, roomId, next.userId]);
      }
      const { rows: updated } = await tx.query(`SELECT relationships_version FROM cb_conversations
        WHERE center_id = $1 AND id = $2`, [scope.centerId, roomId]);
      const appliedVersion = Number(updated[0].relationships_version);
      await tx.query(`INSERT INTO cb_relationship_requests
        (center_id, conversation_id, actor_id, client_id, request_hash, expected_version, applied_version, changed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [scope.centerId, roomId, scope.userId, input.clientId, requestHash, expectedVersion, appliedVersion, changes.length > 0]);
      for (const { old, next, history } of changes) {
        await tx.query(`INSERT INTO cb_relationship_changes
          (center_id, conversation_id, actor_id, client_id, user_id, role,
           previous_active, previous_first_sequence, next_active, next_first_sequence, history_mode)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [scope.centerId, roomId, scope.userId, input.clientId, next.userId, next.role,
          old?.active ?? null, old?.firstSequence ?? null, next.active, next.firstSequence, history]);
      }
      return { conversationId: roomId, appliedVersion, changed: changes.length > 0, replayed: false };
    }, { scheduleWrite: true });
  }
}
