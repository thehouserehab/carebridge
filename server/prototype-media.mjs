// Fictional presentation fixture ONLY. This module never accepts an arbitrary
// image/video and never claims that ClamAV or a native decoder ran. The real
// upload, binding, private storage and access services are exercised with two
// fixed, self-generated assets. Normal/local/native launchers do not import it.
import { createHash } from 'node:crypto';
import { createOwnedSyntheticMedia } from './local-synthetic-media.mjs';
import { prototypeMediaFiles } from './prototype-media-assets.mjs';
import { MediaPreparation } from './media-preparation.mjs';
import { MediaUploads } from './media-uploads.mjs';
import { MediaAccess } from './media-access.mjs';
import { LocalClamAvClient } from './clamav-client.mjs';
import { IsolatedMediaDecoder } from './decoder-jobs.mjs';
import { prepareImageDerivative } from './image-metadata.mjs';
import { prepareVideoDerivative } from './video-metadata.mjs';
import { DECODER_VERSION } from './media-decoder-policy.mjs';
import { fail } from './errors.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = (bytes, type) => ({ type, size: bytes.length, sha256: hash(bytes) });
const samples = prototypeMediaFiles();
const known = file => samples.find(sample => sample.type === file?.type && sample.bytes.length === file.size && sample.sha256 === file.sha256);
const disabled = async () => { throw new Error('Prototype cannot invoke a worker.'); };

class KnownSamplePreparation extends MediaPreparation {
  constructor() {
    // Inert dependencies satisfy the existing service's constructor contract;
    // the overridden prepare has no external transport and only fixed samples.
    super({ scanner: new LocalClamAvClient({ endpoint: { host: '127.0.0.1', port: 65535 }, approvedEngineVersions: ['0.0.0'], daemonTimeZone: 'UTC' }),
      preparer: new IsolatedMediaDecoder({ runtime: { docker: disabled, inspect: disabled, exchange: disabled, identity: disabled },
        approvedImageId: 'sha256:' + '0'.repeat(64), engineIdentity: 'prototype-fixed-samples-only' }) });
  }
  async prepare(file, { signal } = {}) {
    const sample = known(file);
    if (!sample) fail('FORMAT_MISMATCH');
    signal?.throwIfAborted();
    const stream = await file.openSource({ signal });
    const chunks = []; let count = 0, sourceBytes;
    try {
      for await (const chunk of stream) {
        count += chunk.length;
        if (count > sample.bytes.length) fail('SIZE_MISMATCH');
        chunks.push(chunk);
      }
      sourceBytes = Buffer.concat(chunks);
      if (sourceBytes.length !== sample.bytes.length || hash(sourceBytes) !== sample.sha256) fail('HASH_MISMATCH');
      signal?.throwIfAborted();
      const image = file.type === 'image/png';
      const prepared = (image ? prepareImageDerivative : prepareVideoDerivative)(sourceBytes, file.type);
      const source = manifest(sourceBytes, file.type), derivative = manifest(prepared.bytes, file.type);
      // Simulated inspection evidence for the demo's memory DB. The decoder
      // schema requires its current version; this is NOT an executed decoder.
      const scan = value => ({ engine: 'clamav', engineVersion: '0.0.0', databaseVersion: 1,
        databaseUpdatedAt: '2000-01-01T00:00:00.000Z', verdict: 'clean', checkedBytes: value.size,
        sha256: value.sha256, mediaAcceptanceReady: false });
      const decode = value => ({ engine: 'ffmpeg', engineVersion: DECODER_VERSION,
        media: { type: file.type, width: sample.width, height: sample.height, ...(image ? {} : { duration: sample.duration }) },
        decodedVideoFrames: image ? prepared.containerFrames : 4, decodedAudioFrames: 0,
        checkedBytes: value.size, sha256: value.sha256, mediaAcceptanceReady: false });
      const preparation = { source, derivative, sourceDecode: decode(source), derivativeDecode: decode(derivative),
        sourceTimelineSha256: sample.sha256, derivativeTimelineSha256: sample.sha256,
        metadata: image ? { policyVersion: prepared.policyVersion, orientation: prepared.orientation,
          containerFrames: prepared.containerFrames, iccProfilePolicy: prepared.iccProfilePolicy } : {
          policyVersion: prepared.policyVersion, containerMediaUnits: prepared.containerMediaUnits,
          codedPayloadSha256: prepared.codedPayloadSha256, displayStateSha256: prepared.displayStateSha256 }, mediaAcceptanceReady: false };
      return { status: 'prepared', bytes: prepared.bytes, report: { source, derivative,
        sourceScan: scan(source), derivativeScan: scan(derivative), preparation, mediaAcceptanceReady: false }, mediaAcceptanceReady: false };
    } finally {
      stream.destroy(); sourceBytes?.fill(0); for (const chunk of chunks) chunk.fill(0);
    }
  }
}

export async function createPrototypeMedia(database, centerId) {
  return createOwnedSyntheticMedia(database, centerId, async (db, store) => {
    const uploads = new MediaUploads(db, store, { preparation: new KnownSamplePreparation(),
      ttlMilliseconds: 3600000, leaseMilliseconds: 15000, operationTimeoutMilliseconds: 8000 });
    const mediaUploads = {
      async reserve(actor, input) {
        // Reject before accepting bytes or reserving resources. Renaming a real
        // file or declaring a different MIME does not grant demo admission.
        if (!known(input?.file)) fail('INVALID_INPUT');
        return uploads.reserve(actor, input);
      },
      get: (...args) => uploads.get(...args),
      getTransferState: (...args) => uploads.getTransferState(...args),
      open: (...args) => uploads.open(...args),
      cancel: (...args) => uploads.cancel(...args),
      async receive(actor, input, stream) {
        const result = await uploads.receive(actor, input, stream);
        if (result.state !== 'quarantined') return result;
        return uploads.inspect(actor, { conversationId: input.conversationId, uploadId: input.uploadId, expectedVersion: result.version });
      },
    };
    return { mediaUploads, mediaAccess: new MediaAccess(db, store), mediaCleanup: () => uploads.cleanup() };
  }, { storageBytes: 1024 * 1024 * 1024, pendingUploads: 8, uploadsPerWindow: 32, windowMilliseconds: 3600000 });
}
