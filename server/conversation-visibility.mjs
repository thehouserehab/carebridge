import { fail } from './errors.mjs';

// Trusted server scope only. The account/room relationship must already have
// been rechecked under the room lock. These helpers never grant participation.
export const isCareRecipient = (scope) => scope.role === 'care_recipient';
export const hasSharedCareAccess = (scope) => ['therapist', 'guardian'].includes(scope.role);
export function requireSharedCareAccess(scope) {
  if (!hasSharedCareAccess(scope)) fail('NOT_FOUND');
}

const alias = (value) => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value)) throw new TypeError('Internal SQL alias required.');
  return value;
};
const expression = (value) => {
  if (typeof value !== 'string' ||
      !/^(?:\$[1-9][0-9]*|[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*|'(?:therapist|guardian|care_recipient)')$/.test(value))
    throw new TypeError('Internal role expression required.');
  return value;
};

// SQL fragments are composed only from validated source-code aliases and
// placeholders, never request values. Mixed messages expose text, not media.
// An attachment-only message does not become visible when later deleted.
export function recipientTextSql(message = 'm', currentText = 'tv') {
  const m = alias(message), t = alias(currentText);
  return `(${m}.kind = 'text' AND (length(btrim(COALESCE(${t}.body,''))) > 0 OR
    (${t}.operation = 'all' AND EXISTS (SELECT 1 FROM cb_message_text_revisions text_history
      WHERE (text_history.center_id,text_history.conversation_id,text_history.message_id) =
        (${m}.center_id,${m}.conversation_id,${m}.id) AND length(btrim(COALESCE(text_history.body,''))) > 0))))`;
}

export function messageVisibleSql(role, message = 'm', currentText = 'tv') {
  const roleExpression = expression(role);
  return `(${roleExpression} IN ('therapist','guardian') OR
    (${roleExpression} = 'care_recipient' AND ${recipientTextSql(message,currentText)}))`;
}

// A role label alone never makes someone the subject of a rehabilitation
// record. Preserve the dedicated stable binding even on direct read paths.
export function participantVisibleSql(participant = 'p') {
  const p = alias(participant);
  return `(${p}.role IN ('therapist','guardian') OR (${p}.role = 'care_recipient' AND EXISTS (
    SELECT 1 FROM cb_care_recipient_links subject_link JOIN cb_auth_accounts subject_account
      ON subject_account.user_id = subject_link.user_id
    WHERE (subject_link.center_id,subject_link.conversation_id,subject_link.user_id) =
      (${p}.center_id,${p}.conversation_id,${p}.user_id))))`;
}

export const previewAttachments = (scope, attachments) => hasSharedCareAccess(scope) ? attachments : [];
