// Carebridge rehearsal policy, not a promise of identical KakaoTalk behavior.
// Production commands must use an authoritative server clock and identity.
export const MESSAGE_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const messageVersion = (message) => (message.changes?.length ?? 0) + 1;
export const messageHiddenFor = (message, actor) =>
  !!message?.hiddenFor?.some((entry) => entry.userId === actor.id);
export function messageCapabilities(message, actor, now = new Date().toISOString()) {
  const elapsed = Date.parse(now) - Date.parse(message.createdAt);
  const available = message.type === "text" && !message.deletedAt && !messageHiddenFor(message, actor);
  const ownRecent = available && message.authorId === actor.id &&
    Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= MESSAGE_CHANGE_WINDOW_MS;
  return { canEdit: ownRecent, canDeleteAll: ownRecent, canHide: available || !!message.deletedAt };
}
export function messageBodyAt(message, version) {
  if (version === 1) return message.sentBody ?? message.body;
  const change = message.changes?.[version - 2];
  return change?.action === "edit" ? change.body : null;
}
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const commandId = (value) => typeof value === "string" && /^[a-zA-Z0-9-]{8,100}$/.test(value);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();

export function changeTextMessage(db, actor, message, action, input, now) {
  if (message.type !== "text") throw new Error("일반 소식에만 사용할 수 있어요.");
  if (!commandId(input.clientId) || !timestamp(now)) throw new Error("변경 식별자와 시각을 확인해 주세요.");
  const kind = action === "message-edit" ? "edit" : input.scope;
  if (!["edit", "self", "all"].includes(kind)) throw new Error("삭제 범위를 확인해 주세요.");
  if (kind !== "edit" && input.confirmed !== true) throw new Error("삭제 범위를 확인하고 동의해 주세요.");
  const body = input.body;
  if (kind === "edit" && (typeof body !== "string" || body.length > 2000 || (!body.trim() && !message.attachments.length)))
    throw new Error("소식이나 첨부가 필요해요. 글은 2,000자까지 수정할 수 있어요.");
  const normalizedBody = kind === "edit" ? body.trim() : undefined;
  if (db.messages.some((row) => row.id === input.clientId)) throw new Error("발신 ID와 변경 ID는 달라야 해요.");
  // Replays still require current room/history access, enforced by the caller.
  // A command ID cannot be used on another message, by another actor, or with
  // different content. Receipts are internal, never included in projections.
  for (const row of db.messages) {
    const receipt = row.changes?.find((entry) => entry.clientId === input.clientId);
    const hidden = row.hiddenFor?.find((entry) => entry.clientId === input.clientId);
    if (!receipt && !hidden) continue;
    const same = row.id === message.id && (hidden ? kind === "self" && hidden.userId === actor.id :
      message.authorId === actor.id && receipt.action === (kind === "all" ? "delete" : kind) &&
      receipt.expectedVersion === input.expectedVersion && receipt.body === normalizedBody);
    if (!same) throw new Error("이미 사용한 변경 ID입니다. 내용을 다시 확인해 주세요.");
    return;
  }
  if (kind === "self") {
    if (messageHiddenFor(message, actor)) return;
    if (Date.parse(now) < Date.parse(message.createdAt)) throw new Error("변경 시각을 확인해 주세요.");
    message.hiddenFor ??= [];
    message.hiddenFor.push({ userId: actor.id, clientId: input.clientId, at: now });
    return;
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion !== messageVersion(message))
    throw new Error("소식이 변경됐어요. 최신 내용을 확인한 뒤 다시 시도해 주세요.");
  const capabilities = messageCapabilities(message, actor, now);
  if (!(kind === "edit" ? capabilities.canEdit : capabilities.canDeleteAll))
    throw new Error("본인이 보낸 소식만 24시간 안에 수정하거나 모두에게서 삭제할 수 있어요.");
  if (Date.parse(now) < Date.parse(message.changes?.at(-1)?.at ?? message.createdAt))
    throw new Error("변경 시각을 확인해 주세요.");
  if (kind === "edit" && normalizedBody === message.body) throw new Error("수정할 내용을 변경해 주세요.");
  message.sentBody ??= message.body;
  message.changes ??= [];
  message.changes.push({ clientId: input.clientId, action: kind === "all" ? "delete" : "edit",
    expectedVersion: input.expectedVersion, ...(kind === "edit" ? { body: normalizedBody } : {}), at: now });
  if (kind === "edit") { message.body = normalizedBody; message.editedAt = now; }
  else message.deletedAt = now;
}

export function validMessageLifecycle(message, knownUsers, commandIds) {
  if (["sentBody", "changes", "hiddenFor", "editedAt", "deletedAt", "replyVersion", "reviewVersion"]
      .some((key) => message[key] !== undefined) && message.type !== "text") return false;
  if (message.type !== "text") return true;
  if (message.changes !== undefined) {
    if (!Array.isArray(message.changes) || !message.changes.length ||
        typeof message.sentBody !== "string" || message.sentBody.length > 2000 ||
        (!message.sentBody.trim() && !message.attachments.length)) return false;
    let previous = Date.parse(message.createdAt), body = message.sentBody, editedAt;
    for (const [index, change] of message.changes.entries()) {
      if (!exact(change, change?.action === "edit" ? ["clientId", "action", "expectedVersion", "body", "at"] :
        ["clientId", "action", "expectedVersion", "at"]) ||
          !["edit", "delete"].includes(change.action) || !commandId(change.clientId) || commandIds.has(change.clientId) ||
          change.expectedVersion !== index + 1 || !timestamp(change.at) || Date.parse(change.at) < previous ||
          Date.parse(change.at) - Date.parse(message.createdAt) > MESSAGE_CHANGE_WINDOW_MS) return false;
      commandIds.add(change.clientId); previous = Date.parse(change.at);
      if (change.action === "edit") {
        if (typeof change.body !== "string" || change.body !== change.body.trim() || change.body.length > 2000 ||
            (!change.body && !message.attachments.length) || change.body === body) return false;
        body = change.body; editedAt = change.at;
      } else if (index !== message.changes.length - 1 || message.deletedAt !== change.at) return false;
    }
    if (message.body !== body || message.editedAt !== editedAt ||
        (message.changes.at(-1).action !== "delete" && message.deletedAt !== undefined)) return false;
  } else if (["sentBody", "editedAt", "deletedAt"].some((key) => message[key] !== undefined)) return false;
  if (message.hiddenFor !== undefined) {
    if (!Array.isArray(message.hiddenFor)) return false;
    const users = new Set();
    for (const entry of message.hiddenFor) {
      if (!exact(entry, ["userId", "clientId", "at"]) || !knownUsers.includes(entry.userId) || users.has(entry.userId) ||
          !commandId(entry.clientId) || commandIds.has(entry.clientId) || !timestamp(entry.at) ||
          Date.parse(entry.at) < Date.parse(message.createdAt)) return false;
      users.add(entry.userId); commandIds.add(entry.clientId);
    }
  }
  return ["replyVersion", "reviewVersion"].every((key) => message[key] === undefined ||
    (Number.isSafeInteger(message[key]) && message[key] >= 1));
}
