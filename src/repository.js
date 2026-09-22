import { STORAGE_KEY } from "./config.js";
import { seed } from "./seed.js";
import { validateState } from "./domain.js";
export function load(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return { db: seed(), error: null };
    const db = JSON.parse(raw);
    if (!validateState(db)) throw new Error("invalid");
    return { db, error: null };
  } catch {
    return {
      db: null,
      error:
        "저장된 데이터를 읽지 못했어요. 기존 데이터는 덮어쓰지 않았습니다. 브라우저 저장소 접근 설정을 확인하거나 개발 담당자에게 복구를 요청해 주세요.",
    };
  }
}
export function persist(storage, db, previousRevision) {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw !== null) {
    let current;
    try {
      current = JSON.parse(raw);
    } catch {
      throw new Error("저장된 데이터가 손상되었습니다. 입력을 유지했어요.");
    }
    if (!validateState(current))
      throw new Error("저장된 데이터 형식을 확인해 주세요. 입력을 유지했어요.");
    if (current.revision !== previousRevision)
      throw new Error(
        "다른 탭에서 변경되었어요. 입력을 복사한 뒤 새로고침하고 다시 저장해 주세요.",
      );
  } else if (previousRevision !== 0)
    throw new Error(
      "저장소가 변경되었어요. 입력을 복사한 뒤 새로고침해 주세요.",
    );
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    throw new Error(
      "저장 공간 또는 브라우저 설정으로 저장하지 못했어요. 입력은 유지됩니다.",
    );
  }
}
