// Synthetic E/Windows API composition only. No migration, seed, inspection,
// Docker runtime, worker/owner connection, environment discovery or deletion.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { win32 } from 'node:path';
import { Auth } from './auth.mjs';
import { Conversations } from './conversations.mjs';
import { Children, MemberProfiles } from './profiles.mjs';
import { Relationships } from './relationships.mjs';
import { CareRecipientLinks } from './care-recipient-links.mjs';
import { PrimaryCommunicators } from './primary-communicators.mjs';
import { Records } from './records.mjs';
import { ActivityFeedback } from './activity-feedback.mjs';
import { Goals, Appointments } from './care-contexts.mjs';
import { MediaUploads } from './media-uploads.mjs';
import { MediaAccess } from './media-access.mjs';
import { PrivateFileStore } from './private-file-store.mjs';
import { openWindowsDatabaseService } from './windows-database-service.mjs';
import { windowsNativeApiBootstrap, windowsWifiApiBootstrap } from './windows-native-api-test-policy.mjs';
import { createLocalApiListener, createSyntheticHttpsApiListener } from './local-api-listener.mjs';
import { SyntheticHttpsTransport } from './synthetic-https-transport.mjs';

const unavailable = () => new Error('WINDOWS_LOCAL_API_UNAVAILABLE');
const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function ownedRoot(options) {
  // Do not create, adopt, or repair a missing/replaced fixture directory.
  for (let part = options.mediaRoot; ; part = win32.dirname(part)) {
    const info = await lstat(part, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
    if (part === win32.dirname(part)) break;
  }
  if (win32.resolve(await realpath(options.mediaRoot)) !== options.mediaRoot) throw unavailable();
  const identity = await lstat(options.mediaRoot, { bigint: true });
  const path = win32.join(options.root, '.carebridge-check.json');
  const entry = await lstat(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.size < 1n || entry.size > 2048n) throw unavailable();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!sameObject(entry, before) || before.size !== entry.size || !before.isFile() || before.nlink !== 1n) throw unavailable();
    // Bounded read, even if another process grows the file after stat().
    const bytes = Buffer.alloc(2049);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (BigInt(bytesRead) !== before.size) throw unavailable();
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
    const expected = { schema: 1, purpose: 'synthetic-native-e-postgres',
      runId: options.database.storage.syntheticRunId, root: options.root };
    if (!receipt || Object.keys(receipt).length !== Object.keys(expected).length ||
        Object.keys(expected).some(key => receipt[key] !== expected[key])) throw unavailable();
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true });
    if (!sameObject(before, after) || !sameObject(before, current) || current.isSymbolicLink() ||
        [after, current].some(info => !info.isFile() || info.nlink !== 1n || info.size !== before.size ||
          info.mtimeNs !== before.mtimeNs || info.ctimeNs !== before.ctimeNs)) throw unavailable();
  } finally { await handle.close(); }
  if (!sameObject(identity, await lstat(options.mediaRoot, { bigint: true }))) throw unavailable();
  return identity;
}

export async function createWindowsLocalApiService(input) {
  return createOwnedService(input, false);
}

// Separate entry point: existing loopback callers cannot gain LAN authority by
// adding a host, port or certificate to the old factory's options.
export async function createWindowsWifiApiService(input) {
  return createOwnedService(input, true);
}

async function createOwnedService(input, wifi) {
  let database, listener, transport, closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      // Listener closure includes late file-open and stream-disposal work.
      // On uncertain drain do NOT close its DB, delete files, or claim exit.
      await listener?.close();
      transport?.invalidate();
      await database?.close();
    })().catch(() => { throw unavailable(); });
    void closePromise.catch(() => { closePromise = undefined; });
    return closePromise;
  };
  try {
    const required = wifi ? ['database', 'mediaRoot', 'network', 'cert', 'key'] : ['database', 'mediaRoot'];
    const allowed = [...required, 'screen'];
    if (process.platform !== 'win32' || !input || typeof input !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        !required.every(key => Object.hasOwn(input, key)) ||
        Reflect.ownKeys(input).some(key => !allowed.includes(key)) ||
        !Reflect.ownKeys(input).every(key => {
          const property = Object.getOwnPropertyDescriptor(input, key);
          return property && Object.hasOwn(property, 'value');
        })) throw unavailable();
    const { cert, key, ...bootstrap } = input;
    const options = wifi ? windowsWifiApiBootstrap({ purpose: 'synthetic-carebridge-wifi-api', ...bootstrap }) :
      windowsNativeApiBootstrap({ purpose: 'synthetic-carebridge-native-api', ...bootstrap });
    // Certificate/IP/key checks precede any filesystem, credential or DB IO.
    if (wifi) transport = new SyntheticHttpsTransport({ mode: 'private-wifi',
      host: options.network.host, peerAddress: options.network.peerAddress,
      confirmSynthetic: true, cert, key });
    const original = await ownedRoot(options);
    database = await openWindowsDatabaseService({ ...options.database, kind: 'runtime' });
    if (!sameObject(original, await ownedRoot(options))) throw unavailable();
    const store = new PrivateFileStore(options.mediaRoot);
    const listenerOptions = { screen: options.screen, services: {
      auth: new Auth(database), conversations: new Conversations(database), profiles: new Children(database),
      memberProfiles: new MemberProfiles(database), relationships: new Relationships(database),
      careRecipientLinks: new CareRecipientLinks(database), primaryCommunicators: new PrimaryCommunicators(database),
      records: new Records(database), feedback: new ActivityFeedback(database),
      goals: new Goals(database), appointments: new Appointments(database),
      mediaUploads: new MediaUploads(database, store, { preparation: null,
        ttlMilliseconds: 15 * 60_000, leaseMilliseconds: 15_000, operationTimeoutMilliseconds: 8_000 }),
      mediaAccess: new MediaAccess(database, store), mediaMaintenance: 'worker',
    } };
    listener = wifi ? await createSyntheticHttpsApiListener({ ...listenerOptions, transport, port: options.network.port }) :
      await createLocalApiListener(listenerOptions);
    return Object.freeze({ origin: listener.origin, close });
  } catch {
    await close();
    throw unavailable();
  }
}
