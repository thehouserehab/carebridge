import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

export const ICC_PROFILE_LIMIT = 1024*1024;
import { ICC_PROFILE_POLICY } from './media-preparation-policy.mjs';
export { ICC_PROFILE_POLICY };
const TEXT_LIMIT = 65536;
const invalid = () => fail('SCAN_INVALID');
const unsupported = () => fail('SCAN_UNAVAILABLE');
const signature = (bytes,at = 0) => bytes.toString('latin1',at,at+4);
const aligned = (size) => Math.ceil(size/4)*4;
const zero = (bytes) => bytes.every((byte) => byte === 0);

function exact(bytes,size) {
  // Some older producers count up to three alignment bytes inside a tag.
  if (bytes.length < size || bytes.length > aligned(size) || !zero(bytes.subarray(size))) invalid();
  return bytes.subarray(0,size);
}
function utf16(bytes) {
  if (bytes.length%2) invalid();
  for (let at = 0; at < bytes.length; at += 2) {
    const value = bytes.readUInt16BE(at);
    if (value >= 0xd800 && value <= 0xdbff) {
      if (at+4 > bytes.length) invalid(); const low = bytes.readUInt16BE(at+2);
      if (low < 0xdc00 || low > 0xdfff) invalid(); at += 2;
    } else if (value >= 0xdc00 && value <= 0xdfff) invalid();
  }
}
function ascii(bytes) {
  if (!bytes.length || bytes.length > TEXT_LIMIT || bytes.at(-1) !== 0 || bytes.subarray(0,-1).some((n) => n === 0 || n > 127)) invalid();
}
function localized(records) {
  const table = Buffer.alloc(16+records.length*12); table.write('mluc',0,'ascii'); table.writeUInt32BE(records.length,8); table.writeUInt32BE(12,12);
  const parts = [table]; let offset = table.length;
  for (const [index,record] of records.entries()) {
    const at = 16+index*12; record.locale.copy(table,at); table.writeUInt32BE(record.text.length,at+4); table.writeUInt32BE(offset,at+8);
    parts.push(record.text); offset += record.text.length;
  }
  return Buffer.concat(parts);
}
function textTag(bytes) {
  const end = bytes.indexOf(0,8); if (end < 8) invalid();
  ascii(bytes.subarray(8,end+1)); return Buffer.from(exact(bytes,end+1));
}
function mlucTag(bytes) {
  if (bytes.length < 16) invalid(); const count = bytes.readUInt32BE(8),recordSize = bytes.readUInt32BE(12),start = 16+count*12;
  if (!count || count > 256 || recordSize !== 12 || start > bytes.length) invalid();
  const records = [],locales = new Set(); let total = 0;
  for (let index = 0; index < count; index++) {
    const at = 16+index*12,locale = bytes.subarray(at,at+4),size = bytes.readUInt32BE(at+4),offset = bytes.readUInt32BE(at+8);
    if (!/^[a-z]{2}[A-Z]{2}$/.test(locale.toString('latin1')) || locales.has(locale.toString('hex')) || offset < start || offset+size > bytes.length || size%2) invalid();
    locales.add(locale.toString('hex')); total += size; if (total > TEXT_LIMIT) invalid();
    const text = bytes.subarray(offset,offset+size); utf16(text); records.push({ locale,text });
  }
  // Rebuild offsets: copy only the actual legal notice, never gaps or padding.
  return localized(records);
}
function descriptionTag(bytes) {
  if (bytes.length < 12) invalid(); const count = bytes.readUInt32BE(8);
  if (!count || count > TEXT_LIMIT || 12+count+8 > bytes.length) invalid(); ascii(bytes.subarray(12,12+count));
  const unicodeCount = bytes.readUInt32BE(16+count),unicodeEnd = 20+count+unicodeCount*2;
  if (unicodeCount > TEXT_LIMIT/2 || unicodeEnd+70 > bytes.length || bytes[unicodeEnd+2] > 67) invalid();
  utf16(bytes.subarray(20+count,unicodeEnd)); exact(bytes,unicodeEnd+70);
}
function description(major) {
  const label = 'Carebridge color profile';
  if (major === 4) return localized([{ locale:Buffer.from('enUS'),text:Buffer.from(label,'utf16le').swap16() }]);
  const text = Buffer.from(label+'\0'),bytes = Buffer.alloc(12+text.length+8+70);
  bytes.write('desc',0,'ascii'); bytes.writeUInt32BE(text.length,8); text.copy(bytes,12); return bytes;
}
function metadata(bytes,major,copyright = false) {
  const type = signature(bytes);
  if (major === 4) { if (type !== 'mluc') unsupported(); return mlucTag(bytes); }
  if (copyright) { if (type !== 'text') unsupported(); return textTag(bytes); }
  if (type !== 'desc') unsupported(); descriptionTag(bytes);
}
function curve(bytes,major) {
  const type = signature(bytes);
  if (type === 'curv') {
    if (bytes.length < 12) invalid(); const count = bytes.readUInt32BE(8);
    if (count > 65536) unsupported(); const value = exact(bytes,12+count*2);
    if (count === 1 && !bytes.readUInt16BE(12)) invalid();
    for (let index = 1; count > 1 && index < count; index++) if (bytes.readUInt16BE(12+index*2) < bytes.readUInt16BE(10+index*2)) unsupported();
    return value;
  }
  if (type !== 'para' || major !== 4) unsupported();
  if (bytes.length < 12 || bytes.readUInt16BE(10)) invalid(); const kind = bytes.readUInt16BE(8),count = [1,3,4,5,7][kind];
  if (!count) unsupported(); const value = exact(bytes,12+count*4);
  if (bytes.readInt32BE(12) <= 0 || kind > 0 && bytes.readInt32BE(16) <= 0) unsupported();
  const [g,a,b,c,d,e,f] = Array.from({ length:count },(_,index) => bytes.readInt32BE(12+index*4)/65536);
  if (kind >= 3 && (d < 0 || d > 1 || a*d+b < 0 || c < 0)) unsupported();
  const evaluate = (x) => {
    if (kind === 0) return x**g;
    if (kind <= 2) return x >= -b/a ? (a*x+b)**g+(kind === 2 ? c : 0) : kind === 2 ? c : 0;
    return x >= d ? (a*x+b)**g+(kind === 4 ? e : 0) : c*x+(kind === 4 ? f : 0);
  };
  const threshold = kind <= 2 ? -b/a : d,points = [0,1];
  if (kind && threshold > 0 && threshold < 1) points.push(Math.max(0,threshold-1e-12),threshold);
  points.sort((left,right) => left-right); let previous = -Infinity;
  for (const x of points) { const y = evaluate(x); if (!Number.isFinite(y) || y < 0 || y+1e-12 < previous) unsupported(); previous = y; }
  return value;
}
function numeric(name,bytes,major,space) {
  const type = signature(bytes);
  if (['rTRC','gTRC','bTRC','kTRC'].includes(name)) return curve(bytes,major);
  if (['rXYZ','gXYZ','bXYZ','wtpt','bkpt','lumi'].includes(name)) { if (type !== 'XYZ ') unsupported(); return exact(bytes,20); }
  if (name === 'chad') { if (type !== 'sf32') unsupported(); return exact(bytes,44); }
  if (name === 'chrm') {
    if (type !== 'chrm' || bytes.length < 12) unsupported(); const channels = bytes.readUInt16BE(8);
    if (channels !== (space === 'RGB ' ? 3 : 1) || bytes.readUInt16BE(10) > 4) unsupported(); return exact(bytes,12+channels*8);
  }
  if (name === 'meas') {
    if (type !== 'meas') unsupported(); const value = exact(bytes,36);
    if (bytes.readUInt32BE(8) > 2 || bytes.readUInt32BE(24) > 2 || bytes.readUInt32BE(28) > 65536 || bytes.readUInt32BE(32) > 8) unsupported(); return value;
  }
  if (name === 'view') { if (type !== 'view') unsupported(); const value = exact(bytes,36); if (bytes.readUInt32BE(32) > 8) unsupported(); return value; }
  if (name === 'tech') { if (type !== 'sig ') unsupported(); const value = exact(bytes,12); if (!/^[ -~]{4}$/.test(signature(bytes,8))) unsupported(); return value; }
  // An unknown tag may override the matrix/TRC. Never discard it just to
  // make a profile appear supported (including LUT/HDR/vendor extensions).
  unsupported();
}
function header(bytes,expectedSpace) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 132 || bytes.length > ICC_PROFILE_LIMIT || bytes.readUInt32BE(0) !== bytes.length || signature(bytes,36) !== 'acsp') invalid();
  const major = bytes[8],minor = bytes[9] >>> 4;
  if (![2,4].includes(major) || minor > 4) unsupported();
  if (bytes[9]%16 > 9 || bytes[10] || bytes[11] || !zero(bytes.subarray(100,128)) || major === 2 && !zero(bytes.subarray(84,100))) invalid();
  if (!['scnr','mntr'].includes(signature(bytes,12)) || !['RGB ','GRAY'].includes(signature(bytes,16)) || signature(bytes,20) !== 'XYZ ') unsupported();
  if (signature(bytes,16) !== expectedSpace) invalid();
  if (bytes.readUInt32BE(44) > 3 || bytes.readBigUInt64BE(56) > 15n) unsupported();
  if (bytes.readUInt32BE(64) > 3) invalid();
  const date = Array.from({ length:6 },(_,index) => bytes.readUInt16BE(24+index*2)),[year,month,day,hour,minute,second] = date;
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year,month,0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) invalid();
  for (const [index,value] of [63190,65536,54061].entries()) if (Math.abs(bytes.readInt32BE(68+index*4)-value) > 3) invalid();
  return major;
}

// Pure bounded reconstruction, NOT a CMM or scanner. Preserve numeric color
// semantics, required legal notices and technical profile creation date.
// No claim of anonymization or permission to redistribute arbitrary profiles.
export function canonicalizeIccProfile(bytes,expectedSpace) {
  if (!['RGB ','GRAY'].includes(expectedSpace)) invalid(); const major = header(bytes,expectedSpace),count = bytes.readUInt32BE(128),start = 132+count*12;
  if (!count || count > 256 || start > bytes.length) invalid();
  const entries = [],names = new Set();
  for (let index = 0; index < count; index++) {
    const at = 132+index*12,name = signature(bytes,at),offset = bytes.readUInt32BE(at+4),size = bytes.readUInt32BE(at+8);
    if (!/^[ -~]{4}$/.test(name) || names.has(name) || offset < start || offset%4 || size < 8 || offset+size > bytes.length) invalid();
    const data = bytes.subarray(offset,offset+size); if (!zero(data.subarray(4,8))) invalid();
    names.add(name); entries.push({ name,offset,size,data });
  }
  const sorted = [...entries].sort((a,b) => a.offset-b.offset || a.size-b.size); let previous;
  for (const entry of sorted) {
    if (previous && entry.offset < previous.offset+previous.size && !(entry.offset === previous.offset && entry.size === previous.size)) invalid();
    previous = entry;
  }
  const required = ['desc','cprt','wtpt',...(expectedSpace === 'RGB ' ? ['rXYZ','gXYZ','bXYZ','rTRC','gTRC','bTRC'] : ['kTRC'])];
  if (required.some((name) => !names.has(name))) invalid();
  if (expectedSpace === 'RGB ' && names.has('kTRC') || expectedSpace === 'GRAY' && ['rXYZ','gXYZ','bXYZ','rTRC','gTRC','bTRC'].some((name) => names.has(name))) invalid();
  const retained = [];
  for (const { name,data } of entries) {
    if (['desc','dmnd','dmdd','vued'].includes(name)) { metadata(data,major); if (name === 'desc') retained.push({ name,data:description(major) }); }
    else retained.push({ name,data:Buffer.from(name === 'cprt' ? metadata(data,major,true) : numeric(name,data,major,expectedSpace)) });
  }
  retained.sort((a,b) => a.name < b.name ? -1 : 1); // ASCII tag order, independent of host ICU/locale.
  const table = Buffer.alloc(132+retained.length*12); bytes.subarray(0,128).copy(table);
  table.fill(0,40,44); table.fill(0,48,56); table.fill(0,80,128); table.writeUInt32BE(retained.length,128);
  const parts = [table],shared = new Map(); let offset = table.length;
  for (const [index,{ name,data }] of retained.entries()) {
    const key = data.toString('hex'); let location = shared.get(key);
    if (location === undefined) { location = offset; shared.set(key,location); parts.push(data,Buffer.alloc(aligned(data.length)-data.length)); offset += aligned(data.length); }
    const at = 132+index*12; table.write(name,at,'ascii'); table.writeUInt32BE(location,at+4); table.writeUInt32BE(data.length,at+8);
  }
  if (offset > ICC_PROFILE_LIMIT) invalid(); table.writeUInt32BE(offset,0); const result = Buffer.concat(parts);
  if (major === 4) {
    const checked = Buffer.from(result); checked.fill(0,44,48); checked.fill(0,64,68); checked.fill(0,84,100);
    createHash('md5').update(checked).digest().copy(result,84); // ICC ID, not a security/content digest.
  }
  return result;
}
