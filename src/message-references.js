import { messageVersion, messageBodyAt, messageHiddenFor } from "./message-lifecycle.js";
import { canReadMessage, canReadRecord } from "./access.js";
import { feedbackVersion, feedbackAt, feedbackReference } from "./feedback-history.js";

export function sourceMessageVersion(db, message) {
  return message.type === "feedback"
    ? feedbackVersion(db.feedback.find((row) => row.id === message.sourceId)) : messageVersion(message);
}
// A saved clinical reference has its own access boundary. Source-message
// hiding, deletion or feedback edits must not substitute the current files.
// Resolve IDs against the current workspace, never trust a caller's snapshot.
export function recordReferenceMedia(db, actor, recordId, messageId) {
  const record = db.records.find((row) => row.id === recordId);
  if (!record || !canReadRecord(db, actor, record) ||
      !record.referenceMessageIds?.includes(messageId)) return null;
  const source = record.referenceSources?.find((row) => row.messageId === messageId);
  return source ? structuredClone(source.attachments) : null;
}
function snapshot(db, message, at) {
  if (message.type === "feedback") {
    const feedback = db.feedback.find((row) => row.id === message.sourceId);
    return { messageId: message.id, version: feedbackVersion(feedback), body: feedback.reaction,
      attachments: structuredClone(feedback.attachments ?? []), capturedAt: at,
      feedback: feedbackReference(feedback) };
  }
  return { messageId: message.id, version: messageVersion(message), body: message.body,
    attachments: structuredClone(message.attachments), capturedAt: at };
}
// Freeze old ID-only clinical references before the source changes. Never
// rewrite the authored clinical content, publication or immutable file blobs.
export function freezeMessageReferences(db, message, at) {
  for (const reply of db.messages) {
    if (reply.type === "text" && reply.replyTo === message.id && reply.replyVersion === undefined)
      reply.replyVersion = sourceMessageVersion(db, message);
  }
  for (const record of db.records) {
    if (!record.referenceMessageIds?.includes(message.id) || record.referenceSources?.some((s) => s.messageId === message.id)) continue;
    record.referenceSources ??= [];
    record.referenceSources.push(snapshot(db, message, at));
  }
}
export function recordReferenceSources(db, actor, ids, old, expected = [], at) {
  if (!Array.isArray(expected) || expected.some((entry) => !entry ||
      Object.keys(entry).sort().join() !== "messageId,version" || !ids.includes(entry.messageId) ||
      !Number.isSafeInteger(entry.version) || entry.version < 1) ||
      new Set(expected.map((entry) => entry.messageId)).size !== expected.length)
    throw new Error("참고할 소식 버전을 확인해 주세요.");
  return ids.flatMap((id) => {
    const message = db.messages.find((m) => m.id === id);
    const saved = old?.referenceSources?.find((source) => source.messageId === id);
    const version = expected.find((entry) => entry.messageId === id)?.version;
    if (saved) {
      if (version !== undefined && version !== saved.version)
        throw new Error("기록에 참고한 당시 버전과 달라요. 참고 내용을 확인해 주세요.");
      return [structuredClone(saved)];
    }
    if (!["text", "feedback"].includes(message.type)) return [];
    if (!canReadMessage(db, actor, message) || messageHiddenFor(message, actor) || message.deletedAt)
      throw new Error("삭제되었거나 열람할 수 없는 소식은 새로 참고할 수 없어요.");
    if (version !== undefined && version !== sourceMessageVersion(db, message))
      throw new Error("참고한 소식이 수정됐어요. 최신 내용을 확인한 뒤 기록해 주세요.");
    return [snapshot(db, message, at)];
  });
}
export function validRecordReferenceSources(record, db) {
  if (record.referenceSources === undefined) return true; // legacy, frozen on first source change
  if (!Array.isArray(record.referenceSources)) return false;
  const ids = new Set();
  return record.referenceSources.every((source) => {
    const message = db.messages.find((m) => m.id === source?.messageId && m.childId === record.childId && ["text", "feedback"].includes(m.type));
    const feedback = message?.type === "feedback" && db.feedback.find((row) => row.id === message.sourceId);
    const historical = feedback && feedbackAt(feedback, source.version);
    const fields = feedback ? "attachments,body,capturedAt,feedback,messageId,version" : "attachments,body,capturedAt,messageId,version";
    if (!message || Object.keys(source).sort().join() !== fields ||
        !record.referenceMessageIds.includes(source.messageId) || ids.has(source.messageId) ||
        !Number.isSafeInteger(source.version) || source.version < 1 || source.version > sourceMessageVersion(db, message) ||
        (feedback ? !historical || source.body !== historical.reaction ||
          JSON.stringify(source.feedback) !== JSON.stringify(feedbackReference(feedback, source.version)) :
          messageBodyAt(message, source.version) === null || source.body !== messageBodyAt(message, source.version)) ||
        JSON.stringify(source.attachments) !== JSON.stringify(feedback ? historical.attachments : message.attachments) ||
        typeof source.capturedAt !== "string" || !Number.isFinite(Date.parse(source.capturedAt))) return false;
    ids.add(source.messageId); return true;
  });
}
