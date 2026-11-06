import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { handleLocalApiRequest } from './local-api-http.mjs';
import { drainLocalMediaContent } from './local-media-content-http.mjs';
import { MediaAccess } from './media-access.mjs';
import { AccountDelivery } from './account-delivery.mjs';
import { LocalPasswordRecovery } from './local-password-recovery.mjs';
import { LocalEmailLogin } from './local-email-login.mjs';
import { isSyntheticHttpsTransport } from './synthetic-https-transport.mjs';

const HOST = '127.0.0.1';
// Media drain permanently closes a MediaAccess lifetime. A new HTTPS owner may
// not share or reuse an HTTP/HTTPS lifetime. Existing HTTP-only behavior remains.
const mediaTransports = new WeakMap();
const ACCOUNT_FILES = Object.freeze([
  ['/local-api/account-input.js', 'account-input.js', 'text/javascript; charset=utf-8'],
]);
const EMAIL_LOGIN_FILES = ['email-login-client', 'email-login-ui'].map(name =>
  [`/local-api/${name}.js`, `${name}.js`, 'text/javascript; charset=utf-8']);
const INVITATION_FILES = Object.freeze([
  ['/account/invitation', 'invitation.html', 'text/html; charset=utf-8'],
  ...['invitation-entry', 'invitation-token', 'invitation-client', 'invitation-ui', 'operations-invitations']
    .map(name => [`/local-api/${name}.js`, `${name}.js`, 'text/javascript; charset=utf-8']),
]);
const RECOVERY_FILES = Object.freeze([
  ['/account/password-recovery', 'recovery.html', 'text/html; charset=utf-8'],
  ['/account/password-recovery/request', 'recovery.html', 'text/html; charset=utf-8'],
  ...['recovery-entry', 'recovery-token', 'recovery-client', 'recovery-ui']
    .map(name => [`/local-api/${name}.js`, `${name}.js`, 'text/javascript; charset=utf-8']),
]);
const STATIC_FILES = Object.freeze([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/local-api/client.js', 'client.js', 'text/javascript; charset=utf-8'],
  ['/local-api/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/local-api/approval-pending-ui.js', 'approval-pending-ui.js', 'text/javascript; charset=utf-8'],
  ['/local-api/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ['/local-api/care-client.js', 'care-client.js', 'text/javascript; charset=utf-8'],
  ['/local-api/care-ui.js', 'care-ui.js', 'text/javascript; charset=utf-8'],
  ['/local-api/workspace-ui.js', 'workspace-ui.js', 'text/javascript; charset=utf-8'],
  ['/local-api/operations-client.js', 'operations-client.js', 'text/javascript; charset=utf-8'],
  ['/local-api/care-recipient-client.js', 'care-recipient-client.js', 'text/javascript; charset=utf-8'],
  ['/local-api/operations-recipient.js', 'operations-recipient.js', 'text/javascript; charset=utf-8'],
  ['/local-api/self-profile-client.js', 'self-profile-client.js', 'text/javascript; charset=utf-8'],
  ['/local-api/self-profile-ui.js', 'self-profile-ui.js', 'text/javascript; charset=utf-8'],
  ['/local-api/operations-ui.js', 'operations-ui.js', 'text/javascript; charset=utf-8'],
  ['/local-api/operations-onboarding.js', 'operations-onboarding.js', 'text/javascript; charset=utf-8'],
  ['/local-api/operations-schedule.js', 'operations-schedule.js', 'text/javascript; charset=utf-8'],
  ['/local-api/goal-client.js', 'goal-client.js', 'text/javascript; charset=utf-8'],
  ['/local-api/appointment-client.js', 'appointment-client.js', 'text/javascript; charset=utf-8'],
  ['/local-api/media-client.js', 'media-client.js', 'text/javascript; charset=utf-8'],
  ['/local-api/media-ui.js', 'media-ui.js', 'text/javascript; charset=utf-8'],
  ['/local-api/media-viewer.js', 'media-viewer.js', 'text/javascript; charset=utf-8'],
  ['/src/record-fields.js', '../src/record-fields.js', 'text/javascript; charset=utf-8'],
  ['/src/feedback-fields.js', '../src/feedback-fields.js', 'text/javascript; charset=utf-8'],
  ['/src/profile-fields.js', '../src/profile-fields.js', 'text/javascript; charset=utf-8'],
  ['/src/context-fields.js', '../src/context-fields.js', 'text/javascript; charset=utf-8'],
  ['/src/media-policy.js', '../src/media-policy.js', 'text/javascript; charset=utf-8'],
]);
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const PREPARED_CSP = CSP.replace("img-src 'self'", "img-src 'self' blob:; media-src blob:");
const QUARANTINE_MARKER = '<html lang="ko" data-media-mode="quarantine-only">';
const PREPARED_MARKER = '<html lang="ko" data-media-mode="prepared-delivery">';
const SERVICE_NAMES = ['auth', 'conversations', 'profiles', 'memberProfiles', 'relationships', 'records', 'feedback', 'goals', 'appointments',
  'mediaUploads', 'mediaCleanup', 'mediaAccess', 'mediaMaintenance', 'accountDelivery', 'passwordRecovery', 'emailLogin',
  'careRecipientLinks', 'primaryCommunicators'];

function snapshot(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some((key) => !allowed.includes(key))) throw new TypeError('Invalid local listener options.');
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('Local listener options must be data properties.');
    result[key] = descriptor.value;
  }
  return result;
}

function configuration(input) {
  const options = snapshot(input, ['port', 'services', 'screen']);
  const port = Object.hasOwn(options, 'port') ? options.port : 0;
  const screen = Object.hasOwn(options, 'screen') ? options.screen : 'quarantine';
  if (!Number.isInteger(port) || (port !== 0 && (port < 1024 || port > 65535)) ||
      !['quarantine', 'api-only', 'prepared'].includes(screen)) throw new TypeError('Invalid local listener port or screen.');
  const services = snapshot(options.services, SERVICE_NAMES);
  if (!['login', 'authenticate', 'logout'].every((key) => typeof services.auth?.[key] === 'function') ||
      !['inbox', 'list', 'sendText', 'markRead'].every((key) => typeof services.conversations?.[key] === 'function') ||
      typeof services.profiles?.get !== 'function' ||
      (Object.hasOwn(services, 'accountDelivery') && !(services.accountDelivery instanceof AccountDelivery)) ||
      (Object.hasOwn(services, 'passwordRecovery') && !(services.passwordRecovery instanceof LocalPasswordRecovery)) ||
      (Object.hasOwn(services, 'emailLogin') && (!(services.emailLogin instanceof LocalEmailLogin) || !services.emailLogin.usesAuth(services.auth))) ||
      (Object.hasOwn(services, 'mediaAccess') && !(services.mediaAccess instanceof MediaAccess)) ||
      (services.mediaAccess && screen === 'quarantine') ||
      (screen === 'prepared' && !(services.mediaAccess instanceof MediaAccess)) ||
      (Object.hasOwn(services, 'mediaMaintenance') && (services.mediaMaintenance !== 'worker' ||
        !services.mediaAccess || services.mediaCleanup !== undefined))) throw new TypeError('Invalid local listener services.');
  return { port, screen, services: Object.freeze(services) };
}

function securityHeaders(response, screen) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', screen === 'prepared' ? PREPARED_CSP : CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function denied(response, status) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ error: status === 404 ? 'NOT_FOUND' : 'LOCAL_REQUEST_UNAVAILABLE' }));
}

function oneHeader(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count <= 1;
}

function isLocalRequest(request, origin) {
  const expected = new URL(origin);
  return request.socket.localAddress === HOST && request.socket.remoteAddress === HOST &&
    String(request.socket.localPort) === expected.port && request.headers.host === expected.host &&
    ['host', 'origin', 'sec-fetch-site'].every((name) => oneHeader(request, name)) &&
    (request.headers.origin === undefined || request.headers.origin === origin) &&
    (request.headers['sec-fetch-site'] === undefined ||
      ['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) &&
    !Object.keys(request.headers).some((name) => name === 'forwarded' || name.startsWith('x-forwarded-'));
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Local listener shutdown timed out.')), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Internal loopback transport only. Never creates, migrates or closes a DB/store. */
export async function createLocalApiListener(input) {
  return createApiListener(input);
}

/** Explicit synthetic HTTPS transport; not wired to any CLI/native runtime. */
export async function createSyntheticHttpsApiListener(input) {
  const { transport, ...options } = snapshot(input, ['port', 'services', 'screen', 'transport']);
  if (!isSyntheticHttpsTransport(transport)) throw new TypeError('Invalid synthetic HTTPS transport.');
  return createApiListener(options, transport);
}

async function createApiListener(input, transport) {
  // Capture options and the service map before loading assets or opening a port.
  // The service instances remain caller-owned; no arbitrary handler is injected.
  const { port, screen, services } = configuration(input);
  const assets = screen !== 'api-only'
    ? new Map(await Promise.all([...STATIC_FILES, ...(services.accountDelivery || services.passwordRecovery || services.emailLogin ? ACCOUNT_FILES : []),
      ...(services.emailLogin ? EMAIL_LOGIN_FILES : []),
      ...(services.accountDelivery ? INVITATION_FILES : []),
      ...(services.passwordRecovery ? RECOVERY_FILES : [])].map(async ([url, filename, type]) => {
      let body = await readFile(new URL(`../local-api/${filename}`, import.meta.url));
      if (screen === 'prepared' && url === '/') {
        const html = body.toString('utf8');
        // Only a fixed trusted build marker selects prepared UI. Browser URLs,
        // request headers and query strings cannot enable this server mode.
        if (html.split(QUARANTINE_MARKER).length !== 2) throw new Error('Invalid prepared screen asset.');
        body = Buffer.from(html.replace(QUARANTINE_MARKER, PREPARED_MARKER));
      }
      if (services.accountDelivery && url === '/') {
        body = Buffer.from(body.toString('utf8').replace('<html lang="ko"', '<html lang="ko" data-invitations-mode="synthetic"'));
      }
      if (services.passwordRecovery && url === '/') {
        body = Buffer.from(body.toString('utf8').replace('<html lang="ko"', '<html lang="ko" data-recovery-mode="synthetic"'));
      }
      if (services.emailLogin && url === '/') {
        body = Buffer.from(body.toString('utf8').replace('<html lang="ko"', '<html lang="ko" data-email-login-mode="synthetic"'));
      }
      if (transport?.mode === 'private-wifi' && url === '/') {
        body = Buffer.from(body.toString('utf8')
          .replace('<html lang="ko"', '<html lang="ko" data-connection-mode="synthetic-private-wifi"')
          .replace(/<span data-storage-notice>[^<]*<\/span>/,
            '<span data-storage-notice>승인된 개인 Wi-Fi의 PC와 지정 휴대전화에서 가상 자료로만 시험합니다. 실제 아동 자료·사진·영상은 받지 않습니다.</span>'));
      }
      return [url, { body, type }];
    })))
    : new Map();
  const cookieName = `cb_local_${randomBytes(16).toString('hex')}`;
  const sockets = new Set(), requests = new Set();
  let server, origin, apiOptions, listeningStarted = false, closing = false, closePromise, mediaClaim;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    if (server && transport) transport.invalidate();
    closePromise = (async () => {
      const listenerClosed = new Promise((resolve, reject) => {
        if (!server?.listening) return resolve();
        server.close((error) => error ? reject(error) : resolve());
      });
      for (const socket of sockets) socket.destroy();
      server?.closeAllConnections();
      await within(Promise.all([listenerClosed, Promise.allSettled([...requests])]));
      // HTTP completion alone does not prove that a disconnected media open
      // or asynchronous stream disposal finished. The caller may release its
      // DB/files only after this separate actual-lifetime drain succeeds.
      if (listeningStarted && services.mediaAccess) await within(drainLocalMediaContent(services.mediaAccess));
      if (mediaClaim) {
        mediaClaim.owners.delete(server);
        // A failed bind releases only this owner, never a concurrent HTTP
        // owner. A lifetime that has served/drained is permanently consumed.
        if (!mediaClaim.consumed && mediaClaim.owners.size === 0 && mediaTransports.get(services.mediaAccess) === mediaClaim) {
          mediaTransports.delete(services.mediaAccess);
        }
      }
    })();
    // Failure is not successful shutdown. Keep closing=true and allow a later
    // explicit drain retry; caller-owned DB/files must be retained meanwhile.
    void closePromise.catch(() => { closePromise = undefined; });
    return closePromise;
  };

  try {
    const previousMediaTransport = services.mediaAccess && mediaTransports.get(services.mediaAccess);
    if (previousMediaTransport && (transport || previousMediaTransport.kind === 'https')) {
      throw new TypeError('Synthetic HTTPS requires a new, exclusive media lifetime.');
    }
    const handler = (request, response) => {
      securityHeaders(response, screen);
      const task = (async () => {
        if (closing) return denied(response, 503);
        if (transport ? !transport.accepts(request) : !isLocalRequest(request, origin)) return denied(response, 403);
        if (request.url?.startsWith('/api/')) {
          if (!await handleLocalApiRequest(request, response, apiOptions)) denied(response, 404);
          return;
        }
        if (screen === 'api-only') return denied(response, 404);
        if (!['GET', 'HEAD'].includes(request.method)) {
          response.setHeader('Allow', 'GET, HEAD');
          return denied(response, 405);
        }
        if (request.url === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
        const asset = assets.get(request.url);
        if (!asset) return denied(response, 404);
        response.setHeader('Content-Type', asset.type);
        response.setHeader('Content-Length', asset.body.length);
        response.end(request.method === 'HEAD' ? undefined : asset.body);
      })().catch(() => {
        if (response.headersSent) response.destroy();
        else denied(response, 500);
      });
      requests.add(task);
      void task.then(() => requests.delete(task), () => requests.delete(task));
    };
    server = transport ? transport.createServer(handler)
      : createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 }, handler);
    if (services.mediaAccess) {
      mediaClaim = previousMediaTransport ?? { kind: transport ? 'https' : 'http', owners: new Set(), consumed: false };
      mediaClaim.owners.add(server);
      mediaTransports.set(services.mediaAccess, mediaClaim);
    }
    server.maxConnections = 32;
    server.maxRequestsPerSocket = 100;
    server.keepAliveTimeout = 1000;
    server.setTimeout(15000, (socket) => socket.destroy());
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.once('close', () => sockets.delete(socket));
    });
    server.on('clientError', (_, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      const failure = (error) => { server.off('listening', listening); reject(error); };
      const listening = () => {
        server.off('error', failure);
        listeningStarted = true;
        if (mediaClaim) mediaClaim.consumed = true;
        try {
          origin = transport ? transport.activate() : `http://${HOST}:${server.address().port}`;
          apiOptions = Object.freeze({ ...services, origin, cookieName, ...(transport ? { transport } : {}) });
          resolve();
        } catch (error) { reject(error); }
      };
      server.once('error', failure);
      server.once('listening', listening);
      server.listen({ host: transport ? transport.host : HOST, port, exclusive: true });
    });
    return Object.freeze({ origin, close });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Local listener startup and cleanup failed.'); }
    throw error;
  }
}
