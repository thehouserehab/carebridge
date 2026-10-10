import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {syntheticMedia} from './browser-media.mjs';
// Focused continuation after the full setup found an inaccessible editor name.
// Initial message/reply/record/files use product storage functions with synthetic
// inputs; this test does NOT claim to verify their initial authoring UI.
const base=new URL(process.env.APP_URL);assert.ok(['127.0.0.1','localhost','[::1]'].includes(base.hostname));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser=await chromium.connectOverCDP(process.env.CDP_URL),runId=crypto.randomUUID();
const root=fileURLToPath(new URL(`../test-results/message-actions-${runId}/`,import.meta.url));await mkdir(root);
const checks=[],errors=[],unexpectedRequests=[];let context,page,failure=null;
const role=value=>page.getByLabel('사용자 역할',{exact:true}).selectOption(value);
const nav=name=>page.getByRole('navigation',{name:page.viewportSize().width<=640?'모바일 메뉴':'주요 메뉴',exact:true}).getByRole('button',{name,exact:true}).click();
const data=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('child-development-demo-v2')));
const message=id=>page.locator(`[data-message-id="${id}"]`);
const closed=()=>page.locator('#dialog').waitFor({state:'hidden'});
async function chat(){await nav('대화');const row=page.locator('.conversation-row[data-id="c1"]');if(await row.isVisible())await row.click();await page.waitForFunction(()=>document.querySelector('#message-body')&&!document.querySelector('#message-body').disabled);}
async function manage(id,name){const summary=message(id).getByLabel('소식 관리',{exact:true});if((await message(id).locator('.message-menu').getAttribute('open'))===null)await summary.click();await message(id).getByRole('button',{name,exact:true}).click();await page.locator('#dialog').waitFor({state:'visible'});}
async function bytes(ids){return page.evaluate(async ids=>{const {MediaStore}=await import('/src/media-store.js');const store=new MediaStore();const result=await Promise.all(ids.map(async id=>{const blob=await store.read(id);return {id,type:blob?.type,bytes:blob?[...new Uint8Array(await blob.arrayBuffer())]:null};}));(await store.open()).close();return result;},ids);}
try{
  for(const width of [320,390,1440]){
    context=await browser.newContext({viewport:{width,height:900},locale:'ko-KR',isMobile:width<=640,hasTouch:width<=640});page=await context.newPage();page.setDefaultTimeout(7000);
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('dialog',d=>d.accept());
    page.on('request',r=>{const u=new URL(r.url());if(u.origin!==base.origin||u.pathname.startsWith('/api/'))unexpectedRequests.push(r.url());});
    await page.goto(base.href);const media=await syntheticMedia(page);
    const fixture=await page.evaluate(async media=>{
      const {load,persist}=await import('/src/repository.js'),{mutate}=await import('/src/domain.js'),{MediaStore}=await import('/src/media-store.js');
      let db=load(localStorage).db;const initial=db.revision;
      const files=[{id:crypto.randomUUID(),name:'가상.png',type:'image/png',size:media.png.length,share:true},{id:crypto.randomUUID(),name:'가상.webm',type:'video/webm',size:media.video.length,share:true}];
      const id=crypto.randomUUID(),replyId=crypto.randomUUID();
      db=mutate(db,{id:'p1',role:'guardian'},'message',{childId:'c1',clientId:id,body:'합성 최초 화면 소식',attachments:files});
      db=mutate(db,{id:'t1',role:'therapist'},'message',{childId:'c1',clientId:replyId,body:'별도 가상 답변 유지',replyTo:id,expectedReplyVersion:1});
      db=mutate(db,{id:'t1',role:'therapist'},'record',{childId:'c1',goalId:'g1',date:'2026-10-08',title:'가상 당시 참고 기록',performed:'가상 활동',referenceMessageIds:[id],expectedReferenceVersions:[{messageId:id,version:1}]});
      const store=new MediaStore();await store.write(files.map((f,i)=>[f.id,new Blob([new Uint8Array(i?media.video:media.png)],{type:f.type})]));(await store.open()).close();
      persist(localStorage,db,initial);return {id,replyId,files,record:db.records.at(-1)};
    },media);
    const {id,replyId,record}=fixture;await page.reload();await role('guardian');await chat();
    await page.getByLabel('소식 내용',{exact:true}).fill('보존할 다음 가상 초안');await page.waitForFunction(()=>document.querySelector('#draft-status').dataset.state==='saved');
    const originals=await bytes(fixture.files.map(f=>f.id));
    await manage(id,'본문 수정');assert.equal(await page.getByLabel('수정할 소식',{exact:true}).count(),1);
    const command=await page.locator('#dialog').evaluate(el=>el._meta.clientId);
    await page.getByLabel('수정할 소식',{exact:true}).fill('합성 수정 화면 소식');
    await page.evaluate(()=>{const native=Storage.prototype.setItem;window.failMessageSave=true;Storage.prototype.setItem=function(k,v){if(window.failMessageSave&&k==='child-development-demo-v2'&&JSON.parse(v).messages.some(m=>m.body==='합성 수정 화면 소식'))throw new DOMException('Synthetic quota','QuotaExceededError');return native.call(this,k,v);};});
    await page.getByRole('button',{name:'수정 저장',exact:true}).click();await page.locator('#form-error').waitFor({state:'visible'});
    assert.equal((await data()).messages.find(m=>m.id===id).body,'합성 최초 화면 소식');assert.equal(await page.getByLabel('수정할 소식',{exact:true}).inputValue(),'합성 수정 화면 소식');
    assert.equal(await page.locator('#dialog').evaluate(el=>el._meta.clientId),command);
    await page.evaluate(()=>{window.failMessageSave=false;});await page.getByRole('button',{name:'수정 저장',exact:true}).focus();await page.keyboard.press('Space');await closed();
    assert.equal((await data()).messages.find(m=>m.id===id).changes.length,1);assert.ok((await message(id).innerText()).includes('수정됨'));
    assert.equal(await page.getByLabel('소식 내용',{exact:true}).inputValue(),'보존할 다음 가상 초안');assert.deepEqual(await bytes(fixture.files.map(f=>f.id)),originals);
    await page.screenshot({path:`${root}/${width}-edited.png`,fullPage:true});
    await role('therapist');await chat();assert.ok((await message(replyId).innerText()).includes('합성 최초 화면 소식'));assert.ok((await message(replyId).innerText()).includes('원문 수정됨'));
    await nav('기록');await page.locator(`.record-card [data-action=record][data-id="${record.id}"]`).click();assert.ok((await page.locator('#dialog .reference-note').innerText()).includes('합성 최초 화면 소식'));assert.ok((await page.locator('#dialog .reference-note').innerText()).includes('원문이 수정됐어요'));
    await page.getByRole('button',{name:'취소',exact:true}).click();await closed();await role('guardian');await chat();await manage(id,'삭제');
    assert.equal(await page.getByLabel('삭제 범위',{exact:true}).inputValue(),'self');await page.getByLabel('삭제 범위',{exact:true}).selectOption('all');
    await page.getByRole('button',{name:'선택한 범위로 삭제',exact:true}).click();await page.locator('#form-error').waitFor({state:'visible'});assert.equal((await data()).messages.find(m=>m.id===id).deletedAt,undefined);
    await page.getByLabel('선택한 범위에서 삭제할 것을 확인했어요.',{exact:true}).focus();await page.keyboard.press('Space');await page.screenshot({path:`${root}/${width}-delete-confirm.png`,fullPage:true});
    await page.getByRole('button',{name:'선택한 범위로 삭제',exact:true}).focus();await page.keyboard.press('Space');await closed();
    assert.ok((await message(id).innerText()).includes('삭제된 소식입니다.'));assert.equal(await message(id).locator('[data-media-id]').count(),0);assert.equal(await message(id).locator('.message-meta strong').count(),0);
    await page.reload();await role('therapist');await chat();assert.equal((await message(replyId).innerText()).includes('합성 최초 화면 소식'),false);assert.ok((await message(replyId).innerText()).includes('별도 가상 답변 유지'));
    await manage(id,'삭제');assert.deepEqual(await page.getByLabel('삭제 범위',{exact:true}).locator('option').evaluateAll(options=>options.map(o=>o.value)),['self']);
    await page.getByLabel('선택한 범위에서 삭제할 것을 확인했어요.',{exact:true}).check();await page.getByRole('button',{name:'선택한 범위로 삭제',exact:true}).click();await closed();assert.equal(await message(id).count(),0);
    await nav('기록');await page.locator(`.record-card [data-action=record][data-id="${record.id}"]`).click();assert.ok((await page.locator('#dialog .reference-note').innerText()).includes('합성 최초 화면 소식'));assert.ok((await page.locator('#dialog .reference-note').innerText()).includes('원문은 삭제되었거나'));
    await page.locator('[name=performed]').fill('가상 다음 관찰');await page.getByRole('button',{name:'기록 저장',exact:true}).click();await closed();assert.deepEqual((await data()).records.find(r=>r.id===record.id).referenceSources,record.referenceSources);
    await role('guardian');await chat();assert.equal(await message(id).count(),1);assert.equal(await page.getByLabel('소식 내용',{exact:true}).inputValue(),'보존할 다음 가상 초안');assert.deepEqual(await bytes(fixture.files.map(f=>f.id)),originals);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    checks.push(`${width}px: explicit accessible names; edit quota retry keeps command/input/draft; versions/quotes/clinical source; confirmed all-delete and reload; per-user self-delete; original file bytes and clinical source retained`);
    await context.close();context=null;
  }
  assert.deepEqual(errors,[]);assert.deepEqual(unexpectedRequests,[]);
}catch(error){failure=String(error.message||error);await page?.screenshot({path:`${root}/failure.png`,fullPage:true}).catch(()=>{});process.exitCode=1;console.error(error);}
finally{await context?.close();await browser.close();const result={runId,at:new Date().toISOString(),passed:!failure,initialState:'synthetic product-domain/storage fixture, not initial authoring UI',checks,errors,unexpectedRequests,failure,screenshots:root};await writeFile(`${root}/results.json`,JSON.stringify(result,null,2));await writeFile(new URL('../test-results/message-actions-results.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify({runId,passed:!failure,checks:checks.length,failure}));}
