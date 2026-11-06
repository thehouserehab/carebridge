// Internal eligibility hint only, NOT an access grant. The caller takes the
// room lock first and reuses Conversations.inRoomTransaction's current checks.
export async function nextMediaWork(tx) {
  const { rows } = await tx.query(`SELECT q.center_id,q.conversation_id,q.upload_id,u.owner_id,u.version
    FROM cb_media_work_queue q JOIN cb_media_uploads u ON
      (u.center_id,u.conversation_id,u.id) = (q.center_id,q.conversation_id,q.upload_id)
    JOIN cb_conversations c ON (c.center_id,c.id) = (q.center_id,q.conversation_id)
    JOIN cb_participants p ON (p.center_id,p.conversation_id,p.user_id) = (q.center_id,q.conversation_id,u.owner_id)
    JOIN cb_memberships cm ON (cm.center_id,cm.user_id,cm.role) = (p.center_id,p.user_id,p.role)
    JOIN cb_users owner ON owner.id = p.user_id
    JOIN cb_media_resource_limits limits ON limits.center_id = q.center_id AND limits.revision > 0
    CROSS JOIN LATERAL cb_media_resource_usage(q.center_id) capacity
    WHERE q.state IN ('queued','retry') AND q.attempts < 5 + q.approved_retries AND q.available_at <= clock_timestamp()
      AND u.state = 'quarantined' AND u.expires_at > clock_timestamp()
      AND p.active AND cm.active AND owner.active AND p.role IN ('therapist','guardian')
      AND u.created_sequence >= p.first_sequence
      AND capacity.reserved_bytes + CASE WHEN
        (SELECT count(*) FROM cb_media_objects WHERE (center_id,conversation_id,upload_id) = (u.center_id,u.conversation_id,u.id) AND state <> 'deleted') >= 2
        THEN CASE WHEN u.type LIKE 'image/%' THEN 10485760::bigint ELSE 52428800::bigint END ELSE 0 END <= limits.storage_bytes
    ORDER BY q.available_at,q.created_at,q.upload_id LIMIT 1 FOR UPDATE OF c SKIP LOCKED`);
  return rows[0] ?? null;
}
