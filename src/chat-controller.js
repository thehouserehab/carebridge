import { ChatDrafts } from "./chat-drafts.js";
import { AttachmentEditor } from "./media-ui.js";
import { conversationView } from "./conversations.js";
import { escape as e, button } from "./ui.js";
import { messagePreview } from "./message-preview.js";

export class ChatController {
  constructor({ getState, commit, render, read, mediaStore }) {
    Object.assign(this, { getState, commit, render, read, mediaStore });
    this.drafts = new ChatDrafts({ onStatus: (key, status) => {
      if (key === this.key && this.form) this.draftStatus(status);
    } });
    this.generation = 0;
    this.sending = false;
    this.activeSend = null;
    this.sendErrors = new Map();
    this.formLocks = new WeakMap();
  }
  stop() {
    this.generation++;
    if (this.form && this.draft) this.capture();
    this.observer?.disconnect();
    this.editor?.dispose();
    this.editor = null;
    this.form = null;
    this.draft = null;
  }
  async mount(targetId = "") {
    const generation = this.generation;
    this.form = document.querySelector("#chat-compose");
    if (!this.form) return;
    const state = this.getState();
    this.context = { actor: state.actor, childId: state.childId };
    this.key = this.drafts.key(state.actor.id, state.childId);
    this.form.querySelector("#draft-retry").addEventListener("click", () => {
      if (this.sending) return;
      this.capture();
      this.form.querySelector("textarea").focus();
    });
    this.form.querySelector("#draft-reload").addEventListener("click", () => this.render());
    try {
      const draft = await this.drafts.read(this.key);
      if (generation !== this.generation) return;
      this.draft = draft;
      // A successful send followed by a failed draft cleanup must not resend.
      if (
        state.db.messages.some(
          (m) => m.id === draft.clientId && m.authorId === state.actor.id && m.childId === state.childId,
        )
      ) {
        await this.drafts.clearSent(this.key, draft.clientId).catch(() => {});
        if (generation !== this.generation) return;
        this.draft = this.drafts.memory.get(this.key);
      }
    } catch {
      if (generation !== this.generation) return;
      this.draftStatus("unavailable");
      return;
    }
    const textarea = this.form.querySelector("textarea");
    textarea.value = this.draft.body;
    this.form
      .querySelectorAll("textarea, button[type=submit]")
      .forEach((el) => {
        el.disabled = false;
      });
    this.editor = new AttachmentEditor(
      this.form.querySelector("#chat-attachment-editor"),
      this.draft.attachments,
      this.mediaStore,
      { pending: this.draft.entries, onChange: () => this.capture() },
    );
    this.form.querySelector(
      ".attachment-editor > .footnote:last-child",
    ).textContent =
      "보내면 이 대화의 보호자와 담당 치료사가 볼 수 있어요. 파일은 이 브라우저에만 저장됩니다.";
    this.form.querySelector("#chat-files").open =
      !!this.draft.attachments.length;
    this.quote();
    this.draftStatus(this.drafts.status(this.key));
    const sendError = this.sendErrors.get(this.key);
    this.error(sendError?.clientId === this.draft.clientId ? sendError.message : "");
    // A storage event can replace the form while its send is still pending.
    if (this.activeSend?.key === this.key) this.lockForm(this.form);
    textarea.addEventListener("input", () => this.capture());
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.send();
    });
    const log = document.querySelector(".chat-log");
    if (targetId) this.jump(targetId, false);
    else log.scrollTop = log.scrollHeight;
    // Read only actually displayed messages, never every conversation on home.
    this.observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => entry.target.dataset.messageId);
        if (
          generation !== this.generation ||
          !visible.length ||
          document.visibilityState !== "visible"
        )
          return;
        const state = this.getState();
        const rows = conversationView(
          state.db,
          this.context.actor,
          this.context.childId,
        ).messages;
        const last = rows.filter((m) => visible.includes(m.id)).at(-1);
        if (last) {
          try {
            this.read(this.context, last.id);
          } catch (error) {
            this.error(error.message);
          }
        }
      },
      { root: log, threshold: 0.1 },
    );
    log
      .querySelectorAll("[data-message-id]")
      .forEach((el) => this.observer.observe(el));
  }
  capture() {
    if (!this.form || !this.draft) return;
    Object.assign(this.draft, {
      body: this.form.querySelector("textarea").value,
      attachments: this.editor?.metadata() || this.draft.attachments,
      entries: this.editor?.entries() || this.draft.entries,
    });
    return this.drafts.save(this.key, this.draft).catch(() => {});
  }
  draftStatus(phase) {
    const status = this.form?.querySelector("#draft-status");
    if (!status) return;
    status.dataset.state = phase;
    const cannotRestore = !this.drafts.tabPersistent && phase === "saved";
    status.textContent = cannotRestore ? "새로고침하면 복원이 어려워요" : {
      loading: "초안 불러오는 중…", empty: "아직 작성한 소식이 없어요", saving: "초안 저장 중…",
      saved: "이 브라우저에 초안 저장됨", failed: "초안 저장 실패", unavailable: "초안 확인 필요",
    }[phase];
    this.form.querySelector("#draft-retry").hidden = phase !== "failed";
    this.form.querySelector("#draft-reload").hidden = phase !== "unavailable";
    const error = this.form.querySelector("#draft-error");
    error.hidden = !cannotRestore && !["failed", "unavailable"].includes(phase);
    error.textContent = phase === "failed"
      ? "입력은 이 탭에 유지돼요. 닫거나 새로고침하기 전에 초안을 다시 저장해 주세요."
      : phase === "unavailable" ? "기존 초안은 변경하지 않았어요. 다시 불러와 주세요."
      : cannotRestore ? "탭 저장소를 사용할 수 없어 새로고침 후 초안을 찾지 못할 수 있어요. 닫기 전에 소식을 보내거나 필요한 내용을 안전하게 보관해 주세요." : "";
  }
  error(message) {
    const box = this.form?.querySelector("#chat-error");
    if (box) {
      box.hidden = !message;
      box.textContent = message;
    }
  }
  lockForm(form) {
    if (this.formLocks.has(form)) return;
    const controls = [...form.querySelectorAll("button,input,textarea")]
      .map((control) => [control, control.disabled]);
    this.formLocks.set(form, controls);
    controls.forEach(([control]) => { control.disabled = true; });
    form.setAttribute("aria-busy", "true");
  }
  unlockForm(form) {
    const controls = form && this.formLocks.get(form);
    if (!controls) return;
    controls.forEach(([control, disabled]) => { control.disabled = disabled; });
    form.removeAttribute("aria-busy");
    this.formLocks.delete(form);
  }
  quote() {
    if (!this.form || !this.draft) return;
    const state = this.getState();
    const m = conversationView(
      state.db,
      this.context.actor,
      this.context.childId,
    ).messages.find((m) => m.id === this.draft.replyTo);
    this.form.querySelector("#reply-preview").innerHTML = m
      ? `<div class="reply-preview"><span>${!m.canReply ? "삭제되었거나 공유가 종료된 소식" : this.draft.expectedReplyVersion && this.draft.expectedReplyVersion !== m.version ? "원문이 수정됐어요. 연결을 해제하고 다시 선택해 주세요" : `답변할 소식 · ${e(messagePreview(m).slice(0, 120))}`}</span>${button("연결 해제", "cancel-reply", "", "text")}</div>`
      : this.draft.replyTo ? `<div class="reply-preview"><span>열람할 수 없는 소식이에요. 연결을 해제해 주세요.</span>${button("연결 해제", "cancel-reply", "", "text")}</div>` : "";
  }
  reply(id) {
    if (!this.draft) return;
    this.draft.replyTo = id || null;
    const state = this.getState();
    const message = id ? conversationView(state.db, this.context.actor, this.context.childId).messages.find((m) => m.id === id) : null;
    if (["text", "feedback"].includes(message?.type)) this.draft.expectedReplyVersion = message.version;
    else delete this.draft.expectedReplyVersion;
    this.quote();
    this.capture();
    this.form.querySelector("textarea").focus();
  }
  jump(id, focus = true) {
    const target = document.getElementById(`message-${id}`);
    const log = document.querySelector(".chat-log");
    if (!target || !log) return;
    log.scrollTop +=
      target.getBoundingClientRect().top - log.getBoundingClientRect().top - 16;
    target.classList.add("highlight");
    if (focus) target.focus({ preventScroll: true });
  }
  async send() {
    if (this.sending || !this.draft || !this.form) return;
    if (this.editor?.busy) {
      this.error("첨부파일 확인이 끝난 뒤 보내 주세요.");
      return;
    }
    this.capture();
    // Never use mutable current-room state after awaiting media persistence.
    const operation = {
      key: this.key, form: this.form, editor: this.editor,
      actor: structuredClone(this.context.actor),
      input: { childId: this.context.childId, ...structuredClone(this.draft) },
    };
    const { key, form, editor, actor, input } = operation;
    this.activeSend = operation;
    this.sending = true;
    this.sendErrors.delete(key);
    this.error("");
    this.lockForm(form);
    try {
      try {
        await this.commit("message", input, input.entries, actor);
      } catch (error) {
        const message = error?.message || "소식을 보내지 못했어요. 다시 시도해 주세요.";
        this.sendErrors.set(key, { clientId: input.clientId, message });
        if (this.key === key && this.draft?.clientId === input.clientId)
          this.error(message);
        return;
      }
      // Cleanup failure is not a send failure. The sent ID is also checked on
      // mount, so a stale disk draft cannot be offered as a new message.
      await this.drafts.clearSent(key, input.clientId).catch(() => {});
      editor?.dispose();
      const next = this.drafts.memory.get(key);
      if (this.form && this.key === key &&
          this.draft?.clientId === input.clientId && next && next.clientId !== input.clientId) {
        this.draft = next;
        this.form.querySelector("textarea").value = next.body;
        if (this.editor !== editor) this.editor?.dispose();
        this.editor = null;
        this.render(input.clientId);
      }
    } finally {
      this.sending = false;
      this.activeSend = null;
      this.unlockForm(form);
      this.unlockForm(this.form);
    }
  }
}
