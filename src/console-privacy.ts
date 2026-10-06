import type { Logger } from 'pino';

// libsignal writes raw session keys to console independently of Baileys' logger.
// This service uses Pino exclusively; discard third-party console arguments.
export function installConsolePrivacy(logger: Logger, target = console) {
  for (const method of [
    'log',
    'info',
    'debug',
    'warn',
    'error',
    'trace',
    'dir',
    'table',
  ] as const) {
    target[method] = () => {
      logger.debug({ method }, 'Third-party console output suppressed');
    };
  }
}
