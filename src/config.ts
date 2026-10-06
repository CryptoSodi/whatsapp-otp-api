import { resolve } from 'node:path';

export interface Config {
  host: string;
  port: number;
  apiKey: string;
  adminKey: string;
  dataDir: string;
  messageTemplate: string;
  sendTimeoutMs: number;
  rateLimitMax: number;
  logLevel: 'info' | 'warn' | 'error' | 'silent';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  function secret(name: string): string {
    const value = env[name] ?? '';
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(value)) {
      throw new Error(
        `${name} must be 32-256 letters, digits, underscores or hyphens. Run npm run setup.`,
      );
    }
    return value;
  }
  function integer(name: string, fallback: number, min: number, max: number) {
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    }
    return value;
  }
  const apiKey = secret('API_KEY');
  const adminKey = secret('ADMIN_KEY');
  if (apiKey === adminKey)
    throw new Error('API_KEY and ADMIN_KEY must be different.');
  const messageTemplate =
    env.OTP_MESSAGE_TEMPLATE ??
    'Your verification code is {otp}. Do not share this code.';
  if (
    messageTemplate.length > 1000 ||
    messageTemplate.split('{otp}').length !== 2
  ) {
    throw new Error(
      'OTP_MESSAGE_TEMPLATE must contain exactly one {otp} and be at most 1000 characters.',
    );
  }
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['info', 'warn', 'error', 'silent'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be info, warn, error or silent.');
  }
  return {
    host: env.HOST ?? '127.0.0.1',
    port: integer('PORT', 3000, 1, 65535),
    apiKey,
    adminKey,
    dataDir: resolve(env.DATA_DIR ?? './data'),
    messageTemplate,
    sendTimeoutMs: integer('SEND_TIMEOUT_MS', 20000, 1000, 60000),
    rateLimitMax: integer('RATE_LIMIT_MAX', 30, 1, 10000),
    logLevel: logLevel as Config['logLevel'],
  };
}
