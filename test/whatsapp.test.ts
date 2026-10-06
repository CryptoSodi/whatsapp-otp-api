import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pino } from 'pino';
import {
  DisconnectReason,
  type UserFacingSocketConfig,
} from '@whiskeysockets/baileys';
import { openAuthStore } from '../src/auth-store.js';
import { WhatsAppClient, type Socket } from '../src/whatsapp.js';
import { ApiError } from '../src/errors.js';

function fixture(timeout = 1000) {
  const auth = openAuthStore(':memory:');
  const sockets: {
    ev: EventEmitter;
    socket: Socket;
    sent: unknown[];
    ended: boolean;
  }[] = [];
  const options: UserFacingSocketConfig[] = [];
  const factory = (config: UserFacingSocketConfig): Socket => {
    options.push(config);
    const ev = new EventEmitter();
    const record = {
      ev,
      socket: undefined as unknown as Socket,
      sent: [] as unknown[],
      ended: false,
    };
    const socket: Socket = {
      ev: ev as unknown as Socket['ev'],
      end: async () => {
        record.ended = true;
      },
      onWhatsApp: async () => [
        { jid: '923001234567@s.whatsapp.net', exists: true },
      ],
      sendMessage: async (jid, content) => {
        record.sent.push({ jid, content });
        return { key: { id: 'test-id' } };
      },
      requestPairingCode: async () => 'ABCDEFGH',
    };
    record.socket = socket;
    sockets.push(record);
    return socket;
  };
  let fatal = false;
  const client = new WhatsAppClient(
    { sendTimeoutMs: timeout },
    auth,
    pino({ level: 'silent' }),
    () => {
      fatal = true;
    },
    factory,
  );
  client.start();
  return {
    client,
    auth,
    sockets,
    options,
    fatal: () => fatal,
    async close() {
      await client.stop();
      auth.close();
    },
  };
}

const hasCode = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;

test('reset closes the old socket, rotates credentials and ignores old events', async () => {
  const f = fixture();
  try {
    const old = f.sockets[0]!;
    f.auth.state.creds.registered = true;
    old.ev.emit('connection.update', { connection: 'open' });
    const identity = Buffer.from(f.auth.state.creds.noiseKey.private);
    assert.deepEqual(await f.client.resetSession(), { state: 'connecting' });
    assert.equal(old.ended, true);
    assert.equal(f.sockets.length, 2);
    assert.equal(f.auth.state.creds.registered, false);
    assert.notDeepEqual(f.auth.state.creds.noiseKey.private, identity);
    old.ev.emit('connection.update', { connection: 'open', qr: 'stale' });
    old.ev.emit('creds.update', {});
    assert.equal(f.client.status().state, 'connecting');
    assert.equal(f.client.qr(), undefined);
    f.sockets[1]!.ev.emit('connection.update', { qr: 'fresh-qr' });
    assert.equal(f.client.qr(), 'fresh-qr');
    assert.equal(f.client.status().state, 'awaiting_pairing');
  } finally {
    await f.close();
  }
});

test('reset refuses an in-flight send and concurrent resets', async () => {
  const f = fixture();
  try {
    const old = f.sockets[0]!;
    old.ev.emit('connection.update', { connection: 'open' });
    let lookup!: (value: { jid: string; exists: boolean }[]) => void;
    old.socket.onWhatsApp = () =>
      new Promise((resolve) => {
        lookup = resolve;
      });
    const send = f.client.send('+923001234567', 'hello');
    await assert.rejects(f.client.resetSession(), hasCode('SESSION_BUSY'));
    assert.equal(old.ended, false);
    lookup([{ jid: 'recipient', exists: true }]);
    await send;
    let close!: () => void;
    old.socket.end = () =>
      new Promise((resolve) => {
        close = resolve;
      });
    const reset = f.client.resetSession();
    await assert.rejects(f.client.resetSession(), hasCode('SESSION_BUSY'));
    await assert.rejects(
      f.client.send('+923001234567', 'hello'),
      hasCode('WHATSAPP_UNAVAILABLE'),
    );
    close();
    await reset;
    assert.equal(f.sockets.length, 2);
  } finally {
    await f.close();
  }
});

test('reset refuses an in-flight pairing request and stops safely on storage failure', async () => {
  const f = fixture();
  try {
    const old = f.sockets[0]!;
    old.ev.emit('connection.update', { qr: 'qr' });
    let finish!: (code: string) => void;
    old.socket.requestPairingCode = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pair = f.client.pairingCode('+923001234567');
    await assert.rejects(f.client.resetSession(), hasCode('SESSION_BUSY'));
    finish('ABCDEFGH');
    await pair;
    f.auth.reset = () => {
      throw new Error('storage failure');
    };
    await assert.rejects(f.client.resetSession(), hasCode('RESET_FAILED'));
    assert.equal(f.fatal(), true);
    assert.equal(f.sockets.length, 1);
    assert.equal(f.client.status().state, 'error');
  } finally {
    await f.close();
  }
});

test('only sends while connected and sends to the looked-up WhatsApp JID', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.client.send('+923001234567', '001234'),
      hasCode('WHATSAPP_UNAVAILABLE'),
    );
    f.sockets[0]!.ev.emit('connection.update', { connection: 'open' });
    assert.equal(await f.client.send('+923001234567', '001234'), 'test-id');
    assert.deepEqual(f.sockets[0]!.sent, [
      { jid: '923001234567@s.whatsapp.net', content: { text: '001234' } },
    ]);
    assert.equal(f.options[0]!.enableRecentMessageCache, false);
    assert.equal(f.options[0]!.enableAutoSessionRecreation, false);
    assert.equal(f.options[0]!.shouldSyncHistoryMessage, undefined);
  } finally {
    await f.close();
  }
});

test('rejects unknown recipients and concurrent requests without sending', async () => {
  const f = fixture();
  try {
    const s = f.sockets[0]!;
    s.ev.emit('connection.update', { connection: 'open' });
    s.socket.onWhatsApp = async () => [{ jid: 'missing', exists: false }];
    await assert.rejects(
      f.client.send('+923001234567', '123456'),
      hasCode('NOT_ON_WHATSAPP'),
    );
    let resolveLookup!: (value: { jid: string; exists: boolean }[]) => void;
    s.socket.onWhatsApp = () =>
      new Promise((resolve) => {
        resolveLookup = resolve;
      });
    const first = f.client.send('+923001234567', '123456');
    await assert.rejects(
      f.client.send('+923001234567', '654321'),
      hasCode('SENDER_BUSY'),
    );
    resolveLookup([{ jid: 'recipient', exists: true }]);
    assert.equal(await first, 'test-id');
    assert.equal(s.sent.length, 1);
  } finally {
    await f.close();
  }
});

test('timeout invalidates the socket and a late lookup cannot submit an OTP', async () => {
  const f = fixture(20);
  try {
    const s = f.sockets[0]!;
    s.ev.emit('connection.update', { connection: 'open' });
    let resolveLookup!: (value: { jid: string; exists: boolean }[]) => void;
    s.socket.onWhatsApp = () =>
      new Promise((resolve) => {
        resolveLookup = resolve;
      });
    await assert.rejects(
      f.client.send('+923001234567', '123456'),
      hasCode('SEND_UNCONFIRMED'),
    );
    assert.equal(s.ended, true);
    assert.equal(f.client.status().state, 'reconnecting');
    resolveLookup([{ jid: 'recipient', exists: true }]);
    await delay(5);
    assert.equal(s.sent.length, 0);
  } finally {
    await f.close();
  }
});

test('a send error is ambiguous and is never automatically resubmitted', async () => {
  const f = fixture();
  try {
    const s = f.sockets[0]!;
    s.ev.emit('connection.update', { connection: 'open' });
    let attempts = 0;
    s.socket.sendMessage = async () => {
      attempts++;
      throw new Error('provider payload');
    };
    await assert.rejects(
      f.client.send('+923001234567', '123456'),
      hasCode('SEND_UNCONFIRMED'),
    );
    assert.equal(attempts, 1);
  } finally {
    await f.close();
  }
});

test('persists auth updates, pairs, reconnects after required restart, and ignores stale socket events', async () => {
  const f = fixture();
  try {
    const s = f.sockets[0]!;
    s.ev.emit('connection.update', { qr: 'qr-secret' });
    assert.equal(f.client.qr(), 'qr-secret');
    assert.equal(await f.client.pairingCode('+923001234567'), 'ABCDEFGH');
    s.ev.emit('creds.update', {});
    s.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: { output: { statusCode: DisconnectReason.restartRequired } },
      },
    });
    await delay(300);
    assert.equal(f.sockets.length, 2);
    f.sockets[1]!.ev.emit('connection.update', { connection: 'open' });
    s.ev.emit('connection.update', { qr: 'stale-qr', connection: 'close' });
    assert.equal(f.client.status().state, 'connected');
    assert.equal(f.client.qr(), undefined);
  } finally {
    await f.close();
  }
});

test('logged out sessions require operator action and shutdown cancels reconnects', async () => {
  const f = fixture();
  try {
    const s = f.sockets[0]!;
    s.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: { output: { statusCode: DisconnectReason.loggedOut } },
      },
    });
    assert.equal(f.client.status().state, 'logged_out');
    await delay(300);
    assert.equal(f.sockets.length, 1);
  } finally {
    await f.close();
  }
  const g = fixture();
  g.sockets[0]!.ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: {
      error: { output: { statusCode: DisconnectReason.restartRequired } },
    },
  });
  await g.close();
  await delay(300);
  assert.equal(g.sockets.length, 1);
});
