import test from 'node:test';
import assert from 'node:assert/strict';
import {MEDIA_WORKER_STAGE_NAMES,captureMediaWorkerObserver,observeMediaStage} from '../media-worker-observation.mjs';
const tick = () => new Promise((yes) => setImmediate(yes));

test('the diagnostic vocabulary is fixed, ordered and immutable',() => {
  assert.deepEqual(MEDIA_WORKER_STAGE_NAMES,[
    'db-open','worker-admission','retained-recovery','object-cleanup','queue-claim',
    'source-open','source-scan','source-reopen','isolated-preparation','candidate-validation',
    'candidate-scan','candidate-write','candidate-verify','settlement','db-close',
  ]);
  assert.ok(Object.isFrozen(MEDIA_WORKER_STAGE_NAMES));
  assert.throws(() => MEDIA_WORKER_STAGE_NAMES.push('private'),TypeError);
});

test('optional capture accepts only a trusted function, null or undefined',() => {
  const observer = () => {};
  assert.equal(captureMediaWorkerObserver(observer),observer);
  assert.equal(captureMediaWorkerObserver(null),null); assert.equal(captureMediaWorkerObserver(undefined),null);
  for (const value of [true,false,0,'private',{},[],Promise.resolve()])
    assert.throws(() => captureMediaWorkerObserver(value),TypeError);
});

test('every supported stage emits exactly frozen begin and complete events with no result payload',async () => {
  const events = [],result = {token:'PRIVATE_SYNTHETIC',path:'PRIVATE_SYNTHETIC',bytes:Buffer.from('PRIVATE_SYNTHETIC')};
  for (const stage of MEDIA_WORKER_STAGE_NAMES) assert.equal(await observeMediaStage((event) => events.push(event),stage,() => result),result);
  assert.deepEqual(events,MEDIA_WORKER_STAGE_NAMES.flatMap((stage) => [{stage,edge:'begin'},{stage,edge:'complete'}]));
  for (const event of events) { assert.ok(Object.isFrozen(event)); assert.deepEqual(Object.keys(event),['stage','edge']); }
  assert.equal(JSON.stringify(events).includes('PRIVATE_SYNTHETIC'),false);
});

test('completion waits for the actual work, not a diagnostic acknowledgement',async () => {
  const events = [],held = Promise.withResolvers(); let done = false;
  const pending = observeMediaStage((event) => { events.push(event); return new Promise(() => {}); },'candidate-verify',() => held.promise)
    .finally(() => { done = true; });
  await tick(); assert.equal(done,false); assert.deepEqual(events,[{stage:'candidate-verify',edge:'begin'}]);
  const result = Object.freeze({verified:true}); held.resolve(result);
  assert.equal(await pending,result); assert.equal(done,true);
  assert.deepEqual(events.at(-1),{stage:'candidate-verify',edge:'complete'});
});

test('thrown and rejected work preserve the original error object without leaking its properties',async () => {
  for (const asynchronous of [false,true]) {
    const events = [],error = Object.assign(new Error('PRIVATE_SYNTHETIC'),{path:'PRIVATE_SYNTHETIC',cause:new Error('PRIVATE_SYNTHETIC')});
    const work = () => { if (asynchronous) return Promise.reject(error); throw error; };
    await assert.rejects(observeMediaStage((event) => events.push(event),'settlement',work),(actual) => actual === error);
    assert.deepEqual(events,[{stage:'settlement',edge:'begin'},{stage:'settlement',edge:'failed'}]);
    assert.equal(JSON.stringify(events).includes('PRIVATE_SYNTHETIC'),false);
  }
});

test('observer throw, rejection and hostile thenables never replace success or failure',async () => {
  const diagnostic = new Error('PRIVATE_OBSERVER'),problem = new Error('PRIVATE_WORK');
  const observers = [() => { throw diagnostic; },() => Promise.reject(diagnostic),
    () => ({then(_yes,no) { no(diagnostic); }}),() => ({get then() { throw diagnostic; }}),
    (event) => { event.stage = 'private'; },() => false,() => ({approved:true})];
  for (const observer of observers) {
    const result = Object.freeze({approved:false});
    assert.equal(await observeMediaStage(observer,'source-scan',() => result),result);
    await assert.rejects(observeMediaStage(observer,'source-scan',() => { throw problem; }),(error) => error === problem);
  }
  await tick(); // A leaked rejected observation is an unhandled-rejection test failure.
});

test('null and undefined observers perform exactly one work call and preserve primitive failures',async () => {
  for (const observer of [null,undefined]) {
    let count = 0;
    assert.equal(await observeMediaStage(observer,'queue-claim',() => { count++; return null; }),null); assert.equal(count,1);
    await assert.rejects(observeMediaStage(observer,'queue-claim',() => { throw 7; }),(error) => error === 7);
  }
});

test('unknown stages and non-work values are refused without observations or work execution',async () => {
  let observed = 0,worked = 0;
  for (const stage of ['source-scan\nPRIVATE',{},null,undefined])
    await assert.rejects(observeMediaStage(() => observed++,stage,() => worked++),TypeError);
  await assert.rejects(observeMediaStage(() => observed++,'db-open',null),TypeError);
  assert.equal(observed,0); assert.equal(worked,0);
});
