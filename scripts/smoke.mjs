import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const dataDir = await mkdtemp(join(tmpdir(), 'whatsapp-otp-smoke-'));
const apiKey = randomBytes(32).toString('hex');
const adminKey = randomBytes(32).toString('hex');
let output = '';
const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    API_KEY: apiKey,
    ADMIN_KEY: adminKey,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});
let spawnError;
child.on('error', (error) => {
  spawnError = error;
});
const exited = new Promise((resolve) => child.once('exit', resolve));
const base = `http://127.0.0.1:${port}`;
try {
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null)
      throw new Error('Server stopped before health check');
    try {
      const health = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (health.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* listener is still starting */
    }
    await delay(200);
  }
  assert.ok(healthy, 'Server must become healthy');
  assert.equal((await fetch(`${base}/admin/session`)).status, 401);
  const session = await fetch(`${base}/admin/session`, {
    headers: { authorization: `Bearer ${adminKey}` },
  });
  assert.equal(session.status, 200);
  assert.ok(
    ['connecting', 'awaiting_pairing', 'reconnecting'].includes(
      (await session.json()).state,
    ),
  );
  const send = await fetch(`${base}/send-otp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ phone: '+923001234567', otp: '098765' }),
  });
  // A fresh, unpaired session must reject sending; no message can be submitted.
  assert.equal(send.status, 503);
  assert.equal((await send.json()).error.code, 'WHATSAPP_UNAVAILABLE');
  for (const value of [apiKey, adminKey, '098765', '+923001234567'])
    assert.ok(!output.includes(value));
  console.log(
    'Built server smoke test passed: liveness, admin auth, unpaired send rejection, and log privacy. No message sent.',
  );
} finally {
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  // Only direct files and the empty lock directory inside our fresh temp directory.
  for (const entry of await readdir(dataDir, { withFileTypes: true })) {
    const path = join(dataDir, entry.name);
    if (entry.isDirectory()) await rmdir(path);
    else await unlink(path);
  }
  await rmdir(dataDir);
  // proper-lockfile's lock is adjacent to DATA_DIR and may remain after Windows termination.
  await rmdir(`${dataDir}.lock`).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
