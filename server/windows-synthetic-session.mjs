import {createWindowsSyntheticStorage} from './windows-synthetic-storage.mjs';
import {createWindowsSyntheticMediaEnvironment} from './windows-native-media-test-fixture.mjs';
import {launchWindowsSyntheticWorker} from './windows-synthetic-worker-parent.mjs';
import {launchWindowsNativeApiTest} from './windows-native-api-test-parent.mjs';
import {ownSyntheticSession} from './synthetic-session-lifetime.mjs';
import {syntheticSessionOptions} from './synthetic-e-session-options.mjs';

// Human synthetic use, not production/real-data service or public deployment.
export function createWindowsSyntheticSession(args) {
  const selected=syntheticSessionOptions(args),captured=[...selected.postgresArgs];
  return ownSyntheticSession({storage:()=>createWindowsSyntheticStorage(captured,selected),media:createWindowsSyntheticMediaEnvironment,
    worker:({storage,media,onOwned})=>launchWindowsSyntheticWorker({database:storage.configuration('worker'),mediaRoot:storage.mediaRoot,
      environment:storage.environment,onOwned,nativeMedia:{engineIdentity:media.engine,approvedImageId:media.approvedImageId,scannerEndpoint:media.bridge.endpoint}}),
    api:({storage,onOwned})=>launchWindowsNativeApiTest({database:storage.configuration('runtime'),mediaRoot:storage.mediaRoot,
      environment:storage.environment,onOwned,screen:'prepared'}),
  });
}
