import assert from 'node:assert/strict';
import { Records } from './records.mjs';

export function addRecordDraftNativeCases(check, databaseA, databaseB, fixture) {
  check('unfinished record drafts preserve rows, retries, sealed history and numeric boundaries', async () => {
    const f = await fixture('record-draft');
    await databaseA.transaction((tx) => tx.query(`INSERT INTO cb_goals(center_id,conversation_id,id,title,status)
      VALUES ($1,$2,'synthetic-goal','Synthetic goal','active')`, [f.centerId,f.roomId]));
    const a = new Records(databaseA), b = new Records(databaseB);
    const missing = { tool:'Synthetic tool', item:'Synthetic item', value:null, unit:'count', context:'Synthetic condition' };
    const content = { date:'2026-10-07', goalId:'synthetic-goal', status:'draft', assessments:[missing, { ...missing,value:0 },
      { tool:'Partial', item:'', value:2, unit:'', context:'' }], observation:{ status:'',task:'Synthetic unfinished observation' }, activity:{ title:'Synthetic unfinished activity' } };
    const input = { conversationId:f.roomId,recordId:'synthetic-record',clientId:'synthetic-draft-0001',expectedRevision:0,content };
    await a.save(f.therapist,input);
    const draft = await b.get(f.therapist,{ conversationId:f.roomId,recordId:input.recordId });
    assert.deepEqual(draft.assessments,content.assessments);
    assert.equal(draft.observation.status,''); assert.equal(draft.activity.instruction,'');
    assert.equal((await b.save(f.therapist,input)).replayed,true);
    await databaseA.transaction(async (tx) => {
      assert.equal((await tx.query('SELECT count(*)::integer AS count FROM cb_record_assessments WHERE conversation_id = $1',[f.roomId])).rows[0].count,0);
      assert.equal((await tx.query(`SELECT cb_valid_draft_assessments('[{"tool":"","item":"","value":1e1000,"unit":"","context":""}]'::jsonb) AS valid`)).rows[0].valid,false);
    });
    await assert.rejects(b.preview(f.therapist,{ conversationId:f.roomId,recordId:input.recordId }),{ code:'RECORD_NOT_SHAREABLE' });
    await assert.rejects(b.get(f.guardian,{ conversationId:f.roomId,recordId:input.recordId }),{ code:'FORBIDDEN' });
    await assert.rejects(b.save(f.therapist,{ ...input,expectedRevision:1,clientId:'synthetic-draft-0002',content:{ ...content,status:'saved' } }),{ code:'INVALID_INPUT' });
    await assert.rejects(databaseA.transaction((tx) => tx.query(`UPDATE cb_record_revisions SET draft_assessments = '[]'::jsonb WHERE conversation_id = $1`,[f.roomId])),{ code:'23514' });
    await assert.rejects(databaseA.transaction((tx) => tx.query(`INSERT INTO cb_record_revisions
      (center_id,conversation_id,record_id,revision,author_id,goal_id,record_date,status,title,performed,response,next_plan,summary,private_note,draft_assessments)
      SELECT center_id,conversation_id,record_id,2,author_id,goal_id,record_date,'saved',title,performed,response,next_plan,summary,private_note,draft_assessments
      FROM cb_record_revisions WHERE conversation_id = $1`,[f.roomId])),{ code:'23514' });
    await b.save(f.therapist,{ ...input,expectedRevision:1,clientId:'synthetic-draft-final-0001',content:{ ...content,status:'saved',
      performed:'Synthetic completed activity',summary:'Synthetic public summary',observation:{ status:'observed',task:'Synthetic directly observed task' },
      activity:null,assessments:[{ ...missing,value:0 },{ ...missing,item:'Time',value:9,unit:'minutes' }] } });
    assert.deepEqual(await a.get(f.therapist,{ conversationId:f.roomId,recordId:input.recordId,revision:1 }),draft);
    const current = await a.get(f.therapist,{ conversationId:f.roomId,recordId:input.recordId });
    assert.deepEqual(current.assessments.map((row) => row.value),[0,9]); assert.equal(current.revision,2);
    const preview = await a.preview(f.therapist,{ conversationId:f.roomId,recordId:input.recordId });
    assert.equal('assessments' in preview,false);
    assert.equal((await databaseA.transaction((tx) => tx.query('SELECT count(*)::integer AS count FROM cb_record_assessments WHERE conversation_id = $1',[f.roomId]))).rows[0].count,2);
  });
}
