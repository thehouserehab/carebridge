// One AI-operated task A functional check, NOT the user's study session or a
// human usability result. New memory DB + owned nonpersistent browser only.
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { lstat,mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { TASK_A,studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { getPendingSyntheticCleanup } from '../server/local-sandbox-cleanup.mjs';
import { createLocalP0StudyFixture } from './local-p0-study-fixture.mjs';
import { captureLocalP0StudySources } from './local-p0-study-browser.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRoom, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),code='LOCAL_P0_TASK_A_AGENT_FAILED';
const assets=new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/local-api/approval-pending-ui.js',
  '/local-api/care-recipient-client.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);
const sha256=value=>createHash('sha256').update(value).digest('hex');
async function sourceSnapshot() {
  return { ...(await captureLocalP0StudySources()),runnerSha256:sha256(await readFile(fileURLToPath(import.meta.url))) };
}
async function bounded(operation,milliseconds=30_000) {
  let timer;
  try { return await Promise.race([operation,new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error(code)),milliseconds); })]); }
  finally { clearTimeout(timer); }
}
function processLifetime(child) {
  assert(child && Number.isInteger(child.pid),code);
  const streams=[...new Set((child.stdio??[]).filter(Boolean))],done=Promise.withResolvers();
  let exited=child.exitCode!==null||child.signalCode!==null,closed=false;
  const terminal=()=>exited&&closed&&streams.every(stream=>stream.closed===true);
  const changed=()=>{ if(terminal())done.resolve(); };
  child.once('exit',()=>{ exited=true;changed(); }); child.once('close',()=>{ closed=true;changed(); });
  for(const stream of streams)stream.once('close',changed);
  return { terminal,done:done.promise };
}

export async function runLocalP0TaskAAgentBrowser(args=process.argv.slice(2)) {
  const options=messageBrowserOptions(args);
  for(const filename of [options.module,options.executable]) {
    const info=await lstat(filename); assert(info.isFile()&&!info.isSymbolicLink(),code);
  }
  const source=await sourceSnapshot(),{ chromium }=await import(pathToFileURL(options.module).href);
  const runId=randomUUID(),parent=path.join(root,'test-results'),folder=path.join(parent,`local-p0-task-a-agent-${runId}`);
  await mkdir(parent,{ recursive:true }); const parentInfo=await lstat(parent);
  assert(parentInfo.isDirectory()&&!parentInfo.isSymbolicLink(),code); await mkdir(folder);
  const report={ runId,startedAt:new Date().toISOString(),source,task:'A',operator:'AI functional test',viewport:{ width:1440,height:900 },
    passed:false,humanMetricsCollected:false,humanTaskCompletion:false,humanResponsesCollected:false,originalUserSessionUsed:false,
    selectedPath:[],screenshots:[],errors:[],unexpectedRequests:[],failure:null,
    checks:{ homeEntry:false,uiWrite:false,databaseRead:false,apiRead:false,reloadReopen:false,startingMaterialPreserved:false },
    cleanup:{ contextClosed:false,browserStopped:false,sandboxClosed:false },cleanupObservationTimedOut:false,
    limitations:[
      'This is one AI-operated synthetic functional task, not a human task completion, timing, navigation-count or satisfaction result.',
      'The prior user-owned server, browser windows, accounts and study data are never used or accessed.',
      'Fresh memory-only fixture and owned nonpersistent desktop Chromium context; no original-source preflight or baseline comparison.',
      'Only activity feedback UI submission, memory DB/API read and refresh/reopen are checked; no physical device, server restart or participant comprehension.',
      'Requested 조금 해봄 maps to stored partial; the actually observed UI option label is recorded separately, not substituted.',
      'Run timestamps describe automation artifacts only; they are not participant elapsed-time measurements.',
    ] };
  const ownership={ runId,testProcessId:process.pid,browserProcessId:null,origin:null,finished:false };
  const save=(name,value)=>writeFile(path.join(folder,name),JSON.stringify(value,null,2)+'\n');
  const note=(list,value)=>{ if(list.length<24)list.push(value); };
  let fixture,sandbox,browserServer,browser,lifetime,context,page,closing=false,pendingCleanup,phase='STARTUP';
  let asyncFailure=false;
  const step=async(name,operation)=>{ phase=name;assert(!asyncFailure,code);const value=await operation();assert(!asyncFailure,code);return value; };
  const screenshot=async name=>{
    const filename=`1440-A-${name}.png`;
    await page.screenshot({ path:path.join(folder,filename),fullPage:true,
      mask:[page.locator('input[type="email"]'),page.locator('input[type="password"]'),page.locator('.workspace-head .account')] });
    report.screenshots.push({ filename,syntheticOnly:true });
  };
  await save('ownership.json',ownership);
  try {
    fixture=await step('FRESH_SYNTHETIC_FIXTURE',()=>createLocalP0StudyFixture('A',{ port:0 })); sandbox=fixture.sandbox;
    const { origin,ids }=sandbox,room=fixture.rooms[0],publication=fixture.publication,url=new URL(origin);
    assert(url.origin===origin&&url.hostname==='127.0.0.1'&&url.protocol==='http:'&&url.port&&!url.username&&!url.password,code);
    assert.equal(fixture.evidence.humanMetricsCollected,false,code); assert.equal(fixture.evidence.uiTaskCompleted,false,code);
    const expected={ date:fixture.day,...TASK_A },base=`/api/local/centers/${ids.centerId}/conversations/${room.conversationId}`;
    const primaryPath=`/api/local/centers/${ids.centerId}/primary-communicator`,writes=[];
    report.day=fixture.day; report.origin=origin; ownership.origin=origin;
    const material=async()=> (await sandbox.database.query(`SELECT to_jsonb(r) AS value FROM cb_record_revisions r
      WHERE center_id=$1 AND conversation_id=$2 ORDER BY record_id,revision`,[ids.centerId,room.conversationId])).rows;
    const initialMaterial=await material(); assert.equal(initialMaterial.length,2,code);
    assert.equal((await sandbox.database.query('SELECT count(*)::int AS count FROM cb_activity_feedback')).rows[0].count,0,code);
    browserServer=await step('OWNED_BROWSER',()=>chromium.launchServer({ headless:true,executablePath:options.executable,
      host:'127.0.0.1',port:0,env:studyChildEnvironment(),timeout:30_000 }));
    lifetime=processLifetime(browserServer.process()); ownership.browserProcessId=browserServer.process().pid;
    await save('ownership.json',ownership); browser=await chromium.connect(browserServer.wsEndpoint());
    report.browserVersion=browser.version();
    context=await browser.newContext({ viewport:report.viewport,locale:'ko-KR',timezoneId:'Asia/Seoul',
      serviceWorkers:'block',permissions:[],acceptDownloads:false });
    assert.equal((await context.cookies()).length,0,code);
    await context.route('**/*',async route=>{
      if(closing)return route.abort().catch(()=>{});
      try {
        const request=route.request(),target=new URL(request.url()),method=request.method();
        const auth=/^\/api\/local\/auth\/(login|session|logout)$/.test(target.pathname);
        const inbox=target.pathname===`/api/local/centers/${ids.centerId}/inbox`;
        const part=target.pathname.startsWith(base+'/')?target.pathname.slice(base.length):'';
        const roomRead=/^\/(profile|read|goals|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|feedback\/[A-Za-z0-9_-]+)$/.test(part);
        const primary=target.pathname===primaryPath&&target.searchParams.get('conversationId')===room.conversationId&&[...target.searchParams].length===1;
        const feedback=method==='POST'&&/^\/feedback\/[A-Za-z0-9_-]+$/.test(part);
        const ordinaryPost=method==='POST'&&((auth&&target.pathname!=='/api/local/auth/session')||part==='/read');
        const allowed=target.origin===origin&&((['GET','HEAD'].includes(method)&&(assets.has(target.pathname)||auth||inbox||roomRead||primary))||ordinaryPost||feedback);
        if(!allowed) { note(report.unexpectedRequests,{ phase,sameOrigin:target.origin===origin,method:['GET','POST','HEAD'].includes(method)?method:'OTHER' });asyncFailure=true;return route.abort().catch(()=>{}); }
        if(feedback) {
          const body=request.postDataJSON();
          assert.deepEqual(body.content,expected,code); assert.equal(body.sourceMessageId,publication.messageId,code);
          writes.push({ feedbackId:part.split('/').at(-1),content:{ ...body.content },sourceMessageId:body.sourceMessageId });
        }
        await route.continue();
      } catch { if(!closing) { note(report.errors,{ phase,type:'route' });asyncFailure=true; } await route.abort().catch(()=>{}); }
    });
    if(typeof context.routeWebSocket==='function')await context.routeWebSocket('**/*',socket=>{
      note(report.unexpectedRequests,{ phase,type:'websocket' });asyncFailure=true;socket.close();
    });
    page=await context.newPage();page.setDefaultTimeout(15_000);page.setDefaultNavigationTimeout(20_000);
    page.on('pageerror',()=>{ note(report.errors,{ phase,type:'pageerror' });asyncFailure=true; });
    page.on('console',entry=>{ if(entry.type()==='error'&&!entry.text().startsWith('Failed to load resource:')) {
      let diagnostic=entry.text();
      for(const credential of sandbox.credentials)for(const value of [credential.email,credential.password])
        diagnostic=diagnostic.replaceAll(value,'[synthetic credential redacted]');
      diagnostic=diagnostic.replaceAll(origin,'[owned loopback]').replace(/https?:\/\/[^\s"']+/g,'[URL redacted]').slice(0,700);
      note(report.errors,{ phase,type:'console',diagnostic });asyncFailure=true;
    } });
    const homeReady=async()=>{
      await page.getByTestId('home').waitFor();
      await page.getByTestId('home').locator(`[data-home-news] [data-open-room="${room.conversationId}"]`).waitFor();
      assert.equal(await page.locator('button[data-view="home"]:visible').getAttribute('aria-current'),'page',code);
    };
    const dialog=page.getByTestId('care-dialog'),input=name=>dialog.locator(`[name="${name}"]`);
    const get=async pathname=>{
      assert(pathname.startsWith(base+'/'),code);
      const response=await context.request.get(origin+pathname,{ maxRedirects:0,timeout:15_000,headers:{ 'X-Carebridge-Account':ids.guardianId } });
      try { assert.equal(response.status(),200,code);return await response.json(); } finally { await response.dispose(); }
    };
    await step('LOGIN',async()=>{
      const credential=sandbox.credentials.find(item=>item.role==='guardian');assert(credential?.email.endsWith('.test'),code);
      await page.goto(origin);await page.getByLabel('시험 이메일',{ exact:true }).fill(credential.email);
      await page.getByLabel('시험 비밀번호',{ exact:true }).fill(credential.password);
      await page.getByRole('button',{ name:'로그인',exact:true }).click();await homeReady();
    });
    await step('HOME_TO_SHARED_ACTIVITY',async()=>{
      const entry=page.getByTestId('home').locator(`[data-home-news] [data-open-room="${room.conversationId}"][data-target-id="${publication.messageId}"]`);
      await entry.waitFor();const entryLabel=await entry.innerText();assert(entryLabel.includes('하루'),code);
      report.selectedPath.push({ surface:'홈',selectedLabel:entryLabel });await screenshot('home');await entry.click();
      const card=page.locator(`[data-publication-id="${publication.publicationId}"]`);await card.waitFor();
      assert.equal(await page.locator('#room-title').textContent(),'하루',code);
      const title=await card.locator(':scope > h3').textContent();assert.equal(title,'놀이 참여 관찰',code);
      assert((await card.innerText()).includes('좋아하는 놀이 함께 고르기'),code);
      report.selectedPath.push({ surface:'하루 대화',recordTitle:title,activityTitle:'좋아하는 놀이 함께 고르기',selectedLabel:'활동 경험 남기기' });
      await card.getByRole('button',{ name:'활동 경험 남기기',exact:true }).click();await dialog.waitFor();report.checks.homeEntry=true;
    });
    await step('INPUT_FOUR_FIELDS',async()=>{
      await input('date').fill(expected.date);await input('result').selectOption(expected.result);
      await input('reaction').fill(expected.reaction);await input('difficulty').fill(expected.difficulty);
      const resultLabel=await input('result').locator('option:checked').textContent();assert.equal(resultLabel,'일부 했어요',code);
      for(const [key,value]of Object.entries(expected))assert.equal(await input(key).inputValue(),value,code);
      report.requestedResultMeaning='조금 해봄';report.observedResultLabel=resultLabel;report.enteredValues={ ...expected };
      report.selectedPath.push({ surface:'활동 경험 남기기',selectedLabel:resultLabel,savedDateMeaning:'오늘',date:expected.date,submitLabel:'활동 경험 저장' });
      await screenshot('four-fields');
    });
    const receipt=await step('UI_SAVE',async()=>{
      const [response]=await Promise.all([page.waitForResponse(response=>{
        const target=new URL(response.url());return target.origin===origin&&response.request().method()==='POST'&&target.pathname.startsWith(base+'/feedback/');
      }),dialog.getByRole('button',{ name:'활동 경험 저장',exact:true }).click()]);
      assert.equal(response.status(),201,code);const value=(await response.json()).receipt;
      assert.equal(value.operation,'save',code);assert.equal(value.revision,1,code);assert.equal(value.replayed,false,code);
      await dialog.waitFor({ state:'hidden' });assert.equal(writes.length,1,code);assert.equal(writes[0].feedbackId,value.feedbackId,code);
      report.checks.uiWrite=true;report.saveReceipt={ feedbackId:value.feedbackId,messageId:value.messageId,revision:value.revision };return value;
    });
    const stored=await step('DATABASE_AND_API_READ',async()=>{
      const { rows }=await sandbox.database.query(`SELECT r.activity_date::text AS date,r.result,r.reaction,r.difficulty
        FROM cb_activity_feedback f JOIN cb_feedback_revisions r
        ON (r.center_id,r.conversation_id,r.feedback_id,r.revision)=(f.center_id,f.conversation_id,f.id,f.current_revision)
        WHERE f.center_id=$1 AND f.conversation_id=$2 AND f.id=$3 AND f.author_id=$4 AND f.publication_id=$5`,
      [ids.centerId,room.conversationId,receipt.feedbackId,ids.guardianId,publication.publicationId]);
      assert.deepEqual(rows,[expected],code);report.storedValues={ ...rows[0] };report.checks.databaseRead=true;
      const { message }=await get(`${base}/feedback/${receipt.feedbackId}`);
      assert.equal(message.id,receipt.messageId,code);assert.equal(message.authorId,ids.guardianId,code);
      assert.equal(message.feedback.publicationId,publication.publicationId,code);
      for(const [key,value]of Object.entries(expected))assert.equal(message.feedback[key],value,code);
      assert.equal((await sandbox.database.query('SELECT count(*)::int AS count FROM cb_activity_feedback')).rows[0].count,1,code);
      report.checks.apiRead=true;return message.feedback;
    });
    await step('REFRESH_REOPEN',async()=>{
      await page.reload();await homeReady();await workspaceRoom(page,room.conversationId);
      await page.locator(`[data-feedback-id="${receipt.feedbackId}"]`).getByRole('button',{ name:'활동 경험 수정',exact:true }).click();await dialog.waitFor();
      const reopened={};for(const [key,value]of Object.entries(expected)) { reopened[key]=await input(key).inputValue();assert.equal(reopened[key],value,code); }
      assert.deepEqual((await get(`${base}/feedback/${receipt.feedbackId}`)).message.feedback,stored,code);
      report.reopenedValues=reopened;report.checks.reloadReopen=true;report.selectedPath.push({ surface:'새로고침 → 하루 대화',selectedLabel:'활동 경험 수정' });
      await screenshot('reopened');await dialog.getByRole('button',{ name:'닫기',exact:true }).click();await dialog.waitFor({ state:'hidden' });
    });
    await step('PRESERVATION_AND_LOGOUT',async()=>{
      assert.deepEqual(await material(),initialMaterial,code);report.checks.startingMaterialPreserved=true;
      await workspaceAccountAction(page, 'logout');await page.getByTestId('login-form').waitFor();
      report.finalSource=await sourceSnapshot();assert.equal(report.finalSource.sha256,source.sha256,code);assert.equal(report.finalSource.runnerSha256,source.runnerSha256,code);
    });
  } catch(error) {
    pendingCleanup=getPendingSyntheticCleanup(error);
    report.failure={ code,phase,kind:['AssertionError','TimeoutError'].includes(error?.name)?error.name:'Error',
      testLine:Number(error?.stack?.match(/local-p0-task-a-agent-browser\.mjs:(\d+):\d+/)?.[1])||null };
    if(page)try { await bounded(screenshot('failure'),5000); } catch { note(report.errors,{ phase,type:'failure-screenshot' }); }
  } finally {
    closing=true;
    if(context)try { await bounded(context.close());report.cleanup.contextClosed=true; } catch { report.cleanupObservationTimedOut=true; }
    else report.cleanup.contextClosed=true;
    if(browserServer) {
      try { await bounded(browser?.close());await bounded(browserServer.close());await bounded(lifetime.done); }
      catch { report.cleanupObservationTimedOut=true;try { await bounded(browserServer.kill());await bounded(lifetime.done); } catch {} }
      report.cleanup.browserStopped=lifetime?.terminal()===true;
    } else report.cleanup.browserStopped=true;
    if(report.cleanup.browserStopped) {
      try {
        if(sandbox) { await bounded(sandbox.close());assert.equal(sandbox.database.closed,true,code);assert.equal(sandbox.credentials.length,0,code); }
        if(pendingCleanup)await bounded(pendingCleanup());
        report.cleanup.sandboxClosed=true;
      } catch { report.failure??={ code,phase:'SANDBOX_CLEANUP',kind:'Error' }; }
    }
    report.finishedAt=new Date().toISOString();
    report.passed=!report.failure&&!report.cleanupObservationTimedOut&&report.errors.length===0&&report.unexpectedRequests.length===0&&
      Object.values(report.checks).every(Boolean)&&Object.values(report.cleanup).every(Boolean);
    ownership.finished=Object.values(report.cleanup).every(Boolean);ownership.cleanup={ ...report.cleanup };
    await save('ownership.json',ownership);await save('results.json',report);
  }
  console.log(JSON.stringify({ runId,passed:report.passed,task:'A',operator:'AI functional test',humanMetricsCollected:false,
    humanTaskCompletion:false,originalUserSessionUsed:false,checks:report.checks,failure:report.failure,cleanup:report.cleanup }));
  return report.passed;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { if(!await runLocalP0TaskAAgentBrowser())process.exitCode=1; }
  catch { console.error('LOCAL_P0_TASK_A_AGENT_CONFIGURATION_OR_STARTUP_FAILED');process.exitCode=1; }
}
