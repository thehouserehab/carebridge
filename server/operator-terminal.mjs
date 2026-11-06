import { StringDecoder } from 'node:string_decoder';

export class OperatorInputError extends Error {
  constructor(code) { super(code); this.name = 'OperatorInputError'; this.code = code; }
}
export function operatorFail(code) { throw new OperatorInputError(code); }

export function requirePrivateTerminal(input, output) {
  if (input?.isTTY !== true || output?.isTTY !== true || typeof input.setRawMode !== 'function')
    operatorFail('OPERATOR_TTY_REQUIRED');
}

// No input echo, including email and connection URL. Never accept redirected
// stdin or secrets in command arguments. JS strings cannot be securely wiped.
export function readHiddenLine(label, { input = process.stdin,output = process.stderr,
  maxLength = 2048,timeoutMilliseconds = 120000,signal } = {}) {
  requirePrivateTerminal(input,output);
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 2048 ||
      !Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 50 || timeoutMilliseconds > 300000 ||
      (signal !== undefined && !(signal instanceof AbortSignal))) operatorFail('OPERATOR_INPUT_INVALID');
  if (signal?.aborted) operatorFail('OPERATOR_CANCELLED');
  return new Promise((resolve,reject) => {
    const decoder = new StringDecoder('utf8'), previousRaw = Boolean(input.isRaw), previousPaused = input.readableFlowing !== true;
    let value = '', settled = false;
    const onAbort = () => finish('OPERATOR_CANCELLED');
    const onError = () => finish('OPERATOR_INPUT_UNAVAILABLE');
    const onEnd = () => finish('OPERATOR_CANCELLED');
    const timer = setTimeout(() => finish('OPERATOR_INPUT_TIMEOUT'),timeoutMilliseconds);
    function finish(code = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener('data',onData); input.removeListener('error',onError);
      input.removeListener('end',onEnd); input.removeListener('close',onEnd);
      output.removeListener('error',onError); signal?.removeEventListener('abort',onAbort);
      try { input.setRawMode(previousRaw); if (previousPaused) input.pause(); }
      catch { code = 'OPERATOR_INPUT_UNAVAILABLE'; }
      try { output.write('\n'); } catch { code = 'OPERATOR_INPUT_UNAVAILABLE'; }
      const result = value; value = '';
      if (code) reject(new OperatorInputError(code)); else resolve(result);
    }
    function onData(chunk) {
      if (settled) return;
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') return finish('OPERATOR_INPUT_INVALID');
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const chars = Array.from(text);
      for (let index = 0; index < chars.length; index++) {
        const char = chars[index];
        if (char === '\x03' || char === '\x04') return finish('OPERATOR_CANCELLED');
        if (char === '\r' || char === '\n') {
          // Do not let a multiline paste answer subsequent secret/confirmation
          // prompts. A single CRLF is the only accepted trailing input.
          const remaining = chars.slice(index + 1).join('');
          if (remaining && !(char === '\r' && remaining === '\n')) return finish('OPERATOR_INPUT_INVALID');
          return finish();
        }
        if (char === '\x08' || char === '\x7f') { value = Array.from(value).slice(0,-1).join(''); continue; }
        if (char === '\x15') { value = ''; continue; }
        if (char.charCodeAt(0) < 32 || char === '\x1b' || value.length + char.length > maxLength)
          return finish('OPERATOR_INPUT_INVALID');
        value += char;
      }
    }
    input.on('data',onData); input.on('error',onError); input.once('end',onEnd); input.once('close',onEnd);
    output.on('error',onError); signal?.addEventListener('abort',onAbort,{ once:true });
    try { input.setRawMode(true); output.write(label); input.resume(); }
    catch { finish('OPERATOR_INPUT_UNAVAILABLE'); }
  });
}
