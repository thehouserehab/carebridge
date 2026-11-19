import { Auth } from './auth.mjs';
import { Conversations } from './conversations.mjs';
import { Children } from './profiles.mjs';
import { WebChatMedia } from './web-chat-media.mjs';
import { X509Certificate } from 'node:crypto';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const unavailable = () => { throw new Error('CHAT_UNAVAILABLE'); };

/** Optional provider CA for this pool only; never changes Node or OS global trust. */
export function readWebChatDatabaseCa(value, now = Date.now()) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16 * 1024 || !Number.isFinite(now)) unavailable();
  const pem = value.trim();
  if (!/^-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----$/.test(pem)) unavailable();
  let certificate;
  try { certificate = new X509Certificate(pem); } catch { unavailable(); }
  const from = Date.parse(certificate.validFrom), until = Date.parse(certificate.validTo);
  if (!certificate.ca || !Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until) unavailable();
  return pem + '\n';
}

function httpsOrigin(value) {
  let url;
  try { url = new URL(value); } catch { unavailable(); }
  if (typeof value !== 'string' || value.length > 255 || url.origin !== value ||
      url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') ||
      /[\s\x00-\x1f\x7f]/.test(value)) unavailable();
  return url.origin;
}

/** Trusted server configuration only; never called with browser-supplied values. */
export function readWebChatConfig(env) {
  if (env.CAREBRIDGE_WEB_CHAT_ENABLED !== 'true') unavailable();
  const centerId = env.CAREBRIDGE_CHAT_CENTER_ID;
  const raw = env.CAREBRIDGE_CHAT_DATABASE_URL;
  if (typeof centerId !== 'string' || !ID.test(centerId) || typeof raw !== 'string' ||
      raw.length > 4096 || /[\x00-\x20\x7f]/.test(raw)) unavailable();
  let databaseUrl;
  try { databaseUrl = new URL(raw); } catch { unavailable(); }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.username || !databaseUrl.password ||
      !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(databaseUrl.hostname) ||
      /(?:^|\.)(?:localhost|local|internal)$/i.test(databaseUrl.hostname) ||
      !['', '5432', '6543'].includes(databaseUrl.port) || !/^\/[^/]+$/.test(databaseUrl.pathname) || databaseUrl.hash) unavailable();
  // pg parses SSL URL parameters after options. Remove only the accepted mode,
  // then explicitly require certificate verification in the pool configuration.
  for (const [key, value] of databaseUrl.searchParams) {
    if (key !== 'sslmode' || !['require', 'verify-full'].includes(value)) unavailable();
  }
  databaseUrl.search = '';
  const rawOrigins = env.CAREBRIDGE_WEB_ORIGINS;
  if (typeof rawOrigins !== 'string' || rawOrigins.length > 2048) unavailable();
  const values = rawOrigins.split(',').map(value => value.trim());
  if (!values.length || values.length > 8 || values.some(value => !value)) unavailable();
  const origins = new Set(values.map(httpsOrigin));
  if (env.VERCEL_URL !== undefined) {
    if (typeof env.VERCEL_URL !== 'string' || !/^[a-z0-9][a-z0-9-]{0,150}\.vercel\.app$/.test(env.VERCEL_URL)) unavailable();
    origins.add(httpsOrigin('https://' + env.VERCEL_URL));
  }
  const databaseCa = readWebChatDatabaseCa(env.CAREBRIDGE_CHAT_DATABASE_CA);
  return Object.freeze({ centerId, connectionString: databaseUrl.href, origins, databaseCa });
}

/** Each function instance caches a pool/services only. Auth and messages live in PostgreSQL. */
export function createWebChatRuntime({ env = process.env, databaseFactory } = {}) {
  let servicesPromise;
  return {
    async services() {
      if (!servicesPromise) {
        const config = readWebChatConfig(env);
        servicesPromise = (async () => {
          const factory = databaseFactory ?? (await import('./database.mjs')).postgresDatabase;
          const database = factory({ connectionString: config.connectionString,
            ssl: { rejectUnauthorized: true, ...(config.databaseCa === undefined ? {} : { ca: config.databaseCa }) }, max: 2, connectionTimeoutMillis: 5000,
            idleTimeoutMillis: 10000, maxLifetimeSeconds: 300, allowExitOnIdle: true });
          return Object.freeze({ auth: new Auth(database, { sessionTtlSeconds: 3600 }),
            conversations: new Conversations(database), profiles: new Children(database), media: new WebChatMedia(database) });
        })();
        servicesPromise.catch(() => { servicesPromise = undefined; });
      }
      return servicesPromise;
    },
  };
}

const runtime = createWebChatRuntime();
export const webChatServices = () => runtime.services();
