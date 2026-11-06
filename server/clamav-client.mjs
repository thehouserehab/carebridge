import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { MEDIA_LIMITS, MEDIA_TYPES } from '../src/media-policy.js';
import { fail, RepositoryError } from './errors.mjs';

const MAX_REPLY_BYTES = 4096;
const CHUNK_BYTES = 64 * 1024;
const MAX_DATABASE_AGE = 48 * 60 * 60 * 1000;
const CLOCK_SKEW = 5 * 60 * 1000;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEKDAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const engineVersionValid = (value) => typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
const unavailable = () => new RepositoryError('SCAN_UNAVAILABLE');

function configuration(options) {
  const { endpoint, approvedEngineVersions, daemonTimeZone,
    timeoutMilliseconds = 90000, connectTimeoutMilliseconds = 2000,
    maxDatabaseAgeMilliseconds = MAX_DATABASE_AGE, maxConcurrent = 2, now = Date.now } = options ?? {};
  // No DNS, arbitrary URL, remote address, named pipe, or request-selected host.
  if (!endpoint || Object.keys(endpoint).some((key) => !['host','port'].includes(key)) ||
      !['127.0.0.1','::1'].includes(endpoint.host) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535)
    throw new TypeError('An explicit loopback ClamAV endpoint is required.');
  if (!Array.isArray(approvedEngineVersions) || !approvedEngineVersions.length || approvedEngineVersions.length > 8 ||
      approvedEngineVersions.some((version) => !engineVersionValid(version)))
    throw new TypeError('Explicitly approved ClamAV release versions are required.');
  // VERSION uses ctime without a timezone. The operator MUST configure the
  // daemon process with TZ=UTC; this protocol cannot attest that configuration.
  if (daemonTimeZone !== 'UTC') throw new TypeError('The daemon must be configured and declared as UTC.');
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 50 || timeoutMilliseconds > 120000 ||
      !Number.isInteger(connectTimeoutMilliseconds) || connectTimeoutMilliseconds < 50 ||
      connectTimeoutMilliseconds > Math.min(5000,timeoutMilliseconds) ||
      !Number.isInteger(maxDatabaseAgeMilliseconds) || maxDatabaseAgeMilliseconds < 3600000 || maxDatabaseAgeMilliseconds > MAX_DATABASE_AGE ||
      !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4 || typeof now !== 'function')
    throw new TypeError('Invalid ClamAV operation limits.');
  return Object.freeze({ endpoint:Object.freeze({ host:endpoint.host,port:endpoint.port }),
    approvedEngineVersions:Object.freeze([...new Set(approvedEngineVersions)]),
    timeoutMilliseconds,connectTimeoutMilliseconds,maxDatabaseAgeMilliseconds,maxConcurrent,now });
}

function versionReport(reply, config) {
  const match = /^ClamAV (\d{1,3}\.\d{1,3}\.\d{1,3})\/([1-9]\d{0,9})\/(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]|0[1-9]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(reply);
  if (!match || !config.approvedEngineVersions.includes(match[1])) fail('SCAN_UNAVAILABLE');
  const [,engineVersion,databaseVersion,weekday,month,day,hour,minute,second,year] = match;
  const milliseconds = Date.UTC(Number(year),MONTHS.indexOf(month),Number(day),Number(hour),Number(minute),Number(second));
  const date = new Date(milliseconds), current = config.now();
  if (Number(databaseVersion) > 4294967295 || Number(year) < 2000 || date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== MONTHS.indexOf(month) ||
      date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute) ||
      date.getUTCSeconds() !== Number(second) || WEEKDAYS[date.getUTCDay()] !== weekday ||
      !Number.isFinite(current) || milliseconds > current + CLOCK_SKEW || current - milliseconds > config.maxDatabaseAgeMilliseconds)
    fail('SCAN_UNAVAILABLE');
  return { engine:'clamav',engineVersion,databaseVersion:Number(databaseVersion),databaseUpdatedAt:date.toISOString() };
}

function scanInput(file) {
  if (!file || Object.keys(file).some((key) => !['stream','type','size','sha256'].includes(key)) ||
      !(file.stream instanceof Readable) || file.stream.readableObjectMode || file.stream.readableEncoding ||
      file.stream.destroyed || file.stream.readableEnded || !MEDIA_TYPES.includes(file.type) ||
      !Number.isSafeInteger(file.size) || file.size < 1 ||
      file.size > (file.type.startsWith('image/') ? MEDIA_LIMITS.image : MEDIA_LIMITS.video) ||
      typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('SCAN_INVALID');
}

// One command per connection, bounded NUL-framed reply, and EOF required.
// A terminator alone is NOT enough: a second/delayed record must fail closed.
function exchange(config, command, signal, file = null) {
  return new Promise((resolve,reject) => {
    const socket = new Socket();
    let complete = false, inputComplete = !file, commandSent = false, ended = false, total = 0;
    const replies = [];
    let resolveConnection, rejectConnection;
    const connected = new Promise((yes,no) => { resolveConnection = yes; rejectConnection = no; });
    const onAbort = () => finish(unavailable());
    const connectionTimer = setTimeout(onAbort,config.connectTimeoutMilliseconds);
    function finish(error, reply) {
      if (complete) return;
      complete = true;
      clearTimeout(connectionTimer);
      signal.removeEventListener('abort',onAbort);
      socket.destroy();
      if (error) {
        file?.stream.destroy();
        rejectConnection(error);
        reject(error);
      } else resolve(reply);
    }
    socket.once('connect',() => { clearTimeout(connectionTimer); resolveConnection(); });
    socket.on('error',() => finish(unavailable()));
    socket.on('data',(chunk) => {
      if (complete) return;
      total += chunk.length;
      if (!commandSent || !inputComplete || total > MAX_REPLY_BYTES) return finish(unavailable());
      replies.push(chunk);
    });
    socket.once('end',() => {
      ended = true;
      if (complete) return;
      const bytes = Buffer.concat(replies,total);
      // Strict printable ASCII plus exactly one final NUL. Never return raw
      // daemon text, filenames, detection names, or transport errors publicly.
      if (!commandSent || !inputComplete || bytes.length < 2 || bytes.at(-1) !== 0 ||
          bytes.subarray(0,-1).some((byte) => byte < 32 || byte > 126)) return finish(unavailable());
      finish(null,bytes.subarray(0,-1).toString('ascii'));
    });
    socket.once('close',() => { if (!ended) finish(unavailable()); });
    signal.addEventListener('abort',onAbort,{ once:true });
    if (signal.aborted) { onAbort(); connected.catch(() => {}); return; }
    // Awaiting each write callback bounds the queued bytes independently of
    // daemon read speed. Incoming replies are drained concurrently.
    const write = (bytes) => new Promise((yes,no) => {
      if (complete || signal.aborted || socket.destroyed) return no(unavailable());
      socket.write(bytes,(error) => error ? no(unavailable()) : yes());
    });
    (async () => {
      await connected;
      commandSent = true;
      await write(Buffer.from(`z${command}\0`,'ascii'));
      if (!file) return;
      let count = 0;
      const hash = createHash('sha256');
      for await (const chunk of file.stream) {
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail('SCAN_INVALID');
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer,chunk.byteOffset,chunk.byteLength);
        if (count + bytes.length > file.size) fail('SCAN_INVALID');
        count += bytes.length;
        for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
          // Own each bounded frame while awaiting transport IO. A producer
          // cannot mutate a borrowed buffer after it has been hashed.
          const slice = Buffer.from(bytes.subarray(start,start + CHUNK_BYTES)), prefix = Buffer.alloc(4);
          hash.update(slice);
          prefix.writeUInt32BE(slice.length);
          await write(prefix);
          await write(slice);
        }
      }
      if (count !== file.size || hash.digest('hex') !== file.sha256) fail('SCAN_INVALID');
      if (complete || signal.aborted) throw unavailable();
      // Only after exact bytes, hash, and source EOF may the end marker be sent.
      // Set before write so a fast valid reply cannot race its callback.
      inputComplete = true;
      await write(Buffer.alloc(4));
    })().catch((error) => finish(error instanceof RepositoryError && error.code === 'SCAN_INVALID' ? error : unavailable()));
    try { socket.connect(config.endpoint); } catch { finish(unavailable()); }
  });
}

// Internal anti-malware client ONLY. There is intentionally no inspect() and
// no default integration with MediaUploads: decoding is a separate prerequisite.
export class LocalClamAvClient {
  #config;
  #active = 0;
  constructor(options) { this.#config = configuration(options); }

  async #operation(work, signal, stream = null) {
    if ((signal !== undefined && !(signal instanceof AbortSignal)) || signal?.aborted || this.#active >= this.#config.maxConcurrent)
      fail('SCAN_UNAVAILABLE');
    this.#active += 1;
    const controller = new AbortController();
    const abort = () => { controller.abort(); stream?.destroy(); };
    const timer = setTimeout(abort,this.#config.timeoutMilliseconds);
    signal?.addEventListener('abort',abort,{ once:true });
    let rejectAbort;
    const interrupted = new Promise((yes,no) => { rejectAbort = () => no(unavailable()); });
    controller.signal.addEventListener('abort',rejectAbort,{ once:true });
    try {
      return await Promise.race([work(controller.signal),interrupted]);
    } catch (error) {
      throw error instanceof RepositoryError && error.code === 'SCAN_INVALID' ? error : unavailable();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      controller.signal.removeEventListener('abort',rejectAbort);
      controller.abort();
      this.#active -= 1;
    }
  }

  async #status(signal) {
    if (await exchange(this.#config,'PING',signal) !== 'PONG') fail('SCAN_UNAVAILABLE');
    const reply = await exchange(this.#config,'VERSIONCOMMANDS',signal);
    const sections = reply.split('| COMMANDS: ');
    if (sections.length !== 2 || !/^[A-Z]+(?: [A-Z]+)*$/.test(sections[1])) fail('SCAN_UNAVAILABLE');
    const commands = new Set(sections[1].split(' '));
    if (!['PING','VERSION','INSTREAM'].every((command) => commands.has(command))) fail('SCAN_UNAVAILABLE');
    return versionReport(sections[0],this.#config);
  }

  async status({ signal } = {}) {
    const status = await this.#operation((internal) => this.#status(internal),signal);
    return { ...status,available:true,mediaAcceptanceReady:false };
  }

  async scan(file, { signal } = {}) {
    const stream = file?.stream instanceof Readable ? file.stream : null;
    // Keep stream errors handled even during preflight, before its iterator is
    // installed. The underlying stream is server-owned, not arbitrary user code.
    let streamError = false;
    const capture = () => { streamError = true; };
    stream?.on('error',capture);
    try {
      scanInput(file);
      return await this.#operation(async (internal) => {
        const before = await this.#status(internal);
        if (streamError || stream.errored) fail('SCAN_UNAVAILABLE');
        const reply = await exchange(this.#config,'INSTREAM',internal,file);
        let verdict;
        if (reply === 'stream: OK') verdict = 'clean';
        else if (/^stream: [\x20-\x7e]+ FOUND$/.test(reply)) verdict = 'rejected';
        else fail('SCAN_UNAVAILABLE');
        const after = versionReport(await exchange(this.#config,'VERSION',internal),this.#config);
        if (streamError || JSON.stringify(before) !== JSON.stringify(after)) fail('SCAN_UNAVAILABLE');
        return { ...after,verdict,checkedBytes:file.size,sha256:file.sha256,mediaAcceptanceReady:false };
      },signal,stream);
    } finally {
      stream?.destroy();
      if (stream?.closed) stream.removeListener('error',capture);
      else stream?.once('close',() => stream.removeListener('error',capture));
    }
  }
}
