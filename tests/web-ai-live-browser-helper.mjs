import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {seed} from '../src/seed.js';
import {upgradeState} from '../src/conversations.js';
import {validateState} from '../src/domain.js';
import {STORAGE_KEY} from '../src/config.js';
import {studyChildEnvironment} from '../scripts/p0-study-policy.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function webAiVerificationFixture(){
  const fixture=upgradeState(seed());
  Object.assign(fixture.records[0],{format:'structured',performed:'가상 활동: 파란 블록과 노란 블록 중 골랐어요.',response:'가상 반응: 파란 블록을 골랐어요.',privateNote:'SYNTHETIC_PRIVATE_NEVER_SEND'});
  assert(validateState(fixture));return fixture;
}
/** Owned browser and synthetic storage only. The caller supplies the observed deployment origin.
 * Two model actions maximum; actual OpenAI execution also requires server transport evidence.
 */
export async function verifyLiveWebAi({origin,accessCode,reportDirectory,
  playwrightModule=process.env.PLAYWRIGHT_MODULE,executablePath=process.env.STUDY_CHROMIUM_EXECUTABLE}={}){
  let url;try{url=new URL(origin);}catch{throw Error('WEB_AI_CHECK_CONFIGURATION');}
  if(url.origin!==origin||url.username||url.password||url.search||url.hash||
    !(url.protocol==='https:'||(url.protocol==='http:'&&url.hostname==='127.0.0.1'))||
    typeof accessCode!=='string'||!accessCode||accessCode.length>256||
    ![reportDirectory,playwrightModule,executablePath].every(value=>typeof value==='string'&&path.isAbsolute(value)))throw Error('WEB_AI_CHECK_CONFIGURATION');
  const fixture=webAiVerificationFixture(),expectedSource={performed:fixture.records[0].performed,response:fixture.records[0].response};
  await mkdir(reportDirectory,{recursive:true});
  const report={passed:false,syntheticOnly:true,modelActionsAttempted:0,checks:[],responses:[],errors:[],unexpectedRequests:[],screenshots:[],cleanup:{contextClosed:false,browserClosed:false}};
  let chrome,browser,context,phase='START',posts=0;
  try{
    const {chromium}=await import(pathToFileURL(playwrightModule).href);
    chrome=await chromium.launchServer({executablePath,headless:true,host:'127.0.0.1',port:0,env:studyChildEnvironment()});
    browser=await chromium.connect(chrome.wsEndpoint());
    context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ko-KR',serviceWorkers:'block',permissions:[],acceptDownloads:false});
    await context.addInitScript(({fixture,key})=>{if(localStorage.length||sessionStorage.length)throw Error('FRESH_CONTEXT_REQUIRED');localStorage.setItem(key,JSON.stringify(fixture));},{fixture,key:STORAGE_KEY});
    await context.route('**/*',route=>{
      const request=route.request(),target=new URL(request.url());
      const model=request.method()==='POST'&&target.pathname==='/api/ai/respond';
      const session=target.pathname==='/api/ai/session'&&['GET','POST','DELETE'].includes(request.method());
      if(target.origin!==origin||(!(request.method()==='GET'||session||model))||(model&&++posts>2)){report.unexpectedRequests.push({phase,method:request.method()});return route.abort();}
      if(model){const body=request.postDataJSON();assert.equal(body.syntheticConfirmed,true);assert(!request.postData().includes('SYNTHETIC_PRIVATE_NEVER_SEND'));}
      return route.continue();
    });
    const page=await context.newPage();page.setDefaultTimeout(35000);page.on('pageerror',()=>report.errors.push({phase,kind:'PAGE_ERROR'}));
    const capture=async name=>{await page.screenshot({path:path.join(reportDirectory,name),mask:[page.locator('[type=password]')]});report.screenshots.push(name);};
    phase='HOME';await page.goto(origin);assert.equal(new URL(page.url()).origin,origin);
    const entry=page.getByRole('button',{name:'AI 도우미',exact:true});await entry.click();const dialog=page.locator('dialog.web-ai[open]');
    await dialog.locator('[name=accessCode]:enabled').waitFor();assert.equal(posts,0);
    phase='SESSION';await dialog.locator('[name=accessCode]').fill(accessCode);await dialog.locator('[name=synthetic]').check();
    await dialog.getByRole('button',{name:'AI 연결',exact:true}).click();await dialog.locator('[data-web-ai-message]:enabled').waitFor();
    assert.equal(await dialog.locator('[name=accessCode]').count(),0);report.checks.push({kind:'authenticatedHomeEntry',passed:true});
    phase='CHAT';await dialog.locator('[data-web-ai-message]').fill('가상 자료 연결 시험입니다. 파란 블록과 노란 블록 중 파란 블록을 골랐다는 가상 관찰을 보호자에게 전하는 한 문장으로 다듬어 주세요. 다른 사실이나 진단은 넣지 마세요.');
    const chatResponse=page.waitForResponse(response=>response.url()===origin+'/api/ai/respond'&&response.request().method()==='POST');
    report.modelActionsAttempted++;await dialog.getByRole('button',{name:'보내기',exact:true}).click();const chat=await chatResponse;
    report.responses.push({kind:'chat',status:chat.status()});assert.equal(chat.status(),200);const chatValue=await chat.json();assert.equal(chatValue.mode,'openai');
    await dialog.locator('.web-ai-bubble.assistant').waitFor();const answer=await dialog.locator('.web-ai-bubble.assistant p').innerText();assert.equal(answer,chatValue.text);assert(answer.trim());
    report.checks.push({kind:'actualModeChat',responseLength:answer.length,responseSha256:hash(answer),mode:chatValue.mode,model:chatValue.model});await capture('desktop-chat.png');
    for(const viewport of [{width:390,height:844},{width:320,height:568}]){
      phase=viewport.width+':LAYOUT';await page.setViewportSize(viewport);await dialog.locator('.web-ai-bubble.assistant').scrollIntoViewIfNeeded();
      const layout=await dialog.evaluate(node=>{const d=node.getBoundingClientRect(),input=node.querySelector('textarea').getBoundingClientRect();return{noOverflow:document.documentElement.scrollWidth<=innerWidth+1,dialogFits:d.left>=-1&&d.right<=innerWidth+1&&d.top>=-1&&d.bottom<=innerHeight+1,inputFits:input.top>=0&&input.bottom<=innerHeight+1};});
      assert(Object.values(layout).every(Boolean));report.checks.push({kind:'mobileLayout',width:viewport.width,...layout});await capture(viewport.width+'-chat.png');
    }
    await page.setViewportSize({width:1440,height:1000});phase='SUMMARY_PREVIEW';await dialog.getByRole('button',{name:'기록 요약',exact:true}).click();
    await dialog.locator('[data-web-ai-record]').selectOption('r1');assert.equal(posts,1);assert((await dialog.locator('.web-ai-source').innerText()).includes(expectedSource.performed));
    const summaryResponse=page.waitForResponse(response=>response.url()===origin+'/api/ai/respond'&&response.request().method()==='POST');
    phase='SUMMARY';report.modelActionsAttempted++;await dialog.locator('[data-web-ai=generate]').click();const summary=await summaryResponse;
    report.responses.push({kind:'summary',status:summary.status()});assert.equal(summary.status(),200);assert.deepEqual(summary.request().postDataJSON().source,expectedSource);
    const summaryValue=await summary.json();assert.equal(summaryValue.mode,'openai');await dialog.locator('[data-web-ai-draft]').waitFor();
    const draft=await dialog.locator('[data-web-ai-draft]').innerText();assert.equal(draft,summaryValue.summary);assert(draft.trim());
    report.checks.push({kind:'actualModeSummary',responseLength:draft.length,responseSha256:hash(draft),sourceFieldsOnly:true,mode:summaryValue.mode,model:summaryValue.model});
    assert.deepEqual(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),STORAGE_KEY),fixture);report.checks.push({kind:'noAutomaticRecordWrite',passed:true});await capture('desktop-summary.png');
    phase='LOGOUT';await dialog.getByRole('button',{name:'연결 종료',exact:true}).click();await dialog.locator('[name=accessCode]:enabled').waitFor();
    assert.equal(await dialog.locator('.web-ai-bubble').count(),0);assert.equal(posts,2);assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);
    report.checks.push({kind:'logoutClearsConversation',passed:true});report.passed=true;
  }catch{report.errors.push({phase,kind:'WEB_AI_CHECK_FAILED'});}
  finally{
    try{await context?.close();report.cleanup.contextClosed=true;}catch{report.errors.push({phase:'CLEANUP',kind:'CONTEXT_CLOSE_FAILED'});}
    try{await browser?.close();await chrome?.close();report.cleanup.browserClosed=true;}catch{report.errors.push({phase:'CLEANUP',kind:'BROWSER_CLOSE_FAILED'});}
    report.passed=report.passed&&!report.errors.length;await writeFile(path.join(reportDirectory,'report.json'),JSON.stringify(report,null,2)+'\n');
  }
  return report;
}
