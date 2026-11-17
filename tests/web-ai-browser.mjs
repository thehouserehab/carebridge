import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {seed} from '../src/seed.js';
import {upgradeState} from '../src/conversations.js';
import {validateState} from '../src/domain.js';
import {STORAGE_KEY} from '../src/config.js';
import {messageBrowserOptions} from './message-browser-policy.mjs';
import {studyChildEnvironment} from '../scripts/p0-study-policy.mjs';
import {verifyLiveWebAi} from './web-ai-live-browser-helper.mjs';
const options=messageBrowserOptions(process.argv.slice(2));
const root=fileURLToPath(new URL('../',import.meta.url)),folder=root+'test-results/web-ai-browser-'+randomUUID();
await mkdir(folder,{recursive:true});
const fixture=upgradeState(seed());
Object.assign(fixture.records[0],{format:'structured',performed:'가상 활동: 파란 블록과 노란 블록 중 골랐어요.',response:'가상 반응: 파란 블록을 골랐어요.',privateNote:'SYNTHETIC_PRIVATE_NEVER_SEND'});
assert(validateState(fixture));
const calls=[],errors=[],checks=[];let phase='START',origin,browser,chrome,lastPage;
const json=(response,value,status=200,headers={})=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store',...headers});response.end(JSON.stringify(value));};
const server=createServer(async(request,response)=>{
  try{
    const url=new URL(request.url,origin),authenticated=request.headers.cookie?.includes('synthetic-web-ai=1')===true;
    if(url.pathname.startsWith('/api/ai/')){
      let raw='';for await(const chunk of request){raw+=chunk;if(raw.length>30000)throw Error('BODY_LIMIT');}
      const body=raw?JSON.parse(raw):null;
      calls.push({method:request.method,path:url.pathname,body});
      if(url.pathname==='/api/ai/session'){
        if(request.method==='GET')return json(response,{authenticated,enabled:true,mode:'openai'});
        assert.equal(request.headers['x-carebridge-ai'],'1');
        if(request.method==='DELETE')return json(response,{authenticated:false,enabled:true,mode:'openai'},200,{'set-cookie':'synthetic-web-ai=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
        if(body.accessCode!=='synthetic-access-only')return json(response,{error:{code:'INVALID_ACCESS_CODE'}},401);
        assert.equal(body.syntheticConfirmed,true);
        return json(response,{authenticated:true,enabled:true,mode:'openai'},200,{'set-cookie':'synthetic-web-ai=1; HttpOnly; SameSite=Strict; Path=/'});
      }
      if(!authenticated)return json(response,{error:{code:'AUTH_REQUIRED'}},401);
      assert.equal(body.syntheticConfirmed,true);assert.equal(request.headers['x-carebridge-ai'],'1');
      assert(!raw.includes('SYNTHETIC_PRIVATE_NEVER_SEND'));assert(!raw.includes('synthetic-access-only'));
      if(body.kind==='chat')return json(response,{kind:'chat',text:'가상 관찰에 따르면 파란 블록을 골랐어요. <script>실행하지 않아요</script>',mode:'openai',model:'synthetic-contract'});
      assert.deepEqual(body.source,{performed:fixture.records[0].performed,response:fixture.records[0].response});
      return json(response,{kind:'summary',summary:'가상 놀이에서 파란 블록을 직접 골랐어요.',reviewNotes:['가상 자료를 확인해 주세요.'],mode:'openai',model:'synthetic-contract'});
    }
    assert.equal(request.method,'GET');
    assert(url.pathname==='/'||url.pathname==='/favicon.svg'||/^\/src\/[a-z-]+\.(js|css)$/.test(url.pathname));
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    const type=file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.svg')?'image/svg+xml':'text/html';
    response.writeHead(200,{'content-type':type});response.end(await readFile(root+file));
  }catch{errors.push({phase,kind:'MOCK_SERVER_FAILURE'});json(response,{error:{code:'INVALID_INPUT'}},400);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
const report={passed:false,actualModelCalls:0,checks,errors,screenshots:[],provider:'explicit mock API',cleanup:{browserClosed:false,serverClosed:false}};
try{
  const {chromium}=await import(pathToFileURL(options.module).href);
  chrome=await chromium.launchServer({executablePath:options.executable,headless:true,host:'127.0.0.1',port:0,env:studyChildEnvironment()});
  browser=await chromium.connect(chrome.wsEndpoint());
  for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:568}]){
    phase=viewport.width+':SETUP';const before=calls.length;
    const context=await browser.newContext({viewport,isMobile:viewport.width<600,hasTouch:viewport.width<600,locale:'ko-KR',serviceWorkers:'block'});
    await context.addInitScript(({fixture,key})=>{localStorage.setItem(key,JSON.stringify(fixture));},{fixture,key:STORAGE_KEY});
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
    const page=await context.newPage();lastPage=page;page.setDefaultTimeout(10000);
    page.on('pageerror',()=>errors.push({phase,kind:'PAGE_ERROR'}));
    await page.goto(origin);const entry=page.getByRole('button',{name:'AI 도우미',exact:true});await entry.waitFor();
    const pageWidth=await page.evaluate(()=>({actual:document.documentElement.scrollWidth,available:visualViewport.width}));assert(pageWidth.actual<=viewport.width+1&&pageWidth.available<=viewport.width+1,JSON.stringify(pageWidth));
    await entry.click();const dialog=page.locator('dialog.web-ai[open]');await dialog.locator('input[name=accessCode]:enabled').waitFor();
    assert(!calls.slice(before).some(call=>call.path.endsWith('respond')));
    await dialog.locator('[name=accessCode]').fill('synthetic-access-only');await dialog.locator('[name=synthetic]').check();await dialog.getByRole('button',{name:'AI 연결',exact:true}).click();
    await dialog.locator('[data-web-ai-message]:enabled').waitFor();
    assert.equal(await dialog.locator('[name=accessCode]').count(),0);
    phase=viewport.width+':CHAT';await dialog.locator('[data-web-ai-message]').fill('가상 자료 연결 시험입니다. 블록 놀이 관찰을 짧게 정리해 주세요.');
    report.lastBeforeSend=await dialog.evaluate(node=>({innerWidth,innerHeight,dialog:node.getBoundingClientRect().toJSON(),position:getComputedStyle(node).position,viewport:{width:visualViewport.width,height:visualViewport.height,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale},send:node.querySelector('[type=submit]').getBoundingClientRect().toJSON()}));
    await dialog.getByRole('button',{name:'보내기',exact:true}).click();
    await dialog.locator('.web-ai-bubble.assistant').waitFor();assert.equal(await dialog.locator('script').count(),0);
    assert((await dialog.locator('.web-ai-bubble.assistant').innerText()).includes('<script>'));
    const bounds=await dialog.evaluate(node=>{const d=node.getBoundingClientRect(),i=node.querySelector('textarea').getBoundingClientRect();return{dialogFits:d.left>=-1&&d.right<=innerWidth+1&&d.top>=-1&&d.bottom<=innerHeight+1,inputFits:i.top>=0&&i.bottom<=innerHeight};});
    const chatShot=viewport.width+'-chat.png';await page.screenshot({path:folder+'/'+chatShot});report.screenshots.push(chatShot);
    if(!Object.values(bounds).every(Boolean)){report.layoutFailure={width:viewport.width,...bounds};assert.fail('LAYOUT');}
    phase=viewport.width+':SUMMARY';await dialog.getByRole('button',{name:'기록 요약',exact:true}).click();await dialog.locator('[data-web-ai-record]').selectOption('r1');
    assert.equal(calls.slice(before).filter(call=>call.path.endsWith('respond')).length,1);
    assert((await dialog.locator('.web-ai-source').innerText()).includes(fixture.records[0].performed));
    await dialog.locator('[data-web-ai=generate]').click();await dialog.locator('[data-web-ai-draft]').waitFor();
    assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).records[0].summary,STORAGE_KEY),fixture.records[0].summary);
    await dialog.locator('[data-web-ai-replace]').check();await dialog.locator('[data-web-ai=apply]').click();await dialog.waitFor({state:'detached'});
    const record=page.locator('#dialog[open]');await record.waitFor();assert.equal(await record.locator('[name=summary]').inputValue(),'가상 놀이에서 파란 블록을 직접 골랐어요.');
    assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).records[0].summary,STORAGE_KEY),fixture.records[0].summary);
    const summaryShot=viewport.width+'-summary-unsaved.png';await page.screenshot({path:folder+'/'+summaryShot});report.screenshots.push(summaryShot);
    checks.push({width:viewport.width,homeEntry:true,gateBeforeCall:true,chat:true,escaped:true,...bounds,summaryPreview:true,summaryUnsaved:true,sourceFieldsOnly:true});
    await context.close();
  }
  assert.deepEqual(errors,[]);assert.equal(calls.filter(call=>call.path.endsWith('respond')).length,6);
  phase='REUSABLE_HELPER';
  const liveHelper=await verifyLiveWebAi({origin,accessCode:'synthetic-access-only',reportDirectory:folder+'/live-helper',playwrightModule:options.module,executablePath:options.executable});
  assert.equal(liveHelper.passed,true);assert.equal(liveHelper.modelActionsAttempted,2);report.liveHelperPassed=true;
  assert.equal(calls.filter(call=>call.path.endsWith('respond')).length,8);report.passed=true;
}catch(error){errors.push({phase,kind:'WEB_AI_BROWSER_FAILED',diagnostic:String(error.message).slice(0,1000)});await lastPage?.screenshot({path:folder+'/failure.png',mask:[lastPage.locator('[type=password]')]}).catch(()=>{});}
finally{
  try{await browser?.close();await chrome?.close();report.cleanup.browserClosed=true;}catch{errors.push({phase:'CLEANUP',kind:'BROWSER_CLOSE_FAILED'});}
  await new Promise(resolve=>server.close(resolve));report.cleanup.serverClosed=true;
  report.passed=report.passed&&!errors.length;await writeFile(folder+'/report.json',JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({passed:report.passed,reportDirectory:folder,checks:checks.length,errors}));if(!report.passed)process.exitCode=1;
