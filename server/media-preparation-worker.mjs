// Called only by the fixed offline per-file worker. Never in a web service.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { decoderJobSource } from './decoder-job-protocol.mjs';
import { prepareImageDerivative } from './image-metadata.mjs';
import { prepareVideoDerivative } from './video-metadata.mjs';
import { validatePreparationReport } from './media-preparation-protocol.mjs';
import { RepositoryError,fail } from './errors.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const streamOf = (bytes) => Readable.from([bytes],{ objectMode:false });
export async function prepareDecodedMedia(file,decoder,id,{ signal } = {}) {
  const source = file?.stream; if (source instanceof Readable) void finished(source,{ cleanup:true }).catch(() => {});
  let original,candidate,canonical,success = false,registered = false;
  const abort = () => source?.destroy(new RepositoryError('SCAN_UNAVAILABLE'));
  try {
    const manifest = decoderJobSource(file);
    if (!decoder || typeof decoder.decode !== 'function' || !(signal instanceof AbortSignal)) fail('SCAN_UNAVAILABLE');
    signal.addEventListener('abort',abort,{ once:true }); registered = true;
    signal.throwIfAborted(); original = Buffer.alloc(manifest.size); let count = 0;
    for await (const chunk of source) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array) || count+chunk.length > original.length) fail('SCAN_INVALID');
      original.set(chunk,count); count += chunk.length;
    }
    if (count !== original.length || hash(original) !== manifest.sha256) fail('SCAN_INVALID');
    const decodedSource = await decoder.decode({ ...manifest,stream:streamOf(original) },{ signal,timelineEvidence:true });
    signal.throwIfAborted();
    // Never repair, sanitize or hide an original decoder warning. Source
    // decoding must have succeeded before any transformation is attempted.
    if (hash(original) !== manifest.sha256) fail('SCAN_INVALID');
    const transform = manifest.type.startsWith('image/') ? prepareImageDerivative : prepareVideoDerivative;
    const prepared = transform(original,manifest.type);
    candidate = prepared.bytes;
    if (candidate === original || hash(original) !== manifest.sha256) fail('SCAN_INVALID');
    const repeated = transform(candidate,manifest.type); canonical = repeated.bytes;
    if (!canonical.equals(candidate) || ['orientation','containerFrames','iccProfilePolicy','containerMediaUnits','codedPayloadSha256','displayStateSha256']
      .some((key) => repeated[key] !== prepared[key])) fail('SCAN_INVALID');
    canonical.fill(0); canonical = undefined;
    const derivative = { type:manifest.type,...prepared.derivative };
    const decodedDerivative = await decoder.decode({ ...derivative,stream:streamOf(candidate) },{ signal,timelineEvidence:true });
    signal.throwIfAborted();
    const { timelineSha256:sourceTimelineSha256,...sourceDecode } = decodedSource;
    const { timelineSha256:derivativeTimelineSha256,...derivativeDecode } = decodedDerivative;
    const metadata = manifest.type.startsWith('image/') ? {
      policyVersion:prepared.policyVersion,orientation:prepared.orientation,containerFrames:prepared.containerFrames,iccProfilePolicy:prepared.iccProfilePolicy,
    } : { policyVersion:prepared.policyVersion,containerMediaUnits:prepared.containerMediaUnits,
      codedPayloadSha256:prepared.codedPayloadSha256,displayStateSha256:prepared.displayStateSha256 };
    const report = validatePreparationReport({ source:manifest,derivative,sourceDecode,derivativeDecode,sourceTimelineSha256,
      derivativeTimelineSha256,metadata,mediaAcceptanceReady:false },id,manifest);
    if (hash(candidate) !== derivative.sha256) fail('SCAN_INVALID');
    success = true; return { bytes:candidate,report };
  } catch (error) {
    // IO/probe/parser exceptions, stack traces and AbortSignal reasons must
    // not cross the byte-only worker boundary.
    fail(error instanceof RepositoryError && error.code === 'SCAN_INVALID' ? 'SCAN_INVALID' : 'SCAN_UNAVAILABLE');
  } finally {
    if (registered) signal.removeEventListener('abort',abort);
    source?.destroy(); original?.fill(0); canonical?.fill(0); if (!success) candidate?.fill(0);
  }
}
