'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(mainSource, /shell:\s*true/, 'desktop startup must not use shell:true');
  assert.match(mainSource, /DSH_VERSION = '0\.1\.0-rc\.7'/, 'DSH version must remain pinned');
  process.env.DSH_DESKTOP_AUTH_TOKEN = 'a'.repeat(64);
  const { apply } = await import('../plugin-token-cost/lib/index.js');
  const routes = [];
  let fallback;
  let upgrade;
  const webServer = {
    register(route) { routes.push(route); return () => {}; },
    registerFallback(handler) { fallback = handler; return () => {}; },
    registerUpgrade(route) { upgrade = route; return () => {}; },
  };
  const ctx = {
    webServer,
    effect(effect) { return effect(); },
  };
  apply(ctx);

  const challenge = crypto.randomBytes(24).toString('hex');
  const challengeRoute = routes.find((route) => route.path === '/__dsh_desktop_auth');
  assert.ok(challengeRoute, 'desktop auth challenge route should be registered');
  const challengeResponse = { status: 0, headers: {}, body: '' };
  await challengeRoute.handler(
    { url: `/__dsh_desktop_auth?challenge=${challenge}`, headers: {} },
    { writeHead(status, headers) { challengeResponse.status = status; challengeResponse.headers = headers; }, end(body) { challengeResponse.body = body; } },
  );
  const challengeBody = JSON.parse(challengeResponse.body);
  assert.equal(challengeResponse.status, 200);
  assert.equal(challengeBody.service, 'dsh-desktop');
  assert.equal(challengeBody.proof, crypto.createHmac('sha256', Buffer.from(process.env.DSH_DESKTOP_AUTH_TOKEN, 'hex')).update(challenge).digest('hex'));

  let protectedRoute;
  webServer.register({ kind: 'exact', path: '/api/test', handler: (_req, res) => res.end('ok') });
  protectedRoute = routes.find((route) => route.path === '/api/test');
  assert.ok(protectedRoute);
  const rejected = { status: 0 };
  await protectedRoute.handler({ headers: {} }, { writeHead(status) { rejected.status = status; }, end() {} });
  assert.equal(rejected.status, 401, 'API route must reject missing desktop token');

  const accepted = { body: '' };
  await protectedRoute.handler(
    { headers: { 'x-dsh-desktop-token': process.env.DSH_DESKTOP_AUTH_TOKEN } },
    { writeHead() {}, end(body) { accepted.body = body; } },
  );
  assert.equal(accepted.body, 'ok');
  webServer.registerFallback((_req, res) => res.end('fallback'));
  webServer.registerUpgrade({ path: '/api/socket', handler: async () => {} });
  assert.equal(typeof fallback, 'function');
  assert.equal(typeof upgrade?.handler, 'function');
  console.log('security smoke: desktop auth challenge and route guards passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
