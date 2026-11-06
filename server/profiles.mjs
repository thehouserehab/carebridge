import { createHash } from 'node:crypto';
import { Conversations } from './conversations.mjs';
import { Relationships } from './relationships.mjs';
import { lockCenterSchedule } from './schedule-gate.mjs';
import { fail } from './errors.mjs';
import { childProfileFields, memberDisplayName, ProfileFieldError } from '../src/profile-fields.js';
import { hasSharedCareAccess, isCareRecipient, participantVisibleSql } from './conversation-visibility.mjs';

const id = (value) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT'); return value; };
const keys = (value,allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail('INVALID_INPUT');
};
const version = (value) => { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INPUT'); return value; };
const client = (value) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(value)) fail('INVALID_INPUT'); return value; };
const text = (value,max,required = false) => {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) fail('INVALID_INPUT');
  const normalized = value.trim(); if (required && (!normalized || /[\r\n\t]/.test(normalized))) fail('INVALID_INPUT'); return normalized;
};
const childContent = (value) => {
  try { return childProfileFields(value); }
  catch (error) { if (error instanceof ProfileFieldError) fail('INVALID_INPUT'); throw error; }
};
const memberNameContent = (value) => {
  try { return memberDisplayName(value); }
  catch (error) { if (error instanceof ProfileFieldError) fail('INVALID_INPUT'); throw error; }
};
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (value) => value ? new Date(value).toISOString() : null;
const receipt = (row,replayed) => ({ operation:row.operation,childId:row.child_id,conversationId:row.conversation_id,
  userId:row.subject_user_id,appliedVersion:Number(row.applied_version),changed:row.changed,replayed });
async function duplicate(tx,scope,clientId,requestHash) {
  const { rows } = await tx.query(`SELECT * FROM cb_profile_requests WHERE center_id = $1 AND actor_id = $2 AND client_id = $3`,[scope.centerId,scope.userId,clientId]);
  if (!rows.length) return null;
  if (rows[0].request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
  return receipt(rows[0],true);
}
async function remember(tx,scope,clientId,requestHash,operation,appliedVersion,changed,childId = null,roomId = null) {
  await tx.query(`INSERT INTO cb_profile_requests(center_id,actor_id,client_id,request_hash,operation,subject_user_id,child_id,conversation_id,applied_version,changed)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[scope.centerId,scope.userId,clientId,requestHash,operation,
    operation === 'member.save' ? scope.userId : null,childId,roomId,appliedVersion,changed]);
  return { operation,userId:operation === 'member.save' ? scope.userId : null,childId,conversationId:roomId,appliedVersion,changed,replayed:false };
}
const nextVersion = (value,changed) => { if (changed && value === Number.MAX_SAFE_INTEGER) fail('REVISION_LIMIT'); return value + Number(changed); };
const conflict = (error) => {
  if (error.code === '23505' && error.constraint === 'cb_profile_requests_pkey') fail('IDEMPOTENCY_CONFLICT');
  throw error;
};
async function membership(tx,actor,managerOnly = false,write = false) {
  const centerId = id(actor?.centerId), userId = id(actor?.userId);
  const { rows } = await tx.query(`SELECT m.role FROM cb_memberships m JOIN cb_users u ON u.id = m.user_id
    WHERE m.center_id = $1 AND m.user_id = $2 AND m.active AND u.active
    ${write ? 'FOR NO KEY UPDATE OF m FOR SHARE OF u' : 'FOR SHARE OF m,u'}`,[centerId,userId]);
  if (!rows.length || (managerOnly && rows[0].role !== 'center')) fail('NOT_FOUND');
  return { centerId,userId,role:rows[0].role };
}
const memberSelect = `SELECT m.user_id,m.role,p.display_name,p.revision,p.updated_at FROM cb_memberships m
  JOIN cb_users u ON u.id = m.user_id LEFT JOIN cb_member_profiles p ON (p.center_id,p.user_id) = (m.center_id,m.user_id)`;
const memberView = (row) => ({ userId:row.user_id,role:row.role,displayName:row.display_name ?? null,revision:Number(row.revision ?? 0),updatedAt:iso(row.updated_at) });

// Display names are center-scoped, self-managed metadata, not credentials or
// legally verified identities. Managers cannot overwrite another user's name.
export class MemberProfiles {
  constructor(database) { if (!database?.transaction) throw new TypeError('Transactional database required.'); this.database = database; }
  getSelf(actor) {
    return this.database.transaction(async (tx) => {
      const scope = await membership(tx,actor);
      const { rows } = await tx.query(`${memberSelect} WHERE m.center_id = $1 AND m.user_id = $2`,[scope.centerId,scope.userId]);
      return memberView(rows[0]);
    });
  }
  saveSelf(actor,input) {
    keys(input,['clientId','expectedRevision','displayName']);
    const clientId = client(input.clientId), expected = version(input.expectedRevision);
    const displayName = memberNameContent(input.displayName);
    const requestHash = fingerprint({ operation:'member.save',expected,displayName });
    return this.database.transaction(async (tx) => {
      // Take the write lock immediately, never upgrade a shared lock: two
      // concurrent first saves must not deadlock before a profile row exists.
      const scope = await membership(tx,actor,false,true);
      const prior = await duplicate(tx,scope,clientId,requestHash); if (prior) return prior;
      const { rows } = await tx.query('SELECT display_name,revision FROM cb_member_profiles WHERE center_id = $1 AND user_id = $2 FOR UPDATE',[scope.centerId,scope.userId]);
      const old = rows[0], current = Number(old?.revision ?? 0); if (current !== expected) fail('PROFILE_CONFLICT');
      const changed = (old?.display_name ?? null) !== displayName, revision = nextVersion(current,changed);
      if (changed) {
        if (!old) await tx.query(`INSERT INTO cb_member_profiles(center_id,user_id,display_name,revision) VALUES ($1,$2,$3,$4)`,[scope.centerId,scope.userId,displayName,revision]);
        else await tx.query(`UPDATE cb_member_profiles SET display_name = $3,revision = $4,updated_at = clock_timestamp() WHERE center_id = $1 AND user_id = $2`,[scope.centerId,scope.userId,displayName,revision]);
      }
      return remember(tx,scope,clientId,requestHash,'member.save',revision,changed);
    }).catch(conflict);
  }
  listMembers(actor,input = {}) {
    keys(input,['after','limit']); const after = input.after == null ? '' : id(input.after), limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT');
    return this.database.transaction(async (tx) => {
      const scope = await membership(tx,actor,true);
      const { rows } = await tx.query(`${memberSelect} WHERE m.center_id = $1 AND m.active AND u.active AND m.user_id > $2 ORDER BY m.user_id LIMIT $3`,[scope.centerId,after,limit + 1]);
      const selected = rows.slice(0,limit);
      return { members:selected.map(memberView),nextCursor:selected.at(-1)?.user_id ?? null,hasMore:rows.length > limit };
    });
  }
}

const childSelect = `SELECT c.id AS conversation_id,c.child_id,p.name,p.age,p.age_as_of::text AS age_as_of,p.revision,p.updated_at
  FROM cb_conversations c LEFT JOIN cb_child_profiles p ON (p.center_id,p.child_id) = (c.center_id,c.child_id)`;
const childView = (row,scope) => ({ conversationId:row.conversation_id,childId:row.child_id,name:row.name ?? null,
  revision:Number(row.revision ?? 0),...(scope && isCareRecipient(scope) ? {} :
    {age:row.age ?? null,ageAsOf:row.age_as_of ?? null,updatedAt:iso(row.updated_at)}) });
async function checkAgeDate(tx,data) {
  if (data.ageAsOf !== null) {
    const { rows } = await tx.query(`SELECT (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date::text AS today`);
    if (data.ageAsOf > rows[0].today) fail('INVALID_INPUT');
  }
}

export class Children {
  constructor(database) {
    if (!database?.transaction) throw new TypeError('Transactional database required.');
    this.database = database; this.conversations = new Conversations(database); this.relationships = new Relationships(database);
  }
  async inRoom(actor,roomId,work) {
    // Dispatch by a DB role, never caller role. The existing protected service
    // revalidates it after locking the room; this first read grants no access.
    const role = await this.database.transaction(async (tx) => (await membership(tx,actor)).role);
    if (role === 'center') return this.relationships.inManagedRoom(actor,roomId,(tx,scope) => work(tx,{ ...scope,role:'center' }));
    return this.conversations.inRoom(actor,roomId,work);
  }
  register(actor,input) {
    keys(input,['childId','conversationId','clientId','content']);
    const childId = id(input.childId), roomId = id(input.conversationId), clientId = client(input.clientId), data = childContent(input.content);
    const requestHash = fingerprint({ operation:'child.register',childId,roomId,data });
    return this.database.transaction(async (tx) => {
      const centerId = id(actor?.centerId); await lockCenterSchedule(tx,centerId);
      const scope = await membership(tx,actor,true), prior = await duplicate(tx,scope,clientId,requestHash); if (prior) return prior;
      await checkAgeDate(tx,data);
      const { rows: old } = await tx.query(`SELECT id FROM cb_children WHERE center_id = $1 AND id = $2
        UNION ALL SELECT id FROM cb_conversations WHERE center_id = $1 AND id = $3`,[scope.centerId,childId,roomId]);
      if (old.length) fail('CHILD_EXISTS');
      await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)',[scope.centerId,childId]);
      await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)',[scope.centerId,roomId,childId]);
      await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by) VALUES ($1,$2,$3,$4,$5,1,$6)`,
      [scope.centerId,childId,data.name,data.age,data.ageAsOf,scope.userId]);
      return remember(tx,scope,clientId,requestHash,'child.register',1,true,childId,roomId);
    }).catch(conflict);
  }
  get(actor,input) {
    keys(input,['conversationId']);
    return this.inRoom(actor,input.conversationId,async (tx,scope) => {
      const { rows } = await tx.query(`${childSelect} WHERE c.center_id = $1 AND c.id = $2`,[scope.centerId,scope.roomId]);
      const result = childView(rows[0],scope);
      const { rows: participants } = await tx.query(`SELECT m.user_id,m.role,p.display_name,p.revision,p.updated_at FROM cb_participants team
        JOIN cb_memberships m ON (m.center_id,m.user_id,m.role) = (team.center_id,team.user_id,team.role) JOIN cb_users u ON u.id = m.user_id
        LEFT JOIN cb_member_profiles p ON (p.center_id,p.user_id) = (m.center_id,m.user_id)
        WHERE team.center_id = $1 AND team.conversation_id = $2 AND team.active AND m.active AND u.active
          AND ${participantVisibleSql('team')} ORDER BY m.role,m.user_id`,[scope.centerId,scope.roomId]);
      result.participants = participants.map(row => isCareRecipient(scope)
        ? {userId:row.user_id,role:row.role,displayName:row.display_name ?? null} : memberView(row));
      if (hasSharedCareAccess(scope)) {
        const { rows: plans } = await tx.query('SELECT concern,revision,updated_at FROM cb_child_family_plans WHERE center_id = $1 AND child_id = $2',[scope.centerId,scope.childId]);
        result.familyPlan = { concern:plans[0]?.concern ?? '',revision:Number(plans[0]?.revision ?? 0),updatedAt:iso(plans[0]?.updated_at) };
      }
      return result;
    });
  }
  getManaged(actor,input) {
    keys(input,['conversationId']); const roomId = id(input.conversationId);
    return this.relationships.inManagedRoom(actor,roomId,async (tx,scope) => {
      const { rows } = await tx.query(`${childSelect} WHERE c.center_id = $1 AND c.id = $2`,[scope.centerId,scope.roomId]);
      return childView(rows[0]);
    });
  }
  list(actor,input = {}) { return this.#list(actor,input,false); }
  listManaged(actor,input = {}) { return this.#list(actor,input,true); }
  #list(actor,input,managerOnly) {
    keys(input,['after','limit']); const after = input.after == null ? '' : id(input.after), limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT');
    return this.database.transaction(async (tx) => {
      const scope = await membership(tx,actor,managerOnly);
      const { rows } = await tx.query(`${childSelect} WHERE c.center_id = $1 AND c.child_id > $2 AND ($3 = 'center' OR EXISTS (
        SELECT 1 FROM cb_participants team WHERE team.center_id = c.center_id AND team.conversation_id = c.id
          AND team.user_id = $4 AND team.role = $3 AND team.active AND ${participantVisibleSql('team')}))
        ORDER BY c.child_id LIMIT $5`,[scope.centerId,after,scope.role,scope.userId,limit + 1]);
      const selected = rows.slice(0,limit);
      return { children:selected.map(row => childView(row,scope)),nextCursor:selected.at(-1)?.child_id ?? null,hasMore:rows.length > limit };
    });
  }
  save(actor,input) {
    keys(input,['conversationId','clientId','expectedRevision','content']);
    const roomId = id(input.conversationId), clientId = client(input.clientId), expected = version(input.expectedRevision), data = childContent(input.content);
    const requestHash = fingerprint({ operation:'child.save',roomId,expected,data });
    return this.inRoom(actor,roomId,async (tx,scope) => {
      if (scope.role !== 'center') fail('FORBIDDEN');
      const prior = await duplicate(tx,scope,clientId,requestHash); if (prior) return prior;
      await checkAgeDate(tx,data);
      const { rows } = await tx.query('SELECT name,age,age_as_of::text AS age_as_of,revision FROM cb_child_profiles WHERE center_id = $1 AND child_id = $2 FOR UPDATE',[scope.centerId,scope.childId]);
      const old = rows[0], current = Number(old?.revision ?? 0); if (current !== expected) fail('PROFILE_CONFLICT');
      const changed = !old || old.name !== data.name || old.age !== data.age || old.age_as_of !== data.ageAsOf, revision = nextVersion(current,changed);
      if (changed) {
        const values = [scope.centerId,scope.childId,data.name,data.age,data.ageAsOf,revision,scope.userId];
        if (!old) await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,values);
        else await tx.query(`UPDATE cb_child_profiles SET name = $3,age = $4,age_as_of = $5,revision = $6,updated_by = $7,updated_at = clock_timestamp()
          WHERE center_id = $1 AND child_id = $2`,values);
        await tx.query('UPDATE cb_conversations SET revision = revision + 1 WHERE center_id = $1 AND id = $2',[scope.centerId,scope.roomId]);
      }
      return remember(tx,scope,clientId,requestHash,'child.save',revision,changed,scope.childId,scope.roomId);
    }).catch(conflict);
  }
  saveFamilyPlan(actor,input) {
    keys(input,['conversationId','clientId','expectedRevision','concern']);
    const roomId = id(input.conversationId), clientId = client(input.clientId), expected = version(input.expectedRevision), concern = text(input.concern,1000);
    const requestHash = fingerprint({ operation:'child.concern',roomId,expected,concern });
    return this.inRoom(actor,roomId,async (tx,scope) => {
      if (scope.role !== 'guardian') fail('FORBIDDEN');
      const prior = await duplicate(tx,scope,clientId,requestHash); if (prior) return prior;
      const { rows } = await tx.query('SELECT concern,revision FROM cb_child_family_plans WHERE center_id = $1 AND child_id = $2 FOR UPDATE',[scope.centerId,scope.childId]);
      const old = rows[0], current = Number(old?.revision ?? 0); if (current !== expected) fail('PROFILE_CONFLICT');
      const changed = (old?.concern ?? '') !== concern, revision = nextVersion(current,changed);
      if (changed) {
        const values = [scope.centerId,scope.childId,concern,revision,scope.userId];
        if (!old) await tx.query(`INSERT INTO cb_child_family_plans(center_id,child_id,concern,revision,updated_by) VALUES ($1,$2,$3,$4,$5)`,values);
        else await tx.query(`UPDATE cb_child_family_plans SET concern = $3,revision = $4,updated_by = $5,updated_at = clock_timestamp()
          WHERE center_id = $1 AND child_id = $2`,values);
        await tx.query('UPDATE cb_conversations SET revision = revision + 1 WHERE center_id = $1 AND id = $2',[scope.centerId,scope.roomId]);
      }
      return remember(tx,scope,clientId,requestHash,'child.concern',revision,changed,scope.childId,scope.roomId);
    }).catch(conflict);
  }
}
