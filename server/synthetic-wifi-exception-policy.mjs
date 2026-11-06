import path from 'node:path';

// This opt-in identifies one existing Windows application-query TCP rule.
// It is not a wildcard, a display name, or permission to select another rule.
// The elevated helper separately verifies the full rule/filter preimage.
export function syntheticWifiTcpBlockRule(value) {
  if (typeof value !== 'string' || value.length > 300) throw Error('SYNTHETIC_WIFI_TCP_BLOCK_RULE');
  const match = /^TCP Query User\{[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\}(.+)$/.exec(value);
  const file = match?.[1];
  if (!file || file.length > 240 || !/^[A-Za-z]:\\/.test(file) || /[<>"|?*%~\x00-\x1f/]/.test(file) ||
      file.slice(2).includes(':') || path.win32.normalize(file) !== file ||
      path.win32.basename(file).toLowerCase() !== 'node.exe' ||
      file.split('\\').slice(1).some(part => !part || /[ .]$/.test(part) ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw Error('SYNTHETIC_WIFI_TCP_BLOCK_RULE');
  return value;
}
