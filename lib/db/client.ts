import { Platform } from 'react-native';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

const DB_NAME = 'kdoo_chat.db';

let dbInstance: SQLiteDatabase | null = null;
// Promise cache: prevents concurrent openDatabaseAsync() calls from
// racing and corrupting the native database handle (NullPointerException).
// The first caller's promise is reused by all subsequent callers.
let dbPromise: Promise<SQLiteDatabase | null> | null = null;

// ── Write serializer ──────────────────────────────────────────────
//
// SQLite allows only ONE writer at a time. Without serialization,
// concurrent writes (e.g. loadSessions upsert + migration + streaming
// commit) collide and throw "database is locked".
//
// This chain ensures all write operations execute sequentially.
// Read operations (SELECT) do NOT need serialization — WAL mode
// allows unlimited concurrent readers alongside a single writer.
//
// CRITICAL: expo-sqlite's native statement finalization (finalizeAsync)
// runs AFTER the JS promise resolves. Without a yield between writes,
// the next write's BEGIN can collide with the previous write's
// finalizeAsync → "NativeStatement.finalizeAsync has been rejected
// → database is locked".
//
// Usage in repos:
//   await serializeWrite(() => db.runAsync(...));
//   await serializeWrite(() => db.withTransactionAsync(async () => { ... }));
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Get the SQLite database singleton.
 *
 * Returns null on web (no native SQLite). All repository functions must
 * short-circuit on null — SQLite is an optional performance cache, not a
 * hard dependency.
 *
 * On first open, sets connection-level PRAGMAs:
 *  - WAL journal mode: concurrent readers + single writer
 *  - busy_timeout=10s: wait on lock contention instead of failing instantly
 *  - foreign_keys=ON: cascade deletes work correctly
 */
export async function getDb(): Promise<SQLiteDatabase | null> {
  if (Platform.OS === 'web') return null;
  if (dbInstance) return dbInstance;
  // Reuse in-flight promise — prevents multiple concurrent
  // openDatabaseAsync() calls that corrupt the native handle.
  if (dbPromise) return dbPromise;

  dbPromise = (async () => {
    const db = await openDatabaseAsync(DB_NAME);

    // Connection-level PRAGMAs — must run before any query.
    await db.execAsync(`PRAGMA journal_mode = WAL`);
    await db.execAsync(`PRAGMA busy_timeout = 10000`);
    await db.execAsync(`PRAGMA foreign_keys = ON`);

    dbInstance = db;
    return db;
  })();

  try {
    return await dbPromise;
  } catch (e) {
    // Reset promise so a retry can attempt reconnection.
    dbPromise = null;
    throw e;
  }
}

/**
 * Serialize a write operation to prevent "database is locked" errors.
 * All INSERT/UPDATE/DELETE/transaction calls MUST go through this.
 * Reads (SELECT) do NOT need this — WAL allows concurrent reads.
 *
 * Includes automatic retry for "database is locked" errors: expo-sqlite's
 * native statement finalization (finalizeAsync) runs on a separate native
 * thread and may not complete before the next JS-level write begins. The
 * retry gives the native side time to release its internal locks.
 */
export function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const attempt = (retriesLeft: number): Promise<T> =>
    fn().catch(async (err) => {
      const msg = String(err?.message || err);
      if (msg.includes('database is locked') && retriesLeft > 0) {
        // Wait 50ms for native statement finalization to drain, then retry.
        await new Promise<void>((r) => setTimeout(r, 50));
        return attempt(retriesLeft - 1);
      }
      throw err;
    });

  const result = writeChain.then(async () => {
    const r = await attempt(4); // 4 retries × 50ms = up to 200ms total backoff
    // Yield to event loop so native finalizeAsync callbacks drain.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return r;
  });
  // Swallow errors on the chain so one failed write doesn't block
  // subsequent writes. The caller still receives the rejection.
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** True when the SQLite connection is live (native only). */
export function hasDb(): boolean {
  return dbInstance !== null;
}

/** Close and drop the in-memory handle (does NOT delete the db file). */
export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.closeAsync();
    dbInstance = null;
    dbPromise = null;
  }
}
