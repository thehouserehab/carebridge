import { attachmentListValid } from "./media-policy.js";
const saveError = () => new Error("초안을 저장하지 못했어요. 입력은 이 탭에 유지돼요. 닫기 전에 초안을 다시 저장해 주세요.");
const readError = () => new Error("초안을 불러오지 못했어요. 기존 저장 내용은 변경하지 않았어요. 다시 불러와 주세요.");
export function chatDraftValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["clientId", "body", "replyTo", "expectedReplyVersion", "attachments", "entries"].includes(key)) ||
      typeof value.clientId !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(value.clientId) ||
      typeof value.body !== "string" || value.body.length > 2000 ||
      (value.replyTo != null && (typeof value.replyTo !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.replyTo))) ||
      (value.expectedReplyVersion !== undefined && (!value.replyTo || !Number.isSafeInteger(value.expectedReplyVersion) || value.expectedReplyVersion < 1)) ||
      !Array.isArray(value.attachments) || !attachmentListValid(Array.from(value.attachments)) ||
      !Array.isArray(value.entries) || value.entries.length > value.attachments.length)
    return false;
  const ids = new Set();
  return Array.from(value.entries).every((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [id, blob] = entry;
    if (ids.has(id) || !(blob instanceof Blob) || !value.attachments.some((a) => a.id === id && a.type === blob.type && a.size === blob.size))
      return false;
    ids.add(id);
    return true;
  });
}
// Separate draft database: sent attachments remain immutable. Tab-scoped keys
// prevent other open tabs from overwriting unfinished messages.
export class ChatDrafts {
  constructor(options = {}) {
    this.factory = options.factory;
    this.id = options.id || (() => crypto.randomUUID());
    this.onStatus = options.onStatus || (() => {});
    this.memory = new Map();
    this.states = new Map();
    this.pending = Promise.resolve();
    this.failedKeys = new Set();
    this.pendingCount = 0;
    this.tabPersistent = false;
    try {
      const storage = Object.hasOwn(options, "tabStorage") ? options.tabStorage : globalThis.sessionStorage;
      this.tabId = storage.getItem("carebridge-draft-tab") || this.id();
      storage.setItem("carebridge-draft-tab", this.tabId);
      this.tabPersistent = true;
    } catch {
      this.tabId = this.id();
    }
  }
  async open() {
    if (!this.connection)
      this.connection = new Promise((resolve, reject) => {
        const r = (this.factory ?? globalThis.indexedDB).open("carebridge-chat-drafts-v1", 1);
        let refused = false;
        r.onupgradeneeded = () => r.result.createObjectStore("drafts");
        r.onsuccess = () => {
          if (refused) { r.result.close(); return; }
          r.result.onversionchange = () => { r.result.close(); this.connection = null; };
          resolve(r.result);
        };
        r.onerror = r.onblocked = () => { refused = true; reject(readError()); };
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
    return this.failedKeys.size > 0 || (!this.tabPersistent && [...this.memory.values()].some((draft) =>
      draft.body || draft.replyTo || draft.attachments.length));
  }
  empty() {
    return {
      clientId: this.id(),
      body: "",
      replyTo: null,
      attachments: [],
      entries: [],
    };
  }
  async read(key) {
    if (this.memory.has(key)) return this.memory.get(key);
    try {
      const db = await this.open();
      const saved = await new Promise((resolve, reject) => {
        const tx = db.transaction("drafts"), r = tx.objectStore("drafts").get(key);
        tx.oncomplete = () => resolve(r.result);
        tx.onabort = tx.onerror = () => reject(readError());
      });
      if (saved !== undefined && !chatDraftValid(saved)) throw readError();
      if (!this.memory.has(key)) {
        this.memory.set(key, saved ?? this.empty());
        this.status(key, saved === undefined ? "empty" : "saved");
      }
      return this.memory.get(key);
    } catch {
      if (this.memory.has(key)) return this.memory.get(key);
      this.status(key, "unavailable");
      throw readError();
    }
  }
  status(key, phase) {
    const current = this.states.get(key) || { revision: 0, phase: "loading" };
    if (phase) {
      current.phase = phase;
      this.states.set(key, current);
      // UI notification cannot change the result of a committed transaction.
      try { this.onStatus(key, phase); } catch {}
    }
    return current.phase;
  }
  async clearSent(key, clientId) {
    // Compare before replacing memory or queuing an IndexedDB write. A late
    // send completion must not erase the next draft under the same room key.
    if (this.memory.get(key)?.clientId !== clientId) return false;
    await this.save(key, this.empty());
    return true;
  }
  save(key, draft) {
    const state = this.states.get(key) || { revision: 0 };
    const revision = ++state.revision;
    this.states.set(key, state);
    let copy;
    try {
      if (!chatDraftValid(draft)) throw saveError();
      this.memory.set(key, draft);
      copy = structuredClone(draft);
    } catch {
      this.failedKeys.add(key);
      this.status(key, "failed");
      return Promise.reject(saveError());
    }
    this.status(key, "saving");
    this.pendingCount++;
    const operation = this.pending
      .catch(() => {})
      .then(async () => {
        const db = await this.open();
        await new Promise((resolve, reject) => {
          const tx = db.transaction("drafts", "readwrite");
          tx.oncomplete = resolve;
          tx.onabort = tx.onerror = () => reject(saveError());
          try { tx.objectStore("drafts").put(copy, key); }
          catch { try { tx.abort(); } catch {} reject(saveError()); }
        });
      });
    this.pending = operation;
    return operation.then(() => {
      if (this.states.get(key)?.revision === revision) {
        this.failedKeys.delete(key);
        this.status(key, "saved");
      }
    }).catch(() => {
        if (this.states.get(key)?.revision === revision) {
          this.failedKeys.add(key);
          this.status(key, "failed");
        }
        throw saveError();
      })
      .finally(() => {
        this.pendingCount--;
      });
  }
}
