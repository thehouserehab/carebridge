// Explicit synthetic entrypoint only. Credentials are recovered by the fixed
// runtime-role service; IPC never carries a password or arbitrary executable.
import { createWindowsLocalApiService } from './windows-local-api-service.mjs';
import { runWindowsNativeApiTestChild } from './windows-native-api-test-control.mjs';

try {
  if (process.platform !== 'win32' || process.env.CAREBRIDGE_NATIVE_API_TEST_CHILD !== 'synthetic-only' || process.argv.length !== 3)
    throw new Error('WINDOWS_NATIVE_API_TEST_UNAVAILABLE');
  await runWindowsNativeApiTestChild({ instanceId: process.argv[2], createService: createWindowsLocalApiService,
    readActiveResources: () => process.getActiveResourcesInfo() });
} catch {
  process.stderr.write('NATIVE_API_FAILED\n');
  if ([undefined, null, 0].includes(process.exitCode)) process.exitCode = 1;
  if (process.connected) process.disconnect();
}
