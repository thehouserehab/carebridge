import { createHash } from 'node:crypto';
import { Relationships } from './relationships.mjs';
import { fail } from './errors.mjs';

const id = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT'); return value; };
const exact = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value,key))) fail('INVALID_INPUT');
};
const receipt = (row,replayed) => ({ conversationId:row.conversation_id,
  appliedVersion:Number(row.applied_version),changed:row.changed,replayed });

// Synthetic/local integration uses the normal manager boundary. No method
// creates an account, changes a center role, transfers identity or grants past
// history. Identity/consent checks for an operating service remain human gates.
export class CareRecipientLinks {
  constructor(database) { this.relationships = new Relationships(database); }
  get(actor,input) {
    exact(input,['conversationId']); id(input.conversationId);
    return this.relationships.inManagedRoom(actor,input.conversationId,async (tx,scope) => {
      const { rows } = await tx.query(`SELECT l.user_id,p.active AND m.active AND u.active AS active
        FROM cb_care_recipient_links l JOIN cb_participants p
          ON (p.center_id,p.conversation_id,p.user_id) = (l.center_id,l.conversation_id,l.user_id)
        JOIN cb_memberships m ON (m.center_id,m.user_id,m.role) = (p.center_id,p.user_id,p.role)
        JOIN cb_users u ON u.id = p.user_id
        WHERE l.center_id = $1 AND l.conversation_id = $2`,[scope.centerId,scope.roomId]);
      return { conversationId:scope.roomId,childId:scope.childId,userId:rows[0]?.user_id ?? null,
        active:rows[0]?.active === true,version:scope.relationshipsVersion };
    });
  }
  connect(actor,input) { return this.#change(actor,input,true); }
  disconnect(actor,input) { return this.#change(actor,input,false); }
  #change(actor,input,active) {
    exact(input,['conversationId','userId','expectedVersion','clientId']);
    const roomId=id(input.conversationId),userId=id(input.userId),expected=input.expectedVersion,clientId=input.clientId;
    if (!Number.isSafeInteger(expected) || expected < 0 || typeof clientId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(clientId)) fail('INVALID_INPUT');
    const requestHash=createHash('sha256').update(JSON.stringify({ operation:active?'recipient.connect':'recipient.disconnect',roomId,userId,expected })).digest('hex');
    return this.relationships.inManagedRoom(actor,roomId,async (tx,scope) => {
      const { rows: requests } = await tx.query(`SELECT conversation_id,request_hash,applied_version,changed
        FROM cb_relationship_requests WHERE center_id=$1 AND actor_id=$2 AND client_id=$3`,[scope.centerId,scope.userId,clientId]);
      if (requests.length) {
        if (requests[0].conversation_id !== roomId || requests[0].request_hash !== requestHash) fail('IDEMPOTENCY_CONFLICT');
        return receipt(requests[0],true);
      }
      if (scope.relationshipsVersion !== expected) fail('RELATIONSHIP_CONFLICT');
      // Membership is not proof of a provisioned independent login account.
      // Lock it even for disconnect, but permit disconnecting a suspended user.
      const { rows: members } = await tx.query(`SELECT m.active AND u.active AS active,a.user_id AS account_id
        FROM cb_memberships m JOIN cb_users u ON u.id=m.user_id
        LEFT JOIN cb_auth_accounts a ON a.user_id=m.user_id
        WHERE m.center_id=$1 AND m.user_id=$2 AND m.role='care_recipient' FOR SHARE OF m,u`,[scope.centerId,userId]);
      if (!members.length || active && (!members[0].active || !members[0].account_id)) fail('PARTICIPANT_UNAVAILABLE');
      const { rows: links } = await tx.query(`SELECT conversation_id,child_id,user_id FROM cb_care_recipient_links
        WHERE center_id=$1 AND (conversation_id=$2 OR user_id=$3)`,[scope.centerId,roomId,userId]);
      if (links.some(link => link.conversation_id !== roomId || link.child_id !== scope.childId || link.user_id !== userId)) fail('PARTICIPANT_UNAVAILABLE');
      if (!active && !links.length) fail('PARTICIPANT_UNAVAILABLE');
      const { rows: participants } = await tx.query(`SELECT user_id,role,active,first_sequence FROM cb_participants
        WHERE center_id=$1 AND conversation_id=$2 AND (role='care_recipient' OR user_id=$3)
        ORDER BY user_id FOR UPDATE`,[scope.centerId,roomId,userId]);
      if (participants.some(row => row.user_id !== userId || row.role !== 'care_recipient') ||
          (participants.length > 0) !== (links.length > 0)) fail('PARTICIPANT_UNAVAILABLE');
      const old=participants[0];
      const changed=!old || old.active !== active;
      const firstSequence=active && !old?.active ? scope.lastSequence+1 : Number(old?.first_sequence);
      if (!Number.isSafeInteger(firstSequence) || firstSequence < 1) fail('SEQUENCE_LIMIT');
      if (changed) {
        if (!old) await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
          VALUES($1,$2,$3,'care_recipient',$4,$5)`,[scope.centerId,roomId,userId,active,firstSequence]);
        else await tx.query(`UPDATE cb_participants SET active=$4,first_sequence=$5
          WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3`,[scope.centerId,roomId,userId,active,firstSequence]);
        if (!old) await tx.query(`INSERT INTO cb_care_recipient_links(center_id,conversation_id,child_id,user_id,linked_by)
          VALUES($1,$2,$3,$4,$5)`,[scope.centerId,roomId,scope.childId,userId,scope.userId]);
        if (active) await tx.query(`DELETE FROM cb_read_states WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3`,[scope.centerId,roomId,userId]);
      }
      const { rows: versions } = await tx.query(`SELECT relationships_version FROM cb_conversations WHERE center_id=$1 AND id=$2`,[scope.centerId,roomId]);
      const appliedVersion=Number(versions[0].relationships_version);
      await tx.query(`INSERT INTO cb_relationship_requests(center_id,conversation_id,actor_id,client_id,request_hash,expected_version,applied_version,changed)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[scope.centerId,roomId,scope.userId,clientId,requestHash,expected,appliedVersion,changed]);
      if (changed) await tx.query(`INSERT INTO cb_relationship_changes
        (center_id,conversation_id,actor_id,client_id,user_id,role,previous_active,previous_first_sequence,next_active,next_first_sequence,history_mode)
        VALUES($1,$2,$3,$4,$5,'care_recipient',$6,$7,$8,$9,$10)`,
      [scope.centerId,roomId,scope.userId,clientId,userId,old?.active ?? null,old ? Number(old.first_sequence):null,active,firstSequence,active?'from_now':'disconnect']);
      return { conversationId:roomId,appliedVersion,changed,replayed:false };
    },{ scheduleWrite:true }).catch(error => {
      if (error.code === '23505' && ['cb_care_recipient_links_pkey','cb_care_recipient_links_center_id_user_id_key',
        'cb_care_recipient_links_center_id_child_id_key','cb_one_care_recipient_per_room','cb_one_care_recipient_record_per_account'].includes(error.constraint)) fail('PARTICIPANT_UNAVAILABLE');
      throw error;
    });
  }
}
