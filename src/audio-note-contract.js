// Synthetic audio-note contract shared by browser and server. These signatures
// are format hints, not a native decoder, malware scan or authenticity proof.
export const AUDIO_NOTE_MAX_BYTES = 20 * 1024 ** 2;
export const AUDIO_NOTE_TYPES = Object.freeze(['audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/webm']);
const extensions = Object.freeze({ m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm' });
const aliases = Object.freeze({ 'audio/x-m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg', 'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav' });
const invalid = () => { throw new TypeError('Invalid audio note data.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, keys) {
  if (!object(value) || Reflect.ownKeys(value).length !== keys.length || Reflect.ownKeys(value).some(key =>
    !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid();
}
function text(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || !value.isWellFormed() ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value)) invalid();
  return value.trim();
}
function list(value, limit) {
  if (!Array.isArray(value) || value.length > limit || Object.keys(value).length !== value.length) invalid();
  return value;
}
export function normalizeAudioNoteFile(value) {
  exact(value, ['filename', 'type']);
  const filename = text(value.filename, 255);
  if (/[\x00-\x1f\x7f/\\]/.test(filename)) invalid();
  const extension = filename.split('.').pop().toLowerCase();
  if (!filename.includes('.') || !Object.hasOwn(extensions, extension) || typeof value.type !== 'string') invalid();
  const declared = value.type.trim().toLowerCase();
  const type = declared === '' ? extensions[extension] : (aliases[declared] ?? declared);
  if (type !== extensions[extension]) invalid();
  return { filename, type };
}
export function matchesAudioNoteSignature(type, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return false;
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (type === 'audio/mp4') return ascii(4, 8) === 'ftyp';
  if (type === 'audio/mpeg') return ascii(0, 3) === 'ID3' ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08 &&
      (bytes[1] & 0x06) !== 0 && (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0x0c) !== 0x0c);
  if (type === 'audio/wav') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  return type === 'audio/webm' && [0x1a, 0x45, 0xdf, 0xa3].every((byte, index) => bytes[index] === byte);
}
export function validateAudioAnalysisResult(value) {
  exact(value, ['transcript', 'analysis']);
  exact(value.transcript, ['text', 'durationSeconds', 'segments']);
  const duration = value.transcript.durationSeconds;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 7200) invalid();
  const transcriptText = text(value.transcript.text, 60000);
  let previousStart = -1, segmentCharacters = 0;
  const segments = list(value.transcript.segments, 1500).map((segment, index) => {
    exact(segment, ['id', 'start', 'end', 'text']);
    if (segment.id !== index || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) ||
        segment.start < 0 || segment.start < previousStart || segment.end <= segment.start || segment.end > duration) invalid();
    previousStart = segment.start;
    const content = text(segment.text, 4000); segmentCharacters += content.length;
    if (segmentCharacters > 60000) invalid();
    return { id: index, start: segment.start, end: segment.end, text: content };
  });
  if (!segments.length) invalid();
  const fields = ['performed', 'response', 'reflection', 'nextPlan', 'summary'];
  exact(value.analysis, [...fields, 'warnings']);
  const analysis = {};
  for (const field of fields) {
    analysis[field] = list(value.analysis[field], 6).map(claim => {
      exact(claim, ['text', 'segmentIds']);
      const references = list(claim.segmentIds, 8);
      if (!references.length || new Set(references).size !== references.length ||
          references.some(id => !Number.isSafeInteger(id) || id < 0 || id >= segments.length)) invalid();
      return { text: text(claim.text, field === 'summary' ? 200 : 300), segmentIds: [...references] };
    });
    if (analysis[field].map(claim => claim.text).join('\n').length > (field === 'summary' ? 1200 : 2000)) invalid();
  }
  analysis.warnings = list(value.analysis.warnings, 8).map(warning => text(warning, 200));
  const internal = [...analysis.reflection.map(claim => claim.text), ...analysis.warnings].join('\n');
  if (internal.length > 2000) invalid();
  return { transcript: { text: transcriptText, durationSeconds: duration, segments }, analysis };
}
export function audioNoteFields(value) {
  const { analysis } = validateAudioAnalysisResult(value);
  const join = field => analysis[field].map(claim => claim.text).join('\n');
  return { performed: join('performed'), response: join('response'), nextPlan: join('nextPlan'), summary: join('summary'),
    privateNote: [...analysis.reflection.map(claim => claim.text), ...analysis.warnings].join('\n') };
}
