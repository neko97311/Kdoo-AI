/**
 * DDL statements executed once on first initDb() call.
 *
 * Design:
 *  - `user_id` column on every table for login isolation (DELETE WHERE user_id).
 *  - `content_json` stores serialised MessageContent[] + optional search metadata.
 *  - Foreign-key cascade handles message cleanup when a session is deleted.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY NOT NULL,
    title       TEXT NOT NULL,
    last_message TEXT,
    pinned      INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL,
    user_id     TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY NOT NULL,
    session_id   TEXT NOT NULL,
    role         TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    synced       INTEGER NOT NULL DEFAULT 1,    -- 0=未上传服务端,1=已上传(默认值保护历史 chat 消息)
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`,
  /**
   * Client-side "already executed" markers for client-executed tools
   * (e.g. callPhoneTool auto-dial dedup). Keyed by toolCallId (a
   * globally-unique id), so no user_id isolation is needed; rows are
   * pruned by age in initDb (see lib/db/index.ts).
   */
  `CREATE TABLE IF NOT EXISTS client_tool_executed (
    tool_call_id TEXT PRIMARY KEY NOT NULL,
    executed_at  INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session   ON messages(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_user      ON messages(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_unsynced ON messages(user_id, session_id, synced)`,
  // PRAGMA foreign_keys/journal_mode/busy_timeout are set in client.ts getDb()
] as const;
