// Current application -> loopback API -> owned in-memory data and allowlisted
// demo media. AI answers are labeled offline examples, never live API results.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createPrototypeSandbox} from '../server/prototype-sandbox.mjs';
import {Records} from '../server/records.mjs';
import {studyChildEnvironment} from '../scripts/p0-study-policy.mjs';
import {messageBrowserOptions} from './message-browser-policy.mjs';
import {workspaceRoom,workspaceView} from './local-workspace-browser-helpers.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function manifest(){
  const names=['tests/prototype-browser.mjs','tests/local-workspace-browser-helpers.mjs'];
  for(const dir of ['local-api','src','server']) for(const entry of await readdir(path.join(root,dir),{withFileTypes:true}))
    if(entry.isFile()&&/\.(js|mjs|css|html)$/.test(entry.name))names.push(dir+'/'+entry.name);
  const files=await Promise.all(names.sort().map(async name=>({name,sha256:sha(await readFile(path.join(root,name)))})));
  return {sha256:sha(JSON.stringify(files)),files};
}
async function bounded(work){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PROTOTYPE_CLEANUP_TIMEOUT')),15000);})]);}finally{clearTimeout(timer);}}
async function removed(folder){try{await stat(folder);return false;}catch(error){return error.code==='ENOENT';}}

export async function run(args=process.argv.slice(2)){
  const options=messageBrowserOptions(args),{chromium}=await import(pathToFileURL(options.module).href);
  const runId=randomUUID(),folder=path.join(root,'test-results','prototype-browser-'+runId);
  await mkdir(folder,{recursive:true});
  const report={runId,passed:false,source:await manifest(),checks:[],errors:[],unexpectedRequests:[],screenshots:[],
    actualModelCalls:0,syntheticOnly:true,limitations:['Offline AI examples and fixed demo PNG/MP4/WAV only. No arbitrary media scanning, real child data, physical device, production deployment or human usability timing.'],
    cleanup:{contextsClosed:false,browserStopped:false,sandboxesClosed:false,privateRootsRemoved:false}};
  const contexts=new Set(),sandboxes=new Set(),roots=new Set();
  let server,browser,browserProcess,phase='START';
  try{
    server=await chromium.launchServer({headless:true,executablePath:options.executable,host:'127.0.0.1',port:0,env:studyChildEnvironment(),timeout:30000});
    browserProcess=server.process();browser=await chromium.connect(server.wsEndpoint());
    for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:568}]){
      phase=viewport.width+':SETUP';
      const sandbox=await createPrototypeSandbox({port:0});sandboxes.add(sandbox);roots.add(sandbox.mediaRoot);
      const {ids,origin}=sandbox,base='/api/local/centers/'+ids.centerId+'/conversations/'+ids.conversationId;
      const png=sandbox.demoFiles.find(f=>f.type==='image/png'),mp4=sandbox.demoFiles.find(f=>f.type==='video/mp4'),wav=sandbox.demoFiles.find(f=>f.type==='audio/wav');
      assert(png&&mp4&&wav);
      const records=new Records(sandbox.database),actor={userId:ids.therapistId,centerId:ids.centerId};
      const record=()=>records.get(actor,{conversationId:ids.conversationId,recordId:ids.recordId});
      const original=await record();
      const createPage=async role=>{
        const context=await browser.newContext({viewport,locale:'ko-KR',timezoneId:'Asia/Seoul',isMobile:viewport.width<600,hasTouch:viewport.width<600,serviceWorkers:'block',permissions:[],acceptDownloads:false});
        contexts.add(context);
        await context.route('**/*',route=>{
          const request=route.request(),url=new URL(request.url());
          if(url.origin!==origin||!['GET','POST'].includes(request.method())){report.unexpectedRequests.push({phase,method:request.method()});return route.abort();}
          return route.continue();
        });
        const page=await context.newPage();page.setDefaultTimeout(15000);
        page.on('pageerror',()=>report.errors.push({phase,kind:'PAGE_ERROR'}));
        page.on('console',message=>{if(message.type()==='error'&&!/status of 401/.test(message.text()))report.errors.push({phase,kind:'CONSOLE_ERROR'});});
        await page.goto(origin);
        const credential=sandbox.credentials.find(c=>c.role===role);assert(credential.email.endsWith('.test'));
        await page.getByLabel('시험 이메일',{exact:true}).fill(credential.email);
        await page.getByLabel('시험 비밀번호',{exact:true}).fill(credential.password);
        await page.getByRole('button',{name:'로그인',exact:true}).click();
        await page.locator('[data-home-news]').waitFor();
        assert((await page.locator('.topbar').innerText()).includes('Carebridge'));
        await workspaceRoom(page,ids.conversationId);
        return {page,context};
      };
      const therapist=await createPage('therapist'),guardian=await createPage('guardian');
      const capture=async(page,label)=>{
        const name=viewport.width+'-'+label+'.png';
        await page.screenshot({path:path.join(folder,name),mask:[page.locator('input[type=password]'),page.locator('input[type=email]'),page.locator('.account-panel')]});
        report.screenshots.push(name);
        assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'PROTOTYPE_PAGE_OVERFLOW');
      };
      const pick=async(page,button,file)=>{
        const chooser=page.waitForEvent('filechooser');await button.click();
        await(await chooser).setFiles({name:file.name,mimeType:file.type,buffer:file.bytes});
      };
      const upload=async(page,panel,file)=>{
        const row=panel.getByTestId('media-upload-row').filter({hasText:file.name});await row.waitFor();
        await row.locator('[data-media-action="upload"]').click();
        await row.locator('.media-file-status').filter({hasText:'준비 완료'}).waitFor();
      };
      const viewMedia=async(page,messageId,file)=>{
        const button=page.locator('[data-open-attachment][data-message-id="'+messageId+'"]').filter({hasText:file.name});
        await button.click();
        const viewer=page.getByTestId('media-viewer');await viewer.waitFor();
        if(file.type==='image/png'){
          await page.waitForFunction(()=>{const img=document.querySelector('[data-media-viewer-content] img');return img?.complete&&img.naturalWidth>0;});
          assert(await viewer.locator('img').evaluate(async img=>{await img.decode();return img.naturalWidth>0&&img.currentSrc.startsWith('blob:');}));
        }else{
          await page.waitForFunction(()=>{const v=document.querySelector('[data-media-viewer-content] video');return v?.readyState>=1&&v.videoWidth>0;});
          const video=viewer.locator('video');assert.equal(await video.evaluate(v=>v.autoplay),false);
          await video.focus();await video.press('Space');
          await page.waitForFunction(()=>{const v=document.querySelector('[data-media-viewer-content] video');return v&&!v.error&&v.currentTime>0&&(v.getVideoPlaybackQuality?.().totalVideoFrames??0)>0;});
        }
        await capture(page,file.type==='image/png'?'received-photo':'video-playing');
        await viewer.locator('[data-media-viewer-close]').click();await viewer.waitFor({state:'detached'});
      };

      for(const file of [png,mp4]){
        phase=viewport.width+':CHAT_'+file.type;
        await pick(therapist.page,therapist.page.locator('[data-chat-attach]'),file);
        await upload(therapist.page,therapist.page.getByTestId('media-upload-panel'),file);
        await therapist.page.getByLabel('메시지',{exact:true}).fill('가상 시연 첨부 '+file.name);
        const response=therapist.page.waitForResponse(r=>r.url()===origin+base+'/messages'&&r.request().method()==='POST'&&r.status()===201);
        await therapist.page.getByRole('button',{name:'보내기',exact:true}).click();
        const message=(await(await response).json()).message;assert.equal(message.attachments.length,1);
        await guardian.page.reload();await guardian.page.locator('[data-home-news]').waitFor();await workspaceRoom(guardian.page,ids.conversationId);
        await viewMedia(guardian.page,message.id,file);
      }

      phase=viewport.width+':ACTIVITY_WITH_PHOTO';
      await guardian.page.locator('[data-care-action="feedback"][data-message-id="'+ids.publicationMessageId+'"]').click();
      const feedback=guardian.page.locator('[data-care-form="feedback"]');await feedback.waitFor();
      await feedback.locator('[name="result"]').selectOption('partial');
      await feedback.locator('[name="reaction"]').fill('가상 사례: 파란 블록을 골랐어요.');
      await feedback.locator('[name="difficulty"]').fill('가상 사례: 오래 이어가기 어려웠어요.');
      const feedbackUpload=feedback.locator('[data-feedback-upload]');
      await pick(guardian.page,feedbackUpload.locator('[data-media-pick]'),png);
      await upload(guardian.page,feedbackUpload,png);
      await feedback.getByRole('button',{name:'활동 경험 저장',exact:true}).click();
      await guardian.page.getByTestId('care-dialog').waitFor({state:'hidden'});
      await therapist.page.reload();await therapist.page.locator('[data-home-news]').waitFor();await workspaceRoom(therapist.page,ids.conversationId);
      const feedbackRow=therapist.page.locator('[data-testid="message-row"]').filter({hasText:'가상 사례: 파란 블록을 골랐어요.'});
      await feedbackRow.locator('.care-feedback').waitFor();
      assert.equal(await feedbackRow.locator('[data-open-attachment]').count(),1);
      await capture(therapist.page,'activity-experience');

      phase=viewport.width+':AI_CHAT_EXAMPLE';
      await therapist.page.locator('[data-action="ai-assistant"]').click();
      await therapist.page.locator('[data-ai-input]').fill('사진은 어떻게 첨부하나요?');
      await therapist.page.locator('.ai-compose button:not([disabled])').click();
      await therapist.page.locator('.ai-bubble.assistant').filter({hasText:'시연용 예시 답변입니다.'}).waitFor();
      await capture(therapist.page,'ai-example');
      await therapist.page.locator('[data-ai-action="audio"]').click();

      phase=viewport.width+':AUDIO_REVIEW';
      await therapist.page.locator('[data-audio-record] option[value="'+ids.recordId+'"]').waitFor({state:'attached'});
      await therapist.page.locator('[data-audio-record]').selectOption(ids.recordId);
      await therapist.page.locator('[data-audio-file]').setInputFiles({name:wav.name,mimeType:wav.type,buffer:wav.bytes});
      await therapist.page.locator('[data-audio-check="syntheticConfirmed"]').check();
      await therapist.page.locator('[data-audio-check="processingConfirmed"]').check();
      await therapist.page.locator('[data-audio-action="upload"]').click();
      await therapist.page.locator('[data-audio-action="start"]').click();
      await therapist.page.locator('[data-audio-check="reviewed"]').waitFor();
      assert.deepEqual(await record(),original);
      assert.equal(await therapist.page.locator('[data-audio-field]:checked').count(),0,'PROTOTYPE_EXISTING_FIELDS_UNSELECTED');
      await therapist.page.locator('[data-audio-details="transcript"] > summary').click();
      assert((await therapist.page.locator('.audio-transcript').innerText()).includes('가상 수업 테스트입니다.'));
      await therapist.page.locator('[data-audio-field="summary"]').check();
      await therapist.page.locator('[data-audio-check="overwriteConfirmed"]').check();
      await therapist.page.locator('[data-audio-check="reviewed"]').check();
      await capture(therapist.page,'audio-review');
      await therapist.page.locator('[data-audio-action="apply"]').click();
      const form=therapist.page.locator('[data-care-form="record"]');await form.waitFor();
      for(const key of ['performed','response','privateNote','nextPlan'])assert.equal(await form.locator('[name="'+key+'"]').inputValue(),original[key]);
      const summary=await form.locator('[name="summary"]').inputValue();assert(summary.includes('파란 블록'));assert.notEqual(summary,original.summary);
      assert.deepEqual(await record(),original,'PROTOTYPE_APPLY_NOT_SAVED');
      await form.getByRole('button',{name:'보호자 공유 준비',exact:true}).click();
      const publish=therapist.page.locator('[data-care-form="publish"]');await publish.waitFor();
      assert.equal((await record()).summary,summary);
      const preview=await publish.innerText();assert(preview.includes(summary));assert(!preview.includes(original.privateNote));
      await publish.locator('[name="confirmed"]').check();
      await publish.getByRole('button',{name:'확인하고 공유',exact:true}).click();
      await therapist.page.getByTestId('care-dialog').waitFor({state:'hidden'});
      await therapist.page.reload();await therapist.page.locator('[data-home-news]').waitFor();assert.equal((await record()).summary,summary);

      phase=viewport.width+':GUARDIAN_CALENDAR_RELOAD';
      await guardian.page.reload();await guardian.page.locator('[data-home-news]').waitFor();await workspaceView(guardian.page,'child');
      const calendar=guardian.page.locator('[data-calendar-reports]');await calendar.waitFor();
      await calendar.locator('[data-calendar-report]').filter({hasText:original.title}).click();
      await guardian.page.locator('.care-publication').filter({hasText:summary}).waitFor();
      const visible=await guardian.page.locator('body').innerText();
      assert(!visible.includes(original.privateNote));assert(!visible.includes('가상 수업 테스트입니다.'));
      await capture(guardian.page,'calendar-shared-report');
      assert.deepEqual(await guardian.page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
      assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);
      report.checks.push({...viewport,photoDeliveredAndDecoded:true,videoDeliveredAndPlayed:true,activityWithPhotoSavedAndReceived:true,
        offlineAiExample:true,audioTranscriptReviewed:true,existingRecordPreserved:true,explicitSummaryOverwrite:true,applyRemainsUnsaved:true,savedReloadedShared:true,calendarReport:true});
      await therapist.context.close();contexts.delete(therapist.context);
      await guardian.context.close();contexts.delete(guardian.context);
      await sandbox.close();assert(sandbox.database.closed);sandboxes.delete(sandbox);
      console.log(JSON.stringify({width:viewport.width,passed:true}));
    }
    report.finalSource=await manifest();assert.equal(report.source.sha256,report.finalSource.sha256,'PROTOTYPE_SOURCE_CHANGED');
  }catch(error){
    report.failure={phase,kind:error.name,code:/^[A-Z_]+$/.test(error.message??'')?error.message:null,line:Number(error.stack?.match(/prototype-browser\.mjs:(\d+):/)?.[1])||null};
    for(const context of contexts)for(const page of context.pages())try{await page.screenshot({path:path.join(folder,'failure-'+report.screenshots.length+'.png'),mask:[page.locator('input[type=password]'),page.locator('input[type=email]'),page.locator('.account-panel')]});report.screenshots.push('failure-'+report.screenshots.length+'.png');}catch{}
  }finally{
    for(const context of contexts)try{await bounded(context.close());contexts.delete(context);}catch{}
    report.cleanup.contextsClosed=contexts.size===0;
    if(server)try{await bounded(server.close());}catch{try{await bounded(server.kill());}catch{}}
    report.cleanup.browserStopped=typeof browserProcess?.exitCode==='number'||typeof browserProcess?.signalCode==='string';
    for(const sandbox of sandboxes)try{await bounded(sandbox.close());sandboxes.delete(sandbox);}catch{}
    report.cleanup.sandboxesClosed=sandboxes.size===0;
    report.cleanup.privateRootsRemoved=(await Promise.all([...roots].map(removed))).every(Boolean);
    report.passed=!report.failure&&report.checks.length===3&&Object.values(report.cleanup).every(Boolean);
    await writeFile(path.join(folder,'results.json'),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify({runId,passed:report.passed,checks:report.checks.length,failure:report.failure,cleanup:report.cleanup}));
  return report.passed;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(!await run())process.exitCode=1;}catch{console.error('PROTOTYPE_BROWSER_CONFIGURATION_FAILED');process.exitCode=1;}
}
