import { attachmentListValid } from "./media-policy.js";

// Additive schema-3 history: legacy rows are revision 1. Only a successful
// command appends the previous value; reads never rewrite old stored content.
export const feedbackVersion = (feedback) => (feedback.history?.length ?? 0) + 1;
export function feedbackSnapshot(feedback) {
  return structuredClone({ date: feedback.date, result: feedback.result,
    reaction: feedback.reaction, difficulty: feedback.difficulty,
    attachments: feedback.attachments ?? [], updatedAt: feedback.updatedAt,
    reviewed: feedback.reviewed, reviewNote: feedback.reviewNote,
    reviewedAt: feedback.reviewedAt ?? null });
}
export function feedbackAt(feedback, version) {
  if (!Number.isSafeInteger(version) || version < 1 || version > feedbackVersion(feedback)) return null;
  return version === feedbackVersion(feedback) ? feedbackSnapshot(feedback) : feedback.history[version - 1];
}
export function feedbackReference(feedback, version = feedbackVersion(feedback)) {
  const value = feedbackAt(feedback, version);
  return value && { id: feedback.id, publicationId: feedback.publicationId, date: value.date,
    result: value.result, reaction: value.reaction, difficulty: value.difficulty };
}
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
export function validFeedbackHistory(feedback) {
  if (feedback.history === undefined) return true;
  if (!Array.isArray(feedback.history) || !feedback.history.length) return false;
  let previous = -Infinity;
  // Legacy read rules, not the stricter new-command normalization: historical
  // text must remain byte-for-byte intact, including whitespace and old limits.
  for (const value of feedback.history) {
    if (!value || Object.keys(value).sort().join() !==
        "attachments,date,difficulty,reaction,result,reviewNote,reviewed,reviewedAt,updatedAt" ||
        !["reaction", "difficulty", "reviewNote"].every((key) => typeof value[key] === "string") ||
        typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
        !Number.isFinite(Date.parse(`${value.date}T12:00:00Z`)) ||
        new Date(`${value.date}T12:00:00Z`).toISOString().slice(0, 10) !== value.date ||
        !["done", "partial", "skipped"].includes(value.result) || typeof value.reviewed !== "boolean" ||
        !attachmentListValid(value.attachments) || !timestamp(value.updatedAt) ||
        Date.parse(value.updatedAt) < previous || (value.reviewedAt !== null && !timestamp(value.reviewedAt))) return false;
    previous = Date.parse(value.updatedAt);
  }
  return timestamp(feedback.updatedAt) && Date.parse(feedback.updatedAt) >= previous;
}
