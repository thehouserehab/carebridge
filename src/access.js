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
