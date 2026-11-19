import { SharedChatError, validateChatFile } from './shared-chat-client.js';
import { WEB_CHAT_MEDIA_ACCEPT, WEB_CHAT_MEDIA_MAX_FILES } from './shared-chat-media-policy.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const sizeLabel = size => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(size / 1024))} KB`;
const kind = attachment => attachment.type.startsWith('image/') ? '사진' : '동영상';

export function attachmentCards(attachments = []) {
  return attachments.length ? `<div class="chat-message-attachments">${attachments.map((item, index) => `<button type="button" class="chat-attachment-card" data-chat-open-media="${escape(item.id)}" aria-label="${kind(item)} ${index + 1} ${kind(item) === '사진' ? '열기' : '재생'}"><span class="chat-attachment-icon" aria-hidden="true">${kind(item) === '사진' ? '▧' : '▷'}</span><span><strong>${kind(item)} ${index + 1}</strong><small>${sizeLabel(item.size)}${item.duration ? ` · ${Math.ceil(item.duration)}초` : ''}</small></span><span class="chat-attachment-open" aria-hidden="true">열기</span></button>`).join('')}</div>` : '';
}

// One active viewer bounds decoded media memory and keeps blobs out of storage.
// The picker never uploads until the user sends the message.
export class SharedChatMedia {
  constructor({ host, client, getContext, onChanged, onError, errorText }) {
    Object.assign(this, { host, client, getContext, onChanged, onError, errorText });
    this.items = []; this.locked = false; this.notice = ''; this.closed = false; this.view = null;
    this.picker = host.querySelector('[data-chat-files]'); this.picker.accept = WEB_CHAT_MEDIA_ACCEPT;
    this.pickButton = host.querySelector('[data-chat-pick]');
    this.selection = host.querySelector('[data-chat-attachments]');
    this.onPick = () => { if (!this.locked && this.getContext().roomId) this.picker.click(); };
    this.onFiles = () => { const files = [...this.picker.files]; this.picker.value = ''; this.selectFiles(files); };
    this.onRemove = event => { const button = event.target.closest('[data-chat-remove-media]'); if (button && !this.locked) this.remove(button.dataset.chatRemoveMedia); };
    this.onOpen = event => { const button = event.target.closest('[data-chat-open-media]'); if (button) void this.open(button.closest('[data-message]')?.dataset.message, button.dataset.chatOpenMedia, button); };
    this.pickButton.addEventListener('click', this.onPick); this.picker.addEventListener('change', this.onFiles);
    this.selection.addEventListener('click', this.onRemove); host.querySelector('[data-chat-timeline]').addEventListener('click', this.onOpen);
    this.draw();
  }
  setLocked(locked, active) {
    const changed = this.locked !== locked; this.locked = locked;
    this.pickButton.disabled = locked || !active; this.picker.disabled = locked || !active;
    if (changed) this.draw();
  }
  selectFiles(files) {
    if (!files.length || this.locked || this.closed || !this.getContext().roomId) return;
    const additions = [];
    try {
      if (this.items.length + files.length > WEB_CHAT_MEDIA_MAX_FILES) throw new SharedChatError('MEDIA_LIMIT');
      files.forEach(validateChatFile);
      for (const file of files) additions.push({ clientId: crypto.randomUUID(), file, receipt: null,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
      this.items.push(...additions); this.notice = '';
    } catch (error) {
      additions.forEach(item => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
      this.notice = this.errorText(error);
    }
    this.draw(); this.onChanged();
  }
  remove(clientId) {
    const item = this.items.find(value => value.clientId === clientId); if (!item) return;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); item.file = null;
    this.items = this.items.filter(value => value !== item); this.notice = ''; this.draw(); this.onChanged();
    this.pickButton.focus({ preventScroll: true });
  }
  draw() {
    this.selection.hidden = !this.items.length && !this.notice;
    this.selection.innerHTML = `<div class="chat-selection-list">${this.items.map((item, index) => `<div class="chat-selection-item">${item.previewUrl ? `<img src="${escape(item.previewUrl)}" alt="선택한 사진 ${index + 1}">` : '<span class="chat-selection-video" aria-hidden="true">▷</span>'}<span class="chat-selection-name">${escape(item.file?.name ?? '첨부파일')}</span><button type="button" data-chat-remove-media="${item.clientId}" aria-label="${escape(item.file?.name ?? '파일')} 첨부 제거" ${this.locked ? 'disabled' : ''}>×</button></div>`).join('')}</div><p class="chat-selection-note" role="status">${escape(this.notice || `선택 ${this.items.length}개 · 파일당 3MB · 최대 ${WEB_CHAT_MEDIA_MAX_FILES}개`)}</p>`;
  }
  capture() { return Object.freeze([...this.items]); }
  clearSelection() {
    for (const item of this.items) { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); item.previewUrl = null; item.file = null; }
    this.items = []; this.notice = ''; this.picker.value = ''; this.draw();
  }
  closeView() {
    const view = this.view; this.view = null; if (!view) return;
    view.controller.abort();
    const media = view.dialog.querySelector('img,video');
    if (media) { if (media.tagName === 'VIDEO') media.pause(); media.removeAttribute('src'); if (media.tagName === 'VIDEO') media.load(); }
    if (view.url) URL.revokeObjectURL(view.url);
    view.dialog.close(); view.dialog.remove();
    if (view.trigger?.isConnected) view.trigger.focus({ preventScroll: true });
  }
  currentView(view) {
    const context = this.getContext();
    return this.view === view && !view.controller.signal.aborted && !this.closed && context.generation === view.generation &&
      context.roomId === view.roomId && context.userId === view.userId &&
      context.messages.some(message => message.id === view.messageId && !message.hidden && !message.deleted && message.attachments?.some(item => item.id === view.metadata.id));
  }
  reconcile() { if (this.view && !this.currentView(this.view)) this.closeView(); }
  async open(messageId, attachmentId, trigger) {
    const context = this.getContext(), message = context.messages.find(value => value.id === messageId && !value.hidden && !value.deleted);
    const metadata = message?.attachments?.find(value => value.id === attachmentId);
    if (!metadata || !context.roomId || !context.userId) return;
    this.closeView();
    const dialog = document.createElement('dialog'); dialog.className = 'chat-media-dialog'; dialog.setAttribute('aria-label', `${kind(metadata)} 보기`);
    dialog.innerHTML = `<header><h2>${kind(metadata)} 보기</h2><button type="button" class="text-button" aria-label="첨부 닫기">닫기</button></header><div class="chat-media-content"><p role="status">첨부파일을 불러오고 있어요…</p></div>`;
    const controller = new AbortController(), view = { dialog, controller, trigger, metadata, messageId,
      roomId: context.roomId, userId: context.userId, generation: context.generation, url: null };
    this.view = view; document.body.append(dialog);
    dialog.querySelector('button').addEventListener('click', () => this.closeView());
    dialog.addEventListener('cancel', event => { event.preventDefault(); this.closeView(); }); dialog.showModal();
    try {
      const blob = await this.client.attachment(view.roomId, metadata, AbortSignal.any([context.signal, controller.signal]));
      if (!this.currentView(view)) return;
      view.url = URL.createObjectURL(blob);
      const media = document.createElement(metadata.type.startsWith('image/') ? 'img' : 'video');
      if (media.tagName === 'IMG') media.alt = '대화에 첨부된 사진';
      else { media.controls = true; media.playsInline = true; media.preload = 'metadata'; media.setAttribute('aria-label', '대화에 첨부된 동영상'); }
      media.addEventListener('error', () => { if (this.currentView(view)) dialog.querySelector('.chat-media-content').replaceChildren(Object.assign(document.createElement('p'), { textContent: '이 브라우저에서 파일을 열 수 없어요. JPG·PNG·WebP 사진 또는 H.264 MP4 영상을 사용해 주세요.' })); }, { once: true });
      media.src = view.url; dialog.querySelector('.chat-media-content').replaceChildren(media);
    } catch (error) {
      if (!this.currentView(view)) return;
      if (['AUTH_REQUIRED', 'NOT_FOUND', 'ATTACHMENT_NOT_FOUND'].includes(error?.code)) { this.closeView(); this.onError(error); return; }
      const content = dialog.querySelector('.chat-media-content');
      content.replaceChildren(Object.assign(document.createElement('p'), { textContent: this.errorText(error) + ' 창을 닫은 뒤 다시 열어 주세요.' }));
    }
  }
  clear() { this.closeView(); this.clearSelection(); }
  destroy() {
    this.closed = true; this.clear();
    this.pickButton.removeEventListener('click', this.onPick); this.picker.removeEventListener('change', this.onFiles);
    this.selection.removeEventListener('click', this.onRemove); this.host.querySelector('[data-chat-timeline]')?.removeEventListener('click', this.onOpen);
  }
}
