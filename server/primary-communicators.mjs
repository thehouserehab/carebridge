import { createHash } from 'node:crypto';
import { Relationships } from './relationships.mjs';
import { fail } from './errors.mjs';

const id = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT'); return value; };
const exact = (value,allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value,key))) fail('INVALID_INPUT');
};
const recipientIdentity = (alias) => `(${alias}.role <> 'care_recipient' OR EXISTS (
  SELECT 1 FROM cb_care_recipient_links l WHERE (l.center_id,l.conversation_id,l.user_id) =
    (${alias}.center_id,${alias}.conversation_id,${alias}.user_id)))`;
async function currentSelection(tx,scope,userId) {
  if (userId === null) return null;
  const { rows } = await tx.query(`SELECT p.user_id,u.communication_generation AS user_generation,
      m.communication_generation AS membership_generation,p.communication_generation AS participant_generation FROM cb_participants p
    JOIN cb_memberships m ON (m.center_id,m.user_id,m.role) = (p.center_id,p.user_id,p.role)
    JOIN cb_users u ON u.id=p.user_id
    WHERE p.center_id=$1 AND p.conversation_id=$2 AND p.user_id=$3
      AND p.role IN ('guardian','care_recipient') AND p.active AND m.active AND u.active
      AND ${recipientIdentity('p')} FOR SHARE OF p,m,u`,[scope.centerId,scope.roomId,userId]);
  return rows[0] ?? null;
}
const sameQualification = (a,b) => a?.user_id === b?.user_id &&
  ['user_generation','membership_generation','participant_generation'].every(key => String(a?.[key] ?? '') === String(b?.[key] ?? ''));

// Contact metadata only. Changing this preference cannot transfer an account,
// consent, record access, conversation history or any management capability.
export class PrimaryCommunicators {
  constructor(database) {
    this.relationships=new Relationships(database); this.database=database;
  }
  get(actor,input) {
    exact(input,['conversationId']); const roomId=id(input.conversationId),centerId=id(actor?.centerId),userId=id(actor?.userId);
    return this.database.transaction(async tx => {
      // Match the shared room-first lock order. Center managers see metadata,
      // never clinical content; everyone else must currently be linked here.
      const { rows: rooms } = await tx.query(`SELECT c.id FROM cb_conversations c
        WHERE c.center_id=$1 AND c.id=$2 AND EXISTS (
          SELECT 1 FROM cb_memberships m JOIN cb_users u ON u.id=m.user_id
          WHERE m.center_id=c.center_id AND m.user_id=$3 AND m.active AND u.active AND
            (m.role='center' OR EXISTS (SELECT 1 FROM cb_participants p
              WHERE (p.center_id,p.conversation_id,p.user_id,p.role)=(c.center_id,c.id,m.user_id,m.role)
                AND p.role IN ('therapist','guardian','care_recipient') AND p.active AND ${recipientIdentity('p')})))
        FOR SHARE OF c`,[centerId,roomId,userId]);
      if (!rooms.length) fail('NOT_FOUND');
      const { rows: memberships } = await tx.query(`SELECT m.role FROM cb_memberships m JOIN cb_users u ON u.id=m.user_id
        WHERE m.center_id=$1 AND m.user_id=$2 AND m.active AND u.active FOR SHARE OF m,u`,[centerId,userId]);
      const role=memberships[0]?.role;
      if (!role) fail('NOT_FOUND');
      if (role !== 'center') {
        const { rows } = await tx.query(`SELECT p.user_id FROM cb_participants p
          WHERE p.center_id=$1 AND p.conversation_id=$2 AND p.user_id=$3 AND p.role=$4
            AND p.role IN ('therapist','guardian','care_recipient') AND p.active AND ${recipientIdentity('p')}
          FOR SHARE OF p`,[centerId,roomId,userId,role]);
        if (!rows.length) fail('NOT_FOUND');
      }
      const { rows } = await tx.query(`SELECT user_id,user_generation,membership_generation,participant_generation,revision
        FROM cb_primary_communicators WHERE center_id=$1 AND conversation_id=$2`,[centerId,roomId]);
      // Never expose the stored identity after its current qualification ends.
      // A restored active flag is a new generation, not renewed designation.
      const current=await currentSelection(tx,{ centerId,roomId },rows[0]?.user_id ?? null);
      return { conversationId:roomId,userId:current && sameQualification(rows[0],current) ? current.user_id:null,revision:Number(rows[0]?.revision ?? 0) };
    });
  }
  save(actor,input) {
    exact(input,['conversationId','userId','expectedRevision','clientId']);
    const roomId=id(input.conversationId),userId=input.userId === null ? null:id(input.userId),expected=input.expectedRevision,clientId=input.clientId;
    if (!Number.isSafeInteger(expected) || expected < 0 || typeof clientId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(clientId)) fail('INVALID_INPUT');
    const requestHash=createHash('sha256').update(JSON.stringify({ roomId,userId,expected })).digest('hex');
    return this.relationships.inManagedRoom(actor,roomId,async (tx,scope) => {
      const { rows: requests } = await tx.query(`SELECT conversation_id,request_hash,applied_revision,changed
        FROM cb_primary_communicator_requests WHERE center_id=$1 AND actor_id=$2 AND client_id=$3`,[scope.centerId,scope.userId,clientId]);
      if (requests.length) {
        const prior=requests[0];
        if (prior.conversation_id !== roomId || prior.request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
        return { conversationId:roomId,appliedRevision:Number(prior.applied_revision),changed:prior.changed,replayed:true };
      }
      const { rows } = await tx.query(`SELECT user_id,user_generation,membership_generation,participant_generation,revision
        FROM cb_primary_communicators WHERE center_id=$1 AND conversation_id=$2 FOR UPDATE`,[scope.centerId,roomId]);
      const old=rows[0],revision=Number(old?.revision ?? 0);
      if (revision !== expected) fail('PRIMARY_COMMUNICATOR_CONFLICT');
      const selection=await currentSelection(tx,scope,userId);
      if (userId !== null && !selection) fail('PARTICIPANT_UNAVAILABLE');
      const changed=(old?.user_id ?? null) !== userId || userId !== null && !sameQualification(old,selection);
      if (changed && revision === Number.MAX_SAFE_INTEGER) fail('REVISION_LIMIT');
      const appliedRevision=revision+Number(changed);
      if (changed) {
        const values=[scope.centerId,roomId,userId,appliedRevision,scope.userId,
          selection?.user_generation ?? null,selection?.membership_generation ?? null,selection?.participant_generation ?? null];
        if (!old) await tx.query(`INSERT INTO cb_primary_communicators
          (center_id,conversation_id,user_id,revision,updated_by,user_generation,membership_generation,participant_generation)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,values);
        else await tx.query(`UPDATE cb_primary_communicators SET user_id=$3,revision=$4,updated_by=$5,updated_at=clock_timestamp(),
          user_generation=$6,membership_generation=$7,participant_generation=$8
          WHERE center_id=$1 AND conversation_id=$2`,values);
        // Existing room pollers invalidate only their display projection. The
        // relationship version and all permission-bearing rows stay unchanged.
        await tx.query(`UPDATE cb_conversations SET revision=revision+1 WHERE center_id=$1 AND id=$2`,[scope.centerId,roomId]);
      }
      await tx.query(`INSERT INTO cb_primary_communicator_requests
        (center_id,conversation_id,actor_id,client_id,request_hash,expected_revision,applied_revision,changed)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[scope.centerId,roomId,scope.userId,clientId,requestHash,expected,appliedRevision,changed]);
      return { conversationId:roomId,appliedRevision,changed,replayed:false };
    }).catch(error => {
      if (error.code === '23505' && error.constraint === 'cb_primary_communicator_requests_pkey') fail('IDEMPOTENCY_CONFLICT');
      throw error;
    });
  }
}
