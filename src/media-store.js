// Blob storage is deliberately separate from existing JSON records. No server upload.
export class MediaStore {
  constructor(factory) {
    this.factory = factory;
    this.connection = null;
  }
  async open() {
    if (this.connection) return this.connection;
    this.connection = new Promise((resolve, reject) => {
      let factory;
      try { factory = this.factory ?? globalThis.indexedDB; }
      catch { reject(new Error("파일 저장소를 열지 못했어요. 브라우저 설정을 확인해 주세요.")); return; }
      if (!factory) {
        reject(new Error("이 브라우저에서 파일 저장소를 사용할 수 없어요."));
        return;
      }
      let request;
      try { request = factory.open("carebridge-media-v1", 1); }
      catch { reject(new Error("파일 저장소를 열지 못했어요. 브라우저 설정을 확인해 주세요.")); return; }
      let blocked = false;
      request.onupgradeneeded = () =>
        request.result.createObjectStore("files", { keyPath: "id" });
      request.onerror = () =>
        reject(
          new Error(
            "파일 저장소를 열지 못했어요. 브라우저 설정을 확인해 주세요.",
          ),
        );
      request.onblocked = () => {
        blocked = true;
        reject(
          new Error("다른 탭의 파일 저장소를 닫은 뒤 다시 시도해 주세요."),
        );
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          this.connection = null;
        };
        resolve(db);
      };
    }).catch((error) => {
      this.connection = null;
      throw error;
    });
    return this.connection;
  }
  async read(id) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readonly");
      const request = tx.objectStore("files").get(id);
      tx.oncomplete = () => resolve(request.result?.blob || null);
      tx.onabort = tx.onerror = () => reject(new Error("첨부파일을 읽지 못했어요."));
    }).catch(() => { throw new Error("첨부파일을 읽지 못했어요."); });
  }
  async write(entries) {
    if (!entries.length) return;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      const store = tx.objectStore("files");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(
          new Error(
            "첨부파일을 저장하지 못했어요. 브라우저 저장 공간을 확인한 뒤 다시 시도해 주세요.",
          ),
        );
      try { for (const [id, blob] of entries) store.add({ id, blob }); }
      catch { try { tx.abort(); } catch {} reject(new Error("첨부파일을 저장하지 못했어요.")); }
    }).catch(() => { throw new Error("첨부파일을 저장하지 못했어요. 브라우저 저장 공간을 확인한 뒤 다시 시도해 주세요."); });
  }
  async remove(ids) {
    if (!ids.length) return;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error("미완료 파일을 정리하지 못했어요."));
      try { for (const id of ids) tx.objectStore("files").delete(id); }
      catch { try { tx.abort(); } catch {} reject(new Error("미완료 파일을 정리하지 못했어요.")); }
    }).catch(() => { throw new Error("미완료 파일을 정리하지 못했어요."); });
  }
}
// First commit new immutable blobs; only then publish their references in JSON.
// Existing blobs are never deleted on edit: older shared snapshots still use them.
export async function saveWithMedia(store, entries, saveRecord) {
  await store.write(entries);
  try {
    return await saveRecord();
  } catch (error) {
    try {
      await store.remove(entries.map(([id]) => id));
    } catch {
      throw new Error(
        `${error.message} 미완료 첨부파일 일부가 이 브라우저에 남아 있을 수 있어요.`,
      );
    }
    throw error;
  }
}
