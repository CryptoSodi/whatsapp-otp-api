import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

// This database stores WhatsApp credentials and encryption keys, never OTP requests.
// Keys are kept generic so new Baileys key types (including LID mappings) persist too.
export function openAuthStore(filename: string) {
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec(
    'PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;',
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS auth (category TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (category, id))',
  );
  const select = db.prepare(
    'SELECT value FROM auth WHERE category = ? AND id = ?',
  );
  const put = db.prepare(
    'INSERT INTO auth(category,id,value) VALUES(?,?,?) ON CONFLICT(category,id) DO UPDATE SET value=excluded.value',
  );
  const remove = db.prepare('DELETE FROM auth WHERE category = ? AND id = ?');
  function read(category: string, id: string) {
    const row = select.get(category, id);
    return row
      ? JSON.parse(row.value as string, BufferJSON.reviver)
      : undefined;
  }
  let generation = 0;
  function createState(
    creds: AuthenticationState['creds'],
    version: number,
  ): AuthenticationState {
    return {
      creds,
      keys: {
        async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          if (version !== generation) return result;
          for (const id of ids) {
            let value = read(type, id);
            if (value !== undefined) {
              if (type === 'app-state-sync-key')
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              result[id] = value;
            }
          }
          return result;
        },
        async set(data) {
          // A closed socket must not repopulate a newly reset session.
          if (version !== generation) return;
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const [category, values] of Object.entries(data)) {
              for (const [id, value] of Object.entries(values ?? {})) {
                if (value == null) remove.run(category, id);
                else
                  put.run(
                    category,
                    id,
                    JSON.stringify(value, BufferJSON.replacer),
                  );
              }
            }
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        },
      },
    };
  }
  let state = createState(
    read('credentials', 'current') ?? initAuthCreds(),
    generation,
  );
  return {
    get state() {
      return state;
    },
    reset() {
      const next = createState(initAuthCreds(), generation + 1);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM auth');
        put.run(
          'credentials',
          'current',
          JSON.stringify(next.creds, BufferJSON.replacer),
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      generation++;
      state = next;
    },
    saveCreds() {
      put.run(
        'credentials',
        'current',
        JSON.stringify(state.creds, BufferJSON.replacer),
      );
    },
    close() {
      db.close();
    },
  };
}
