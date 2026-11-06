import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {addAuthPasswordRecoveryNativeCases,PASSWORD_RECOVERY_NATIVE_CASE_COUNT} from '../auth-password-recovery-native-tests.mjs';

test('native recovery registration is inert and declares eight uniquely named bounded cases',() => {
  let calls = 0;
  const database = {transaction:() => {calls++; throw new Error('SYNTHETIC_DATABASE_MUST_NOT_START');}};
  const cases = [];
  addAuthPasswordRecoveryNativeCases((label,work) => cases.push({label,work}),database,database,{owner:database,observer:database});
  assert.equal(calls,0);
  assert.equal(PASSWORD_RECOVERY_NATIVE_CASE_COUNT,8);
  assert.equal(cases.length,PASSWORD_RECOVERY_NATIVE_CASE_COUNT);
  assert.equal(new Set(cases.map(row => row.label)).size,cases.length);
  for (const row of cases) {
    assert.match(row.label,/^[a-zA-Z0-9 ,.-]{1,160}$/);
    assert.equal(typeof row.work,'function');
  }
});

test('native recovery is explicitly packaged and both runners retain exact scenario milestones',async () => {
  const source = async name => readFile(new URL(`../${name}`,import.meta.url),'utf8');
  const [docker,allowlist,postgres,windows,fixture,launcher] = await Promise.all([
    'postgres-test.Dockerfile','postgres-test.Dockerfile.dockerignore','postgres-integration.mjs',
    'windows-postgres-check.mjs','postgres-container-fixture.mjs','postgres-container-test.mjs',
  ].map(source));
  assert.match(docker,/COPY server\/auth\.mjs server\/auth-password-change-native-tests\.mjs server\/auth-password-recovery-native-tests\.mjs \.\//);
  assert.ok(allowlist.split(/\r?\n/).includes('!server/auth-password-recovery-native-tests.mjs'));
  assert.match(postgres,/addAuthPasswordRecoveryNativeCases\(check,databaseA,databaseB\)/);
  assert.match(windows,/owner:source,observer:database\(sourceCluster\.config\)/);
  assert.match(windows,/assert\.equal\(recoveryCases\.length,PASSWORD_RECOVERY_NATIVE_CASE_COUNT\)/);
  for (const text of [fixture,launcher]) assert.ok(text.includes('Native PostgreSQL integration: 61 scenarios passed.'));
  assert.match(launcher,/recovery \? 14 : 61/);
  // The established combined native-media/recovery mode adds 23 prepared
  // restore checks to 55. Keep every exact milestone, including the combined
  // 78 branch already checked by native-recovery-wiring.test.mjs.
  assert.match(windows,/assert\.equal\(stateChecks\.length,preparedFaultSamples\?23:18\)/);
  assert.match(windows,/checks\.length === \(nativeMediaCheck\?\(recoveryStateCheck\?78:55\):roleCheck\?48:recoveryStateCheck\?27:9\)/);
});
