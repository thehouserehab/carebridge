import { ChatDrafts } from "./chat-drafts.js";
import { AttachmentEditor } from "./media-ui.js";
import { conversationView } from "./conversations.js";
import { escape as e, button } from "./ui.js";

export class ChatController {
  constructor({ getState, commit, render, read, mediaStore }) {
    Object.assign(this, { getState, commit, render, read, mediaStore });
    this.drafts = new ChatDrafts();
    this.generation = 0;
    this.sending = false;
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
    try {
      const draft = await this.drafts.read(this.key);
      if (generation !== this.generation) return;
      this.draft = draft;
      // A successful send followed by a failed draft cleanup must not resend.
      if (
        state.db.messages.some(
          (m) => m.id === draft.clientId && m.authorId === state.actor.id,
        )
      )
        this.draft = this.drafts.empty();
    } catch (error) {
      if (generation !== this.generation) return;
      this.error(error.message + " 다시 불러오려면 대화를 다시 열어 주세요.");
      this.form.querySelector("#draft-status").textContent =
        "임시 저장소 확인 필요";
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
    this.form.querySelector("#draft-status").textContent =
      "이 대화에만 임시 저장";
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
    const form = this.form;
    this.drafts.save(this.key, this.draft).catch((error) => {
      if (form === this.form) this.error(error.message);
    });
  }
  error(message) {
    const box = this.form?.querySelector("#chat-error");
    if (box) {
      box.hidden = false;
      box.textContent = message;
    }
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
      ? `<div class="reply-preview"><span>답변할 소식 · ${e(m.body.slice(0, 120))}</span>${button("연결 해제", "cancel-reply", "", "text")}</div>`
      : "";
  }
  reply(id) {
    if (!this.draft) return;
    this.draft.replyTo = id || null;
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
    if (this.sending || !this.draft) return;
    if (this.editor.busy) {
      this.error("첨부파일 확인이 끝난 뒤 보내 주세요.");
      return;
    }
    this.capture();
    const input = { childId: this.context.childId, ...this.draft };
    const controls = [...this.form.querySelectorAll("button,input,textarea")];
    this.sending = true;
    controls.forEach((el) => {
      el.disabled = true;
    });
    this.form.setAttribute("aria-busy", "true");
    try {
      await this.commit(
        "message",
        input,
        this.draft.entries,
        this.context.actor,
      );
      this.draft = this.drafts.empty();
      this.form.querySelector("textarea").value = "";
      this.editor.dispose();
      this.editor = null;
      await this.drafts.save(this.key, this.draft).catch(() => {});
      this.render(input.clientId);
    } catch (error) {
      this.error(error.message);
    } finally {
      this.sending = false;
      controls.forEach((el) => {
        el.disabled = false;
      });
      this.form?.removeAttribute("aria-busy");
    }
  }
}
