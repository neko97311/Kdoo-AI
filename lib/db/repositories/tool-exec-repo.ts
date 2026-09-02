import { getDb, serializeWrite } from '../client';

/**
 * Client-executed tool dedup markers (e.g. callPhoneTool auto-dial on
 * message arrival).
 *
 * Why a dedicated table (not a column on `messages`):
 *  - toolCallId is a globally-unique key, making this a self-contained
 *    key->flag store - no new field needs threading through
 *    ChatMessage / content_json / store hydration.
 *  - `CREATE TABLE IF NOT EXISTS` is idempotent: existing installs get
 *    the table on the next initDb without an ALTER TABLE migration.
 *
 * Rows are tiny and pruned by age on initDb - markers only matter inside
 * the 30s auto-dial window (AUTO_DIAL_MAX_AGE_MS in
 * CallPhoneToolRenderer).
 */

/** toolCallIds claimed during THIS app session - synchronous, race-proof. */
const sessionClaimed = new Set<string>();

/**
 * Session-level claim on a tool call. Returns false when this app session
 * already claimed (executed / is executing) the given toolCallId.
 *
 * MUST run synchronously BEFORE the async SQLite check below - claiming
 * here closes the remount race where a second mount could pass the async
 * DB check before the first mount's INSERT lands.
 */
export function claimToolCallExecution(toolCallId: string): boolean {
  if (sessionClaimed.has(toolCallId)) return false;
  sessionClaimed.add(toolCallId);
  return true;
}

/**
 * Device-level marker check - survives cold restarts. Returns false when
 * the DB is unavailable (the caller's time guard still applies).
 */
export async function hasToolCallExecuted(toolCallId: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const rows = await db.getAllAsync<{ marker: number }>(
    'SELECT 1 AS marker FROM client_tool_executed WHERE tool_call_id = ? LIMIT 1',
    toolCallId,
  );
  return rows.length > 0;
}

/** Persist the executed marker (idempotent upsert). */
export async function markToolCallExecuted(toolCallId: string): Promise<void> {
  const db = await getDb();
  if (!db) return; // session-level claim above still applies for this app run
  await serializeWrite(() =>
    db.runAsync(
      'INSERT OR REPLACE INTO client_tool_executed (tool_call_id, executed_at) VALUES (?, ?)',
      toolCallId,
      Date.now(),
    ),
  );
}
