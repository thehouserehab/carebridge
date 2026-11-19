// Deliberately bounded public prototype storage; not the local worker policy.
export const WEB_CHAT_MEDIA_MAX_BYTES = 3 * 1024 * 1024;
export const WEB_CHAT_MEDIA_MAX_FILES = 4;
export const WEB_CHAT_MEDIA_CENTER_BYTES = 100 * 1024 * 1024;
export const WEB_CHAT_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'video/mp4']);
export const WEB_CHAT_MEDIA_ACCEPT = WEB_CHAT_MEDIA_TYPES.join(',');

export function webChatMediaName(type) {
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4' }[type];
  return extension ? `carebridge-${type.startsWith('image/') ? 'photo' : 'video'}.${extension}` : null;
}

export function webChatMediaCaption(attachments) {
  const images = attachments.filter(item => item.type.startsWith('image/')).length;
  const videos = attachments.length - images;
  return [images ? `사진 ${images}개` : '', videos ? `동영상 ${videos}개` : ''].filter(Boolean).join(' · ');
}
