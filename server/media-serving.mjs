import { decoderJobManifest } from './decoder-job-protocol.mjs';
import { fail } from './errors.mjs';

// All preview/download paths select the same immutable serving manifest.
// Only historical pre-013 approvals can still refer to their original bytes.
// A new upload NEVER falls back to the original when a derivative is missing.
export function servingFile(row) {
  if (!row || !['ready','bound'].includes(row.state)) fail('CONTENT_UNAVAILABLE');
  if (!row.preparation_id) {
    if (row.preparation_required !== false || row.candidate_key || row.prepared_size || row.prepared_sha256) fail('CONTENT_UNAVAILABLE');
    return { ...row };
  }
  try {
    const manifest = decoderJobManifest({ type:row.type,size:row.prepared_size,sha256:row.prepared_sha256 });
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.candidate_key ?? '') || row.candidate_key === row.object_key) fail('CONTENT_UNAVAILABLE');
    return { ...row,...manifest,object_key:row.candidate_key };
  } catch { fail('CONTENT_UNAVAILABLE'); }
}
