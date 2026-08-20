/**
 * token-cost host half plus the desktop loopback trust boundary.
 * The Electron shell supplies a per-installation secret in the environment.
 * Every HTTP/upgrade route is protected; the challenge route proves that a
 * running service was started with that secret without sending the secret.
 */
import crypto from 'node:crypto';

const AUTH_PATH = '/__dsh_desktop_auth';
const AUTH_HEADER = 'x-dsh-desktop-token';
const SERVICE_NAME = 'dsh-desktop';

function tokenBuffer() {
  const value = process.env.DSH_DESKTOP_AUTH_TOKEN || '';
  return /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : null;
}

function proof(token, challenge) {
  return crypto.createHmac('sha256', token).update(challenge).digest('hex');
}

function authorized(req, token) {
  const supplied = String(req.headers[AUTH_HEADER] || '');
  const actual = Buffer.from(supplied, 'hex');
  return actual.length === token.length && crypto.timingSafeEqual(actual, token);
}

function reject(res) {
  if (!res.headersSent) res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'desktop authentication required' }));
}

function challengeHandler(req, res, token) {
  let challenge = '';
  try { challenge = new URL(req.url || '/', 'http://localhost').searchParams.get('challenge') || ''; } catch {}
  if (!/^[a-f0-9]{48,128}$/i.test(challenge)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid challenge' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ service: SERVICE_NAME, proof: proof(token, challenge) }));
}

function protectHandler(handler, token) {
  return async (req, res) => {
    if (!authorized(req, token)) { reject(res); return; }
    await handler(req, res);
  };
}

function protectUpgrade(handler, token) {
  return async (req, socket, head) => {
    if (!authorized(req, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    await handler(req, socket, head);
  };
}

export const inject = ['webServer'];

export function apply(ctx) {
  const token = tokenBuffer();
  if (!token) throw new Error('DSH_DESKTOP_AUTH_TOKEN is missing or invalid; refusing to start unauthenticated web service');
  const webServer = ctx.webServer;

  // Install the wrappers before dependent web routes (connection/static) start.
  const register = webServer.register.bind(webServer);
  webServer.register = (route) => {
    if (route.path === AUTH_PATH) return register(route);
    return register({ ...route, handler: protectHandler(route.handler, token) });
  };
  const registerFallback = webServer.registerFallback.bind(webServer);
  webServer.registerFallback = (handler) => registerFallback(protectHandler(handler, token));
  const registerUpgrade = webServer.registerUpgrade.bind(webServer);
  webServer.registerUpgrade = (route) => registerUpgrade({ ...route, handler: protectUpgrade(route.handler, token) });

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: AUTH_PATH,
    handler: (req, res) => challengeHandler(req, res, token),
  }), 'token-cost: desktop auth challenge');

  console.log('[token-cost] host plugin activated with desktop authentication');
}
