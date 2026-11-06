import { createHash } from 'node:crypto';
import { MEDIA_TYPES } from '../src/media-policy.js';
import { fail } from './errors.mjs';

export const DECODER_VERSION = '9.0.2';
export const PROBE_PATH = '/opt/carebridge/ffmpeg/bin/ffprobe';
export const DECODE_LIMITS = Object.freeze({ dimension:8192,pixels:40_000_000,frames:144000,
  decodedPixels:20_000_000_000,duration:600,outputBytes:16*1024*1024,allocationBytes:256*1024*1024 });
const profiles = Object.freeze({
  'image/jpeg':{ formats:['jpeg_pipe'],video:['mjpeg'],audio:[] },
  'image/png':{ formats:['png_pipe','apng'],video:['png','apng'],audio:[] },
  'image/gif':{ formats:['gif'],video:['gif'],audio:[] },
  'image/webp':{ formats:['webp_pipe','webp_anim'],video:['webp','webp_anim'],audio:[] },
  'video/mp4':{ formats:['mov,mp4,m4a,3gp,3g2,mj2'],inputFormats:['mov'],video:['h264','hevc','av1','mpeg4'],audio:['aac','mp3','alac'] },
  'video/webm':{ formats:['matroska,webm'],inputFormats:['matroska'],video:['vp8','vp9','av1'],audio:['opus','vorbis'] },
});
const invalid = () => fail('SCAN_INVALID');
const dimension = (width,height) => {
  if (![width,height].every((number) => Number.isSafeInteger(number) && number >= 1 && number <= DECODE_LIMITS.dimension) ||
      width*height > DECODE_LIMITS.pixels) invalid();
};
const decimal = (value) => {
  if (typeof value !== 'string' || !/^-?\d{1,10}(?:\.\d{1,9})?$/.test(value)) invalid();
  const number = Number(value); if (!Number.isFinite(number)) invalid(); return number;
};
const integer = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,9})$/.test(value)) invalid();
  const number = Number(value); if (!Number.isSafeInteger(number)) invalid(); return number;
};

// Not a user URL/path command builder. fd 3 is a verified read-only regular
// file opened by the caller, unlinked before exec; no file/network protocol.
export function decoderArguments(type) {
  const profile = profiles[type]; if (!MEDIA_TYPES.includes(type) || !profile) invalid();
  const codecs = [...profile.video,...profile.audio]; if (codecs.includes('av1')) codecs.push('libdav1d');
  // Truncated containers can emit warning-level output but exit 0. Treat
  // warnings as failures as well, rather than approving a partial decode.
  return ['-hide_banner','-v','warning','-max_alloc',String(DECODE_LIMITS.allocationBytes),
    '-threads','1','-max_pixels',String(DECODE_LIMITS.pixels),'-err_detect','explode',
    '-protocol_whitelist','fd','-format_whitelist',(profile.inputFormats ?? profile.formats).join(','),
    '-codec_whitelist',codecs.join(','),'-fd','3','-blocksize','65536',
    ...(type === 'video/mp4' ? ['-enable_drefs','0','-use_absolute_path','0'] : []),
    ...(type === 'image/gif' ? ['-ignore_loop','1'] : []),
    '-show_frames','-show_streams','-count_frames','-show_format','-show_entries',
    'frame=media_type,stream_index,width,height,best_effort_timestamp_time,duration_time,nb_samples:stream=index,codec_name,codec_type,width,height,nb_frames,nb_read_frames,sample_rate:format=format_name:frame_side_data=:stream_tags=:format_tags=:stream_disposition=:stream_side_data=',
    '-of','json','-i','fd:'];
}

// Parse only measured decoded frame fields. Never return probe originals/tags,
// paths, error strings, captions, metadata or caller-provided dimensions.
export function decodedMediaReport(document,type,expectedFrames = null,{ timelineEvidence = false } = {}) {
  if (typeof timelineEvidence !== 'boolean') invalid();
  const profile = profiles[type];
  if (!MEDIA_TYPES.includes(type) || !profile || !document || !Array.isArray(document.frames) || !document.frames.length ||
      document.frames.length > DECODE_LIMITS.frames || !Array.isArray(document.streams) ||
      document.streams.length < 1 || document.streams.length > 2 || !profile.formats.includes(document.format?.format_name)) invalid();
  const streams = new Map(); let video;
  for (const stream of document.streams) {
    if (!Number.isSafeInteger(stream.index) || stream.index < 0 || streams.has(stream.index) ||
        !['video','audio'].includes(stream.codec_type) || !profile[stream.codec_type].includes(stream.codec_name)) invalid();
    if (stream.codec_type === 'video') {
      if (video) invalid(); dimension(stream.width,stream.height); video = stream;
    } else if (integer(stream.sample_rate) < 8000 || integer(stream.sample_rate) > 192000) invalid();
    streams.set(stream.index,{ ...stream,count:0 });
  }
  if (!video) invalid();
  let pixels = 0, earliest = Infinity,latest = -Infinity,audioFrames = 0,videoFrames = 0;
  const previousTimes = new Map(), isVideo = type.startsWith('video/');
  // Animated images can consume the same playback/CPU budget as videos. A
  // single-frame GIF/APNG/WebP animation still has a measured frame delay.
  // Static PNG/JPEG/WebP keep their existing metadata-only return shape.
  const timedMedia = isVideo || ['gif','apng','webp_anim'].includes(document.format.format_name);
  // Optional preparation evidence, not a pixel/audio-content hash. Hash only
  // validated technical fields, never probe tags, filenames or raw documents.
  const timeline = timelineEvidence ? createHash('sha256') : null;
  timeline?.update(JSON.stringify({ type,timedMedia,streams:[...streams.values()].sort((a,b) => a.index-b.index).map((stream) =>
    stream.codec_type === 'video' ? [stream.index,'video',stream.codec_name,stream.width,stream.height] :
      [stream.index,'audio',stream.codec_name,integer(stream.sample_rate)]) })+'\n');
  for (const frame of document.frames) {
    const stream = streams.get(frame.stream_index);
    if (!stream || frame.media_type !== stream.codec_type) invalid(); stream.count += 1;
    if (frame.media_type === 'video') {
      dimension(frame.width,frame.height);
      if (frame.width !== video.width || frame.height !== video.height) invalid();
      pixels += frame.width*frame.height; if (pixels > DECODE_LIMITS.decodedPixels) invalid(); videoFrames += 1;
    } else {
      if (!Number.isSafeInteger(frame.nb_samples) || frame.nb_samples < 1 || frame.nb_samples > 65536) invalid();
      audioFrames += 1;
    }
    if (timedMedia) {
      const time = decimal(frame.best_effort_timestamp_time), duration = frame.media_type === 'audio' ?
        frame.nb_samples/integer(stream.sample_rate) : decimal(frame.duration_time);
      if (duration <= 0 || duration > DECODE_LIMITS.duration ||
          (previousTimes.has(frame.stream_index) && time < previousTimes.get(frame.stream_index))) invalid();
      previousTimes.set(frame.stream_index,time); earliest = Math.min(earliest,time); latest = Math.max(latest,time+duration);
      if (latest-earliest > DECODE_LIMITS.duration) invalid();
      timeline?.update(JSON.stringify([frame.stream_index,frame.media_type,time,duration,
        frame.media_type === 'audio' ? frame.nb_samples : [frame.width,frame.height]])+'\n');
    } else {
      timeline?.update(JSON.stringify([frame.stream_index,frame.media_type,frame.width,frame.height])+'\n');
    }
  }
  if (!videoFrames || expectedFrames !== null && videoFrames !== expectedFrames) invalid();
  for (const stream of streams.values()) {
    if (!stream.count || integer(stream.nb_read_frames) !== stream.count ||
        stream.codec_type === 'video' && stream.nb_frames !== undefined && stream.nb_frames !== 'N/A' && integer(stream.nb_frames) !== stream.count) invalid();
  }
  const duration = latest-earliest;
  if (timedMedia && (!Number.isFinite(duration) || duration <= 0 || duration > DECODE_LIMITS.duration)) invalid();
  return { media:{ type,width:video.width,height:video.height,...(isVideo ? { duration } : {}) },
    decodedVideoFrames:videoFrames,decodedAudioFrames:audioFrames,
    ...(timelineEvidence ? { timelineSha256:timeline.digest('hex') } : {}) };
}
