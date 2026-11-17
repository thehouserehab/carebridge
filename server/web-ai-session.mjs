import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const WEB_AI_COOKIE = '__Secure-carebridge-ai';
export const WEB_AI_SESSION_SECONDS = 60 * 60;
const TOKEN_PART = /^[A-Za-z0-9_-]+$/;
const secret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
const digest = value => createHash('sha256').update(value).digest();
const same = (left, right) => timingSafeEqual(digest(left), digest(right));

function origin(value) {
  if (typeof value !== 'string' || value.length > 255) throw new Error('WEB_AI_CONFIG_INVALID');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password ||
      url.hostname === 'localhost' || !url.hostname.includes('.') || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error('WEB_AI_CONFIG_INVALID');
  }
  return url.origin;
}

/** No environment values are returned to browser clients or written to logs. */
export function readWebAiConfig(env) {
  const apiKey = env.CAREBRIDGE_OPENAI_API_KEY;
  const accessCode = env.CAREBRIDGE_WEB_ACCESS_CODE;
  const sessionSecret = env.CAREBRIDGE_WEB_SESSION_SECRET;
  const model = env.CAREBRIDGE_AI_MODEL ?? 'gpt-6-luna';
  const reasoningEffort = env.CAREBRIDGE_AI_REASONING_EFFORT ?? 'none';
  const explicitOrigins = env.CAREBRIDGE_WEB_ORIGINS;
  if (typeof apiKey !== 'string' || !/^sk-[A-Za-z0-9_-]{16,508}$/.test(apiKey) ||
      !secret(accessCode) || !secret(sessionSecret) || same(accessCode, sessionSecret) ||
      typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model) ||
      !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort) ||
      typeof explicitOrigins !== 'string' || explicitOrigins.length > 2048) throw new Error('WEB_AI_CONFIG_INVALID');
  const values = explicitOrigins.split(',').map(value => value.trim());
  if (!values.length || values.length > 8 || values.some(value => !value)) throw new Error('WEB_AI_CONFIG_INVALID');
  const origins = new Set(values.map(origin));
  // This is a server-provided deployment hostname, never a forwarded/client header.
  if (env.VERCEL_URL !== undefined) {
    if (typeof env.VERCEL_URL !== 'string' || !/^[a-z0-9][a-z0-9-]{0,150}\.vercel\.app$/.test(env.VERCEL_URL)) {
      throw new Error('WEB_AI_CONFIG_INVALID');
    }
    origins.add(origin('https://' + env.VERCEL_URL));
  }
  const signingKey = createHmac('sha256', sessionSecret).update('carebridge-web-ai-v1:').update(digest(accessCode)).digest();
  return Object.freeze({ apiKey, accessCode, signingKey, model, reasoningEffort, origins });
}

export function acceptsAccessCode(config, value) {
  return typeof value === 'string' && value.length <= 128 && same(value, config.accessCode);
}

export function createWebAiCookie(config, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(iat) || iat < 0) throw new Error('WEB_AI_CLOCK_INVALID');
  const payload = Buffer.from(JSON.stringify({ v: 1, iat, exp: iat + WEB_AI_SESSION_SECONDS, id: randomBytes(16).toString('base64url') })).toString('base64url');
  const signature = createHmac('sha256', config.signingKey).update(payload).digest('base64url');
  return `${WEB_AI_COOKIE}=${payload}.${signature}; Path=/api/ai; Max-Age=${WEB_AI_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearWebAiCookie() {
  return `${WEB_AI_COOKIE}=; Path=/api/ai; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** Stateless validation survives function-instance replacement; it grants AI access only. */
export function hasWebAiSession(config, cookieHeader, nowMs = Date.now()) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 8192) return false;
  const candidates = cookieHeader.split(';').map(part => part.trim()).filter(part => part.startsWith(WEB_AI_COOKIE + '='));
  if (candidates.length !== 1) return false;
  const token = candidates[0].slice(WEB_AI_COOKIE.length + 1);
  if (token.length > 1024) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => part && TOKEN_PART.test(part))) return false;
  const [payload, signature] = parts;
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const actual = Buffer.from(signature, 'base64url');
  const expected = createHmac('sha256', config.signingKey).update(payload).digest();
  if (actual.length !== expected.length || actual.toString('base64url') !== signature || !timingSafeEqual(actual, expected)) return false;
  try {
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) return false;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const now = Math.floor(nowMs / 1000);
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'exp,iat,id,v' && value.v === 1 &&
      Number.isSafeInteger(now) && Number.isSafeInteger(value.iat) && Number.isSafeInteger(value.exp) &&
      value.iat >= 0 && value.iat <= now + 5 && value.exp === value.iat + WEB_AI_SESSION_SECONDS && now < value.exp &&
      typeof value.id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value.id);
  } catch { return false; }
}

export function sameWebAiOrigin(config, request, mutation = false) {
  try {
    const url = new URL(request.url);
    if (!config.origins.has(url.origin) || url.protocol !== 'https:') return false;
    const supplied = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if (supplied !== null && supplied !== url.origin) return false;
    if (site !== null && site !== 'same-origin' && !(site === 'none' && !mutation)) return false;
    return !mutation || (supplied === url.origin && request.headers.get('x-carebridge-ai') === '1');
  } catch { return false; }
}
