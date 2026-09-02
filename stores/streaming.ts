import { create } from 'zustand';
// ── v18g PLATFORM ISOLATION ─────────────────────────────────────────────────
// Importing `react-native-nitro-markdown` directly here pulls the entire
// native-only dependency graph (ratex-react-native → RN internals → relative
// paths under `react-native/Libraries/Core/setUpReactDevTools.js`) into the
// web bundler, which fails with `Unable to resolve '../../src/private/...'`.
//
// Metro resolves `./markdownSession` per platform via the `.native.ts` /
// `.web.ts` suffix convention: native → real nitro HybridObject; web → plain
// string buffer stub. The web bundler never enters the nitro graph.
//
// See: `stores/markdownSession.native.ts` and `stores/markdownSession.web.ts`.
import { createMarkdownSession, type MarkdownSession } from './markdownSession';
import type { MessageContent, SourceLink, VideoResult } from '@/types';

// ── v15 DEBUG INSTRUMENTATION ──────────────────────────────────────────────
// Module-level counters so we can see how often updateContent() is being
// invoked during a WS stream and whether the call rate matches the WS
// token rate (or whether something else is pumping it).
const __streamingUpdateCounters = {
  total: 0, // raw updateContent() invocations (pre-throttle)
  enqueued: 0, // updaters currently sitting in pending queue
  flushed: 0, // actual store.set() calls (post-throttle)
  lastTs: 'never',
  sampleEvery: 50, // Sample every 50 RAW calls; 60s stream × 50 calls/s ≈ 60 logs
};

// ── v17 + v18f THROTTLE BATCHING ───────────────────────────────────────────
// Root cause (v15 hard evidence): WS text-delta fires ~50 calls/s → each
// triggered set() → re-render → MarkdownRenderer re-parses cumulative text.
// 50 calls/s × 100ms parse = 5x JS thread capacity → thread permanently
// blocked → touch/scroll starved → Maximum update depth → GO_BACK spam.
//
// v17 fix: coalesce multiple updateContent() calls within a window into
// a single store.set(). We keep a queue of `updater` fns and apply
// them in order on flush. Result: dramatically fewer store updates,
// MarkdownRenderer re-parses much less, JS thread recovers.
//
// ── v18f REVISION: 100ms → 30ms ─────────────────────────────────────────────
// v18f user feedback (真机回归): "文字还是感觉一块一块的出来的，可以一个字
// 一个字的出吗？出字的速度可以快一点"
//
// Root cause analysis (v18f):
//   - 100ms window × ~50 calls/s = ~5 characters per flush → 用户看到
//     "整段整段" 出现, 不是 "逐字" 出现
//   - 100ms > 视觉"逐字"阈值 (~16ms/char @ 60fps, 即每字符一帧)
//   - 但完全移除节流 (方案 B) 有 5-10% 风险让 v17 已修复的 JS 线程阻塞回归
//
// v18f fix (方案 A): 把 THROTTLE_MS 从 100ms 降到 30ms (即 ~33 updates/s):
//   - 保留节流机制, 避免 JS 线程阻塞回归 (v17 根因已根治问题)
//   - 30ms 远低于人眼 "lag" 感知 (~120ms), 用户感觉是"实时"
//   - 30ms 是 60fps 帧间隔 (~16ms) 的 ~2x, 仍能合并同一帧内的多个 delta
//   - v18e 反馈1 修复 (禁用 incrementalParsing) + MarkdownStream 内部 RAF
//     + useTransitionUpdates 三层防护已就位, 30ms 节流安全
//   - 预期: 真机看到 ~3 字符/flush (vs v17 的 ~5 字符/flush), 接近 "逐字"
//
// Combined defenses (防止 v17 回归):
//   1. THROTTLE_MS = 30ms        (本层, JS 线程 batch)
//   2. MarkdownStream updateStrategy="raf" (native 渲染层)
//   3. useTransitionUpdates       (React 优先级层)
const THROTTLE_MS = 50;
let pendingUpdaters: Array<(c: MessageContent[]) => MessageContent[]> = [];
let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPending(set: (updater: (state: StreamingState) => Partial<StreamingState>) => void): void {
  if (pendingUpdaters.length === 0) {
    pendingFlushTimer = null;
    return;
  }
  const batch = pendingUpdaters;
  pendingUpdaters = [];
  pendingFlushTimer = null;
  __streamingUpdateCounters.flushed += 1;
  set((state) => {
    // Apply each queued updater sequentially against the live state copy.
    // Each updater still receives a shallow-cloned content array (same
    // contract as before) so callers can't mutate Zustand state directly.
    let contentCopy = state.content.map((c) => ({ ...c }));
    for (const updater of batch) {
      contentCopy = updater(contentCopy);
    }
    return { content: contentCopy };
  });
}

// ── v18d NATIVE MARKDOWN SESSION MAP ───────────────────────────────────────
// Per-messageId C++ HybridObject sessions for `react-native-nitro-markdown`'s
// `MarkdownStream` API. Lives at module scope (NOT in Zustand state) because:
//
//   1. HybridObject instances must be created via `createMarkdownSession` on
//      the JS thread and `dispose()`d on unmount. Zustand state is designed
//      for serializable data — storing HybridObjects triggers
//      `getSnapshot should be cached` warnings on every state read.
//
//   2. Session references MUST be stable across re-renders. Every render of
//      MarkdownRenderer reads the same HybridObject via `sessions.get(id)`;
//      the underlying native listener stays subscribed without re-binding.
//
//   3. chat.ts's `text-delta` handler calls `session.append(delta)` BEFORE
//      throttled updateContent fires, so the native AST is always ahead of
//      the JS-visible text — MarkdownStream picks up only the new suffix
//      range on its RAF tick (instead of full re-parse).
//
// Lifecycle is coupled to startStreaming / endStreaming / reset below:
//   - startStreaming(messageId)  → sessions.set(messageId, createMarkdownSession(''))
//   - text-delta handler         → sessions.get(messageId).append(rawText)
//   - endStreaming()             → dispose + delete
//   - reset()                    → disposeAllSessions + clear map
const __sessions = new Map<string, MarkdownSession>();

/** Get or lazily create the native session for a streaming messageId. */
export function getOrCreateStreamingSession(messageId: string): MarkdownSession {
  let session = __sessions.get(messageId);
  if (!session) {
    try {
      session = createMarkdownSession('');
      __sessions.set(messageId, session);
    } catch (err) {
      console.warn(`[streaming] createMarkdownSession failed for ${messageId}:`, err);
      throw err;
    }
  }
  return session;
}

/** Append a fresh text-delta to the native session for `messageId`. No-op
 *  when no stream is active for that id (e.g. cancellation race). */
export function appendToStreamingSession(messageId: string, delta: string): void {
  const session = __sessions.get(messageId);
  if (!session) return; // stream ended before delta arrived
  try {
    session.append(delta);
  } catch (err) {
    // Native bridge error — fall back to reset so subsequent renders stay
    // consistent. MarkdownStream will re-sync from session.getAllText().
    console.warn(`[streaming] session.append failed for ${messageId}:`, err);
    try {
      session.reset(getCurrentStreamingText(messageId, delta));
    } catch (resetErr) {
      // ── v18e: triple-fail guard. Both `append` and `reset` rejected —
      //   the native side is likely torn down or the HybridObject pointer
      //   is stale (can happen after rapid session-switching races).
      //   Log + dispose + drop from Map so the next startStreaming()
      //   will lazily recreate a fresh session via getOrCreateStreamingSession.
      //   Without this, every subsequent token re-fails on the dead
      //   HybridObject and spams the device log.
      console.warn(
        `[streaming] session.reset fallback also failed for ${messageId}; disposing dead session:`,
        resetErr,
      );
      try {
        session.dispose();
      } catch {
        // already dead — ignore
      }
      __sessions.delete(messageId);
    }
  }
}

/** Internal helper used by appendToStreamingSession fallback path. */
function getCurrentStreamingText(messageId: string, fallback: string): string {
  const session = __sessions.get(messageId);
  if (!session) return fallback;
  try {
    return session.getAllText() + fallback;
  } catch {
    return fallback;
  }
}

/** Read-only accessor for a single session. Returns undefined when no
 *  stream is active for that messageId. Used by ChatBubble to pass the
 *  HybridObject into MarkdownRenderer; the renderer never mutates the
 *  session itself — only chat.ts appends deltas. */
export function getStreamingSession(messageId: string): MarkdownSession | undefined {
  return __sessions.get(messageId);
}

/**
 * Migrate a native session's key from `oldId` to `newId` WITHOUT disposing
 * or recreating the underlying HybridObject.
 *
 * Used by the `start`-event id-reconciliation path in chat.ts: the
 * placeholder assistant message is created in `sendMessage` with a client
 * UUID, but the server assigns its own UUID (carried in
 * `start.payload.messageId`). When `start` arrives we must retarget every
 * id reference to the server UUID so that:
 *   - `commitStreamingToMessages` finds the placeholder by its new id
 *   - `loadMessages` (background refresh) dedupes correctly
 *   - The native MarkdownStream keeps reading from the SAME HybridObject
 *     (only the Map key changes; the C++ AST is untouched)
 *
 * Safe to call when no session exists for `oldId` (no-op).
 */
export function migrateStreamingSession(oldId: string, newId: string): void {
  const session = __sessions.get(oldId);
  if (!session) return;
  __sessions.delete(oldId);
  __sessions.set(newId, session);
}

/** Dispose + remove a single session (called from endStreaming). */
export function disposeStreamingSession(messageId: string): void {
  const session = __sessions.get(messageId);
  if (!session) return;
  try {
    session.dispose();
  } catch (err) {
    console.warn(`[streaming] session.dispose failed for ${messageId}:`, err);
  }
  __sessions.delete(messageId);
}

/** Dispose every active session (called from reset / hard cancel). */
export function disposeAllStreamingSessions(): void {
  __sessions.forEach((session, messageId) => {
    try {
      session.dispose();
    } catch (err) {
      console.warn(`[streaming] session.dispose failed for ${messageId}:`, err);
    }
  });
  __sessions.clear();
}

/**
 * ── Physical Isolation Store (v3 Architecture) ──────────────────────
 *
 * During WS streaming, ALL incremental content writes go HERE — never to
 * `useChatStore.messages`. This freezes the messages tree so that
 * ChatView's `sessionMessages` selector returns a referentially-stable
 * array across every WS token, eliminating the O(n) reconciliation storm
 * that blocked the JS thread and starved native touch/scroll events.
 *
 * Data flow:
 *   text-delta / reasoning-delta / tool-*  →  updateContent()  →  this store
 *   [STREAM_END / cancel / error]           →  endStreaming()   →  commit to messages tree
 *
 * ChatView renders a single `<StreamingBubble>` that subscribes to this
 * store; all historical ChatBubbles are frozen and skip re-render via
 * React.memo.
 */

interface StreamingState {
  /** ID of the placeholder assistant message in the messages tree */
  messageId: string | null;
  /** Live content array (same shape as `ChatMessage.content`) */
  content: MessageContent[];
  /** Search metadata (flushed from out-of-order WS events) */
  searchKeywords?: string[];
  sources?: SourceLink[];
  videoResults?: VideoResult[];
  /** 后端透传的消息元数据(含 source: 'cron'|'webhook' 等标签,用于合并判定) */
  metadata?: Record<string, unknown>;

  // ── Actions ──

  /** Begin a new stream. Resets all fields and sets the message ID. */
  startStreaming: (messageId: string) => void;

  /**
   * Apply an updater to `content`. The updater receives a shallow-copied
   * array (each element is spread-cloned) so mutations never touch
   * Zustand state directly — same contract as the old
   * `updateStreamingContent` in chat.ts.
   */
  updateContent: (updater: (content: MessageContent[]) => MessageContent[]) => void;

  /** Update search metadata fields. */
  updateMeta: (meta: { searchKeywords?: string[]; sources?: SourceLink[]; videoResults?: VideoResult[] }) => void;

  /** 写入后端透传的消息 metadata(用于 finish 事件携带的 source 标签等). */
  setMetadata: (metadata: Record<string, unknown>) => void;

  /**
   * End streaming and return the final content array for the caller to
   * commit into the messages tree. Resets all fields to idle state.
   * Returns `null` if no stream was active.
   */
  endStreaming: () => { content: MessageContent[]; searchKeywords?: string[]; sources?: SourceLink[]; videoResults?: VideoResult[]; metadata?: Record<string, unknown> } | null;

  /** Reset to idle without returning content (used on teardown / hard cancel). */
  reset: () => void;
}

const IDLE = {
  messageId: null as string | null,
  content: [] as MessageContent[],
  searchKeywords: undefined as string[] | undefined,
  sources: undefined as SourceLink[] | undefined,
  videoResults: undefined as VideoResult[] | undefined,
  metadata: undefined as Record<string, unknown> | undefined,
};

export const useStreamingStore = create<StreamingState>((set, get) => ({
  ...IDLE,

  startStreaming: (messageId) => {
    // ── v18d: pre-create the native session BEFORE the first text-delta
    //   arrives, so chat.ts's handler can synchronously call session.append
    //   without waiting for MarkdownRenderer to mount. The session lives in
    //   a module-level Map; the text-delta handler will look it up by id.
    getOrCreateStreamingSession(messageId);
    set({ messageId, content: [], searchKeywords: undefined, sources: undefined, videoResults: undefined, metadata: undefined });
  },

  updateContent: (updater) => {
    // ── v15 DEBUG: locate the source of the independent updateContent loop.
    //   v13's `console.error` + `new Error().stack` came back EMPTY on the
    //   release build (Hermes / minification strips Error.stack). Now we:
    //     1. Use `console.log` (NOT stripped as aggressively as Error.stack)
    //     2. Maintain a module-level counter and sample every Nth call
    //        so we don't spam the device log at streaming speeds
    //     3. Include microsecond ISO timestamp + counter + stack for diagnosis
    //
    // ── v17 THROTTLE: enqueue the updater instead of calling `set` directly.
    //   All enqueued updaters within THROTTLE_MS are applied as a single
    //   batched `set`. Sample log now shows raw + queue size so we can
    //   verify the merge ratio (target: 50 raw calls → ~5 set calls).
    __streamingUpdateCounters.total += 1;
    __streamingUpdateCounters.lastTs = new Date().toISOString();
    pendingUpdaters.push(updater);
    __streamingUpdateCounters.enqueued = pendingUpdaters.length;
    if (__streamingUpdateCounters.total % __streamingUpdateCounters.sampleEvery === 0) {
      console.log(
        `[streaming.updateContent] sample #${__streamingUpdateCounters.total} ts=${__streamingUpdateCounters.lastTs} queued=${pendingUpdaters.length} flushed=${__streamingUpdateCounters.flushed} mergeRatio=${(__streamingUpdateCounters.flushed / Math.max(1, __streamingUpdateCounters.total)).toFixed(2)}`,
      );
    }
    if (pendingFlushTimer === null) {
      pendingFlushTimer = setTimeout(() => flushPending(set), THROTTLE_MS);
    }
  },

  updateMeta: (meta) => set(meta),

  setMetadata: (metadata) => set({ metadata }),

  endStreaming: () => {
    const finishedMessageId = get().messageId;
    if (!finishedMessageId) return null;
    // ── v17: flush any pending updaters synchronously BEFORE reading state
    //   and resetting to IDLE. Otherwise the last ≤100ms worth of tokens
    //   would be silently dropped on every stream end.
    if (pendingUpdaters.length > 0) {
      // Clear the timer first to prevent a racing async flush from
      // re-applying updaters after we've already reset to IDLE.
      if (pendingFlushTimer !== null) {
        clearTimeout(pendingFlushTimer);
        pendingFlushTimer = null;
      }
      const batch = pendingUpdaters;
      pendingUpdaters = [];
      // Apply batched updaters against CURRENT state (which may be stale
      // by ≤100ms relative to the raw updaters). Read get() again here
      // instead of capturing `content` from before the flush check, so the
      // caller gets the truly-final content including the last batch.
      let contentCopy = get().content.map((c) => ({ ...c }));
      for (const updater of batch) {
        contentCopy = updater(contentCopy);
      }
      const { searchKeywords, sources, videoResults, metadata } = get();
      // Iron rule v18d-fix: `IDLE` already contains `content: []` (see
      // top-level IDLE constant). When we spread IDLE AFTER `content`,
      // IDLE.content overwrites our `contentCopy`. To preserve the
      // flushed content we spread IDLE first, then explicitly override
      // content. This matches the non-flush path below which uses `set({
      // ...IDLE })` after destructuring `content` from get() and returning
      // it to the caller.
      set({ ...IDLE, content: contentCopy });
      // ── v18d: dispose the native session now that the stream is final.
      //   Doing this AFTER `set({...IDLE})` ensures the trailing tokens
      //   are committed before the session's underlying listener goes away.
      disposeStreamingSession(finishedMessageId);
      __streamingUpdateCounters.flushed += 1;
      return { content: contentCopy, searchKeywords, sources, videoResults, metadata };
    }
    const { content, searchKeywords, sources, videoResults, metadata } = get();
    set({ ...IDLE });
    // ── v18d: dispose the native session now that the stream is final.
    disposeStreamingSession(finishedMessageId);
    return { content, searchKeywords, sources, videoResults, metadata };
  },

  reset: () => {
    // ── v17: cancel any pending flush so it doesn't fire against a reset
    //   store and produce a stale set() call after teardown.
    if (pendingFlushTimer !== null) {
      clearTimeout(pendingFlushTimer);
      pendingFlushTimer = null;
    }
    pendingUpdaters = [];
    set({ ...IDLE });
    // ── v18d: dispose every active native session. reset() is the
    //   teardown path (hard cancel / logout) — we have no way to know
    //   which messageIds were active, so sweep the whole map.
    disposeAllStreamingSessions();
  },
}));
