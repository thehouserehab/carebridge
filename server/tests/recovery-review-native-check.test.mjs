// Pure service/DB doubles and source-wiring checks. No PGlite, PostgreSQL,
// credentials, child processes, listeners, native tools or file writes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { seedRecoveryReviewFixture,verifyRecoveryReviewFixture,verifyQuarantinedRecoveryReviewFixture } from '../recovery-review-native-check.mjs';

const identities={therapist:{centerId:'synthetic-center',userId:'synthetic-therapist'},
  guardian:{centerId:'synthetic-center',userId:'synthetic-guardian'},
  manager:{centerId:'synthetic-center',userId:'synthetic-manager'},conversationId:'synthetic-room'};
const denied=code=>Object.assign(new Error(code),{code});
function schemaDouble(){
  const tables=['cb_message_reviews','cb_message_review_requests'];
  return {
    constraints:tables.flatMap(relname=>[
      {relname,conname:`${relname}_pkey`,contype:'p',definition:'SYNTHETIC PRIMARY KEY'},
      {relname,conname:`${relname}_review_version_check`,contype:'c',conenforced:true,convalidated:true,definition:'CHECK (review_version > 0)'},
      {relname,conname:`${relname}_source_fkey`,contype:'f',referenced_table:'cb_message_text_revisions',definition:'SYNTHETIC PINNED REVISION FK'},
    ]),
    functions:[{proname:'cb_message_review_guard',arguments:'',definition:'SYNTHETIC REVIEW GUARD BODY'}],
    triggers:[['cb_message_reviews','cb_message_review_guard'],['cb_message_review_requests','cb_message_review_request_guard'],
      ['cb_message_review_requests','cb_message_review_request_immutable'],
      ...tables.flatMap(table=>[[table,'cb_000_recovery_guard'],[table,'cb_recovery_truncate_guard']])]
      .map(([relname,tgname])=>({relname,tgname,tgenabled:'O',definition:`SYNTHETIC ${tgname}`})),
  };
}

function serviceDouble(options={}) {
  const calls=[],queries=[],schema=schemaDouble(),state={revision:0,reviewVersion:0,note:'',body:'',requests:[],audit:0,roomRevision:0,
    quarantine:options.quarantined?1:0,activeUsers:options.quarantined?0:3,fixtureUsers:3,sources:[],
    reviewerId:identities.therapist.userId,receiptActor:identities.therapist.userId};
  const messageId='synthetic-review-message';
  const view=()=>({messageId,conversationId:identities.conversationId,revision:state.revision,
    reviewVersion:state.reviewVersion,reviewedRevision:state.revision,note:state.note,body:state.body,attachmentCount:0});
  const chat={
    async sendText(actor,input){calls.push({method:'send',actor,input});state.revision=1;state.body=input.body;
      state.sources.push({revision:1,actor_id:actor.userId,operation:'sent',body:input.body});return {id:messageId};},
    async textReviewSave(actor,input){
      calls.push({method:'save',actor,input});
      const prior=state.requests.find(row=>row.client_id===input.clientId);
      if(prior){if(options.mutateReplay)state.audit++;
        return {messageId,revision:prior.message_revision,reviewVersion:prior.review_version,operation:'review',replayed:true};}
      assert.equal(input.expectedRevision,state.revision);assert.equal(input.expectedReviewVersion,state.reviewVersion);
      state.reviewVersion++;state.note=input.note;state.audit++;state.roomRevision++;
      state.requests.push({client_id:input.clientId,message_revision:state.revision,review_version:state.reviewVersion});
      return {messageId,revision:state.revision,reviewVersion:options.badSeedReceipt?99:state.reviewVersion,operation:'review',replayed:false};
    },
    async editText(actor,input){calls.push({method:'edit',actor,input});assert.equal(input.expectedRevision,state.revision);
      state.revision++;state.body=input.body;state.audit++;state.roomRevision++;
      state.sources.push({revision:state.revision,actor_id:actor.userId,operation:'edit',body:input.body});},
    async textReview(actor,input){calls.push({method:'read',actor,input});
      if(actor.userId===identities.guardian.userId&&!options.guardianReadAllowed)throw denied('FORBIDDEN');
      if(actor.userId===identities.manager.userId&&!options.managerReadAllowed)throw denied('NOT_FOUND');
      return view();},
    async list(actor,input){calls.push({method:'list',actor,input});
      return {messages:[{id:messageId,body:state.body,...(options.publicLeak?{reviewNote:state.note}:{})}]};},
  };
  const owner={async transaction(work){const before=structuredClone(state);try{return await work({async query(sql,parameters){
    queries.push({sql,parameters});
    if(sql.includes('AS gates')){
      assert.deepEqual(parameters,[[identities.therapist.userId,identities.guardian.userId,identities.manager.userId]]);
      return {rows:[{gates:state.quarantine,active_users:state.activeUsers,fixture_users:state.fixtureUsers}]};
    }
    if(sql.includes('FROM pg_catalog.pg_constraint')){
      assert.deepEqual(parameters,[['cb_message_reviews','cb_message_review_requests']]);return {rows:structuredClone(schema.constraints)};
    }
    if(sql.includes('FROM pg_catalog.pg_proc')){
      assert.deepEqual(parameters,['cb_message_review_guard']);return {rows:structuredClone(schema.functions)};
    }
    if(sql.includes('FROM pg_catalog.pg_trigger')){
      assert.deepEqual(parameters,[['cb_message_reviews','cb_message_review_requests']]);return {rows:structuredClone(schema.triggers)};
    }
    assert.deepEqual(parameters.slice(0,3),[identities.therapist.centerId,identities.conversationId,messageId]);
    if(/^(UPDATE|INSERT INTO) public\.cb_message_review/.test(sql)){
      const probe=sql.startsWith('UPDATE')?'update':'insert';
      if(options.allowWrite===probe){state.reviewVersion++;return {rowCount:1};}
      if(options.writeError===probe)throw denied('42501');
      if(options.otherGuard===probe)throw Object.assign(new Error('invalid review advance'),{code:'23514'});
      throw Object.assign(new Error('restored service remains quarantined'),{code:'23514'});
    }
    if(sql.startsWith('SELECT reviewer_id'))return {rows:[{reviewer_id:state.reviewerId,message_revision:state.revision,
      review_version:state.reviewVersion,note:state.note}]};
    if(sql.startsWith('SELECT actor_id'))return {rows:state.requests.map(row=>({actor_id:state.receiptActor,...structuredClone(row)}))};
    if(sql.startsWith('SELECT current_revision'))return {rows:[{current_revision:state.revision}]};
    if(sql.startsWith('SELECT revision,actor_id'))return {rows:structuredClone(state.sources)};
    assert.equal(parameters.length,3);
    if(sql.startsWith('SELECT\n'))return {rows:[{reviews:1,requests:state.requests.length}]};
    if(sql.startsWith('SELECT client_id'))return {rows:structuredClone(state.requests)};
    throw new Error('UNEXPECTED_SYNTHETIC_QUERY');
  }});}catch(error){for(const key of Object.keys(state))delete state[key];Object.assign(state,before);throw error;}}};
  let snapshots=0;
  const fingerprint=async db=>{assert.equal(db,owner);snapshots++;
    if(options.mutateFinalSnapshot&&snapshots===2)state.audit++;return structuredClone(state);};
  return {chat,owner,fingerprint,calls,queries,state,schema,snapshots:()=>snapshots};
}

test('review fixture uses ordinary source v1 note v1 source edit v2 note v2 and retains the first exact request',async()=>{
  const service=serviceDouble(),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
  assert.deepEqual(service.calls.map(call=>call.method),['send','save','edit','save','read']);
  const saves=service.calls.filter(call=>call.method==='save');
  assert.deepEqual(saves.map(call=>[call.input.expectedRevision,call.input.expectedReviewVersion]),[[1,0],[2,1]]);
  assert.notEqual(saves[0].input.clientId,saves[1].input.clientId);
  assert.equal(fixture.firstRequest,saves[0].input);assert.equal(fixture.view.note,saves[1].input.note);
  assert.equal(fixture.firstReceipt.reviewVersion,1);assert.equal(fixture.view.reviewVersion,2);
  for(const value of [fixture,fixture.target,fixture.firstRequest,fixture.secondRequest,fixture.view,fixture.therapist])assert.ok(Object.isFrozen(value));
  assert.notEqual(fixture.therapist,identities.therapist);assert.equal(service.snapshots(),0);
});

test('review fixture refuses an incorrect acknowledged seed version rather than adopting it as expected data',async()=>{
  const service=serviceDouble({badSeedReceipt:true});
  await assert.rejects(seedRecoveryReviewFixture(service.chat,identities,service.owner),{code:'ERR_ASSERTION'});
  assert.equal(service.calls.some(call=>call.method==='edit'),false);
});

test('verification checks both source pins, exact old retry, denied readers and private projection without changing the snapshot',async()=>{
  const service=serviceDouble(),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner),before=structuredClone(service.state);
  service.calls.length=0;service.queries.length=0;
  await verifyRecoveryReviewFixture({...service,fixture});
  assert.equal(service.snapshots(),2);assert.deepEqual(service.state,before);
  assert.deepEqual(service.calls.map(call=>call.method),['read','save','read','read','read','list']);
  assert.equal(service.calls[1].input,fixture.firstRequest);
  assert.equal(service.queries.length,5);
  assert.ok(service.queries.slice(3).every(query=>query.sql.includes('center_id=$1 AND conversation_id=$2 AND message_id=$3')));
  // A second independently supplied service view can verify the same fixture;
  // this is call wiring, not a claim of persistence or a real process restart.
  await verifyRecoveryReviewFixture({...service,fixture});assert.deepEqual(service.state,before);
});

test('verification rejects an absent historical receipt and an equal-count source-pin replacement',async()=>{
  for(const change of [state=>state.requests.shift(),state=>{state.requests[0].message_revision=2;},
    state=>{state.requests[0].review_version=2;},state=>{state.requests[0].client_id='synthetic-replaced';}]){
    const service=serviceDouble(),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
    change(service.state);const before=structuredClone(service.state);
    await assert.rejects(verifyRecoveryReviewFixture({...service,fixture}));
    assert.deepEqual(service.state,before);
  }
});

test('verification rejects a retry that silently changes audit or room state',async()=>{
  const service=serviceDouble({mutateReplay:true}),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
  await assert.rejects(verifyRecoveryReviewFixture({...service,fixture}),{code:'ERR_ASSERTION'});
  assert.equal(service.snapshots(),2);
});

test('verification refuses newly readable guardian or manager notes and leaked public review fields',async()=>{
  for(const options of [{guardianReadAllowed:true},{managerReadAllowed:true},{publicLeak:true}]){
    const service=serviceDouble(options),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
    await assert.rejects(verifyRecoveryReviewFixture({...service,fixture}),{code:'ERR_ASSERTION'});
  }
});

test('022 schema comparison refuses altered FK CHECK function body and disabled or changed triggers',async()=>{
  for(const change of [schema=>{schema.constraints[2].referenced_table='cb_message_reviews';},
    schema=>{schema.constraints[1].definition='CHECK (review_version >= 0)';},
    schema=>{schema.constraints[1].convalidated=false;},schema=>{schema.functions[0].definition='SYNTHETIC WEAKENED FUNCTION';},
    schema=>{schema.triggers[0].tgenabled='D';},schema=>{schema.triggers[0].definition='SYNTHETIC WRONG TRIGGER';}]){
    const service=serviceDouble(),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
    change(service.schema);service.calls.length=0;
    await assert.rejects(verifyRecoveryReviewFixture({...service,fixture}),{code:'ERR_ASSERTION'});
    assert.equal(service.calls.length,0); // Do not replay or expose any note after schema failure.
  }
});

test('schema evidence cannot be initialized from empty catalogs',async()=>{
  for(const part of ['constraints','functions','triggers']){
    const service=serviceDouble();service.schema[part]=[];
    await assert.rejects(seedRecoveryReviewFixture(service.chat,identities,service.owner),{code:'ERR_ASSERTION'});
  }
});

test('quarantined verification reads the exact v2 note and both source pins without service replay',async()=>{
  const service=serviceDouble({quarantined:true}),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
  service.calls.length=0;service.queries.length=0;const before=structuredClone(service.state);
  await verifyQuarantinedRecoveryReviewFixture({...service,fixture});
  assert.deepEqual(service.state,before);assert.equal(service.snapshots(),2);assert.deepEqual(service.calls,[]);
  const writes=service.queries.filter(query=>/^(UPDATE|INSERT INTO)/.test(query.sql));
  assert.equal(writes.length,2);
  assert.match(writes[0].sql,/SET review_version=review_version\+1/);
  assert.match(writes[0].sql,/WHERE center_id=\$1 AND conversation_id=\$2 AND message_id=\$3/);
  assert.match(writes[1].sql,/SELECT center_id,conversation_id,reviewer_id,\$4,\$5,message_id,message_revision,review_version/);
  assert.equal(writes[1].parameters.length,5);
  assert.match(writes[1].parameters[3],/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.match(writes[1].parameters[4],/^[a-f0-9]{64}$/);
  assert.equal(service.queries.some(query=>/TRUNCATE|DELETE|ALTER|DROP|GRANT|REVOKE/.test(query.sql)),false);
});

test('quarantined verification refuses an absent or duplicate gate, active users and missing fixture users before probing writes',async()=>{
  for(const change of [state=>{state.quarantine=0;},state=>{state.quarantine=2;},
    state=>{state.activeUsers=1;},state=>{state.fixtureUsers=0;}]){
    const service=serviceDouble({quarantined:true}),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
    change(service.state);service.queries.length=0;const before=structuredClone(service.state);
    await assert.rejects(verifyQuarantinedRecoveryReviewFixture({...service,fixture}),{code:'ERR_ASSERTION'});
    assert.equal(service.snapshots(),2);assert.deepEqual(service.state,before);
    assert.equal(service.queries.length,1);
  }
});

test('quarantined verification rejects changed note, reviewer, old receipt, source body or pinned revision before writes',async()=>{
  for(const change of [state=>{state.note='SYNTHETIC changed note';},state=>{state.reviewVersion=1;},
    state=>{state.reviewerId=identities.guardian.userId;},state=>{state.receiptActor=identities.guardian.userId;},
    state=>state.requests.shift(),state=>{state.requests[0].message_revision=2;},
    state=>{state.requests[0].client_id='synthetic-replacement';},state=>{state.revision=1;},
    state=>{state.sources[0].body='SYNTHETIC changed original';},state=>{state.sources[1].operation='all';},
    state=>{state.sources[1].actor_id=identities.therapist.userId;},state=>state.sources.pop()]){
    const service=serviceDouble({quarantined:true}),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
    change(service.state);service.queries.length=0;const before=structuredClone(service.state);
    await assert.rejects(verifyQuarantinedRecoveryReviewFixture({...service,fixture}));
    assert.equal(service.snapshots(),2);assert.deepEqual(service.state,before);
    assert.equal(service.queries.some(query=>/^(UPDATE|INSERT INTO)/.test(query.sql)),false);
  }
});

test('quarantined verification still fingerprints on changed schema and never reaches write probes',async()=>{
  const service=serviceDouble({quarantined:true}),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
  service.schema.triggers[0].definition='SYNTHETIC altered trigger';service.queries.length=0;
  await assert.rejects(verifyQuarantinedRecoveryReviewFixture({...service,fixture}),{code:'ERR_ASSERTION'});
  assert.equal(service.snapshots(),2);
  assert.equal(service.queries.some(query=>/^(UPDATE|INSERT INTO)/.test(query.sql)),false);
});

test('quarantined verification refuses a different 23514 guard or privilege rejection for either legal write',async()=>{
  for(const probe of ['update','insert'])for(const fault of ['otherGuard','writeError']){
    const service=serviceDouble({quarantined:true,[fault]:probe}),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
    const before=structuredClone(service.state);
    await assert.rejects(verifyQuarantinedRecoveryReviewFixture({...service,fixture}),{code:'ERR_ASSERTION'});
    assert.equal(service.snapshots(),2);assert.deepEqual(service.state,before);
  }
});

test('unexpectedly successful quarantine writes are rolled back, rejected and fingerprinted',async()=>{
  for(const allowWrite of ['update','insert']){
    const service=serviceDouble({quarantined:true,allowWrite}),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
    const before=structuredClone(service.state);
    await assert.rejects(verifyQuarantinedRecoveryReviewFixture({...service,fixture}),{code:'ERR_ASSERTION'});
    assert.equal(service.snapshots(),2);assert.deepEqual(service.state,before);
  }
});

test('quarantined verification detects fingerprint mutation on both passing and failing assertion paths',async()=>{
  for(const failEarly of [false,true]){
    const service=serviceDouble({quarantined:true,mutateFinalSnapshot:true}),fixture=await seedRecoveryReviewFixture(service.chat,identities,service.owner);
    if(failEarly)service.state.activeUsers=1;
    await assert.rejects(verifyQuarantinedRecoveryReviewFixture({...service,fixture}),{code:'ERR_ASSERTION'});
    assert.equal(service.snapshots(),2);
  }
});

test('Windows role rehearsal wires exact migrations and 022 verification through source and independent restore restarts',async()=>{
  const source=await readFile(new URL('../windows-postgres-check.mjs',import.meta.url),'utf8');
  assert.match(source,/if\(roleCheck&&\(!nativeMediaCheck\|\|recoveryStateCheck\)\)reviewChecks=\{seeded:false,sourceRestart:false,restored:false,restoredRestart:false/);
  assert.match(source,/assert\.deepEqual\(migrations,expectedMigrations\.map\(row=>row\.name\)\)/);
  assert.match(source,/assertRecoveryMigrations\(rows,expectedMigrations\)/);
  assert.equal((source.match(/await verifyRecoveryMigrationLedger\(source\)/g)??[]).length,2);
  assert.equal((source.match(/await verifyRecoveryMigrationLedger\(restored\)/g)??[]).length,2);
  for(const [flag,connection]of [['seeded','source'],['sourceRestart','source'],['restored','restored'],['restoredRestart','restored']])
    assert.ok(source.includes(`await verifyServices(${connection==='source'?'sourceRuntime':'restoredRuntime'},fixture,${connection});if(reviewChecks)reviewChecks.${flag}=true;`));
  assert.match(source,/sourceUnchanged && Object\.values\(reviewChecks\)\.every\(value=>value===true\)/);
  assert.match(source,/if\(fixture\.review\)await verifyRecoveryReviewFixture\(\{chat,owner,fingerprint,fixture:fixture\.review\}\)/);
});

test('role rehearsal preserves old summaries and synthetic clusters while recording code and SQL identity',async()=>{
  const source=await readFile(new URL('../windows-postgres-check.mjs',import.meta.url),'utf8');
  assert.ok(source.includes('database-privileges-${runId}-results.json'));
  assert.match(source,/await freshFile\(join\(resultDirectory,'database-privileges-results\.json'\),resultBytes\)/);
  assert.match(source,/if\(error\?\.code!=='EEXIST'\)throw error/);
  assert.match(source,/assert\.deepEqual\(await recoverySourceManifest\(\),sourceManifest\);sourceUnchanged=true/);
  assert.match(source,/migrationManifest:expectedMigrations/);assert.match(source,/sourceManifest,sourceUnchanged:/);
  assert.ok(source.includes("['server/migrations/',/\\.sql$/]"));
  assert.doesNotMatch(source,/dropDisposableDatabase|DROP DATABASE|\brm\(/);
  // Existing result-directory mkdir is allowed; owned data roots are not deleted.
  assert.match(source,/Owned synthetic databases\/media\/bundle remain OFFLINE/);
  assert.match(source,/bundleKey\?\.fill\(0\)/);
});
