// One fresh synthetic Windows/E child ONLY. Bootstrap configuration and the
// held-decoder stdin gate are fixture mechanisms, not product IPC commands.
import assert from 'node:assert/strict';
import {lstat,readFile} from 'node:fs/promises';
import {win32} from 'node:path';
import {databaseCredentialOptions} from './windows-database-credential-policy.mjs';
import {mediaWorkerControlId} from './media-worker-control-protocol.mjs';
import {runWindowsMediaWorkerControlledProcess} from './media-worker-controlled-process.mjs';
import {PrivateFileStore} from './private-file-store.mjs';
import {fakePreparation,fakeClam,engine,image} from './tests/media-preparation-fixtures.mjs';
let clam,gateInput='';const release=Promise.withResolvers();
process.stdin.on('error',() => {});
process.stdin.on('data',(data) => {
  gateInput+=data.toString('ascii');
  if(gateInput==='RELEASE\n') release.resolve();
  else if(gateInput.length>=8) release.reject(new Error('SYNTHETIC_GATE'));
});
process.stdin.on('end',() => {if(gateInput!=='RELEASE\n')release.reject(new Error('SYNTHETIC_GATE'));});
release.promise.catch(()=>{});
process.once('message',async (bootstrap) => {
  try {
    assert.equal(process.platform,'win32');assert.equal(process.env.CAREBRIDGE_WORKER_IPC_TEST_CHILD,'synthetic-only');
    const instanceId=mediaWorkerControlId(process.argv[2]);
    assert.equal(Object.keys(bootstrap ?? {}).sort().join(','),'database,mediaRoot,purpose');
    assert.equal(bootstrap.purpose,'synthetic-carebridge-worker-child');
    const storage=databaseCredentialOptions(bootstrap.database.storage);assert.ok(storage.syntheticRunId);
    const root=win32.join(storage.privateRoot,'checks',`postgres-check-${storage.syntheticRunId}`);
    assert.equal(bootstrap.mediaRoot,win32.join(root,'source-media'));
    for(const path of [root,bootstrap.mediaRoot]) {const info=await lstat(path);assert.ok(info.isDirectory()&&!info.isSymbolicLink());}
    const receipt=JSON.parse(await readFile(win32.join(root,'.carebridge-check.json')));
    assert.deepEqual(receipt,{schema:1,purpose:'synthetic-native-e-postgres',runId:storage.syntheticRunId,root});
    // Each fresh in-memory engine starts its own container counter. It is not
    // the same engine across children; retained SQL receipts must not collide
    // with IDs from a different synthetic engine. Never loosen journal fences.
    const ownedEngine=`${engine}-ipc-${instanceId}`;
    clam=await fakeClam();const fake=fakePreparation(),exchange=fake.runtime.exchange.bind(fake.runtime);
    fake.runtime.identity=async () => ownedEngine;
    fake.runtime.exchange=async (...args) => {
      const result=await exchange(...args);process.stdout.write('PREPARING\n');await release.promise;return result;
    };
    await runWindowsMediaWorkerControlledProcess({database:bootstrap.database,media:{store:new PrivateFileStore(bootstrap.mediaRoot),
      scanner:clam.scanner,runtime:fake.runtime,engineIdentity:ownedEngine,approvedImageId:image,capacity:1,pollMilliseconds:50}},{instanceId});
  } catch {process.exitCode=1;}
  finally {
    await clam?.close().catch(() => {process.exitCode=1;});process.stdin.destroy();
    if(process.connected)process.disconnect(); // No process.exit or kill.
  }
});
