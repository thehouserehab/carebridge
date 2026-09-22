import { conversationList } from "./conversations.js";
import { conversationRows } from "./chat-ui.js";
import { escape as e, button, empty, dateLabel } from "./ui.js";
import { today } from "./config.js";
export function communicationHome(db, actor, { heading, appointmentRows }) {
  const rooms = conversationList(db, actor);
  const childIds = new Set(rooms.map((r) => r.childId));
  const unread = rooms.reduce((count, r) => count + r.unread, 0);
  const next = db.appointments
    .filter(
      (a) =>
        childIds.has(a.childId) &&
        a.status === "scheduled" &&
        a.date >= today(),
    )
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .slice(0, 3);
  const drafts = db.records
    .filter((r) => childIds.has(r.childId) && r.status === "draft")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const activities = rooms.flatMap((r) =>
    r.messages
      .filter((m) => m.publication?.activity && !m.archived)
      .map((m) => ({ ...m, child: r.child })),
  );
  return `<div class="communication-home"><section class="panel news-panel">${heading(unread ? `새 소식 ${unread}` : "최근 대화", "아이의 소식에서 다음 대화로 이어가세요.")}${conversationRows(db, actor)}</section><div class="home-secondary"><section class="panel">${heading("다음 일정", "담당 아이들의 예정된 만남", button("전체 일정", "nav", "schedule", "text"))}${appointmentRows(next, { all: true })}</section><section class="panel">${
    actor.role === "therapist"
      ? `${heading("이어 쓸 기록", "아직 작성 중인 초안")}${
          drafts.length
            ? drafts
                .slice(0, 5)
                .map(
                  (r) =>
                    `<div class="draft-row"><div><strong>${e(db.children.find((c) => c.id === r.childId).name)} · ${e(r.title)}</strong><small>${dateLabel(r.date)}</small></div>${button("이어 쓰기", "open-draft", r.id, "soft")}</div>`,
                )
                .join("")
            : empty(
                "작성 중인 초안이 없어요",
                "일정에서 기록을 시작하거나 아이의 소식을 기록에 참고할 수 있어요.",
              )
        }`
      : `${heading("가정에서 이어갈 활동", "대화에서 경험을 함께 나눠 주세요.")}${activities.length ? activities.map((m) => `<div class="draft-row"><div><strong>${e(m.publication.activity.title)}</strong><small>${e(m.child.name)}</small></div>${button("대화에서 보기", "open-chat", m.childId, "soft", `data-message="${e(m.id)}"`)}</div>`).join("") : empty("아직 공유된 활동이 없어요", "치료사가 활동을 공유하면 여기에 표시됩니다.")}`
  }</section></div></div>`;
}
