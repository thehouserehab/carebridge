import test from 'node:test';
import assert from 'node:assert/strict';
import { CareUi, CareMutation } from '../local-api/care-ui.js';
import { AiAssistantUi } from '../local-api/ai-assistant-ui.js';
import { AudioNotesUi, audioNotesAvailable } from '../local-api/audio-notes-ui.js';

const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return{promise,resolve};};
const fieldNames=['performed','response','privateNote','nextPlan','summary'];
const saved=()=>({id:'test-record',revision:2,conversationId:'test-room',status:'saved',date:'2026-11-16',title:'합성 수업',
  goalId:'test-goal',performed:'기존 활동',response:'',privateNote:'기존 내부 메모',nextPlan:'',summary:'기존 보호자 요약',
  observation:null,activity:null,assessments:[],referenceSources:[],attachmentCount:0});
const draft={recordId:'test-record',revision:2,fields:{performed:'합성 활동',response:'합성 반응',privateNote:'합성 확인 질문',nextPlan:'합성 다음 준비',summary:'합성 보호자 요약'}};
const selection=(keys,overwriteConfirmed=false)=>({fields:keys,expectedValues:Object.fromEntries(keys.map(key=>[key,saved()[key]])),reviewed:true,overwriteConfirmed});

function fixture(api={}){
  let context={user:{userId:'test-user',centers:[{id:'test-center',role:'therapist'}]},role:'therapist',centerId:'test-center',roomId:'test-room',
    generation:1,connected:true,signal:new AbortController().signal,messages:[]};
  const errors=[],ui=new CareUi({api:{record:async()=>saved(),...api},getContext:()=>context,onError:error=>errors.push(error)});
  ui.key=JSON.stringify([context.user.userId,context.centerId,context.roomId]);
  const state={mutation:new CareMutation(),records:[{id:'test-record'}],goals:[{id:'test-goal'}],loaded:true,view:null};ui.states.set(ui.key,state);
  let form=null,events=0;const notice={textContent:''};
  ui.dialog={open:false,querySelector:selector=>['form','[data-care-form="record"]'].includes(selector)?form:selector==='[data-care-error]'?notice:null,
    querySelectorAll:()=>[],close(){this.open=false;},replaceChildren(){form=null;}};
  ui.render=()=>{};ui.display=()=>{
    const inputs=Object.fromEntries(['date','title','goalId',...fieldNames].map(key=>[key,{value:state.view.values[key]??'',parentElement:null,
      dispatchEvent(event){assert.equal(event.type,'input');events++;}}]));
    form={elements:{namedItem:key=>inputs[key]??null},querySelectorAll:()=>[]};ui.dialog.open=true;
  };
  const controller=new AbortController();let current=true;
  const operation={signal:controller.signal,isCurrent:()=>current};
  return{ui,state,controller,operation,errors,get context(){return context;},setContext(value){context=value;},deactivate(){current=false;},
    input:key=>form?.elements.namedItem(key),get events(){return events;},apply:(selected=selection(['response','nextPlan']),value=draft)=>ui.applyAiAudio(value,selected,context,operation)};
}

test('reviewed audio applies only selected empty fields and never saves or shares',async()=>{
  const f=fixture({recordSave:()=>assert.fail('must not save'),recordPublish:()=>assert.fail('must not share')});
  assert.equal(await f.apply(),true);assert.equal(f.events,2);
  assert.equal(f.input('response').value,draft.fields.response);assert.equal(f.input('nextPlan').value,draft.fields.nextPlan);
  for(const key of ['performed','summary','privateNote'])assert.equal(f.input(key).value,saved()[key]);
  assert.equal(f.state.mutation.operation,null);
});

test('existing text requires explicit replacement confirmation before any read',async()=>{
  const f=fixture({record:()=>assert.fail('must not begin read')});
  assert.equal(await f.apply(selection(['summary'])),false);assert.equal(f.events,0);
});

test('explicit replacement changes only selected fields and preserves internal/public separation',async()=>{
  const f=fixture();assert.equal(await f.apply(selection(['summary'],true)),true);
  assert.equal(f.input('summary').value,draft.fields.summary);assert.equal(f.input('privateNote').value,saved().privateNote);
  assert.equal(f.events,1);
});

test('unreviewed, unknown, duplicated and excessive field selections are rejected',async()=>{
  for(const selected of [{...selection(['response']),reviewed:false},{...selection(['response']),fields:['response','response']},
    {fields:['appointmentId'],expectedValues:{appointmentId:''},reviewed:true,overwriteConfirmed:false},
    {...selection(['response']),expectedValues:{response:'',secret:'unexpected'}}]){
    const f=fixture({record:()=>assert.fail('must not read')});assert.equal(await f.apply(selected),false);
  }
  const f=fixture({record:()=>assert.fail('must not read')});
  assert.equal(await f.apply(selection(['response']),{...draft,fields:{...draft.fields,response:'x'.repeat(2001)}}),false);
});

test('existing unsaved forms block audio application',async()=>{
  const f=fixture({record:()=>assert.fail('must not read')});const existing={kind:'record',values:{response:'작성 중인 글'}};f.state.view=existing;
  assert.equal(await f.apply(),false);assert.equal(f.state.view,existing);
});

for(const changes of [{revision:3},{response:'다른 창에서 고친 반응'}])test('changed saved record blocks stale audio application '+Object.keys(changes)[0],async()=>{
  const f=fixture({record:async()=>({...saved(),...changes})});assert.equal(await f.apply(),false);assert.equal(f.events,0);assert.equal(f.state.view,null);
});

test('manual edits while the record opens survive audio application attempt',async()=>{
  const f=fixture(),open=f.ui.handleAction.bind(f.ui);
  f.ui.handleAction=async(...args)=>{const view=await open(...args);f.input('response').value='직접 적은 반응';return view;};
  assert.equal(await f.apply(),false);assert.equal(f.input('response').value,'직접 적은 반응');assert.equal(f.ui.dialog.open,true);assert.equal(f.events,0);
});

for(const change of ['cancel','context','inactive'])test('slow audio application respects '+change,async()=>{
  const gate=deferred(),f=fixture({record:async()=>gate.promise});const pending=f.apply();
  if(change==='cancel')f.controller.abort();else if(change==='context')f.setContext({...f.context,generation:2});else f.deactivate();
  gate.resolve(saved());assert.equal(await pending,false);assert.equal(f.state.view,null);assert.equal(f.events,0);
});

test('guardian role cannot apply audio even with a prepared draft',async()=>{
  const f=fixture({record:()=>assert.fail('must not read')});f.setContext({...f.context,role:'guardian',user:{...f.context.user,centers:[{id:'test-center',role:'guardian'}]}});
  assert.equal(await f.apply(),false);
});

test('audio entry exists only for synthetic runtime and therapist role',()=>{
  const original=globalThis.document;
  try{
    for(const [mode,role,expected] of [['synthetic','therapist',true],['synthetic','guardian',false],['','therapist',false]]){
      globalThis.document={documentElement:{dataset:{audioNotesMode:mode}}};
      const ai=new AiAssistantUi({api:{},getContext:()=>({})});ai.context={role};ai.records=[];ai.dialog={innerHTML:''};ai.render();
      assert.equal(ai.dialog.innerHTML.includes('data-ai-action="audio"'),expected);
      assert.equal(audioNotesAvailable({role}),expected);
    }
  }finally{globalThis.document=original;}
});

const analysisResult={transcript:{text:'합성 놀이를 해요.',durationSeconds:2,segments:[{id:0,start:0,end:2,text:'합성 놀이를 해요.'}]},
  analysis:{performed:[{text:'합성 활동',segmentIds:[0]}],response:[{text:'합성 반응',segmentIds:[0]}],reflection:[{text:'확인 질문',segmentIds:[0]}],
    nextPlan:[],summary:[{text:'보호자 요약',segmentIds:[0]}],warnings:[]}};
const audioSession={id:'test-audio',recordId:'test-record',recordRevision:2,revision:3,state:'ready',result:analysisResult};
function audioFixture(){
  let context={user:{userId:'test-user'},role:'therapist',centerId:'test-center',roomId:'test-room',generation:1,connected:true,signal:new AbortController().signal};
  let applied=0;const ui=new AudioNotesUi({api:{},getContext:()=>context,onApply:async()=>{applied++;return true;}});
  ui.context=context;ui.scope=JSON.stringify([context.user.userId,context.centerId,context.roomId,context.role,context.generation]);
  ui.dialog={open:true,close(){this.open=false;},remove(){}};ui.render=()=>{};ui.record=saved();ui.sessions=[];ui.selection=new Set();ui.adopt(audioSession);
  return{ui,get applied(){return applied;},setContext(value){context=value;},get context(){return context;}};
}
test('audio review defaults only empty fields, and replaced fields need separate confirmation',()=>{
  const f=audioFixture();assert.deepEqual([...f.ui.selection],['response']);assert.equal(f.ui.canApply(),false);
  f.ui.reviewed=true;assert.equal(f.ui.canApply(),true);f.ui.selection.add('summary');assert.equal(f.ui.canApply(),false);
  f.ui.overwriteConfirmed=true;assert.equal(f.ui.canApply(),true);f.ui.close(false);
});

test('closing or switching workspace blocks a late audio approval before record application',async()=>{
  const original=globalThis.document;globalThis.document={documentElement:{dataset:{audioNotesMode:'synthetic'}}};
  try{
    for(const action of ['close','switch']){
      const f=audioFixture(),gate=deferred();f.ui.reviewed=true;f.ui.client.get=async()=>gate.promise;
      const pending=f.ui.apply();if(action==='close')f.ui.close(false);else f.setContext({...f.context,generation:2});
      gate.resolve(audioSession);await pending;assert.equal(f.applied,0);f.ui.close(false);
    }
  }finally{globalThis.document=original;}
});

test('a late processing poll cannot replace a newer cancellation state',async()=>{
  const original=globalThis.document;globalThis.document={documentElement:{dataset:{audioNotesMode:'synthetic'}}};
  try{
    const f=audioFixture(),gate=deferred();f.ui.session={...audioSession,state:'processing',revision:2,result:null};
    f.ui.client.get=async()=>gate.promise;const pending=f.ui.poll();
    f.ui.session={...audioSession,state:'cancelled',revision:3,result:null};gate.resolve({...audioSession,state:'processing',revision:2,result:null});
    await pending;assert.equal(f.ui.session.state,'cancelled');assert.equal(f.ui.session.revision,3);f.ui.close(false);
  }finally{globalThis.document=original;}
});
