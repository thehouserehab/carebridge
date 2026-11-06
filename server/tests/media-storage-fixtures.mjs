// Test-only contract evidence, NEVER imported by an application/native worker.
// No claim of actual ClamAV/FFmpeg execution. Native proof is tested separately.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { LocalClamAvClient } from '../clamav-client.mjs';
import { MediaPreparation } from '../media-preparation.mjs';
import { RepositoryError } from '../errors.mjs';
import { fakePreparation,reportFor } from './media-preparation-fixtures.mjs';
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };
const manifest = (file) => ({ type:file.type,size:file.size,sha256:file.sha256 });
export const scan = (file,verdict = 'clean') => ({ engine:'clamav',engineVersion:'1.4.6',databaseVersion:28150,
  databaseUpdatedAt:'2026-10-05T00:00:00.000Z',verdict,checkedBytes:file.size,sha256:file.sha256,mediaAcceptanceReady:false });
export { evidenceForManifest,sealFixture } from "../media-storage-test-evidence.mjs";
export function candidate(bytes,type = 'image/png') {
  const p = reportFor(bytes,type);
  return { status:'prepared',bytes:p.bytes,report:{ source:p.report.source,derivative:p.report.derivative,
    sourceScan:scan(p.report.source),derivativeScan:scan(p.report.derivative),preparation:p.report,mediaAcceptanceReady:false },mediaAcceptanceReady:false };
}
export class FixturePreparation extends MediaPreparation {
  constructor(work = async (bytes,file) => candidate(bytes,file.type)) {
    super({ scanner:new LocalClamAvClient({ endpoint:{ host:'127.0.0.1',port:65535 },approvedEngineVersions:['1.4.6'],daemonTimeZone:'UTC' }),
      preparer:fakePreparation().preparer });
    this.work = work;
  }
  async prepare(file,{ signal } = {}) {
    const source = await file.openSource({ signal }); let result;
    try { const bytes = await collect(source); result = await this.work(bytes,manifest(file),signal); signal?.throwIfAborted(); return result; }
    catch (error) { if (Buffer.isBuffer(result?.bytes)) result.bytes.fill(0); throw error; }
    finally { source.destroy(); }
  }
}
// Preserve old scanner-validation scenarios as deliberately synthetic input to
// the NEW strict storage boundary, without restoring a production scan-only path.
export function fromLegacyScanner(scanner) {
  return new FixturePreparation(async (bytes,file) => {
    const report = await scanner.inspect({ ...file,stream:Readable.from([bytes],{ objectMode:false }) });
    if (report?.policyVersion !== 'carebridge-media-v1' || !['clean','rejected'].includes(report?.verdict)) throw new RepositoryError('SCAN_INVALID');
    if (report.verdict === 'rejected') return { status:'rejected',stage:'source',source:file,sourceScan:scan(file,'rejected'),mediaAcceptanceReady:false };
    const result = candidate(bytes,file.type);
    result.report.preparation.sourceDecode.media = report.media;
    result.report.preparation.derivativeDecode.media = report.media;
    return result;
  });
}
