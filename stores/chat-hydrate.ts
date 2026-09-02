import type { ChatMessage } from '@/types';

/**
 * Merge SQLite-canonical messages with MMKV-cached messages for the
 * `useChatStore.hydrateFromSQLite` cold-start path.
 *
 * Why this exists
 * ────────────────
 * Cold-start sequence in `app/_layout.tsx`:
 *   1. MMKV (synchronous, sub-millisecond) → rehydrates the last 50 cached
 *      messages for the current session. These may include optimistic
 *      `m_N_timestamp` placeholders whose SQLite write hadn't completed
 *      before the OS killed the app.
 *   2. SQLite (async, tens to hundreds of ms) → `hydrateFromSQLite()` loads
 *      the canonical server snapshot for the current session.
 *   3. API (async, network) → `loadMessages(backgroundRefresh: true)` will
 *      run on top of this for freshness.
 *
 * This function handles step 2: merging SQLite's authoritative snapshot
 * with anything still in MMKV that SQLite doesn't know about.
 *
 * What this function guarantees
 * ─────────────────────────────
 *   - Server-side messages (from SQLite) are the source of truth.
 *   - Local-only messages whose id is NOT on the server are preserved —
 *     these are typically optimistic messages whose SQLite write was lost
 *     when the OS killed the app.
 *   - Client-generated placeholders (`id` matching `m_N_timestamp` from
 *     `addMessage`) are dropped from local-only. They are NEVER persisted
 *     to SQLite (see loadMessages active-stream guard), so allowing them
 *     through here would resurrect duplicates that conflict with the
 *     server snapshot's real UUID.
 *   - Output is sorted by `createdAt` ASC — chronological order, the
 *     invariant `ChatView`'s FlatList relies on.
 *
 * Edge cases
 * ──────────
 *   - `serverMessages = []` (cold path with empty cache) → returns sorted
 *     local-only. The caller (`hydrateFromSQLite`) treats this as
 *     "nothing to do" and skips the state set, so this branch only
 *     matters for direct callers / tests.
 *   - `localMessages = []` → returns `serverMessages` (already ASC from
 *     SQLite's `ORDER BY created_at`).
 *   - Same id in both → server wins (local treated as local-only and
 *     filtered out).
 *
 * Why this is a separate function from `mergeMessagesForBackgroundRefresh`
 * ──────────────────────────────────────────────────────────────────────
 * The two merges have different invariants:
 *   - `mergeMessagesForBackgroundRefresh` (API path): server snapshot
 *     might contain duplicates around cursor boundaries, so the server
 *     array is deduped defensively before the merge.
 *   - This function (SQLite path): SQLite's PRIMARY KEY guarantees
 *     unique ids per row, so the server array does NOT need to be deduped.
 * The contract difference would force either one of them to do wasted
 * work, or — worse — mask a real SQLite corruption by silently deduping
 * what should never have been duplicated in the first place.
 */
export function mergeMessagesForHydration(
  serverMessages: readonly ChatMessage[],
  localMessages: readonly ChatMessage[],
): ChatMessage[] {
  const serverIds = new Set(serverMessages.map((m) => m.id));

  // Orphan deletion (route-1): a local-only message (id NOT on server)
  // is kept iff (a) id does NOT start with 'm_' AND (b) it is the newest
  // (max createdAt) among ALL localMessages. A real-id local-only message
  // that is NOT the newest is a stale orphan — its send likely failed and
  // a newer message has since been sent. Only the newest might still be
  // legitimately in-flight (pending server confirmation).
  const maxLocalCreatedAt =
    localMessages.length > 0
      ? Math.max(
          ...localMessages.map((m) => new Date(m.createdAt).getTime()),
        )
      : -Infinity;

  const localOnly = localMessages.filter(
    (m) =>
      !serverIds.has(m.id) &&
      !m.id.startsWith('m_') &&
      new Date(m.createdAt).getTime() === maxLocalCreatedAt,
  );

  return [...serverMessages, ...localOnly].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}
