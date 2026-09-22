import { attachmentListValid } from "./media-policy.js";
// Separate draft database: sent attachments remain immutable. Tab-scoped keys
// prevent other open tabs from overwriting unfinished messages.
export class ChatDrafts {
  constructor() {
    this.memory = new Map();
    this.pending = Promise.resolve();
    this.failedKeys = new Set();
    this.pendingCount = 0;
    try {
      this.tabId =
        sessionStorage.getItem("carebridge-draft-tab") || crypto.randomUUID();
      sessionStorage.setItem("carebridge-draft-tab", this.tabId);
    } catch {
      this.tabId = crypto.randomUUID();
    }
  }
  async open() {
    if (!this.connection)
      this.connection = new Promise((resolve, reject) => {
        const r = indexedDB.open("carebridge-chat-drafts-v1", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("drafts");
        r.onsuccess = () => resolve(r.result);
        r.onerror = r.onblocked = () =>
          reject(new Error("작성 중인 소식을 임시 저장하지 못했어요."));
      }).catch((error) => {
        this.connection = null;
        throw error;
      });
    return this.connection;
  }
  key(actorId, childId) {
    return `${this.tabId}/${actorId}/${childId}`;
  }
  get failed() {
    return this.failedKeys.size > 0;
  }
  empty() {
    return {
      clientId: crypto.randomUUID(),
      body: "",
      replyTo: null,
      attachments: [],
      entries: [],
    };
  }
  async read(key) {
    if (this.memory.has(key)) return this.memory.get(key);
    const db = await this.open();
    const saved = await new Promise((resolve, reject) => {
      const r = db.transaction("drafts").objectStore("drafts").get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () =>
        reject(new Error("작성 중인 소식을 불러오지 못했어요."));
    });
    if (
      saved &&
      (!/^[a-zA-Z0-9-]{8,100}$/.test(saved.clientId) ||
        typeof saved.body !== "string" ||
        saved.body.length > 2000 ||
        !attachmentListValid(saved.attachments) ||
        !Array.isArray(saved.entries) ||
        !saved.entries.every(
          ([id, blob]) =>
            blob instanceof Blob &&
            saved.attachments.some(
              (a) =>
                a.id === id && a.type === blob.type && a.size === blob.size,
            ),
        ))
    )
      throw new Error(
        "임시 저장된 소식의 형식을 확인하지 못했어요. 기존 내용은 덮어쓰지 않았습니다.",
      );
    if (!this.memory.has(key)) this.memory.set(key, saved || this.empty());
    return this.memory.get(key);
  }
  save(key, draft) {
    this.memory.set(key, draft);
    this.pendingCount++;
    const copy = structuredClone(draft);
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        const db = await this.open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("drafts", "readwrite");
          tx.objectStore("drafts").put(copy, key);
          tx.oncomplete = resolve;
          tx.onabort = () =>
            reject(
              new Error(
                "임시 저장에 실패했어요. 닫기 전에 보내기를 다시 시도해 주세요.",
              ),
            );
        });
        this.failedKeys.delete(key);
      });
    this.pending = operation;
    return operation
      .catch((error) => {
        this.failedKeys.add(key);
        throw error;
      })
      .finally(() => {
        this.pendingCount--;
      });
  }
}
