// Fresh synthetic Windows/E fixture only. No operating path, password, DB URL,
// owner-selected role, preparation adapter or arbitrary command on the wire.
import { win32 } from 'node:path';
import { databaseCredentialOptions } from './windows-database-credential-policy.mjs';
import { windowsDatabaseServiceOptions } from './windows-database-service.mjs';
import { syntheticWifiNetwork, wifiOrigin } from './synthetic-wifi-network.mjs';

export const nativeApiTestUnavailable = () => new Error('WINDOWS_NATIVE_API_TEST_UNAVAILABLE');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const protocol = 'carebridge-native-api-control-v1';

export function windowsNativeApiBootstrap(input) {
  try {
    const hasScreen = input != null && Object.hasOwn(input, 'screen');
    if (!exact(input, ['purpose', 'database', 'mediaRoot', ...(hasScreen ? ['screen'] : [])]) ||
        hasScreen && !Object.hasOwn(Object.getOwnPropertyDescriptor(input, 'screen'), 'value') ||
        input.purpose !== 'synthetic-carebridge-native-api' ||
        !exact(input.database, ['storage', 'credentialId', 'privileges', 'endpoint'])) throw nativeApiTestUnavailable();
    const screen = hasScreen ? input.screen : 'api-only';
    if (!['api-only', 'prepared'].includes(screen)) throw nativeApiTestUnavailable();
    const storage = databaseCredentialOptions(input.database.storage);
    const parsed = windowsDatabaseServiceOptions({ ...input.database, kind: 'runtime' });
    if (!storage.syntheticRunId || parsed.connection.ssl === false || parsed.connection.ssl.ca === undefined ||
        input.mediaRoot !== win32.join(storage.privateRoot, 'checks', `postgres-check-${storage.syntheticRunId}`, 'source-media'))
      throw nativeApiTestUnavailable();
    return Object.freeze({
      database: Object.freeze({ storage: parsed.storage, credentialId: parsed.credentialId, privileges: parsed.privileges,
        endpoint: Object.freeze({ host: parsed.connection.host, port: parsed.connection.port, ca: parsed.connection.ssl.ca }) }),
      root: win32.dirname(input.mediaRoot), mediaRoot: input.mediaRoot, screen,
    });
  } catch { throw nativeApiTestUnavailable(); }
}

export function windowsWifiApiBootstrap(input) {
  try {
    const hasScreen = input != null && Object.hasOwn(input, 'screen');
    const keys = ['purpose', 'database', 'mediaRoot', 'network', ...(hasScreen ? ['screen'] : [])];
    if (!exact(input, keys) || keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) ||
        input.purpose !== 'synthetic-carebridge-wifi-api') throw nativeApiTestUnavailable();
    const network = syntheticWifiNetwork(input.network);
    const parsed = windowsNativeApiBootstrap({ purpose: 'synthetic-carebridge-native-api', database: input.database,
      mediaRoot: input.mediaRoot, ...(hasScreen ? { screen: input.screen } : {}) });
    return Object.freeze({ ...parsed, network });
  } catch { throw nativeApiTestUnavailable(); }
}

export function nativeApiInstanceId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw nativeApiTestUnavailable();
  return value;
}
export function nativeApiOrigin(value, network) {
  try {
    if (network !== undefined) return wifiOrigin(value, network);
    if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(value)) throw nativeApiTestUnavailable();
    const url = new URL(value);
    if (url.origin !== value || Number(url.port) < 1024 || Number(url.port) > 65535) throw nativeApiTestUnavailable();
    return value;
  } catch { throw nativeApiTestUnavailable(); }
}
export function nativeApiControlMessage(instanceId, kind, origin, network) {
  nativeApiInstanceId(instanceId);
  if (!['ready', 'stop', 'stopped', 'failed'].includes(kind) || (kind !== 'ready' && origin !== undefined)) throw nativeApiTestUnavailable();
  return Object.freeze({ protocol, instanceId, kind, ...(kind === 'ready' ? { origin: nativeApiOrigin(origin, network) } : {}) });
}
export function parseNativeApiControlMessage(value, instanceId, direction, handle, network) {
  if (handle !== undefined || !['parent', 'child'].includes(direction) ||
      !exact(value, value?.kind === 'ready' ? ['protocol', 'instanceId', 'kind', 'origin'] : ['protocol', 'instanceId', 'kind']) ||
      value.protocol !== protocol || value.instanceId !== instanceId ||
      (direction === 'parent' ? value.kind !== 'stop' : value.kind === 'stop')) throw nativeApiTestUnavailable();
  return nativeApiControlMessage(instanceId, value.kind, value.origin, network);
}
