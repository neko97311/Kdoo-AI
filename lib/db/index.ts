/**
 * SQLite cache layer — barrel export + initialisation + MMKV migration.
 *
 * Lifecycle:
 *  1. `initDb(userId)` — open connection, create tables, migrate MMKV (once).
 *  2. Repository functions (upsert/get/delete) — called from chat store.
 *  3. `clearAllUserData(userId)` — called on logout.
 *
 * On web, every function is a no-op (getDb returns null).
 */

import { Platform } from 'react-native';
import { getDb, serializeWrite } from './client';
import { SCHEMA_STATEMENTS } from './schema';
import { mmkv } from '@/lib/mmkv';
import { reviveSessions, reviveMessages } from '@/lib/serialize';
import type { ChatSession, ChatMessage } from '@/types';

// Static imports (NOT dynamic import()) so Metro bundles these into the
// main chunk. Dynamic import() causes lazy bundling: the first time
// initDb() runs (session open), Metro spends 500ms+ compiling each repo
// module, freezing the UI. With static imports they're in the initial bundle.
import {
  upsertSession,
  upsertSessions,
  getSessions,
  deleteSession,
  deleteAllSessions,
} from './repositories/session-repo';
import {
  upsertMessage,
  upsertMessages,
  getMessages,
  getMessagesBefore,
  deleteMessage,
  deleteMessagesBySession,
  deleteAllMessages,
  replaceMessagesBySession,
} from './repositories/message-repo';
export {
  upsertSession,
  upsertSessions,
  getSessions,
  deleteSession,
  deleteAllSessions,
  upsertMessage,
  upsertMessages,
  getMessages,
  getMessagesBefore,
  deleteMessage,
  deleteMessagesBySession,
  deleteAllMessages,
  replaceMessagesBySession,
};
export { getDb, hasDb, closeDb } from './client';

// ── Constants ────────────────────────────────────────────────────

const MIGRATION_KEY = 'sqlite_migrated_v1';
const MIGRATION_V2_KEY = 'sqlite_synced_column_v1';
const PERSIST_KEY = 'chat-store-v1'; // zustand persist name in chat.ts

let dbReady = false;
// Promise cache: prevents concurrent initDb() calls from racing.
// The first caller's promise is reused by all subsequent callers.
let initPromise: Promise<void> | null = null;

/** True after initDb() has completed successfully. */
export function isDbReady(): boolean {
  return dbReady;
}

// ── Initialisation ───────────────────────────────────────────────

/**
 * Open the database, create tables, and run one-time MMKV migration.
 * Safe to call multiple times — concurrent calls reuse the same promise.
 */
export async function initDb(userId: string): Promise<void> {
  if (dbReady) return;
  if (Platform.OS === 'web') {
    dbReady = true;
    return;
  }
  // Reuse in-flight promise — prevents multiple concurrent
  // initializations that race on schema creation + migration.
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const db = await getDb();
    if (!db) return;

    // 1. Create / migrate schema — serialize with all other writes to
    //    prevent "database is locked" when schema creation races with
    //    concurrent writes from repositories (e.g. upsertSession, upsertMessage).
    await serializeWrite(async () => {
      for (const stmt of SCHEMA_STATEMENTS) {
        await db.execAsync(stmt);
      }
    });

    // 1b. ALTER TABLE migration for existing users. We query pragma_table_info
    //     instead of relying on MMKV flag — robust against flag drift.
    //     Reads (PRAGMA, SELECT) don't need serialization, but DDL writes
    //     (ALTER TABLE, CREATE INDEX) MUST go through serializeWrite to
    //     prevent "database is locked" if any repository write sneaks in
    //     between the dbReady check and the DDL execution.
    const cols = await db.getAllAsync<{ name: string }>(
      `PRAGMA table_info(messages)`,
    );
    const hasSyncedCol = cols.some((c) => c.name === 'synced');
    if (!hasSyncedCol) {
      console.log('[DB] messages table missing synced column — running ALTER TABLE');
      await serializeWrite(() =>
        db.execAsync('ALTER TABLE messages ADD COLUMN synced INTEGER NOT NULL DEFAULT 1'),
      );
      console.log('[DB] ALTER TABLE messages ADD synced OK');
    }
    const idxExists = await db.getAllAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_unsynced'`,
    );
    if (idxExists.length === 0) {
      await serializeWrite(() =>
        db.execAsync('CREATE INDEX idx_messages_unsynced ON messages(user_id, session_id, synced)'),
      );
      console.log('[DB] CREATE INDEX idx_messages_unsynced OK');
    }

    // 1c. Prune stale client_tool_executed markers (client-executed tool
    //     dedup, e.g. callPhoneTool auto-dial). Markers only matter inside
    //     the 30s auto-dial window; keep 7 days so cold restarts within a
    //     week still see recent "already executed" flags.
    try {
      await serializeWrite(() =>
        db.runAsync(
          'DELETE FROM client_tool_executed WHERE executed_at < ?',
          Date.now() - 7 * 24 * 3600 * 1000,
        ),
      );
    } catch (e) {
      console.warn('[DB] prune client_tool_executed failed:', e);
    }
    mmkv.set(MIGRATION_V2_KEY, 'true');

    // 2. One-time MMKV → SQLite migration
    const alreadyMigrated = mmkv.getString(MIGRATION_KEY);
    if (alreadyMigrated !== 'true') {
      await migrateFromMmkv(userId);
      mmkv.set(MIGRATION_KEY, 'true');
    }

    dbReady = true;
  })();

  try {
    await initPromise;
  } catch (e) {
    // Reset promise so a retry can attempt reinitialization.
    initPromise = null;
    throw e;
  }
}

/**
 * Read the old MMKV-persisted chat store and bulk-insert into SQLite.
 * Silently skips if MMKV has no data or parsing fails.
 *
 * NOTE: Date objects are stored as ISO strings inside MMKV's JSON.
 * We revive them via reviveSessions / reviveMessages before inserting
 * so the repository layer receives proper Date instances.
 */
async function migrateFromMmkv(userId: string): Promise<void> {
  const raw = mmkv.getString(PERSIST_KEY);
  if (!raw) return;

  try {
    const persisted = JSON.parse(raw) as {
      state?: {
        sessions?: ChatSession[];
        messages?: Record<string, ChatMessage[]>;
      };
    };

    const state = persisted.state;
    if (!state) return;

    // ── Sessions ──
    if (state.sessions && state.sessions.length > 0) {
      const sessions = reviveSessions(state.sessions);
      await upsertSessions(sessions, userId);
    }

    // ── Messages ──
    if (state.messages) {
      const messagesMap = reviveMessages(state.messages);
      // Flatten all sessions' messages into one batch
      const allMessages: ChatMessage[] = [];
      for (const msgs of Object.values(messagesMap)) {
        allMessages.push(...msgs);
      }
      if (allMessages.length > 0) {
        await upsertMessages(allMessages, userId);
      }
    }
  } catch (e) {
    console.warn('[DB] MMKV → SQLite migration failed (non-fatal):', e);
  }
}

// ── Logout cleanup ───────────────────────────────────────────────

/**
 * Wipe all SQLite data for a user. Called from auth.ts logout().
 * Resets the migration flag so a fresh login re-migrates if needed.
 */
export async function clearAllUserData(userId: string): Promise<void> {
  await deleteAllSessions(userId);
  await deleteAllMessages(userId);
}
