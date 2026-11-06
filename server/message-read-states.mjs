import { messageVisibleSql, participantVisibleSql } from './conversation-visibility.mjs';

// Internal projection helper: the caller must hold the conversation lock and
// authorize the viewer first. Never accept scope or database rows from HTTP.
// A recipient hiding a message is not acknowledgement and does not exclude
// that recipient. Only explicit read cursors count as an acknowledgement.
export async function messageReadStates(tx, scope, rows) {
  if (!Array.isArray(rows) || rows.length > 100 || rows.some(row =>
    !row || typeof row.id !== 'string' || !row.id))
    throw new TypeError('A bounded authorized message batch is required.');
  const result = new Map(rows.map(row => [row.id, false]));
  if (!result.size) return result;
  const { rows: states } = await tx.query(`WITH selected AS MATERIALIZED (
      SELECT * FROM cb_messages WHERE center_id=$1 AND conversation_id=$2 AND id=ANY($3::text[])
    ), visible_messages AS MATERIALIZED (
    SELECT m.center_id,m.conversation_id,m.id,m.sequence,m.kind,tv.body,tv.operation,source.sequence AS source_sequence
    FROM selected m
    LEFT JOIN cb_message_text_heads th ON (th.center_id,th.conversation_id,th.message_id) =
      (m.center_id,m.conversation_id,m.id)
    LEFT JOIN cb_message_text_revisions tv ON (tv.center_id,tv.conversation_id,tv.message_id,tv.revision) =
      (th.center_id,th.conversation_id,th.message_id,th.current_revision)
    LEFT JOIN cb_activity_feedback f ON (f.center_id,f.conversation_id,f.id) =
      (m.center_id,m.conversation_id,m.feedback_id)
    LEFT JOIN cb_messages source ON (source.center_id,source.conversation_id,source.publication_id) =
      (f.center_id,f.conversation_id,f.publication_id)
    WHERE m.sequence >= $5 AND (m.kind <> 'feedback' OR source.sequence >= $5) AND ${messageVisibleSql('$6')}
    ), eligible_participants AS MATERIALIZED (
    SELECT p.user_id,p.role,p.first_sequence,COALESCE(r.sequence,0) AS last_read
    FROM cb_participants p
    JOIN cb_memberships cm ON (cm.center_id,cm.user_id,cm.role)=(p.center_id,p.user_id,p.role) AND cm.active
    JOIN cb_users u ON u.id=p.user_id AND u.active
    LEFT JOIN cb_read_states r ON (r.center_id,r.conversation_id,r.user_id) =
      (p.center_id,p.conversation_id,p.user_id)
    WHERE p.center_id=$1 AND p.conversation_id=$2 AND p.active AND p.user_id<>$4 AND ${participantVisibleSql('p')}
    ) SELECT m.id AS message_id,
      COUNT(p.user_id)>0 AND COALESCE(bool_and(p.last_read>=m.sequence),false) AS read
    FROM visible_messages m LEFT JOIN eligible_participants p
      ON p.first_sequence<=m.sequence AND (m.kind<>'feedback' OR m.source_sequence>=p.first_sequence)
        AND ${messageVisibleSql('p.role', 'm', 'm')}
    GROUP BY m.id,m.sequence`, [scope.centerId,scope.roomId,[...result.keys()],scope.userId,scope.firstSequence,scope.role]);
  for (const state of states) if (result.has(state.message_id)) result.set(state.message_id,state.read === true);
  return result;
}
