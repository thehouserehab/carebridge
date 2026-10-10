import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatController } from '../src/chat-controller.js';

// DOM/controller contracts only; real IndexedDB/media/second-tab rendering are
// verified separately in chat-send-lifecycle-browser.mjs.
const deferred = () => Promise.withResolvers();
const draft = (id,body) => ({ clientId:id,body,replyTo:null,attachments:[],entries:[] });
function form(body) {
  const text = { value:body,disabled:false },button = { disabled:false },unavailable = { disabled:true };
  const error = { hidden:true,textContent:'' },attributes = new Map();
  return { text,error,button,unavailable,attributes,
    querySelector:(selector) => selector === 'textarea' ? text : selector === '#chat-error' ? error : null,
    querySelectorAll:() => [text,button,unavailable],
    setAttribute:(key,value) => attributes.set(key,value),removeAttribute:(key) => attributes.delete(key) };
}
function fixture() {
  const gate = deferred(),calls = [],renders = [],saved = new Map();
  const controller = new ChatController({ getState:()=>({}),read:()=>{},mediaStore:{},render:(id)=>renders.push(id),
    commit:async (...args) => { calls.push(args); await gate.promise; } });
  let nextId = 0;
  controller.drafts = { memory:saved,empty:()=>draft(`empty-client-${++nextId}`,''),
    save:async (key,value) => { saved.set(key,structuredClone(value)); },
    async clearSent(key,clientId) { if (saved.get(key)?.clientId !== clientId) return false;
      await this.save(key,this.empty()); return true; } };
  controller.capture = () => controller.drafts.save(controller.key,controller.draft);
  const mount = (childId,clientId,body) => {
    controller.context = { actor:{ id:'synthetic-therapist' },childId };
    controller.key = `synthetic-tab/synthetic-therapist/${childId}`;
    controller.draft = draft(clientId,body); controller.form = form(body);
    controller.editor = { busy:false,disposed:0,dispose() { this.disposed++; } };
    saved.set(controller.key,structuredClone(controller.draft));
    return { key:controller.key,form:controller.form,draft:controller.draft,editor:controller.editor };
  };
  const old = mount('c1','send-client-old','가상 이전 방 소식');
  return { controller,gate,calls,renders,saved,old,mount };
}

test('same composer success saves once and restores originally disabled controls',async () => {
  const f = fixture(),send = f.controller.send();
  assert.equal(f.old.form.text.disabled,true); f.gate.resolve(); await send;
  assert.equal(f.calls.length,1); assert.equal(f.calls[0][1].childId,'c1');
  assert.equal(f.old.form.text.value,''); assert.equal(f.old.form.unavailable.disabled,true);
  assert.equal(f.controller.sending,false); assert.equal(f.old.form.attributes.has('aria-busy'),false);
});
test('late success after remount never clears the other room draft composer or attachment editor',async () => {
  const f = fixture(),send = f.controller.send(); f.controller.stop();
  const other = f.mount('c2','send-client-new','가상 다른 방 미전송 소식');
  f.gate.resolve(); await send;
  assert.equal(other.form.text.value,other.draft.body);
  assert.equal(f.controller.draft.clientId,'send-client-new'); assert.equal(other.editor.disposed,0);
  assert.equal(f.saved.get(other.key).clientId,'send-client-new');
  assert.equal(f.saved.get(f.old.key).body,''); assert.equal(f.renders.length,0);
});
test('late failure is retained for its original room and not shown on a newly mounted room',async () => {
  const f = fixture(),send = f.controller.send(); f.controller.stop();
  const other = f.mount('c2','send-client-new','가상 다른 방 미전송 소식');
  f.gate.reject(new Error('가상 원래 방 전송 실패')); await send;
  assert.equal(other.form.error.hidden,true); assert.equal(other.form.text.value,other.draft.body);
  assert.equal(f.saved.get(f.old.key).clientId,'send-client-old');
  assert.equal(f.controller.sendErrors.get(f.old.key).clientId,'send-client-old');
  assert.equal(f.controller.sendErrors.get(other.key),undefined);
});
test('completion after composer removal cannot manufacture a success error or touch absent DOM',async () => {
  const f = fixture(),send = f.controller.send(); f.controller.stop(); f.gate.resolve(); await send;
  assert.equal(f.saved.get(f.old.key).body,''); assert.equal(f.controller.sending,false);
  assert.equal(f.renders.length,0); assert.equal(f.controller.sendErrors.size,0);
});
test('same room newer client draft survives old completion and input snapshot is independent',async () => {
  const f = fixture(),send = f.controller.send();
  f.old.draft.body = '가상 나중 변경'; f.controller.stop();
  const newer = f.mount('c1','send-client-new','가상 같은 방 다음 소식'); f.gate.resolve(); await send;
  assert.equal(f.calls[0][1].body,'가상 이전 방 소식');
  assert.equal(f.saved.get(newer.key).clientId,'send-client-new');
  assert.equal(newer.form.text.value,'가상 같은 방 다음 소식'); assert.equal(newer.editor.disposed,0);
});
test('duplicate submits remain one operation and same ID retry is preserved after failure',async () => {
  const f = fixture(),send = f.controller.send(); await f.controller.send();
  assert.equal(f.calls.length,1); f.gate.reject(new Error('가상 전송 실패')); await send;
  assert.equal(f.controller.draft.clientId,'send-client-old'); assert.equal(f.old.form.text.value,'가상 이전 방 소식');
  assert.equal(f.old.form.error.textContent,'가상 전송 실패'); assert.equal(f.controller.sending,false);
});
test('remounted pending form unlocks to its own original disabled states after failure',async () => {
  const f = fixture(),send = f.controller.send(); f.controller.stop();
  const same = f.mount('c1','send-client-old','가상 이전 방 소식');
  f.controller.lockForm(same.form); f.controller.lockForm(same.form);
  f.gate.reject(new Error('가상 전송 실패')); await send;
  assert.equal(same.form.text.disabled,false); assert.equal(same.form.unavailable.disabled,true);
  assert.equal(same.form.attributes.has('aria-busy'),false);
  assert.equal(same.form.error.textContent,'가상 전송 실패');
});
test('failed disk cleanup after successful commit is not reported as a send failure',async () => {
  const f = fixture();
  const clear = f.controller.drafts.clearSent;
  f.controller.drafts.clearSent = async function (...args) { await clear.apply(this,args); throw new Error('가상 초안 저장 실패'); };
  const send = f.controller.send(); f.gate.resolve(); await send;
  assert.equal(f.calls.length,1); assert.equal(f.old.form.text.value,'');
  assert.equal(f.old.form.error.hidden,true); assert.equal(f.controller.sendErrors.size,0);
  assert.equal(f.controller.sending,false);
});
test('nested attachment and actor state are captured independently of later changes',async () => {
  const f = fixture(),blob = new Blob(['synthetic'],{ type:'image/png' });
  f.old.draft.attachments = [{ id:'synthetic-file',name:'가상.png',type:blob.type,size:blob.size,share:true }];
  f.old.draft.entries = [['synthetic-file',blob]];
  const send = f.controller.send();
  f.old.draft.attachments[0].name = '가상 나중 변경.png';
  f.old.draft.entries.length = 0; f.controller.context.actor.id = 'synthetic-other';
  assert.equal(f.calls[0][1].attachments[0].name,'가상.png');
  assert.equal(f.calls[0][2].length,1); assert.equal(await f.calls[0][2][0][1].text(),'synthetic');
  assert.equal(f.calls[0][3].id,'synthetic-therapist');
  f.gate.resolve(); await send;
});
