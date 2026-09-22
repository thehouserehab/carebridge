import { escape as e, button, badge, empty, dateLabel } from "./ui.js";
import { mediaGallery } from "./media-ui.js";
import { conversationList, conversationView } from "./conversations.js";
export const sender = (db, childId, id) =>
  db.children.find((c) => c.id === childId)?.therapistId === id
    ? "담당 치료사"
    : "보호자";
export const timeLabel = (v) =>
  v?.includes("T")
    ? new Intl.DateTimeFormat("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(v))
    : "";
export function conversationRows(db, actor, selected = "") {
  return (
    conversationList(db, actor)
      .map(
        (r) =>
          `<button type="button" class="conversation-row ${selected === r.childId ? "selected" : ""}" data-action="open-chat" data-id="${e(r.childId)}" data-message="${e(r.targetId)}"><span class="avatar ${e(r.child.color)}">${e(r.child.name.slice(0, 1))}</span><span class="conversation-summary"><strong>${e(r.child.name)} <small>${r.latest ? sender(db, r.childId, r.latest.authorId) : "새 대화"}</small></strong><span>${e(r.latest?.body || "첫 소식을 남겨 보세요.")}</span></span><span class="conversation-meta"><time>${r.latest ? dateLabel(r.latest.createdAt, { month: "numeric", day: "numeric" }) : ""} ${timeLabel(r.latest?.createdAt)}</time>${r.unread ? `<span class="unread" aria-label="읽지 않은 소식 ${r.unread}개">${r.unread}</span>` : ""}</span></button>`,
      )
      .join("") ||
    empty(
      "연결된 대화가 없어요",
      "담당 관계가 연결된 아이의 대화가 표시됩니다.",
    )
  );
}
function messageCard(db, actor, childId, m) {
  let content = `<p class="message-body">${e(m.body)}</p>`;
  if (m.publication) {
    const p = m.publication;
    content = `<span class="tiny-label">공유 기록${m.archived ? " · 이전 공유본" : ""}</span><h3>${e(p.title)}</h3><p class="message-body">${e(p.summary)}</p>${p.activity ? `<details class="chat-activity"><summary>가정 활동 · ${e(p.activity.title)}</summary><p>${e(p.activity.instruction)}</p><p>${e(p.activity.frequency)}</p><small>${e(p.activity.caution)}</small></details>${actor.role === "guardian" && !m.archived ? button("활동 경험 남기기", "feedback", p.id, "soft activity-response") : ""}` : ""}`;
  }
  if (m.feedback)
    content = `<span class="tiny-label">가정 활동 경험 · ${{ done: "함께 했어요", partial: "조금 해봤어요", skipped: "하지 못했어요" }[m.feedback.result]}</span>${content}${m.feedback.difficulty ? `<p>어려움 · ${e(m.feedback.difficulty)}</p>` : ""}${badge(m.feedback.reviewed ? "다음 회기에 반영 확인" : "반영 확인 전", m.feedback.reviewed ? "green" : "neutral")}${actor.role === "therapist" ? button("반영 메모", "review", m.feedback.id, "text") : ""}`;
  if (m.reviewed) content += badge("다음 회기에 반영 확인", "green");
  return `<article id="message-${e(m.id)}" tabindex="-1" data-message-id="${e(m.id)}" class="chat-message ${m.authorId === actor.id ? "own" : ""} ${m.type !== "text" ? "event-card" : ""} ${m.hidden ? "withdrawn" : ""}"><div class="message-meta"><strong>${sender(db, childId, m.authorId)}</strong><time>${timeLabel(m.createdAt)}</time></div><div class="message-bubble">${m.quote ? `<button type="button" class="message-quote" data-action="jump-message" data-id="${e(m.quote.id)}">${e(m.quote.hidden ? "공유가 종료된 기록입니다." : m.quote.body.slice(0, 100))}</button>` : ""}${content}${mediaGallery(m.attachments)}</div><div class="message-actions">${m.canReply ? button(m.type === "publication" ? "이 기록에 답하기" : "답하기", "reply-message", m.id, "text") : ""}${actor.role === "therapist" && m.type !== "publication" ? button("기록에 참고", "reference-message", m.id, "text") : ""}${actor.role === "therapist" && m.type === "text" && m.authorId !== actor.id ? button("반영 메모", "message-review", m.id, "text") : ""}${m.authorId === actor.id ? `<small>${m.read ? "읽음" : "아직 읽지 않음"}</small>` : ""}</div></article>`;
}
export function chatScreen(db, actor, childId, opened) {
  const child = db.children.find((c) => c.id === childId);
  const room = conversationView(db, actor, childId);
  let day = "";
  const messages = room.messages
    .map((m) => {
      const date = m.createdAt.slice(0, 10);
      const divider =
        date !== day ? `<p class="chat-date">${dateLabel(date)}</p>` : "";
      day = date;
      return divider + messageCard(db, actor, childId, m);
    })
    .join("");
  return `<div class="chat-layout ${opened ? "room-open" : ""}"><aside class="chat-list"><h2>아이별 대화</h2>${conversationRows(db, actor, childId)}</aside><section class="chat-room" aria-label="${e(child.name)} 대화"><header class="chat-header">${button("‹ 목록", "chat-list", "", "text chat-back")}<div><h2>${e(child.name)}</h2><p>담당 치료사 · 연결된 보호자 ${child.guardianIds.length}명</p></div>${button("아이 정보", "nav", "children", "text")}</header><p class="chat-local-note">로컬 대화 체험 · 다른 기기로 전달되지 않습니다.</p><div class="chat-log" role="region" aria-label="대화 내용" tabindex="0">${messages || empty("첫 소식을 남겨 보세요", "일상 소식이나 질문, 사진·동영상을 함께 전할 수 있어요.")}</div><form id="chat-compose" class="chat-composer" aria-label="소식 작성"><div id="reply-preview"></div><label class="sr-only" for="message-body">소식 내용</label><textarea id="message-body" maxlength="2000" rows="2" placeholder="소식이나 궁금한 점을 남겨 주세요" disabled></textarea><div class="compose-actions"><button type="button" class="button soft" data-action="chat-attachments">＋ 사진·동영상</button><span id="draft-status" role="status">작성 중인 소식 불러오는 중…</span><button type="submit" class="button primary" disabled>보내기</button></div><details id="chat-files"><summary>첨부파일 확인</summary><div id="chat-attachment-editor"></div></details><p id="chat-error" class="form-error" role="alert" hidden></p></form></section></div>`;
}
