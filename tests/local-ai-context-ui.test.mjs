import test from 'node:test';
import assert from 'node:assert/strict';
import { AiAssistantUi } from '../local-api/ai-assistant-ui.js';

function rendered({ prototypeMode, aiMode, mode, preview, tab='chat', role='therapist', name='하루' } = {}) {
  const original=globalThis.document;
  try {
    globalThis.document={documentElement:{dataset:{prototypeMode,aiMode}}};
    const ui=new AiAssistantUi({api:{},getContext:()=>({})});
    ui.context={role,profile:{name}};ui.records=[];ui.tab=tab;ui.input='';ui.status='';ui.preview=preview;
    ui.conversation=mode?{mode,messages:[],revision:0}:null;ui.dialog={innerHTML:''};
    ui.render();return ui.dialog.innerHTML;
  } finally { globalThis.document=original; }
}

test('prototype first paint identifies the example responder before AI state arrives',()=>{
  const markup=rendered({prototypeMode:'synthetic'});
  assert.match(markup,/합성 응답 검증 모드/);
  assert.match(markup,/시험 응답기에/);
  assert.doesNotMatch(markup,/OpenAI에/);
  assert.match(markup,/연결된 아이 · 하루/);
  assert.match(markup,/아동 기록·사진·영상은 자동으로 보내지 않아요/);
});

test('connected mode metadata overrides the prototype presentation hint',()=>{
  const live=rendered({prototypeMode:'synthetic',mode:'openai'});
  assert.match(live,/OpenAI에/);assert.doesNotMatch(live,/합성 응답 검증 모드/);
  const fixture=rendered({mode:'fixture'});
  assert.match(fixture,/합성 응답 검증 모드/);assert.doesNotMatch(fixture,/OpenAI에/);
});

test('explicit live marker identifies OpenAI before API state arrives in a synthetic prototype',()=>{
  const live=rendered({prototypeMode:'synthetic',aiMode:'openai'});
  assert.match(live,/OpenAI 사용 · 가상 자료 전용/);
  assert.match(live,/OpenAI에/);
  assert.doesNotMatch(live,/합성 응답 검증 모드|시험 응답기에/);
  assert.match(live,/<button class="primary" type="submit" disabled>/);
  const fixture=rendered({aiMode:'fixture'});
  assert.match(fixture,/합성 응답 검증 모드/);
  assert.doesNotMatch(fixture,/OpenAI 사용|OpenAI에/);
});

test('server responses override explicit provider hints in both directions',()=>{
  const live=rendered({prototypeMode:'synthetic',aiMode:'fixture',mode:'openai'});
  assert.match(live,/OpenAI 사용 · 가상 자료 전용/);
  assert.doesNotMatch(live,/합성 응답 검증 모드|시험 응답기에/);
  const fixture=rendered({prototypeMode:'synthetic',aiMode:'openai',mode:'fixture'});
  assert.match(fixture,/합성 응답 검증 모드/);
  assert.doesNotMatch(fixture,/OpenAI 사용|OpenAI에/);
});

test('record preview metadata determines which provider the summary confirmation names',()=>{
  const preview={recordId:'synthetic-record',mode:'openai',source:{performed:'가상 활동',response:'가상 반응'}};
  const live=rendered({aiMode:'fixture',mode:'fixture',preview,tab:'summary'});
  assert.match(live,/위 내용을 OpenAI에 보내 초안 만들기/);
  assert.match(live,/OpenAI 사용 · 가상 자료 전용/);
  assert.doesNotMatch(live,/시험 요약 초안 만들기|합성 응답 검증 모드/);
  const fixture=rendered({aiMode:'openai',mode:'openai',preview:{...preview,mode:'fixture'},tab:'summary'});
  assert.match(fixture,/시험 요약 초안 만들기/);
  assert.doesNotMatch(fixture,/위 내용을 OpenAI에|OpenAI 사용/);
});

test('connected child label is escaped and never grants guardian record controls',()=>{
  const markup=rendered({mode:'fixture',role:'guardian',name:'<img src=x onerror=alert(1)> & 하루'});
  assert.match(markup,/연결된 아이 · &lt;img src=x onerror=alert\(1\)&gt; &amp; 하루/);
  assert.doesNotMatch(markup,/<img src=x/);
  assert.doesNotMatch(markup,/data-ai-action="summary"/);
  assert.doesNotMatch(markup,/data-ai-action="audio"/);
  assert.doesNotMatch(rendered({name:''}),/data-ai-context/);
});
