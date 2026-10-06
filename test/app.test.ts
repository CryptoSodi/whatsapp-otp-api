import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { buildApp } from '../src/app.js';
import { ApiError } from '../src/errors.js';
import type { WhatsAppGateway } from '../src/gateway.js';
import { config, senderHeaders, adminHeaders } from './helpers.js';

function fakeGateway() {
  const sent: { phone: string; text: string }[] = [];
  const gateway: WhatsAppGateway = {
    status: () => ({ state: 'connected' }),
    qr: () => 'test-pairing-qr',
    pairingCode: async () => 'ABCD1234',
    resetSession: async () => ({ state: 'connecting' }),
    send: async (phone, text) => {
      sent.push({ phone, text });
      return 'message-123';
    },
  };
  return { gateway, sent };
}

const urlSendKey = 'c'.repeat(64);
const sendUrl = (key = urlSendKey, otp = '001234') =>
  `/send-otp?${new URLSearchParams({ key, phone: '+923074000106', otp })}`;

test('URL sending is opt-in and requires its separate credential', async (t) => {
  const { gateway, sent } = fakeGateway();
  const disabled = await buildApp(config, gateway);
  const app = await buildApp({ ...config, urlSendKey }, gateway);
  t.after(() => Promise.all([disabled.close(), app.close()]));
  assert.equal((await disabled.inject(sendUrl())).statusCode, 404);
  for (const key of ['', 'invalid', config.apiKey, config.adminKey]) {
    assert.equal((await app.inject(sendUrl(key))).statusCode, 401);
  }
  assert.equal(
    (
      await app.inject({
        url: '/admin/session',
        headers: { authorization: `Bearer ${urlSendKey}` },
      })
    ).statusCode,
    401,
  );
  assert.equal(sent.length, 0);
  const response = await app.inject(sendUrl());
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'submitted');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.deepEqual(sent, [
    {
      phone: '+923074000106',
      text: 'Your verification code is 001234. Do not share this code.',
    },
  ]);
});

test('URL sending rejects malformed queries, HEAD and explicit prefetch without sending', async (t) => {
  const { gateway, sent } = fakeGateway();
  const app = await buildApp({ ...config, urlSendKey }, gateway);
  t.after(() => app.close());
  for (const url of [
    sendUrl(urlSendKey, 'hello'),
    `${sendUrl()}&message=hello`,
    `${sendUrl()}&otp=654321`,
    sendUrl().replace('%2B', '+'),
  ]) {
    assert.equal((await app.inject(url)).statusCode, 400);
  }
  assert.equal(
    (await app.inject({ method: 'HEAD', url: sendUrl() })).statusCode,
    404,
  );
  for (const headers of [
    { purpose: 'prefetch' },
    { 'sec-purpose': 'prefetch;prerender' },
  ]) {
    assert.equal(
      (await app.inject({ url: sendUrl(), headers })).statusCode,
      425,
    );
  }
  assert.equal(sent.length, 0);
});

test('URL and POST sending share one rate limit in both directions', async (t) => {
  for (const urlFirst of [true, false]) {
    const { gateway, sent } = fakeGateway();
    const app = await buildApp(
      { ...config, urlSendKey, rateLimitMax: 1 },
      gateway,
    );
    t.after(() => app.close());
    const urlRequest = { method: 'GET' as const, url: sendUrl() };
    const postRequest = {
      method: 'POST' as const,
      url: '/send-otp',
      headers: senderHeaders,
      payload: { phone: '+923074000106', otp: '123456' },
    };
    assert.equal(
      (await app.inject(urlFirst ? urlRequest : postRequest)).statusCode,
      200,
    );
    assert.equal(
      (await app.inject(urlFirst ? postRequest : urlRequest)).statusCode,
      429,
    );
    assert.equal(sent.length, 1);
  }
});

test('URL credentials and OTP never appear in application logs or error responses', async (t) => {
  let logs = '';
  const logger = pino(
    {},
    new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    }),
  );
  const { gateway } = fakeGateway();
  gateway.send = async () => {
    throw new Error(`provider error ${urlSendKey} 007654`);
  };
  const app = await buildApp({ ...config, urlSendKey }, gateway, logger);
  t.after(() => app.close());
  const response = await app.inject(sendUrl(urlSendKey, '007654'));
  assert.equal(response.statusCode, 500);
  for (const secret of [
    urlSendKey,
    '007654',
    '+923074000106',
    '%2B923074000106',
  ]) {
    assert.ok(!logs.includes(secret));
    assert.ok(!response.body.includes(secret));
  }
});

test('requires the correct scoped key; health is public', async (t) => {
  const { gateway, sent } = fakeGateway();
  const app = await buildApp(config, gateway);
  t.after(() => app.close());
  assert.equal((await app.inject('/health')).statusCode, 200);
  for (const headers of [
    {},
    adminHeaders,
    { authorization: 'Bearer invalid' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/send-otp',
      headers,
      payload: { phone: '+923001234567', otp: '123456' },
    });
    assert.equal(response.statusCode, 401);
  }
  assert.equal(
    (await app.inject({ url: '/admin/session', headers: senderHeaders }))
      .statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: '/admin/session', headers: adminHeaders }))
      .statusCode,
    200,
  );
  assert.equal(sent.length, 0);
});

test('sends caller-supplied OTP verbatim including leading zeros', async (t) => {
  const { gateway, sent } = fakeGateway();
  const app = await buildApp(config, gateway);
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/send-otp',
    headers: senderHeaders,
    payload: { phone: '+923001234567', otp: '001234' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'submitted');
  assert.equal(response.json().messageId, 'message-123');
  assert.deepEqual(sent, [
    {
      phone: '+923001234567',
      text: 'Your verification code is 001234. Do not share this code.',
    },
  ]);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(!response.body.includes('001234'));
});

test('rejects malformed bodies and arbitrary messages before sending', async (t) => {
  const { gateway, sent } = fakeGateway();
  const app = await buildApp(config, gateway);
  t.after(() => app.close());
  const invalid = [
    {},
    { phone: '03001234567', otp: '123456' },
    { phone: '+012345678', otp: '123456' },
    { phone: '+923001234567', otp: 123456 },
    { phone: '+923001234567', otp: '123' },
    { phone: '+923001234567', otp: '12345678901' },
    { phone: '+923001234567', otp: 'spam' },
    { phone: '+923001234567', otp: '123456', text: 'arbitrary text' },
  ];
  for (const payload of invalid) {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/send-otp',
          headers: senderHeaders,
          payload,
        })
      ).statusCode,
      400,
    );
  }
  const large = await app.inject({
    method: 'POST',
    url: '/send-otp',
    headers: senderHeaders,
    payload: { phone: '+923001234567', otp: '1'.repeat(3000) },
  });
  assert.equal(large.statusCode, 413);
  assert.equal(sent.length, 0);
});

test('rate limits the sender globally, including requests with spoofed forwarding headers', async (t) => {
  const { gateway, sent } = fakeGateway();
  const app = await buildApp({ ...config, rateLimitMax: 1 }, gateway);
  t.after(() => app.close());
  const request = {
    method: 'POST' as const,
    url: '/send-otp',
    headers: senderHeaders,
    payload: { phone: '+923001234567', otp: '123456' },
  };
  assert.equal((await app.inject(request)).statusCode, 200);
  const limited = await app.inject({
    ...request,
    headers: { ...senderHeaders, 'x-forwarded-for': '1.2.3.4' },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, 'RATE_LIMITED');
  assert.equal(sent.length, 1);
});

test('reports disconnected sessions and never claims recipient delivery', async (t) => {
  const { gateway } = fakeGateway();
  gateway.status = () => ({ state: 'reconnecting' });
  gateway.send = async () => {
    throw new ApiError(503, 'WHATSAPP_UNAVAILABLE', 'Not connected');
  };
  const app = await buildApp(config, gateway);
  t.after(() => app.close());
  assert.equal(
    (await app.inject({ url: '/ready', headers: senderHeaders })).statusCode,
    503,
  );
  const result = await app.inject({
    method: 'POST',
    url: '/send-otp',
    headers: senderHeaders,
    payload: { phone: '+923001234567', otp: '123456' },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.json().error.code, 'WHATSAPP_UNAVAILABLE');
});

test('pairing routes are protected, uncached, and provide QR SVG or code', async (t) => {
  const { gateway } = fakeGateway();
  const app = await buildApp(config, gateway);
  t.after(() => app.close());
  assert.equal((await app.inject('/admin/qr')).statusCode, 401);
  const qr = await app.inject({ url: '/admin/qr', headers: adminHeaders });
  assert.equal(qr.statusCode, 200);
  assert.match(qr.body, /<svg/);
  assert.equal(qr.headers['cache-control'], 'no-store');
  const code = await app.inject({
    method: 'POST',
    url: '/admin/pairing-code',
    headers: adminHeaders,
    payload: { phone: '+923001234567' },
  });
  assert.equal(code.json().code, 'ABCD1234');
  gateway.qr = () => undefined;
  assert.equal(
    (await app.inject({ url: '/admin/qr', headers: adminHeaders })).statusCode,
    409,
  );
});

test('logs and errors do not expose OTP, phone, credentials or raw exception data', async (t) => {
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      logs += chunk.toString();
      done();
    },
  });
  const logger = pino({}, stream);
  const { gateway } = fakeGateway();
  gateway.send = async () => {
    throw new Error('secret-provider-error 007654 +923001234567');
  };
  const app = await buildApp(config, gateway, logger);
  t.after(() => app.close());
  const result = await app.inject({
    method: 'POST',
    url: '/send-otp?otp=007654',
    headers: senderHeaders,
    payload: { phone: '+923001234567', otp: '007654' },
  });
  assert.equal(result.statusCode, 500);
  for (const secret of [
    '007654',
    '+923001234567',
    config.apiKey,
    'secret-provider-error',
  ]) {
    assert.ok(!logs.includes(secret), `Log leaked ${secret}`);
    assert.ok(!result.body.includes(secret));
  }
});
