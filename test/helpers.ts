import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

export const config = loadConfig({
  API_KEY: 'a'.repeat(64),
  ADMIN_KEY: 'b'.repeat(64),
  LOG_LEVEL: 'silent',
});
export const senderHeaders = { authorization: `Bearer ${config.apiKey}` };
export const adminHeaders = { authorization: `Bearer ${config.adminKey}` };

export function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'whatsapp-otp-test-'));
  return {
    path,
    cleanup() {
      // Only known files directly inside this freshly created temporary directory.
      for (const file of readdirSync(path)) unlinkSync(join(path, file));
      rmdirSync(path);
    },
  };
}
