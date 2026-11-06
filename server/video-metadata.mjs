import { createHash } from 'node:crypto';
import { MEDIA_LIMITS } from '../src/media-policy.js';
import { validateMediaContainer } from './media-container-validation.mjs';
import { rewriteMp4Metadata } from './mp4-metadata.mjs';
import { rewriteWebmMetadata } from './webm-metadata.mjs';
import { fail } from './errors.mjs';

import { VIDEO_METADATA_POLICY } from './media-preparation-policy.mjs';
export { VIDEO_METADATA_POLICY };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Trusted offline file-worker component. Byte-only input/output: no names,
// user IDs, arbitrary paths, URLs, storage writes or operating acceptance.
// Container text reduction is NOT anonymization: pixels/voices, codec private
// data and compressed payloads are unchanged. Scan and fully decode both
// manifests, compare all streams, then durably store before enabling sharing.
export function prepareVideoDerivative(bytes,type) {
  if (!Buffer.isBuffer(bytes) || !['video/mp4','video/webm'].includes(type) || !bytes.length || bytes.length > MEDIA_LIMITS.video) fail('SCAN_INVALID');
  validateMediaContainer(bytes,type);
  const prepared = (type === 'video/mp4' ? rewriteMp4Metadata : rewriteWebmMetadata)(bytes);
  if (prepared.bytes.length !== bytes.length) fail('SCAN_INVALID'); validateMediaContainer(prepared.bytes,type);
  return { ...prepared,policyVersion:VIDEO_METADATA_POLICY,type,
    source:{ size:bytes.length,sha256:hash(bytes) },derivative:{ size:prepared.bytes.length,sha256:hash(prepared.bytes) },
    mediaAcceptanceReady:false };
}
