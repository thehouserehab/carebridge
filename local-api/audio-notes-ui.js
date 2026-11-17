import { AudioNotesClient } from './audio-notes-client.js';
import { LocalApiError } from './client.js';
import { AUDIO_NOTE_MAX_BYTES, normalizeAudioNoteFile, audioNoteFields } from '../src/audio-note-contract.js';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const scope=value=>JSON.stringify([value?.user?.userId,value?.centerId,value?.roomId,value?.role,value?.generation]);
const fields={performed:'오늘 한 활동',response:'아이의 반응',privateNote:'치료사 내부 메모',nextPlan:'다음 수업 준비',summary:'보호자 보고서'};
const states={uploaded:'업로드 완료',processing:'전사·초안 작성 중',ready:'검토할 초안',failed:'처리 실패',cancelled:'처리 취소'};
const errors={AI_UNAVAILABLE:'녹음 분석 연결이 준비되지 않았어요.',AI_BUSY:'다른 녹음을 처리하고 있어요. 완료 후 다시 확인해 주세요.',
  AI_LIMIT:'이번 시험의 녹음 또는 호출 한도에 도달했어요.',AI_SOURCE_CHANGED:'기록이나 녹음 상태가 바뀌었어요. 최신 내용을 다시 확인해 주세요.',
  AI_REQUEST_FAILED:'결과를 확인하지 못했어요. 자동으로 다시 전송하지 않습니다.',INVALID_INPUT:'녹음의 형식·크기와 확인 항목을 확인해 주세요.',
  IDEMPOTENCY_CONFLICT:'이미 처리한 요청이에요. 현재 상태를 다시 확인해 주세요.',CANCELLED:'화면 요청을 취소했어요.'};
const time=value=>`${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`;
export const audioNotesAvailable=context=>context?.role==='therapist' &&
  globalThis.document?.documentElement?.dataset.audioNotesMode==='synthetic';

// The original, generated transcript and suggestions remain separate. This UI
// never writes a clinical record or publishes to a guardian.
export class AudioNotesUi {
  constructor({api,getContext,onApply,onDismiss=()=>false,onError=()=>{}}) {
    this.api=api;this.client=new AudioNotesClient(api);this.getContext=getContext;this.onApply=onApply;this.onDismiss=onDismiss;this.onError=onError;
    this.dialog=null;this.epoch=0;this.urls=new Set();
  }
  current(token=this.epoch) {
    const context=this.getContext();
    return token===this.epoch && !!this.dialog?.open && audioNotesAvailable(context) && context.connected &&
      !context.signal?.aborted && scope(context)===this.scope;
  }
  sync() { if(this.dialog?.open&&!this.current())this.close(false); }
  close(restore=true) {
    const wasOpen=this.dialog?.open===true;
    this.epoch++;clearTimeout(this.pollTimer);this.pollTimer=null;this.pollController?.abort();this.pollController=null;
    this.operation?.abort();this.operation=null;this.dialog?.close();this.dialog?.remove();this.dialog=null;
    for(const url of this.urls)URL.revokeObjectURL(url);this.urls.clear();
    this.records=[];this.sessions=[];this.record=null;this.session=null;this.file=null;this.selection=new Set();this.busy=false;
    if(restore&&wasOpen&&this.onDismiss()!==true&&this.returnFocus?.isConnected)this.returnFocus.focus();
  }
  async open() {
    const context=this.getContext();
    if(!audioNotesAvailable(context)||!context.connected||!context.roomId)return;
    this.close(false);this.context=context;this.scope=scope(context);this.returnFocus=document.activeElement;
    this.status='저장 기록을 불러오고 있어요…';this.syntheticConfirmed=false;this.processingConfirmed=false;
    this.reviewed=false;this.overwriteConfirmed=false;this.deletePending=false;
    const dialog=document.createElement('dialog');dialog.className='ai-assistant audio-notes';dialog.setAttribute('aria-labelledby','audio-notes-title');
    dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
    dialog.addEventListener('change',event=>void this.change(event));
    dialog.addEventListener('click',event=>{
      const button=event.target.closest('[data-audio-action]');if(!button)return;
      const action=button.dataset.audioAction;
      if(action==='close')this.close();
      else if(action==='upload')void this.upload();
      else if(action==='start'||action==='cancel')void this.process(action);
      else if(action==='refresh')void this.refresh();
      else if(action==='download')void this.download();
      else if(action==='delete'){this.deletePending=!this.deletePending;this.render();}
      else if(action==='remove')void this.remove();
      else if(action==='apply')void this.apply();
      else if(action==='segment'){
        const details=this.dialog.querySelector('[data-audio-details="transcript"]');if(details)details.open=true;
        const segment=this.dialog.querySelector(`[data-audio-segment="${Number(button.dataset.segmentId)}"]`);
        segment?.focus();segment?.scrollIntoView({block:'nearest'});
      }
    });
    document.body.append(dialog);this.dialog=dialog;this.render();dialog.showModal();
    await this.run(async signal=>{
      const records=await this.api.records(context.centerId,context.roomId,signal);
      return()=>{this.records=records;this.status=records.length?'':'먼저 해당 수업의 기록을 저장해 주세요. 일정에서 기록을 만들면 캘린더 연결을 유지할 수 있어요.';};
    });
    this.dialog?.querySelector('[data-audio-record]')?.focus();
  }
  async run(work) {
    if(this.busy||!this.current())return;
    const token=this.epoch,controller=new AbortController();this.operation=controller;this.busy=true;this.render();
    const signal=AbortSignal.any([controller.signal,this.context.signal]);
    try {const commit=await work(signal);if(this.current(token)&&!signal.aborted)commit?.();}
    catch(error){
      if(!this.current(token))return;
      if(['AUTH_REQUIRED','FORBIDDEN','NOT_FOUND'].includes(error.code)){
        this.close(false);this.onError('열람 권한이 바뀌어 녹음 화면을 닫았어요.');return;
      }
      this.status=errors[signal.aborted?'CANCELLED':error.code]??'결과를 확인하지 못했어요. 현재 상태를 다시 확인해 주세요. 자동 재전송하지 않습니다.';
    } finally {if(this.current(token)){this.operation=null;this.busy=false;this.render();this.schedulePoll();}}
  }
  async change(event) {
    if(this.busy)return;
    const target=event.target;
    if(target.matches('[data-audio-record]')){await this.selectRecord(target.value);return;}
    if(target.matches('[data-audio-session]')){this.adopt(this.sessions.find(item=>item.id===target.value)??null);this.render();this.schedulePoll();return;}
    if(target.matches('[data-audio-file]')){
      const file=target.files?.[0];if(!file)return;
      try {normalizeAudioNoteFile({filename:file.name,type:file.type});if(file.size<1||file.size>AUDIO_NOTE_MAX_BYTES)throw new Error();this.file=file;this.status='';}
      catch{this.file=null;this.status='M4A·MP3·WAV·WebM 녹음 파일 1개, 20MB 이하로 선택해 주세요.';}
      this.render();return;
    }
    if(target.matches('[data-audio-check]')){
      const key=target.dataset.audioCheck;if(['syntheticConfirmed','processingConfirmed','reviewed','overwriteConfirmed'].includes(key))this[key]=target.checked;
      this.updateButtons();return;
    }
    if(target.matches('[data-audio-field]')){
      if(target.checked)this.selection.add(target.dataset.audioField);else this.selection.delete(target.dataset.audioField);
      this.overwriteConfirmed=false;this.render();
    }
  }
  async selectRecord(recordId) {
    if(this.busy)return;
    clearTimeout(this.pollTimer);this.pollController?.abort();this.pollController=null;
    this.record=null;this.session=null;this.sessions=[];this.file=null;this.selection=new Set();this.status='';
    this.syntheticConfirmed=false;this.processingConfirmed=false;this.reviewed=false;this.overwriteConfirmed=false;
    if(!this.records.some(record=>record.id===recordId)){this.render();return;}
    await this.run(async signal=>{
      const record=await this.api.record(this.context.centerId,this.context.roomId,recordId,signal);
      const sessions=await this.client.list(this.context,recordId,signal);
      return()=>{this.record=record;this.sessions=sessions;this.adopt(sessions.at(-1)??null);};
    });
  }
  adopt(session) {
    const changed=this.session?.id!==session?.id||this.session?.revision!==session?.revision;
    this.session=session;this.deletePending=false;
    if(session)this.sessions=this.sessions.some(item=>item.id===session.id)?this.sessions.map(item=>item.id===session.id?session:item):[...this.sessions,session];
    if(changed){
      this.reviewed=false;this.overwriteConfirmed=false;this.selection=new Set();
      if(session?.state==='ready'){
        const suggested=audioNoteFields(session.result);
        for(const key of Object.keys(fields))if(suggested[key].trim()&&!String(this.record?.[key]??'').trim())this.selection.add(key);
      }
    }
  }
  async upload() {
    if(!this.record||!this.file||!this.syntheticConfirmed||!this.processingConfirmed||this.busy)return;
    const record=this.record,file=this.file;this.status='가상 녹음을 업로드하고 있어요…';
    await this.run(async signal=>{
      const session=await this.client.upload(this.context,record,file,{syntheticConfirmed:true,processingConfirmed:true},crypto.randomUUID(),signal);
      return()=>{this.adopt(session);this.file=null;this.status='업로드했어요. 분석 버튼을 누르면 녹음과 전사문을 처리합니다.';};
    });
  }
  async process(action) {
    if(!this.session||this.busy)return;
    const session=this.session;
    if(action==='start'&&session.state!=='uploaded')return;
    if(action==='cancel'&&session.state!=='processing')return;
    this.status=action==='start'?'전사·초안 작성을 시작하고 있어요…':'중단을 요청하고 있어요…';
    await this.run(async signal=>{
      const changed=await this.client.change(this.context,session,action,crypto.randomUUID(),signal);
      return()=>{this.adopt(changed);this.status=action==='start'?'처리 중에는 이 화면을 닫아도 서버 작업이 계속될 수 있어요. 중단하려면 ‘분석 중단’을 눌러 주세요.':'중단 상태를 확인했어요. 이미 전송된 요청에는 비용이 발생할 수 있어요.';};
    });
  }
  schedulePoll() {
    clearTimeout(this.pollTimer);this.pollTimer=null;
    if(!this.current()||this.busy||this.session?.state!=='processing'||this.pollController)return;
    this.pollTimer=setTimeout(()=>{this.pollTimer=null;void this.poll();},1000);
  }
  async poll() {
    if(!this.current()||this.busy||this.session?.state!=='processing')return;
    const token=this.epoch,session=this.session,controller=new AbortController();this.pollController=controller;
    const signal=AbortSignal.any([controller.signal,this.context.signal]);
    let again=true;
    try {
      const current=await this.client.get(this.context,session.recordId,session.id,signal);
      if(!this.current(token)||signal.aborted||this.session?.id!==session.id)return;
      if(current.revision<this.session.revision)return;
      if(current.revision!==this.session.revision){
        this.adopt(current);this.status=current.state==='ready'?'초안이 준비됐어요. 원문과 대조한 뒤 적용할 항목을 선택해 주세요.':
          current.state==='failed'?'처리를 완료하지 못했어요. 자동 재시도하지 않습니다.':current.state==='cancelled'?'분석이 중단됐어요.':this.status;
        this.render();
      }
    }catch(error){
      again=false;if(!this.current(token)||signal.aborted)return;
      if(['AUTH_REQUIRED','FORBIDDEN','NOT_FOUND'].includes(error.code)){this.close(false);this.onError('열람 권한이 바뀌어 녹음 화면을 닫았어요.');return;}
      this.status='처리 상태를 확인하지 못했어요. ‘상태 다시 확인’을 눌러 주세요. 분석을 중복 요청하지 않습니다.';this.render();
    }finally{if(this.pollController===controller)this.pollController=null;if(again&&this.current(token))this.schedulePoll();}
  }
  async refresh() {
    if(!this.session||this.busy)return;
    const session=this.session;
    await this.run(async signal=>{
      const current=await this.client.get(this.context,session.recordId,session.id,signal);
      return()=>{if(this.session?.id===current.id&&current.revision>=this.session.revision)this.adopt(current);this.status='현재 상태를 확인했어요.';};
    });
  }
  async download() {
    if(!this.session||this.busy)return;
    const session=this.session;
    await this.run(async signal=>{
      const bytes=await this.client.original(this.context,session,signal);
      return()=>{
        const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));this.urls.add(url);
        const anchor=document.createElement('a');anchor.href=url;anchor.download='carebridge-synthetic-'+session.id+'.'+({
          'audio/mp4':'m4a','audio/mpeg':'mp3','audio/wav':'wav','audio/webm':'webm'}[session.type]);
        document.body.append(anchor);anchor.click();anchor.remove();
        setTimeout(()=>{URL.revokeObjectURL(url);this.urls.delete(url);},1000);
        this.status='서버 수신본의 해시를 대조한 뒤 다운로드를 요청했어요. 녹음의 진위나 법적 증거 효력을 인증하는 기능은 아닙니다.';
      };
    });
  }
  async remove() {
    if(!this.session||!this.deletePending||this.busy)return;
    const session=this.session;
    await this.run(async signal=>{
      await this.client.remove(this.context,session,signal);
      return()=>{this.sessions=this.sessions.filter(item=>item.id!==session.id);this.adopt(this.sessions.at(-1)??null);this.status='시험 녹음과 생성 결과를 삭제했어요. 이미 별도로 저장한 치료 기록은 유지됩니다.';};
    });
  }
  overwriteKeys() {return [...this.selection].filter(key=>String(this.record?.[key]??'').trim());}
  canApply() {return !this.busy&&this.session?.state==='ready'&&this.record?.revision===this.session.recordRevision&&
    this.reviewed&&this.selection.size>0&&(!this.overwriteKeys().length||this.overwriteConfirmed);}
  async apply() {
    if(!this.canApply())return;
    const token=this.epoch,session=this.session,record=this.record,selected=[...this.selection];
    const draft={recordId:session.recordId,revision:session.recordRevision,fields:audioNoteFields(session.result)};
    const selection={fields:selected,expectedValues:Object.fromEntries(selected.map(key=>[key,record[key]??''])),
      overwriteConfirmed:this.overwriteConfirmed,reviewed:true};
    await this.run(async signal=>{
      const latest=await this.client.get(this.context,session.recordId,session.id,signal);
      if(latest.state!=='ready'||latest.revision!==session.revision)throw new LocalApiError('AI_SOURCE_CHANGED');
      const isCurrent=()=>this.current(token)&&!signal.aborted;
      if(!isCurrent())return;
      const accepted=await this.onApply(draft,selection,this.context,{signal,isCurrent});
      if(!accepted)throw new LocalApiError('AI_SOURCE_CHANGED');
      return()=>{this.close(false);document.querySelector(`[data-care-form="record"] [name="${selected[0]}"]`)?.focus();};
    });
  }
  updateButtons() {
    const upload=this.dialog?.querySelector('[data-audio-action="upload"]');if(upload)upload.disabled=this.busy||!this.file||!this.syntheticConfirmed||!this.processingConfirmed;
    const apply=this.dialog?.querySelector('[data-audio-action="apply"]');if(apply)apply.disabled=!this.canApply();
  }
  claims(items) {
    return items.length?`<ul>${items.map(claim=>`<li>${escape(claim.text)}<span class="audio-evidence">${claim.segmentIds.map(id=>{
      const segment=this.session.result.transcript.segments[id];return `<button type="button" data-audio-action="segment" data-segment-id="${id}">${time(segment.start)} 원문</button>`;
    }).join('')}</span></li>`).join('')}</ul>`:'<p class="small muted">녹음에서 확인한 내용이 없어요.</p>';
  }
  render() {
    if(!this.dialog)return;
    const body=this.dialog.querySelector('.audio-body'),scroll=body?.scrollTop??0;
    const opened=new Set([...this.dialog.querySelectorAll('[data-audio-details][open]')].map(node=>node.dataset.audioDetails));
    const active=document.activeElement,focusKey=active?.dataset?.audioField;
    const session=this.session,disabled=this.busy?'disabled':'',result=session?.result,generated=result?audioNoteFields(result):null;
    const overwrite=this.overwriteKeys();
    const prototype=globalThis.document?.documentElement?.dataset.prototypeMode==='synthetic';
    this.dialog.innerHTML=`<header class="ai-head"><div><p class="eyebrow">AI 기록 도우미</p><h2 id="audio-notes-title">녹음 정리</h2></div><button type="button" data-audio-action="close" aria-label="녹음 정리 닫기">닫기</button></header>
      <p class="audio-scope" role="note">${prototype?'프로토타입 · 제공된 가상 녹음의 예시 결과를 보여드려요. 외부 AI 호출은 없어요.':'가상 녹음 전용 · 서버 종료 시 녹음과 분석 결과가 삭제됩니다.'}</p>
      <div class="audio-body"><label class="audio-label">연결할 저장 기록<select data-audio-record ${disabled}><option value="">기록 선택</option>${this.records.map(record=>`<option value="${escape(record.id)}" ${this.record?.id===record.id?'selected':''}>${escape(record.date)} · ${escape(record.title||'제목 없는 기록')}</option>`).join('')}</select></label>
      ${this.record?`<section class="audio-upload" aria-label="가상 녹음 업로드"><h3>녹음 파일 올리기</h3><p class="small muted">${prototype?'샘플 폴더의 carebridge-demo-session.wav를 선택하세요.':'M4A·MP3·WAV·WebM 1개 · 20MB 이하'}</p><label class="audio-label">파일 선택<input type="file" data-audio-file accept="${prototype?'.wav,audio/wav':'.m4a,.mp3,.wav,.webm,audio/mp4,audio/mpeg,audio/wav,audio/webm'}" ${disabled}></label><p class="audio-file">${this.file?escape(this.file.name):'선택한 파일 없음'}</p>
        <label class="audio-check"><input type="checkbox" data-audio-check="syntheticConfirmed" ${this.syntheticConfirmed?'checked':''} ${disabled}>실제 아동·사람·개인정보가 없는 가상 녹음이에요.</label>
        <label class="audio-check"><input type="checkbox" data-audio-check="processingConfirmed" ${this.processingConfirmed?'checked':''} ${disabled}>${prototype?'외부 AI 호출 없이 제공된 샘플의 예시 결과를 확인하는 시연임을 이해했어요.':'분석 시 녹음·전사문을 OpenAI로 전송하며 비용이 발생할 수 있음을 확인했어요.'}</label>
        <p class="small muted">${prototype?'녹음 정리 → 검토 → 기록 반영을 시연할 수 있어요.':'국내 처리나 법적 보관을 보장하지 않습니다. 실제 녹음 동의를 받는 절차를 대신하지 않습니다.'}</p><button type="button" class="primary" data-audio-action="upload">가상 녹음 업로드</button></section>`:''}
      ${this.sessions.length?`<label class="audio-label">이 기록의 시험 녹음<select data-audio-session ${disabled}>${this.sessions.map(item=>`<option value="${escape(item.id)}" ${item.id===session?.id?'selected':''}>${escape(item.filename)} · ${states[item.state]}</option>`).join('')}</select></label>`:''}
      ${session?`<section class="audio-source" aria-label="원본 녹음 정보"><h3>${escape(session.filename)}</h3><p class="audio-status">${states[session.state]}${session.mode==='fixture'?' · 합성 응답 시험':''}</p>${prototype&&session.state==='failed'?'<p role="alert">제공된 carebridge-demo-session.wav 샘플인지 확인해 주세요.</p>':''}<p class="small muted">${(session.size/1024/1024).toFixed(1)}MB · 서버 수신 ${escape(new Date(session.receivedAt).toLocaleString('ko-KR'))}</p>
        <details data-audio-details="source"><summary>원본 식별·처리 이력</summary><p class="small muted">수신 시각은 실제 녹음 시각과 다를 수 있어요. 해시는 수신한 파일이 바뀌었는지 확인하는 값입니다.</p><code>${escape(session.sha256)}</code><ul>${session.events.map(event=>`<li>${escape(event.kind)} · ${escape(new Date(event.at).toLocaleString('ko-KR'))}</li>`).join('')}</ul><button type="button" data-audio-action="download" ${disabled}>시험 원본 다운로드</button></details>
        <div class="audio-actions">${session.state==='uploaded'?`<button class="primary" type="button" data-audio-action="start" ${disabled}>${session.mode==='fixture'?'합성 응답으로 분석':'OpenAI로 전사·초안 만들기'}</button>`:''}${session.state==='processing'?`<button type="button" data-audio-action="cancel" ${disabled}>분석 중단</button>`:''}<button type="button" data-audio-action="refresh" ${disabled}>상태 다시 확인</button><button type="button" data-audio-action="delete" ${disabled}>시험 녹음 삭제</button></div>
        ${session.state==='processing'?'<p class="small muted">닫아도 서버 작업은 계속될 수 있어요. 중단하려면 분석 중단을 눌러 주세요.</p>':''}
        ${this.deletePending?`<div class="audio-delete"><p>이 시험 녹음과 전사·초안을 삭제할까요? 별도로 저장한 기록은 유지됩니다.</p><button type="button" data-audio-action="remove" ${disabled}>녹음과 초안 삭제</button></div>`:''}
      </section>`:''}
      ${result?`<section class="audio-results" aria-label="녹음 분석 초안"><p class="audio-scope">AI 초안 · 녹음에 들리는 사실만 참고하며, 치료의 적절성·효과를 판정하지 않습니다.</p>
        <details data-audio-details="transcript"><summary>시간별 전사 원문 확인</summary><p class="small muted">발언자의 신원·역할을 자동 확정하지 않습니다. 잘못 들린 내용은 원본과 대조해 주세요.</p><ol class="audio-transcript">${result.transcript.segments.map(segment=>`<li tabindex="-1" data-audio-segment="${segment.id}"><span>${time(segment.start)}–${time(segment.end)}</span><p>${escape(segment.text)}</p></li>`).join('')}</ol></details>
        <h3>수업 활동·반응</h3><h4>오늘 한 활동</h4>${this.claims(result.analysis.performed)}<h4>아이의 반응</h4>${this.claims(result.analysis.response)}
        <details data-audio-details="internal" open><summary>치료사 검토·다음 수업 준비</summary><h4>확인할 질문</h4>${this.claims(result.analysis.reflection)}<h4>다음 수업 준비</h4>${this.claims(result.analysis.nextPlan)}${result.analysis.warnings.length?`<h4>확인 필요</h4><ul>${result.analysis.warnings.map(warning=>`<li>${escape(warning)}</li>`).join('')}</ul>`:''}</details>
        <h3>보호자 보고서 초안</h3>${this.claims(result.analysis.summary)}<p class="small muted">아직 보호자에게 공개하지 않았어요. 기존 공유 미리보기에서 확인한 내용만 전달됩니다.</p>
        <fieldset class="audio-fields"><legend>기록에 적용할 항목</legend><p class="small muted">빈 항목만 기본 선택합니다. 기존 글을 바꾸려면 해당 항목을 직접 선택해 주세요.</p>${Object.entries(fields).map(([key,label])=>`<label class="audio-check"><input type="checkbox" data-audio-field="${key}" ${this.selection.has(key)?'checked':''} ${this.busy||!generated[key].trim()?'disabled':''}>${label}${String(this.record?.[key]??'').trim()?' · 기존 글 있음':''}</label>`).join('')}</fieldset>
        ${overwrite.length?`<section class="audio-overwrite" aria-label="바뀔 기록 확인"><h4>선택한 기존 글이 바뀝니다</h4>${overwrite.map(key=>`<details data-audio-details="replace-${key}"><summary>${fields[key]} · 변경 전·후</summary><strong>기존 글</strong><p>${escape(this.record[key])}</p><strong>적용할 초안</strong><p>${escape(generated[key])}</p></details>`).join('')}<label class="audio-check"><input type="checkbox" data-audio-check="overwriteConfirmed" ${this.overwriteConfirmed?'checked':''} ${disabled}>위 항목의 기존 글을 선택한 초안으로 바꾸겠습니다.</label></section>`:''}
        ${this.record?.revision!==session.recordRevision?'<p role="alert">연결 기록이 변경되어 이 초안을 적용할 수 없어요. 최신 기록으로 새 시험 녹음을 준비해 주세요.</p>':''}
        <label class="audio-check"><input type="checkbox" data-audio-check="reviewed" ${this.reviewed?'checked':''} ${disabled}>전사 원문과 초안을 대조했고 적용할 내용을 확인했어요.</label>
        <button type="button" class="primary" data-audio-action="apply">선택한 초안을 기록 작성란에 넣기</button><p class="small muted">작성란에서 수정한 뒤 저장·공유하세요. 자동 저장·전송하지 않습니다.</p>
      </section>`:''}</div>
      <footer class="ai-footer"><p role="status" data-audio-status>${escape(this.status)}</p></footer>`;
    for(const details of this.dialog.querySelectorAll('[data-audio-details]'))if(opened.has(details.dataset.audioDetails))details.open=true;
    const nextBody=this.dialog.querySelector('.audio-body');if(nextBody)nextBody.scrollTop=scroll;
    if(focusKey)this.dialog.querySelector(`[data-audio-field="${focusKey}"]`)?.focus({preventScroll:true});
    this.updateButtons();
  }
}
