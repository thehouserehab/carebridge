// Fresh synthetic fixture ONLY. Never adopt an existing center/member or
// provision from a browser request. Owner and runtime ports stay separate.
import {randomBytes,randomUUID} from 'node:crypto';
import {Auth} from './auth.mjs';
import {Children} from './profiles.mjs';
import {Relationships} from './relationships.mjs';
import {configureSyntheticMediaPolicy} from './media-resource-test-policy.mjs';

export async function seedNativeApiTestFixture({owner,runtime}) {
  const centerId=`native-api-center-${randomUUID()}`,conversationId=`native-api-room-${randomUUID()}`;
  const childId=`native-api-child-${randomUUID()}`,credentials=[];
  const forgetCredentials=()=>{for(const value of credentials){value.password='';value.email='';}credentials.length=0;};
  let managerPassword=randomBytes(24).toString('base64url');
  try {
    const created=await new Auth(owner).bootstrapNewCenter({operationId:randomUUID(),centerId,confirmNewCenter:centerId,
      email:`native.manager.${randomUUID()}@synthetic.test`,password:managerPassword});
    // Drop references, not a claim that immutable JavaScript strings were zeroed.
    managerPassword='';
    const manager=Object.freeze({centerId,userId:created.userId}),auth=new Auth(runtime);
    for(const role of ['guardian','therapist']){
      const credential={role,centerId,email:`native.${role}.${randomUUID()}@synthetic.test`,password:randomBytes(24).toString('base64url')};
      credentials.push(credential);
      const invitation=await auth.createInvitation(manager,{centerId,email:credential.email,role});
      const accepted=await auth.acceptInvitation({token:invitation.token,password:credential.password});
      credential.userId=accepted.user.userId;
      // The harness proves login over HTTP, not via the acceptance session.
      await auth.logout(accepted.token);
    }
    const guardian=Object.freeze({centerId,userId:credentials[0].userId}),therapist=Object.freeze({centerId,userId:credentials[1].userId});
    await new Children(runtime).register(manager,{childId,conversationId,clientId:randomUUID(),
      content:{name:'가상 네이티브 연결 검증 아동',age:null,ageAsOf:null}});
    const relationships=new Relationships(runtime),initial=await relationships.get(manager,{conversationId});
    await relationships.replace(manager,{conversationId,clientId:randomUUID(),expectedVersion:initial.version,historyConfirmed:true,
      therapist:{userId:therapist.userId,history:'from_now'},guardians:[{userId:guardian.userId,history:'from_now'}]});
    await owner.transaction(tx=>configureSyntheticMediaPolicy(tx,centerId));
    const result={centerId,conversationId,childId,manager,guardian,therapist};
    Object.defineProperties(result,{credentials:{value:credentials},forgetCredentials:{value:forgetCredentials}});
    return Object.freeze(result);
  }catch(error){forgetCredentials();throw error;}
  finally{managerPassword='';}
}
