import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Auth} from '../auth.mjs';
import {Children} from '../profiles.mjs';
import {Relationships} from '../relationships.mjs';
import {seedNativeApiTestFixture} from '../native-api-seed-testfixture.mjs';
import {migrate} from '../migrate.mjs';

// Real migrations/Auth/Children/Relationships with an in-memory PGlite DB.
// No native PostgreSQL, E drive, file store, child process or engine is used.
test('two native HTTP seeds isolate new centers without changing the original exact-one-role fixture',async()=>{
  const db=await PGlite.create(),created=[];
  try{
    await migrate(db);
    const auth=new Auth(db),centerId='synthetic-role-center',conversationId='synthetic-role-room';
    const password=randomBytes(24).toString('base64url');
    const bootstrap=await auth.bootstrapNewCenter({operationId:randomUUID(),centerId,confirmNewCenter:centerId,
      email:'original.manager@synthetic.test',password});
    const manager={centerId,userId:bootstrap.userId},members={center:manager};
    for(const role of ['guardian','therapist']){
      const invitation=await auth.createInvitation(manager,{centerId,email:`original.${role}@synthetic.test`,role});
      const accepted=await auth.acceptInvitation({token:invitation.token,password});
      members[role]={centerId,userId:accepted.user.userId};
    }
    const profiles=new Children(db),relationships=new Relationships(db);
    await profiles.register(manager,{childId:'synthetic-role-child',conversationId,clientId:randomUUID(),
      content:{name:'가상 기존 권한 시험 아동',age:null,ageAsOf:null}});
    const initial=await relationships.get(manager,{conversationId});
    await relationships.replace(manager,{conversationId,clientId:randomUUID(),expectedVersion:initial.version,historyConfirmed:true,
      therapist:{userId:members.therapist.userId,history:'from_now'},guardians:[{userId:members.guardian.userId,history:'from_now'}]});
    const originalUserIds=Object.values(members).map(actor=>actor.userId).sort();
    async function snapshot(){
      return db.transaction(async tx=>{
        const result={};
        for(const table of ['cb_centers','cb_memberships','cb_children','cb_conversations','cb_child_profiles','cb_participants',
          'cb_media_resource_limits','cb_auth_invitations','cb_auth_audit_events','cb_center_bootstraps']){
          const where=table==='cb_centers'?'id':'center_id';
          result[table]=(await tx.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE ${where}=$1 ORDER BY to_jsonb(t)::text`,[centerId])).rows;
        }
        for(const table of ['cb_users','cb_auth_accounts','cb_auth_sessions']){
          const where=table==='cb_users'?'id':'user_id';
          result[table]=(await tx.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE ${where}=ANY($1::text[]) ORDER BY to_jsonb(t)::text`,[originalUserIds])).rows;
        }
        return result;
      });
    }
    const before=await snapshot();
    // Use separate transactional ports, as the native parent does. This test
    // checks seed/data isolation, not PostgreSQL role-grant enforcement.
    const owner={transaction:work=>db.transaction(work)},runtime={transaction:work=>db.transaction(work)};
    for(let i=0;i<2;i++){
      const fixture=await seedNativeApiTestFixture({owner,runtime});created.push(fixture);
      assert.notEqual(fixture.centerId,centerId);assert.notEqual(fixture.conversationId,conversationId);
      assert.deepEqual(await snapshot(),before);
      const existing=(await db.query('SELECT user_id,role,active FROM cb_memberships WHERE center_id=$1 ORDER BY role',[centerId])).rows;
      for(const role of ['center','guardian','therapist'])assert.equal(existing.filter(row=>row.role===role).length,1);
      assert.deepEqual(existing.map(row=>row.user_id).sort(),originalUserIds);
      const current=(await db.query('SELECT user_id,role,active FROM cb_memberships WHERE center_id=$1 ORDER BY role',[fixture.centerId])).rows;
      assert.deepEqual(current.map(row=>row.role),['center','guardian','therapist']);assert(current.every(row=>row.active));
      assert.deepEqual(current.map(row=>row.user_id).sort(),[fixture.manager.userId,fixture.guardian.userId,fixture.therapist.userId].sort());
      const policy=(await db.query('SELECT revision,accepting_uploads FROM cb_media_resource_limits WHERE center_id=$1',[fixture.centerId])).rows;
      assert.deepEqual(policy,[{revision:1,accepting_uploads:true}]);
      assert.equal(Object.getOwnPropertyDescriptor(fixture,'credentials').enumerable,false);
      assert.equal(fixture.credentials.length,2);
      assert(!JSON.stringify(fixture).includes('password'));assert(!JSON.stringify(fixture).includes('@synthetic.test'));
      const activeSessions=(await db.query('SELECT count(*)::int AS count FROM cb_auth_sessions WHERE user_id=ANY($1::text[]) AND revoked_at IS NULL',
        [[fixture.manager.userId,fixture.guardian.userId,fixture.therapist.userId]])).rows[0].count;
      assert.equal(activeSessions,0);
      for(const credential of fixture.credentials){
        assert.match(credential.email,/@synthetic\.test$/);assert(credential.password.length>=24);
        const session=await auth.login({email:credential.email,password:credential.password});
        assert.equal(session.user.userId,credential.userId);assert.deepEqual(session.user.centers,[{id:fixture.centerId,role:credential.role}]);
        await auth.logout(session.token);
        const profile=await profiles.get(fixture[credential.role],{conversationId:fixture.conversationId});
        assert.equal(profile.childId,fixture.childId);assert.equal(profile.name,'가상 네이티브 연결 검증 아동');
        assert.deepEqual(profile.participants.map(member=>member.role),['guardian','therapist']);
      }
      await assert.rejects(profiles.get(members.guardian,{conversationId:fixture.conversationId}),{code:'NOT_FOUND'});
      await assert.rejects(profiles.get(fixture.guardian,{conversationId}),{code:'NOT_FOUND'});
    }
    assert.equal(new Set(created.map(fixture=>fixture.centerId)).size,2);
    assert.equal(new Set(created.map(fixture=>fixture.childId)).size,2);
    assert.equal(new Set(created.map(fixture=>fixture.conversationId)).size,2);
    assert.equal(new Set(created.flatMap(fixture=>[fixture.manager.userId,fixture.guardian.userId,fixture.therapist.userId])).size,6);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM cb_centers')).rows[0].count,3);
    await assert.rejects(profiles.get(created[0].guardian,{conversationId:created[1].conversationId}),{code:'NOT_FOUND'});
    assert.deepEqual(await snapshot(),before);
    for(const fixture of created){
      const retained=[...fixture.credentials];fixture.forgetCredentials();
      assert.equal(fixture.credentials.length,0);assert(retained.every(value=>value.password===''&&value.email===''));
    }
  }finally{for(const fixture of created)fixture.forgetCredentials();await db.close();}
});
