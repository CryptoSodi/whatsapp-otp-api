import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { buildApp } from '../src/app.js';
import { pairScript } from '../src/pair-page.js';
import type { WhatsAppGateway } from '../src/gateway.js';
import { config, adminHeaders, senderHeaders } from './helpers.js';

function fixture() {
  let resets = 0;
  const gateway: WhatsAppGateway = {
    status: () => ({ state: 'connected' }),
    qr: () => undefined,
    pairingCode: async () => 'ABCDEFGH',
    send: async () => 'unused',
    resetSession: async () => {
      resets++;
      return { state: 'connecting' };
    },
  };
  return { gateway, resets: () => resets };
}

test('pairing page is public, uncached and contains no embedded credentials', async (t) => {
  const f = fixture();
  const app = await buildApp(config, f.gateway);
  t.after(() => app.close());
  const page = await app.inject('/pair');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type']!, /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(
    page.headers['content-security-policy']!,
    /frame-ancestors 'none'/,
  );
  const script = await app.inject('/pair/app.js');
  assert.equal(script.statusCode, 200);
  assert.doesNotThrow(() => new Script(pairScript));
  for (const key of [config.apiKey, config.adminKey]) {
    assert.ok(!page.body.includes(key));
    assert.ok(!script.body.includes(key));
  }
  assert.equal((await app.inject('/admin/session')).statusCode, 401);
  assert.equal(f.resets(), 0);
});

test('reset requires the admin key and explicit confirmation; GET cannot reset', async (t) => {
  const f = fixture();
  const app = await buildApp(config, f.gateway);
  t.after(() => app.close());
  for (const headers of [
    {},
    senderHeaders,
    { authorization: 'Bearer invalid' },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/reset',
          headers,
          payload: { confirm: 'RESET_WHATSAPP_SESSION' },
        })
      ).statusCode,
      401,
    );
  }
  for (const payload of [
    {},
    { confirm: true },
    { confirm: 'yes' },
    { confirm: 'RESET_WHATSAPP_SESSION', extra: true },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/admin/reset',
          headers: adminHeaders,
          payload,
        })
      ).statusCode,
      400,
    );
  }
  assert.equal(
    (await app.inject({ url: '/admin/reset', headers: adminHeaders }))
      .statusCode,
    404,
  );
  assert.equal(f.resets(), 0);
  const request = {
    method: 'POST' as const,
    url: '/admin/reset',
    headers: adminHeaders,
    payload: { confirm: 'RESET_WHATSAPP_SESSION' },
  };
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal((await app.inject(request)).statusCode, 429);
  assert.equal(f.resets(), 2);
});

test('reset rejects foreign browser origins even with a valid admin key', async (t) => {
  const f = fixture();
  const app = await buildApp(config, f.gateway);
  t.after(() => app.close());
  const request = {
    method: 'POST' as const,
    url: '/admin/reset',
    headers: {
      ...adminHeaders,
      host: 'otp.sirfbazar.com',
      origin: 'http://wrong.example',
    },
    payload: { confirm: 'RESET_WHATSAPP_SESSION' },
  };
  assert.equal((await app.inject(request)).statusCode, 403);
  assert.equal(f.resets(), 0);
  assert.equal(
    (
      await app.inject({
        ...request,
        headers: { ...request.headers, origin: 'http://otp.sirfbazar.com' },
      })
    ).statusCode,
    200,
  );
  assert.equal(f.resets(), 1);
});
