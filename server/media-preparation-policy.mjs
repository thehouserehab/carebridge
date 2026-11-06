import { MEDIA_LIMITS } from '../src/media-policy.js';
// Shared immutable policy identifiers; no parsers, launchers or IO here.
export const IMAGE_METADATA_POLICY = 'carebridge-image-metadata-v2';
export const VIDEO_METADATA_POLICY = 'carebridge-video-metadata-v1';
export const ICC_PROFILE_POLICY = 'carebridge-icc-matrix-trc-v1';
export const PREPARATION_PROTOCOL = 'carebridge-media-preparation-v1';
export const PREPARATION_REPORT_LIMIT = 8192;
export const PREPARATION_OUTPUT_LIMIT = MEDIA_LIMITS.video+PREPARATION_REPORT_LIMIT+4;
