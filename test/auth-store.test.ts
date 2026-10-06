import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { openAuthStore } from '../src/auth-store.js';
import { temporaryDirectory } from './helpers.js';

test('persists credentials and Signal/LID keys through process-style reopening', async () => {
  const temp = temporaryDirectory();
  const filename = join(temp.path, 'session.sqlite');
  let store = openAuthStore(filename);
  try {
    const originalKey = Buffer.from(store.state.creds.noiseKey.private);
    store.state.creds.registered = true;
    store.saveCreds();
    await store.state.keys.set({
      session: { recipient: Buffer.from([1, 2, 3, 255]) },
      'lid-mapping': { phone: '12345@lid' },
      'device-list': { recipient: ['1', '2'] },
      'app-state-sync-key': { sync: { keyData: Buffer.from([9, 8, 7]) } },
    });
    store.close();
    store = openAuthStore(filename);
    assert.equal(store.state.creds.registered, true);
    assert.deepEqual(store.state.creds.noiseKey.private, originalKey);
    assert.deepEqual(
      (await store.state.keys.get('session', ['recipient'])).recipient,
      Buffer.from([1, 2, 3, 255]),
    );
    assert.equal(
      (await store.state.keys.get('lid-mapping', ['phone'])).phone,
      '12345@lid',
    );
    assert.deepEqual(
      (await store.state.keys.get('device-list', ['recipient'])).recipient,
      ['1', '2'],
    );
    assert.deepEqual(
      (await store.state.keys.get('app-state-sync-key', ['sync'])).sync
        ?.keyData,
      Buffer.from([9, 8, 7]),
    );
    await store.state.keys.set({ session: { recipient: null } });
    assert.equal(
      (await store.state.keys.get('session', ['recipient'])).recipient,
      undefined,
    );
  } finally {
    store.close();
    temp.cleanup();
  }
});

test('rolls back the entire key batch on an invalid write', async () => {
  const store = openAuthStore(':memory:');
  try {
    await store.state.keys.set({ session: { existing: Buffer.from('old') } });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await assert.rejects(async () =>
      store.state.keys.set({
        session: {
          existing: Buffer.from('new'),
          broken: cyclic as unknown as Buffer,
        },
      }),
    );
    assert.deepEqual(
      (await store.state.keys.get('session', ['existing'])).existing,
      Buffer.from('old'),
    );
  } finally {
    store.close();
  }
});

test('reset persists a fresh identity and rejects writes from the old socket auth state', async () => {
  const temp = temporaryDirectory();
  const filename = join(temp.path, 'session.sqlite');
  let store = openAuthStore(filename);
  try {
    const old = store.state;
    old.creds.registered = true;
    store.saveCreds();
    await old.keys.set({ session: { old: Buffer.from('old-session') } });
    store.reset();
    const freshKey = Buffer.from(store.state.creds.noiseKey.private);
    assert.equal(store.state.creds.registered, false);
    assert.notDeepEqual(freshKey, old.creds.noiseKey.private);
    await old.keys.set({ session: { stale: Buffer.from('late-write') } });
    assert.deepEqual(await old.keys.get('session', ['old']), {});
    assert.deepEqual(
      await store.state.keys.get('session', ['old', 'stale']),
      {},
    );
    await store.state.keys.set({
      session: { new: Buffer.from('new-session') },
    });
    store.close();
    store = openAuthStore(filename);
    assert.equal(store.state.creds.registered, false);
    assert.deepEqual(store.state.creds.noiseKey.private, freshKey);
    assert.deepEqual(
      (await store.state.keys.get('session', ['new'])).new,
      Buffer.from('new-session'),
    );
    assert.deepEqual(
      await store.state.keys.get('session', ['old', 'stale']),
      {},
    );
  } finally {
    store.close();
    temp.cleanup();
  }
});
