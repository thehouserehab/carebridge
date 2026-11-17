import { AiClient } from './ai-client.js';
import { LocalApiError } from './client.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const scope = value => JSON.stringify([value?.user?.userId,value?.centerId,value?.roomId,value?.role,value?.generation]);
const errors = {
  AI_UNAVAILABLE:'AI가 아직 연결되지 않았어요. 서버의 OpenAI 설정을 확인해 주세요.',
  AI_BUSY:'앞선 AI 요청을 처리하고 있어요. 완료 후 다시 확인해 주세요.',
  AI_LIMIT:'이번 시험의 AI 호출 한도에 도달했어요.',
  AI_SOURCE_CHANGED:'기록이 바뀌었어요. 최신 기록을 다시 선택해 주세요.',
  AI_CONVERSATION_CHANGED:'다른 화면에서 대화가 바뀌었어요. 닫았다가 다시 열어 주세요.',
  AI_REQUEST_FAILED:'이 요청의 결과를 확인하지 못했어요. 자동으로 재전송하지 않습니다.',
  AI_PROVIDER_UNAVAILABLE:'AI 응답을 받지 못했어요. 질문은 그대로 보관했어요.',
  AI_OUTPUT_INVALID:'AI 응답을 확인할 수 없어 적용하지 않았어요.',
  AI_REQUEST_CONFLICT:'이 요청은 다시 사용할 수 없어요. 내용을 확인해 새로 작성해 주세요.',
  AI_CANCELLED:'AI 요청을 취소했어요. 전송이 시작된 요청은 비용이 발생할 수 있어요.',
  CANCELLED:'AI 요청을 취소했어요.',
};

// No provider keys, browser storage, automatic record discovery or automatic writes.
export class AiAssistantUi {
  constructor({api,getContext,onApplySummary,onApplyAudio,onDismiss=()=>false,onError=()=>{}}) {
    this.api=api; this.client=new AiClient(api); this.getContext=getContext;
    this.onApplySummary=onApplySummary; this.onApplyAudio=onApplyAudio; this.onDismiss=onDismiss; this.onError=onError; this.dialog=null; this.epoch=0;
  }
  current(token=this.epoch) {
    const value=this.getContext();
    return token===this.epoch && !!this.dialog?.open && value.connected && scope(value)===this.scope;
  }
  sync() { this.audioUi?.sync(); if(this.dialog?.open && !this.current()) this.close(false); }
  close(restoreFocus=true) {
    const wasOpen=this.dialog?.open===true;
    this.audioUi?.close(restoreFocus);
    this.epoch++; this.operation?.abort(); this.operation=null;
    this.dialog?.close(); this.dialog?.remove(); this.dialog=null;
    this.conversation=null; this.records=[]; this.preview=null; this.draft=null; this.input=''; this.busy=false;
    if(restoreFocus && wasOpen && this.onDismiss()!==true && this.returnFocus?.isConnected)this.returnFocus.focus();
  }
  async open() {
    const context=this.getContext();
    if(!context.connected || !context.roomId) {this.onError('연결된 대화를 먼저 선택해 주세요.');return;}
    this.close(false);
    this.context=context; this.scope=scope(context); this.tab='chat'; this.input='';
    this.records=[]; this.preview=null; this.draft=null; this.status='AI 연결을 확인하고 있어요…'; this.busy=false;
    this.returnFocus=document.activeElement;
    const dialog=document.createElement('dialog'); dialog.className='ai-assistant'; dialog.setAttribute('aria-labelledby','ai-title');
    dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
    dialog.addEventListener('input',event=>{if(event.target.matches('[data-ai-input]'))this.input=event.target.value;});
    dialog.addEventListener('change',event=>{if(event.target.matches('[data-ai-record]'))void this.selectRecord(event.target.value);});
    dialog.addEventListener('click',event=>{
      const action=event.target.closest('[data-ai-action]')?.dataset.aiAction;
      if(action==='close')this.close();
      else if(action==='cancel'){this.operation?.abort();}
      else if(action==='chat'||action==='summary')void this.setTab(action);
      else if(action==='generate')void this.generate();
      else if(action==='apply')void this.apply();
      else if(action==='audio')void this.openAudio();
    });
    dialog.addEventListener('submit',event=>{event.preventDefault();void this.send();});
    document.body.append(dialog);this.dialog=dialog;this.render();dialog.showModal();
    await this.run(async signal=>{
      const conversation=await this.client.conversation(context,signal);
      return ()=>{this.conversation=conversation;this.status='';};
    });
    this.dialog?.querySelector('[data-ai-input]')?.focus();
  }
  async openAudio() {
    if(this.busy || !this.current() || this.context.role!=='therapist' ||
        globalThis.document?.documentElement?.dataset.audioNotesMode!=='synthetic')return;
    const token=this.epoch;
    try {
      // Keep the ordinary app and its media paths unchanged. Only the dedicated
      // synthetic audio runtime requests this optional module.
      const {AudioNotesUi}=await import('./audio-notes-ui.js');
      if(!this.current(token))return;
      this.close(false);
      this.audioUi=new AudioNotesUi({api:this.api,getContext:this.getContext,onApply:this.onApplyAudio,onDismiss:this.onDismiss,onError:this.onError});
      await this.audioUi.open();
    } catch {
      if(this.current(token))this.onError('녹음 화면을 열지 못했어요. 다시 시도해 주세요.');
    }
  }
  async run(work) {
    if(this.busy || !this.current())return;
    const token=this.epoch, controller=new AbortController();this.operation=controller;this.busy=true;this.render();
    const signal=AbortSignal.any([controller.signal,this.context.signal]);
    try {
      const commit=await work(signal);
      if(this.current(token)&&!signal.aborted)commit?.();
    } catch(error) {
      if(!this.current(token))return;
      if(['AUTH_REQUIRED','FORBIDDEN','NOT_FOUND'].includes(error.code)){
        this.close(false);this.onError('열람 권한이 바뀌어 AI 화면을 닫았어요.');return;
      }
      this.status=errors[signal.aborted?'AI_CANCELLED':error?.code] ?? '응답을 확인하지 못했어요. 입력은 유지했으며 자동으로 다시 보내지 않습니다.';
    } finally {
      if(this.current(token)){this.operation=null;this.busy=false;this.render();}
    }
  }
  async send() {
    if(this.busy || !this.conversation || !this.input.trim())return;
    const message=this.input.trim(), expectedRevision=this.conversation.revision, requestId=crypto.randomUUID();
    this.status='답변을 작성하고 있어요…';
    await this.run(async signal=>{
      const conversation=await this.client.send(this.context,{message,expectedRevision,requestId},signal);
      return ()=>{this.conversation=conversation;this.input='';this.status='';};
    });
    this.dialog?.querySelector('[data-ai-history]')?.lastElementChild?.scrollIntoView({block:'nearest'});
    this.dialog?.querySelector('[data-ai-input]')?.focus();
  }
  async setTab(tab) {
    if(this.busy || !this.current() || tab===this.tab)return;
    this.tab=tab;this.status='';this.render();
    if(tab==='summary' && this.context.role==='therapist'){
      await this.run(async signal=>{
        const records=await this.api.records(this.context.centerId,this.context.roomId,signal);
        return ()=>{this.records=records;this.preview=null;this.draft=null;this.status=records.length?'':'먼저 기록을 저장한 뒤 선택해 주세요.';};
      });
    }
  }
  async selectRecord(id) {
    if(this.busy)return;
    this.preview=null;this.draft=null;this.status='';
    const record=this.records.find(record=>record.id===id);
    if(!record){this.render();return;}
    await this.run(async signal=>{
      const preview=await this.client.preview(this.context,record,signal);
      return ()=>{this.preview=preview;};
    });
  }
  async generate() {
    if(!this.preview || this.busy)return;
    const preview=this.preview;this.status='요약 초안을 작성하고 있어요…';this.draft=null;
    await this.run(async signal=>{
      const draft=await this.client.generate(this.context,preview,crypto.randomUUID(),signal);
      return ()=>{this.draft=draft;this.status='생성한 내용을 확인한 뒤 적용해 주세요. 아직 기록에 저장하거나 공유하지 않았어요.';};
    });
  }
  async apply() {
    if(!this.draft || !this.preview || this.busy)return;
    const token=this.epoch, draft=this.draft, context=this.context;
    await this.run(async signal=>{
      const latest=await this.client.preview(context,{id:draft.recordId,revision:draft.revision},signal);
      if(latest.sourceHash!==draft.sourceHash)throw new LocalApiError('AI_SOURCE_CHANGED');
      const isCurrent=()=>this.current(token)&&!signal.aborted;
      if(!isCurrent())return;
      const accepted=await this.onApplySummary(draft,latest,context,{signal,isCurrent});
      if(!accepted)throw new LocalApiError('AI_SOURCE_CHANGED');
      return ()=>{this.close(false);document.querySelector('[data-care-form="record"] [name="summary"]')?.focus();};
    });
  }
  render() {
    if(!this.dialog)return;
    const disabled=this.busy?'disabled':'';
    const presentation=globalThis.document?.documentElement?.dataset;
    // Synthetic data and fixture responses are separate choices. The explicit
    // provider marker describes first paint; API metadata is authoritative.
    const mode=this.preview?.mode ?? this.conversation?.mode ?? presentation?.aiMode ??
      (presentation?.prototypeMode==='synthetic'?'fixture':undefined);
    const fixture=mode==='fixture';
    const childName=this.context.profile?.name;
    const messages=this.conversation?.messages ?? [];
    const chat=`<section class="ai-chat-panel" aria-label="AI 대화">
      <div class="ai-history" data-ai-history role="log" aria-label="AI 대화 내용" aria-live="polite">
        ${messages.length?messages.map(message=>`<article class="ai-bubble ${message.role}"><strong>${message.role==='user'?'나':'AI 도우미'}</strong><p>${escape(message.content)}</p></article>`).join(''):
          '<div class="ai-empty"><h3>무엇이 궁금하세요?</h3><p>개념 설명, 문장 다듬기, 아이디어를 함께 정리해요.</p><p class="small muted">진단이나 치료 결정은 담당 전문가와 확인해 주세요.</p></div>'}
      </div>
      ${this.conversation?.contextTruncated?'<p class="small muted">이전 대화 일부가 길이 제한으로 제외됐어요.</p>':''}
      <form class="ai-compose"><label for="ai-question" class="sr-only">AI에게 질문</label><textarea id="ai-question" data-ai-input rows="2" maxlength="2000" placeholder="AI에게 질문해 보세요" ${disabled}>${escape(this.input)}</textarea><button class="primary" type="submit" ${this.busy||!this.conversation?'disabled':''}>보내기</button></form>
      <p class="ai-disclosure">입력한 질문과 최근 AI 대화만 ${fixture?'시험 응답기에':'OpenAI에'} 전송해요. 아동 기록·사진·영상은 자동으로 보내지 않아요.</p>
    </section>`;
    const summary=`<section class="ai-summary-panel" aria-label="기록 요약 도우미"><label>요약할 저장 기록<select data-ai-record ${disabled}><option value="">기록 선택</option>${this.records.map(record=>`<option value="${escape(record.id)}" ${this.preview?.recordId===record.id?'selected':''}>${escape(record.date)} · ${escape(record.title||'제목 없는 기록')}</option>`).join('')}</select></label>
      ${this.preview?`<section class="ai-source" aria-label="AI에 보낼 내용"><h3>AI에 보낼 내용</h3><strong>오늘 한 활동</strong><p>${escape(this.preview.source.performed||'입력 없음')}</p><strong>아이의 반응</strong><p>${escape(this.preview.source.response||'입력 없음')}</p><p class="small muted">이 두 항목만 전달해요. 이름·연락처가 들어 있다면 기록에서 먼저 수정해 주세요.</p></section><button class="primary" data-ai-action="generate" ${disabled}>${fixture?'시험 요약 초안 만들기':'위 내용을 OpenAI에 보내 초안 만들기'}</button>`:''}
      ${this.draft?`<section class="ai-result" aria-label="AI 요약 초안"><h3>보호자용 요약 초안</h3><p class="ai-generated">${escape(this.draft.summary)}</p>${this.draft.reviewNotes.length?`<ul>${this.draft.reviewNotes.map(note=>`<li>${escape(note)}</li>`).join('')}</ul>`:''}<button type="button" data-ai-action="apply" ${disabled}>확인하고 기록 작성란에 넣기</button><p class="small muted">원하는 대로 수정한 뒤 기존 저장·공유 버튼을 사용하세요.</p></section>`:''}
    </section>`;
    this.dialog.innerHTML=`<header class="ai-head"><div><p class="eyebrow">CAREBRIDGE</p><h2 id="ai-title">AI 도우미</h2>${childName?`<p class="small muted" data-ai-context>연결된 아이 · ${escape(childName)}</p>`:''}</div><button type="button" data-ai-action="close" aria-label="AI 도우미 닫기">닫기</button></header>
      <nav class="ai-tabs" aria-label="AI 기능"><button type="button" data-ai-action="chat" aria-pressed="${this.tab==='chat'}" ${disabled}>자유 대화</button>${this.context.role==='therapist'?`<button type="button" data-ai-action="summary" aria-pressed="${this.tab==='summary'}" ${disabled}>기록 요약</button>${globalThis.document?.documentElement?.dataset.audioNotesMode==='synthetic'?`<button type="button" data-ai-action="audio" ${disabled}>녹음 정리</button>`:''}`:''}</nav>
      ${fixture?'<p class="ai-fixture" role="note" data-ai-provider>합성 응답 검증 모드 · 실제 AI 모델의 답변이 아닙니다.</p>':mode==='openai'?'<p class="small muted" role="note" data-ai-provider>OpenAI 사용 · 가상 자료 전용</p>':''}
      <div class="ai-content">${this.tab==='chat'?chat:summary}</div>
      <footer class="ai-footer"><p role="status" data-ai-status>${escape(this.status)}</p>${this.busy?'<button type="button" data-ai-action="cancel">요청 취소</button>':''}</footer>`;
  }
}
