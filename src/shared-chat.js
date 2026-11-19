import { SharedChatClient, SharedChatError, validateChatPayload } from './shared-chat-client.js';
import { SharedChatMedia, attachmentCards } from './shared-chat-media.js';
import { webChatMediaCaption } from './shared-chat-media-policy.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const roleName = role => role === 'therapist' ? '치료사' : '보호자';
const errorText = error => ({ AUTH_INVALID: '이메일과 비밀번호를 확인해 주세요.', AUTH_REQUIRED: '로그인 연결이 만료됐거나 계정이 바뀌었어요. 다시 로그인해 주세요.',
  SESSION_PRESENT: '이미 로그인된 계정이 있어요. 로그인 상태를 다시 확인해 주세요.', NOT_FOUND: '이 대화에 접근할 수 없어요. 대화 목록을 다시 확인해 주세요.',
  INVALID_INPUT: '입력 내용을 확인해 주세요.', IDEMPOTENCY_CONFLICT: '전송 번호의 내용이 달라 확인이 필요해요. 새 메시지로 다시 보내지 말고 담당자에게 알려 주세요.',
  CHAT_LIMIT: '요청이 많아요. 잠시 후 다시 시도해 주세요.', CHAT_TOO_MUCH: '이번 시연에서 불러올 수 있는 대화 범위를 넘었어요. 담당자에게 알려 주세요.',
  CROSS_ORIGIN_DENIED: '허용된 Carebridge 주소에서 다시 접속해 주세요.',
  MEDIA_LIMIT: '파일당 3MB 이하, 최대 4개까지 선택해 주세요.', INVALID_MEDIA: 'JPG·PNG·WebP 사진 또는 H.264 MP4 영상을 선택해 주세요.',
  UPLOAD_EXPIRED: '첨부 대기 시간이 지났어요. 파일 선택을 확인하고 다시 보내 주세요.', ATTACHMENT_NOT_FOUND: '첨부파일에 접근할 수 없어요. 대화를 새로 확인해 주세요.',
  MEDIA_STORAGE_FULL: '시연용 첨부 저장 공간이 가득 찼어요. 담당자에게 알려 주세요.' }[error?.code] ?? '서버에 연결하지 못했어요. 잠시 후 다시 확인해 주세요.');
const timeText = value => new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' }).format(new Date(value));
const dayText = value => new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));
const roomName = value => value?.name?.trim() || '가상 아동 대화';
const nearBottom = node => node.scrollHeight - node.clientHeight - node.scrollTop < 70;

export class SharedChatApp {
  constructor({ host, client = new SharedChatClient(), pollMs = 5000 } = {}) {
    this.host = host; this.client = client; this.pollMs = pollMs; this.phase = 'checking'; this.generation = 0;
    this.rooms = []; this.messages = []; this.drafts = new Map(); this.operation = null; this.newMessages = 0;
    this.user = null; this.selected = null; this.readThrough = 0; this.completeSnapshot = false; this.lifetime = new AbortController();
    this.onVisibility = () => { if (document.visibilityState === 'hidden') this.refreshController?.abort(); else void this.refresh(); };
    this.onResume = () => { void this.refresh(); };
    this.onViewport = () => { const height = Math.round(window.visualViewport?.height || innerHeight); document.documentElement.style.setProperty('--chat-height', `${height}px`); };
  }
  async start() {
    this.onViewport(); window.visualViewport?.addEventListener('resize', this.onViewport); window.addEventListener('resize', this.onViewport);
    document.addEventListener('visibilitychange', this.onVisibility); window.addEventListener('focus', this.onResume); window.addEventListener('online', this.onResume);
    this.timer = setInterval(() => { void this.refresh(); }, this.pollMs);
    await this.restore();
  }
  async restore() {
    this.host.innerHTML = '<section class="chat-checking"><span class="brand-mark" aria-hidden="true">C</span><p role="status">대화 연결을 확인하고 있어요…</p></section>';
    try { const value = await this.client.session(this.lifetime.signal); if (value.authenticated) { this.user = value.user; this.workspace(); await this.refresh(); } else this.loginScreen('', value.enabled); }
    catch (error) { this.loginScreen(errorText(error)); }
  }
  clear() {
    this.generation++; this.refreshController?.abort(); this.refreshController = null; this.refreshing = false;
    this.media?.destroy(); this.media = null;
    this.user = null; this.selected = null; this.rooms = []; this.messages = []; this.drafts.clear(); this.operation = null; this.sending = false;
    this.client.userId = null; this.newMessages = 0; this.readThrough = 0; this.completeSnapshot = false; this.lifetime.abort(); this.lifetime = new AbortController();
  }
  loginScreen(message = '', enabled = true) {
    this.clear(); this.phase = 'login';
    this.host.innerHTML = `<main class="chat-login"><a class="chat-brand" href="/"><span class="brand-mark" aria-hidden="true">C</span>Carebridge</a><section class="login-card"><p class="eyebrow">함께 이어가는 대화</p><h1>서로의 소식을<br>나눠 보세요</h1><p class="login-copy">안내받은 치료사 또는 보호자 시연 계정으로 로그인하세요.</p>${enabled ? `<form data-chat-login><label for="chat-email">시연 이메일</label><input id="chat-email" name="email" type="email" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="254" required><label for="chat-password">비밀번호</label><input id="chat-password" name="password" type="password" autocomplete="off" maxlength="128" required><label class="chat-consent"><input name="synthetic" type="checkbox" required><span>가상 자료만 입력합니다.</span></label><button class="primary" type="submit">대화 시작하기</button></form>` : '<p class="login-copy">공용 대화 연결을 준비하고 있어요.</p>'}<p data-chat-status class="chat-status" role="status">${escape(message)}</p><button class="text-button" data-chat-restore type="button">로그인 상태 다시 확인</button><p class="login-note">사진·동영상과 메시지는 공용 서버에 저장되어 상대방에게 전달됩니다. 실제 개인정보는 입력하지 마세요.</p><a class="back-home" href="/">홈 · AI 도우미로 돌아가기</a></section></main>`;
    this.host.querySelector('[data-chat-restore]').addEventListener('click', () => { void this.restore(); });
    this.host.querySelector('form')?.addEventListener('submit', event => { event.preventDefault(); void this.login(event.currentTarget); });
  }
  status(message) { const node = this.host.querySelector('[data-chat-status]'); if (node && node.textContent !== message) node.textContent = message; }
  async login(form) {
    if (this.loggingIn || !form.elements.synthetic.checked) return;
    const email = form.elements.email.value.trim(), password = form.elements.password.value; form.elements.password.value = '';
    this.loggingIn = true; form.querySelectorAll('input,button').forEach(node => { node.disabled = true; }); this.status('로그인하고 있어요…');
    try { const value = await this.client.login(email, password, this.lifetime.signal); this.user = value.user; this.workspace(); await this.refresh(); }
    catch (error) { this.status(errorText(error)); form.querySelectorAll('input,button').forEach(node => { node.disabled = false; }); form.elements.password.focus(); }
    finally { this.loggingIn = false; }
  }
  workspace() {
    this.phase = 'workspace';
    this.host.innerHTML = `<div class="shared-chat-shell"><aside class="chat-sidebar"><header><a class="chat-brand" href="/"><span class="brand-mark" aria-hidden="true">C</span>Carebridge</a><p class="chat-account">${escape(roleName(this.user.role))}로 연결됨</p></header><div class="room-list-heading"><h1>대화</h1><button class="text-button" data-chat-refresh type="button" aria-label="대화 새로고침">새로고침</button></div><nav class="chat-room-list" data-chat-rooms aria-label="연결된 대화"><p class="chat-empty">대화 목록을 불러오고 있어요…</p></nav><footer class="chat-sidebar-footer"><span>${escape(this.user.email)}</span><div><a href="/">홈 · AI 도우미</a><button type="button" data-chat-logout class="text-button">로그아웃</button></div></footer></aside><main class="chat-main"><header class="chat-room-header"><button class="chat-back text-button" data-chat-back type="button" aria-label="대화 목록으로">‹</button><div><h2 data-chat-room-title>대화를 선택해 주세요</h2><p data-chat-participants>연결된 사람과 소식을 나눠요.</p></div><span class="chat-connected" data-chat-connection>연결 확인 중</span></header><div class="chat-demo-note">가상 자료 전용 · 사진·동영상과 대화를 함께 나눠요</div><div class="chat-timeline-wrap"><div class="chat-timeline" data-chat-timeline role="log" aria-label="대화 내용" aria-live="off" tabindex="0"><p class="chat-empty">왼쪽 목록에서 대화를 선택해 주세요.</p></div><button type="button" class="new-messages" data-chat-new hidden>새 메시지 보기 ↓</button></div><div class="chat-attachments" data-chat-attachments hidden></div><form class="chat-composer" data-chat-compose><button type="button" class="chat-attach-button" data-chat-pick aria-label="사진·동영상 첨부" title="JPG·PNG·WebP·MP4 · 파일당 3MB · 최대 4개" disabled>+</button><input type="file" data-chat-files multiple hidden><label class="sr-only" for="chat-message">메시지</label><textarea id="chat-message" name="message" placeholder="메시지를 입력하세요" rows="1" maxlength="2000" disabled></textarea><button class="primary" data-chat-send type="submit" disabled>보내기</button></form><div class="chat-footer-status"><p data-chat-status class="chat-status" role="status"></p><button class="text-button" type="button" data-chat-retry hidden>같은 메시지 다시 보내기</button></div></main></div>`;
    this.host.querySelector('[data-chat-refresh]').addEventListener('click', () => { void this.refresh(); });
    this.host.querySelector('[data-chat-logout]').addEventListener('click', () => { void this.logout(); });
    this.host.querySelector('[data-chat-back]').addEventListener('click', () => { this.roomOpen = false; this.host.querySelector('.shared-chat-shell').classList.remove('room-open'); });
    this.host.querySelector('[data-chat-rooms]').addEventListener('click', event => { const button = event.target.closest('[data-room]'); if (button) void this.select(button.dataset.room); });
    this.host.querySelector('[data-chat-compose]').addEventListener('submit', event => { event.preventDefault(); void this.send(); });
    this.host.querySelector('[data-chat-retry]').addEventListener('click', () => { void this.send(); });
    const input = this.host.querySelector('textarea');
    input.addEventListener('input', () => { if (!this.operation && this.selected) this.drafts.set(this.selected, input.value); this.sizeInput(); this.composer(); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(min-width: 760px)').matches) { event.preventDefault(); void this.send(); } });
    this.host.querySelector('[data-chat-new]').addEventListener('click', () => this.bottom());
    this.host.querySelector('[data-chat-timeline]').addEventListener('scroll', () => { if (nearBottom(this.timeline())) { this.newMessages = 0; this.newMessageButton(); void this.markRead(); } }, { passive: true });
    this.media = new SharedChatMedia({ host: this.host, client: this.client,
      getContext: () => ({ roomId: this.selected, userId: this.user?.userId, generation: this.generation, signal: this.lifetime.signal, messages: this.messages }),
      onChanged: () => this.composer(), errorText, onError: error => {
        if (error?.code === 'AUTH_REQUIRED') this.loginScreen(errorText(error));
        else { this.status(errorText(error)); void this.refresh(); }
      } });
  }
  timeline() { return this.host.querySelector('[data-chat-timeline]'); }
  sizeInput() { const input = this.host.querySelector('textarea'); if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 112)}px`; } }
  composer() {
    const form = this.host.querySelector('[data-chat-compose]'); if (!form) return;
    const input = form.elements.message, active = !!this.selected && this.rooms.some(room => room.conversationId === this.selected);
    input.disabled = !active || this.sending; input.readOnly = !!this.operation;
    form.querySelector('[data-chat-send]').disabled = !active || this.sending || !!this.operation || (!input.value.trim() && !this.media?.items.length);
    form.querySelector('[data-chat-send]').textContent = this.sending ? '전송 중' : '보내기';
    this.media?.setLocked(this.sending || !!this.operation, active);
    const retry = this.host.querySelector('[data-chat-retry]'); retry.hidden = !this.operation || this.sending; retry.disabled = this.sending;
    this.host.querySelector('[data-chat-logout]').disabled = !!this.sending;
  }
  revokeRoom() {
    const roomId = this.selected; this.selected = null; this.messages = []; this.operation = null; this.drafts.delete(roomId);
    this.media?.clear();
    this.newMessages = 0; this.readThrough = 0; this.completeSnapshot = false; this.host.querySelector('textarea').value = '';
    this.host.querySelector('[data-chat-room-title]').textContent = '대화를 선택해 주세요';
    this.host.querySelector('[data-chat-participants]').textContent = '연결된 사람과 소식을 나눠요.';
    this.timeline().innerHTML = '<p class="chat-empty">대화에 대한 접근 권한이 변경됐어요.</p>'; this.newMessageButton(); this.composer();
  }
  async select(roomId) {
    if (this.sending || !this.rooms.some(room => room.conversationId === roomId)) return;
    if (this.selected !== roomId) {
      if (this.operation) { this.status('전송 결과를 먼저 확인해 주세요. 같은 메시지를 다시 보내면 중복 없이 확인합니다.'); return; }
      this.refreshController?.abort(); this.refreshController = null; this.refreshing = false; this.generation++;
      this.media?.clear();
      this.selected = roomId; this.messages = []; this.readThrough = 0; this.newMessages = 0; this.completeSnapshot = false; this.timeline().innerHTML = '<p class="chat-empty">대화를 불러오고 있어요…</p>';
      this.host.querySelector('textarea').value = this.drafts.get(roomId) ?? ''; this.sizeInput();
    }
    this.roomOpen = true; this.host.querySelector('.shared-chat-shell').classList.add('room-open'); this.paintRooms(); this.composer(); await this.refresh();
  }
  paintRooms() {
    const list = this.host.querySelector('[data-chat-rooms]'); if (!list) return;
    list.querySelector('.chat-empty')?.remove();
    if (!this.rooms.length) { list.innerHTML = '<p class="chat-empty">아직 연결된 대화가 없어요.</p>'; return; }
    const available = new Set(this.rooms.map(value => value.conversationId));
    for (const node of list.querySelectorAll('[data-room]')) if (!available.has(node.dataset.room)) node.remove();
    for (const room of this.rooms) {
      let node = Array.from(list.children).find(item => item.dataset.room === room.conversationId);
      if (!node) { node = document.createElement('button'); node.type = 'button'; node.className = 'chat-room'; node.dataset.room = room.conversationId; list.append(node); }
      node.classList.toggle('selected', room.conversationId === this.selected); node.setAttribute('aria-pressed', String(room.conversationId === this.selected));
      const latest = room.latest;
      const mediaSummary = Array.isArray(latest?.attachments) && latest.attachments.length && latest.attachments.every(item => typeof item?.type === 'string') ? webChatMediaCaption(latest.attachments) : '';
      const preview = latest?.hidden || latest?.deleted ? '삭제되거나 숨겨진 메시지' : latest?.body || mediaSummary || '첫 소식을 남겨 보세요.';
      const html = `<span class="room-avatar" aria-hidden="true">${escape(roomName(room).slice(0, 1))}</span><span class="room-copy"><strong>${escape(roomName(room))}</strong><small>${escape(preview)}</small></span>${room.unread ? `<span class="unread-count" aria-label="읽지 않은 메시지 ${room.unread}개">${room.unread > 99 ? '99+' : room.unread}</span>` : ''}`;
      if (node.innerHTML !== html) node.innerHTML = html;
    }
    const selected = this.rooms.find(room => room.conversationId === this.selected);
    if (selected) {
      this.host.querySelector('[data-chat-room-title]').textContent = roomName(selected);
      this.host.querySelector('[data-chat-participants]').textContent = selected.participants.map(person => person.displayName || roleName(person.role)).join(' · ');
    }
  }
  newMessageButton() { const button = this.host.querySelector('[data-chat-new]'); if (button) { button.hidden = !this.newMessages; button.textContent = `새 메시지 ${this.newMessages}개 보기 ↓`; } }
  bottom() { const timeline = this.timeline(); if (!timeline) return; timeline.scrollTop = timeline.scrollHeight; this.newMessages = 0; this.newMessageButton(); void this.markRead(); }
  paintMessages(next, forceBottom = false) {
    const timeline = this.timeline(), atBottom = nearBottom(timeline) || !this.messages.length;
    const priorIds = new Set(this.messages.map(value => value.id));
    const priorNode = [...timeline.children].find(node => node.dataset.message && node.getBoundingClientRect().bottom > timeline.getBoundingClientRect().top);
    const anchor = priorNode ? { id: priorNode.dataset.message, offset: priorNode.getBoundingClientRect().top - timeline.getBoundingClientRect().top } : null;
    timeline.querySelector('.chat-empty')?.remove();
    const currentIds = new Set(next.map(value => value.id)); for (const node of [...timeline.children]) if (!currentIds.has(node.dataset.message)) node.remove();
    const selected = this.rooms.find(room => room.conversationId === this.selected);
    for (const message of next) {
      let node = [...timeline.children].find(value => value.dataset.message === message.id);
      if (!node) { node = document.createElement('article'); node.dataset.message = message.id;
        node.innerHTML = '<span class="message-author"></span><div class="message-bubble"></div><span class="message-meta"></span>'; timeline.append(node); }
      const mine = message.authorId === this.user.userId, author = selected?.participants.find(person => person.userId === message.authorId);
      node.className = 'chat-message' + (mine ? ' mine' : '');
      const text = message.hidden || message.deleted ? '삭제되거나 숨겨진 메시지입니다.' : message.body;
      const authorNode = node.querySelector('.message-author'), authorText = mine ? '나' : author?.displayName || '상대방';
      if (authorNode.textContent !== authorText) authorNode.textContent = authorText;
      const bubble = node.querySelector('.message-bubble'), bubbleHtml = `<p>${escape(text)}</p>${attachmentCards(message.attachments)}`;
      if (bubble.innerHTML !== bubbleHtml) bubble.innerHTML = bubbleHtml;
      const meta = node.querySelector('.message-meta');
      const metaHtml = `<time datetime="${escape(message.createdAt)}" title="${escape(dayText(message.createdAt))}">${escape(timeText(message.createdAt))}</time>${mine ? `<span>${message.read === true ? '읽음' : '전송됨'}</span>` : ''}${message.edited ? '<span>수정됨</span>' : ''}`;
      if (meta.innerHTML !== metaHtml) meta.innerHTML = metaHtml;
    }
    if (!next.length) timeline.innerHTML = '<p class="chat-empty">아직 소식이 없어요.<br>첫 메시지를 보내 보세요.</p>';
    const added = next.filter(value => !priorIds.has(value.id) && value.authorId !== this.user.userId).length;
    this.messages = next;
    this.media?.reconcile();
    if (atBottom || forceBottom) this.bottom();
    else {
      if (anchor) { const node = [...timeline.children].find(value => value.dataset.message === anchor.id); if (node) timeline.scrollTop += node.getBoundingClientRect().top - timeline.getBoundingClientRect().top - anchor.offset; }
      this.newMessages += added; this.newMessageButton();
    }
  }
  async refresh() {
    if (this.phase !== 'workspace' || this.refreshing || this.sending || document.visibilityState === 'hidden' || !navigator.onLine) return;
    const controller = new AbortController(), generation = this.generation, selected = this.selected;
    this.refreshController = controller; this.refreshing = true; const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    try {
      const session = await this.client.session(signal); if (!session.authenticated || session.user.userId !== this.user.userId) throw new SharedChatError('AUTH_REQUIRED');
      const rooms = await this.client.rooms(signal); const exists = selected && rooms.some(room => room.conversationId === selected);
      const page = exists ? await this.client.messages(selected, signal) : null;
      if (generation !== this.generation || signal.aborted || this.phase !== 'workspace') return;
      this.rooms = rooms; this.paintRooms();
      if (selected && !exists) { this.revokeRoom(); this.status('연결된 대화를 다시 선택해 주세요.'); }
      if (page) { this.readThrough = Math.max(this.readThrough, page.lastRead); this.completeSnapshot = true; this.paintMessages(page.messages); }
      this.host.querySelector('[data-chat-connection]').textContent = '연결됨'; this.host.querySelector('[data-chat-connection]').classList.remove('offline');
      if (!this.operation) this.status(''); this.composer();
      if (!this.selected && rooms.length === 1) { this.refreshing = false; this.refreshController = null; await this.select(rooms[0].conversationId); }
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return;
      if (error?.code === 'AUTH_REQUIRED') { this.loginScreen(errorText(error)); return; }
      if (error?.code === 'NOT_FOUND') this.revokeRoom();
      this.status(errorText(error) + (this.messages.length ? ' 이전 대화와 작성 중인 내용은 유지됩니다.' : ''));
      const connection = this.host.querySelector('[data-chat-connection]'); if (connection) { connection.textContent = '연결 확인 필요'; connection.classList.add('offline'); }
    } finally { if (this.refreshController === controller) { this.refreshController = null; this.refreshing = false; } }
  }
  async send() {
    if (this.phase !== 'workspace' || !this.selected || this.sending) return;
    const input = this.host.querySelector('textarea');
    if (!this.operation) {
      try {
        const files = this.media.capture();
        const payload = validateChatPayload(input.value, files.map(file => ({ id: file.clientId })));
        this.operation = Object.freeze({ roomId: this.selected, clientId: crypto.randomUUID(), body: payload.body, files });
      }
      catch { this.status('메시지는 1~2,000자로 입력해 주세요.'); return; }
    }
    const operation = this.operation, generation = this.generation; this.sending = true; this.completeSnapshot = false; this.refreshController?.abort(); this.refreshController = null; this.refreshing = false; this.composer(); this.status('메시지를 보내고 있어요…');
    try {
      for (const [index, file] of operation.files.entries()) {
        if (file.receipt) continue;
        this.status(`첨부 ${index + 1}/${operation.files.length}개를 보내고 있어요…`);
        const receipt = await this.client.upload(operation.roomId, file, this.lifetime.signal);
        if (generation !== this.generation || this.operation !== operation) return;
        file.receipt = receipt;
      }
      this.status('메시지를 보내고 있어요…');
      const message = await this.client.send(operation.roomId, { clientId: operation.clientId, body: operation.body,
        attachments: operation.files.map(file => ({ id: file.receipt.id })) }, this.lifetime.signal);
      if (generation !== this.generation || this.operation !== operation) return;
      this.operation = null; this.media.clearSelection(); input.value = ''; this.drafts.delete(operation.roomId); this.sizeInput();
      const next = [...this.messages.filter(value => value.id !== message.id), message].sort((a, b) => a.sequence - b.sequence); this.paintMessages(next, true); this.status('보냈어요.');
    } catch (error) {
      if (generation !== this.generation) return;
      if (error?.code === 'AUTH_REQUIRED') { this.loginScreen(errorText(error)); return; }
      if (error?.code === 'NOT_FOUND') { this.revokeRoom(); this.status(errorText(error)); return; }
      if (['INVALID_INPUT', 'INVALID_MEDIA', 'MEDIA_LIMIT', 'MEDIA_STORAGE_FULL', 'UPLOAD_EXPIRED', 'ATTACHMENT_NOT_FOUND'].includes(error?.code)) {
        // These are definite server refusals, not ambiguous transport failures.
        // Expired reservations must receive fresh upload ids on the next send.
        if (error.code === 'UPLOAD_EXPIRED' || error.code === 'ATTACHMENT_NOT_FOUND') for (const file of operation.files) { file.receipt = null; file.clientId = crypto.randomUUID(); }
        this.operation = null; this.media.notice = errorText(error); this.media.draw(); this.status(errorText(error)); return;
      }
      this.status(errorText(error) + ' 입력은 보관했어요. 같은 메시지 다시 보내기로 전송 결과를 확인해 주세요.');
    } finally { if (generation === this.generation) { this.sending = false; this.composer(); if (!this.operation) { input.focus({ preventScroll: true }); void this.refresh(); } } }
  }
  async markRead() {
    if (this.reading || this.media?.view || !this.completeSnapshot || this.phase !== 'workspace' || !this.selected || document.visibilityState !== 'visible' || !document.hasFocus() || !this.roomOpen || !nearBottom(this.timeline())) return;
    const last = this.messages.at(-1); if (!last || last.sequence <= this.readThrough) return;
    const selected = this.selected, generation = this.generation; this.reading = true;
    try { const result = await this.client.markRead(selected, last.id, this.lifetime.signal); if (generation === this.generation && selected === this.selected) this.readThrough = Math.max(this.readThrough, result.lastRead); }
    catch (error) { if (generation === this.generation && error?.code === 'AUTH_REQUIRED') this.loginScreen(errorText(error)); }
    finally { this.reading = false; }
  }
  async logout() {
    if (this.sending || this.loggingOut) return; this.loggingOut = true;
    try { await this.client.logout(this.lifetime.signal); this.loginScreen('로그아웃했어요.'); }
    catch (error) { if (error?.code === 'AUTH_REQUIRED') this.loginScreen('로그아웃했어요.'); else this.status('로그아웃을 확인하지 못했어요. 다시 눌러 주세요.'); }
    finally { this.loggingOut = false; }
  }
  destroy() {
    clearInterval(this.timer); this.clear(); document.removeEventListener('visibilitychange', this.onVisibility); window.removeEventListener('focus', this.onResume); window.removeEventListener('online', this.onResume); window.removeEventListener('resize', this.onViewport); window.visualViewport?.removeEventListener('resize', this.onViewport);
  }
}

if (typeof document !== 'undefined' && document.querySelector('[data-shared-chat-app]')) {
  const app = new SharedChatApp({ host: document.querySelector('[data-shared-chat-app]') });
  void app.start(); window.addEventListener('pagehide', () => app.destroy(), { once: true });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
}
