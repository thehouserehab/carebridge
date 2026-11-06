import { createServer } from 'node:http';
import { AuthError, authFail } from './auth.mjs';

export const SESSION_COOKIE = 'cb_session';
const MAX_BODY_BYTES = 16 * 1024;

const jsonHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function writeJson(res, status, body, extra = {}) {
  res.writeHead(status, { ...jsonHeaders, ...extra });
  res.end(JSON.stringify(body));
}

function writeEmpty(res, status, extra = {}) {
  res.writeHead(status, { ...jsonHeaders, ...extra });
  res.end();
}

function parseCookies(value = '') {
  const cookies = new Map();
  for (const item of value.split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    const key = item.slice(0, index).trim();
    const raw = item.slice(index + 1).trim();
    if (!key) continue;
    try { cookies.set(key, decodeURIComponent(raw)); } catch { /* ignore malformed cookie */ }
  }
  return cookies;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) authFail('PAYLOAD_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) authFail('INVALID_INPUT');
    return body;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    authFail('INVALID_INPUT');
  }
}

function onlyKeys(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) authFail('INVALID_INPUT');
}

async function requireSession(req, auth) {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  const user = token ? await auth.authenticate(token) : null;
  if (!user) authFail('AUTH_REQUIRED', 401);
  return user;
}

function cookie(value, { secure, maxAge = 0 } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function publicError(error) {
  if (error instanceof AuthError) {
    const known = new Set([
      'INVALID_INPUT', 'PAYLOAD_TOO_LARGE', 'ACCOUNT_EXISTS', 'USER_NOT_FOUND',
      'FORBIDDEN', 'NOT_FOUND', 'INVITATION_EXISTS', 'INVITATION_INVALID',
      'INVITATION_ACCOUNT_EXISTS', 'INVITATION_NOT_PENDING', 'INVITATION_CONFLICT',
    ]);
    if (error.code === 'AUTH_INVALID')
      return { status: 401, body: { error: 'AUTH_INVALID', message: '이메일 또는 비밀번호를 확인해 주세요.' } };
    if (error.code === 'AUTH_REQUIRED')
      return { status: 401, body: { error: 'AUTH_REQUIRED', message: '로그인이 필요합니다.' } };
    if (known.has(error.code)) {
      const status = error.code === 'PAYLOAD_TOO_LARGE' ? 413 : error.status;
      const message = {
        ACCOUNT_EXISTS: '이미 사용 중인 계정입니다.',
        INVITATION_EXISTS: '같은 대상에 아직 유효한 초대가 있습니다.',
        INVITATION_ACCOUNT_EXISTS: '이미 계정이 있는 대상입니다. 기존 계정 연결 절차가 필요합니다.',
        INVITATION_NOT_PENDING: '대기 중인 초대만 철회할 수 있습니다.',
        FORBIDDEN: '이 작업을 수행할 권한이 없습니다.',
        NOT_FOUND: '요청한 대상을 찾을 수 없습니다.',
      }[error.code] ?? '요청 내용을 확인해 주세요.';
      return { status, body: { error: error.code, message } };
    }
  }
  return { status: 500, body: { error: 'AUTH_UNAVAILABLE', message: '인증 처리에 실패했습니다.' } };
}

export async function handleAuthRequest(req, res, { auth, secureCookies = false } = {}) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/auth/')) return false;
  if (!auth?.login || !auth?.authenticate || !auth?.logout) {
    writeJson(res, 503, { error: 'AUTH_UNAVAILABLE', message: '인증 서버가 준비되지 않았습니다.' });
    return true;
  }
  try {
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      onlyKeys(body, ['email', 'password']);
      const result = await auth.login(body);
      writeJson(res, 200, { user: result.user }, {
        'Set-Cookie': cookie(result.token, { secure: secureCookies, maxAge: Math.max(0, Math.floor((Date.parse(result.user.expiresAt) - Date.now()) / 1000)) }),
      });
      return true;
    }
    if (url.pathname === '/api/auth/session' && req.method === 'GET') {
      writeJson(res, 200, { user: await requireSession(req, auth) });
      return true;
    }
    if (url.pathname === '/api/auth/invitations/accept' && req.method === 'POST') {
      const body = await readJson(req);
      onlyKeys(body, ['token', 'password']);
      const result = await auth.acceptInvitation(body);
      writeJson(res, 200, { user: result.user, invitation: result.invitation }, {
        'Set-Cookie': cookie(result.token, {
          secure: secureCookies,
          maxAge: Math.max(0, Math.floor((Date.parse(result.user.expiresAt) - Date.now()) / 1000)),
        }),
      });
      return true;
    }
    if (url.pathname === '/api/auth/invitations' && req.method === 'POST') {
      const user = await requireSession(req, auth);
      const body = await readJson(req);
      onlyKeys(body, ['centerId', 'email', 'role']);
      const invitation = await auth.createInvitation(user, body);
      writeJson(res, 201, { invitation });
      return true;
    }
    if (url.pathname === '/api/auth/invitations' && req.method === 'GET') {
      const user = await requireSession(req, auth);
      const centerId = url.searchParams.get('centerId');
      writeJson(res, 200, { invitations: await auth.listInvitations(user, { centerId }) });
      return true;
    }
    if (url.pathname === '/api/auth/invitations/revoke' && req.method === 'POST') {
      const user = await requireSession(req, auth);
      const body = await readJson(req);
      onlyKeys(body, ['centerId', 'invitationId']);
      await auth.revokeInvitation(user, body);
      writeEmpty(res, 204);
      return true;
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (token) await auth.logout(token);
      writeEmpty(res, 204, { 'Set-Cookie': cookie('', { secure: secureCookies, maxAge: 0 }) });
      return true;
    }
    writeJson(res, 404, { error: 'NOT_FOUND', message: '요청한 인증 경로가 없습니다.' });
    return true;
  } catch (error) {
    const result = publicError(error);
    writeJson(res, result.status, result.body);
    return true;
  }
}

export function createAuthServer(options) {
  return createServer(async (req, res) => {
    if (await handleAuthRequest(req, res, options)) return;
    writeJson(res, 404, { error: 'NOT_FOUND', message: '요청한 인증 경로가 없습니다.' });
  });
}
