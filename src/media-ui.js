import { escape as e } from "./ui.js";
import {
  MEDIA_TYPES,
  MEDIA_LIMITS,
  MEDIA_HELP,
  inspectFile,
  normalizeAttachments,
  fileSize,
} from "./media-policy.js";
export function mediaGallery(items = [], withScope = false) {
  return items.length
    ? `<div class="media-gallery">${items.map((m) => `<figure class="media-item"><div class="media-preview" data-media-id="${e(m.id)}" data-type="${e(m.type)}" data-size="${m.size}" data-name="${e(m.name)}"><span class="media-status">첨부파일 불러오는 중…</span></div><figcaption><span class="media-name">${e(m.name)}</span><small>${fileSize(m.size)}${withScope ? ` · ${m.share ? "보호자 공유 선택" : "치료사만 보기"}` : ""}</small></figcaption></figure>`).join("")}</div>`
    : "";
}
export class MediaView {
  constructor(store) {
    this.store = store;
    this.urls = [];
    this.generation = 0;
  }
  clear() {
    this.generation++;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
  }
  async hydrate(root, pending = new Map()) {
    this.clear();
    const generation = this.generation;
    await Promise.all(
      [...root.querySelectorAll("[data-media-id]")].map(async (slot) => {
        try {
          const blob =
            pending.get(slot.dataset.mediaId) ||
            (await this.store.read(slot.dataset.mediaId));
          if (generation !== this.generation || !slot.isConnected) return;
          if (
            !blob ||
            blob.type !== slot.dataset.type ||
            blob.size !== Number(slot.dataset.size)
          )
            throw new Error(
              "이 브라우저에서 원본을 찾지 못했어요. 파일을 다시 첨부해 주세요.",
            );
          const url = URL.createObjectURL(blob);
          this.urls.push(url);
          const element = document.createElement(
            blob.type.startsWith("image/") ? "img" : "video",
          );
          element.src = url;
          if (element.tagName === "IMG") {
            element.alt = slot.dataset.name;
            element.loading = "lazy";
          } else {
            element.controls = true;
            element.preload = "metadata";
            element.playsInline = true;
            element.setAttribute("aria-label", slot.dataset.name);
          }
          const errorMessage = () => {
            const note = document.createElement("span");
            note.className = "media-status";
            note.textContent =
              "이 브라우저에서 미리볼 수 없는 파일이에요. 원본을 내려받아 확인해 주세요.";
            element.replaceWith(note);
          };
          element.addEventListener("error", errorMessage, { once: true });
          const download = document.createElement("a");
          download.href = url;
          download.download = slot.dataset.name;
          download.textContent = "원본 다운로드";
          download.className = "media-download";
          slot.replaceChildren(element, download);
        } catch (error) {
          if (generation === this.generation && slot.isConnected) {
            slot.replaceChildren();
            const note = document.createElement("span");
            note.className = "media-status";
            note.textContent = error.message;
            slot.append(note);
          }
        }
      }),
    );
  }
}
export class AttachmentEditor {
  constructor(
    root,
    items,
    store,
    { sharing = false, onChange = () => {} } = {},
  ) {
    this.root = root;
    this.items = normalizeAttachments(items);
    this.store = store;
    this.pending = new Map();
    this.view = new MediaView(store);
    this.sharing = sharing;
    this.onChange = onChange;
    this.busy = false;
    this.closed = false;
    root.innerHTML = `<section class="attachment-editor" aria-label="사진과 동영상 첨부"><h3>사진·동영상</h3><p class="footnote">${MEDIA_HELP}</p><label class="file-picker"><span>사진·동영상 선택</span><input type="file" multiple accept="${MEDIA_TYPES.join(",")}" aria-label="사진·동영상 선택"></label><p class="attachment-message" role="status" aria-live="polite"></p><div class="attachment-list"></div><p class="footnote">${sharing ? "기본은 치료사만 보기예요. 공유할 파일을 선택하고 기록의 공유 미리보기에서 확인해 주세요." : "첨부한 파일은 이 피드백과 함께 담당 치료사에게 전달돼요."} 파일은 이 브라우저에만 저장됩니다.</p></section>`;
    root
      .querySelector("input[type=file]")
      .addEventListener("change", (event) => this.select(event));
    root.addEventListener("click", (event) => {
      const target = event.target.closest("[data-remove-media]");
      if (!target) return;
      const id = target.dataset.removeMedia;
      this.items = this.items.filter((x) => x.id !== id);
      this.pending.delete(id);
      this.onChange();
      this.draw();
      root.querySelector("input[type=file]").focus();
    });
    root.addEventListener("change", (event) => {
      const id = event.target.dataset.shareMedia;
      if (!id) return;
      this.items.find((x) => x.id === id).share = event.target.checked;
      this.onChange();
    });
    this.draw();
  }
  draw() {
    const list = this.root.querySelector(".attachment-list");
    list.innerHTML = this.items
      .map(
        (m) =>
          `<div class="attachment-row">${mediaGallery([m])}<div class="attachment-options">${this.sharing ? `<label><input type="checkbox" data-share-media="${m.id}" ${m.share ? "checked" : ""}> 보호자에게 공유 <span class="sr-only">${e(m.name)}</span></label>` : ""}<button type="button" class="button text" data-remove-media="${m.id}" aria-label="${e(m.name)} 첨부 제거">제거</button></div></div>`,
      )
      .join("");
    this.view.hydrate(list, this.pending);
  }
  async select(event) {
    const files = [...event.target.files];
    event.target.value = "";
    if (!files.length || this.busy) return;
    const message = this.root.querySelector(".attachment-message");
    this.busy = true;
    event.target.disabled = true;
    message.textContent = "파일을 확인하고 있어요…";
    try {
      if (this.items.length + files.length > MEDIA_LIMITS.count)
        throw new Error(
          `첨부파일은 최대 ${MEDIA_LIMITS.count}개까지 선택할 수 있어요.`,
        );
      if (
        this.items.reduce((n, x) => n + x.size, 0) +
          files.reduce((n, x) => n + x.size, 0) >
        MEDIA_LIMITS.total
      )
        throw new Error("첨부파일 합계는 100MB 이하여야 합니다.");
      const additions = [];
      for (const file of files)
        additions.push({ ...(await inspectFile(file)), share: !this.sharing });
      if (this.closed) return;
      this.items.push(...additions);
      additions.forEach((m, i) => this.pending.set(m.id, files[i]));
      this.onChange();
      this.draw();
      message.textContent = `${files.length}개 파일을 선택했어요. 기록을 저장하면 함께 보관됩니다.`;
    } catch (error) {
      if (!this.closed) message.textContent = error.message;
    } finally {
      this.busy = false;
      if (!this.closed) event.target.disabled = false;
    }
  }
  metadata() {
    return normalizeAttachments(this.items);
  }
  entries() {
    return [...this.pending.entries()];
  }
  dispose() {
    this.closed = true;
    this.view.clear();
    this.pending.clear();
  }
}
