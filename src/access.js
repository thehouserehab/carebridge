// Shared relationship policy for records, home aggregation and conversations.
// Demo roles are not authentication; server enforcement is a separate P1 gate.
export function accessibleChildren(db, actor) {
  return db.children.filter(
    (c) =>
      actor.role === "center" ||
      (actor.role === "therapist" && c.therapistId === actor.id) ||
      (actor.role === "guardian" && c.guardianIds.includes(actor.id)),
  );
}

// Additive local rehearsal policy. Legacy workspaces retain their current
// access. This is not server authentication or a production identity map.
export function historyBoundary(db, actor, childId) {
  return db.children.find((c) => c.id === childId)?.historyAccess
    ?.find((entry) => entry.userId === actor.id) ?? { firstSequence: 1, firstRecordRevision: 0 };
}
export function canReadPublication(db, actor, publication) {
  if (!publication || actor.role === "center" || !accessibleChildren(db, actor).some((c) => c.id === publication.childId)) return false;
  const event = db.messages?.find((m) => m.type === "publication" && m.sourceId === publication.id);
  return !event ? historyBoundary(db, actor, publication.childId).firstSequence === 1
    : canReadMessage(db, actor, event);
}
export function canReadMessage(db, actor, message) {
  if (!message || actor.role === "center" ||
      !accessibleChildren(db, actor).some((c) => c.id === message.childId) ||
      message.sequence < historyBoundary(db, actor, message.childId).firstSequence) return false;
  if (message.type === "feedback") {
    const feedback = db.feedback.find((f) => f.id === message.sourceId);
    const publication = db.publications.find((p) => p.id === feedback?.publicationId);
    return !!publication && canReadPublication(db, actor, publication);
  }
  return true;
}
export function canReadRecord(db, actor, record) {
  return actor.role === "therapist" &&
    accessibleChildren(db, actor).some((c) => c.id === record.childId) &&
    (record.createdRevision ?? 0) >= historyBoundary(db, actor, record.childId).firstRecordRevision;
}
export function validHistoryAccess(db) {
  return db.children.every((child) => {
    if (child.historyAccess === undefined) return true;
    if (!Array.isArray(child.historyAccess)) return false;
    const known = [child.therapistId, ...child.guardianIds,
      ...(child.formerTherapistIds ?? []), ...(child.formerGuardianIds ?? [])];
    const ids = new Set();
    return child.historyAccess.every((entry) => {
      if (!entry || Object.keys(entry).sort().join() !== "firstRecordRevision,firstSequence,userId" ||
          !known.includes(entry.userId) || ids.has(entry.userId) ||
          !Number.isSafeInteger(entry.firstSequence) || entry.firstSequence < 1 ||
          entry.firstSequence > (db.messages?.at(-1)?.sequence ?? 0) + 1 ||
          !Number.isSafeInteger(entry.firstRecordRevision) || entry.firstRecordRevision < 0 ||
          entry.firstRecordRevision > db.revision) return false;
      ids.add(entry.userId);
      return true;
    });
  });
}
