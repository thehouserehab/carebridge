// Explicit synthetic SQL evidence ONLY; no byte, decoder, malware or clinical proof.
import { randomUUID } from "node:crypto";
const scan = (file) => ({ engine:"clamav",engineVersion:"1.4.6",databaseVersion:28150,databaseUpdatedAt:"2026-10-05T00:00:00.000Z",verdict:"clean",checkedBytes:file.size,sha256:file.sha256,mediaAcceptanceReady:false });
// SQL-budget fixtures only: these declarations deliberately prove NO byte IO.
export function evidenceForManifest(source,derivative = source) {
  const proof = (file) => ({ engine:'ffmpeg',engineVersion:'9.0.2',media:{ type:file.type,width:1,height:1,...(file.type.startsWith('video/') ? { duration:1 } : {}) },
    decodedVideoFrames:1,decodedAudioFrames:0,checkedBytes:file.size,sha256:file.sha256,mediaAcceptanceReady:false });
  const preparation = { source,derivative,sourceDecode:proof(source),derivativeDecode:proof(derivative),sourceTimelineSha256:'c'.repeat(64),derivativeTimelineSha256:'c'.repeat(64),
    metadata:source.type.startsWith('video/') ? { policyVersion:'carebridge-video-metadata-v1',containerMediaUnits:1,codedPayloadSha256:'d'.repeat(64),displayStateSha256:'e'.repeat(64) } :
      { policyVersion:'carebridge-image-metadata-v2',orientation:1,containerFrames:1,iccProfilePolicy:null },mediaAcceptanceReady:false };
  return { source,derivative,sourceScan:scan(source),derivativeScan:scan(derivative),preparation,mediaAcceptanceReady:false };
}
export async function sealFixture(tx,row,evidence) {
  const id = randomUUID();
  await tx.query(`INSERT INTO cb_media_preparations
    (id,center_id,conversation_id,upload_id,upload_version,lease_id,source_key,derivative_key,type,source_size,derivative_size,source_sha256,derivative_sha256,evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,row.center_id,row.conversation_id,row.id,row.version,row.lease_id,row.object_key,row.candidate_key,
    row.type,row.size,evidence.derivative.size,row.sha256,evidence.derivative.sha256,JSON.stringify(evidence)]);
  const report = { verdict:'clean',engine:'clamav',engineVersion:'1.4.6',policyVersion:'carebridge-media-v1',media:evidence.preparation.derivativeDecode.media };
  return (await tx.query(`UPDATE cb_media_uploads SET version = version + 1,state = 'ready',lease_id = NULL,lease_until = NULL,
    scan_report = $2,preparation_id = $3,prepared_size = $4,prepared_sha256 = $5 WHERE id = $1 RETURNING *`,
  [row.id,JSON.stringify(report),id,evidence.derivative.size,evidence.derivative.sha256])).rows[0];
}
