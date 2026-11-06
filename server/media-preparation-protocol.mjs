import { createHash } from 'node:crypto';
import { decoderJobManifest,decoderJobReport,DECODER_JOB_PROTOCOL,JOB_HEADER_LIMIT,jobIdValid } from './decoder-job-protocol.mjs';
import { fail } from './errors.mjs';
import { IMAGE_METADATA_POLICY,VIDEO_METADATA_POLICY,ICC_PROFILE_POLICY,PREPARATION_PROTOCOL,PREPARATION_REPORT_LIMIT,PREPARATION_OUTPUT_LIMIT } from './media-preparation-policy.mjs';
export { PREPARATION_PROTOCOL,PREPARATION_REPORT_LIMIT,PREPARATION_OUTPUT_LIMIT };
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value,key));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const unavailable = () => fail('SCAN_UNAVAILABLE');
function framed(value,limit) {
  const json = Buffer.from(JSON.stringify(value)); if (!json.length || json.length > limit) unavailable();
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(json.length); return Buffer.concat([prefix,json]);
}
function json(bytes,limit) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limit) unavailable();
  let text,value; try { text = new TextDecoder('utf-8',{ fatal:true }).decode(bytes); value = JSON.parse(text); } catch { unavailable(); }
  // The fixed worker serializes canonical JSON. Reject duplicate keys, extra
  // records and alternate encodings rather than normalizing attacker output.
  if (JSON.stringify(value) !== text) unavailable(); return value;
}
export function preparationJobHeader(id,file) {
  if (!jobIdValid(id)) fail('SCAN_INVALID');
  return framed({ protocol:PREPARATION_PROTOCOL,id,...decoderJobManifest(file) },JOB_HEADER_LIMIT);
}
export function parsePreparationJobHeader(bytes) {
  let value; try { value = json(bytes,JOB_HEADER_LIMIT); } catch { fail('SCAN_INVALID'); }
  if (!exact(value,['protocol','id','type','size','sha256']) || value.protocol !== PREPARATION_PROTOCOL || !jobIdValid(value.id)) fail('SCAN_INVALID');
  return Object.freeze({ id:value.id,...decoderJobManifest({ type:value.type,size:value.size,sha256:value.sha256 }) });
}
function decodeProof(value,id,file) {
  return decoderJobReport(JSON.stringify({ protocol:DECODER_JOB_PROTOCOL,id,report:value }),id,file,0);
}
export function validatePreparationReport(report,id,file) {
  try { file = decoderJobManifest(file); } catch { unavailable(); }
  if (!jobIdValid(id) || !exact(report,['source','derivative','sourceDecode','derivativeDecode','sourceTimelineSha256','derivativeTimelineSha256','metadata','mediaAcceptanceReady']) ||
      report.mediaAcceptanceReady !== false || !sha(report.sourceTimelineSha256) || report.sourceTimelineSha256 !== report.derivativeTimelineSha256) unavailable();
  let source,derivative; try { source = decoderJobManifest(report.source); derivative = decoderJobManifest(report.derivative); } catch { unavailable(); }
  if (JSON.stringify(source) !== JSON.stringify(file) || derivative.type !== source.type) unavailable();
  const sourceDecode = decodeProof(report.sourceDecode,id,source),derivativeDecode = decodeProof(report.derivativeDecode,id,derivative);
  if (JSON.stringify(sourceDecode.media) !== JSON.stringify(derivativeDecode.media) ||
      sourceDecode.decodedVideoFrames !== derivativeDecode.decodedVideoFrames || sourceDecode.decodedAudioFrames !== derivativeDecode.decodedAudioFrames) unavailable();
  const metadata = report.metadata,image = file.type.startsWith('image/');
  if (image) {
    if (!exact(metadata,['policyVersion','orientation','containerFrames','iccProfilePolicy']) || metadata.policyVersion !== IMAGE_METADATA_POLICY ||
        !Number.isSafeInteger(metadata.orientation) || metadata.orientation < 1 || metadata.orientation > 8 ||
        metadata.containerFrames !== sourceDecode.decodedVideoFrames ||
        metadata.iccProfilePolicy !== null && metadata.iccProfilePolicy !== ICC_PROFILE_POLICY) unavailable();
  } else if (!exact(metadata,['policyVersion','containerMediaUnits','codedPayloadSha256','displayStateSha256']) || metadata.policyVersion !== VIDEO_METADATA_POLICY ||
      !Number.isSafeInteger(metadata.containerMediaUnits) || metadata.containerMediaUnits < 1 || metadata.containerMediaUnits > 200000 ||
      !sha(metadata.codedPayloadSha256) || !sha(metadata.displayStateSha256) || source.size !== derivative.size) unavailable();
  return { source,derivative,sourceDecode,derivativeDecode,sourceTimelineSha256:report.sourceTimelineSha256,
    derivativeTimelineSha256:report.derivativeTimelineSha256,metadata:{ ...metadata },mediaAcceptanceReady:false };
}
export function preparationJobOutput(id,report,bytes) {
  const checked = validatePreparationReport(report,id,report?.source);
  if (!Buffer.isBuffer(bytes) || bytes.length !== checked.derivative.size || digest(bytes) !== checked.derivative.sha256) unavailable();
  return Buffer.concat([framed({ protocol:PREPARATION_PROTOCOL,id,report:checked },PREPARATION_REPORT_LIMIT),bytes]);
}
export function preparationJobError(id,code) {
  if (!jobIdValid(id) || !['SCAN_INVALID','SCAN_UNAVAILABLE'].includes(code)) unavailable();
  return framed({ protocol:PREPARATION_PROTOCOL,id,error:code },PREPARATION_REPORT_LIMIT);
}
export function preparationJobReport(output,id,file,exitCode) {
  if (!Buffer.isBuffer(output) || output.length < 5 || output.length > PREPARATION_OUTPUT_LIMIT || !jobIdValid(id) ||
      !Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) unavailable();
  const length = output.readUInt32BE(); if (length < 1 || length > PREPARATION_REPORT_LIMIT || length+4 > output.length) unavailable();
  const value = json(output.subarray(4,length+4),PREPARATION_REPORT_LIMIT);
  if (value?.protocol !== PREPARATION_PROTOCOL || value.id !== id) unavailable();
  if (Object.hasOwn(value,'error')) {
    if (!exact(value,['protocol','id','error']) || exitCode === 0 || output.length !== length+4 || !['SCAN_INVALID','SCAN_UNAVAILABLE'].includes(value.error)) unavailable();
    fail(value.error);
  }
  if (!exact(value,['protocol','id','report']) || exitCode !== 0) unavailable();
  const report = validatePreparationReport(value.report,id,file),bytes = output.subarray(length+4);
  if (bytes.length !== report.derivative.size || digest(bytes) !== report.derivative.sha256) unavailable();
  // Caller-owned candidate. Never hand out a view into a transport buffer.
  const owned = Buffer.alloc(bytes.length); bytes.copy(owned); return { bytes:owned,report };
}
