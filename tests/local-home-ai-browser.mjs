// Fresh home entry -> real loopback API -> owned prototype memory database.
// All responses are explicitly offline examples. No existing user session is touched.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createPrototypeSandbox} from '../server/prototype-sandbox.mjs';
import {Records} from '../server/records.mjs';
import {studyChildEnvironment} from '../scripts/p0-study-policy.mjs';
import {messageBrowserOptions} from './message-browser-policy.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function manifest(){
  const names=['tests/local-home-ai-browser.mjs'];
  for(const dir of ['local-api','src','server'])for(const entry of await readdir(path.join(root,dir),{withFileTypes:true}))
    if(entry.isFile()&&/\.(js|mjs|css|html)$/.test(entry.name))names.push(dir+'/'+entry.name);
  const files=await Promise.all(names.sort().map(async name=>({name,sha256:hash(await readFile(path.join(root,name)))})));
  return {sha256:hash(JSON.stringify(files)),files};
}
async function bounded(work){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('HOME_AI_CLEANUP_TIMEOUT')),15000);})]);}finally{clearTimeout(timer);}}
async function removed(folder){try{await stat(folder);return false;}catch(error){return error.code==='ENOENT';}}
async function ready(page){
  await page.locator('.ai-assistant[open] .ai-fixture').waitFor();
  await page.waitForFunction(()=>{const input=document.querySelector('.ai-assistant[open] [data-ai-input]');return input&&!input.disabled;});
}

export async function run(args=process.argv.slice(2)){
  const options=messageBrowserOptions(args),{chromium}=await import(pathToFileURL(options.module).href);
  const runId=randomUUID(),folder=path.join(root,'test-results','local-home-ai-'+runId);
  await mkdir(folder,{recursive:true});
  const report={runId,source:await manifest(),passed:false,checks:[],observations:[],errors:[],unexpectedRequests:[],screenshots:[],actualModelCalls:0,
    limitations:['Fresh owned loopback sessions and explicit offline providers. No live AI, real child data, existing user browser or physical device.'],
    cleanup:{contextsClosed:false,browserStopped:false,sandboxesClosed:false,privateRootsRemoved:false}};
  const contexts=new Set(),sandboxes=new Set(),roots=new Set();
  let server,browser,browserProcess,phase='START';
  try{
    server=await chromium.launchServer({headless:true,executablePath:options.executable,host:'127.0.0.1',port:0,env:studyChildEnvironment(),timeout:30000});
    browserProcess=server.process();browser=await chromium.connect(server.wsEndpoint());
    for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:568}])for(const role of ['therapist','guardian']){
      phase=viewport.width+':'+role+':SETUP';
      const sandbox=await createPrototypeSandbox({port:0});sandboxes.add(sandbox);roots.add(sandbox.mediaRoot);
      const {ids,origin}=sandbox,base='/api/local/centers/'+ids.centerId+'/conversations/'+ids.conversationId;
      const context=await browser.newContext({viewport,locale:'ko-KR',timezoneId:'Asia/Seoul',isMobile:viewport.width<600,hasTouch:viewport.width<600,serviceWorkers:'block',permissions:[],acceptDownloads:false});
      contexts.add(context);const calls=[];
      await context.route('**/*',route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.origin!==origin||!['GET','POST'].includes(request.method())){report.unexpectedRequests.push({phase,method:request.method()});return route.abort();}
        return route.continue();
      });
      const page=await context.newPage();page.setDefaultTimeout(15000);
      page.on('pageerror',()=>report.errors.push({phase,kind:'PAGE_ERROR'}));
      page.on('console',message=>{if(message.type()==='error'&&!/status of 401/.test(message.text()))report.errors.push({phase,kind:'CONSOLE_ERROR'});});
      page.on('response',response=>{const url=new URL(response.url());if(url.pathname.includes('/ai-conversation')||url.pathname.includes('/ai-summary'))calls.push({method:response.request().method(),path:url.pathname,status:response.status()});});
      await page.goto(origin);const credential=sandbox.credentials.find(c=>c.role===role);assert(credential.email.endsWith('.test'));
      await page.getByLabel('시험 이메일',{exact:true}).fill(credential.email);await page.getByLabel('시험 비밀번호',{exact:true}).fill(credential.password);
      await page.getByRole('button',{name:'로그인',exact:true}).click();
      await page.locator('[data-home-news]').waitFor();
      await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('서버와 연결'));
      const capture=async label=>{const name=viewport.width+'-'+role+'-'+label+'.png';await page.screenshot({path:path.join(folder,name),mask:[page.locator('input[type=password]'),page.locator('input[type=email]'),page.locator('.account-panel')]});report.screenshots.push(name);};
      phase=viewport.width+':'+role+':FRESH_HOME';
      const button=page.locator('[data-action="ai-assistant"]');
      report.observations.push({width:viewport.width,role,freshHomeButtonDisabled:await button.isDisabled(),priorAiCalls:calls.length});
      await capture('fresh-home');
      assert.equal(await button.isDisabled(),false,'HOME_AI_BUTTON_DISABLED_WITH_AUTHORIZED_CHILD');
      await button.click();await ready(page);
      assert(calls.some(c=>c.method==='GET'&&c.path===base+'/ai-conversation'&&c.status===200),'HOME_AI_REAL_CONVERSATION_READ');
      const dialog=page.locator('.ai-assistant[open]');
      await dialog.locator('[data-ai-input]').fill('사진 첨부 방법을 알려주세요.');
      await dialog.getByRole('button',{name:'보내기',exact:true}).click();
      await dialog.locator('.ai-bubble.assistant').waitFor();
      assert((await dialog.locator('.ai-bubble.assistant').innerText()).includes('시연용 예시'));
      assert(calls.some(c=>c.method==='POST'&&c.path===base+'/ai-conversation'&&c.status===200),'HOME_AI_REAL_SEND');
      await capture('answer');
      let revisedSource=false;
      if(role==='therapist'){
        phase=viewport.width+':SUMMARY_SOURCE';
        await dialog.locator('[data-ai-action="summary"]').click();
        await dialog.locator('[data-ai-record] option[value="'+ids.recordId+'"]').waitFor({state:'attached'});
        await dialog.locator('[data-ai-record]').selectOption(ids.recordId);
        await dialog.locator('[data-ai-action="generate"]').waitFor();
        const records=new Records(sandbox.database),actor={userId:ids.therapistId,centerId:ids.centerId};
        const original=await records.get(actor,{conversationId:ids.conversationId,recordId:ids.recordId});
        assert((await dialog.locator('.ai-source').innerText()).includes(original.performed));
        await dialog.locator('[data-ai-action="generate"]').click();await dialog.locator('.ai-generated').waitFor();
        assert((await dialog.locator('.ai-generated').innerText()).includes(original.response));
        await dialog.locator('[data-ai-action="close"]').click();
        const updatedText='가상 수정 확인: 세모 블록을 골랐다고 기록했습니다.';
        await records.save(actor,{conversationId:ids.conversationId,recordId:ids.recordId,clientId:randomUUID(),expectedRevision:original.revision,
          content:{date:original.date,title:original.title,goalId:original.goalId,status:'saved',performed:updatedText,response:original.response,
            privateNote:original.privateNote,nextPlan:original.nextPlan,summary:original.summary,assessments:[],activity:original.activity??null,observation:original.observation??null}});
        await button.click();await ready(page);await dialog.locator('[data-ai-action="summary"]').click();
        await dialog.locator('[data-ai-record] option[value="'+ids.recordId+'"]').waitFor({state:'attached'});await dialog.locator('[data-ai-record]').selectOption(ids.recordId);
        await dialog.locator('[data-ai-action="generate"]').waitFor();
        assert((await dialog.locator('.ai-source').innerText()).includes(updatedText),'HOME_AI_SOURCE_REFRESHED_FROM_SERVER');
        await dialog.locator('[data-ai-action="generate"]').click();await dialog.locator('.ai-generated').waitFor();
        assert((await dialog.locator('.ai-generated').innerText()).includes(updatedText));
        revisedSource=true;await capture('updated-record-source');
      }else assert.equal(await dialog.locator('[data-ai-action="summary"]').count(),0);
      await dialog.locator('[data-ai-action="close"]').click();await dialog.waitFor({state:'detached'});
      assert.equal(await page.locator('.main-nav [data-view="home"]').getAttribute('aria-current'),'page','HOME_AI_CLOSE_PRESERVES_HOME');
      assert(await page.getByTestId('home').isVisible());
      assert(await button.evaluate(node=>document.activeElement===node),'HOME_AI_CLOSE_RESTORES_FOCUS');
      const held=Promise.withResolvers(),release=Promise.withResolvers(),released=Promise.withResolvers();
      const loadingRoute=async route=>{
        if(route.request().method()!=='GET')return route.continue();
        held.resolve();await release.promise;
        try{await route.continue();}catch{}finally{released.resolve();}
      };
      await page.route(origin+base+'/ai-conversation',loadingRoute);
      try{
        await button.click();await bounded(held.promise);
        await page.locator('.ai-assistant[open] [data-ai-action="close"]').click();
        assert(await button.evaluate(node=>document.activeElement===node),'HOME_AI_LOADING_CLOSE_RESTORES_FOCUS');
      }finally{
        release.resolve();await bounded(released.promise);await page.unroute(origin+base+'/ai-conversation',loadingRoute);
      }
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.deepEqual(await page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
      assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);
      report.checks.push({...viewport,role,homeEntry:true,realGet:true,realSend:true,recordSourceUpdated:revisedSource,homePreserved:true,closeFocusRestored:true,loadingCloseFocusRestored:true});
      await context.close();contexts.delete(context);await sandbox.close();assert(sandbox.database.closed);sandboxes.delete(sandbox);
      console.log(JSON.stringify({width:viewport.width,role,passed:true}));
    }
    for(const variant of ['multiple','empty']){
      phase=variant+':SETUP';
      const sandbox=await createPrototypeSandbox({port:0});sandboxes.add(sandbox);roots.add(sandbox.mediaRoot);
      const {ids,origin}=sandbox;
      const extra={childId:'home-ai-child-'+randomUUID(),roomId:'home-ai-room-'+randomUUID()};
      if(variant==='multiple')await sandbox.database.transaction(async tx=>{
        await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)',[ids.centerId,extra.childId]);
        await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)',[ids.centerId,extra.roomId,extra.childId]);
        await tx.query("INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence) VALUES ($1,$2,$3,'therapist',true,1)",[ids.centerId,extra.roomId,ids.therapistId]);
        await tx.query("INSERT INTO cb_child_profiles(center_id,child_id,name,revision,updated_by) VALUES ($1,$2,'가상 둘째 아동',1,$3)",[ids.centerId,extra.childId,ids.therapistId]);
      });
      else await sandbox.database.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND user_id=$2',[ids.centerId,ids.guardianId]);
      const role=variant==='multiple'?'therapist':'guardian';
      const context=await browser.newContext({viewport:{width:390,height:844},locale:'ko-KR',isMobile:true,hasTouch:true,serviceWorkers:'block',permissions:[]});contexts.add(context);
      const calls=[];
      await context.route('**/*',route=>{
        const request=route.request(),url=new URL(request.url());
        if(url.origin!==origin||!['GET','POST'].includes(request.method())){report.unexpectedRequests.push({phase,method:request.method()});return route.abort();}
        return route.continue();
      });
      const page=await context.newPage();page.setDefaultTimeout(15000);
      page.on('pageerror',()=>report.errors.push({phase,kind:'PAGE_ERROR'}));
      page.on('response',response=>{const url=new URL(response.url());if(url.pathname.includes('/ai-conversation')||url.pathname.endsWith('/read'))calls.push({path:url.pathname,method:response.request().method(),status:response.status()});});
      await page.goto(origin);const credential=sandbox.credentials.find(c=>c.role===role);
      await page.getByLabel('시험 이메일',{exact:true}).fill(credential.email);await page.getByLabel('시험 비밀번호',{exact:true}).fill(credential.password);
      await page.getByRole('button',{name:'로그인',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('서버와 연결'));
      const button=page.locator('[data-action="ai-assistant"]');
      if(variant==='multiple'){
        phase='MULTI_CHILD_SELECTION';
        assert.equal(await button.isDisabled(),false);await button.click();
        const picker=page.locator('.ai-child-picker[open]');await picker.waitFor();
        assert.equal(await picker.locator('[data-ai-child]').count(),2);assert.equal(calls.length,0);
        await picker.locator('[data-ai-child="'+extra.roomId+'"]').click();await ready(page);
        const aiCalls=calls.filter(c=>c.path.endsWith('/ai-conversation'));
        assert.equal(aiCalls.length,1);assert(aiCalls[0].path.endsWith('/'+extra.roomId+'/ai-conversation'));
        assert.equal(calls.filter(c=>c.path.endsWith('/read')).length,0,'HOME_AI_DOES_NOT_MARK_CHAT_READ');
        await page.locator('[data-ai-action="close"]').click();
        assert.equal(await page.locator('.main-nav [data-view="home"]').getAttribute('aria-current'),'page');
        await page.reload();await page.waitForFunction(()=>document.querySelector('#status')?.textContent.includes('서버와 연결'));
        await page.locator('[data-action="ai-assistant"]').click();await picker.waitFor();await picker.press('Escape');await picker.waitFor({state:'detached'});
        assert.equal(await page.locator('.ai-assistant[open]').count(),0);
        report.checks.push({variant,explicitChildSelection:true,selectedChildOnly:true,noReadMutation:true,cancelSafe:true,homePreserved:true});
      }else{
        phase='NO_AUTHORIZED_CHILD';
        assert.equal(await button.isDisabled(),true);assert.equal(calls.length,0);
        assert((await button.getAttribute('title'))?.length>0,'HOME_AI_EMPTY_CONTEXT_EXPLAINED');
        report.checks.push({variant,disabledWithExplanation:true,aiCalls:0});
      }
      const name=variant+'-home.png';await page.screenshot({path:path.join(folder,name),mask:[page.locator('input[type=password]'),page.locator('input[type=email]'),page.locator('.account-panel')]});report.screenshots.push(name);
      assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);
      await context.close();contexts.delete(context);await sandbox.close();sandboxes.delete(sandbox);
      console.log(JSON.stringify({variant,passed:true}));
    }
    report.finalSource=await manifest();assert.equal(report.source.sha256,report.finalSource.sha256,'HOME_AI_SOURCE_CHANGED');
  }catch(error){
    report.failure={phase,kind:error?.name,code:/^HOME_AI_[A-Z_]+$/.test(error?.message??'')?error.message:undefined,line:Number(error?.stack?.match(/local-home-ai-browser\.mjs:(\d+):/)?.[1])||null};
    for(const context of contexts)for(const page of context.pages())try{const name='failure-'+report.screenshots.length+'.png';await page.screenshot({path:path.join(folder,name),mask:[page.locator('input[type=password]'),page.locator('input[type=email]'),page.locator('.account-panel')]});report.screenshots.push(name);}catch{}
  }finally{
    for(const context of contexts)try{await bounded(context.close());contexts.delete(context);}catch{}
    report.cleanup.contextsClosed=contexts.size===0;
    if(server)try{await bounded(server.close());}catch{try{await bounded(server.kill());}catch{}}
    report.cleanup.browserStopped=typeof browserProcess?.exitCode==='number'||typeof browserProcess?.signalCode==='string';
    for(const sandbox of sandboxes)try{await bounded(sandbox.close());sandboxes.delete(sandbox);}catch{}
    report.cleanup.sandboxesClosed=sandboxes.size===0;report.cleanup.privateRootsRemoved=(await Promise.all([...roots].map(removed))).every(Boolean);
    report.passed=!report.failure&&report.checks.length===8&&Object.values(report.cleanup).every(Boolean);
    await writeFile(path.join(folder,'results.json'),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify({runId,passed:report.passed,checks:report.checks.length,failure:report.failure,cleanup:report.cleanup}));
  return report.passed;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(!await run())process.exitCode=1;}catch{console.error('HOME_AI_BROWSER_CONFIGURATION_FAILED');process.exitCode=1;}
}
