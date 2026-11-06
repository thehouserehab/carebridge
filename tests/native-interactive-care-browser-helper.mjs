// Borrowed, caller-owned synthetic pages. All mutations use visible UI; HTTP
// responses below are observations, never substitutes for a user operation.
import assert from 'node:assert/strict';
import {workspaceRecords,workspaceRoom,workspaceView} from './local-workspace-browser-helpers.mjs';
const code='NATIVE_INTERACTIVE_CARE_FAILED';
export async function exerciseInteractiveCare({origin,centerId,conversationId,goalId,appointmentId,guardianId,guardian,therapist,capture,onPhase}) {
  const base=`${origin}/api/local/centers/${centerId}/conversations/${conversationId}`;
  const result={homeSchedule:false,structuredRecord:false,privatePreview:false,sharedReceive:false,feedbackReceive:false,reload:false};
  const text={title:'가상 연결 확인 기록',performed:'가상 내부 수행 관찰',response:'가상 내부 반응 관찰',nextPlan:'가상 다음 회기 계획',
    privateNote:'가상 치료사 전용 비공개 메모',summary:'가상 보호자 공유 요약',reaction:'가상 집에서 활동한 경험'};
  const dialog=who=>who.page.getByTestId('care-dialog');
  async function field(who,name,value,select=false){
    const input=dialog(who).locator(`[name="${name}"]`);
    for(const details of await input.locator('xpath=ancestor::details').all())
      if(await details.getAttribute('open')===null)await details.locator(':scope > summary').click();
    if(select)await input.selectOption(value);else await input.fill(value);
  }
  const response=(who,suffix,method)=>who.page.waitForResponse(r=>r.url().startsWith(base+suffix)&&r.request().method()===method&&r.status()>=200&&r.status()<300);
  const submit=async(who,name)=>{await dialog(who).getByRole('button',{name,exact:true}).click();await dialog(who).waitFor({state:'hidden'});};
  onPhase('CARE_HOME_RECORD');
  await workspaceView(therapist.page,'home');
  await therapist.page.getByTestId('home').locator(`[data-appointment-record="${appointmentId}"][data-context-room="${conversationId}"]`).click();
  await dialog(therapist).waitFor();result.homeSchedule=true;
  for(const name of ['title','performed','response','nextPlan','privateNote','summary'])await field(therapist,name,text[name]);
  await field(therapist,'goalId',goalId,true);
  for(const [name,value]of Object.entries({activityTitle:'가상 가정 놀이',activityInstruction:'가상 놀이 선택',activityFrequency:'가상 하루 한 번',activityCaution:'가상 피곤하면 쉬어요'}))await field(therapist,name,value);
  await capture(therapist,'1440-interactive-record');
  const [savedResponse]=await Promise.all([response(therapist,'/records/','POST'),submit(therapist,'기록 저장')]);
  const receipt=(await savedResponse.json()).receipt,savedId=receipt?.recordId;
  assert(savedId&&receipt.revision===1,code);
  const request=savedResponse.request().postDataJSON();
  assert(request.content.status==='saved'&&request.content.appointmentId===appointmentId&&request.content.goalId===goalId,code);
  onPhase('CARE_PREVIEW_SHARE');
  await workspaceRecords(therapist.page,conversationId);
  const [previewResponse]=await Promise.all([response(therapist,`/records/${savedId}/preview`,'GET'),
    therapist.page.locator(`[data-care-action="preview-record"][data-record-id="${savedId}"]`).click()]);
  await dialog(therapist).waitFor();const preview=(await previewResponse.json()).preview;
  assert.equal(preview.summary,text.summary,code);
  assert.deepEqual(preview.recipientIds,[guardianId],code);assert.equal(preview.recordRevision,receipt.revision,code);
  for(const name of ['performed','response','nextPlan','privateNote']){
    assert(!JSON.stringify(preview).includes(text[name]),code);assert(!(await dialog(therapist).innerText()).includes(text[name]),code);
  }
  await dialog(therapist).locator('[name="confirmed"]').check();await capture(therapist,'1440-interactive-preview');
  const [publishedResponse]=await Promise.all([response(therapist,`/records/${savedId}/publish`,'POST'),submit(therapist,'확인하고 공유')]);
  assert.equal(publishedResponse.status(),201,code);result.privatePreview=true;
  onPhase('CARE_GUARDIAN_RECEIVE');
  await guardian.page.reload();await guardian.page.getByTestId('home').waitFor();
  await guardian.page.getByTestId('home').locator(`[data-open-room="${conversationId}"]`).filter({hasText:'가상 가정 놀이'}).click();
  const shared=guardian.page.locator('[data-publication-id]').filter({hasText:text.summary});await shared.waitFor();
  const publicText=await guardian.page.locator('body').innerText();
  for(const name of ['performed','response','nextPlan','privateNote'])assert(!publicText.includes(text[name]),code);
  await shared.scrollIntoViewIfNeeded();
  await capture(guardian,'390-interactive-publication');result.sharedReceive=true;
  onPhase('CARE_FEEDBACK');
  await shared.locator('[data-care-action="feedback"]').click();await dialog(guardian).waitFor();
  await field(guardian,'result','partial',true);await field(guardian,'reaction',text.reaction);await field(guardian,'difficulty','가상 잠시 쉬었어요');
  const [feedbackResponse]=await Promise.all([response(guardian,'/feedback/','POST'),submit(guardian,'활동 경험 저장')]);
  assert.equal(feedbackResponse.status(),201,code);
  await therapist.page.reload();await therapist.page.getByTestId('home').waitFor();await workspaceRoom(therapist.page,conversationId);
  const feedbackRow=therapist.page.getByTestId('message-row').filter({hasText:text.reaction});await feedbackRow.waitFor();await feedbackRow.scrollIntoViewIfNeeded();
  await capture(therapist,'1440-interactive-feedback');result.feedbackReceive=true;
  onPhase('CARE_RELOAD_RECORD');
  await workspaceRecords(therapist.page,conversationId);
  const [storedResponse]=await Promise.all([response(therapist,`/records/${savedId}`,'GET'),
    therapist.page.locator(`[data-care-action="edit-record"][data-record-id="${savedId}"]`).click()]);
  await dialog(therapist).waitFor();const stored=(await storedResponse.json()).record;
  assert.equal(stored.appointmentId,appointmentId,code);assert.equal(stored.appointmentRevision,request.expectedAppointmentRevision,code);
  assert.equal(stored.goalId,goalId,code);assert.equal(stored.goalRevision,request.expectedGoalRevision,code);
  assert.equal(stored.status,'saved',code);
  for(const name of ['performed','response','nextPlan','privateNote','summary'])assert.equal(stored[name],text[name],code);
  for(const name of ['performed','response','nextPlan','privateNote','summary'])assert.equal(await dialog(therapist).locator(`[name="${name}"]`).inputValue(),text[name],code);
  await dialog(therapist).getByRole('button',{name:'입력 취소',exact:true}).click();await dialog(therapist).waitFor({state:'hidden'});
  result.structuredRecord=true;result.reload=true;return Object.freeze(result);
}
