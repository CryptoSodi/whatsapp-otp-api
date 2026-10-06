import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pino } from 'pino';
import lockfile from 'proper-lockfile';
import { loadConfig } from './config.js';
import { openAuthStore } from './auth-store.js';
import { WhatsAppClient } from './whatsapp.js';
import { buildApp } from './app.js';
import { installConsolePrivacy } from './console-privacy.js';

process.umask(0o077);
const config = loadConfig();
const logger = pino({ level: config.logLevel });
installConsolePrivacy(logger);
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
// Exactly one process may own this account's credentials on this filesystem.
const release = await lockfile.lock(config.dataDir, {
  lockfilePath: join(config.dataDir, '.session.lock'),
  stale: 30000,
  retries: 0,
});
const auth = openAuthStore(join(config.dataDir, 'session.sqlite'));
const whatsapp = new WhatsAppClient(config, auth, logger, () => {
  void shutdown(1);
});
const app = await buildApp(config, whatsapp, logger);
let closing = false;

async function shutdown(exitCode: number) {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(1), 30000);
  force.unref();
  try {
    await app.close();
    await whatsapp.stop();
    auth.close();
    await release();
  } catch {
    logger.error('Shutdown did not complete cleanly');
    exitCode = 1;
  }
  clearTimeout(force);
  process.exit(exitCode);
}

process.on('SIGTERM', () => {
  void shutdown(0);
});
process.on('SIGINT', () => {
  void shutdown(0);
});
process.on('uncaughtException', () => {
  logger.fatal(
    'Uncaught exception; stopping without logging sensitive exception details',
  );
  void shutdown(1);
});
process.on('unhandledRejection', () => {
  logger.fatal(
    'Unhandled rejection; stopping without logging sensitive exception details',
  );
  void shutdown(1);
});
try {
  await app.listen({ host: config.host, port: config.port });
  whatsapp.start();
} catch {
  logger.error('Could not start the HTTP server');
  await shutdown(1);
}
