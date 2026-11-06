import assert from 'node:assert/strict';
import {after,before,beforeEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../migrate.mjs';
import {RECOVERY_USER_STATE_EXPRESSIONS} from '../recovery-state-comparison.mjs';

// Memory-only actual SQL and migration 023 triggers. This is not a native
// cross-database restore/SHARE-lock proof and does not attach to an E: database.
// The contract suite additionally asserts that the comparator declares these
// exact cursor expressions for the appropriate source and target connections.
let db;
before(async()=>{db=await PGlite.create();await migrate(db);});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE');});

async function userState(side){
  const expression=RECOVERY_USER_STATE_EXPRESSIONS[side];
  assert.ok(expression);
  return db.transaction(async tx=>{
    await tx.query(`DECLARE cb_recovery_compare NO SCROLL CURSOR FOR SELECT (${expression})::text AS row
    FROM public."cb_users" t ORDER BY (${expression})::text COLLATE "C"`);
    try{return (await tx.query('FETCH FORWARD 128 FROM cb_recovery_compare')).rows.map(value=>value.row);}
    finally{await tx.query('CLOSE cb_recovery_compare');}
  });
}
const rawUsers=async()=> (await db.query('SELECT id,active,communication_generation::text AS generation FROM cb_users ORDER BY id')).rows;
const quarantineUsers=()=>db.query('UPDATE public.cb_users SET active=false WHERE active');

test('actual source SQL predicts exactly one quarantine increment only for active users, including bigint boundaries',async()=>{
  await db.exec(`INSERT INTO cb_users(id,active,communication_generation) VALUES
    ('active-zero',true,0),('active-known',true,37),('active-upper',true,9007199254740990),
    ('inactive-zero',false,0),('inactive-known',false,37),('inactive-upper',false,9007199254740991)`);
  const beforeRows=await rawUsers(),expected=await userState('source');
  assert.deepEqual(await rawUsers(),beforeRows); // Comparison is read-only.
  assert.notDeepEqual(await userState('target'),expected); // No target normalization.
  await quarantineUsers(); // Same fixed UPDATE used by quarantineRestoredDatabase.
  assert.deepEqual(await userState('target'),expected);
  assert.deepEqual(await rawUsers(),beforeRows.map(row=>({...row,active:false,
    generation:String(BigInt(row.generation)+(row.active?1n:0n))})));
  // Replaying the user-close operation must not create another increment.
  await quarantineUsers();
  assert.deepEqual(await userState('target'),expected);
});

test('actual SQL does not clamp or erase an exhausted active user generation',async()=>{
  await db.exec("INSERT INTO cb_users(id,active,communication_generation) VALUES ('active-exhausted',true,9007199254740991)");
  const beforeRows=await rawUsers(),expected=await userState('source');
  assert.match(expected[0],/"communication_generation": 9007199254740992/);
  assert.notDeepEqual(await userState('target'),expected);
  await assert.rejects(quarantineUsers(),error=>error.code==='23514');
  assert.deepEqual(await rawUsers(),beforeRows);
});

test('actual target generations retain detectable extra changes for originally active and inactive users',async()=>{
  await db.exec(`INSERT INTO cb_users(id,active,communication_generation) VALUES
    ('active-cycle',true,10),('inactive-cycle',false,20)`);
  const expected=await userState('source');
  await quarantineUsers();
  const quarantined=await rawUsers();
  assert.deepEqual(await userState('target'),expected);
  for(const id of ['active-cycle','inactive-cycle']){
    // Valid state transitions emulate unauthorized extra history without
    // disabling any integrity trigger or manufacturing a bypass update.
    await db.query('UPDATE cb_users SET active=true WHERE id=$1',[id]);
    await db.query('UPDATE cb_users SET active=false WHERE id=$1',[id]);
    assert.notDeepEqual(await userState('target'),expected);
    const row=(await rawUsers()).find(value=>value.id===id);
    assert.equal(row.active,false);
    assert.equal(BigInt(row.generation),BigInt(quarantined.find(value=>value.id===id).generation)+2n);
  }
});

test('actual quarantine leaves membership/participant generations and saved primary-contact qualification unchanged',async()=>{
  await db.exec(`INSERT INTO cb_centers(id) VALUES ('generation-center');
    INSERT INTO cb_users(id,active) VALUES ('generation-manager',true),('generation-guardian',true);
    INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES
      ('generation-center','generation-manager','center',true),('generation-center','generation-guardian','guardian',true);
    INSERT INTO cb_children(center_id,id) VALUES ('generation-center','generation-child');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('generation-center','generation-room','generation-child');
    INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ('generation-center','generation-room','generation-guardian','guardian',true,1);
    INSERT INTO cb_primary_communicators(center_id,conversation_id,user_id,user_generation,membership_generation,
      participant_generation,revision,updated_by) VALUES
      ('generation-center','generation-room','generation-guardian',0,0,0,1,'generation-manager')`);
  const exactState=async()=>{
    const result={};
    for(const table of ['cb_memberships','cb_participants','cb_primary_communicators'])
      result[table]=(await db.query(`SELECT to_jsonb(t)::text AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows;
    return result;
  };
  const before=await exactState(),expected=await userState('source');
  await quarantineUsers();
  assert.deepEqual(await userState('target'),expected);
  assert.deepEqual(await exactState(),before);
  const saved=(await db.query(`SELECT p.user_generation::text AS saved,u.communication_generation::text AS current
    FROM cb_primary_communicators p JOIN cb_users u ON u.id=p.user_id`)).rows[0];
  assert.deepEqual(saved,{saved:'0',current:'1'}); // Old preference stays invalidated.
});
