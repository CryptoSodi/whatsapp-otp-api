import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { buildApp } from '../src/app.js';
import type { WhatsAppGateway } from '../src/gateway.js';
import { config, senderHeaders, adminHeaders } from './helpers.js';

const urlSendKey = 'c'.repeat(64);
const phone = '+923074000106';
const url = (message: string, key = urlSendKey) =>
  `/send-message?${new URLSearchParams({ key, phone, message })}`;
function fakeGateway() {
  const sent: { phone: string; text: string }[] = [];
  const gateway: WhatsAppGateway = {
    status: () => ({ state: 'connected' }),
    qr: () => undefined,
    pairingCode: async () => 'ABCD1234',
    send: async (phone, text) => {
      sent.push({ phone, text });
      return 'message-123';
    },
  };
  return { gateway, sent };
}

test('custom text is preserved through POST and URL including Unicode, newlines, and URL punctuation', async (t) => {
  const { gateway, sent } = fakeGateway();
  const app = await buildApp({ ...config, urlSendKey }, gateway);
  t.after(() => app.close());
  const message = 'Sirfbazar: *001234*\nآپ کا کوڈ ✅ A&B + 50% ? #';
  for (const request of [
    {
      method: 'POST' as const,
      url: '/send-message',
      headers: senderHeaders,
      payload: { phone, message },
    },
    { method: 'GET' as const, url: url(message) },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'submitted');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(!response.body.includes(message));
  }
  assert.deepEqual(sent, [
    { phone, text: message },
    { phone, text: message },
  ]);
  const unicode = '😀'.repeat(1000);
  // JSON-escaped surrogate pairs must also fit the POST body limit.
  const escaped = JSON.stringify({ phone, message: unicode }).replaceAll(
    '😀',
    '\\ud83d\\ude00',
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/send-message',
        headers: { ...senderHeaders, 'content-type': 'application/json' },
        payload: escaped,
      })
    ).statusCode,
    200,
  );
  assert.equal(sent.at(-1)?.text, unicode);
});

test('custom message credentials remain scoped and probes never send', async (t) => {
  const { gateway, sent } = fakeGateway();
  const app = await buildApp({ ...config, urlSendKey }, gateway);
  const disabled = await buildApp(config, gateway);
  t.after(() => Promise.all([app.close(), disabled.close()]));
  assert.equal((await disabled.inject(url('Hello'))).statusCode, 404);
  for (const headers of [
    {},
    adminHeaders,
    { authorization: `Bearer ${urlSendKey}` },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/send-message',
          headers,
          payload: { phone, message: 'Hello' },
        })
      ).statusCode,
      401,
    );
  }
  for (const key of ['', config.apiKey, config.adminKey]) {
    assert.equal((await app.inject(url('Hello', key))).statusCode, 401);
  }
  assert.equal(
    (await app.inject({ method: 'HEAD', url: url('Hello') })).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        url: url('Hello'),
        headers: { 'sec-purpose': 'prefetch' },
      })
    ).statusCode,
    425,
  );
  assert.equal(sent.length, 0);
});

test('custom message validation rejects blank, oversized, non-string and extra fields before sending', async (t) => {
  const { gateway, sent } = fakeGateway();
  const app = await buildApp({ ...config, urlSendKey }, gateway);
  t.after(() => app.close());
  for (const message of ['', ' \t\n', 'a'.repeat(1001), '😀'.repeat(1001)]) {
    assert.equal((await app.inject(url(message))).statusCode, 400);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/send-message',
          headers: senderHeaders,
          payload: { phone, message },
        })
      ).statusCode,
      400,
    );
  }
  for (const payload of [
    { phone, message: 1234 },
    { phone, message: ['Hello'] },
    { phone: '03074000106', message: 'Hello' },
    { phone, message: 'Hello', otp: '123456' },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/send-message',
          headers: senderHeaders,
          payload,
        })
      ).statusCode,
      400,
    );
  }
  assert.equal(
    (await app.inject(url('Hello') + '&message=Another')).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/send-message',
        headers: senderHeaders,
        payload: { phone, message: 'a'.repeat(20000) },
      })
    ).statusCode,
    413,
  );
  assert.equal(sent.length, 0);
});

test('all custom message and OTP routes share the same sender budget', async (t) => {
  const requests = [
    { method: 'GET' as const, url: url('Hello') },
    {
      method: 'POST' as const,
      url: '/send-message',
      headers: senderHeaders,
      payload: { phone, message: 'Hello' },
    },
    {
      method: 'GET' as const,
      url: `/send-otp?${new URLSearchParams({ key: urlSendKey, phone, otp: '123456' })}`,
    },
    {
      method: 'POST' as const,
      url: '/send-otp',
      headers: senderHeaders,
      payload: { phone, otp: '123456' },
    },
  ];
  for (const first of requests) {
    const { gateway, sent } = fakeGateway();
    const app = await buildApp(
      { ...config, urlSendKey, rateLimitMax: 1 },
      gateway,
    );
    t.after(() => app.close());
    assert.equal((await app.inject(first)).statusCode, 200);
    for (const next of requests)
      assert.equal((await app.inject(next)).statusCode, 429);
    assert.equal(sent.length, 1);
  }
});

test('custom message text and keys stay out of errors and application logs', async (t) => {
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
  const message = 'private-message-765432';
  gateway.send = async () => {
    throw new Error(message);
  };
  const app = await buildApp({ ...config, urlSendKey }, gateway, logger);
  t.after(() => app.close());
  for (const request of [
    { url: url(message) },
    {
      method: 'POST' as const,
      url: '/send-message',
      headers: senderHeaders,
      payload: { phone, message },
    },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 500);
    for (const secret of [message, urlSendKey, config.apiKey, phone]) {
      assert.ok(!logs.includes(secret));
      assert.ok(!response.body.includes(secret));
    }
  }
});
