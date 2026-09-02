import type { ChatMessage } from '@/types';

/**
 * Merge server snapshot with local messages for the background-refresh path
 * in `useChatStore.loadMessages`.
 *
 * Why this exists
 * ────────────────
 * Cold-start flow:
 *   1. MMKV (synchronous) → rehydrate `messages[currentSessionId]` with the
 *      last 50 cached messages — including any optimistic messages whose
 *      SQLite sync hadn't completed before the OS killed the app.
 *   2. SQLite (async, ~tens to hundreds of ms) → `hydrateFromSQLite()`
 *      overlays the canonical server state for the current session.
 *   3. API (async, network) → `loadMessages(sessionId, { backgroundRefresh: true })`
 *      fetches the fresh server snapshot and merges it on top.
 *
 * Step 3 is where messages used to "blink" or "disappear". Two distinct
 * root causes were fixed here:
 *
 *   (a) ORDER BUG — The original code concatenated the server snapshot
 *       (typically DESC) with local-only messages (always ASC, because
 *       local appends go to the tail) without re-sorting, so FlatList
 *       rendered a scrambled order that *looked* like middle messages had
 *       vanished.
 *
 *   (b) REFERENCE-STABILITY BUG — Even after fixing the order, every
 *       backgroundRefresh produced a brand-new array (because of `.sort()`
 *       and `[...]` spread). Zustand's `Object.is` check on the selector
 *       result then triggered a FlatList re-render on EVERY API poll,
 *       even when nothing changed. Re-renders reset visible-window
 *       calculations and can briefly collapse the rendered range,
 *       reproducing the "中间消息不见" flicker observed by the user.
 *       Fix: when the merge is a no-op (server confirms what we already
 *       have, no placeholders to drop, local already sorted), return
 *       `localMessages` BY REFERENCE so Zustand skips the re-render.
 *
 * What this function guarantees
 * ─────────────────────────────
 *   - Every message has a unique id (server duplicates dropped defensively).
 *   - Local-only messages (not on the server, and not a client placeholder)
 *     are preserved — e.g. optimistic messages whose SQLite write was lost.
 *   - Client-generated placeholders (`id` matching `m_N_timestamp` from
 *     `addMessage`) are dropped: by the time the active-stream guard at the
 *     call site has returned, those rows are already represented in the
 *     server snapshot under their real UUID.
 *   - Output is sorted by `createdAt` ASC — chronological order, the
 *     invariant `ChatView`'s FlatList relies on.
 *   - Reference stability: when the merge would produce an array
 *     structurally equal to `localMessages`, return `localMessages` itself
 *     so downstream selectors / FlatList skip the re-render.
 *
 * Edge cases
 * ──────────
 *   - `serverMessages = []` → returns `localOnly` (call-site already guards
 *     against this with `converted.length > 0` before SQLite sync, but the
 *     merge is still safe and useful for in-memory state).
 *   - `localMessages = []` → returns the deduped, *sorted* server snapshot.
 *   - Same id appears in both → server wins (local is treated as local-only
 *     and filtered out), preventing duplicate bubbles in FlatList.
 *   - Server confirms exactly what local has (no-op) → returns
 *     `localMessages` by reference (no new array allocation, no FlatList
 *     re-render).
 */
export function mergeMessagesForBackgroundRefresh(
  serverMessages: readonly ChatMessage[],
  localMessages: readonly ChatMessage[],
): ChatMessage[] {
  // 1. Dedupe server snapshot defensively (API can occasionally return dupes
  //    around cursor boundaries; mergeItemParts usually catches it upstream
  //    but this is the last line of defence before the UI).
  const dedupedServer = serverMessages.filter(
    (m, idx, arr) => arr.findIndex((x) => x.id === m.id) === idx,
  );
  const serverIds = new Set(dedupedServer.map((m) => m.id));

  // 2. Orphan deletion (route-1): a local-only message (id NOT on server)
  //    is kept iff (a) id does NOT start with 'm_' AND (b) it is the newest
  //    (max createdAt) among ALL localMessages. A real-id local-only message
  //    that is NOT the newest is a stale orphan — its send likely failed and
  //    a newer message has since been sent. Only the newest might still be
  //    legitimately in-flight (pending server confirmation).
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

  // 3. Reference-stability short-circuit. If the merge would be a no-op
  //    (server subset of local, no orphans/placeholders to drop, local
  //    already sorted, total length preserved), return `localMessages`
  //    BY REFERENCE so Zustand's Object.is selector check skips the
  //    FlatList re-render.
  //
  //    The orphan condition added for route-1: every local-only message
  //    must survive the orphan filter (i.e. be non-m_ AND be the newest).
  //    If any local-only message would be dropped as a stale orphan, the
  //    merge is NOT a no-op and we fall through to the real merge.
  //
  //    Safety: the cast is safe because every caller in this codebase
  //    passes a mutable ChatMessage[] (the store's `state.messages[sid]`
  //    array); the `readonly` in the parameter type is purely a defensive
  //    promise that we won't mutate the input, which we don't.
  if (
    localMessages.length > 0 &&
    dedupedServer.length <= localMessages.length &&
    dedupedServer.every((m) => localMessages.some((l) => l.id === m.id)) &&
    localMessages.every(
      (m) =>
        serverIds.has(m.id) ||
        (!m.id.startsWith('m_') &&
          new Date(m.createdAt).getTime() === maxLocalCreatedAt),
    ) &&
    isSortedAscByCreatedAt(localMessages)
  ) {
    return localMessages as ChatMessage[];
  }

  // 4. Re-check after server dedupe (in case local carried an id the server
  //    listed twice but local had once — local is still preserved because
  //    `localOnly` is computed against the deduped server set above).
  const finalLocal = localOnly.filter((m) => !serverIds.has(m.id));

  // 5. Sort ASC by createdAt — chronological order is the invariant the
  //    FlatList at ChatView.tsx relies on. Without this step the concat
  //    produces a DESC-then-ASC list that scrolls visibly out of order.
  return [...dedupedServer, ...finalLocal].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * Check whether `messages` is sorted by `createdAt` ASC (monotonic
 * non-decreasing). Used by `mergeMessagesForBackgroundRefresh` to decide
 * whether the no-op short-circuit can preserve the input reference.
 *
 * Note: in practice `localMessages` is always sorted ASC because
 * `addMessage` appends to the tail with `new Date()` (monotonic per
 * session). This helper exists as a safety net for any code path that
 * could break that invariant.
 */
function isSortedAscByCreatedAt(
  messages: readonly ChatMessage[],
): boolean {
  for (let i = 1; i < messages.length; i++) {
    const prev = new Date(messages[i - 1].createdAt).getTime();
    const curr = new Date(messages[i].createdAt).getTime();
    if (curr < prev) return false;
  }
  return true;
}
