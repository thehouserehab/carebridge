// One stdin payload, one process/container. No filename, URL, actor or DB access.
import { Readable } from 'node:stream';
import { LinuxMediaDecoder } from './media-decoder.mjs';
import { DECODER_JOB_PROTOCOL,JOB_HEADER_LIMIT,parseDecoderJobHeader } from './decoder-job-protocol.mjs';
import { PREPARATION_PROTOCOL,parsePreparationJobHeader,preparationJobOutput,preparationJobError } from './media-preparation-protocol.mjs';
import { prepareDecodedMedia } from './media-preparation-worker.mjs';
// Explicitly reviewed 9.0.2 signed-source decoder-only artifact (fd protocol,
// no encoders/network/file/pipe). Never approve an installed binary by hashing
// it at startup. A changed build requires a separate configuration review.
const approvedBinarySha256 = '4ef9928dcf1137bba3f36e4c9e78259d28a6213d1bb7b3d8b341bd6a60230aef';
let id = null,completed = false,protocol = DECODER_JOB_PROTOCOL,candidate,output;
const capture = () => {}; process.stdin.on('error',capture); process.stdout.on('error',capture);
const controller = new AbortController();
const headerTimer = setTimeout(() => { controller.abort(); process.stdin.destroy(); },5000);
// PID 1 exits even if the protocol/decoder stops making progress. The container
// runtime then ends its namespace; this does not replace the host's stop check.
const lifetime = setTimeout(() => process.kill(process.pid,'SIGKILL'),110000);
try {
  const iterator = process.stdin[Symbol.asyncIterator](); let header = Buffer.alloc(0),length = null,remainder;
  while (true) {
    const next = await iterator.next(); if (next.done || !(next.value instanceof Uint8Array) || controller.signal.aborted) throw new Error('INVALID');
    const bytes = Buffer.from(next.value); let at = 0;
    if (length === null) {
      const needed = 4-header.length; header = Buffer.concat([header,bytes.subarray(0,needed)]); at = Math.min(needed,bytes.length);
      if (header.length < 4) continue;
      length = header.readUInt32BE(); if (length < 1 || length > JOB_HEADER_LIMIT) throw new Error('INVALID'); header = Buffer.alloc(0);
    }
    const needed = length-header.length; header = Buffer.concat([header,bytes.subarray(at,at+needed)]); at += Math.min(needed,bytes.length-at);
    if (header.length < length) continue;
    const envelope = JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(header));
    const preparation = envelope.protocol === PREPARATION_PROTOCOL;
    const manifest = preparation ? parsePreparationJobHeader(header) : parseDecoderJobHeader(header);
    protocol = preparation ? PREPARATION_PROTOCOL : DECODER_JOB_PROTOCOL;
    id = manifest.id; remainder = bytes.subarray(at); clearTimeout(headerTimer);
    const stream = Readable.from((async function* () {
      try {
        if (remainder.length) yield remainder;
        while (true) { const part = await iterator.next(); if (part.done) break; yield part.value; }
      } finally { await iterator.return?.(); }
    })(),{ objectMode:false });
    const decoder = new LinuxMediaDecoder({ approvedBinarySha256 });
    const file = { stream,type:manifest.type,size:manifest.size,sha256:manifest.sha256 };
    if (preparation) {
      const prepared = await prepareDecodedMedia(file,decoder,id,{ signal:controller.signal }); candidate = prepared.bytes;
      output = preparationJobOutput(id,prepared.report,candidate);
    } else {
      const report = await decoder.decode(file,{ signal:controller.signal });
      output = Buffer.from(JSON.stringify({ protocol:DECODER_JOB_PROTOCOL,id,report })+'\n');
    }
    await new Promise((resolve,reject) => process.stdout.write(output,(error) => error ? reject(error) : resolve()));
    completed = true; break;
  }
} catch (error) {
  if (id) {
    const code = error?.code === 'SCAN_INVALID' ? 'SCAN_INVALID' : 'SCAN_UNAVAILABLE';
    process.stdout.write(protocol === PREPARATION_PROTOCOL ? preparationJobError(id,code) : JSON.stringify({ protocol:DECODER_JOB_PROTOCOL,id,error:code })+'\n');
  }
  process.exitCode = 1;
} finally {
  clearTimeout(headerTimer); clearTimeout(lifetime); process.stdin.destroy();
  candidate?.fill(0); output?.fill(0);
  if (!completed) process.exitCode = 1;
}
