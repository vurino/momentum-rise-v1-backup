import * as SQLite from "expo-sqlite";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";

const DB_NAME = "momentum.db";
const KEY_STORAGE_KEY = "momentum_db_encryption_key";

/** Turns raw random bytes into a hex string, safe to use as a SQLCipher
 * PRAGMA key passphrase (SQLCipher runs its own PBKDF2 over this value
 * internally, same as it would over a human-typed password — the
 * difference is this "password" already has 256 bits of real entropy). */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getOrCreateEncryptionKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY_STORAGE_KEY);
  if (existing) return existing;

  // Generated once per install and never leaves this device. SecureStore is
  // backed by the Android Keystore, so the key itself is encrypted at rest
  // by the OS, separately from (and beneath) the SQLCipher layer it protects.
  const randomBytes = await Crypto.getRandomBytesAsync(32);
  const key = toHex(randomBytes);
  await SecureStore.setItemAsync(KEY_STORAGE_KEY, key);
  return key;
}

let dbInstance: SQLite.SQLiteDatabase | null = null;
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** Opens (or creates, on first launch) the encrypted local database and
 * ensures the schema exists. Safe to call from multiple places — the
 * underlying open + key + migration work only happens once; every caller
 * after that gets the same already-open connection. */
export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) return dbInstance;
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    const key = await getOrCreateEncryptionKey();
    const db = await SQLite.openDatabaseAsync(DB_NAME);

    // Must be the first statement run against a freshly-opened SQLCipher
    // database, before any table access — this is what turns the on-disk
    // file from plain SQLite into an encrypted SQLCipher database.
    await db.execAsync(`PRAGMA key = '${key}';`);

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS schedule_slots (
        id TEXT PRIMARY KEY NOT NULL,
        label TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT 'clock',
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        "group" TEXT NOT NULL DEFAULT 'general',
        order_index INTEGER NOT NULL,
        days TEXT NOT NULL,
        specific_date TEXT,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS daily_tasks (
        id TEXT PRIMARY KEY NOT NULL,
        date TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        stopped INTEGER NOT NULL DEFAULT 0,
        auto_skipped INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        name TEXT,
        start_time TEXT,
        end_time TEXT,
        duration INTEGER,
        started_at TEXT,
        completed_at TEXT,
        stopped_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_daily_tasks_date ON daily_tasks(date);
      CREATE INDEX IF NOT EXISTS idx_daily_tasks_slot_id ON daily_tasks(slot_id);

      -- Small key/value table for app-level bookkeeping — currently just the
      -- "cleared_today_date" marker Settings' "Clear today's tasks" writes,
      -- so Today knows which activities were deliberately cleared and
      -- shouldn't be regenerated for that one date.
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT,
        slot_ids TEXT
      );
    `);

    dbInstance = db;
    return db;
  })();

  return dbPromise;
}

/** Test-only escape hatch: forces the next getDatabase() call to reopen from
 * scratch. Not used by the app itself. */
export function _resetDatabaseForTests() {
  dbInstance = null;
  dbPromise = null;
}
