import { win32 } from 'node:path';

// Synthetic local tooling only. Deliberately accepts no DB URL, port, password,
// existing cluster, shell, TLS bypass or production activation option.
const fail = () => { throw new Error('WINDOWS_POSTGRES_CONFIGURATION'); };
export const PORTABLE_POSTGRES_VERSION = '18.6-5';
export const PORTABLE_POSTGRES_SHA256 = 'e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2';
export function windowsPostgresOptions(args) {
  if (!Array.isArray(args) || args.length !== 5 || args[0] !== '--base' || args[2] !== '--powershell' ||
      args[4] !== '--confirm-synthetic-e-drive' ||
      typeof args[1] !== 'string' || !/^e:[\\/][^\x00-\x1f\x7f]+$/i.test(args[1]) ||
      typeof args[3] !== 'string' || !/^[a-z]:[\\/][^\x00-\x1f\x7f]+$/i.test(args[3])) fail();
  const base = win32.resolve(args[1]), powershell = win32.resolve(args[3]);
  if (base === win32.parse(base).root || win32.basename(powershell).toLowerCase() !== 'pwsh.exe' ||
      /[:*?"<>|]/.test(base.slice(2)) || /[:*?"<>|]/.test(powershell.slice(2))) fail();
  return Object.freeze({ base, powershell, privateRoot:win32.join(base,'private'),
    bin:win32.join(base,'private','runtime',`postgresql-${PORTABLE_POSTGRES_VERSION}`,'pgsql','bin') });
}
export function windowsPostgresCheckOptions(args) {
  if(!Array.isArray(args))fail();
  const nativeRecoveryCheck=args[0]==='--verify-native-recovery';
  const nativeMediaCheck=nativeRecoveryCheck||args[0]==='--verify-native-media';
  const recoveryStateCheck=nativeRecoveryCheck||args[0]==='--verify-recovery-state';
  const roleCheck=nativeMediaCheck||args[0]==='--verify-role-privileges';
  return Object.freeze({options:windowsPostgresOptions(args.slice(roleCheck||recoveryStateCheck?1:0)),roleCheck,nativeMediaCheck,recoveryStateCheck});
}
export function postgresCheckPaths(privateRoot, runId) {
  if (typeof privateRoot !== 'string' || !/^e:[\\/]/i.test(privateRoot) ||
      typeof runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId)) fail();
  const root = win32.join(privateRoot,'checks',`postgres-check-${runId}`);
  return Object.freeze({ root, source:win32.join(root,'source'), restored:win32.join(root,'restored'),
    sourceMedia:win32.join(root,'source-media'), restoredMedia:win32.join(root,'restored-media'),
    stateMedia:win32.join(root,'state-media'),
    bundles:win32.join(root,'bundles'), restoreInput:win32.join(root,'restore-input') });
}
export function windowsPostgresEnvironment(environment, bin) {
  // No inherited PG*, DATABASE_URL, NODE_OPTIONS, PowerShell profile or custom
  // DLL search path. Case-insensitive Windows environment variable handling.
  const names = ['SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'];
  const result = {};
  for (const name of names) {
    const key = Object.keys(environment).find((candidate) => candidate.toUpperCase() === name);
    if (key !== undefined) result[name] = environment[key];
  }
  if (typeof result.SYSTEMROOT !== 'string' || !win32.isAbsolute(result.SYSTEMROOT) ||
      typeof bin !== 'string' || !win32.isAbsolute(bin)) fail();
  result.PATH = `${bin};${win32.join(result.SYSTEMROOT,'System32')};${result.SYSTEMROOT}`;
  result.TZ = 'UTC'; result.LANG = 'C';
  return result;
}
