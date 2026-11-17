import {WebAiClient,boundedWebAiMessages} from './web-ai-client.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const key=context=>JSON.stringify([context?.actorId,context?.role,context?.childId]);
const messages={AUTH_REQUIRED:'AI 체험 연결이 만료됐어요. 체험 코드로 다시 연결해 주세요.',INVALID_ACCESS_CODE:'체험 코드를 확인해 주세요.',AI_UNAVAILABLE:'지금은 AI에 연결할 수 없어요. 잠시 후 다시 확인해 주세요.',INVALID_INPUT:'입력 내용을 확인해 주세요.',AI_PROVIDER_UNAVAILABLE:'OpenAI 응답을 받지 못했어요. 입력은 유지했으며 자동으로 재전송하지 않아요.',AI_OUTPUT_INVALID:'응답을 확인할 수 없어 적용하지 않았어요.',AI_RATE_LIMITED:'잠시 후 다시 시도해 주세요. 이번 요청 한도에 도달했어요.',CROSS_ORIGIN_DENIED:'현재 주소에서 AI 연결을 허용하지 않아요.',AI_CANCELLED:'요청을 중단했어요. 이미 시작된 요청에는 비용이 발생할 수 있어요.'};
export function sameWebAiSnapshot(left,right) {
  return !!left&&!!right&&JSON.stringify(left)===JSON.stringify(right);
}
export class WebAiUi {
  constructor({getContext,listRecords,getRecord,onApply,client=new WebAiClient(),onError=()=>{}}) {
    Object.assign(this,{getContext,listRecords,getRecord,onApply,client,onError});this.history=[];this.input='';this.epoch=0;
  }
  current(epoch=this.epoch) {return epoch===this.epoch&&this.dialog?.open&&this.scope===key(this.getContext());}
  sync() {
    if(this.scope&&this.scope!==key(this.getContext())) {this.close(false);this.history=[];this.input='';this.scope=null;}
  }
  close(restore=true) {
    this.epoch++;this.operation?.abort();this.operation=null;this.busy=false;
    if(this.dialog){this.dialog.close();this.dialog.remove();this.dialog=null;}
    this.snapshot=null;this.draft=null;
    if(restore&&this.returnFocus?.isConnected)this.returnFocus.focus();
  }
  async open() {
    this.sync();this.close(false);this.context=this.getContext();this.scope=key(this.context);this.tab='chat';this.status='AI 연결을 확인하고 있어요…';this.authenticated=false;this.enabled=true;
    this.returnFocus=document.activeElement;
    const dialog=document.createElement('dialog');dialog.className='web-ai';dialog.setAttribute('aria-labelledby','web-ai-title');this.dialog=dialog;
    dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
    dialog.addEventListener('input',event=>{if(event.target.matches('[data-web-ai-message]'))this.input=event.target.value;});
    dialog.addEventListener('change',event=>{
      if(event.target.matches('[data-web-ai-record]')){this.snapshot=event.target.value?this.getRecord(event.target.value):null;this.draft=null;this.status='';this.render();}
    });
    dialog.addEventListener('click',event=>{
      const action=event.target.closest('[data-web-ai]')?.dataset.webAi;
      if(action==='close')this.close();
      else if(action==='cancel')this.operation?.abort();
      else if(action==='logout')void this.logout();
      else if(action==='retry')void this.checkSession();
      else if(['chat','summary'].includes(action)&&!this.busy){this.tab=action;this.status='';this.render();}
      else if(action==='generate')void this.generate();
      else if(action==='apply')void this.apply();
    });
    dialog.addEventListener('submit',event=>{
      event.preventDefault();
      if(event.target.matches('[data-web-ai-login]')) {
        const code=event.target.elements.accessCode.value;event.target.elements.accessCode.value='';
        if(event.target.elements.synthetic.checked)void this.login(code);else{this.status='가상 자료만 사용하는지 확인해 주세요.';this.render();}
      }else if(event.target.matches('[data-web-ai-chat]'))void this.send();
    });
    document.body.append(dialog);this.render();dialog.showModal();await this.checkSession();
  }
  async run(work) {
    if(this.busy||!this.current())return;
    const epoch=this.epoch,controller=new AbortController();this.operation=controller;this.busy=true;this.render();
    try {const commit=await work(controller.signal);if(this.current(epoch)&&!controller.signal.aborted)commit?.();}
    catch(error){if(this.current(epoch)){this.status=messages[controller.signal.aborted?'AI_CANCELLED':error?.code]??messages.AI_UNAVAILABLE;if(error?.code==='AUTH_REQUIRED'){this.authenticated=false;this.history=[];this.snapshot=this.draft=null;}}}
    finally{if(this.current(epoch)){this.busy=false;this.operation=null;this.render();}}
  }
  async checkSession(){await this.run(async signal=>{const session=await this.client.session(signal);return()=>{Object.assign(this,session);if(!session.authenticated){this.history=[];this.input='';this.snapshot=this.draft=null;}this.status=session.enabled?'':'AI 연결을 준비하고 있어요. 지금은 사용할 수 없어요.';};});}
  async login(code){await this.run(async signal=>{const session=await this.client.login(code,signal);return()=>{Object.assign(this,session);this.status='';};});this.dialog?.querySelector('[data-web-ai-message]')?.focus();}
  async logout(){if(this.busy)return;await this.run(async signal=>{await this.client.logout(signal);return()=>{this.authenticated=false;this.history=[];this.input='';this.snapshot=this.draft=null;this.status='AI 체험 연결을 종료했어요.';};});}
  async send(){
    if(!this.authenticated||!this.input.trim())return;
    let history;
    try{history=boundedWebAiMessages(this.history,this.input);}catch{this.status=messages.INVALID_INPUT;this.render();return;}
    this.status='답변을 작성하고 있어요…';
    await this.run(async signal=>{const result=await this.client.chat(history,signal);return()=>{this.history=[...history,{role:'assistant',content:result.text}];this.input='';this.status='';};});
    this.dialog?.querySelector('[data-web-ai-history]')?.lastElementChild?.scrollIntoView({block:'nearest'});this.dialog?.querySelector('[data-web-ai-message]')?.focus();
  }
  async generate(){
    if(!this.snapshot||this.context.role!=='therapist')return;
    if(!sameWebAiSnapshot(this.snapshot,this.getRecord(this.snapshot.recordId))){this.snapshot=this.draft=null;this.status='기록이 바뀌었어요. 다시 선택해 주세요.';this.render();return;}
    const snapshot=structuredClone(this.snapshot);this.status='요약 초안을 작성하고 있어요…';this.draft=null;
    await this.run(async signal=>{const result=await this.client.summary(snapshot.source,signal);return()=>{if(!sameWebAiSnapshot(snapshot,this.getRecord(snapshot.recordId))){this.status='기록이 바뀌어 초안을 적용하지 않았어요. 다시 선택해 주세요.';return;}this.draft=result;this.status='아직 저장하거나 공유하지 않았어요. 내용을 확인한 뒤 작성란에 넣어 주세요.';};});
  }
  async apply(){
    if(this.busy||!this.draft||!this.snapshot||!this.current())return;
    const checked=this.dialog.querySelector('[data-web-ai-replace]');
    if(this.snapshot.originalSummary&&checked?.checked!==true){this.status='기존 요약을 바꿀지 확인해 주세요.';this.render();return;}
    if(!sameWebAiSnapshot(this.snapshot,this.getRecord(this.snapshot.recordId))){this.snapshot=this.draft=null;this.status='기록이 바뀌었어요. 다시 선택해 주세요.';this.render();return;}
    const accepted=this.onApply(this.snapshot,this.draft.summary);
    if(accepted)this.close(false);else{this.status='작성 화면을 열 수 없어요. 다른 입력을 마친 뒤 다시 확인해 주세요.';this.render();}
  }
  render(){
    if(!this.dialog)return;
    const disabled=this.busy?'disabled':'', snapshot=this.snapshot;
    this.dialog.innerHTML=`<header class="web-ai-header"><div><span>OPENAI · 가상 자료 전용</span><h2 id="web-ai-title">AI 도우미</h2></div><button type="button" data-web-ai="close" aria-label="AI 도우미 닫기">닫기</button></header>
      ${this.authenticated?`<div class="web-ai-tabs" role="group" aria-label="AI 기능"><button type="button" data-web-ai="chat" aria-pressed="${this.tab==='chat'}" ${disabled}>자유 대화</button>${this.context.role==='therapist'?`<button type="button" data-web-ai="summary" aria-pressed="${this.tab==='summary'}" ${disabled}>기록 요약</button>`:''}<button type="button" data-web-ai="logout" ${disabled}>연결 종료</button></div>`:''}
      ${!this.authenticated?`<section class="web-ai-gate"><h3>AI 체험 연결</h3><p>제공받은 체험 코드로 연결해 주세요. 화면의 역할 선택과 별도로 확인합니다.</p>${this.enabled?`<form data-web-ai-login><label>체험 코드<input name="accessCode" type="password" autocomplete="off" maxlength="256" required ${disabled}></label><label class="web-ai-check"><input name="synthetic" type="checkbox" required ${disabled}>가상 자료만 입력하며 질문·선택한 기록 내용을 OpenAI로 전송하는 데 동의해요.</label><button class="web-ai-primary" type="submit" ${disabled}>AI 연결</button></form>`:`<button type="button" data-web-ai="retry" ${disabled}>연결 상태 다시 확인</button>`}<p class="web-ai-note">API 키를 이 화면에 입력하지 마세요. 체험 코드는 브라우저에 저장하지 않아요.</p></section>`:
      this.tab==='chat'?`<section class="web-ai-history" data-web-ai-history aria-label="AI 대화">${this.history.length?this.history.map(item=>`<article class="web-ai-bubble ${item.role}"><strong>${item.role==='user'?'나':'AI 도우미'}</strong><p>${escape(item.content)}</p></article>`).join(''):'<div class="web-ai-empty"><h3>무엇을 도와드릴까요?</h3><p>가상 관찰을 정리하거나 궁금한 내용을 물어보세요.</p></div>'}</section><form class="web-ai-compose" data-web-ai-chat><label class="sr-only" for="web-ai-message">AI에게 질문</label><textarea id="web-ai-message" data-web-ai-message maxlength="2000" rows="2" placeholder="AI에게 질문해 보세요" required ${disabled}>${escape(this.input)}</textarea><button class="web-ai-primary" type="submit" ${disabled}>보내기</button></form><p class="web-ai-note">질문과 최근 AI 대화만 보내요. 아동 기록·사진·영상은 자동으로 전송하지 않아요. 대화는 이 페이지를 닫으면 사라져요.</p>`:
      `<section class="web-ai-summary"><label>요약할 가상 기록<select data-web-ai-record ${disabled}><option value="">기록을 선택해 주세요</option>${this.listRecords().map(record=>`<option value="${escape(record.id)}" ${snapshot?.recordId===record.id?'selected':''}>${escape(record.date)} · ${escape(record.title)}</option>`).join('')}</select></label>${snapshot?`<div class="web-ai-source"><h3>OpenAI에 보낼 내용</h3><strong>오늘 한 활동</strong><p>${escape(snapshot.source.performed||'입력 없음')}</p><strong>아이의 반응</strong><p>${escape(snapshot.source.response||'입력 없음')}</p></div>${Object.values(snapshot.source).some(value=>value.trim())?`<button class="web-ai-primary" type="button" data-web-ai="generate" ${disabled}>이 두 항목으로 요약 만들기</button>`:'<p>이 기록에는 활동·반응이 없어요. 기록 작성 화면에서 가상 내용을 입력한 뒤 저장해 주세요.</p>'}`:'<p>기록을 선택하면 전송할 활동·반응 두 항목을 먼저 보여드려요. 내부 메모와 첨부는 보내지 않아요.</p>'}${this.draft?`<div class="web-ai-result"><h3>보호자에게 전할 요약 초안</h3><p data-web-ai-draft>${escape(this.draft.summary)}</p>${this.draft.reviewNotes.length?`<ul>${this.draft.reviewNotes.map(note=>`<li>${escape(note)}</li>`).join('')}</ul>`:''}${snapshot.originalSummary?`<details><summary>기존 요약 보기</summary><p>${escape(snapshot.originalSummary)}</p></details><label class="web-ai-check"><input type="checkbox" data-web-ai-replace>기존 요약을 이 초안으로 바꿀게요.</label>`:''}<button type="button" class="web-ai-primary" data-web-ai="apply" ${disabled}>검토한 초안을 작성란에 넣기</button></div>`:''}</section>`}
      <footer class="web-ai-footer"><p role="status" aria-live="polite">${escape(this.status)}</p>${this.busy?'<button type="button" data-web-ai="cancel">요청 중단</button>':''}</footer>`;
  }
}
