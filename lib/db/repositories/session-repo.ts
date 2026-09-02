import type { ChatSession } from '@/types';
import { getDb, serializeWrite } from '../client';

// ── Row type (raw SQLite column shapes) ──────────────────────────

interface SessionRow {
  id: string;
  title: string;
  last_message: string | null;
  pinned: number;
  updated_at: string;
  user_id: string;
}

// ── Conversions ───────────────────────────────────────────────────

function rowToSession(row: SessionRow): ChatSession {
  return {
    id: row.id,
    title: row.title,
    lastMessage: row.last_message ?? undefined,
    updatedAt: new Date(row.updated_at),
    isPinned: row.pinned === 1,
  };
}

// ── Public API ────────────────────────────────────────────────────

/** INSERT OR REPLACE a session for the given user. */
export async function upsertSession(
  session: ChatSession,
  userId: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.runAsync(
      `INSERT OR REPLACE INTO sessions
         (id, title, last_message, pinned, updated_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      session.id,
      session.title,
      session.lastMessage ?? null,
      session.isPinned ? 1 : 0,
      session.updatedAt.toISOString(),
      userId,
    ),
  );
}

/** Batch upsert (single transaction) — used after API loadSessions. */
export async function upsertSessions(
  sessions: ChatSession[],
  userId: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.withTransactionAsync(async () => {
      for (const s of sessions) {
        await db.runAsync(
          `INSERT OR REPLACE INTO sessions
             (id, title, last_message, pinned, updated_at, user_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          s.id,
          s.title,
          s.lastMessage ?? null,
          s.isPinned ? 1 : 0,
          s.updatedAt.toISOString(),
          userId,
        );
      }
    }),
  );
}

/** Load all sessions for a user, ordered pinned-first then newest-first. */
export async function getSessions(userId: string): Promise<ChatSession[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.getAllAsync<SessionRow>(
    `SELECT * FROM sessions WHERE user_id = ?
     ORDER BY pinned DESC, updated_at DESC`,
    userId,
  );
  return rows.map(rowToSession);
}

/** Delete a single session AND its messages for the given user. */
export async function deleteSession(
  sessionId: string,
  userId: string,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.withTransactionAsync(async () => {
      await db.runAsync(
        `DELETE FROM messages WHERE session_id = ? AND user_id = ?`,
        sessionId,
        userId,
      );
      await db.runAsync(
        `DELETE FROM sessions WHERE id = ? AND user_id = ?`,
        sessionId,
        userId,
      );
    }),
  );
}

/** Wipe ALL sessions + messages for a user (logout isolation). */
export async function deleteAllSessions(userId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await serializeWrite(() =>
    db.withTransactionAsync(async () => {
      await db.runAsync(`DELETE FROM messages WHERE user_id = ?`, userId);
      await db.runAsync(`DELETE FROM sessions WHERE user_id = ?`, userId);
    }),
  );
}
