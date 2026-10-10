// Display-only text for an already authorized projection, never a substitute
// for permission checks or a value to persist as authored/clinical content.
export function messagePreview(message) {
  if (!message) return "첫 소식을 남겨 보세요.";
  if (message.body?.trim()) return message.body;
  if (message.hidden || message.deleted) return "열람할 수 없는 소식입니다.";
  const attachments = message.attachments || [];
  const photos = attachments.filter((file) => file.type?.startsWith("image/")).length;
  const videos = attachments.filter((file) => file.type?.startsWith("video/")).length;
  const other = attachments.length - photos - videos;
  return [photos && `사진 ${photos}장`, videos && `동영상 ${videos}개`, other && `첨부파일 ${other}개`]
    .filter(Boolean).join(" · ") || "소식이 도착했어요.";
}
