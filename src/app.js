import {
  BRAND,
  ACCOUNTS,
  GUARDIANS,
  THERAPISTS,
  today,
  STORAGE_KEY,
  DEMO_CENTER,
} from "./config.js";
import { OnboardingController } from "./onboarding-controller.js";
import { accountButton } from "./onboarding-ui.js";
import { childProfileEditor, childAgeLabel, memberProfileEditor } from "./profile-ui.js";
import { childProfileFormValues, memberDisplayNameForm } from "./profile-fields.js";
import { demoMember, memberName } from "./member-profiles.js";
import { observeViewport } from "./viewport.js";
import {
  accessibleChildren,
  currentPublications,
  project,
  mutate,
} from "./domain.js";
import { load, persist, assertRevision } from "./repository.js";
import { isCompleteAssessment } from "./record-fields.js";
import { canReadMessage } from "./access.js";
import { conversationView, messageProjection } from "./conversations.js";
import { messageHiddenFor } from "./message-lifecycle.js";
import { sourceMessageVersion, recordReferenceMedia } from "./message-references.js";
import { feedbackVersion } from "./feedback-history.js";
import { chatScreen } from "./chat-ui.js";
import { ChatController } from "./chat-controller.js";
import { communicationHome } from "./home-ui.js";
import {
  recordEditor,
  parseRecordForm,
  assessmentRow,
  reindexAssessmentRows,
  recordDetail,
} from "./record-ui.js";
import { MediaStore, saveWithMedia } from "./media-store.js";
import { AttachmentEditor, mediaGallery, MediaView } from "./media-ui.js";
import {
  escape as e,
  icon,
  button,
  badge,
  dateLabel,
  empty,
  field,
  select,
} from "./ui.js";

const app = document.querySelector("#app");
observeViewport();
document.title = `${BRAND.name} · ${BRAND.tagline}`;
const dialog = document.querySelector("#dialog");
const mediaStore = new MediaStore();
const referencePreviewPolicy = {
  canDisplay(slot) {
    if (!slot.closest(".record-references, .reference-media")) return true;
    try {
      assertRevision(storage, db.revision);
      return !pendingWorkspaceChange;
    } catch { return false; }
  },
  missingMessage: (slot) => slot.closest(".reference-media")
    ? "기록 당시 원본을 이 브라우저에서 찾지 못했어요. 다른 파일로 대체하지 않았어요."
    : null,
};
const pageMedia = new MediaView(mediaStore, referencePreviewPolicy);
const dialogMedia = new MediaView(mediaStore, referencePreviewPolicy);
let attachmentEditor = null;
let saving = false;
let storage;
try {
  storage = window.localStorage;
} catch {
  storage = {
    getItem() {
      throw new Error("unavailable");
    },
  };
}
const loaded = load(storage);
let db = loaded.db;
let loadError = loaded.error;
let pendingWorkspaceChange = false;
let requireStoredWorkspace = Boolean(loadError) || db?.revision > 0;
let account = "therapist",
  childId = "c1",
  view = "home",
  filter = "all",
  query = "",
  chatOpened = false,
  scheduleDate = today(),
  toastTimer,
  dirty = false;
try {
  const pref = JSON.parse(
    sessionStorage.getItem("child-development-view") || "null",
  );
  if (pref && ACCOUNTS[pref.account]) {
    account = pref.account;
    childId = pref.childId;
    view = pref.view;
    chatOpened = pref.view === "chat" && pref.chatOpened === true;
  }
} catch {
  /* UI preferences are optional. */
}
const actor = () => ACCOUNTS[account];
const getView = () => project(db, actor(), childId);
let chatTarget = "";
const chat = new ChatController({
  getState: () => ({ db, actor: actor(), childId }),
  mediaStore,
  commit: (...args) => commit(...args),
  render: (id) => {
    chatTarget = id;
    safeRender();
  },
  read: (context, id) => {
    const room = conversationView(db, context.actor, context.childId);
    const m = room.messages.find((m) => m.id === id);
    if (!m || m.sequence <= room.lastRead) return;
    const next = mutate(db, context.actor, "read", {
      childId: context.childId,
      id,
    });
    persist(storage, next, db.revision);
    db = next;
  },
});
const roleName = () => ACCOUNTS[account].label;
const onboarding = new OnboardingController({
  getActor: actor,
  render: () => safeRender(),
  flash,
  busy: () => saving || chat.sending || chat.editor?.busy || dialog.open,
  getMemberName: (id) => demoMember(db, id)?.name,
});
const goalName = (id) =>
  db.goals.find((g) => g.id === id)?.title || "연결된 목표";
const childName = (id) => db.children.find((c) => c.id === id)?.name || "";
const statusLabels = {
  scheduled: "예정",
  attended: "출석",
  absent: "결석",
  cancelled: "취소",
};
const resultLabels = {
  done: "함께 했어요",
  partial: "조금 해봤어요",
  skipped: "하지 못했어요",
};
const navItems = () =>
  account === "center"
    ? [
        ["home", "운영 현황", "home"],
        ["children", "아동", "child"],
        ["schedule", "일정", "calendar"],
        ["members", "구성원", "child"],
      ]
    : [
        ["home", "홈", "home"],
        ["chat", "대화", "message"],

        ["records", "기록", "record"],
        ["children", "아이 정보", "child"],
      ];
function flash(message) {
  const t = document.querySelector("#toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4000);
}
function errorMarkup(message) {
  return `<div class="fatal" role="alert"><h1>기록을 불러오지 못했어요</h1><p>${e(message)}</p>${button("다시 불러오기", "reload")}</div>`;
}
function safeRender() {
  chat.stop();
  pageMedia.clear();
  try {
    render();
    pageMedia.hydrate(app);
    if (view === "chat") {
      chat.mount(chatTarget);
      chatTarget = "";
    }
  } catch {
    app.innerHTML = errorMarkup(
      "화면에 필요한 데이터가 올바르지 않습니다. 저장된 데이터는 유지했습니다. 개발 담당자에게 확인을 요청해 주세요.",
    );
  }
}
function render() {
  if (!db) {
    app.innerHTML = errorMarkup(loadError);
    return;
  }
  const children = accessibleChildren(db, actor());
  if (!children.some((c) => c.id === childId)) childId = children[0]?.id ?? null;
  if (
    !navItems().some(([id]) => id === view) &&
    !["schedule", "activities"].includes(view)
  )
    view = "home";
  // No assignment is a valid workspace state, not permission to pick an
  // unrelated child. Keep the child-scoped projection fail-closed.
  const p = children.length ? getView() : null;
  try {
    sessionStorage.setItem(
      "child-development-view",
      JSON.stringify({ account, childId, view, chatOpened }),
    );
  } catch {
    /* Optional preference only. */
  }
  const nav = navItems()
    .map(
      ([id, label, i]) =>
        `<button class="nav-item ${view === id ? "active" : ""}" data-action="nav" data-id="${id}" ${view === id ? 'aria-current="page"' : ""}>${icon(i)}<span>${label}</span></button>`,
    )
    .join("");
  const primaryAction = !p ? "" : view === "home" && account !== "center"
    ? button(account === "guardian" ? "소식 보내기" : "대화 시작", "start-chat", "", "primary")
    : account === "therapist" && !["children", "chat"].includes(view)
      ? button(`${icon("plus")} 기록 작성`, "record", "", "primary")
      : account === "center" && view !== "members"
        ? button(`${icon("plus")} 일정 등록`, "appointment", "", "primary") : "";
  const context = !p ? "" : `<div class="context-bar" ${view === "members" || (["home", "chat"].includes(view) && account !== "center") ? "hidden" : ""}><div class="child-select"><span class="avatar ${e(p.child.color)}">${e(p.child.name.slice(0, 1))}</span><label><span class="sr-only">선택한 아동</span><select id="child" aria-label="선택한 아동">${children.map((c) => `<option value="${c.id}" ${c.id === childId ? "selected" : ""}>${e(c.name)} · ${e(childAgeLabel(c))}</option>`).join("")}</select></label><span class="context-meta">${e(demoMember(db, p.child.therapistId)?.name || "미배정")}</span></div><span class="demo-note">가상 아동 · 이 브라우저에 저장</span></div>`;
  const content = p ? {
    home: homeView, chat: () => chatScreen(db, actor(), childId, chatOpened),
    children: childrenView, records: recordsView, activities: activitiesView,
    schedule: scheduleView, members: () => onboarding.screen(),
  }[view](p) : emptyAssignmentView();
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="#home" data-action="nav" data-id="home"><img src="/favicon.svg" alt="" width="34" height="34"><span>${e(BRAND.name)}<small>${e(BRAND.tagline)}</small></span></a><div class="workspace-label">우리 아이를 중심으로</div><nav aria-label="주요 메뉴">${nav}</nav><div class="sidebar-bottom"><div class="connection-mark"><i></i><i></i><i></i></div><strong>센터에서 가정까지</strong><p>작은 기록을 함께 이어가요.</p>${button("프로토타입 안내", "about", "", "text")}</div></aside><div class="body"><header class="topbar"><span class="workspace-title">${e(BRAND.name)} <span class="muted">/ ${roleName()}</span></span><div class="demo-switch"><span>데모 화면</span><label class="sr-only" for="role">사용자 역할</label><select id="role" aria-label="사용자 역할">${Object.entries(
    ACCOUNTS,
  )
    .map(
      ([id, a]) =>
        `<option value="${id}" ${id === account ? "selected" : ""}>${a.label}</option>`,
    )
    .join(
      "",
    )}</select></div></header><main id="main" tabindex="-1"><div class="page-heading"><div><p class="eyebrow">${dateLabel(today(), { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</p><h1>${{ home: account === "center" ? "오늘의 센터" : account === "guardian" ? "아이의 소식을 함께 나눠요" : "소식에서 다음 만남으로", chat: "대화", children: account === "guardian" ? "아이를 함께 이해해요" : "우리 아이들", records: account === "guardian" ? "센터에서 전해온 기록" : "기록과 변화", activities: "가정에서 이어가는 시간", schedule: "함께하는 일정", members: "구성원" }[view]}</h1></div>${primaryAction}</div>${context}<div id="view-content">${content}</div><footer class="page-footer">${e(BRAND.version)} · 실제 아동 정보는 입력하지 마세요.</footer></main></div><nav class="mobile-nav" aria-label="모바일 메뉴">${nav}</nav></div>`;
  app.querySelector(".topbar .demo-switch").insertAdjacentHTML("beforebegin",
    `<div class="topbar-actions">${button(`${icon("child")}<span>내 표시 이름</span>`, "member-profile", "", "text member-profile-entry", 'aria-label="내 표시 이름"')}${accountButton("로그인 화면", "login", "", "text account-login-entry")}</div>`);
}
function emptyAssignmentView() {
  const description = account === "guardian"
    ? "센터에서 보호자 관계를 연결하면 아이의 소식과 공유 기록을 확인할 수 있어요."
    : "센터에서 담당 관계를 연결하면 아이의 소식과 기록을 확인할 수 있어요.";
  return `<section class="panel" data-empty-assignment aria-label="아동 연결 안내">${empty("연결된 아이가 아직 없어요", description)}<p class="footnote">연결이 없어도 기존 기록과 미전송 초안은 삭제되지 않아요.</p></section>`;
}
function heading(title, subtitle = "", action = "") {
  return `<div class="section-heading"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ""}</div>${action}</div>`;
}
function appointmentRows(rows, { all = false } = {}) {
  return rows.length
    ? `<div class="rows">${rows.map((a) => `<div class="appointment-row"><div class="time"><strong>${a.time}</strong><small>${a.duration}분</small></div><div class="row-main"><strong>${all ? `${e(childName(a.childId))} · ` : ""}${e(a.title)}</strong><span>${dateLabel(a.date)} · ${e(a.room)}</span></div>${badge(statusLabels[a.status], a.status === "attended" ? "green" : "neutral")}<div class="row-actions">${account === "therapist" && a.status !== "cancelled" ? button(db.records.some((r) => r.appointmentId === a.id) ? "기록 보기" : "기록하기", "session-record", a.id, "text") : ""}${account !== "guardian" ? button(icon("chevron"), "appointment", a.id, "icon-button", `aria-label="${e(childName(a.childId))} ${a.time} 일정 수정"`) : ""}</div></div>`).join("")}</div>`
    : empty("예정된 일정이 없어요", "새 일정이 등록되면 여기에 표시돼요.");
}
function homeView(p) {
  return account === "center"
    ? centerView(p)
    : communicationHome(db, actor(), { heading, appointmentRows });
}
function recordCards(records, compact = false) {
  if (!records.length)
    return empty(
      "아직 작성한 기록이 없어요",
      "아이의 목표와 오늘의 경험을 연결해 보세요.",
      button("첫 기록 작성", "record", "", "soft"),
    );
  return records
    .map(
      (r) =>
        `<article class="record-card"><div class="meta">${badge(r.publicationId ? "공유 중" : r.status === "draft" ? "작성 중인 초안" : "내부 기록", r.publicationId ? "green" : "neutral")}<time>${dateLabel(r.date)}</time></div><h3>${e(r.title)}</h3><p class="goal-ref">${icon("target")}${e(goalName(r.goalId))}</p><p class="body-copy">${e(r.summary || "보호자에게 공유할 내용을 아직 작성하지 않았어요.")}</p>${mediaGallery(r.attachments, true)}${!compact ? `<details><summary>내부 기록과 평가 보기</summary><div class="private-content">${recordDetail(r)}</div></details>` : ""}<div class="card-actions">${button("수정", "record", r.id, "text")}${button("공유 미리보기", "preview", r.id, "soft")}${r.publicationId ? button("공유 철회", "unpublish", r.id, "text muted") : ""}</div></article>`,
    )
    .join("");
}
function publicationCards(pubs) {
  return pubs.length
    ? pubs
        .map(
          (p) =>
            `<article class="record-card"><div class="meta">${badge("센터에서 공유", "blue")}<time>${dateLabel(p.date)}</time></div><h3>${e(p.title)}</h3><p class="goal-ref">${icon("target")}${e(goalName(p.goalId))}</p><p class="body-copy">${e(p.summary)}</p>${mediaGallery(p.attachments)}${p.activity ? button(`${icon("activity")} 연결된 가정 활동`, "to-activities", "", "text") : ""}</article>`,
        )
        .join("")
    : empty(
        "아직 공유된 기록이 없어요",
        "담당 치료사가 확인 후 공유한 기록만 여기에 표시돼요.",
      );
}
function recordsView(p) {
  const goals = [["all", "모든 목표"], ...p.goals.map((g) => [g.id, g.title])];
  const records = p.records
    .filter((r) => filter === "all" || r.goalId === filter)
    .sort((a, b) => b.date.localeCompare(a.date));
  const pubs = p.publications
    .filter((r) => filter === "all" || r.goalId === filter)
    .sort((a, b) => b.date.localeCompare(a.date));
  return `<div class="view-toolbar"><div class="tabs"><button class="tab active">${account === "guardian" ? "공유된 이야기" : "세션 기록"}</button></div><label class="sr-only" for="goal-filter">목표별 기록 필터</label><select id="goal-filter" aria-label="목표별 기록 필터">${goals.map(([v, t]) => `<option value="${v}" ${filter === v ? "selected" : ""}>${e(t)}</option>`).join("")}</select></div><div class="content-grid"><section class="panel">${account === "therapist" ? recordCards(records) : publicationCards(pubs)}</section><aside><section class="panel">${heading("연결된 변화", "기록과 가정의 경험을 함께 확인해요")}${timeline(p, filter)}</section>${account === "therapist" ? assessmentCompare(records) : ""}</aside></div>`;
}
function timeline(p, goalFilter = "all") {
  const pubs = p.publications.filter(
    (x) => goalFilter === "all" || x.goalId === goalFilter,
  );
  const entries = [
    ...pubs.map((x) => ({
      date: x.date,
      title: "센터 기록 공유",
      body: x.title,
      type: "blue",
    })),
    ...p.feedback
      .filter((f) => pubs.some((x) => x.id === f.publicationId))
      .map((f) => ({
        date: f.date,
        title: resultLabels[f.result],
        body: f.reaction,
        type: "green",
      })),
    ...p.goals
      .filter((g) => goalFilter === "all" || g.id === goalFilter)
      .map((g) => ({
        date: g.updatedAt.slice(0, 10),
        title:
          g.status === "achieved" ? "목표 달성으로 기록" : "함께 정한 목표",
        body: g.title,
        type: "neutral",
      })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  return entries.length
    ? `<ol class="timeline">${entries
        .slice(0, 15)
        .map(
          (x) =>
            `<li><span class="timeline-dot ${x.type}"></span><time>${dateLabel(x.date)}</time><strong>${e(x.title)}</strong><p>${e(x.body)}</p></li>`,
        )
        .join("")}</ol>`
    : empty(
        "변화를 함께 쌓아가요",
        "목표와 공유 기록, 피드백이 여기에 연결돼요.",
      );
}
function assessmentCompare(records) {
  const groups = new Map();
  for (const r of records
    .filter((r) => r.status === "saved")
    .flatMap((r) =>
      (r.assessments || []).filter(isCompleteAssessment).map((assessment) => ({ ...r, assessment })),
    )
    .sort((a, b) => a.date.localeCompare(b.date))) {
    const a = r.assessment;
    const key = JSON.stringify([r.goalId, a.tool, a.item, a.unit, a.context]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return `<section class="panel">${heading("직접 입력한 평가값", "같은 목표·항목·단위·측정 조건끼리 표시해요")}${groups.size ? [...groups.values()].map((list) => `<div class="comparison"><strong>${e(list[0].assessment.item)}</strong><small>${e(list[0].assessment.tool)} · ${e(list[0].assessment.context)}</small>${list.map((r) => `<div><span>${dateLabel(r.date)}</span><b>${r.assessment.value} ${e(r.assessment.unit)}</b></div>`).join("")}</div>`).join("") : empty("평가값이 아직 없어요", "필요할 때 기록 작성에서 직접 입력할 수 있어요.")}<p class="footnote">입력값의 비교이며, 자동 점수 산정이나 임상 해석은 제공하지 않습니다.</p></section>`;
}
function childrenView(p) {
  const cards = p.children.filter((c) => c.name.includes(query));
  const roster =
    account !== "guardian"
      ? `<section class="panel roster">${heading("등록된 아동", `${p.children.length}명`, account === "center" ? button(`${icon("plus")} 아동 등록`, "child", "", "soft") : "")}<label class="search-label">${icon("child")}<input id="child-search" aria-label="아동 검색" placeholder="이름으로 찾기" value="${e(query)}"></label><div id="roster">${cards.length ? cards.map((c) => `<button class="child-row ${c.id === childId ? "selected" : ""}" data-action="select-child" data-id="${c.id}"><span class="avatar ${e(c.color)}">${e(c.name.slice(0, 1))}</span><span><strong>${e(c.name)}</strong><small>${e(childAgeLabel(c))} · ${e(demoMember(db, c.therapistId)?.name || "미배정")}</small></span>${icon("chevron")}</button>`).join("") : empty("검색 결과가 없어요", "다른 이름으로 찾아보세요.")}</div></section>`
      : "";
  const profile = `<section class="panel profile"><div class="profile-header"><span class="avatar large ${e(p.child.color)}">${e(p.child.name.slice(0, 1))}</span><div><h2>${e(p.child.name)}</h2><p>${e(childAgeLabel(p.child, true))} · 가상 아동</p></div>${badge("함께하는 중", "green")}</div><div class="profile-facts"><span>담당 치료사<strong>${e(demoMember(db, p.child.therapistId)?.name || "미배정")}</strong></span><span>예정된 일정<strong>${p.appointments.filter((a) => a.date >= today() && a.status === "scheduled").length}건</strong></span></div>${account === "center" ? `<div class="card-actions">${button("기본정보 수정", "child-profile", childId, "text")}</div>` : ""}</section>`;
  if (account === "center")
    return `<div class="children-grid">${roster}<div>${profile}<section class="panel">${heading("아동 일정", "센터에서는 기본 정보와 운영 현황을 확인해요", button("담당 관계 관리", "relationships", childId, "soft"))}${appointmentRows(p.appointments.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)))}<p class="footnote">기록 작성 ${p.recordCount}건 · 임상 기록과 가족 피드백 내용은 이 화면에 표시하지 않습니다.</p></section></div></div>`;
  return `<div class="${account === "guardian" ? "content-grid" : "children-grid"}">${roster}<div>${profile}<div class="child-shortcuts">${button("대화 열기", "open-chat", childId, "soft")}${button("전체 일정", "nav", "schedule", "soft")}${button("가정 활동", "nav", "activities", "soft")}</div><section class="panel">${heading("가족이 바라는 변화", "목표를 함께 정하는 출발점", account === "guardian" ? button("수정", "concern", "", "text") : "")}<p class="body-copy">${e(p.child.concern || "아직 남긴 관심사가 없어요.")}</p></section><section class="panel">${heading("함께 정한 목표", "관찰한 변화에 맞춰 목표를 조정해요", account === "therapist" ? button("목표 추가", "goal", "", "soft") : "")}${p.goals.length ? p.goals.map((g) => `<article class="goal-card"><div class="meta">${badge({ active: "이어가는 중", achieved: "달성", paused: "잠시 보류" }[g.status], g.status === "achieved" ? "green" : "blue")}</div><h3>${e(g.title)}</h3><p>${e(g.description)}</p>${account === "therapist" ? button("목표 수정", "goal", g.id, "text") : ""}</article>`).join("") : empty("아직 정한 목표가 없어요", "보호자의 관심사를 참고해 첫 목표를 정해 주세요.")}</section></div>${account === "guardian" ? `<aside class="panel">${heading("함께 쌓은 이야기")}${timeline(p)}</aside>` : ""}</div>`;
}
function feedbackCard(f, pub) {
  return `<article class="feedback-card"><div class="meta">${badge(resultLabels[f.result], f.result === "done" ? "green" : "neutral")}<time>${dateLabel(f.date)}</time>${badge(f.reviewed ? "치료사 확인" : "확인 대기", f.reviewed ? "neutral" : "blue")}</div><strong>${e(pub?.activity?.title || "가정 활동")}</strong><p>${e(f.reaction)}</p>${mediaGallery(f.attachments)}${f.difficulty ? `<p class="difficulty">어려웠던 점 · ${e(f.difficulty)}</p>` : ""}${account === "therapist" && f.reviewNote ? `<div class="review-note">다음 회기에 반영 · ${e(f.reviewNote)}</div>` : ""}<div class="card-actions">${account === "therapist" ? button(f.reviewed ? "반영 메모 수정" : "확인하고 다음 회기 준비", "review", f.id, "soft") : currentPublications(db, childId).some((p) => p.id === f.publicationId) ? button("피드백 수정", "feedback-edit", f.id, "text") : ""}</div></article>`;
}
function activitiesView(p) {
  // Current sharing status does not grant access to pre-connection history.
  const currentIds = new Set(currentPublications(db, childId).map((pub) => pub.id));
  const pubs = p.publications.filter((pub) => pub.activity && currentIds.has(pub.id));
  const feedback = p.feedback
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));
  return `<div class="content-grid"><section><div class="section-heading"><div><h2>${account === "guardian" ? "함께 해볼 활동" : "공유 중인 가정 활동"}</h2><p>아이의 목표에서 이어진 활동이에요.</p></div>${badge(`${pubs.length}개`, "blue")}</div>${pubs.length ? pubs.map((pub) => `<article class="panel activity-card"><span class="activity-symbol">${icon("activity")}</span><p class="goal-ref">${icon("target")}${e(goalName(pub.goalId))}</p><h2>${e(pub.activity.title)}</h2><p class="body-copy">${e(pub.activity.instruction)}</p><p class="frequency">${icon("clock")}${e(pub.activity.frequency)}</p>${pub.activity.caution ? `<details><summary>활동 전 확인해 주세요</summary><p class="footnote">${e(pub.activity.caution)}</p></details>` : ""}<div class="card-actions">${account === "guardian" ? button("활동 경험 남기기", "feedback", pub.id, "primary") : button("연결된 기록 수정", "record", pub.recordId, "soft")}</div></article>`).join("") : `<section class="panel">${empty("아직 공유된 활동이 없어요", account === "therapist" ? "세션 기록에 가정 활동을 추가하고 공유해 주세요." : "치료사가 준비한 활동이 공유되면 알려드릴게요.", account === "therapist" ? button("기록 작성", "record", "", "soft") : "")}</section>`}</section><section class="panel">${heading(account === "guardian" ? "우리 가족의 경험" : "가정에서 전해온 소식", `${feedback.length}개의 피드백${account === "therapist" ? ` · 확인 대기 ${feedback.filter((f) => !f.reviewed).length}개` : ""}`)}${
    feedback.length
      ? feedback
          .map((f) =>
            feedbackCard(
              f,
              p.publications.find((pub) => pub.id === f.publicationId),
            ),
          )
          .join("")
      : empty(
          "아직 남긴 경험이 없어요",
          "잘된 점도, 어려웠던 점도 다음 만남에 도움이 돼요.",
        )
  }</section></div>`;
}
function centerView() {
  const children = accessibleChildren(db, actor());
  const appts = db.appointments
    .filter((a) => a.date === today())
    .sort((a, b) => a.time.localeCompare(b.time));
  const due = appts.filter(
    (a) =>
      a.status === "attended" &&
      !db.records.some((r) => r.appointmentId === a.id),
  );
  return `<div class="metric-strip"><div><span>오늘 일정</span><strong>${appts.filter((a) => a.status !== "cancelled").length}<small>건</small></strong></div><div><span>출석 확인</span><strong>${appts.filter((a) => a.status === "attended").length}<small>건</small></strong></div><div><span>기록 작성 대기</span><strong>${due.length}<small>건</small></strong></div><div><span>등록 아동</span><strong>${children.length}<small>명</small></strong></div></div><section class="panel">${heading("오늘의 일정", "출결을 확인하고 다음 업무로 연결하세요.", button("전체 일정", "nav", "schedule", "text"))}${appointmentRows(appts, { all: true })}</section><section class="panel">${heading("기록 확인이 필요한 일정", "출석 처리된 일정 중 연결된 세션 기록이 없는 건입니다.")}${appointmentRows(due, { all: true })}</section>`;
}
function scheduleView(p) {
  const all = account === "center";
  const rows = (all ? db.appointments : p.appointments)
    .filter((a) => a.date === scheduleDate)
    .sort((a, b) => a.time.localeCompare(b.time));
  return `<div class="view-toolbar"><div class="date-controls">${button("이전 날", "day", "-1", "icon-button", 'aria-label="이전 날"')}<label class="sr-only" for="schedule-date">일정 날짜</label><input id="schedule-date" type="date" value="${scheduleDate}" aria-label="일정 날짜">${button("다음 날", "day", "1", "icon-button", 'aria-label="다음 날"')}${button("오늘", "today", "", "text")}</div>${account !== "guardian" ? button(`${icon("plus")} 일정 등록`, "appointment", "", "soft") : ""}</div><section class="panel">${heading(`${dateLabel(scheduleDate)} 일정`, all ? "센터 전체 아동의 일정을 보여드려요." : `${e(p.child.name)}의 일정을 보여드려요.`)}${appointmentRows(rows, { all })}</section><p class="footnote">일정 변경은 이 브라우저에 반영됩니다. 문자·카카오톡 알림은 전송되지 않습니다.</p>`;
}

function openForm(title, content, action, meta = {}, submit = "저장하기") {
  disposeDialogMedia();
  dirty = false;
  const memberEdit = action === "member-profile";
  dialog._profileActor = memberEdit ? { ...actor() } : null;
  dialog._profileReturnFocus = memberEdit ? document.activeElement : null;
  dialog.innerHTML = `<form id="edit-form"><header class="dialog-header"><div><p class="eyebrow">${e(childName(meta.childId || childId))} · ${roleName()}</p><h2 id="dialog-title">${title}</h2></div>${button(icon("close"), "close", "", "icon-button", 'aria-label="닫기"')}</header><div class="dialog-body">${content}<p id="form-error" class="form-error" role="alert" tabindex="-1" hidden></p></div><footer class="dialog-footer">${button("취소", "close", "", "secondary")}<button class="button primary" type="submit">${submit}</button></footer></form>`;
  dialog.dataset.action = action;
  dialog._meta = meta;
  if (memberEdit) dialog.querySelector(".eyebrow").textContent = `${DEMO_CENTER.name} · ${roleName()}`;
  dialog.showModal();
  if (pendingWorkspaceChange) showWorkspaceChange();
}
function disposeDialogMedia() {
  attachmentEditor?.dispose();
  attachmentEditor = null;
  dialogMedia.clear();
}
function mountAttachments(items = [], sharing = false) {
  const root = document.createElement("div");
  dialog.querySelector("#form-error").before(root);
  attachmentEditor = new AttachmentEditor(root, items, mediaStore, {
    sharing,
    onChange: () => {
      dirty = true;
    },
  });
}
function recordForm(
  id = "",
  appointmentId = "",
  referenceId = "",
  templateId = "",
) {
  const p = getView();
  if (!p.goals.length) {
    flash("첫 기록을 작성하기 전에 목표를 정해 주세요.");
    openAction("goal");
    return;
  }
  let r = p.records.find((x) => x.id === id) || {};
  if (templateId) {
    const source = p.records.find((x) => x.id === templateId);
    r = {
      goalId: source.goalId,
      assessments: (source.assessments || []).map((a) => ({ ...a, value: "" })),
    };
  }
  const refs = referenceId ? [referenceId] : r.referenceMessageIds || [];
  const messages = refs.flatMap((id) => {
    const message = db.messages.find((m) => m.id === id && m.childId === childId);
    if (!message) return [];
    const saved = r.referenceSources?.find((source) => source.messageId === id);
    if (saved) return [{ id, body: saved.body, version: saved.version, preserved: true,
      recordId: r.id, attachments: saved.attachments,
      sourceChanged: saved.version !== sourceMessageVersion(db, message),
      sourceUnavailable: !!message.deletedAt || messageHiddenFor(message, actor()) }];
    return [messageProjection(db, actor(), message)];
  });
  const selectedAppointment = r.appointmentId || appointmentId;
  const date =
    r.date ||
    db.appointments.find((a) => a.id === selectedAppointment)?.date ||
    today();
  openForm(
    id ? "세션 기록 수정" : "오늘의 세션 기록",
    recordEditor(r, p.goals, date, messages),
    "record",
    {
      id,
      childId,
      appointmentId: selectedAppointment || "",
      referenceMessageIds: refs,
      expectedReferenceVersions: messages.filter((m) => ["text", "feedback"].includes(m.type) && !m.preserved)
        .map((m) => ({ messageId: m.id, version: m.version })),
      format: r.format || "structured",
    },
    "기록 저장",
  );
  const titleInput = dialog.querySelector("[name=title]");
  let automaticTitle = !r.title;
  const suggestTitle = () => {
    if (!automaticTitle) return;
    const day = dialog.querySelector("[name=date]").value;
    const activity = dialog
      .querySelector("[name=performed]")
      .value.trim()
      .slice(0, 50);
    titleInput.value = `${day} ${activity || "세션 기록"}`;
  };
  titleInput.addEventListener("input", () => {
    automaticTitle = false;
  });
  dialog.querySelector("[name=date]").addEventListener("input", suggestTitle);
  dialog
    .querySelector("[name=performed]")
    .addEventListener("input", suggestTitle);
  suggestTitle();
  const footer = dialog.querySelector(".dialog-footer");
  footer.insertAdjacentHTML(
    "afterbegin",
    '<button type="submit" class="button text" name="intent" value="draft" formnovalidate>초안 저장</button>',
  );
  footer.insertAdjacentHTML(
    "beforeend",
    '<button type="submit" class="button primary" name="intent" value="share">보호자 공유 준비</button>',
  );
  const wrap = document.createElement("details");
  wrap.className = "record-details";
  wrap.open = !!r.attachments?.length;
  wrap.innerHTML = "<summary>사진·동영상</summary><div></div>";
  dialog.querySelector("#form-error").before(wrap);
  attachmentEditor = new AttachmentEditor(
    wrap.querySelector("div"),
    r.attachments || [],
    mediaStore,
    {
      sharing: true,
      onChange: () => {
        dirty = true;
      },
    },
  );
  const last = p.records
    .filter((x) => x.id !== id)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!id && last)
    dialog
      .querySelector(".dialog-body")
      .insertAdjacentHTML(
        "afterbegin",
        button(
          "이전 목표·측정 항목만 가져오기",
          "record-template",
          last.id,
          "text",
        ),
      );
  const notes = [
    ...db.messages
      // Clinical notes survive source-message hiding/deletion, but must still
      // respect this therapist's relationship and history boundary.
      .filter((m) => m.childId === childId && m.reviewed && m.reviewNote && canReadMessage(db, actor(), m))
      .slice(-3)
      .map((m) => m.reviewNote),
    ...p.feedback
      .filter((f) => f.reviewed && f.reviewNote)
      .slice(-3)
      .map((f) => f.reviewNote),
    ...p.records
      .filter((r) => r.nextPlan && r.id !== id)
      .slice(-1)
      .map((r) => r.nextPlan),
  ];
  if (notes.length)
    dialog
      .querySelector(".dialog-body")
      .insertAdjacentHTML(
        "afterbegin",
        `<details class="previous-context"><summary>이전 기록과 가정 피드백에서 이어갈 내용</summary>${notes.map((note) => `<p class="footnote">${e(note)}</p>`).join("")}</details>`,
      );
}
function openAction(action, id = "") {
  if (action === "member-profile") {
    if (saving || dialog.open || onboarding.dialog.open) return;
    const member = demoMember(db, actor().id);
    if (!member) return;
    openForm("내 표시 이름", memberProfileEditor(member), "member-profile", {}, "표시 이름 저장");
    return;
  }
  const p = getView();
  if (["message-edit", "message-delete"].includes(action)) {
    const message = conversationView(db, actor(), childId).messages.find((m) => m.id === id);
    if (!message || (action === "message-edit" && !message.canEdit)) return;
    const content = action === "message-edit"
      ? `${field("수정할 소식", "body", message.body, { type: "textarea", id: "message-edit-body" })}<p class="footnote">보낸 뒤 24시간 안에 본문을 수정할 수 있어요. 사진·동영상은 바뀌지 않으며 ‘수정됨’이 표시돼요.</p>`
      : `${select("삭제 범위", "scope", [["self", "나에게만 삭제"], ...(message.canDeleteAll ? [["all", "모두에게서 삭제"]] : [])], "self", "message-delete-scope")}<p class="notice">나에게만 삭제하면 다른 참여자의 소식은 유지돼요. 모두에게서 삭제는 본인이 보낸 뒤 24시간 안에 가능하며 삭제 안내가 남아요.</p><p class="footnote">이 기능은 대화에서 숨기는 처리예요. 이미 참고한 치료 기록·공유본·다운로드한 사본과 보관 파일을 지우지 않아요.</p><label class="check"><input type="checkbox" name="confirmed"> 선택한 범위에서 삭제할 것을 확인했어요.</label>`;
    openForm(action === "message-edit" ? "보낸 소식 수정" : "소식 삭제", content, action,
      { childId, id, expectedVersion: message.version, clientId: crypto.randomUUID() },
      action === "message-edit" ? "수정 저장" : "선택한 범위로 삭제");
    dialog._messageActor = { ...actor() };
    return;
  }
  if (action === "message-review") {
    const m = conversationView(db, actor(), childId).messages.find(
      (m) => m.id === id,
    );
    if (!m) return;
    openForm(
      "다음 회기에 반영",
      `${m.reviewChanged ? '<p class="notice">원문이 수정됐어요. 기존 메모는 수정 전 내용에 대한 메모이므로 현재 소식과 대조한 뒤 확인해 주세요.</p>' : ""}<blockquote>${e(m.body)}</blockquote>${field("다음 회기에 반영할 내용", "reviewNote", m.reviewNote || "", { type: "textarea", required: true, hint: "내부 메모입니다. 공개 답변은 대화에서 따로 보내세요." })}`,
      "message-review",
      { childId, id, expectedVersion: m.version },
      "확인하고 저장",
    );
    return;
  }
  if (action === "record") {
    recordForm(id);
    return;
  }
  if (action === "goal") {
    const g = p.goals.find((g) => g.id === id) || {};
    openForm(
      id ? "함께 정한 목표 수정" : "새로운 목표",
      `${field("목표", "title", g.title || "", { required: true, max: 100, placeholder: "가족과 함께 바라는 변화를 적어 주세요" })}${field("목표 설명", "description", g.description || "", { type: "textarea" })}${select(
        "목표 상태",
        "status",
        [
          ["active", "이어가는 중"],
          ["achieved", "달성"],
          ["paused", "잠시 보류"],
        ],
        g.status || "active",
      )}`,
      "goal",
      { id, childId },
    );
  }
  if (action === "concern")
    openForm(
      "가족이 바라는 변화",
      field("관심사와 바라는 변화", "concern", p.child.concern, {
        type: "textarea",
        max: 1000,
        placeholder: "일상에서 중요하게 생각하는 일이나 어려움을 알려주세요.",
      }),
      "concern",
      { childId },
    );
  if (action === "preview") {
    const r = p.records.find((r) => r.id === id);
    if (!r) return;
    openForm(
      "보호자에게 보이는 내용",
      `<p class="notice">${e(p.child.name)}의 연결된 보호자에게 아래 내용만 공유합니다.</p><article class="share-preview"><div class="meta">${badge("공유 미리보기", "blue")}<time>${dateLabel(r.date)}</time></div><h3>${e(r.title)}</h3><p class="goal-ref">${e(goalName(r.goalId))}</p><p class="body-copy">${e(r.summary || "공유할 내용을 먼저 작성해 주세요.")}</p>${r.activity ? `<hr><span class="tiny-label">가정에서 함께 해봐요</span><h3>${e(r.activity.title)}</h3><p>${e(r.activity.instruction)}</p><p>${e(r.activity.frequency)}</p><small>${e(r.activity.caution)}</small>` : ""}</article><p class="footnote">내부 메모, 평가 원문, 다음 회기 메모는 포함되지 않습니다. 재공유하면 새로운 공유본이 생성되고 이전 피드백은 당시 내용과 연결됩니다.</p>`,
      "publish",
      { id, childId },
      r.publicationId ? "수정 내용 공유하기" : "보호자에게 공유",
    );
    const recipients = document.createElement("p");
    recipients.textContent = `수신자 ${p.child.guardianIds.length}명 · ${p.child.guardianIds.map((id) => memberName(db, id)).join(", ") || "연결된 보호자 없음"}`;
    dialog.querySelector(".notice").append(recipients);
    dialog
      .querySelector(".share-preview")
      .insertAdjacentHTML(
        "beforeend",
        mediaGallery((r.attachments || []).filter((file) => file.share)),
      );
    dialogMedia.hydrate(dialog);
  }
  if (action === "unpublish")
    openForm(
      "공유를 철회할까요?",
      '<p>보호자 화면에서 이 기록과 연결된 활동이 내려갑니다. 기존 기록과 피드백은 치료사 화면에 보존됩니다.</p><p class="footnote">이미 확인하거나 별도로 보관한 내용까지 회수할 수는 없습니다.</p>',
      "unpublish",
      { id, childId },
      "공유 철회",
    );
  if (action === "feedback" || action === "feedback-edit") {
    const f =
      action === "feedback-edit" ? p.feedback.find((f) => f.id === id) : null;
    const pub = p.publications.find((x) => x.id === (f?.publicationId || id));
    if (!pub?.activity) return;
    openForm(
      "우리 가족의 활동 경험",
      `<div class="notice"><strong>${e(pub.activity.title)}</strong><p>${e(pub.activity.instruction)}</p></div>${field("활동 날짜", "date", f?.date || today(), { required: true, type: "date" })}${select("어떻게 해봤나요?", "result", Object.entries(resultLabels), f?.result || "done")}${field("아이의 반응", "reaction", f?.reaction || "", { required: true, type: "textarea", max: 1000, placeholder: "좋아했던 점이나 평소와 달랐던 모습을 알려주세요." })}${field("어려웠던 점·궁금한 점", "difficulty", f?.difficulty || "", { type: "textarea", max: 1000 })}`,
      "feedback",
      { childId, publicationId: pub.id, id: f?.id || "", ...(f ? { expectedVersion: f.version ?? feedbackVersion(f) } : {}) },
      "경험 전달하기",
    );
    mountAttachments(f?.attachments);
  }
  if (action === "review") {
    const f = p.feedback.find((f) => f.id === id);
    if (!f) return;
    openForm(
      "다음 회기에 이어가기",
      `<div class="notice"><p>${e(f.reaction)}</p>${f.difficulty ? `<p>어려웠던 점 · ${e(f.difficulty)}</p>` : ""}</div>${field("다음 회기에 반영할 내용", "reviewNote", f.reviewNote || "", { required: true, type: "textarea", hint: "치료사 내부 메모로 저장돼요. 아동의 다음 기록을 작성할 때 참고할 수 있어요." })}`,
      "review",
      { id, childId, expectedVersion: feedbackVersion(f) },
      "확인하고 저장",
    );
    dialog
      .querySelector(".notice")
      .insertAdjacentHTML("beforeend", mediaGallery(f.attachments));
    dialogMedia.hydrate(dialog);
  }
  if (action === "relationships") {
    if (account !== "center") return;
    const child = db.children.find((c) => c.id === id);
    if (!child) return;
    const historyOptions = [["default", "기본 범위 유지"], ["all", "과거도 추가 공개"]];
    const guardianOptions = GUARDIANS.map(
      (guardian) =>
        `<div><label class="relationship-option"><input type="checkbox" name="guardianIds" value="${e(guardian.id)}" ${child.guardianIds.includes(guardian.id) ? "checked" : ""}><span><strong>${e(memberName(db, guardian.id))}</strong><small>${child.guardianIds.includes(guardian.id) ? "연결 유지 · 기존 범위 유지" : "새 연결 · 이후 소식부터"}</small></span></label>${select(`${memberName(db, guardian.id)} 열람 범위`, `history-${guardian.id}`, historyOptions, "default")}</div>`,
    ).join("");
    openForm(
      "담당 관계 관리",
      `<p class="notice">${e(child.name)}의 새 연결·재연결은 이후 소식부터, 유지 중인 관계는 기존 범위 그대로 보여요.</p>${select(
        "담당 치료사",
        "therapistId",
        THERAPISTS.map((therapist) => [therapist.id, memberName(db, therapist.id)]),
        child.therapistId,
      )}${select("선택한 치료사 열람 범위", "therapistHistory", historyOptions, "default")}<fieldset class="relationship-options"><legend>연결할 보호자</legend>${guardianOptions}</fieldset><label class="relationship-confirm"><input type="checkbox" name="historyConfirmed"><span><strong>기존 기록 열람 범위를 확인했어요.</strong><small>신규·재연결은 저장 이후 소식부터 보여요. 유지 중인 관계는 기존 범위를 유지하며, 연결 해제 시 새 조회가 차단돼요.</small></span></label><label class="relationship-confirm"><input type="checkbox" name="pastHistoryConfirmed"><span><strong>‘과거도 추가 공개’를 선택한 구성원에게 기존 기록·대화를 공개할 것을 별도로 확인했어요.</strong><small>기본 연결에는 체크하지 않아도 돼요. 기존 원본·답변·첨부는 삭제하지 않아요.</small></span></label><p class="footnote">현재는 이 브라우저의 가상 자료 체험이에요. 실제 계정·다른 기기 전달은 아직 연결하지 않았어요.</p>`,
      "relationships",
      { childId: child.id },
      "관계 저장",
    );
    return;
  }
  if (action === "appointment") {
    const a = db.appointments.find((a) => a.id === id) || {};
    const targetChild = a.childId || childId;
    openForm(
      id ? "일정 수정" : "새 일정",
      `${select(
        "아동",
        "childId",
        p.children.map((c) => [
          c.id,
          `${c.name} · ${demoMember(db, c.therapistId)?.name || ""}`,
        ]),
        targetChild,
      )}${field("일정 이름", "title", a.title || "물리치료", { required: true, max: 100 })}<div class="form-grid">${field("날짜", "date", a.date || scheduleDate, { required: true, type: "date" })}${field("시작 시간", "time", a.time || "10:00", { required: true, type: "time" })}${field("진행 시간 (분)", "duration", a.duration || 40, { required: true, type: "number", min: 10 })}${field("장소", "room", a.room || "1번 치료실", { required: true, max: 60 })}</div>${select("상태", "status", Object.entries(statusLabels), a.status || "scheduled")}${id ? '<p class="footnote">기존 일정의 아동은 변경할 수 없습니다. 일정은 아동의 현재 담당 치료사와 연결됩니다.</p>' : ""}`,
      "appointment",
      { id },
    );
    if (id) dialog.querySelector("[name=childId]").disabled = true;
    dialog._meta.childId = targetChild;
  }
  if (action === "child-profile") {
    if (account !== "center") return;
    const child = db.children.find((c) => c.id === id);
    if (!child) return;
    openForm("아동 기본정보 수정", `${childProfileEditor(child)}<p class="footnote">이름·연령만 수정해요. 담당 관계와 기록·대화·사진·동영상은 유지돼요. 가족 관심사는 보호자가 별도로 작성해요.</p>`, "child-profile", { childId: child.id }, "기본정보 저장");
    return;
  }
  if (action === "child")
    openForm(
      "새 아동 등록",
      `${childProfileEditor()}${select(
        "담당 치료사",
        "therapistId",
        THERAPISTS.map((t) => [t.id, memberName(db, t.id)]),
        "t1",
      )}<p class="notice">데모에서는 가상 정보만 입력해 주세요. 새 아동의 보호자 초대·계정 연결은 후속 개발 범위입니다.</p>`,
      "child",
      {},
      "아동 등록",
    );
  if (action === "about") {
    openForm(
      "프로토타입 안내",
      `<p>Carebridge는 아동 중심의 업무 흐름을 체험하는 로컬 앱입니다.</p><h3>체험 순서</h3><ol><li>치료사: 목표 확인 → 기록 작성 → 공유 미리보기</li><li>보호자: 공유 기록 확인 → 가정 활동 경험 전달</li><li>치료사: 피드백 확인 → 다음 회기와 목표에 반영</li><li>센터: 아동 등록 → 일정과 출결 관리</li></ol><h3>저장과 접근</h3><p>데이터는 이 브라우저의 로컬 저장소에 유지됩니다. 역할 전환은 실제 로그인이 아니며 운영용 접근 통제를 제공하지 않습니다. 실제 개인정보는 입력하지 마세요.</p><p>브라우저 데이터 삭제 시 기록이 사라집니다. 다른 브라우저·기기와 자동 동기화되지 않습니다.</p><h3>사진·동영상</h3><p>세션 기록과 가정 활동 피드백에 첨부할 수 있습니다. 파일은 IndexedDB에 보관되며 서버에 업로드되지 않습니다. 세션 첨부는 파일별 공유 선택 후 공유 미리보기에서 확인하세요. 첨부 제거는 현재 기록에서만 적용되며 기존 공유본의 원본은 보존됩니다.</p><h3>후속 기능</h3><p>수납·바우처·정산, 실시간 채팅, 알림, AI 요약은 현재 제공하지 않습니다. 카메라 측정과 자동 치료계획은 별도 검증이 필요합니다.</p>`,
      "about",
      {},
      "확인",
    );
  }
}
function navigate(next) {
  view = next;
  filter = "all";
  safeRender();
  document.querySelector("#main")?.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
function closeDialog() {
  if (saving) return;
  if (dirty && !window.confirm("저장하지 않은 입력을 닫을까요?")) return;
  dialog.close();
  dirty = false;
}
async function commit(action, input, entries = [], author = actor()) {
  if (!db) throw new Error(loadError || "저장된 데이터를 다시 확인해 주세요. 입력을 유지했어요.");
  assertRevision(storage, db.revision);
  await saveWithMedia(mediaStore, entries, () => {
    const next = mutate(db, author, action, input);
    persist(storage, next, db.revision);
    db = next;
  });
}
document.addEventListener("click", (event) => {
  const target = event.target.closest("button[data-action], a[data-action]");
  if (!target) return;
  event.preventDefault();
  const { action, id } = target.dataset;
  if (chat.sending || chat.editor?.busy) {
    flash("소식과 첨부를 확인하고 있어요. 완료될 때까지 기다려 주세요.");
    return;
  }
  if (action === "add-assessment") {
    const rows = dialog.querySelector("#assessment-rows");
    if (rows.children.length >= 20) {
      flash("측정값은 20개까지 추가할 수 있어요.");
      return;
    }
    rows.insertAdjacentHTML("beforeend", assessmentRow({}, rows.children.length));
    reindexAssessmentRows(rows);
    rows.lastElementChild.querySelector("input").focus();
    dirty = true;
    return;
  }
  if (action === "remove-assessment") {
    const row = target.closest("[data-assessment]");
    const rows = row.parentElement;
    const nearbyRow = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    reindexAssessmentRows(rows);
    (nearbyRow?.querySelector("input") || dialog.querySelector('[data-action="add-assessment"]')).focus();
    dirty = true;
    return;
  }
  if (action === "record-template") {
    if (
      dirty &&
      !confirm(
        "현재 입력 대신 이전 목표와 측정 항목만 가져올까요? 관찰 결과와 측정값은 가져오지 않습니다.",
      )
    )
      return;
    recordForm(
      "",
      dialog._meta.appointmentId,
      dialog._meta.referenceMessageIds?.[0],
      id,
    );
    dirty = true;
    return;
  }
  if (action === "view-reference" || action === "view-reference-media") {
    // A still-open editor may contain an old relationship after another tab
    // changes the workspace. Keep unsaved inputs, but do not open more files.
    try {
      assertRevision(storage, db.revision);
    } catch {
      pendingWorkspaceChange = true;
      if (dialog.open) showWorkspaceChange();
      else refreshWorkspace();
      flash("저장된 자료가 변경됐어요. 창을 닫고 최신 내용을 확인해 주세요.");
      return;
    }
  }
  if (action === "view-reference-media") {
    const files = recordReferenceMedia(db, actor(), id, target.dataset.reference);
    const panel = target.closest(".reference-attachments")?.querySelector(".reference-media");
    if (!files || !panel) return;
    const opening = panel.hidden;
    panel.innerHTML = opening ? `<p class="footnote">기록 당시 첨부 · 치료사 내부 참고이며 보호자 공유에 자동 포함되지 않아요.</p>${mediaGallery(files)}` : "";
    panel.hidden = !opening;
    target.setAttribute("aria-expanded", String(opening));
    target.textContent = opening ? "당시 사진·영상 닫기" : `당시 사진·영상 ${files.length}개 보기`;
    if (dialog.contains(target)) dialogMedia.hydrate(dialog.querySelector(".record-references"));
    else pageMedia.hydrate(app);
    return;
  }
  if (action === "view-reference") {
    const m = conversationView(db, actor(), childId).messages.find(
      (m) => m.id === id,
    );
    if (!m) return;
    const note = target.closest(".reference-note");
    if (!note.querySelector(".reference-original"))
      note.insertAdjacentHTML(
        "beforeend",
        `<div class="reference-original"><time>${e(m.createdAt)}</time><p>${e(m.body)}</p>${mediaGallery(m.attachments)}</div>`,
      );
    dialogMedia.hydrate(dialog.querySelector(".record-references"));
    return;
  }
  if (action === "start-chat" || action === "open-chat") {
    if (action === "open-chat") childId = id;
    chatOpened = action === "open-chat" || account === "guardian";
    chatTarget = target.dataset.message || "";
    view = "chat";
    safeRender();
    return;
  }
  if (action === "chat-list") {
    chatOpened = false;
    safeRender();
    return;
  }
  if (action === "reply-message" || action === "cancel-reply") {
    chat.reply(action === "cancel-reply" ? "" : id);
    return;
  }
  if (action === "jump-message") {
    chat.jump(id);
    return;
  }
  if (action === "chat-attachments") {
    const files = document.querySelector("#chat-files");
    files.open = true;
    files.querySelector("input[type=file]").click();
    return;
  }
  if (action === "reference-message") {
    recordForm("", "", id);
    return;
  }
  if (action === "open-draft") {
    childId = db.records.find((r) => r.id === id).childId;
    recordForm(id);
    return;
  }
  if (action === "reload") {
    location.reload();
    return;
  }
  if (!db) return;
  if (action === "nav") {
    navigate(id);
    return;
  }
  if (action === "close") {
    closeDialog();
    return;
  }
  if (action === "to-activities") {
    navigate("activities");
    return;
  }
  if (action === "select-child") {
    childId = id;
    safeRender();
    return;
  }
  if (action === "day") {
    const d = new Date(`${scheduleDate}T12:00:00`);
    d.setDate(d.getDate() + Number(id));
    scheduleDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    safeRender();
    return;
  }
  if (action === "today") {
    scheduleDate = today();
    safeRender();
    return;
  }
  if (action === "session-record") {
    const a = db.appointments.find((a) => a.id === id);
    if (!a) return;
    childId = a.childId;
    const r = db.records.find((r) => r.appointmentId === id);
    recordForm(r?.id || "", id);
    return;
  }
  try {
    openAction(action, id);
  } catch {
    flash("이 항목을 열 수 없어요. 현재 화면과 역할을 확인해 주세요.");
  }
});
document.addEventListener("change", (event) => {
  const t = event.target;
  if (t.id === "role") {
    if (chat.sending || chat.editor?.busy) {
      t.value = account;
      flash("저장·첨부 확인 후 역할을 전환해 주세요.");
      return;
    }
    account = t.value;
    chatOpened = false;
    view = "home";
    query = "";
    filter = "all";
    safeRender();
  }
  if (t.id === "child") {
    childId = t.value;
    filter = "all";
    safeRender();
  }
  if (t.id === "goal-filter") {
    filter = t.value;
    safeRender();
  }
  if (t.id === "schedule-date" && t.value) {
    scheduleDate = t.value;
    safeRender();
  }
  if (t.dataset.toggle) {
    const fields = document.getElementById(t.dataset.toggle);
    fields.hidden = !t.checked;
    fields.disabled = !t.checked;
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "child-search") {
    query = event.target.value;
    const start = event.target.selectionStart;
    safeRender();
    const input = document.querySelector("#child-search");
    input.focus();
    input.setSelectionRange(start, start);
  }
  if (dialog.contains(event.target)) dirty = true;
});
dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDialog();
});
dialog.addEventListener("close", () => {
  // close is queued: record → share-preview can reopen this same dialog
  // before the previous close event runs. openForm already disposed the old
  // editor, so a late event must not cancel the new preview's hydration.
  if (!dialog.open) {
    disposeDialogMedia();
    // Even a missed/late storage event cannot leave an old workspace visible
    // after the user explicitly closes the editor. Never rebase live inputs.
    refreshWorkspace();
    dialog.querySelector("[data-workspace-change]")?.remove();
  }
});
dialog.addEventListener("close", () => {
  if (dialog.open || dialog.dataset.action !== "member-profile") return;
  dialog.replaceChildren();
  const target = dialog._profileReturnFocus?.isConnected ? dialog._profileReturnFocus : app.querySelector('[data-action="member-profile"]');
  target?.focus({ preventScroll: true });
  dialog._profileActor = dialog._profileReturnFocus = null;
});
dialog.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving) return;
  if (attachmentEditor?.busy) {
    flash("파일 확인이 끝난 뒤 저장해 주세요.");
    return;
  }
  const action = dialog.dataset.action;
  if (action === "about") {
    dialog.close();
    return;
  }
  const form = event.target;
  const intent = event.submitter?.value || "saved";
  if (intent === "draft") {
    // Number inputs expose an empty value for unfinished text such as '-'.
    // Preserve that editor state instead of silently saving it as missing.
    const invalidNumber = [...form.querySelectorAll('[data-assessment] input[type="number"]')]
      .find((control) => control.validity.badInput);
    if (invalidNumber) { invalidNumber.reportValidity(); return; }
  }
  if (intent !== "draft" && !form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  const input = { ...dialog._meta, ...values };
  if (action === "record")
    Object.assign(input, parseRecordForm(form), {
      status: intent === "draft" ? "draft" : "saved",
    });
  if (action === "relationships")
    Object.assign(input, {
      guardianIds: [...form.querySelectorAll('[name="guardianIds"]:checked')].map(
        (control) => control.value,
      ),
      historyConfirmed: form.elements.historyConfirmed.checked,
      pastHistoryConfirmed: form.elements.pastHistoryConfirmed.checked,
      historyChoices: Object.fromEntries([
        [form.elements.therapistId.value, form.elements.therapistHistory.value],
        ...[...form.querySelectorAll('[name="guardianIds"]:checked')].map((control) =>
          [control.value, form.elements[`history-${control.value}`].value]),
      ]),
    });
  if (action === "message-delete") input.confirmed = form.elements.confirmed.checked;
  if (attachmentEditor) input.attachments = attachmentEditor.metadata();
  const entries = attachmentEditor?.entries() || [];
  const controls = [
    ...form.querySelectorAll("input, select, textarea, button"),
  ].map((control) => [control, control.disabled]);
  saving = true;
  controls.forEach(([control]) => {
    control.disabled = true;
  });
  form.setAttribute("aria-busy", "true");
  try {
    if (["message-edit", "message-delete"].includes(action)) {
      const owner = dialog._messageActor;
      if (!owner || owner.id !== actor().id || owner.role !== actor().role)
        throw new Error("체험 계정이 변경됐어요. 소식을 다시 열어 주세요.");
    }
    if (action === "member-profile") {
      const owner = dialog._profileActor;
      if (!owner || owner.id !== actor().id || owner.role !== actor().role)
        throw new Error("체험 계정이 변경됐어요. 입력을 보관하고 이름 설정을 다시 열어 주세요.");
      input.displayName = memberDisplayNameForm(values.displayName);
    }
    if (["child", "child-profile"].includes(action)) Object.assign(input, childProfileFormValues(values));
    await commit(action, input, entries);
    dirty = false;
    dialog.close();
    if (action === "record" || action === "publish" || action === "unpublish")
      view = "records";
    if (
      action === "feedback" ||
      action === "review" ||
      action === "message-review" || action === "message-edit" || action === "message-delete"
    ) {
      view = "chat";
      chatOpened = true;
    }
    if (action === "child") {
      childId = db.children.at(-1).id;
      view = "children";
    }
    if (action === "appointment") {
      childId = input.childId;
      scheduleDate = input.date;
      view = "schedule";
    }
    safeRender();
    if (["message-edit", "message-delete"].includes(action)) {
      document.querySelector(".chat-log")?.focus({ preventScroll: true });
      chat.jump(input.id, false);
    }
    if (action === "record" && intent === "share")
      openAction("preview", input.id || db.records.at(-1).id);
    flash(
      {
        publish: "보호자 화면에 공유했어요.",
        unpublish: "공유를 철회했어요.",
        feedback: "활동 경험을 전달했어요.",
        review: "다음 회기 반영 메모를 저장했어요.",
        "member-profile": "이 브라우저의 표시 이름을 저장했어요.",
      }[action] || "저장했어요.",
    );
  } catch (error) {
    const box = document.querySelector("#form-error");
    box.textContent = error.message;
    box.hidden = false;
    box.focus();
  } finally {
    saving = false;
    controls.forEach(([control, disabled]) => {
      control.disabled = disabled;
    });
    form.removeAttribute("aria-busy");
  }
});
function showWorkspaceChange() {
  const references = dialog.querySelector(".record-references");
  if (references) {
    // Revoke only read-only previews, not the separate pending attachment
    // editor. Late IndexedDB reads cannot reopen files after access changes.
    dialogMedia.clear();
    references.querySelectorAll(".reference-media").forEach((panel) => {
      panel.replaceChildren();
      panel.hidden = true;
    });
    references.querySelectorAll(".reference-original").forEach((preview) => preview.remove());
    references.querySelectorAll("button").forEach((control) => {
      control.disabled = true;
      if (control.hasAttribute("aria-expanded")) control.setAttribute("aria-expanded", "false");
    });
  }
  const body = dialog.querySelector(".dialog-body");
  if (!body || body.querySelector("[data-workspace-change]")) return;
  const notice = document.createElement("p");
  notice.className = "notice";
  notice.dataset.workspaceChange = "";
  notice.setAttribute("role", "status");
  notice.textContent = "다른 탭에서 데이터가 변경됐어요. 입력과 첨부는 유지되지만 이 창에서는 저장할 수 없어요. 필요한 입력을 보관한 뒤 닫으면 최신 내용을 반영해요.";
  body.prepend(notice);
}
function refreshWorkspace() {
  if (dialog.open) return;
  // Retain this guard across an error state: a later clear event must not
  // bootstrap sample records just because the current db is now null.
  requireStoredWorkspace ||= db?.revision > 0;
  const newer = load(storage, { requireExisting: requireStoredWorkspace });
  requireStoredWorkspace ||= Boolean(newer.error);
  const changed = pendingWorkspaceChange || !newer.db || newer.db.revision !== db?.revision;
  pendingWorkspaceChange = false;
  if (!changed) return;
  db = newer.db;
  loadError = newer.error;
  safeRender();
  if (db) flash("다른 탭의 변경을 반영했어요.");
}
window.addEventListener("storage", (event) => {
  if (event.storageArea !== storage || (event.key !== STORAGE_KEY && event.key !== null)) return;
  if (dialog.open) {
    pendingWorkspaceChange = true;
    showWorkspaceChange();
    flash(
      "다른 탭에서 데이터가 변경됐어요. 현재 입력은 유지했어요.",
    );
    return;
  }
  refreshWorkspace();
});
window.addEventListener("beforeunload", (event) => {
  if (
    dirty ||
    chat.sending ||
    chat.editor?.busy ||
    chat.drafts.failed ||
    chat.drafts.pendingCount
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
safeRender();
