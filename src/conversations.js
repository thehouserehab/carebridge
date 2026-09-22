import { normalizeAttachments, attachmentListValid } from "./media-policy.js";
import { accessibleChildren } from "./access.js";

export function participants(db, childId) {
  const child = db.children.find((c) => c.id === childId);
  return child ? [child.therapistId, ...child.guardianIds] : [];
}
export function canConverse(db, actor, childId) {
  return (
    actor.role !== "center" &&
    accessibleChildren(db, actor).some((c) => c.id === childId)
  );
}
export function synchronizeEvents(db) {
  for (const child of db.children) {
    if (!db.conversations.some((c) => c.childId === child.id))
      db.conversations.push({ id: `room-${child.id}`, childId: child.id });
  }
  const events = [
    ...db.publications.map((p) => ({
      id: `publication-${p.id}`,
      childId: p.childId,
      type: "publication",
      sourceId: p.id,
      authorId: db.children.find((c) => c.id === p.childId).therapistId,
      createdAt: p.sharedAt,
    })),
    ...db.feedback.map((f) => ({
      id: `feedback-${f.id}`,
      childId: f.childId,
      type: "feedback",
      sourceId: f.id,
      authorId: f.authorId,
      createdAt: f.updatedAt,
    })),
  ].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  for (const event of events) {
    if (db.messages.some((m) => m.id === event.id)) continue;
    db.messages.push({
      ...event,
      conversationId: db.conversations.find((c) => c.childId === event.childId)
        .id,
      sequence: (db.messages.at(-1)?.sequence || 0) + 1,
    });
  }
}
export function upgradeState(source) {
  if (source.schema === 3) return source;
  const db = structuredClone(source);
  db.schema = 3;
  db.conversations = [];
  db.messages = [];
  db.readStates = [];
  for (const r of db.records) {
    r.format = "legacy";
    r.status = "saved";
    r.assessments = r.assessment ? [structuredClone(r.assessment)] : [];
    r.observation = null;
    r.performed = "";
    r.response = "";
    r.referenceMessageIds = [];
  }
  synchronizeEvents(db);
  return db;
}
const current = (db, pubId) =>
  db.records.some((r) => r.publicationId === pubId);
function publicationId(db, message) {
  if (message.type === "publication") return message.sourceId;
  if (message.type === "feedback")
    return db.feedback.find((f) => f.id === message.sourceId)?.publicationId;
  return null;
}
export function messageProjection(db, actor, message) {
  if (!canConverse(db, actor, message.childId))
    throw new Error("접근할 수 없는 대화입니다.");
  const pubId = publicationId(db, message);
  const archived = !!pubId && !current(db, pubId);
  const base = {
    id: message.id,
    childId: message.childId,
    conversationId: message.conversationId,
    sequence: message.sequence,
    authorId: message.authorId,
    createdAt: message.createdAt,
    type: message.type,
    archived,
    canReply: !archived,
    attachments: [],
  };
  if (archived && actor.role === "guardian")
    return { ...base, hidden: true, body: "공유가 종료된 기록입니다." };
  if (message.type === "publication") {
    const pub = db.publications.find((p) => p.id === message.sourceId);
    return {
      ...base,
      publication: structuredClone(pub),
      body: pub.title,
      attachments: pub.attachments || [],
    };
  }
  if (message.type === "feedback") {
    const f = db.feedback.find((f) => f.id === message.sourceId);
    const feedback = {
      id: f.id,
      publicationId: f.publicationId,
      result: f.result,
      reaction: f.reaction,
      difficulty: f.difficulty,
      reviewed: f.reviewed,
      date: f.date,
    };
    if (actor.role === "therapist") feedback.reviewNote = f.reviewNote;
    return {
      ...base,
      feedback,
      body: f.reaction,
      attachments: f.attachments || [],
    };
  }
  let quote = null;
  if (message.replyTo) {
    const original = db.messages.find((m) => m.id === message.replyTo);
    // Only project the direct source; no recursively copied quotations.
    const p = messageProjection(db, actor, { ...original, replyTo: null });
    quote = {
      id: p.id,
      body: p.body,
      hidden: !!p.hidden,
      authorId: p.authorId,
    };
  }
  return {
    ...base,
    body: message.body,
    attachments: structuredClone(message.attachments),
    quote,
    reviewed: !!message.reviewed,
    reviewNote: actor.role === "therapist" ? message.reviewNote : undefined,
  };
}
export function conversationView(db, actor, childId) {
  if (!canConverse(db, actor, childId))
    throw new Error("접근할 수 없는 대화입니다.");
  const room = db.conversations.find((c) => c.childId === childId);
  const lastRead =
    db.readStates.find(
      (r) => r.conversationId === room.id && r.userId === actor.id,
    )?.sequence || 0;
  const rows = db.messages.filter((m) => m.conversationId === room.id);
  const unread = rows.filter(
    (m) => m.sequence > lastRead && m.authorId !== actor.id,
  );
  const others = participants(db, childId).filter((id) => id !== actor.id);
  const messages = rows.map((m) => ({
    ...messageProjection(db, actor, m),
    read:
      others.length > 0 &&
      others.every(
        (id) =>
          (db.readStates.find(
            (r) => r.conversationId === room.id && r.userId === id,
          )?.sequence || 0) >= m.sequence,
      ),
  }));
  return {
    ...room,
    messages,
    unread: unread.length,
    targetId: unread[0]?.id || rows.at(-1)?.id || "",
    lastRead,
  };
}
export function conversationList(db, actor) {
  return db.children
    .filter((c) => canConverse(db, actor, c.id))
    .map((child) => {
      const room = conversationView(db, actor, child.id);
      return { ...room, child, latest: room.messages.at(-1) };
    })
    .sort(
      (a, b) =>
        Number(b.unread > 0) - Number(a.unread > 0) ||
        (b.latest?.sequence || 0) - (a.latest?.sequence || 0),
    );
}
export function changeConversation(db, actor, action, input, now) {
  if (!canConverse(db, actor, input.childId))
    throw new Error("접근할 수 없는 대화입니다.");
  const room = db.conversations.find((c) => c.childId === input.childId);
  const find = (id) => {
    const row = db.messages.find(
      (m) => m.id === id && m.conversationId === room.id,
    );
    if (!row) throw new Error("연결할 메시지를 확인해 주세요.");
    return row;
  };
  if (action === "read") {
    const sequence = input.id ? find(input.id).sequence : 0;
    const old = db.readStates.find(
      (r) => r.conversationId === room.id && r.userId === actor.id,
    );
    if (old) old.sequence = Math.max(old.sequence, sequence);
    else
      db.readStates.push({
        conversationId: room.id,
        userId: actor.id,
        sequence,
      });
    return;
  }
  if (action === "message-review") {
    if (actor.role !== "therapist")
      throw new Error("치료사만 반영 메모를 작성할 수 있어요.");
    const m = find(input.id);
    if (m.type !== "text") throw new Error("일반 메시지에만 사용할 수 있어요.");
    const note = String(input.reviewNote || "").trim();
    if (!note || note.length > 2000)
      throw new Error("반영 메모를 2,000자 이내로 작성해 주세요.");
    Object.assign(m, { reviewed: true, reviewNote: note, reviewedAt: now });
    return;
  }
  const id = String(input.clientId || "");
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(id))
    throw new Error("발신 식별자를 확인해 주세요.");
  const old = db.messages.find((m) => m.id === id);
  const body = String(input.body || "").trim();
  const attachments = normalizeAttachments(input.attachments || []).map(
    (m) => ({ ...m, share: true }),
  );
  if (old) {
    if (
      old.authorId !== actor.id ||
      old.conversationId !== room.id ||
      old.body !== body ||
      old.replyTo !== (input.replyTo || null) ||
      JSON.stringify(old.attachments) !== JSON.stringify(attachments)
    )
      throw new Error("이미 사용한 발신 ID입니다. 새 메시지로 작성해 주세요.");
    return; // Idempotent retry, even after its referenced publication was withdrawn.
  }
  if ((!body && !attachments.length) || body.length > 2000)
    throw new Error(
      "소식이나 첨부를 넣어 주세요. 글은 2,000자까지 보낼 수 있어요.",
    );
  if (
    input.replyTo &&
    !messageProjection(db, actor, find(input.replyTo)).canReply
  )
    throw new Error(
      "공유가 종료된 기록에는 새 답변을 보낼 수 없어요. 답변 연결을 해제해 주세요.",
    );
  db.messages.push({
    id,
    conversationId: room.id,
    childId: input.childId,
    type: "text",
    authorId: actor.id,
    body,
    attachments,
    replyTo: input.replyTo || null,
    createdAt: now,
    sequence: (db.messages.at(-1)?.sequence || 0) + 1,
  });
}
export function validConversations(db) {
  if (
    !["conversations", "messages", "readStates"].every((k) =>
      Array.isArray(db[k]),
    )
  )
    return false;
  if (
    new Set(db.conversations.map((r) => r.id)).size !==
      db.conversations.length ||
    new Set(db.conversations.map((r) => r.childId)).size !==
      db.children.length ||
    db.conversations.length !== db.children.length ||
    !db.conversations.every(
      (r) =>
        typeof r.id === "string" && db.children.some((c) => c.id === r.childId),
    )
  )
    return false;
  const ids = new Set();
  let sequence = 0;
  for (const m of db.messages) {
    if (
      !m ||
      typeof m.id !== "string" ||
      ids.has(m.id) ||
      !Number.isInteger(m.sequence) ||
      m.sequence <= sequence ||
      !participants(db, m.childId).includes(m.authorId) ||
      typeof m.createdAt !== "string" ||
      Number.isNaN(Date.parse(m.createdAt)) ||
      !db.conversations.some(
        (r) => r.id === m.conversationId && r.childId === m.childId,
      )
    )
      return false;
    if (m.type === "text") {
      if (
        typeof m.body !== "string" ||
        m.body.length > 2000 ||
        !attachmentListValid(m.attachments) ||
        (!m.body.trim() && !m.attachments.length) ||
        (m.replyTo &&
          !db.messages.some(
            (r) =>
              ids.has(r.id) &&
              r.id === m.replyTo &&
              r.conversationId === m.conversationId,
          ))
      )
        return false;
    } else if (["publication", "feedback"].includes(m.type)) {
      if (
        !db[m.type === "publication" ? "publications" : "feedback"].some(
          (r) => r.id === m.sourceId && r.childId === m.childId,
        )
      )
        return false;
      if (
        db.messages.some(
          (r) => r !== m && r.type === m.type && r.sourceId === m.sourceId,
        )
      )
        return false;
    } else return false;
    ids.add(m.id);
    sequence = m.sequence;
  }
  const readKeys = new Set();
  return db.readStates.every((r) => {
    const room = db.conversations.find((c) => c.id === r.conversationId);
    const key = `${r.conversationId}/${r.userId}`;
    if (
      !room ||
      !participants(db, room.childId).includes(r.userId) ||
      readKeys.has(key) ||
      !Number.isInteger(r.sequence) ||
      r.sequence < 0 ||
      (r.sequence !== 0 &&
        !db.messages.some(
          (m) => m.conversationId === room.id && m.sequence === r.sequence,
        ))
    )
      return false;
    readKeys.add(key);
    return true;
  });
}
