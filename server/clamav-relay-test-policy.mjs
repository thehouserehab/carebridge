import {testResourceNames,resourceReceipt,containerArguments,assertContainerIsolation} from './clamav-container-policy.mjs';
const unavailable=() => new Error('CLAMAV_RELAY_TEST_UNAVAILABLE');
export function clamAvRelayArguments(run,scannerId,imageId) {
  try {
    const args=containerArguments(testResourceNames(run),'worker',imageId,scannerId);
    return [...args.slice(0,-1),'--interactive',imageId];
  } catch {throw unavailable();}
}
export function assertClamAvRelayIsolation(value,receipt,imageId,scannerId,running=false) {
  try {
    resourceReceipt(receipt.id,'worker',receipt.run);
    const h=value.HostConfig,env=value.Config?.Env;
    if(receipt.role!=='worker'||value.Config?.OpenStdin!==true||value.Config.Tty!==false||
      JSON.stringify(value.Config.Entrypoint)!=='["/usr/local/bin/node"]'||
      JSON.stringify(value.Config.Cmd)!=='["/app/server/clamav-relay-peer-test.mjs"]'||
      JSON.stringify(h.SecurityOpt)!=='["no-new-privileges"]'||h.GroupAdd?.length||
      h.Ulimits?.length!==1||h.Ulimits[0].Name!=='nofile'||h.Ulimits[0].Soft!==1024||h.Ulimits[0].Hard!==1024||
      !Array.isArray(env)||new Set(env.map(item=>item.split('=',1)[0])).size!==env.length||
      env.some(item=>typeof item!=='string'||!(/^(TZ=UTC|NODE_VERSION=24\.15\.0|YARN_VERSION=\d+\.\d+\.\d+|PATH=[a-z0-9_/:]+)$/.test(item))))throw unavailable();
    assertContainerIsolation(value,receipt,imageId,{scannerId,running});
  } catch {throw unavailable();}
}
