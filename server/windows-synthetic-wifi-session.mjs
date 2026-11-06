import { createWindowsSyntheticStorage } from './windows-synthetic-storage.mjs';
import { createWindowsSyntheticMediaEnvironment } from './windows-native-media-test-fixture.mjs';
import { launchWindowsSyntheticWorker } from './windows-synthetic-worker-parent.mjs';
import { launchWindowsWifiApiTest } from './windows-native-api-test-parent.mjs';
import { ownSyntheticSession } from './synthetic-session-lifetime.mjs';
import { syntheticSessionOptions } from './synthetic-e-session-options.mjs';
import { syntheticWifiNetwork } from './synthetic-wifi-network.mjs';

const invalid = () => new Error('WINDOWS_SYNTHETIC_WIFI_SESSION_CONFIGURATION');

function configuration(input) {
  try {
    const names = ['postgresArgs', 'network', 'cert', 'key'];
    if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).length !== names.length) throw invalid();
    const captured = {};
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
      captured[name] = descriptor.value;
    }
    // Copy exactly the original five PostgreSQL arguments without invoking a
    // caller-owned iterator, getter, or inherited array item. Resume flags and
    // session retention are deliberately unavailable in this Wi-Fi factory.
    const args = captured.postgresArgs;
    if (!Array.isArray(args) || Object.getPrototypeOf(args) !== Array.prototype || args.length !== 5 ||
        Reflect.ownKeys(args).some(name => !['0', '1', '2', '3', '4', 'length'].includes(name))) throw invalid();
    const values = [];
    for (let index = 0; index < 5; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(args, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') throw invalid();
      values.push(descriptor.value);
    }
    const selected = syntheticSessionOptions(values);
    if (selected.mode !== 'ephemeral' || selected.sessionId !== null || selected.postgresArgs.length !== 5) throw invalid();
    const network = syntheticWifiNetwork(captured.network);
    if (!Buffer.isBuffer(captured.cert) || captured.cert.length < 128 || captured.cert.length > 65536 ||
        !Buffer.isBuffer(captured.key) || captured.key.length < 128 || captured.key.length > 16384) throw invalid();
    return { selected, network, cert: Buffer.from(captured.cert), key: Buffer.from(captured.key) };
  } catch { throw invalid(); }
}

/**
 * Ephemeral synthetic E storage + one explicitly approved Wi-Fi API boundary.
 * This factory never changes firewall/trust, exports a certificate, adopts a
 * prior session, or broadens the existing worker/database/media permissions.
 */
export function createWindowsSyntheticWifiSession(input) {
  // Invalid contracts fail synchronously, before ownSyntheticSession can queue
  // storage initialization or native child startup.
  const { selected, network, cert, key } = configuration(input);
  const clearMaterial = () => { cert.fill(0); key.fill(0); };
  try {
    const session = ownSyntheticSession({
      storage: () => createWindowsSyntheticStorage([...selected.postgresArgs], selected),
      media: createWindowsSyntheticMediaEnvironment,
      worker: ({ storage, media, onOwned }) => launchWindowsSyntheticWorker({
        database: storage.configuration('worker'), mediaRoot: storage.mediaRoot,
        environment: storage.environment, onOwned,
        nativeMedia: { engineIdentity: media.engine, approvedImageId: media.approvedImageId,
          scannerEndpoint: media.bridge.endpoint },
      }),
      api: ({ storage, onOwned }) => launchWindowsWifiApiTest({
        database: storage.configuration('runtime'), mediaRoot: storage.mediaRoot,
        environment: storage.environment, onOwned, screen: 'prepared', network, cert, key,
      }),
    });
    // API-only restart keeps these same owned bytes. A rejected close or an
    // observation deadline is not permission to discard them: only the full
    // lifetime's terminal child/drain/database/secret cleanup resolves stop.
    // Returned caller Buffers are never mutated by this factory.
    void session.waitForStop().then(clearMaterial, () => {});
    return session;
  } catch {
    clearMaterial();
    throw invalid();
  }
}
