import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsPostgresOptions, windowsPostgresCheckOptions, postgresCheckPaths, windowsPostgresEnvironment } from '../windows-postgres-policy.mjs';
const args = ['--base','E:\\CarebridgeBeta','--powershell','C:\\Tools\\pwsh.exe','--confirm-synthetic-e-drive'];
test('Windows PostgreSQL probe requires explicit E storage and a synthetic-only confirmation', () => {
  const options = windowsPostgresOptions(args);
  assert.equal(options.base,'E:\\CarebridgeBeta'); assert.equal(options.powershell,'C:\\Tools\\pwsh.exe');
  assert.equal(options.bin,'E:\\CarebridgeBeta\\private\\runtime\\postgresql-18.6-5\\pgsql\\bin');
  assert.equal(Object.isFrozen(options),true);
  for (const value of [null, [], args.slice(0,4), [...args,'--activate'], ['--base','E:\\',...args.slice(2)],
    ['--base','C:\\Beta',...args.slice(2)], ['--base','E:relative',...args.slice(2)], ['--base','E:\\Beta\\..',...args.slice(2)],
    ['--base','\\\\host\\share',...args.slice(2)], ['--base','E:\\x:stream',...args.slice(2)],
    ['--base','E:\\x\n',...args.slice(2)], [...args.slice(0,2),'--powershell','pwsh.exe',args[4]],
    [...args.slice(0,2),'--powershell','C:\\cmd.exe',args[4]], [...args.slice(0,4),'--production']])
    assert.throws(() => windowsPostgresOptions(value),{ message:'WINDOWS_POSTGRES_CONFIGURATION' });
});
test('native recovery requires one explicit mode while preserving every existing mode result', () => {
  for (const [mode, roleCheck, nativeMediaCheck, recoveryStateCheck] of [
    [null, false, false, false],
    ['--verify-role-privileges', true, false, false],
    ['--verify-native-media', true, true, false],
    ['--verify-recovery-state', false, false, true],
    ['--verify-native-recovery', true, true, true],
  ]) {
    const result = windowsPostgresCheckOptions(mode ? [mode, ...args] : args);
    assert.deepEqual(result, { options:windowsPostgresOptions(args), roleCheck, nativeMediaCheck, recoveryStateCheck });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.options), true);
  }
});

test('native check modes reject duplicate or combined flags instead of implicitly widening scope', () => {
  const modes = ['--verify-role-privileges', '--verify-native-media', '--verify-recovery-state', '--verify-native-recovery'];
  for (const first of modes) {
    for (const second of modes) {
      for (const value of [[first, second, ...args], [first, ...args, second], [first, ...args.slice(0, 2), second, ...args.slice(2)]])
        assert.throws(() => windowsPostgresCheckOptions(value), { message:'WINDOWS_POSTGRES_CONFIGURATION' });
    }
    assert.throws(() => windowsPostgresCheckOptions([...args, first]), { message:'WINDOWS_POSTGRES_CONFIGURATION' });
  }
});

test('native recovery preserves strict storage confirmation and rejects supplied database, host and secret options', () => {
  const mode = '--verify-native-recovery';
  const forbidden = [
    ['--database-url', 'postgresql://synthetic.invalid/test'],
    ['--database', 'previous-synthetic-database'],
    ['--cluster', 'E:\\CarebridgeBeta\\private\\existing-cluster'],
    ['--host', '127.0.0.1'], ['--port', '5432'],
    ['--password', 'synthetic-not-a-secret'], ['--key', 'E:\\synthetic.key'],
    ['--tls-key', 'E:\\synthetic.key'], ['--resume'], ['--activate'],
  ];
  for (const extra of forbidden) {
    for (const value of [[mode, ...args, ...extra], [mode, ...extra, ...args]])
      assert.throws(() => windowsPostgresCheckOptions(value), { message:'WINDOWS_POSTGRES_CONFIGURATION' });
  }
  for (const value of [null, {}, [], [mode], [mode, ...args.slice(0, 4)],
    ['--VERIFY-NATIVE-RECOVERY', ...args], ['--verify-native-recovery=true', ...args],
    [mode, '--base', 'C:\\Beta', ...args.slice(2)], [mode, '--base', 'E:\\', ...args.slice(2)],
    [mode, ...args.slice(2), ...args.slice(0, 2)], [mode, ...args.slice(0, 4), '--production']])
    assert.throws(() => windowsPostgresCheckOptions(value), { message:'WINDOWS_POSTGRES_CONFIGURATION' });
});

test('native persistence probe paths are fresh UUID-owned descendants, never a provided cluster', () => {
  const paths = postgresCheckPaths('E:\\CarebridgeBeta\\private','b364d384-02e7-497c-9412-ca0c3778ea20');
  assert.equal(paths.source,'E:\\CarebridgeBeta\\private\\checks\\postgres-check-b364d384-02e7-497c-9412-ca0c3778ea20\\source');
  assert.notEqual(paths.source,paths.restored); assert.equal(Object.isFrozen(paths),true);
  assert.equal(paths.stateMedia,`${paths.root}\\state-media`);
  assert.notEqual(paths.stateMedia,paths.sourceMedia); assert.notEqual(paths.stateMedia,paths.restoredMedia);
  for (const [root,id] of [['C:\\Beta','b364d384-02e7-497c-9412-ca0c3778ea20'],['E:\\Beta','../x'],['E:\\Beta','not-uuid']])
    assert.throws(() => postgresCheckPaths(root,id),{ message:'WINDOWS_POSTGRES_CONFIGURATION' });
});
test('native children cannot inherit DB endpoints, credentials, hooks or alternate executable paths', () => {
  const environment = windowsPostgresEnvironment({ SystemRoot:'C:\\Windows',Path:'C:\\Untrusted',
    pgHOST:'external.example',PGPASSWORD:'not-a-real-secret',DATABASE_URL:'not-a-real-url',
    NODE_OPTIONS:'--import injected',PSModulePath:'C:\\Untrusted',TEMP:'C:\\Temp',custom:'not-carried' },'E:\\Beta\\bin');
  assert.deepEqual(environment,{ SYSTEMROOT:'C:\\Windows',TEMP:'C:\\Temp',
    PATH:'E:\\Beta\\bin;C:\\Windows\\System32;C:\\Windows',TZ:'UTC',LANG:'C' });
  assert.throws(() => windowsPostgresEnvironment({},'E:\\Beta\\bin'),{ message:'WINDOWS_POSTGRES_CONFIGURATION' });
});
