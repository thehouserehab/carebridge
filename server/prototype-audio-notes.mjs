import { createHash } from 'node:crypto';
import { AiAudioNotes } from './ai-audio-notes.mjs';
import { prototypeAudioSample } from './prototype-ai-fixtures.mjs';
import { fail } from './errors.mjs';

// The demonstration admits only its provided audio before retaining a session.
// Live AI and ordinary synthetic launchers keep the normal upload policy.
export class PrototypeAudioNotes extends AiAudioNotes {
  async upload(actor, input) {
    if (input?.type !== prototypeAudioSample.type || typeof input?.base64 !== 'string' ||
        input.base64.length !== 4 * Math.ceil(prototypeAudioSample.size / 3)) fail('INVALID_INPUT');
    const bytes = Buffer.from(input.base64, 'base64');
    try {
      if (bytes.length !== prototypeAudioSample.size ||
          createHash('sha256').update(bytes).digest('hex') !== prototypeAudioSample.sha256) fail('INVALID_INPUT');
    } finally { bytes.fill(0); }
    return super.upload(actor, input);
  }
}
