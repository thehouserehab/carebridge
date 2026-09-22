export const MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
];
export const MEDIA_LIMITS = {
  count: 6,
  image: 10 * 1024 ** 2,
  video: 50 * 1024 ** 2,
  total: 100 * 1024 ** 2,
};
export const MEDIA_HELP =
  "최대 6개 · 사진 10MB, 동영상 50MB 이하 · 합계 100MB 이하. JPG·PNG·WebP·GIF·MP4·WebM";
export function attachmentListValid(items) {
  return (
    Array.isArray(items) &&
    items.length <= MEDIA_LIMITS.count &&
    new Set(items.map((x) => x?.id)).size === items.length &&
    items.every(
      (x) =>
        x &&
        typeof x.id === "string" &&
        /^[a-zA-Z0-9-]{1,80}$/.test(x.id) &&
        typeof x.name === "string" &&
        x.name.length > 0 &&
        x.name.length <= 255 &&
        MEDIA_TYPES.includes(x.type) &&
        Number.isSafeInteger(x.size) &&
        x.size > 0 &&
        x.size <=
          (x.type.startsWith("image/")
            ? MEDIA_LIMITS.image
            : MEDIA_LIMITS.video) &&
        typeof x.share === "boolean",
    ) &&
    items.reduce((sum, x) => sum + x.size, 0) <= MEDIA_LIMITS.total
  );
}
export function normalizeAttachments(items = []) {
  if (!attachmentListValid(items))
    throw new Error("첨부파일 형식·개수·용량을 확인해 주세요.");
  return items.map(({ id, name, type, size, share }) => ({
    id,
    name,
    type,
    size,
    share,
  }));
}
export function fileSize(bytes) {
  return bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}
export async function inspectFile(file) {
  if (!MEDIA_TYPES.includes(file.type))
    throw new Error(
      `${file.name}: 지원하지 않는 형식입니다. JPG·PNG·WebP·GIF·MP4·WebM을 선택해 주세요.`,
    );
  const limit = file.type.startsWith("image/")
    ? MEDIA_LIMITS.image
    : MEDIA_LIMITS.video;
  if (file.size === 0 || file.size > limit)
    throw new Error(
      `${file.name}: 빈 파일이거나 ${fileSize(limit)} 제한을 초과했어요.`,
    );
  const bytes = new Uint8Array(await file.slice(0, 40).arrayBuffer());
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  const matches = {
    "image/jpeg": bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    "image/png": [137, 80, 78, 71, 13, 10, 26, 10].every(
      (v, i) => bytes[i] === v,
    ),
    "image/gif": ["GIF87a", "GIF89a"].includes(ascii(0, 6)),
    "image/webp": ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP",
    "video/mp4": ascii(4, 8) === "ftyp" && bytes.length >= 12,
    "video/webm": [26, 69, 223, 163].every((v, i) => bytes[i] === v),
  };
  if (!matches[file.type])
    throw new Error(`${file.name}: 파일 내용과 형식이 일치하지 않아요.`);
  return {
    id: crypto.randomUUID(),
    name: file.name.slice(0, 255),
    type: file.type,
    size: file.size,
    share: false,
  };
}
