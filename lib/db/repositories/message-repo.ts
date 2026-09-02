import type { ChatMessage, MessageContent, SourceLink } from '@/types';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb, serializeWrite } from '../client';

// ── Serialisation helpers ────────────────────────────────────────

/**
 * Everything beyond the core columns is stuffed into `content_json`
 * as a single JSON blob. This avoids schema changes when MessageContent
 * evolves and keeps search metadata (keywords, sources) co-located.
 */
interface MessageJson {
  content: MessageContent[];
  searchKeywords?: string[];
  sources?: SourceLink[];
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content_json: string;
  created_at: string;
  user_id: string;
  synced: number;
}

function rowToMessage(row: MessageRow): ChatMessage {
  const parsed = JSON.parse(row.content_json) as MessageJson;
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as ChatMessage['role'],
    content: parsed.content,
    createdAt: new Date(row.created_at),
    ...(parsed.searchKeywords ? { searchKeywords: parsed.searchKeywords } : {}),
    ...(parsed.sources ? { sources: parsed.sources } : {}),
  };
}

function messageToJson(msg: ChatMessage): MessageJson {
  const json: MessageJson = { content: msg.content };
  if (msg.searchKeywords) json.searchKeywords = msg.searchKeywords;
  if (msg.sources) json.sources = msg.sources;
  return json;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Ensure session rows exist before inserting messages (FK constraint).
 *
 * `messages.session_id` has a FOREIGN KEY → `sessions.id`. If the parent
 * row doesn't exist yet (e.g. loadMessages runs before loadSessions
 * completes, or a brand-new session hasn't been persisted), the INSERT
 * would throw "FOREIGN KEY constraint failed".
 *
 * Uses `INSERT OR IGNORE` so:
 *  - existing sessions are untouched (PK conflict → skip)
 *  - missing sessions get a minimal stub row that satisfies the FK
 *
 * Stubs are overwritten later by `upsertSessions` (INSERT OR REPLACE)
 * with real title / last_message / updatedAt.
 */
async function ensureSessionRows(
  db: SQLiteDatabase,
  sessionId: string,
  fallbackIsoTimestamp: string,
  userId: string,
): Promise<void> {
  await db.runAsync(
    `INSERT OR IGNORE INTO sessions
       (id, title, last_message, pinned, updated_at, user_id)
     VALUES (?, '', NULL, 0, ?, ?)`,
    sessionId,
    fallbackIsoTimestamp,
    userId,
  );
}

/** INSERT OR REPLACE a single message.
 *  @param synced 0 = pending upload to server (voice transcripts), 1 = already uploaded (default, chat path). */
export async function upsertMessage(
  msg: ChatMessage,
  userId: string,
  synced: number = 1,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.withTransactionAsync(async () => {
      await ensureSessionRows(db, msg.sessionId, msg.createdAt.toISOString(), userId);
      await db.runAsync(
        `INSERT OR REPLACE INTO messages
           (id, session_id, role, content_json, created_at, user_id, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        msg.id,
        msg.sessionId,
        msg.role,
        JSON.stringify(messageToJson(msg)),
        msg.createdAt.toISOString(),
        userId,
        synced,
      );
    }),
  );
}

/** Batch upsert (single transaction). All rows share the same `synced` flag. */
export async function upsertMessages(
  messages: ChatMessage[],
  userId: string,
  synced: number = 1,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.withTransactionAsync(async () => {
      // Deduplicate session IDs to avoid redundant INSERT OR IGNORE.
      const seen = new Set<string>();
      for (const m of messages) {
        if (seen.has(m.sessionId)) continue;
        seen.add(m.sessionId);
        await ensureSessionRows(db, m.sessionId, m.createdAt.toISOString(), userId);
      }
      for (const m of messages) {
        await db.runAsync(
          `INSERT OR REPLACE INTO messages
             (id, session_id, role, content_json, created_at, user_id, synced)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          m.id,
          m.sessionId,
          m.role,
          JSON.stringify(messageToJson(m)),
          m.createdAt.toISOString(),
          userId,
          synced,
        );
      }
    }),
  );
}

/** Load all messages for a session (oldest first). */
export async function getMessages(
  sessionId: string,
  userId: string,
): Promise<ChatMessage[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.getAllAsync<MessageRow>(
    `SELECT * FROM messages WHERE session_id = ? AND user_id = ?
     ORDER BY created_at ASC`,
    sessionId,
    userId,
  );
  return rows.map(rowToMessage);
}

/**
 * Load a page of messages older than a given timestamp (scroll-back
 * pagination). Queries DESC (newest first) then reverses to ASC
 * (oldest first) for consistent prepend ordering with getMessages.
 */
export async function getMessagesBefore(
  sessionId: string,
  beforeCreatedAt: Date,
  userId: string,
  limit: number = 20,
): Promise<ChatMessage[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.getAllAsync<MessageRow>(
    `SELECT * FROM messages
     WHERE session_id = ? AND user_id = ? AND created_at < ?
     ORDER BY created_at DESC
     LIMIT ?`,
    sessionId,
    userId,
    beforeCreatedAt.toISOString(),
    limit,
  );
  return rows.reverse().map(rowToMessage);
}

/** Mark messages as synced-to-server by primary key. Empty input is a no-op. */
export async function markSynced(ids: string[], userId: string): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.runAsync(
      `UPDATE messages SET synced = 1 WHERE id IN (${ids.map(() => '?').join(', ')}) AND user_id = ?`,
      ...ids,
      userId,
    ),
  );
}

/** Load unsynced (synced=0) messages for a user, optionally filtered by session.
 *  Ordered by created_at ASC for deterministic replay order. */
export async function getUnsyncedMessages(
  userId: string,
  sessionId?: string,
): Promise<ChatMessage[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = sessionId
    ? await db.getAllAsync<MessageRow>(
        `SELECT * FROM messages WHERE user_id = ? AND session_id = ? AND synced = 0
         ORDER BY created_at ASC`,
        userId,
        sessionId,
      )
    : await db.getAllAsync<MessageRow>(
        `SELECT * FROM messages WHERE user_id = ? AND synced = 0
         ORDER BY created_at ASC`,
        userId,
      );
  return rows.map(rowToMessage);
}

/** Delete a single message (e.g. empty streaming placeholder). */
export async function deleteMessage(
  messageId: string,
  userId: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.runAsync(
      `DELETE FROM messages WHERE id = ? AND user_id = ?`,
      messageId,
      userId,
    ),
  );
}

/**
 * Delete all messages for a specific session.
 *
 * Used by `loadMessages` before writing the fresh server snapshot to
 * eliminate the dual-id problem: local addMessage() writes rows with
 * client-generated ids (m_N_timestamp), while server fetches write rows
 * with server ids. INSERT OR REPLACE dedupes by PRIMARY KEY (id), so
 * the two id-spaces accumulate as duplicate rows. Deleting by session_id
 * before the server write makes SQLite a faithful mirror of the server
 * state for that session.
 */
export async function deleteMessagesBySession(
  sessionId: string,
  userId: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.runAsync(
      `DELETE FROM messages WHERE session_id = ? AND user_id = ?`,
      sessionId,
      userId,
    ),
  );
}

/**
 * Atomically replace ALL messages for a session.
 *
 * DELETE + INSERT in a single `serializeWrite` + single transaction.
 * Eliminates the two-step `deleteMessagesBySession().then(() => upsertMessages())`
 * pattern that created a queue gap where concurrent writes (e.g. loadSessions
 * upsert) could interleave and trigger "database is locked" on the native
 * statement finalizer.
 */
export async function replaceMessagesBySession(
  sessionId: string,
  messages: ChatMessage[],
  userId: string,
  synced: number = 1,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.withTransactionAsync(async () => {
      // 1. Wipe existing rows for this session
      await db.runAsync(
        `DELETE FROM messages WHERE session_id = ? AND user_id = ?`,
        sessionId,
        userId,
      );
      // 2. Ensure parent session row exists (FK constraint)
      if (messages.length > 0) {
        await ensureSessionRows(
          db,
          sessionId,
          messages[0].createdAt.toISOString(),
          userId,
        );
      }
      // 3. Insert new server snapshot
      for (const m of messages) {
        await db.runAsync(
          `INSERT OR REPLACE INTO messages
             (id, session_id, role, content_json, created_at, user_id, synced)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          m.id,
          m.sessionId,
          m.role,
          JSON.stringify(messageToJson(m)),
          m.createdAt.toISOString(),
          userId,
          synced,
        );
      }
    }),
  );
}

/** Delete all messages for a user (logout isolation). */
export async function deleteAllMessages(userId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.runAsync(`DELETE FROM messages WHERE user_id = ?`, userId),
  );
}
