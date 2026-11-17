import { createOpenAiChatProvider, createOpenAiSummaryProvider } from './ai-summary-provider.mjs';
import { readWebAiConfig, acceptsAccessCode, createWebAiCookie, clearWebAiCookie, hasWebAiSession, sameWebAiOrigin } from './web-ai-session.mjs';

const MAX_BODY_BYTES = 24 * 1024;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const statuses = { AUTH_REQUIRED: 401, INVALID_ACCESS_CODE: 401, AI_UNAVAILABLE: 503,
  INVALID_INPUT: 400, AI_PROVIDER_UNAVAILABLE: 503, AI_OUTPUT_INVALID: 502,
  AI_RATE_LIMITED: 429, CROSS_ORIGIN_DENIED: 403, METHOD_NOT_ALLOWED: 405 };
function failure(code) { const error = new Error(code); error.code = code; return error; }
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.length <= max && value.isWellFormed() && !CONTROL.test(value);

function json(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'private, no-store, max-age=0', 'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'Vary': 'Origin, Cookie', ...extra,
  } });
}
function denied(code, extra) { return json({ error: { code } }, statuses[code] ?? 503, extra); }
function sessionStatus(authenticated, enabled = true, extra) { return json({ authenticated, enabled, mode: 'openai' }, 200, extra); }

async function body(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) throw failure('INVALID_INPUT');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw failure('INVALID_INPUT');
  if (!request.body || request.signal.aborted) throw failure('INVALID_INPUT');
  const reader = request.body.getReader(), chunks = [];
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (request.signal.aborted) throw failure('INVALID_INPUT');
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_BODY_BYTES) throw failure('INVALID_INPUT');
      chunks.push(part.value);
    }
    if (request.signal.aborted) throw failure('INVALID_INPUT');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw failure('INVALID_INPUT'); }
  finally { request.signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function chatInput(value) {
  if (!exact(value, ['kind', 'messages', 'syntheticConfirmed']) || value.syntheticConfirmed !== true ||
      !Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 11 || value.messages.length % 2 !== 1) throw failure('INVALID_INPUT');
  let total = 0;
  const messages = value.messages.map((message, index) => {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    if (!exact(message, ['role', 'content']) || message.role !== role || !text(message.content, role === 'user' ? 2000 : 6000) || !message.content.trim()) throw failure('INVALID_INPUT');
    total += message.content.length;
    return { role, content: message.content.trim() };
  });
  if (total > 16000) throw failure('INVALID_INPUT');
  return { messages };
}
function summaryInput(value) {
  if (!exact(value, ['kind', 'source', 'syntheticConfirmed']) || value.syntheticConfirmed !== true ||
      !exact(value.source, ['performed', 'response']) || !text(value.source.performed, 2000) ||
      !text(value.source.response, 2000) || (!value.source.performed.trim() && !value.source.response.trim())) throw failure('INVALID_INPUT');
  return { performed: value.source.performed.trim(), response: value.source.response.trim() };
}

/** Only the existing OpenAI provider receives secrets. No process-local session or quota store. */
export function createWebAiHandlers({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  function config() { try { return readWebAiConfig(env); } catch { return null; } }
  async function session(request) {
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) return denied('METHOD_NOT_ALLOWED', { Allow: 'GET, POST, DELETE' });
    const settings = config();
    if (!settings) return request.method === 'GET' ? sessionStatus(false, false) : denied('AI_UNAVAILABLE');
    if (!sameWebAiOrigin(settings, request, request.method !== 'GET')) return denied('CROSS_ORIGIN_DENIED');
    if (request.method === 'GET') return sessionStatus(hasWebAiSession(settings, request.headers.get('cookie'), now()));
    if (request.method === 'DELETE') return sessionStatus(false, true, { 'Set-Cookie': clearWebAiCookie() });
    try {
      const input = await body(request);
      if (!exact(input, ['accessCode', 'syntheticConfirmed']) || input.syntheticConfirmed !== true || !text(input.accessCode, 128)) return denied('INVALID_INPUT');
      if (!acceptsAccessCode(settings, input.accessCode)) return denied('INVALID_ACCESS_CODE');
      return sessionStatus(true, true, { 'Set-Cookie': createWebAiCookie(settings, now()) });
    } catch { return denied('INVALID_INPUT'); }
  }
  async function respond(request) {
    if (request.method !== 'POST') return denied('METHOD_NOT_ALLOWED', { Allow: 'POST' });
    const settings = config();
    if (!settings) return denied('AI_UNAVAILABLE');
    if (!sameWebAiOrigin(settings, request, true)) return denied('CROSS_ORIGIN_DENIED');
    if (!hasWebAiSession(settings, request.headers.get('cookie'), now())) return denied('AUTH_REQUIRED');
    try {
      const input = await body(request);
      if (input?.kind !== 'chat' && input?.kind !== 'summary') return denied('INVALID_INPUT');
      const content = input.kind === 'chat' ? chatInput(input) : summaryInput(input);
      const providerOptions = { apiKey: settings.apiKey, model: settings.model, reasoningEffort: settings.reasoningEffort,
        maxOutputTokens: 800, timeoutMs: 20000, fetchImpl };
      const result = input.kind === 'chat'
        ? await createOpenAiChatProvider(providerOptions).respond(content, { signal: request.signal })
        : await createOpenAiSummaryProvider(providerOptions).generate(content, { signal: request.signal });
      if (!hasWebAiSession(settings, request.headers.get('cookie'), now())) return denied('AUTH_REQUIRED');
      return json(input.kind === 'chat'
        ? { kind: 'chat', text: result.text, mode: 'openai', model: settings.model }
        : { kind: 'summary', summary: result.summary, reviewNotes: result.reviewNotes, mode: 'openai', model: settings.model });
    } catch (error) {
      const code = ['INVALID_INPUT', 'AI_OUTPUT_INVALID', 'AI_PROVIDER_UNAVAILABLE'].includes(error?.code) ? error.code : 'AI_PROVIDER_UNAVAILABLE';
      return denied(code);
    }
  }
  return Object.freeze({ session, respond });
}
