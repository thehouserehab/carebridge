// Real browser regression for returning to a mobile conversation after an AI
// modal. Fresh synthetic memory DB only; no uploads or model calls are made.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { workspaceRoom } from './local-workspace-browser-helpers.mjs';
import { createLocalAiApiSandbox } from '../server/local-api-sandbox.mjs';
import { Conversations } from '../server/conversations.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
async function manifest(){
  const names=['tests/local-ai-dismiss-browser.mjs','tests/local-workspace-browser-helpers.mjs','local-api/app.js',
    'local-api/ai-assistant-ui.js','local-api/audio-notes-ui.js','local-api/audio-notes-client.js','local-api/styles.css','local-api/workspace-ui.js'];
  const files=await Promise.all(names.map(async name=>({name,sha256:digest(await readFile(path.join(root,name)))})));
  return{sha256:digest(JSON.stringify(files)),files};
}
async function geometry(page){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  return page.evaluate(()=>{
    const measure=selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect();return{
      top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height,
      visible:r.top>=0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,
      hit:[[r.left+4,r.top+4],[r.right-4,r.top+4],[r.left+4,r.bottom-4],[r.right-4,r.bottom-4],
        [r.left+r.width/2,r.top+r.height/2]].every(([x,y])=>node.contains(document.elementFromPoint(x,y)))};};
    const list=document.querySelector('[data-testid="message-list"]'),top=list.getBoundingClientRect().top+list.clientTop;
    const anchor=[...list.querySelectorAll('[data-message-id]')].find(row=>row.getBoundingClientRect().bottom>top);
    return{viewport:{width:innerWidth,height:innerHeight},scrollY,pageWidth:document.documentElement.scrollWidth,
      header:measure('.room-head'),nav:measure('.main-nav'),composer:measure('.composer'),input:measure('.composer textarea'),
      send:measure('.composer button[type="submit"]'),draft:document.querySelector('.composer textarea').value,
      focusedId:document.activeElement?.id??'',reading:{scrollTop:list.scrollTop,clientHeight:list.clientHeight,scrollHeight:list.scrollHeight,
        anchor:anchor?.dataset.messageId??null,offset:anchor?anchor.getBoundingClientRect().top-top:0}};
  });
}
function fits(value){
  assert(value.pageWidth<=value.viewport.width+1,'HORIZONTAL_OVERFLOW');
  assert(value.header.visible&&value.composer.visible&&value.input.visible&&value.send.visible,'COMPOSER_OUTSIDE_VIEWPORT');
  assert(value.input.hit&&value.send.hit,'COMPOSER_OBSCURED');
  assert(value.send.height>=44&&value.composer.bottom<=value.nav.top+1&&value.send.bottom<=value.nav.top+1,'COMPOSER_BELOW_NAV');
}
export async function run(args=process.argv.slice(2)){
  const options=messageBrowserOptions(args),{chromium}=await import(pathToFileURL(options.module).href);
  const runId=randomUUID(),folder=path.join(root,'test-results','local-ai-dismiss-'+runId);await mkdir(folder,{recursive:true});
  const report={runId,source:await manifest(),passed:false,actualModelCalls:0,checks:[],errors:[],unexpectedRequests:[],
    cleanup:{contextsClosed:false,browserStopped:false,sandboxesClosed:false}};
  const ownership={runId,testProcessId:process.pid,browserProcessId:null,origins:[],finished:false};
  const contexts=new Set(),sandboxes=new Set();let server,browser,phase='START';
  const save=()=>writeFile(path.join(folder,'ownership.json'),JSON.stringify(ownership,null,2));await save();
  try{
    server=await chromium.launchServer({headless:true,executablePath:options.executable,host:'127.0.0.1',port:0,env:studyChildEnvironment(),timeout:30000});
    ownership.browserProcessId=server.process().pid;await save();browser=await chromium.connect(server.wsEndpoint());
    for(const viewport of [{width:320,height:568},{width:390,height:844},{width:390,height:420}])for(const audio of [false,true]){
      phase=`${viewport.width}x${viewport.height}:${audio?'audio':'ordinary'}`;
      const noCall=async()=>assert.fail('MODEL_MUST_NOT_BE_CALLED');
      const sandbox=await createLocalAiApiSandbox({summaryProvider:{mode:'fixture',model:'fixture-summary',generate:noCall},
        chatProvider:{mode:'fixture',model:'fixture-chat',respond:noCall},
        ...(audio?{audioProvider:{mode:'fixture',model:'fixture-audio',transcriptionModel:'fixture-transcript',generate:noCall}}:{})});
      sandboxes.add(sandbox);ownership.origins.push(sandbox.origin);await save();
      const conversations=new Conversations(sandbox.database),ids=sandbox.ids;
      for(let i=0;i<18;i++)await conversations.sendText({centerId:ids.centerId,userId:ids.therapistId},
        {conversationId:ids.conversationId,clientId:randomUUID(),body:`합성 읽기 위치 시험 ${i+1}. 실제 아동 정보가 없는 가상 메시지입니다.`});
      const context=await browser.newContext({viewport,locale:'ko-KR',isMobile:true,hasTouch:true,serviceWorkers:'block',permissions:[]});contexts.add(context);
      await context.route('**/*',route=>{
        if(new URL(route.request().url()).origin!==sandbox.origin||!['GET','POST'].includes(route.request().method())){
          report.unexpectedRequests.push({phase});return route.abort();
        }return route.continue();
      });
      const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',()=>report.errors.push({phase,kind:'PAGE_ERROR'}));
      await page.goto(sandbox.origin);const credential=sandbox.credentials.find(item=>item.role===(audio?'therapist':'guardian'));
      await page.getByLabel('시험 이메일',{exact:true}).fill(credential.email);await page.getByLabel('시험 비밀번호',{exact:true}).fill(credential.password);
      await page.getByRole('button',{name:'로그인',exact:true}).click();await page.getByTestId('home').waitFor();await workspaceRoom(page,ids.conversationId);
      const input=page.locator('.composer textarea');await input.fill('합성 미전송 초안 · 닫은 뒤에도 유지');
      const initial=await geometry(page);fits(initial);
      const list=page.locator('[data-testid="message-list"]'),bounds=await list.boundingBox();
      await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.wheel(0,-180);
      await page.waitForFunction(()=>{const list=document.querySelector('[data-testid="message-list"]');return list.scrollHeight-list.scrollTop-list.clientHeight>60;});
      const before=await geometry(page);fits(before);
      await page.locator('[data-action="ai-assistant"]').click();await page.locator('.ai-assistant[open]').waitFor();
      if(audio){
        await page.locator('[data-ai-action="audio"]:not([disabled])').waitFor();
        const transitionBefore=await page.evaluate(()=>scrollY);
        await page.locator('[data-ai-action="audio"]').click();await page.locator('.audio-notes[open]').waitFor();
        assert(Math.abs(await page.evaluate(()=>scrollY)-transitionBefore)<=1,'TRANSITION_REALIGNED_CHAT');
        // Escape is the same explicit dismissal path as the close button.
        await page.keyboard.press('Escape');await page.locator('.audio-notes[open]').waitFor({state:'hidden'});
      }else{
        assert.equal(await page.locator('[data-ai-action="audio"]').count(),0);
        await page.locator('[data-ai-action="close"]').click();await page.locator('.ai-assistant[open]').waitFor({state:'hidden'});
      }
      const after=await geometry(page);fits(after);
      assert.equal(after.draft,before.draft,'DRAFT_CHANGED');assert.equal(after.reading.anchor,before.reading.anchor,'READING_ANCHOR_CHANGED');
      assert(Math.abs(after.reading.offset-before.reading.offset)<=1,'READING_OFFSET_CHANGED');
      assert(Math.abs(after.reading.scrollTop-before.reading.scrollTop)<=1,'READING_SCROLL_CHANGED');assert.equal(after.focusedId,'room-title');
      await page.screenshot({path:path.join(folder,`${viewport.width}x${viewport.height}-${audio?'audio':'ordinary'}-dismissed.png`),mask:[page.locator('.account-panel')]});
      report.checks.push({phase,viewport,audio,before,after});
      await context.close();contexts.delete(context);await sandbox.close();sandboxes.delete(sandbox);
    }
    report.finalSource=await manifest();assert.equal(report.source.sha256,report.finalSource.sha256,'SOURCE_CHANGED');
    assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);
  }catch(error){report.failure={phase,kind:error?.name,message:String(error?.message??'').slice(0,160)};}
  finally{
    for(const context of contexts)await context.close();report.cleanup.contextsClosed=true;
    await browser?.close();await server?.close();report.cleanup.browserStopped=true;
    for(const sandbox of sandboxes)await sandbox.close();report.cleanup.sandboxesClosed=true;
    ownership.finished=true;await save();report.passed=!report.failure&&report.checks.length===6&&Object.values(report.cleanup).every(Boolean);
    await writeFile(path.join(folder,'results.json'),JSON.stringify(report,null,2));
  }
  console.log(JSON.stringify({runId,passed:report.passed,checks:report.checks.length,failure:report.failure,cleanup:report.cleanup}));
  if(!report.passed)process.exitCode=1;return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await run();
