import { win32 } from 'node:path';

// Synthetic Windows test tooling only, not a production worker launch policy.
// The caller still owns the executable, Docker user config and engine access.
// Node/libuv on Windows additionally supplies missing OS-essential identity
// variables. This bounds explicit application inheritance, not an OS sandbox.
const unavailable = () => new Error('LOCAL_DOCKER_TEST_UNAVAILABLE');
const nativeNames = ['SYSTEMROOT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'];
const fixturePatterns = Object.freeze({
  POSTGRES_PASSWORD:/^[a-f0-9]{64}$/,
  CAREBRIDGE_FIXTURE_PASSWORD:/^[a-f0-9]{64}$/,
  CAREBRIDGE_LINUX_TEST_ENGINE:/^[a-zA-Z0-9:_-]{12,80}$/,
  CAREBRIDGE_LINUX_TEST_IMAGE:/^sha256:[a-f0-9]{64}$/,
  CAREBRIDGE_LINUX_TEST_DATABASE_ID:/^[a-f0-9]{64}$/,
});
const literalEnvironment = new Set([
  'TZ=UTC',
  'POSTGRES_USER=carebridge_fixture_admin',
  'POSTGRES_DB=postgres',
  'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
  'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256',
]);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
function nativePath(value) {
  if (typeof value !== 'string' || !/^[a-z]:[\\/]/i.test(value) ||
      /[\x00-\x1f\x7f:*?"<>|]/.test(value.slice(2)) || /(^|[\\/])\.\.([\\/]|$)/.test(value)) throw unavailable();
  return win32.normalize(value);
}

export function localDockerTestConfiguration(source,extra = {}) {
  try {
    if (!record(source) || !record(extra) || ![Object.prototype,null].includes(Object.getPrototypeOf(extra))) throw unavailable();
    const descriptors = Object.getOwnPropertyDescriptors(source),base = {};
    for (const name of nativeNames) {
      const keys = Object.keys(descriptors).filter((key) => key.toUpperCase() === name);
      if (keys.length > 1) throw unavailable(); // Windows names are case-insensitive.
      if (keys.length) {
        const property = descriptors[keys[0]];
        if (!Object.hasOwn(property,'value')) throw unavailable();
        base[name] = nativePath(property.value);
      }
    }
    if (!base.SYSTEMROOT || !base.LOCALAPPDATA) throw unavailable();
    const cli = win32.join(base.LOCALAPPDATA,'Programs','DockerDesktop','resources','bin','docker.exe');
    base.WINDIR = base.SYSTEMROOT;
    base.PATH = `${win32.dirname(cli)};${win32.join(base.SYSTEMROOT,'System32')};${base.SYSTEMROOT}`;
    base.TZ = 'UTC'; base.LANG = 'C';
    Object.freeze(base);

    // Capture before the first native await. Never accept arbitrary overrides,
    // accessors, differently cased duplicates or application credentials.
    const fixtures = {};
    for (const key of Reflect.ownKeys(extra)) {
      if (typeof key !== 'string' || !Object.hasOwn(fixturePatterns,key)) throw unavailable();
      const property = Object.getOwnPropertyDescriptor(extra,key);
      if (!Object.hasOwn(property,'value') || typeof property.value !== 'string' ||
          !fixturePatterns[key].test(property.value)) throw unavailable();
      fixtures[key] = property.value;
    }
    Object.freeze(fixtures);
    return Object.freeze({cli,environmentFor(args) {
      try {
        if (!Array.isArray(args) || !args.length || Object.keys(args).length !== args.length ||
            args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw unavailable();
        // Build, inspect, info, attach, exchange and cleanup never receive even
        // the generated fixture password. Only an explicit create --env NAME
        // may import that one captured value into the intended test container.
        if (args[0] !== 'create') return base;
        const environment = {...base},seen = new Set();
        for (let index = 1; index < args.length; index++) {
          const arg = args[index];
          if (arg === '--env-file' || arg.startsWith('--env-file=') || /^-e(?:$|[^-])/.test(arg)) throw unavailable();
          if (arg !== '--env' && !arg.startsWith('--env=')) continue;
          const entry = arg === '--env' ? args[++index] : arg.slice(6);
          if (typeof entry !== 'string' || !entry) throw unavailable();
          const name = entry.split('=',1)[0];
          if (seen.has(name.toUpperCase())) throw unavailable();
          seen.add(name.toUpperCase());
          if (entry.includes('=')) {
            if (!literalEnvironment.has(entry)) throw unavailable();
          } else {
            if (!Object.hasOwn(fixtures,name)) throw unavailable();
            environment[name] = fixtures[name];
          }
        }
        return Object.freeze(environment);
      } catch { throw unavailable(); }
    }});
  } catch { throw unavailable(); }
}
