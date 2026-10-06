import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { installConsolePrivacy } from '../src/console-privacy.js';
import { pino } from 'pino';

test('configuration fails closed for missing/shared keys and invalid settings', () => {
  const env = { API_KEY: 'a'.repeat(64), ADMIN_KEY: 'b'.repeat(64) };
  assert.throws(() => loadConfig({}));
  assert.throws(() => loadConfig({ ...env, ADMIN_KEY: env.API_KEY }));
  assert.throws(() => loadConfig({ ...env, API_KEY: 'short' }));
  assert.throws(() => loadConfig({ ...env, URL_SEND_KEY: 'short' }));
  assert.throws(() => loadConfig({ ...env, URL_SEND_KEY: env.API_KEY }));
  assert.throws(() => loadConfig({ ...env, URL_SEND_KEY: env.ADMIN_KEY }));
  assert.equal(loadConfig(env).urlSendKey, undefined);
  assert.equal(
    loadConfig({ ...env, URL_SEND_KEY: 'c'.repeat(64) }).urlSendKey,
    'c'.repeat(64),
  );
  assert.throws(() => loadConfig({ ...env, PORT: 'NaN' }));
  assert.throws(() => loadConfig({ ...env, SEND_TIMEOUT_MS: '0' }));
  assert.throws(() =>
    loadConfig({ ...env, OTP_MESSAGE_TEMPLATE: 'Missing placeholder' }),
  );
  assert.throws(() =>
    loadConfig({ ...env, OTP_MESSAGE_TEMPLATE: '{otp} {otp}' }),
  );
  assert.throws(() => loadConfig({ ...env, LOG_LEVEL: 'debug' }));
  assert.equal(loadConfig(env).host, '127.0.0.1');
});

test('third-party console calls cannot print their secret arguments', () => {
  let leaked = false;
  const target = { ...console };
  target.info = () => {
    leaked = true;
  };
  target.warn = () => {
    leaked = true;
  };
  installConsolePrivacy(pino({ level: 'silent' }), target);
  target.info('Closing session:', { privateKey: 'secret' });
  target.warn('Session already closed', { privateKey: 'secret' });
  assert.equal(leaked, false);
});
