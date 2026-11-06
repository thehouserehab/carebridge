// An explicit, single-peer synthetic Wi-Fi boundary. No LAN discovery, DNS,
// wildcard interfaces, IPv6, or caller-selected ports are accepted here.
import { isIPv4 } from 'node:net';

const unavailable = () => new Error('SYNTHETIC_WIFI_NETWORK_UNAVAILABLE');
function privateAddress(value) {
  if (typeof value !== 'string' || !isIPv4(value)) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}

export function syntheticWifiNetwork(input) {
  try {
    const keys = ['host', 'peerAddress', 'port', 'confirmSynthetic'];
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key) ?? {}, 'value')))
      throw unavailable();
    const { host, peerAddress, port, confirmSynthetic } = input;
    if (!privateAddress(host) || !privateAddress(peerAddress) || host === peerAddress || port !== 8443 || confirmSynthetic !== true)
      throw unavailable();
    return Object.freeze({ host, peerAddress, port, confirmSynthetic });
  } catch { throw unavailable(); }
}

export function wifiOrigin(value, network) {
  const parsed = syntheticWifiNetwork(network);
  if (typeof value !== 'string' || value !== `https://${parsed.host}:${parsed.port}`) throw unavailable();
  return value;
}
