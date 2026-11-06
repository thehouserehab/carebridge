import { Readable } from 'node:stream';
import { MEDIA_TYPES,MEDIA_LIMITS } from '../src/media-policy.js';
import { DECODER_VERSION,DECODE_LIMITS } from './media-decoder-policy.mjs';
import { fail } from './errors.mjs';

export const DECODER_JOB_PROTOCOL = 'carebridge-decoder-job-v1';
export const JOB_HEADER_LIMIT = 1024;
export const JOB_OUTPUT_LIMIT = 4096;
export const jobIdValid = (id) => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value,key));
const invalid = () => fail('SCAN_INVALID');
export function decoderJobSource(file) {
  if (!exact(file,['stream','type','size','sha256']) || !(file.stream instanceof Readable) || file.stream.destroyed ||
      file.stream.readableEnded || file.stream.readableObjectMode || file.stream.readableEncoding) invalid();
  return decoderJobManifest({ type:file.type,size:file.size,sha256:file.sha256 });
}
export function decoderJobManifest(file) {
  if (!exact(file,['type','size','sha256']) || !MEDIA_TYPES.includes(file.type) || !Number.isSafeInteger(file.size) || file.size < 1 ||
      file.size > (file.type.startsWith('image/') ? MEDIA_LIMITS.image : MEDIA_LIMITS.video) ||
      typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) invalid();
  return Object.freeze({ type:file.type,size:file.size,sha256:file.sha256 });
}
export function decoderJobHeader(id,file) {
  if (!jobIdValid(id)) invalid();
  const body = Buffer.from(JSON.stringify({ protocol:DECODER_JOB_PROTOCOL,id,...decoderJobManifest(file) }));
  if (body.length > JOB_HEADER_LIMIT) invalid();
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length); return Buffer.concat([prefix,body]);
}
export function parseDecoderJobHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > JOB_HEADER_LIMIT) invalid();
  let value; try { value = JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(bytes)); } catch { invalid(); }
  if (!exact(value,['protocol','id','type','size','sha256']) || value.protocol !== DECODER_JOB_PROTOCOL || !jobIdValid(value.id)) invalid();
  return Object.freeze({ id:value.id,...decoderJobManifest({ type:value.type,size:value.size,sha256:value.sha256 }) });
}
export function decoderJobReport(output,id,file,exitCode) {
  try { file = decoderJobManifest(file); } catch { fail('SCAN_UNAVAILABLE'); }
  if (typeof output !== 'string' || Buffer.byteLength(output) > JOB_OUTPUT_LIMIT || !jobIdValid(id) ||
      !Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) fail('SCAN_UNAVAILABLE');
  let value; try { value = JSON.parse(output); } catch { fail('SCAN_UNAVAILABLE'); }
  if (value?.protocol !== DECODER_JOB_PROTOCOL || value.id !== id) fail('SCAN_UNAVAILABLE');
  if (Object.hasOwn(value,'error')) {
    if (!exact(value,['protocol','id','error']) || exitCode === 0 || !['SCAN_INVALID','SCAN_UNAVAILABLE'].includes(value.error)) fail('SCAN_UNAVAILABLE');
    fail(value.error);
  }
  if (exitCode !== 0 || !exact(value,['protocol','id','report'])) fail('SCAN_UNAVAILABLE');
  const report = value.report, media = report?.media;
  if (!exact(report,['engine','engineVersion','media','decodedVideoFrames','decodedAudioFrames','checkedBytes','sha256','mediaAcceptanceReady']) ||
      report.engine !== 'ffmpeg' || report.engineVersion !== DECODER_VERSION || report.mediaAcceptanceReady !== false ||
      report.checkedBytes !== file.size || report.sha256 !== file.sha256 ||
      ![report.decodedVideoFrames,report.decodedAudioFrames].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      report.decodedVideoFrames < 1 || report.decodedVideoFrames+report.decodedAudioFrames > DECODE_LIMITS.frames ||
      !exact(media,file.type.startsWith('video/') ? ['type','width','height','duration'] : ['type','width','height']) || media.type !== file.type ||
      ![media.width,media.height].every((n) => Number.isSafeInteger(n) && n >= 1 && n <= DECODE_LIMITS.dimension) ||
      media.width*media.height > DECODE_LIMITS.pixels ||
      media.width*media.height*report.decodedVideoFrames > DECODE_LIMITS.decodedPixels ||
      (file.type.startsWith('image/') && report.decodedAudioFrames !== 0) ||
      (file.type.startsWith('video/') && (!Number.isFinite(media.duration) || media.duration <= 0 || media.duration > DECODE_LIMITS.duration))) fail('SCAN_UNAVAILABLE');
  return { ...report,media:{ ...media } }; // Internal decode evidence only, never an upload verdict.
}
