import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {syntheticMedia} from './browser-media.mjs';
import {messageBrowserConnection,messageBrowserRunId} from './message-browser-policy.mjs';
assert.ok(process.env.PLAYWRIGHT_MODULE,'Installed test browser runtime required');
const connection=messageBrowserConnection({wsEndpoint:process.env.PLAYWRIGHT_WS_ENDPOINT,cdpUrl:process.env.CDP_URL});
const base=new URL(process.env.APP_URL); assert.ok(['127.0.0.1','localhost','[::1]'].includes(base.hostname));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser=await (connection.kind==='playwright'?chromium.connect(connection.url):chromium.connectOverCDP(connection.url))
  .catch(()=>{throw new Error('Owned test browser connection failed');});
const runId=messageBrowserRunId(process.env.MESSAGE_TEST_RUN_ID??crypto.randomUUID()),root=fileURLToPath(new URL(`../test-results/messages-${runId}/`,import.meta.url));
await mkdir(root); const checks=[],errors=[],unexpectedRequests=[]; let failure=null,context,page;
const data=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('child-development-demo-v2')));
const role=value=>page.getByLabel('사용자 역할',{exact:true}).selectOption(value);
const nav=name=>page.getByRole('navigation',{name:page.viewportSize().width<=640?'모바일 메뉴':'주요 메뉴',exact:true}).getByRole('button',{name,exact:true}).click();
const message=id=>page.locator(`[data-message-id="${id}"]`);
const closed=()=>page.locator('#dialog').waitFor({state:'hidden'});
async function chat(){await nav('대화');const row=page.locator('.conversation-row[data-id="c1"]');if(await row.isVisible())await row.click();await page.waitForFunction(()=>document.querySelector('#message-body')&&!document.querySelector('#message-body').disabled);}
async function send(body){await page.getByLabel('소식 내용',{exact:true}).fill(body);await page.getByRole('button',{name:'보내기',exact:true}).click();await page.waitForFunction(body=>JSON.parse(localStorage.getItem('child-development-demo-v2')).messages.some(m=>m.body===body),body);await page.waitForFunction(()=>document.querySelector('#message-body')?.value===''&&!document.querySelector('#message-body').disabled);return (await data()).messages.at(-1).id;}
async function manage(id,name){await message(id).getByLabel('소식 관리',{exact:true}).click();await message(id).getByRole('button',{name,exact:true}).click();await page.locator('#dialog').waitFor({state:'visible'});}
async function bytes(ids){return page.evaluate(async ids=>{const {MediaStore}=await import('/src/media-store.js');const store=new MediaStore();const result=await Promise.all(ids.map(async id=>{const blob=await store.read(id);return {id,type:blob?.type,bytes:blob?[...new Uint8Array(await blob.arrayBuffer())]:null};}));(await store.open()).close();return result;},ids);}
try{
  for(const width of [320,390,1440]){
    context=await browser.newContext({viewport:{width,height:900},locale:'ko-KR',hasTouch:width<=640,isMobile:width<=640});page=await context.newPage();page.setDefaultTimeout(8000);
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('request',r=>{const url=new URL(r.url());if(url.origin!==base.origin||url.pathname.startsWith('/api/'))unexpectedRequests.push(r.url());});
    page.on('dialog',dialog=>dialog.accept());
    await context.route('**/*',route=>{const request=route.request(),url=new URL(request.url());return url.origin===base.origin&&['GET','HEAD'].includes(request.method())&&!url.pathname.startsWith('/api/')?route.continue():route.abort();});
    await page.goto(base.href);await role('guardian');await chat();
    const media=await syntheticMedia(page);
    await page.getByRole('button',{name:'＋ 사진·동영상',exact:true}).click();
    await page.locator('#chat-attachment-editor input[type=file]').setInputFiles([
      {name:'가상-사진.png',mimeType:'image/png',buffer:Buffer.from(media.png)},
      {name:'가상-영상.webm',mimeType:'video/webm',buffer:Buffer.from(media.video)}]);
    await page.waitForFunction(()=>!document.querySelector('#chat-attachment-editor input').disabled);
    const id=await send('합성 최초 화면 소식');
    const attachments=(await data()).messages.find(m=>m.id===id).attachments, originals=await bytes(attachments.map(a=>a.id));
    await page.getByLabel('소식 내용',{exact:true}).fill('보존할 다음 가상 초안');
    await page.waitForFunction(()=>document.querySelector('#draft-status').dataset.state==='saved');
    await role('therapist');await chat();
    await message(id).getByRole('button',{name:'답하기',exact:true}).click();const reply=await send('별도 가상 답변 유지');
    await message(id).getByRole('button',{name:'기록에 참고',exact:true}).click();
    await page.locator('#edit-form details').filter({has:page.getByText('공유 요약·제목',{exact:true})}).locator(':scope > summary').click();
    await page.locator('[name=title]').fill('가상 당시 참고 기록');await page.locator('[name=performed]').fill('가상 관찰 활동');
    await page.getByRole('button',{name:'기록 저장',exact:true}).click();await closed();
    const record=(await data()).records.at(-1);assert.equal(record.referenceSources[0].version,1);
    await role('guardian');await chat();assert.equal(await page.getByLabel('소식 내용',{exact:true}).inputValue(),'보존할 다음 가상 초안');
    await manage(id,'본문 수정');const commandId=await page.locator('#dialog').evaluate(el=>el._meta.clientId);
    await page.getByLabel('수정할 소식',{exact:true}).fill('합성 수정 화면 소식');
    await page.evaluate(()=>{const native=Storage.prototype.setItem;window.failMessageSave=true;Storage.prototype.setItem=function(key,value){if(window.failMessageSave&&key==='child-development-demo-v2'&&JSON.parse(value).messages.some(m=>m.body==='합성 수정 화면 소식'))throw new DOMException('Synthetic quota','QuotaExceededError');return native.call(this,key,value);};});
    await page.getByRole('button',{name:'수정 저장',exact:true}).click();await page.locator('#form-error').waitFor({state:'visible'});
    assert.equal((await data()).messages.find(m=>m.id===id).body,'합성 최초 화면 소식');
    assert.equal(await page.getByLabel('수정할 소식',{exact:true}).inputValue(),'합성 수정 화면 소식');
    assert.equal(await page.locator('#dialog').evaluate(el=>el._meta.clientId),commandId);
    await page.evaluate(()=>{window.failMessageSave=false;});
    await page.getByRole('button',{name:'수정 저장',exact:true}).focus();await page.keyboard.press('Space');await closed();
    assert.ok((await message(id).innerText()).includes('수정됨'));
    assert.equal((await data()).messages.find(m=>m.id===id).changes.length,1);
    assert.equal(await page.getByLabel('소식 내용',{exact:true}).inputValue(),'보존할 다음 가상 초안');
    assert.deepEqual(await bytes(attachments.map(a=>a.id)),originals);
    await page.screenshot({path:`${root}/${width}-edited.png`,fullPage:true});
    await role('therapist');await chat();assert.ok((await message(reply).innerText()).includes('합성 최초 화면 소식'));
    assert.ok((await message(reply).innerText()).includes('원문 수정됨'));
    await nav('기록');await page.locator(`.record-card button[data-action="record"][data-id="${record.id}"]`).click();
    assert.ok((await page.locator('#dialog .reference-note').innerText()).includes('합성 최초 화면 소식'));
    assert.ok((await page.locator('#dialog .reference-note').innerText()).includes('원문이 수정됐어요'));
    await page.getByRole('button',{name:'취소',exact:true}).click();await closed();
    await role('guardian');await chat();await manage(id,'삭제');
    assert.equal(await page.getByLabel('삭제 범위',{exact:true}).inputValue(),'self');
    await page.getByLabel('삭제 범위',{exact:true}).selectOption('all');
    await page.getByRole('button',{name:'선택한 범위로 삭제',exact:true}).click();await page.locator('#form-error').waitFor({state:'visible'});
    assert.equal((await data()).messages.find(m=>m.id===id).deletedAt,undefined);
    await page.getByLabel('선택한 범위에서 삭제할 것을 확인했어요.',{exact:true}).focus();await page.keyboard.press('Space');
    await page.getByRole('button',{name:'선택한 범위로 삭제',exact:true}).focus();await page.keyboard.press('Space');await closed();
    assert.ok((await message(id).innerText()).includes('삭제된 소식입니다.'));
    assert.equal(await message(id).locator('.media-gallery').count(),0);
    assert.equal(await message(id).locator('.message-meta strong').count(),0);
    assert.equal(await message(id).getByRole('button',{name:'기록에 참고',exact:true}).count(),0);
    assert.deepEqual(await bytes(attachments.map(a=>a.id)),originals);
    await page.reload();await role('therapist');await chat();
    assert.equal((await message(id).innerText()).includes('합성 수정 화면 소식'),false);
    assert.equal((await message(reply).innerText()).includes('합성 최초 화면 소식'),false);
    assert.ok((await message(reply).innerText()).includes('별도 가상 답변 유지'));
    await manage(id,'삭제');assert.deepEqual(await page.getByLabel('삭제 범위',{exact:true}).locator('option').evaluateAll(options=>options.map(o=>o.value)),['self']);
    await page.getByLabel('선택한 범위에서 삭제할 것을 확인했어요.',{exact:true}).check();
    await page.getByRole('button',{name:'선택한 범위로 삭제',exact:true}).click();await closed();
    assert.equal(await message(id).count(),0);
    await page.screenshot({path:`${root}/${width}-deleted.png`,fullPage:true});
    await nav('기록');await page.locator(`.record-card button[data-action="record"][data-id="${record.id}"]`).click();
    assert.ok((await page.locator('#dialog .reference-note').innerText()).includes('합성 최초 화면 소식'));
    assert.ok((await page.locator('#dialog .reference-note').innerText()).includes('원문은 삭제되었거나'));
    await page.locator('[name=performed]').fill('가상 후속 관찰');await page.getByRole('button',{name:'기록 저장',exact:true}).click();await closed();
    assert.deepEqual((await data()).records.find(r=>r.id===record.id).referenceSources,record.referenceSources);
    await role('guardian');await chat();assert.equal(await message(id).count(),1);
    assert.equal(await page.getByLabel('소식 내용',{exact:true}).inputValue(),'보존할 다음 가상 초안');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    checks.push(`${width}px: media send → clinical reference → edit failure/retry/keyboard → original quote retained → all-delete/confirmation/reload → self-delete isolated → clinical original/draft/blob bytes retained`);
    await context.close();context=null;
  }
  assert.deepEqual(errors,[]);assert.deepEqual(unexpectedRequests,[]);
}catch(error){failure=String(error.message||error);await page?.screenshot({path:`${root}/failure.png`,fullPage:true}).catch(()=>{});process.exitCode=1;console.error(error);}
finally{await context?.close();const browserVersion=browser.version();await browser.close();const report={runId,at:new Date().toISOString(),browserVersion,passed:!failure,checks,errors,unexpectedRequests,failure,screenshots:root};await writeFile(`${root}/results.json`,JSON.stringify(report,null,2));await writeFile(new URL('../test-results/message-lifecycle-results.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify({runId,passed:!failure,checks:checks.length,failure}));}
