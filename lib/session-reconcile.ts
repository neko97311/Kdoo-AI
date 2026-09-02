/**
 * Pure helper for the post-`loadSessions()` reconciliation step in the
 * root layout (`app/_layout.tsx`).
 *
 * Background — the bug this guards against:
 *
 *   1. User taps a `kdoomobile://share/{id}` deep link.
 *   2. `app/share/[id].tsx` calls `forkShareApi(id)` → backend returns a
 *      NEW session B (different id, different content). It then either:
 *        (a) [before fix] `setCurrentSession(B.id)` — only sets the current
 *            pointer, never inserts B into `sessions[]`.
 *        (b) [after fix] `addSession(B)` — prepends B into `sessions[]`
 *            and sets it as current.
 *   3. Root layout's background refresh runs `loadSessions()` shortly
 *      after. If the backend hasn't fully replicated B yet (or B is
 *      paginated out, or the cache is stale), the returned `sessions[]`
 *      does NOT contain B.
 *   4. Pre-fix code at `_layout.tsx:319-321` would then null out the
 *      current pointer, dropping the user onto the empty ChatHome.
 *
 * The reconciliation rule is: "if currentSessionId points to an id that
 * no longer exists in the loaded list, clear it". Extracting it as a
 * pure function lets us:
 *
 *   - Test the exact guard logic without spinning up the layout effect,
 *     React, or any native modules.
 *   - Reuse the same rule from the share-intake login-resume effect if
 *     needed in the future.
 *   - Keep `_layout.tsx` free of branching / state-reading that belongs
 *     in the store layer.
 *
 * @module lib/session-reconcile
 */

/** Minimal shape the helper needs from a session. Keeping it loose so
 *  the same helper works for both `ChatSession` (from the store) and any
 *  future lightweight representation returned from `loadSessions()`. */
export interface SessionLike {
  id: string;
}

/**
 * Returns the value to assign to `currentSessionId` after `loadSessions()`
 * resolves. Pass-through unless the current id no longer exists in the
 * freshly-loaded list — in which case it is cleared (returns `null`).
 *
 * @param currentSessionId  The current `currentSessionId` from the store.
 * @param sessions          The freshly-loaded session list (from API or
 *                          SQLite hydration).
 * @returns                 The new `currentSessionId` to apply.
 */
export function reconcileCurrentSessionId<
  S extends SessionLike,
>(
  currentSessionId: string | null,
  sessions: ReadonlyArray<S>,
): string | null {
  if (
    currentSessionId !== null &&
    !sessions.some((s) => s.id === currentSessionId)
  ) {
    return null;
  }
  return currentSessionId;
}
