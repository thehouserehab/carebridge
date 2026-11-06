import { createHash } from 'node:crypto';
import { decoderJobManifest } from './decoder-job-protocol.mjs';
import { validatePreparationReport } from './media-preparation-protocol.mjs';
import { fail } from './errors.mjs';

const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value,key));
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function scanEvidence(value,manifest) {
  if (!exact(value,['engine','engineVersion','databaseVersion','databaseUpdatedAt','verdict','checkedBytes','sha256','mediaAcceptanceReady']) ||
      value.engine !== 'clamav' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.engineVersion ?? '') ||
      !Number.isSafeInteger(value.databaseVersion) || value.databaseVersion < 1 || value.databaseVersion > 4294967295 ||
      typeof value.databaseUpdatedAt !== 'string' || !Number.isFinite(Date.parse(value.databaseUpdatedAt)) ||
      new Date(value.databaseUpdatedAt).toISOString() !== value.databaseUpdatedAt || !['clean','rejected'].includes(value.verdict) ||
      value.checkedBytes !== manifest.size || value.sha256 !== manifest.sha256 || value.mediaAcceptanceReady !== false) fail('SCAN_UNAVAILABLE');
  return { ...value };
}
export const sameScanEngine = (a,b) => ['engine','engineVersion','databaseVersion','databaseUpdatedAt'].every((key) => a[key] === b[key]);

// Revalidate at the storage boundary, not just at the worker/transport boundary.
// This is technical evidence for exact bytes, NOT clinical/operating approval.
export function preparedCandidate(value,file,id) {
  try {
    file = decoderJobManifest(file);
    if (!exact(value,['status','bytes','report','mediaAcceptanceReady']) || value.status !== 'prepared' || value.mediaAcceptanceReady !== false ||
        !exact(value.report,['source','derivative','sourceScan','derivativeScan','preparation','mediaAcceptanceReady']) || value.report.mediaAcceptanceReady !== false) fail('SCAN_INVALID');
    const preparation = validatePreparationReport(value.report.preparation,id,file);
    if (!same(decoderJobManifest(value.report.source),file) || !same(decoderJobManifest(value.report.derivative),preparation.derivative) ||
        !Buffer.isBuffer(value.bytes) || value.bytes.length !== preparation.derivative.size ||
        createHash('sha256').update(value.bytes).digest('hex') !== preparation.derivative.sha256) fail('SCAN_INVALID');
    const sourceScan = scanEvidence(value.report.sourceScan,file),derivativeScan = scanEvidence(value.report.derivativeScan,preparation.derivative);
    if (sourceScan.verdict !== 'clean' || derivativeScan.verdict !== 'clean' || !sameScanEngine(sourceScan,derivativeScan)) fail('SCAN_INVALID');
    return { source:file,derivative:preparation.derivative,sourceScan,derivativeScan,preparation,mediaAcceptanceReady:false };
  } catch { fail('SCAN_INVALID'); }
}
export function preparationRejection(value,file) {
  try {
    file = decoderJobManifest(file);
    const derivative = value?.stage === 'derivative';
    if (!exact(value,derivative ? ['status','stage','source','sourceScan','derivativeScan','mediaAcceptanceReady'] :
      ['status','stage','source','sourceScan','mediaAcceptanceReady']) || value.status !== 'rejected' ||
      !['source','derivative'].includes(value.stage) || value.mediaAcceptanceReady !== false || !same(decoderJobManifest(value.source),file)) fail('SCAN_INVALID');
    const sourceScan = scanEvidence(value.sourceScan,file);
    if (!derivative && sourceScan.verdict !== 'rejected') fail('SCAN_INVALID');
    if (derivative) {
      const scan = scanEvidence(value.derivativeScan,decoderJobManifest({ type:file.type,size:value.derivativeScan?.checkedBytes,sha256:value.derivativeScan?.sha256 }));
      if (sourceScan.verdict !== 'clean' || scan.verdict !== 'rejected' || !sameScanEngine(sourceScan,scan)) fail('SCAN_INVALID');
    }
    return { verdict:'rejected',engine:sourceScan.engine,engineVersion:sourceScan.engineVersion,policyVersion:'carebridge-media-v1' };
  } catch { fail('SCAN_INVALID'); }
}
