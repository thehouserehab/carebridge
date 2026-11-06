import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateSyntheticWifiCertificate} from '../server/synthetic-wifi-certificate.mjs';
import {privateSecretEnvironment} from '../server/windows-private-secret-io.mjs';

const source=fileURLToPath(new URL('./hold-synthetic-wifi-current-user-trust.ps1',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/synthetic-wifi-current-user-trust-fixture.ps1',import.meta.url));
const powershell=process.env.CAREBRIDGE_TEST_POWERSHELL;
const enabled=process.platform==='win32'&&Boolean(powershell);

test('trust guard fixes CurrentUser root, owner lifetime and exact cleanup without UI or elevation',async()=>{
  const text=await readFile(source,'utf8');
  assert.match(text,/StoreName\]::Root/);
  assert.match(text,/StoreLocation\]::CurrentUser/);
  assert.match(text,/\$owner\.Handle/);
  assert.match(text,/StartTime\.ToUniversalTime\(\)\.Ticks/);
  assert.match(text,/StartTime\.ToUniversalTime\(\)\.AddHours\(2\)/);
  assert.match(text,/Stopwatch\]::StartNew\(\)/);
  assert.match(text,/\$clock\.Elapsed\.TotalMilliseconds -lt \$remainingMilliseconds/);
  assert.match(text,/\$identity\.User\.Value -cne \$ExpectedUserSid/);
  assert.match(text,/Get-Hash \$candidate\.RawData/);
  assert.match(text,/\$exited -isnot \[bool\]/);
  assert.match(text,/Assert-OwnerAlive\s+if \(\[IO\.File\]::Exists\(\$ReceiptPath \+ '\.stop'\)/);
  assert.ok(text.indexOf('$ownedAttempt = $true')<text.indexOf('$store.Add($certificate)'));
  assert.match(text,/\$store\.Remove\(\$candidate\)/);
  assert.match(text,/Assert-RootCount 0\s+\$removed = \$true/);
  assert.doesNotMatch(text,/LocalMachine|runas|Import-Certificate|Set-ExecutionPolicy|Invoke-Expression|Register-ScheduledTask/);
});

test('PowerShell lifecycle uses in-memory stores only; each failure keeps honest cleanup evidence', {skip:!enabled}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'carebridge-current-user-trust-fixture-'));
  const file=join(directory,'public.cer');
  const material=await generateSyntheticWifiCertificate({host:'127.0.0.1',powershell});
  material.key.fill(0);
  const scenarios=[
    ['normal',0,0,'removed',true],
    ['validate-only',0,0,null,false],
    ['existing',1,1,null,false],
    ['wrong-hash',1,0,null,false],
    ['pid-reuse',1,0,null,false],
    ['expired',1,0,null,false],
    ['unknown-exit-state',1,0,null,false],
    ['unknown-exit-before-add',1,0,'not-added',false],
    ['owner-error-before-add',1,0,'not-added',false],
    ['stop-before-add',1,0,'not-added',false],
    ['partial-add-error',1,0,'removed',true],
    ['exit-after-add',1,0,'removed',true],
    ['unknown-exit-after-add',1,0,'removed',true],
    ['owner-error-after-add',1,0,'removed',true],
    ['stop-during-add',1,0,'removed',true],
    ['unknown-wait-result',1,0,'removed',true],
    ['observe-error',1,0,'removed',true],
    ['active-receipt-error',1,0,'removed',true],
    ['removed-receipt-error',1,0,'active',true],
    ['remove-error',1,1,'cleanup-unconfirmed',true],
  ];
  try{
    await writeFile(file,material.publicCertificate,{flag:'wx'});
    for(const [scenario,code,remaining,receiptState,added] of scenarios)await t.test(scenario,async()=>{
      const receipt=join(directory,`${scenario}.json`);
      const observed=await new Promise((resolve,reject)=>{
        const child=spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',fixture,
          '-SourcePath',source,'-CertificatePath',file,'-NodePath',process.execPath,'-ReceiptPath',receipt,'-Scenario',scenario],
        {windowsHide:true,shell:false,env:privateSecretEnvironment(process.env,powershell),stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();},15000);
        child.stdout.on('data',v=>{stdout+=v;});child.stderr.on('data',v=>{stderr+=v;});
        child.once('error',reject);
        child.once('close',(exitCode,signal)=>{clearTimeout(timer);resolve({exitCode,signal,stdout,stderr});});
      });
      assert.equal(observed.signal,null);assert.equal(observed.stderr,'');
      const reports=observed.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
      const report=reports.find(value=>value.fixture);
      assert.ok(report,observed.stdout);assert.equal(observed.exitCode,code);assert.equal(report.code,code);
      assert.equal(report.remaining,remaining);assert.equal(report.receiptState,receiptState);
      assert.equal(report.events.includes('add'),added);
      assert.equal(report.events.includes('remove'),added);
      if(['unknown-exit-before-add','owner-error-before-add','stop-before-add','unknown-exit-after-add','owner-error-after-add','stop-during-add'].includes(scenario)){
        assert.equal(report.events.includes('wait'),false);
        assert.equal(report.events.includes('receipt:active'),false);
      }
      if(scenario==='removed-receipt-error')assert.ok(reports.some(value=>value.removed===true));
      if(scenario==='remove-error')assert.ok(reports.some(value=>value.cleanupUnconfirmed===true));
    });
  }finally{
    await rm(file,{force:true});
    for(const [scenario]of scenarios){
      await rm(join(directory,`${scenario}.json`),{force:true});
      await rm(join(directory,`${scenario}.json.stop`),{force:true});
    }
    await rmdir(directory);
  }
});
