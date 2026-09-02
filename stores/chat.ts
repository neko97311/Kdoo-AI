import { AppState } from 'react-native';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { zustandMmkvStorage } from '@/lib/zustand-storage';
import { reviveSessions, reviveMessages } from '@/lib/serialize';
import {
  upsertSession,
  upsertSessions,
  deleteSession as dbDeleteSession,
  upsertMessage,
  upsertMessages,
  deleteMessage as dbDeleteMessage,
  replaceMessagesBySession,
  getSessions,
  getMessages,
  getMessagesBefore,
  isDbReady,
} from '@/lib/db';
import type { ChatSession, ChatMessage, Agent, MessageContent, ApiMessage, ImageContent, TextContent, ReasoningContent, ToolInvocationContent, DataContent, McpStructuredContent, SourceLink, VideoResult, FileContent, CreationRefContent } from '@/types';
import type { WsContentBlock } from '@/types';
import { apiMessageToChatMessage, extractThinkingFromText, mergeItemParts } from '@/types';
import {
  loadSessionsFromApi,
  createSessionApi,
  updateSessionApi,
  deleteSessionApi,
  loadAgentsFromApi,
  getSessionMessages,
} from '@/services/session-service';
import { wsService } from '@/services/websocket';
import { useStreamingStore, appendToStreamingSession, migrateStreamingSession } from '@/stores/streaming';
// Circular import: auth.ts imports useChatStore from this file.
// Both modules only reference each other inside function bodies (runtime),
// never at module evaluation time — ES module circular deps resolve safely.
import { useAuthStore } from '@/stores/auth';
import { useTtsStore, prepareAudioContext } from '@/stores/tts';
import { useToastStore } from '@/stores/toast';
import { updateChatSettings } from '@/services/user';
import { logger } from '@/utils/logger';
import { i18n } from '@/i18n';
import { mergeMessagesForBackgroundRefresh } from '@/stores/chat-merge';
import { mergeMessagesForHydration } from '@/stores/chat-hydrate';
import { randomUUID } from 'expo-crypto';
import type { WsChatPayload, WsServerEvent } from '@/types';

// ============================================================
// SQLite sync helpers (write-through to source of truth, no-op on web)
// ============================================================

/** Get the current logged-in user's ID (null if not logged in). */
function getCurrentUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

/** Upsert a session to SQLite after local state change. */
function syncSessionToDb(sessionId: string): void {
  if (!isDbReady()) return;
  const uid = getCurrentUserId();
  if (!uid) return;
  const session = useChatStore.getState().sessions.find((s) => s.id === sessionId);
  if (session) {
    upsertSession(session, uid).catch((e) => {
      logger.warn('DB', 'syncSessionToDb failed', e);
    });
  }
}

// ── Message write debounce ───────────────────────────────────────
//
// Back-to-back syncMessageToDb calls (e.g. sendMessage adds user msg +
// AI placeholder within the same tick) create rapid-fire serializeWrite
// entries. Debouncing coalesces them into a single batched upsert after
// a 150ms quiet period, reducing DB write pressure and lock contention.
const msgWriteBuffer = new Map<string, ChatMessage>(); // keyed by msg.id
let msgWriteTimer: ReturnType<typeof setTimeout> | null = null;

function flushMessageBuffer(uid: string): void {
  if (msgWriteBuffer.size === 0) return;
  const batch = Array.from(msgWriteBuffer.values());
  msgWriteBuffer.clear();
  upsertMessages(batch, uid).catch((e) => {
      logger.warn('DB', 'syncMessageToDb batch failed', e);
  });
}

/** Upsert a message to SQLite after local state change (debounced). */
function syncMessageToDb(msg: ChatMessage): void {
  if (!isDbReady()) return;
  const uid = getCurrentUserId();
  if (!uid) return;
  // Buffer this message; replace if already pending (latest content wins).
  msgWriteBuffer.set(msg.id, msg);
  if (msgWriteTimer) clearTimeout(msgWriteTimer);
  msgWriteTimer = setTimeout(() => flushMessageBuffer(uid), 150);
}

interface MessageCursor {
  nextCursor?: string;
  hasMore: boolean;
}

interface ChatStore {
  sessions: ChatSession[];
  currentSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  messageCursors: Record<string, MessageCursor>;
  isLoadingMore: boolean;
  isDrawerOpen: boolean;
  isTyping: boolean;
  isLoading: boolean;
  isCreating: boolean;
  isStreaming: boolean;
  streamingMessageId: string | null;
  pendingUserMessage: boolean;
  pendingAudioUri: string | null;
  pendingBlocks: WsContentBlock[] | null;
  streamingText: string;
  /** True between sending a cancel and receiving cancel-ack (or 15s timeout).
   *  During this window, the UI shows only a TypingIndicator (no text)
   *  and the input bar is disabled. */
  isWaitingForCancelAck: boolean;
  /** Message that was queued while waiting for cancel-ack to land. When the
   *  ack arrives (or timeout fires), flushPendingSendAfterCancel() sends it
   *  through the normal sendMessage path. null when no message is queued. */
  pendingSendAfterCancel: { text: string; blocks: WsContentBlock[] | null } | null;

  wsConnected: boolean;
  error: string | null;
  agents: Agent[];
  /** Pending tool approvals: toolCallId → { runId, toolName } */
  pendingToolApprovals: Record<string, { runId: string; toolName: string }>;

  // Sync methods (local)
  createSession: (title?: string) => string;
  /**
   * Insert an externally-created ChatSession (e.g. from a share-fork
   * API call) into the store and make it current.
   *
   * Mirrors the post-create state in `createSession`, but takes the
   * session object directly (no local id generation) and sets it as
   * the current session. Also kicks off `syncSessionToDb` so the
   * session is persisted to SQLite alongside local ones.
   *
   * This is critical for the share-link flow: `_layout.tsx:312-314`
   * cleans up `currentSessionId` if it isn't in the loaded `sessions[]`
   * list (e.g. after `loadSessions` returns a stale cache). If we
   * only call `setCurrentSession`, the forked session gets nulled
   * out within a few hundred ms and the user lands on the empty
   * ChatHome screen instead of the new chat.
   */
  addSession: (session: ChatSession) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  togglePinSession: (id: string) => void;
  setCurrentSession: (id: string | null) => void;
  addMessage: (sessionId: string, message: Omit<ChatMessage, 'id' | 'createdAt'>) => ChatMessage;
  toggleDrawer: () => void;
  setDrawerOpen: (open: boolean) => void;
  setTyping: (typing: boolean) => void;
  setPendingUserMessage: (pending: boolean) => void;
  setPendingAudioUri: (uri: string | null) => void;
  setPendingBlocks: (blocks: WsContentBlock[] | null) => void;
  clearError: () => void;

  /** Toggle auto-play TTS on/off. When turning off, stops any in-flight auto-play. */
  toggleAutoPlay: () => void;

  // Async methods (API)
  loadSessions: () => Promise<void>;
  createSessionAsync: (params: { agentId: string; name?: string }) => Promise<string | null>;
  updateSessionAsync: (sessionId: string, params: { name?: string; agentId?: string; isPinned?: boolean }) => Promise<void>;
  deleteSessionAsync: (sessionId: string) => Promise<void>;
  loadAgents: () => Promise<void>;

  // Messages
  loadMessages: (sessionId: string, opts?: { backgroundRefresh?: boolean }) => Promise<void>;
  loadMoreMessages: (sessionId: string) => Promise<void>;
  hasMoreMessages: (sessionId: string) => boolean;

  /** Hydrate store from SQLite after initDb completes (Plan C).
   *  Loads all sessions + current session messages from SQLite (source of
   *  truth), merging with any MMKV-cached data. Called from _layout.tsx
   *  after initDb() — NOT from onRehydrateStorage (which runs before DB
   *  is ready). */
  hydrateFromSQLite: () => Promise<void>;

  // WebSocket
  connectWebSocket: () => void;
  disconnectWebSocket: () => void;
  sendMessage: (sessionId: string, text: string, blocks?: WsContentBlock[], agentId?: string) => void;
  cancelStream: () => void;
  /** Queue a message to be sent after the current stream's cancel-ack arrives.
   *  If no stream is in-flight, the message is sent immediately. */
  setPendingSendAfterCancel: (p: { text: string; blocks: WsContentBlock[] | null } | null) => void;
  /** Drop the queued message without sending. */
  clearPendingSendAfterCancel: () => void;
  /** Send whatever is queued (if any) and clear the queue. Called from the
   *  cancel-ack handler and from the 15s timeout fallback. */
  flushPendingSendAfterCancel: () => void;
  respondToToolApproval: (sessionId: string, toolCallId: string, approved: boolean) => void;
}

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: {},
  messageCursors: {},
  isLoadingMore: false,
  isDrawerOpen: false,
  isTyping: false,
  isLoading: false,
  isCreating: false,
  isStreaming: false,
  streamingMessageId: null,
  pendingUserMessage: false,
  pendingAudioUri: null,
  pendingBlocks: null,
  streamingText: '',
  isWaitingForCancelAck: false,
  pendingSendAfterCancel: null,
  wsConnected: false,
  error: null,
  agents: [],
  pendingToolApprovals: {},

  // --- Sync methods ---

  createSession: (title?: string) => {
    const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session: ChatSession = {
      id,
      title: title || 'New chat',
      updatedAt: new Date(),
      isPinned: false,
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
      messages: { ...state.messages, [id]: [] },
    }));
    syncSessionToDb(id);
    return id;
  },

  addSession: (session) => {
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: session.id,
      messages: { ...state.messages, [session.id]: [] },
    }));
    syncSessionToDb(session.id);
  },

  deleteSession: (id) => {
    set((state) => {
      const { [id]: _, ...remainingMessages } = state.messages;
      return {
        sessions: state.sessions.filter((s) => s.id !== id),
        messages: remainingMessages,
        currentSessionId: state.currentSessionId === id ? null : state.currentSessionId,
      };
    });
    // SQLite: fire-and-forget delete (cascade removes messages too)
    if (isDbReady()) {
      const uid = getCurrentUserId();
      if (uid) dbDeleteSession(id, uid).catch(() => {});
    }
  },

  renameSession: (id, title) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, title } : s,
      ),
    }));
    syncSessionToDb(id);
  },

  togglePinSession: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    const newPinned = !(session?.isPinned);
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, isPinned: newPinned } : s,
      ),
    }));
    syncSessionToDb(id);
    updateSessionApi(id, { isPinned: newPinned }).catch(() => {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === id ? { ...s, isPinned: !newPinned } : s,
        ),
      }));
      syncSessionToDb(id);
    });
  },

  setCurrentSession: (id) => {
    set({ currentSessionId: id });
  },

  addMessage: (sessionId, message) => {
    const fullMessage: ChatMessage = {
      ...message,
      id: randomUUID(),
      createdAt: new Date(),
    };
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [...(state.messages[sessionId] || []), fullMessage],
      },
    }));
    syncMessageToDb(fullMessage);
    return fullMessage;
  },

  toggleDrawer: () => {
    set((state) => ({ isDrawerOpen: !state.isDrawerOpen }));
  },

  setDrawerOpen: (open) => {
    set({ isDrawerOpen: open });
  },

  setTyping: (typing) => {
    set({ isTyping: typing });
  },

  setPendingUserMessage: (pending) => {
    set({ pendingUserMessage: pending });
  },

  setPendingAudioUri: (uri) => {
    set({ pendingAudioUri: uri });
  },

  setPendingBlocks: (blocks) => {
    set({ pendingBlocks: blocks });
  },

  clearError: () => {
    set({ error: null });
  },

  toggleAutoPlay: () => {
    const authState = useAuthStore.getState();
    const current = authState.user?.chatSetting.autoPlay ?? false;
    const next = !current;

    // Optimistic local update + AsyncStorage persist (instant UI feedback)
    authState.setChatSetting({ autoPlay: next });

    // Background API save (non-blocking, best-effort with rollback on failure)
    updateChatSettings({ autoPlay: next }).catch((e) => {
      logger.warn('Chat', 'Failed to persist autoPlay setting', e);
      authState.setChatSetting({ autoPlay: current });
    });

    if (next) {
      // User-gesture: activate the native audio session now so the
      // AudioContext created here can actually run. Playback itself
      // starts later when WS text deltas arrive (async), but by then
      // the gesture is over — so we must prepare here. Without this,
      // resume() inside the async WS callback resolves but the context
      // stays "suspended" → zero audio output.
      prepareAudioContext();
    } else {
      // Turning off — stop any in-flight auto-play TTS
      useTtsStore.getState().stopAutoPlay();
    }
  },

  // --- Async methods (API) ---

  loadSessions: async () => {
    set({ isLoading: true, error: null });
    try {
      const sessions = await loadSessionsFromApi();
      set({ sessions, isLoading: false });
      // SQLite: cache server data for instant cold-start display
      if (isDbReady()) {
        const uid = getCurrentUserId();
        if (uid && sessions.length > 0) {
          upsertSessions(sessions, uid).catch((e) => {
            logger.warn('DB', 'loadSessions upsert failed', e);
          });
        }
      }
    } catch (err: any) {
      set({ error: err.message || 'Failed to load sessions', isLoading: false });
    }
  },

  createSessionAsync: async (params) => {
    set({ isCreating: true, error: null });
    try {
      const session = await createSessionApi(params);
      set((state) => ({
        sessions: [session, ...state.sessions],
        currentSessionId: session.id,
        messages: { ...state.messages, [session.id]: [] },
        isCreating: false,
      }));
      // SQLite: cache new server-created session
      if (isDbReady()) {
        const uid = getCurrentUserId();
        if (uid) upsertSession(session, uid).catch(() => {});
      }
      return session.id;
    } catch (err: any) {
      set({ error: err.message || 'Failed to create session', isCreating: false });
      return null;
    }
  },

  updateSessionAsync: async (sessionId, params) => {
    try {
      const updated = await updateSessionApi(sessionId, params);
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? updated : s,
        ),
      }));
      syncSessionToDb(sessionId);
    } catch (err: any) {
      set({ error: err.message || 'Failed to update session' });
    }
  },

  deleteSessionAsync: async (sessionId) => {
    // Save state for potential rollback
    const prevSessions = get().sessions;
    const prevMessages = get().messages;
    const prevCurrentSessionId = get().currentSessionId;

    // Optimistic: delete locally first for instant UI feedback
    set((state) => {
      const { [sessionId]: _, ...remainingMessages } = state.messages;
      return {
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        messages: remainingMessages,
        currentSessionId: state.currentSessionId === sessionId ? null : state.currentSessionId,
      };
    });

    try {
      await deleteSessionApi(sessionId);
      // SQLite: delete only after API success (server is source of truth)
      if (isDbReady()) {
        const uid = getCurrentUserId();
        if (uid) dbDeleteSession(sessionId, uid).catch(() => {});
      }
    } catch (err: any) {
      // API failed → rollback to previous state
      set({
        sessions: prevSessions,
        messages: prevMessages,
        currentSessionId: prevCurrentSessionId,
        error: err.message || 'Failed to delete session',
      });
    }
  },

  loadAgents: async () => {
    // try {
    //   const agents = await loadAgentsFromApi();
    //   set({ agents });
    // } catch (err: any) {
    //   console.warn('Failed to load agents:', err.message);
    // }
  },

  // --- Messages ---

  loadMessages: async (sessionId, opts) => {
    if (!sessionId) return;
    const backgroundRefresh = opts?.backgroundRefresh ?? false;
    set({ isLoading: true });
    try {
      const res = await getSessionMessages(sessionId);
      // Guard: API layer returns undefined on business errors (e.g. 5000
      // NOT_FOUND_ERROR when the session doesn't belong to the current
      // account after a switch). Without this guard, res.nextCursor below
      // throws "Cannot read property 'nextCursor' of undefined".
      if (!res) {
        set({ isLoading: false });
        return;
      }
      const items = res?.items ?? [];
      const mergeItems = mergeItemParts(items);
      const converted = mergeItems
        .map((m) => apiMessageToChatMessage(m, sessionId))
        .filter((m): m is ChatMessage => m !== null);
      set((state) => {
        // Race-guard: skip messages overwrite when this session has an active
        // stream. loadMessages is triggered on session entry (index.tsx) when
        // cursor is missing, and may complete AFTER the user sends a message.
        // The server response includes the just-created assistant message
        // (server id, partial/complete content), while the local placeholder
        // (m_N_timestamp) is still streaming via StreamingBubble. Overwriting
        // here would either:
        //   (a) wipe the placeholder → commitStreamingToMessages can't find it
        //       → content lost;
        //   (b) keep the placeholder (previous fix) → server version + stream
        //       version render in parallel → "两个你好！" duplicate that
        //       vanishes after finish ("刷新后后面的没有了").
        // Skipping the overwrite (only updating cursor) lets the in-flight
        // stream complete normally; the next loadMessages (manual refresh or
        // session re-entry) will sync the server snapshot.
        const activeStreamId = useStreamingStore.getState().messageId;
        const sessionHasActiveStream = !!activeStreamId
          && (state.messages[sessionId] || []).some((m) => m.id === activeStreamId);

        const nextCursors = {
          ...state.messageCursors,
          [sessionId]: { nextCursor: res.nextCursor, hasMore: res.hasMore },
        };

        if (sessionHasActiveStream) {
          return { messageCursors: nextCursors, isLoading: false };
        }

        // Background refresh merge mode: merge server messages with local
        // state instead of overwriting. This preserves local-only messages
        // (e.g. optimistic messages whose SQLite sync was lost when the OS
        // killed the app) while still pulling server-side updates.
        //
        // Merge semantics live in `mergeMessagesForBackgroundRefresh` —
        // see that file for the full rationale (sort, dedup, placeholder
        // filter). The inline version here is intentionally thin so the
        // behaviour is unit-testable in isolation.
        if (backgroundRefresh) {
          const localMessages = state.messages[sessionId] || [];
          const merged = mergeMessagesForBackgroundRefresh(converted, localMessages);
          return {
            messages: { ...state.messages, [sessionId]: merged },
            messageCursors: nextCursors,
            isLoading: false,
          };
        }

        return {
          messages: { ...state.messages, [sessionId]: converted },
          messageCursors: nextCursors,
          isLoading: false,
        };
      });
      // SQLite: cache server messages for instant cold-start display.
      // DELETE then INSERT (not INSERT OR REPLACE alone) — otherwise local
      // ids from addMessage/commitStreamingToMessages (m_N_timestamp) and
      // server ids accumulate as duplicate rows because PK dedup only
      // matches on `id`. Wiping by session_id makes SQLite a faithful
      // mirror of the server snapshot.
      //
      // Guard 1: only run the delete-then-insert cycle when the server
      // actually returned messages. An empty response (transient network
      // blip, server error returning []) would otherwise wipe valid
      // cached history without replacing it. Keep the SQLite cache as-is
      // in that case — it's stale-but-better-than-empty for cold start.
      //
      // Guard 2: skip when this session has an active stream (mirrors the
      // in-memory guard above). Otherwise SQLite would store the server
      // snapshot (with server id) while the local placeholder (m_N_timestamp)
      // is also being persisted by syncMessageToDb → next cold-start prefill
      // reads both → duplicate bubbles.
      const activeStreamIdDb = useStreamingStore.getState().messageId;
      const sessionHasActiveStreamDb = !!activeStreamIdDb
        && (useChatStore.getState().messages[sessionId] || [])
          .some((m) => m.id === activeStreamIdDb);
      if (isDbReady() && converted.length > 0 && !sessionHasActiveStreamDb) {
        const uid = getCurrentUserId();
        if (uid) {
          replaceMessagesBySession(sessionId, converted, uid).catch((e) => {
            logger.warn('DB', 'loadMessages sqlite sync failed', e);
          });
        }
      }
    } catch (err: any) {
      logger.warn('Chat', 'Failed to load messages', err.message);
      set({ isLoading: false });
    }
  },

  loadMoreMessages: async (sessionId) => {
    if (!sessionId) return;
    const state = get();
    if (state.isLoadingMore) return;

    const cursor = state.messageCursors[sessionId];
    // No more data from either SQLite or API
    if (!cursor?.hasMore) return;

    const existing = state.messages[sessionId] || [];
    if (existing.length === 0) return;

    set({ isLoadingMore: true });
    try {
      // ── Try SQLite first (fast, local) ──
      // Query messages older than the oldest one currently in memory.
      if (isDbReady()) {
        const uid = getCurrentUserId();
        if (uid) {
          const oldestCreatedAt = existing[0].createdAt;
          const olderMessages = await getMessagesBefore(
            sessionId,
            oldestCreatedAt,
            uid,
            20,
          );
          if (olderMessages.length > 0) {
            // Dedup by id — SQLite might return messages already in memory
            // (e.g. local-only messages with client-generated ids that also
            // got synced to SQLite with the same id).
            const existingIds = new Set(existing.map((m) => m.id));
            const deduped = olderMessages.filter((m) => !existingIds.has(m.id));
            if (deduped.length > 0) {
              set((s) => {
                const currentExisting = s.messages[sessionId] || [];
                // 跨页边界合并:deduped 末条 ↔ currentExisting 首条
                const { newPage: trimmedDeduped, existing: mergedExisting } =
                  mergeCrossBoundaryMessages(deduped, currentExisting);
                return {
                  messages: {
                    ...s.messages,
                    [sessionId]: [...trimmedDeduped, ...mergedExisting],
                  },
                  // hasMore = SQLite returned a full page (might have more)
                  //          OR API cursor still has more (fallback available)
                  messageCursors: {
                    ...s.messageCursors,
                    [sessionId]: {
                      nextCursor: cursor?.nextCursor,
                      hasMore: deduped.length === 20 || (cursor?.hasMore ?? false),
                    },
                  },
                  isLoadingMore: false,
                };
              });
              return;
            }
          }
        }
      }

      // ── Fall back to API cursor ──
      // SQLite exhausted (no older messages cached) — fetch from server.
      if (!cursor?.nextCursor) {
        // No API cursor either — nothing more to load
        set((s) => ({
          isLoadingMore: false,
          messageCursors: {
            ...s.messageCursors,
            [sessionId]: { nextCursor: undefined, hasMore: false },
          },
        }));
        return;
      }

      const res = await getSessionMessages(sessionId, cursor.nextCursor);
      // Guard: API layer returns undefined on business errors — same as
      // loadMessages. See comment there for details.
      if (!res) {
        set({ isLoadingMore: false });
        return;
      }
      const items = res?.items ?? [];
      const mergeItems = mergeItemParts(items);
      const converted = mergeItems
        .map((m) => apiMessageToChatMessage(m, sessionId))
        .filter((m): m is ChatMessage => m !== null);
      set((state) => {
        // Dedup by id when prepending paginated history. Cursor boundaries
        // can overlap (backend returns messages already in the loaded list),
        // which would otherwise produce two messages with the same UUID ->
        // React "two children with the same key" error in ChatView.
        const existing = state.messages[sessionId] || [];
        const existingIds = new Set(existing.map((m) => m.id));
        const dedupedConverted = converted.filter((m) => !existingIds.has(m.id));
        // 跨页边界合并:dedupedConverted 末条 ↔ existing 首条
        const { newPage: trimmedConverted, existing: mergedExisting } =
          mergeCrossBoundaryMessages(dedupedConverted, existing);
        return {
          messages: {
            ...state.messages,
            [sessionId]: [...trimmedConverted, ...mergedExisting],
          },
          messageCursors: {
            ...state.messageCursors,
            [sessionId]: { nextCursor: res.nextCursor, hasMore: res.hasMore },
          },
          isLoadingMore: false,
        };
      });
      // SQLite: cache paginated history for future cold-start scroll loading
      if (isDbReady()) {
        const uid = getCurrentUserId();
        if (uid && converted.length > 0) {
          upsertMessages(converted, uid).catch((e) => {
            logger.warn('DB', 'loadMoreMessages upsert failed', e);
          });
        }
      }
    } catch (err: any) {
      logger.warn('Chat', 'Failed to load more messages', err.message);
      set({ isLoadingMore: false });
    }
  },

  hasMoreMessages: (sessionId) => {
    const cursor = get().messageCursors[sessionId];
    return cursor ? cursor.hasMore : false;
  },

  hydrateFromSQLite: async () => {
    if (!isDbReady()) return;
    const uid = getCurrentUserId();
    if (!uid) return;

    const t0 = Date.now();
    try {
      // 1. Load all sessions from SQLite (source of truth)
      const dbSessions = await getSessions(uid);
      logger.info('Hydrate', `getSessions @ ${Date.now() - t0}ms, count: ${dbSessions.length}`);
      if (dbSessions.length > 0) {
        // Merge: SQLite as base, keep any MMKV-only sessions (just-created,
        // SQLite write might not have completed before app was killed).
        const mmkvSessions = get().sessions;
        const dbIds = new Set(dbSessions.map((s) => s.id));
        const mmkvOnly = mmkvSessions.filter((s) => !dbIds.has(s.id));
        set({ sessions: [...dbSessions, ...mmkvOnly] });
        logger.info('Hydrate', `sessions merged: ${dbSessions.length} SQLite + ${mmkvOnly.length} MMKV-only`);
      }

      // 2. Load current session messages from SQLite
      const { currentSessionId } = get();
      if (currentSessionId) {
        const dbMessages = await getMessages(currentSessionId, uid);
        logger.info('Hydrate', `getMessages(${currentSessionId}) @ ${Date.now() - t0}ms, count: ${dbMessages.length}`);
        if (dbMessages.length > 0) {
          // Merge: SQLite as source of truth, keep MMKV-only messages
          // (in-flight optimistic messages whose SQLite write hasn't
          // completed — e.g. app killed mid-stream).
          //
          // Merge semantics live in `mergeMessagesForHydration` — see
          // that file for the full rationale (m_ placeholder filter,
          // sort). The inline version here is intentionally thin so the
          // behaviour is unit-testable in isolation. The m_ filter
          // closes a duplicate-bubble race where a placeholder whose
          // SQLite write was skipped (loadMessages active-stream guard)
          // would otherwise be resurrected on next cold start against
          // the server snapshot's real UUID.
          const mmkvMessages = get().messages[currentSessionId] ?? [];
          const merged = mergeMessagesForHydration(dbMessages, mmkvMessages);
          set((s) => ({
            messages: { ...s.messages, [currentSessionId]: merged },
          }));
          logger.info('Hydrate', `messages merged: ${dbMessages.length} SQLite + ${merged.length - dbMessages.length} MMKV-only`);
        }
      }
      logger.info('Hydrate', `done @ ${Date.now() - t0}ms`);
    } catch (e) {
      logger.warn('DB', 'hydrateFromSQLite failed (non-fatal)', e);
    }
  },

  // --- WebSocket ---

  connectWebSocket: () => {
    wsService.connect().catch((e) => {
      logger.warn('Chat', 'WebSocket connect failed', e);
    });
  },

  disconnectWebSocket: () => {
    // Drop the cancel-ack timer so we don't fire flushPendingSendAfterCancel
    // after the WS has been torn down (would race against a future session).
    clearCancelAckTimer();
    // Drop the stream watchdog too — without an active WS, no stream events
    // can arrive, so the 90s timer would either (a) fire on a torn-down store
    // and attempt wsService.reconnect() on a deliberately-disconnected
    // socket, or (b) sit armed across a logout/login and fire on the next
    // user's session. Disarm unconditionally on teardown.
    disarmStreamWatchdog();
    // Reset cancel-wait bookkeeping so it can't outlive the connection.
    // Without this, isWaitingForCancelAck would stay true forever after a
    // disconnect (timer was the only thing that could clear it), leaving
    // the input bar permanently disabled after a reconnect.
    expectingCancelAck = false;
    wsService.disconnect();
    set({
      isWaitingForCancelAck: false,
      pendingSendAfterCancel: null,
    });
  },

  sendMessage: async (sessionId, text, blocks, agentId) => {
    // Guard: reject empty messages — no meaningful text AND no content blocks.
    // Prevents empty/whitespace-only strings from reaching the backend.
    const trimmedText = (text || '').trim();
    if (!trimmedText && !(blocks && blocks.length > 0)) {
      set({ pendingUserMessage: false });
      return;
    }

    const state = get();
    const agentIdToUse = 'default';

    // ── Stale-stream cleanup ──
    // If a previous stream is still active for a DIFFERENT session (user
    // navigated away via "new chat" / session switch without cancelling),
    // we must (a) tell the server to stop it, (b) commit its accumulated
    // content into the OLD session's message tree (data preservation),
    // and (c) clear all stream-local state. Without this, the OLD stream's
    // text-delta events continue arriving and leak into the NEW session's
    // bubble — the "two text blocks in one bubble" duplication bug.
    // This is the root-cause fix for the ChatHome → send → duplicate text
    // scenario (ChatDrawer.handleNewChat calls setCurrentSession(null)
    // WITHOUT cancelling the active WS stream).
    if (streamingMessageId && streamingSessionId && streamingSessionId !== sessionId) {
      // Best-effort cancel — don't wait for cancel-ack (the server may take
      // 100ms+ to respond, and we want the new send to proceed immediately).
      wsService.cancelStream(streamingSessionId);
      // Commit accumulated content into the OLD session so the user doesn't
      // lose the partial reply when they return to that session later.
      commitStreamingToMessages(streamingSessionId);
      // Reset all stream-local state (mirrors finish handler cleanup).
      useChatStore.setState({ isStreaming: false, streamingMessageId: null, streamingText: '' });
      streamingMessageId = null;
      streamingSessionId = null;
      lastWsMessageType = null;
      // Drop the watchdog from the OLD stream — sendMessage will arm a
      // fresh one for the NEW stream below. Without this, the OLD timer
      // could fire mid-send and tear down the socket the NEW stream is
      // actively using.
      disarmStreamWatchdog();
    }

    // Build local MessageContent[] for addMessage
    const localContent: MessageContent[] = [];
    if (blocks && blocks.length > 0) {
      // blocks already contain text when provided (handleSend adds text as first block)
      for (const b of blocks) {
        if (b.type === 'text') {
          localContent.push({ type: 'text', text: b.text || '' });
        } else if (b.type === 'image') {
          localContent.push({
            type: 'image',
            uri: b.image || '',
            data: b.image,
            mediaType: b.mediaType,
          });
        } else if (b.type === 'file') {
          // WS sends all files as type:'file'; use mimeType to distinguish images for local display
          const fileMediaType = (b as any).mimeType || b.mediaType;
          const fileData = b.data || (b as any).image;
          const fileName = b.filename || 'file';
          if (fileMediaType?.startsWith('image/')) {
            // Use type 'image' so ChatBubble renders it the same way as API-loaded messages
            localContent.push({
              type: 'image',
              uri: fileData || '',
              data: fileData,
              mediaType: fileMediaType,
            });
          } else {
            localContent.push({
              type: 'file',
              name: fileName,
              uri: '',
              data: fileData,
              mediaType: fileMediaType,
            });
          }
        } else if (b.type === 'audio') {
          localContent.push({
            type: 'file',
            name: 'audio',
            uri: '',
            data: b.audio,
            mediaType: b.mediaType || 'audio/webm',
          });
        }
      }
    } else if (text) {
      localContent.push({ type: 'text', text });
    }

    // Fallback: if no content at all, add empty text
    if (localContent.length === 0) {
      localContent.push({ type: 'text', text: '' });
    }

    // Add user message locally. Route-1: client UUID is the final id
    // (server uses it directly via idempotent upsert), so the message is
    // durable the moment it enters state — no 'sending' placeholder phase.
    const userMsg = state.addMessage(sessionId, {
      sessionId,
      role: 'user',
      content: localContent,
    });

    // Create placeholder assistant message immediately so the bubble with
    // typing dots shows without waiting for the WS 'start' event.
    const aiMsg = state.addMessage(sessionId, {
      sessionId,
      role: 'assistant',
      content: [],
    });
    streamingMessageId = aiMsg.id;
    streamingSessionId = sessionId;

    // v3: init physical-isolation streaming store so WS deltas write here
    // (not the messages tree) until finish/cancel commits.
    useStreamingStore.getState().startStreaming(aiMsg.id);

    // Build WebSocket message content — blocks already contain text when provided
    const wsContent: string | WsContentBlock[] = (blocks && blocks.length > 0) ? blocks : text;

    // Send via WebSocket — sendChat returns Promise<boolean> (async).
    // Previous code assigned the raw Promise to `sent` and checked
    // `if (!sent)`, which was dead code because Promises are always
    // truthy. Now properly awaited so the error branch actually fires.
    const payload: WsChatPayload = {
      type: 'chat',
      sessionId,
      messages: [{ role: 'user', content: wsContent, id: userMsg.id }],
      agentId: agentIdToUse,
    };

    const sent = await wsService.sendChat(payload);
    if (!sent) {
      // sendChat failed: WS was disconnected and the one-shot reconnect
      // attempt did not reach OPEN state within 5s. Must clean up BOTH
      // the optimistic user message AND the placeholder assistant message.
      const failState = useChatStore.getState();
      const failMessages = failState.messages[sessionId] || [];
      useChatStore.setState({
        messages: {
          ...failState.messages,
          [sessionId]: failMessages.filter(m => m.id !== aiMsg.id && m.id !== userMsg.id),
        },
        pendingUserMessage: false,
      });
      // SQLite: remove both the user msg and the AI placeholder
      if (isDbReady()) {
        const uid = getCurrentUserId();
        if (uid) {
          dbDeleteMessage(aiMsg.id, uid).catch(() => {});
          dbDeleteMessage(userMsg.id, uid).catch(() => {});
        }
      }
      useStreamingStore.getState().reset();
      streamingMessageId = null;
      streamingSessionId = null;
      // Toast: notify user the message failed to send
      useToastStore.getState().showToast({ message: i18n.t('chatView.sendFailed'), variant: 'warning' });
      return;
    }

    // WS delivery confirmed — start streaming state. Route-1: the user
    // message is already durable (client UUID = final id via upsert), so
    // there is no 'sending' placeholder phase to exit.
    set({ isStreaming: true, streamingMessageId: aiMsg.id, pendingUserMessage: false, streamingText: '' });
    // Arm the stream watchdog: if 90s passes with ZERO WS activity on
    // this stream, we presume the server or socket is dead and trigger
    // the force-reconnect path (send cancel → finalize → reconnect).
    // Every active-stream handler (text-delta / reasoning-* / tool-* /
    // mcp-tool-* / step-*) re-arms it, so this only fires on true death.
    armStreamWatchdog();
  },

  cancelStream: () => {
    const { currentSessionId } = get();
    // Already waiting on a prior cancel — don't pile up timers. The caller
    // (ChatView queue branch) just set pendingSendAfterCancel, so the ack
    // we're already waiting for will pick it up on arrival.
    if (get().isWaitingForCancelAck) {
      return;
    }
    expectingCancelAck = true;
    if (currentSessionId) {
      wsService.cancelStream(currentSessionId);
      // v19B (delayed-commit): DO NOT commit m_OLD or clear streamingMessageId
      // here. The server has likely already pushed in-flight tokens onto the
      // WS pipe; clearing streamingMessageId now would make the text-delta
      // handler's `!streamingMessageId` guard drop them (the "m_OLD 被截断"
      // bug — user reported "上一条消息被隔成两段，刷新就好了"). Instead we keep
      // streamingMessageId = m_OLD so tokens keep accumulating; the actual
      // commit + clear + flush happens in finalizeOldStreamAndFlush() when
      // cancel-ack arrives (or the 15s timeout fires).
    } else {
      useStreamingStore.getState().reset();
    }
    set({ isWaitingForCancelAck: true });

    // 15s safety net: if cancel-ack never arrives (network drop, server bug,
    // …) force-flush via the shared helper so housekeeping is identical to
    // the ack path.
    if (cancelAckTimer) clearTimeout(cancelAckTimer);
    cancelAckTimer = setTimeout(() => {
      logger.warn('Chat', 'cancel-ack timeout — forcing flush of queued message');
      cancelAckTimer = null;
      expectingCancelAck = false;
      useChatStore.setState({ isWaitingForCancelAck: false });
      finalizeOldStreamAndFlush();
    }, CANCEL_ACK_TIMEOUT_MS);
  },

  setPendingSendAfterCancel: (p) => {
    set({ pendingSendAfterCancel: p });
  },

  clearPendingSendAfterCancel: () => {
    set({ pendingSendAfterCancel: null });
  },

  flushPendingSendAfterCancel: () => {
    const { pendingSendAfterCancel, currentSessionId, sendMessage } = get();
    if (!pendingSendAfterCancel || !currentSessionId) {
      // Nothing queued (or session gone) — just clear and bail.
      if (pendingSendAfterCancel) set({ pendingSendAfterCancel: null });
      return;
    }
    const { text, blocks } = pendingSendAfterCancel;
    // Clear BEFORE calling sendMessage so a re-entrant cancelStream inside
    // sendMessage (e.g. attach upload failures that race a new cancel) sees
    // an empty queue rather than re-flushing.
    set({ pendingSendAfterCancel: null });
    sendMessage(currentSessionId, text, blocks ?? undefined);
  },

  respondToToolApproval: (sessionId, toolCallId, approved) => {
    const state = get();
    const approval = state.pendingToolApprovals[toolCallId];
    if (!approval) {
      logger.warn('Chat', `No pending approval found for toolCallId: ${toolCallId}`);
      return;
    }
    wsService.respondToToolApproval(toolCallId, approved, approval.runId, sessionId);
    // Update local state
    const newApprovals = { ...state.pendingToolApprovals };
    delete newApprovals[toolCallId];
    set({ pendingToolApprovals: newApprovals });
  },
    }),
    {
      name: 'chat-store-v1',
      storage: createJSONStorage(() => zustandMmkvStorage),
      // Plan C: MMKV is a hot cache, not a full mirror.
      // Persist only sessions + currentSessionId + current session's
      // recent 50 messages + messageCursors (to prevent unnecessary
      // API re-fetch on cold start). All other messages live in SQLite.
      partialize: (state) => {
        const sid = state.currentSessionId;
        const currentMsgs = sid ? state.messages[sid] : undefined;
        const recentMsgs = currentMsgs ? currentMsgs.slice(-50) : [];
        return {
          sessions: state.sessions,
          currentSessionId: state.currentSessionId,
          messages: sid ? { [sid]: recentMsgs } : {},
          messageCursors: state.messageCursors,
        };
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.sessions = reviveSessions(state.sessions);
        state.messages = reviveMessages(state.messages);
        // SQLite hydration is handled by hydrateFromSQLite(), called from
        // _layout.tsx after initDb() completes — NOT here (DB not ready yet).
      },
    }
  )
);

// ============================================================
// Helpers for attachment content block conversion
// ============================================================

/**
 * Convert WsContentBlock[] (from WS echo) to MessageContent[] (for ChatBubble).
 */
function wsContentBlocksToMessageContent(blocks: WsContentBlock[]): MessageContent[] {
  return blocks.map((b) => {
    switch (b.type) {
      case 'text':
        return { type: 'text' as const, text: b.text || '' };
      case 'image':
        return {
          type: 'image' as const,
          uri: b.image || '',
          data: b.image,
          mediaType: b.mediaType,
        };
      case 'file': {
        const fileMediaType = (b as any).mimeType || b.mediaType;
        const fileData = b.data || (b as any).image;
        const fileName = b.filename || 'file';
        if (fileMediaType?.startsWith('image/')) {
          return {
            type: 'image' as const,
            uri: fileData || '',
            data: fileData,
            mediaType: fileMediaType,
          };
        }
        return {
          type: 'file' as const,
          name: fileName,
          uri: '',
          data: fileData,
          mediaType: fileMediaType,
        };
      }
      case 'audio':
        return {
          type: 'file' as const,
          name: 'audio',
          uri: '',
          data: b.audio,
          mediaType: b.mediaType || 'audio/webm',
        };
      default:
        return { type: 'text' as const, text: '' };
    }
  });
}

// ============================================================
// WebSocket event setup — call once at app startup
// ============================================================

let wsInitialized = false;

/** ID of the currently streaming assistant message (null when idle) */
let streamingMessageId: string | null = null;
/**
 * The sessionId that owns the current stream. Paired with streamingMessageId
 * so WS handlers can reject events from a STALE stream (one the user already
 * navigated away from) even when the server's text-delta event omits the
 * optional `sessionId` field (types/index.ts L332: `sessionId?: string`).
 *
 * Without this, the existing resolveEventSessionId guard falls back to
 * currentSessionId and becomes a self-comparison (currentSessionId !==
 * currentSessionId → always false → guard never fires). Late-arriving deltas
 * from an abandoned stream then leak into the NEW session's bubble — the
 * "two text blocks in one bubble" duplication bug.
 *
 * Set in: sendMessage, start handler.
 * Cleared in: finish/error handlers, finalizeOldStreamAndFlush, sendChat-fail.
 */
let streamingSessionId: string | null = null;
let expectingCancelAck = false;

/**
 * Accumulator for auto-play TTS sentence detection. Incoming text-delta
 * chunks are appended here; when a sentence-ending punctuation is found,
 * complete sentences are flushed to the TTS queue and the remainder stays
 * for the next delta. Reset on `start`, flushed on `finish`.
 */
let autoPlayTextBuffer = '';

/**
 * v19 race-fix: set true by cancel-ack handler (and 15s safety net) right
 * before flushing the queued NEW send. Indicates "the very next `start`
 * (or first text-delta) belongs to the NEW stream; any `finish` arriving
 * before that gate clears is a STALE finish from the OLD (cancelled) stream
 * and MUST be dropped, otherwise it would:
 *   1. commitStreamingToMessages on the NEW placeholder (empty content)
 *   2. remove the NEW placeholder from the messages tree
 *   3. clear streamingMessageId (both module var + store state)
 *   4. reset the streaming store via endStreaming()
 * …leaving the NEW stream with no bubble (TypingDots vanish) until the
 * actual NEW `start` event arrives and creates a 3rd placeholder.
 *
 * Cleared by: `start` handler, `text-delta` handler (first token).
 * Not a perfect guard (if OLD finish arrives AFTER NEW start, the gate is
 * already cleared), but that ordering is far rarer than the documented
 * "cancel-ack → flush → stale OLD finish → NEW start" race this fixes.
 */
let expectingNewStreamStart = false;

/** Max wait for `cancel-ack` before we force-flush the queued message anyway.
 *  At 15s the user has lost patience with the silent bubble; we'd rather risk
 *  1-2 stray tokens from the dying stream than block the new send forever. */
const CANCEL_ACK_TIMEOUT_MS = 15000;
/** Active cancel-ack timeout. Cleared by the cancel-ack handler on arrival.
 *  Fires after CANCEL_ACK_TIMEOUT_MS and force-flushes the queue. */
let cancelAckTimer: ReturnType<typeof setTimeout> | null = null;

/** Clear the cancel-ack wait timer. Exported so disconnect / unmount paths
 *  can drop it without leaking. Safe to call when no timer is armed. */
export function clearCancelAckTimer(): void {
  if (cancelAckTimer) {
    clearTimeout(cancelAckTimer);
    cancelAckTimer = null;
  }
}

// ============================================================
// Stream watchdog — death-detection for "..." bubble stuck forever
// ============================================================
//
// PROBLEM: if the server crashes / LLM upstream hangs / the WS enters a
// half-open TCP black hole while a stream is in-flight, NO `finish` /
// `cancel-ack` / `error` event ever arrives. streamingMessageId stays
// non-null, useStreamingStore.messageId stays non-null, and the empty
// placeholder bubble (content: []) keeps rendering TypingDots forever.
// The cancel-ack 15s timer only arms when the USER presses cancel, so
// it never fires in this scenario.
//
// FIX: arm a 90s watchdog when sendMessage succeeds. Any subsequent
// WS event in the active-stream handlers (text-delta / reasoning-*
// / tool-* / mcp-tool-* / step-*) re-arms it — proving the stream is
// alive. If 90s elapse with ZERO activity, the stream is presumed dead
// and we:
//   1. Send a `cancel` frame so the server stops the dying stream
//      (best-effort; the socket may already be dead, but send() on a
//      closed socket is a silent no-op, so it's safe to try).
//   2. finalize local stream state (commit accumulated content, clear
//      streamingMessageId / streamingSessionId / pending search meta,
//      reset useStreamingStore). This makes the TypingDots vanish.
//   3. wsService.reconnect() — close the socket and open a fresh one,
//      guaranteeing any in-flight frames on the old TCP byte stream
//      are discarded (new socket = fresh stream). This is the
//      "prevent stale data from coming back" half: even if the server
//      had queued tokens for the dead stream, they can't reach us.
//   4. Toast the user.
//
// The watchdog is disarmed on every legitimate stream-end path
// (finish / cancel-ack / finalizeOldStreamAndFlush / disconnectWebSocket)
// so it never fires after a clean teardown.
const STREAM_WATCHDOG_TIMEOUT_MS = 90_000;
let streamWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

function armStreamWatchdog(): void {
  if (streamWatchdogTimer) clearTimeout(streamWatchdogTimer);
  streamWatchdogTimer = setTimeout(() => {
    streamWatchdogTimer = null;
    triggerStreamWatchdogTimeout();
  }, STREAM_WATCHDOG_TIMEOUT_MS);
}

function disarmStreamWatchdog(): void {
  if (streamWatchdogTimer) {
    clearTimeout(streamWatchdogTimer);
    streamWatchdogTimer = null;
  }
}

/**
 * Watchdog fired: 90s with zero WS activity while a stream was in-flight.
 * Send cancel → finalize → reconnect → toast. See the block comment above
 * for the rationale and the ordering invariants.
 */
function triggerStreamWatchdogTimeout(): void {
  logger.warn('Chat', 'stream watchdog — 90s no WS activity, force-reconnecting');

  // Snapshot the stream identity BEFORE clearing — cancelStream needs
  // the sessionId, and we need streamingMessageId to commit content.
  const sessionIdToCancel = streamingSessionId;
  const placeholderId = streamingMessageId;

  // 1. Send the cancel frame first (best-effort; socket may be dead).
  //    wsService.cancelStream is a no-op when not OPEN, so this is safe.
  if (sessionIdToCancel) {
    wsService.cancelStream(sessionIdToCancel);
  }

  // 2. Finalize local stream state. We do NOT call
  //    finalizeOldStreamAndFlush() here because it would flush a queued
  //    pendingSendAfterCancel through sendMessage — but the socket is
  //    being torn down, so that send would race against reconnect().
  //    Instead, drop the queued send explicitly and run the same
  //    housekeeping inline (mark streaming parts completed → commit
  //    accumulated content → reset all stream-local state).
  clearCancelAckTimer();
  expectingCancelAck = false;

  const state = useChatStore.getState();
  if (state.currentSessionId && placeholderId) {
    updateStreamingContent(state.currentSessionId, (content) =>
      content.map((c) => {
        if (c.type === 'reasoning' && (c as ReasoningContent).state === 'streaming') {
          return { ...c, state: 'completed' as const };
        }
        if (c.type === 'text' && (c as TextContent).state === 'streaming') {
          return { ...c, state: 'completed' as const };
        }
        return c;
      })
    );
    commitStreamingToMessages(state.currentSessionId);
  }

  useChatStore.setState({
    isStreaming: false,
    streamingMessageId: null,
    streamingText: '',
    isWaitingForCancelAck: false,
    pendingSendAfterCancel: null, // drop queued send — socket is gone
  });
  useStreamingStore.getState().reset();

  streamingMessageId = null;
  streamingSessionId = null;
  lastWsMessageType = null;
  pendingSearchKeywords = null;
  pendingSearchSources = null;
  pendingVideoResults = null;
  pendingSearchSessionId = null;

  // 3. Drop the socket and open a fresh one. The fresh TCP byte stream
  //    guarantees no stale tokens from the dead stream can leak into
  //    the next stream's handlers (they'd have to arrive on the new
  //    socket, which the server can't send on behalf of a dead stream).
  wsService.reconnect();

  // 4. Toast the user — the typing dots vanished, the connection is
  //    being rebuilt, they can retry in a moment.
  useToastStore.getState().showToast({
    message: i18n.t('chatView.replyTimeout'),
    variant: 'warning',
  });
}

/** Track the type of the last received message for type-change detection */
let lastWsMessageType: string | null = null;

/** Out-of-order buffer: search keywords/results may arrive before `start` event */
let pendingSearchKeywords: string[] | null = null;
let pendingSearchSources: SourceLink[] | null = null;
let pendingVideoResults: VideoResult[] | null = null;
let pendingSearchSessionId: string | null = null;

/**
 * Per-session last-seen sequenceId for stream resume / chunk dedup.
 *
 * Updated on every text-delta / reasoning-delta that carries a sequenceId.
 * On WS reconnect, __connected__ handler sends an `attach` request with the
 * last known sequenceId so the server can replay missed chunks. Cleared on
 * `finish` / `error` / teardown.
 */
let sessionSequenceIds = new Map<string, number>();

/**
 * Dedup guard for stream chunks carrying a sequenceId. Returns true if the
 * chunk should be processed (new or higher sequenceId), false if it's a
 * duplicate or out-of-order replay chunk that should be dropped. Updates
 * the sessionSequenceIds map as a side effect when returning true.
 *
 * Chunks without a sequenceId (pre-resume normal stream) always pass.
 */
function shouldProcessChunk(sessionId: string, sequenceId: number | undefined): boolean {
  if (sequenceId === undefined) return true;
  const last = sessionSequenceIds.get(sessionId);
  if (last !== undefined && sequenceId <= last) return false;
  sessionSequenceIds.set(sessionId, sequenceId);
  return true;
}

/**
 * Apply an updater to the streaming message's content array.
 *
 * v3 Physical Isolation: writes go to `useStreamingStore` — NOT the messages
 * tree. This freezes `messages[sessionId]` so ChatView's `sessionMessages`
 * selector returns a stable reference across every WS token, preventing the
 * O(n) reconciliation storm that blocked the JS thread.
 *
 * The updater receives a shallow-copied array (each element is spread-cloned)
 * so mutations never touch Zustand state directly — same contract as before.
 * Returns true if a stream was active.
 */
function updateStreamingContent(
  _sessionId: string,
  updater: (content: MessageContent[]) => MessageContent[]
): boolean {
  const streamState = useStreamingStore.getState();
  if (!streamState.messageId) return false;
  useStreamingStore.getState().updateContent(updater);
  return true;
}

/**
 * Update metadata fields (searchKeywords / sources) on the streaming message.
 * v3: writes to `useStreamingStore`, not the messages tree.
 * Returns true if a stream was active.
 */
function updateStreamingMeta(
  _sessionId: string,
  meta: { searchKeywords?: string[]; sources?: SourceLink[]; videoResults?: VideoResult[] },
): boolean {
  const streamState = useStreamingStore.getState();
  if (!streamState.messageId) return false;
  useStreamingStore.getState().updateMeta(meta);
  return true;
}

function filterInternalStreamingContent(content: MessageContent[]): MessageContent[] {
  return content.filter((c) => {
    if (c.type !== 'data') return true;
    const dataType = (c as DataContent).dataType;
    if (typeof dataType !== 'string') return true;
    if (dataType.startsWith('data-om-')) return false;
    if (dataType.startsWith('data-sandbox-')) return false;
    return true;
  });
}

/**
 * 跨页合并判定:上一页(older,正在被 prepend 到 existing 前)的最后一条
 * 与 existing 的第一条时间相邻。若两者都是 assistant、sessionId 相同、
 * 双方 metadata.source 都为空,则合并为一个气泡(规范 §分页跨边界合并)。
 *
 * 合并方向:older 的 content parts 在前(更早),existing 首条的 content 在后。
 * id 保留 existing 首条的(最新一条,符合"id 取最新"规则,同时减少 React 重渲染)。
 * createdAt 取较早的;metadata 取首条不覆盖(older 优先)。
 *
 * 返回 { newPage, existing } — 已合并的版本(若未合并,原样返回引用)。
 */
function mergeCrossBoundaryMessages(
  newPage: ChatMessage[],
  existing: ChatMessage[],
): { newPage: ChatMessage[]; existing: ChatMessage[] } {
  if (newPage.length === 0 || existing.length === 0) return { newPage, existing };
  const lastNew = newPage[newPage.length - 1];
  const firstExisting = existing[0];
  if (
    lastNew.role !== 'assistant' ||
    firstExisting.role !== 'assistant' ||
    lastNew.sessionId !== firstExisting.sessionId
  ) {
    return { newPage, existing };
  }
  const lastNewSource = (lastNew.metadata as { source?: string } | undefined)?.source;
  const firstExistingSource = (firstExisting.metadata as { source?: string } | undefined)?.source;
  if (lastNewSource || firstExistingSource) return { newPage, existing };
  // 合并:older 在前,newer 在后;保留 existing 首条 id 以减少 React 重渲染
  const mergedFirstExisting: ChatMessage = {
    ...firstExisting,
    content: [...lastNew.content, ...firstExisting.content],
    createdAt:
      firstExisting.createdAt.getTime() <= lastNew.createdAt.getTime()
        ? firstExisting.createdAt
        : lastNew.createdAt,
    metadata: lastNew.metadata ?? firstExisting.metadata,
  };
  return {
    newPage: newPage.slice(0, -1),
    existing: [mergedFirstExisting, ...existing.slice(1)],
  };
}

/**
 * Reconcile the placeholder assistant message's client UUID with the
 * server-assigned UUID carried in the `start` event.
 *
 * WHY
 * ────────────────────────────────────────────────────────────────
 * `sendMessage` creates an optimistic AI placeholder immediately (via
 * `addMessage` → `randomUUID()`) so the user sees a typing-dots bubble
 * without waiting for the WS `start` event. The server, however, assigns
 * its own UUID to the assistant message (the client never sends an AI id
 * in the `chat` payload — only the user message id).
 *
 * Before this reconciliation, the placeholder kept its client UUID while
 * the server snapshot used a different UUID. `loadMessages` (background
 * refresh) then saw two messages with different ids and identical content
 * → the "AI 回复内容重复显示" bug.
 *
 * WHAT
 * ────────────────────────────────────────────────────────────────
 * When `start` arrives, `start.payload.messageId` is the server's UUID.
 * This function retargets every reference from the old client UUID to
 * the new server UUID in one atomic pass:
 *
 *   1. `messages[sessionId]` array — placeholder.id
 *   2. `streamingMessageId` module variable
 *   3. `useStreamingStore.messageId`
 *   4. `useChatStore.streamingMessageId`
 *   5. native MarkdownSession Map key (migrateStreamingSession)
 *   6. SQLite — delete the stale old-id row (commit will write the new id)
 *
 * GUARDS
 * ────────────────────────────────────────────────────────────────
 *   - `oldId === newId` → no-op (server reused our UUID, or replay start)
 *   - placeholder not found in messages array → skip messages/SQLite parts
 *   - streamingStore not active for oldId → skip migrate
 */
function reconcilePlaceholderId(oldId: string, newId: string, sessionId: string): void {
  if (oldId === newId) return;

  const state = useChatStore.getState();
  const msgs = state.messages[sessionId] || [];
  const idx = msgs.findIndex((m) => m.id === oldId);

  // 1+4. messages array (placeholder.id) + useChatStore.streamingMessageId
  if (idx !== -1) {
    const updated = { ...msgs[idx], id: newId };
    useChatStore.setState({
      messages: {
        ...state.messages,
        [sessionId]: [...msgs.slice(0, idx), updated, ...msgs.slice(idx + 1)],
      },
      streamingMessageId: newId,
    });
  } else {
    // Placeholder already gone (e.g. finish raced ahead) — still retarget
    // the store-level streamingMessageId if it was pointing at oldId.
    if (state.streamingMessageId === oldId) {
      useChatStore.setState({ streamingMessageId: newId });
    }
  }

  // 2. module variable
  streamingMessageId = newId;

  // 3. streamingStore.messageId (content/metadata stay untouched — only
  //    the id changes so endStreaming() returns the right content).
  useStreamingStore.setState({ messageId: newId });

  // 5. native MarkdownSession Map key
  migrateStreamingSession(oldId, newId);

  // 6. SQLite — remove the stale old-id row. The new-id row will be
  //    written by `syncMessageToDb` when `commitStreamingToMessages` runs.
  if (isDbReady() && idx !== -1) {
    const uid = getCurrentUserId();
    if (uid) dbDeleteMessage(oldId, uid).catch(() => {});
  }

  logger.info('Chat', 'reconcilePlaceholderId', { oldId, newId, sessionId });
}

/**
 * Commit the streaming content back into the messages tree as a single atomic
 * update, then reset the streaming store. Called at finish / cancel-ack / error.
 *
 * v3: during streaming the placeholder message in the messages tree has empty
 * content (frozen). This function flushes the accumulated content from
 * `useStreamingStore` into the placeholder in one shot, so the messages tree
 * only changes ONCE per stream — not once per token.
 */
function commitStreamingToMessages(sessionId: string): void {
  const result = useStreamingStore.getState().endStreaming();
  if (!result) return;

  const filteredContent = filterInternalStreamingContent(result.content);

  const state = useChatStore.getState();
  const sessionMessages = state.messages[sessionId] || [];
  const msgIdx = sessionMessages.findIndex(m => m.id === streamingMessageId);
  if (msgIdx === -1) return;

  const msg = sessionMessages[msgIdx];

  if (filteredContent.length === 0 && !result.videoResults?.length) {
    const filtered = sessionMessages.filter(m => m.id !== streamingMessageId);
    useChatStore.setState({
      messages: { ...state.messages, [sessionId]: filtered },
    });
    // SQLite: remove the empty placeholder
    if (isDbReady() && streamingMessageId) {
      const uid = getCurrentUserId();
      if (uid) dbDeleteMessage(streamingMessageId, uid).catch(() => {});
    }
    return;
  }

  const updatedMsg: ChatMessage = {
    ...msg,
    ...(filteredContent.length > 0 ? { content: filteredContent } : {}),
    ...(result.searchKeywords ? { searchKeywords: result.searchKeywords } : {}),
    ...(result.sources       ? { sources:       result.sources }       : {}),
    ...(result.videoResults  ? { videoResults:  result.videoResults }  : {}),
    ...(result.metadata      ? { metadata:      result.metadata }      : {}),
  };

  useChatStore.setState({
    messages: {
      ...state.messages,
      [sessionId]: [
        ...sessionMessages.slice(0, msgIdx),
        updatedMsg,
        ...sessionMessages.slice(msgIdx + 1),
      ],
    },
  });
  // SQLite: persist the committed message
  syncMessageToDb(updatedMsg);
}

/**
 * v19B (delayed-commit): Finalize the OLD (cancelled) stream — commit its
 * full accumulated content (including in-flight tokens that arrived between
 * cancelStream() and cancel-ack) as history, clear streaming state, arm the
 * start-gate, and flush the queued send.
 *
 * Shared by the cancel-ack handler and the 15s timeout safety net so both
 * paths perform identical housekeeping.
 *
 * PRECONDITION: streamingMessageId = m_OLD (still receiving tokens), or null
 * (if an OLD finish already landed and cleaned up). On return,
 * streamingMessageId = m_NEW (placeholder for the new stream) or null if no
 * pending send.
 */
function finalizeOldStreamAndFlush(): void {
  const state = useChatStore.getState();
  const { currentSessionId } = state;
  // Mark m_OLD's in-flight parts as completed so the historical bubble
  // stops showing TypingDots / spinner once committed.
  if (currentSessionId && streamingMessageId) {
    updateStreamingContent(currentSessionId, (content) =>
      content.map((c) => {
        if (c.type === 'reasoning' && (c as ReasoningContent).state === 'streaming') {
          return { ...c, state: 'completed' as const };
        }
        if (c.type === 'text' && (c as TextContent).state === 'streaming') {
          return { ...c, state: 'completed' as const };
        }
        return c;
      })
    );
    commitStreamingToMessages(currentSessionId);
    // Drop empty placeholder (no tokens arrived for m_OLD before cancel).
    // commitStreamingToMessages already removes empty messages, but keep
    // this belt-and-suspenders guard for the role check edge case.
    const msgs = useChatStore.getState().messages[currentSessionId] || [];
    const committed = msgs.find(m => m.id === streamingMessageId);
    if (committed && committed.role === 'assistant' && committed.content.length === 0) {
      useChatStore.setState({
        messages: {
          ...useChatStore.getState().messages,
          [currentSessionId]: msgs.filter(m => m.id !== streamingMessageId),
        },
      });
    }
  }
  useChatStore.setState({
    isStreaming: false,
    streamingMessageId: null,
    streamingText: '',
  });
  streamingMessageId = null;
  streamingSessionId = null;
  lastWsMessageType = null;
  pendingSearchKeywords = null;
  pendingSearchSources = null;
  pendingVideoResults = null;
  pendingSearchSessionId = null;
  // The stream is finalized — drop the watchdog so it can't fire after
  // cleanup and tear down a socket that's about to carry the NEXT stream
  // (flushPendingSendAfterCancel below may immediately call sendMessage
  // which arms a fresh watchdog).
  disarmStreamWatchdog();
  // Arm the start-gate: a stale `finish` from the OLD stream may still
  // arrive (server sent cancel-ack, but a finish was already in flight on
  // the WS pipe). The gate tells the finish handler to drop it so it
  // doesn't clobber the NEW placeholder (TypingDots vanishing bug).
  expectingNewStreamStart = true;
  // Flush the queued message. flushPendingSendAfterCancel is a no-op when
  // pendingSendAfterCancel is null (pure cancel, no queued send).
  useChatStore.getState().flushPendingSendAfterCancel();
}

/**
 * Flush buffered search keywords/sources into the streaming message.
 * Called when `start` event arrives (creates the message the buffer was waiting for).
 * Validates session match to prevent cross-session contamination (P5).
 */
function flushPendingSearchMeta(): void {
  const state = useChatStore.getState();
  const sessionId = state.currentSessionId;
  if (!sessionId || !streamingMessageId) {
    // Still no target — keep buffering, don't clear
    return;
  }
  // Session isolation: discard buffer if session changed since buffering
  if (pendingSearchSessionId && pendingSearchSessionId !== sessionId) {
    pendingSearchKeywords = null;
    pendingSearchSources = null;
    pendingVideoResults = null;
    pendingSearchSessionId = null;
    return;
  }
  const meta: { searchKeywords?: string[]; sources?: SourceLink[]; videoResults?: VideoResult[] } = {};
  if (pendingSearchKeywords) meta.searchKeywords = pendingSearchKeywords;
  if (pendingSearchSources) meta.sources = pendingSearchSources;
  if (pendingVideoResults) meta.videoResults = pendingVideoResults;
  if (Object.keys(meta).length === 0) return;
  updateStreamingMeta(sessionId, meta);
  pendingSearchKeywords = null;
  pendingSearchSources = null;
  pendingVideoResults = null;
  pendingSearchSessionId = null;
}

/**
 * Append `delta` text to the last TextContent part (or create a new one).
 * Returns a **new** content array with a brand-new TextContent object —
 * never mutates the input array or its elements.
 */
function appendTextDelta(content: MessageContent[], delta: string): MessageContent[] {
  // Only append to the VERY LAST part if it's already text.
  // If the last part is a tool-invocation (or anything non-text), start a new text part.
  // This preserves segmentation: text → tool → text stays as 3 separate parts.
  const last = content[content.length - 1];
  if (last && last.type === 'text') {
    const updated: TextContent = {
      ...(last as TextContent),
      text: (last as TextContent).text + delta,
      state: 'streaming',
    };
    return [...content.slice(0, -1), updated];
  }
  // Last part is not text (or content is empty) — create a new text part
  const newPart: TextContent = { type: 'text', text: delta, state: 'streaming' };
  return [...content, newPart];
}

/** Find the last reasoning part in content (for reasoning-end completion) */
function findLastReasoningPart(content: MessageContent[]): ReasoningContent | undefined {
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'reasoning') return content[i] as ReasoningContent;
  }
  return undefined;
}

/**
 * Append `delta` text to the last ReasoningContent part (or create a new one).
 * Same segmentation logic as appendTextDelta: only appends to the VERY LAST part
 * if it's already reasoning. Otherwise creates a new reasoning part.
 */
function appendReasoningDelta(content: MessageContent[], delta: string): MessageContent[] {
  const last = content[content.length - 1];
  if (last && last.type === 'reasoning') {
    const updated: ReasoningContent = {
      ...(last as ReasoningContent),
      text: (last as ReasoningContent).text + delta,
      state: 'streaming',
      expanded: true,
    };
    return [...content.slice(0, -1), updated];
  }
  const newPart: ReasoningContent = { type: 'reasoning', text: delta, state: 'streaming', expanded: true };
  return [...content, newPart];
}

/** Find a tool-invocation part by toolCallId */
function findToolPart(content: MessageContent[], toolCallId: string): ToolInvocationContent | undefined {
  return content.find(
    (c): c is ToolInvocationContent => c.type === 'tool-invocation' && c.toolCallId === toolCallId
  );
}

/**
 * ── v18e: WS event session-isolation guard ──────────────────────────────
 *
 * Root cause of the "session 已经改变" toast at WS end:
 *   When the user switches chat sessions mid-stream, the WS connection stays
 *   open and the OLD stream's late-arriving events (text-delta / finish /
 *   cancel-ack / error / …) still reach the JS handlers. They are then
 *   processed against the NEW currentSessionId, which:
 *     - writes tokens into the wrong bubble (`commitStreamingToMessages`),
 *     - sets `state.error` for a stream the user has already abandoned,
 *     - clears `streamingMessageId` while a NEW stream may already be active.
 *
 * The fix: every WS handler MUST resolve the authoritative sessionId from
 * the event payload (when the server provides one) and drop the event when
 * it doesn't match the session the user is currently looking at (or the
 * session whose stream is in-flight). The captured session a stream
 * belongs to is whatever sessionId was current at `start` — for events
 * after `start`, that's `state.currentSessionId` at handler time.
 *
 * For events that arrive BEFORE `start` (data-search-keywords /
 * data-search-results), we still drop them if they don't match the
 * current session, so a stale search-meta from a previous session can't
 * leak into the new bubble.
 *
 * This helper is the single source of truth for that check — handlers call
 * it at the top and bail when it returns `null` (means "ignore this event").
 */
function resolveEventSessionId(event: any, fallbackState: ReturnType<typeof useChatStore.getState>): string | null {
  const eventSessionId: string | undefined =
    typeof event?.sessionId === 'string' && event.sessionId.length > 0 ? event.sessionId : undefined;
  // Prefer the event's own sessionId (authoritative — server knows which
  // stream it belongs to). Fall back to the store's currentSessionId only
  // for events that don't carry one (rare; legacy protocol buffer).
  const authoritative = eventSessionId ?? fallbackState.currentSessionId ?? null;
  if (!authoritative) return null;
  // If a stream is in-flight, drop events for any other session — they're
  // stale tokens/acks/errors for a stream the user has already navigated
  // away from. Without this guard, late-arriving tokens would mutate the
  // NEW currentSessionId's bubble.
  if (streamingMessageId && authoritative !== fallbackState.currentSessionId) {
    return null;
  }
  return authoritative;
}

// ============================================================
// AppState foreground recovery
// ============================================================

/** Minimum background duration (ms) before triggering a refetch on return. */
const BACKGROUND_REFETCH_THRESHOLD_MS = 5000;

let appStateListenerActive = false;
let backgroundedAt: number | null = null;

/**
 * Listen for AppState transitions. When the app returns to the foreground
 * after being backgrounded for > BACKGROUND_REFETCH_THRESHOLD_MS, refetch
 * sessions + current session messages to catch up on anything the WS
 * may have missed while the app was not active.
 *
 * Safe to call multiple times — only registers once.
 */
function setupAppStateListener(): void {
  if (appStateListenerActive) return;
  appStateListenerActive = true;

  const subscription = AppState.addEventListener('change', (nextAppState) => {
    if (nextAppState === 'background' || nextAppState === 'inactive') {
      backgroundedAt = Date.now();
      return;
    }

    // nextAppState === 'active'
    if (backgroundedAt === null) return;
    const elapsed = Date.now() - backgroundedAt;
    backgroundedAt = null;

    if (elapsed < BACKGROUND_REFETCH_THRESHOLD_MS) return;

    // Guard: skip refetch if user logged out while backgrounded.
    // Without this, loadSessions() fires an authed request with no token
    // → 401 → unwanted "Session Expired" toast.
    if (!useAuthStore.getState().isAuthenticated) return;

    // App was away long enough that the WS may have dropped events.
    // Refetch sessions + current session messages from the server.
    const state = useChatStore.getState();
    state.loadSessions();
    if (state.currentSessionId) {
      state.loadMessages(state.currentSessionId);
    }
  });

  // Best-effort cleanup: remove the listener when the module is torn down.
  // In practice this listener lives for the app's lifetime.
  // (subscription.remove is available on RN's AppStateEventListener)
}

export function setupWebSocketHandlers(): () => void {
  if (wsInitialized) return () => { };
  wsInitialized = true;

  // Register AppState foreground recovery listener (once)
  setupAppStateListener();

  // ── start: backend begins streaming a new assistant response ──
  const unsubStart = wsService.on('start', (event) => {
    const state = useChatStore.getState();
    if (!state.currentSessionId) return;
    // v19 race-fix: NEW stream's start arrived — clear the gate so the
    // finish handler stops dropping finishes. Any future finish is now
    // attributable to THIS stream.
    expectingNewStreamStart = false;
    lastWsMessageType = 'start';

    // Reset auto-play sentence accumulator for the new stream
    autoPlayTextBuffer = '';

    // Placeholder assistant message was already created in sendMessage.
    // Only create one if it doesn't exist (e.g. WS reconnect).
    if (!streamingMessageId) {
      const msg = state.addMessage(state.currentSessionId, {
        sessionId: state.currentSessionId,
        role: 'assistant',
        content: [],
      });
      streamingMessageId = msg.id;
      streamingSessionId = state.currentSessionId;
      // v3: init streaming store for this stream
      useStreamingStore.getState().startStreaming(msg.id);
      useChatStore.setState({ isStreaming: true, streamingMessageId: msg.id, streamingText: '' });
    }

    // ── Reconcile placeholder id with server-assigned messageId ──────────
    // The placeholder was created with a client UUID (addMessage →
    // randomUUID). The server assigns its own UUID to the assistant
    // message, carried here in `start.payload.messageId`. Without
    // reconciliation the placeholder (client UUID) and the server snapshot
    // (server UUID) would appear as two separate messages with identical
    // content → "AI 回复内容重复显示" bug. See `reconcilePlaceholderId`
    // above for the full 6-point retarget.
    const startPayload = (event as any).payload ?? {};
    const serverMsgId: string | undefined =
      typeof startPayload.messageId === 'string' && startPayload.messageId.length > 0
        ? startPayload.messageId
        : typeof startPayload.id === 'string' && startPayload.id.length > 0
          ? startPayload.id
          : typeof (event as any).msgId === 'string' && (event as any).msgId.length > 0
            ? (event as any).msgId
            : undefined;
    if (serverMsgId && streamingMessageId && serverMsgId !== streamingMessageId) {
      reconcilePlaceholderId(streamingMessageId, serverMsgId, state.currentSessionId);
    }

    // If the server's start event carries an explicit sessionId, treat it as
    // authoritative for this stream — overrides the value guessed from
    // currentSessionId above. This lets the text-delta guard reject stale
    // tokens even when sendMessage's guess was wrong (e.g. rapid session
    // switching between send and start arrival).
    const startEventSessId = typeof (event as any).sessionId === 'string'
      ? (event as any).sessionId
      : null;
    if (startEventSessId && startEventSessId.length > 0) {
      streamingSessionId = startEventSessId;
    }

    // Reset sequence tracking for this new stream (clear any stale entries
    // from a previous stream on the same session).
    if (streamingSessionId) {
      sessionSequenceIds.delete(streamingSessionId);
    }

    // Flush out-of-order search metadata buffered before `start`
    flushPendingSearchMeta();
  });

  // -- text-delta: incremental text content -- only keep type=text --
  const unsubDelta = wsService.on('text-delta', (event) => {
    // ── v13: catch "Maximum update depth exceeded" at the WS handler boundary ──
    // If any downstream subscriber triggers a re-entrant setState loop, React
    // throws "Maximum update depth exceeded". Without this try/catch, the
    // throw bubbles up to the WS emit loop (services/websocket.ts line 328)
    // and the WS stream effectively dies for the rest of the message. With
    // this catch we log the error + drop the offending token so the stream
    // continues. Combined with `[streaming.updateContent]` stack-trace logs
    // (added v13), this gives us hard evidence of the loop while keeping
    // the user-facing stream alive.
    try {
      // v19A race-fix (Start-gate) v2: when the gate is armed (cancel-ack
      // flushed m_NEW but its `start` hasn't arrived yet), ANY text-delta
      // landing now is a STALE token from m_OLD still in the WS pipe.
      // Dropping it (instead of the old "clear gate" behavior) is correct
      // because:
      //   - Server protocol guarantees m_NEW's delta arrives AFTER m_NEW's
      //     start, and start clears the gate. So gate-armed ⇒ not m_NEW.
      //   - User requirement: tokens arriving AFTER cancel-ok may be
      //     dropped ("在收到cancel-ok前继续接收第一条消息的数据").
      // The previous code cleared the gate here, which let a stale m_OLD
      // delta disable the gate just before a stale m_OLD finish arrived,
      // causing the finish handler to commit m_NEW with m_OLD's trailing
      // tokens (the "m_OLD 被截断成两段, 后半段出现在 m_NEW bubble" bug).
      if (expectingNewStreamStart) {
        return;
      }
      const state = useChatStore.getState();
      const payload = (event as any).payload;
      if (!payload?.text) return;
      // ── v18e: drop tokens for any session other than the one the user is
      //   currently looking at. This fixes the "session 已经改变" toast where
      //   late-arriving tokens from a stream the user has already navigated
      //   away from were being written into the new currentSessionId's bubble.
      const eventSessionId = resolveEventSessionId(event, state);
      if (!eventSessionId) return;
      const { currentSessionId } = state;
      if (!currentSessionId || !streamingMessageId) return;

      // ── Stale-stream guard (root-cause fix for text duplication) ──
      // streamingSessionId records which session owns the active stream.
      // If the user switched sessions without cancelling (e.g. "new chat"
      // during streaming), late-arriving deltas from the OLD stream would
      // otherwise leak into the NEW session's bubble because
      // resolveEventSessionId falls back to currentSessionId when the
      // server omits the optional `sessionId` field (making its internal
      // guard a self-comparison that never fires). Reject any delta whose
      // session doesn't match the stream's owner.
      if (streamingSessionId) {
        const rawEventSessId = typeof (event as any).sessionId === 'string'
          && (event as any).sessionId.length > 0
          ? (event as any).sessionId
          : null;
        // Event carries explicit sessionId → strict match
        if (rawEventSessId && rawEventSessId !== streamingSessionId) return;
        // Event has no sessionId → trust streamingSessionId and verify the
        // user is still looking at the stream's owning session
        if (!rawEventSessId && currentSessionId !== streamingSessionId) return;
      }

      // ── Resume/dedup: drop duplicate chunks based on sequenceId ──
      // Replay chunks (after WS reconnect + attach) carry a sequenceId.
      // If we've already seen this sequenceId or a higher one, drop it.
      if (!shouldProcessChunk(eventSessionId,
        typeof (event as any).sequenceId === 'number' ? (event as any).sequenceId : undefined,
      )) return;

      let rawText = payload.text;
      // Come and remove the special characters
      rawText = rawText.replace(/<\/mm:think>\s*/, '')
      if (!rawText) {
        return
      }

      updateStreamingContent(currentSessionId, (content) => {
        return appendTextDelta(content, rawText);
      });
      // ── v18d: push the same delta into the C++ HybridObject session ──
      // MarkdownStream reads from this session, so any incremental render
      // picks up the new suffix range via RAF tick. We append AFTER
      // updateStreamingContent so the native AST is always ≥ the JS-visible
      // text (no "native behind JS" window that would cause re-parse of the
      // whole accumulated string). On bridge failure we fall back to reset
      // inside `appendToStreamingSession`, which keeps the session in sync.
      appendToStreamingSession(streamingMessageId, rawText);
      lastWsMessageType = 'text-delta';

      // ── Auto-play TTS: accumulate text and flush complete sentences ──
      // Sentence boundary = CJK + ASCII terminal punctuation plus soft
      // punctuation (comma/semicolon/colon) so streaming flushes earlier and
      // run-on clauses don't pile up. We split AFTER the delimiter (lookbehind)
      // so each enqueued unit includes its punctuation. The trailing partial
      // (no delimiter yet) stays in the buffer for the next delta; the
      // remainder is flushed on finish. Note: enqueueText runs the full
      // splitForTts pipeline (re-split + short-fragment merge + terminal-punct
      // enforcement), so this split is purely a latency/flush-timing hint.
      if (useAuthStore.getState().user?.chatSetting.autoPlay) {
        autoPlayTextBuffer += rawText;
        const parts = autoPlayTextBuffer.split(/(?<=[。！？\n.!?？，；：,;:])/);
        autoPlayTextBuffer = parts.pop() || '';
        for (const part of parts) {
          const trimmed = part.trim();
          if (trimmed) {
            useTtsStore.getState().enqueueText(trimmed, streamingMessageId);
          }
        }
      }
    } catch (e) {
      // Surface the error but don't crash the stream. v13 diagnostic:
      // if this fires repeatedly, check the matching
      // `[streaming.updateContent]` stack-trace in the same logcat window.
      console.error(
        `[WS-RX][${new Date().toISOString()}] text-delta handler threw — dropping token to keep stream alive:`,
        e,
      );
    }
  });

  // ── reasoning-start: model begins thinking ──
  const unsubReasoningStart = wsService.on('reasoning-start', (event) => {
    const state = useChatStore.getState();
    // v18e: drop stale-session events before doing any state work
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    lastWsMessageType = 'reasoning-start';

    updateStreamingContent(state.currentSessionId, (content) => {
      // Only create a new reasoning part if the last part is not already reasoning
      const last = content[content.length - 1];
      if (last && last.type === 'reasoning') return content;
      const reasoningPart: ReasoningContent = {
        type: 'reasoning',
        text: '',
        state: 'streaming',
        expanded: true,
      };
      return [...content, reasoningPart];
    });
  });

  // ── reasoning-delta: incremental reasoning text ──
  const unsubReasoningDelta = wsService.on('reasoning-delta', (event) => {
    const payload = (event as any).payload as { text?: string } | undefined;
    if (!payload?.text) return;
    const state = useChatStore.getState();
    // v18e: drop stale-session events before doing any state work
    const reasoningEvtSessId = resolveEventSessionId(event, state);
    if (!reasoningEvtSessId) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    // ── Resume/dedup: drop duplicate chunks based on sequenceId ──
    if (!shouldProcessChunk(reasoningEvtSessId,
      typeof (event as any).sequenceId === 'number' ? (event as any).sequenceId : undefined,
    )) return;
    lastWsMessageType = 'reasoning-delta';

    updateStreamingContent(state.currentSessionId, (content) => {
      return appendReasoningDelta(content, payload.text!);
    });
  });

  // ── reasoning-end: reasoning complete ──
  // v18e: take `event` param so we can run session-isolation guard (was a
  // zero-arg lambda before — late-arriving reasoning-end for an abandoned
  // stream would have marked the new session's reasoning as completed).
  const unsubReasoningEnd = wsService.on('reasoning-end', (event) => {
    const state = useChatStore.getState();
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    lastWsMessageType = 'reasoning-end';

    updateStreamingContent(state.currentSessionId, (content) => {
      const rp = findLastReasoningPart(content);
      if (rp) {
        const idx = content.indexOf(rp);
        if (idx !== -1) {
          return [
            ...content.slice(0, idx),
            { ...rp, state: 'completed' as const, expanded: false },
            ...content.slice(idx + 1),
          ];
        }
      }
      return content;
    });
  });

  // ── tool-call: new tool invocation ──
  const unsubToolCall = wsService.on('tool-call', (event) => {
    const payload = (event as any).payload as { toolCallId: string; toolName: string; args: Record<string, unknown> } | undefined;
    if (!payload?.toolCallId) return;
    const state = useChatStore.getState();
    // v18e: drop stale-session events before doing any state work
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    lastWsMessageType = 'tool-call';

    updateStreamingContent(state.currentSessionId, (content) => {
      // Skip if tool part already exists (e.g., created by mcp-tool-call)
      if (findToolPart(content, payload.toolCallId)) return content;
      const rawName = payload.toolName ?? 'tool';
      const toolPart: ToolInvocationContent = {
        type: 'tool-invocation',
        toolCallId: String(payload.toolCallId ?? ''),
        toolName: typeof rawName === 'string' ? rawName : String((rawName as any)?.name ?? JSON.stringify(rawName)),
        args: payload.args,
        state: 'input-available',
      };
      return [...content, toolPart];
    });
  });

  // ── tool-progress: real-time progress for long-running tools (e.g., image generation) ──
  const unsubToolProgress = wsService.on('tool-progress', (event) => {
    const payload = (event as any).payload as { toolCallId?: string; toolName: string; value: number; max: number; step?: string } | undefined;
    if (!payload?.toolName || typeof payload.value !== 'number' || typeof payload.max !== 'number') return;
    const state = useChatStore.getState();
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;

    updateStreamingContent(state.currentSessionId, (content) => {
      // Match by toolCallId if provided
      if (payload.toolCallId) {
        const tp = findToolPart(content, payload.toolCallId);
        if (tp) {
          return content.map(c =>
            c === tp ? { ...tp, progress: { value: payload.value, max: payload.max, step: payload.step } } : c
          );
        }
      }
      // Fallback: match by toolName (find last matching tool-invocation part)
      for (let i = content.length - 1; i >= 0; i--) {
        const c = content[i];
        if (c.type === 'tool-invocation' && (c as ToolInvocationContent).toolName === payload.toolName) {
          return content.map((item, idx) =>
            idx === i ? { ...item, progress: { value: payload.value, max: payload.max, step: payload.step } } : item
          );
        }
      }
      return content;
    });
  });

  // ── tool-result: tool execution result ──
  const unsubToolResult = wsService.on('tool-result', (event) => {
    const payload = (event as any).payload as { toolCallId: string; toolName: string; result: unknown } | undefined;
    if (!payload?.toolCallId) return;
    const state = useChatStore.getState();
    // v18e: drop stale-session events before doing any state work
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;

    // Special handling: image tools render the result image directly
    // (txt2imageTool = generate, textEditImageTool = edit).
    if (payload.toolName === 'txt2imageTool' || payload.toolName === 'textEditImageTool') {
      lastWsMessageType = 'tool-call';
      updateStreamingContent(state.currentSessionId, (content) => {
        // Remove the tool-invocation part entirely — the image replaces it
        const withoutTool = content.filter(c =>
          !(c.type === 'tool-invocation' && (c as ToolInvocationContent).toolCallId === payload.toolCallId)
        );
        const result = (payload.result as Record<string, unknown> | undefined) ?? {};
        const imageUrl = result?.imageUrl;
        // Failure protocol: imageUrl is null (txt-2-image) or an "Error: ..."
        // string (edit-2-image) on failure. Don't append a broken image —
        // the agent's follow-up text explains what went wrong.
        if (typeof imageUrl !== 'string' || imageUrl.startsWith('Error:')) {
          return withoutTool;
        }
        // Append the generated/edited image
        const imageContent: ImageContent = {
          type: 'image',
          uri: imageUrl,
        };
        return [...withoutTool, imageContent];
      });
      return;
    }

    // General tool result: update existing tool-invocation part
    // Extract structuredContent from result if present (MCP tools like calculatorTool
    // embed structuredContent inside payload.result.structuredContent)
    lastWsMessageType = 'tool-result';
    const resultObj = payload.result as Record<string, unknown> | undefined;
    const extractedStructured = resultObj?.structuredContent as McpStructuredContent | undefined;

    updateStreamingContent(state.currentSessionId, (content) => {
      const tp = findToolPart(content, payload.toolCallId);
      if (tp) {
        return content.map(c =>
          c === tp ? {
            ...tp,
            result: payload.result,
            state: 'output-available' as const,
            ...(extractedStructured ? { structuredContent: extractedStructured } : {}),
          } : c
        );
      }
      return content;
    });
  });

  // ── creation-job-update: job watcher pushes progress for a video/creation
  //     tool card → refresh the matching tool-invocation part's result. ──
  const unsubCreationJobUpdate = wsService.on('creation-job-update', (event) => {
    const payload = (event as any).payload as {
      toolCallId?: string; status?: string; progress?: number; artifacts?: unknown[]; error?: { code?: string; message?: string } | null;
    } | undefined;
    if (!payload?.toolCallId) return;
    const state = useChatStore.getState();
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    updateStreamingContent(state.currentSessionId, (content) => {
      const tp = findToolPart(content, payload.toolCallId!);
      if (!tp) return content;
      return content.map(c =>
        c === tp ? {
          ...tp,
          result: {
            ...((tp.result as Record<string, unknown> | undefined) ?? {}),
            status: payload.status,
            progress: payload.progress,
            artifacts: payload.artifacts,
            error: payload.error,
          },
          ...(payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled'
            ? { state: 'output-available' as const }
            : {}),
        } : c,
      );
    });
  });

  // ── creation-failed: job watcher reports a failed video generation. Append
  //     a separate assistant message with the localized failure text. ──
  const unsubCreationFailed = wsService.on('creation-failed', (event) => {
    const payload = (event as any).payload as {
      messageId?: string; role?: string; parts?: Array<Record<string, unknown>>;
    } | undefined;
    if (!payload?.parts?.length) return;
    const state = useChatStore.getState();
    if (!resolveEventSessionId(event, state)) return;
    const sid = (event as any).sessionId || state.currentSessionId;
    if (!sid) return;

    const content: MessageContent[] = [];
    for (const p of payload.parts) {
      if (p.type === 'text' && typeof p.text === 'string') {
        content.push({ type: 'text', text: p.text, state: 'completed' as const });
      }
    }
    if (content.length === 0) return;

    state.addMessage(sid, {
      sessionId: sid,
      role: 'assistant',
      content,
      metadata: { source: 'creation-failed' },
    });
  });

  // ── creation-complete: job watcher pushed a NEW assistant message that
  //     references the finished video (Doubao-style completion). Append it as
  //     a separate bubble (metadata.source prevents merge). ──
  const unsubCreationComplete = wsService.on('creation-complete', (event) => {
    const payload = (event as any).payload as {
      messageId?: string; role?: string; parts?: Array<Record<string, unknown>>; readyText?: string;
    } | undefined;
    if (!payload?.parts?.length) return;
    const state = useChatStore.getState();
    if (!resolveEventSessionId(event, state)) return;
    const sid = (event as any).sessionId || state.currentSessionId;
    if (!sid) return;

    const content: MessageContent[] = [];
    for (const p of payload.parts) {
      if (p.type === 'creation-ref' && typeof p.text === 'string' && p.text.trim()) {
        const ref: CreationRefContent = { type: 'creation-ref', text: p.text };
        content.push(ref);
      } else if (p.type === 'file') {
        const file: FileContent = {
          type: 'file',
          name: typeof p.filename === 'string' ? p.filename : 'video.mp4',
          uri: typeof p.data === 'string' ? p.data : '',
          mediaType: typeof p.mimeType === 'string' ? p.mimeType : 'video/mp4',
        };
        content.push(file);
      }
    }
    if (content.length === 0) return;

    state.addMessage(sid, {
      sessionId: sid,
      role: 'assistant',
      content,
      metadata: {
        source: 'creation-complete',
        ...(payload.readyText && payload.readyText.trim() ? { readyText: payload.readyText } : {}),
      },
    });
  });

  // ── tool-error: tool execution error ──
  const unsubToolError = wsService.on('tool-error', (event) => {
    const payload = (event as any).payload as { toolCallId: string; toolName: string; error: string } | undefined;
    if (!payload?.toolCallId) return;
    const state = useChatStore.getState();
    // v18e: drop stale-session events before doing any state work
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    lastWsMessageType = 'tool-error';

    updateStreamingContent(state.currentSessionId, (content) => {
      const tp = findToolPart(content, payload.toolCallId);
      if (tp) {
        return content.map(c =>
          c === tp ? { ...tp, state: 'output-error' as const, errorText: payload.error } : c
        );
      }
      return content;
    });
  });

  // ── tool-call-approval: tool waiting for user approval ──
  const unsubToolApproval = wsService.on('tool-call-approval', (event) => {
    const payload = (event as any).payload as { toolCallId: string; toolName: string; args: Record<string, unknown>; runId: string } | undefined;
    if (!payload?.toolCallId) return;
    const state = useChatStore.getState();
    // v18e: drop stale-session events before doing any state work
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    lastWsMessageType = 'tool-call-approval';

    // Track in pendingToolApprovals for respondToToolApproval
    const rawName = payload.toolName ?? 'tool';
    const safeToolName = typeof rawName === 'string' ? rawName : String((rawName as any)?.name ?? JSON.stringify(rawName));
    useChatStore.setState((s) => ({
      pendingToolApprovals: {
        ...s.pendingToolApprovals,
        [payload.toolCallId]: { runId: payload.runId, toolName: safeToolName },
      },
    }));

    updateStreamingContent(state.currentSessionId, (content) => {
      const tp = findToolPart(content, payload.toolCallId);
      if (tp) {
        return content.map(c =>
          c === tp ? { ...tp, state: 'approval-requested' as const, args: payload.args } : c
        );
      }
      // New tool part
      const newTp: ToolInvocationContent = {
        type: 'tool-invocation',
        toolCallId: String(payload.toolCallId ?? ''),
        toolName: safeToolName,
        args: payload.args,
        state: 'approval-requested',
      };
      return [...content, newTp];
    });
  });

  // ── mcp-tool-call: MCP interactive tool invocation ──
  const unsubMcpToolCall = wsService.on('mcp-tool-call', (event) => {
    const payload = (event as any).payload as { toolCallId: string; toolName: string; args: Record<string, unknown> } | undefined;
    if (!payload?.toolCallId) return;
    const state = useChatStore.getState();
    // v18e: drop stale-session events before doing any state work
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    lastWsMessageType = 'mcp-tool-call';

    updateStreamingContent(state.currentSessionId, (content) => {
      // Skip if tool part already exists (e.g., created by regular tool-call)
      if (findToolPart(content, payload.toolCallId)) return content;
      const rawName = payload.toolName ?? 'tool';
      const toolPart: ToolInvocationContent = {
        type: 'tool-invocation',
        toolCallId: String(payload.toolCallId ?? ''),
        toolName: typeof rawName === 'string' ? rawName : String((rawName as any)?.name ?? JSON.stringify(rawName)),
        args: payload.args,
        state: 'input-available',
      };
      return [...content, toolPart];
    });
  });

  // ── mcp-tool-result: MCP tool result with structuredContent ──
  const unsubMcpToolResult = wsService.on('mcp-tool-result', (event) => {
    const payload = (event as any).payload as { toolCallId: string; toolName: string; result: unknown; structuredContent?: McpStructuredContent } | undefined;
    if (!payload?.toolCallId) return;
    const state = useChatStore.getState();
    // v18e: drop stale-session events before doing any state work
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    lastWsMessageType = 'mcp-tool-result';

    // Extract structuredContent from payload.result if not at top level
    // (WS messages nest structuredContent inside result.structuredContent)
    const resultObj = payload.result as Record<string, unknown> | undefined;
    const extractedStructured = (payload.structuredContent ?? resultObj?.structuredContent) as McpStructuredContent | undefined;

    updateStreamingContent(state.currentSessionId, (content) => {
      const tp = findToolPart(content, payload.toolCallId);
      if (tp) {
        return content.map(c =>
          c === tp ? {
            ...tp,
            result: payload.result,
            state: 'output-available' as const,
            ...(extractedStructured ? { structuredContent: extractedStructured } : {}),
          } : c
        );
      }

      // Interactive tool result (different toolCallId from original agent call):
      // Find the existing MCP tool part with matching resourceUri and update IT,
      // so the iframe shows the latest result after page refresh.
      const resourceUri = extractedStructured?.resourceUri;
      if (resourceUri) {
        const mcpPart = content.find(
          (c): c is ToolInvocationContent =>
            c.type === 'tool-invocation' &&
            (c as ToolInvocationContent).structuredContent?.resourceUri === resourceUri
        );
        if (mcpPart) {
          return content.map(c =>
            c === mcpPart ? {
              ...mcpPart,
              result: payload.result,
              state: 'output-available' as const,
              ...(extractedStructured ? { structuredContent: extractedStructured } : {}),
            } : c
          );
        }
      }

      // No matching part found — create one with the result
      const rawName = payload.toolName ?? 'tool';
      const newTp: ToolInvocationContent = {
        type: 'tool-invocation',
        toolCallId: String(payload.toolCallId ?? ''),
        toolName: typeof rawName === 'string' ? rawName : String((rawName as any)?.name ?? JSON.stringify(rawName)),
        result: payload.result,
        state: 'output-available',
        ...(extractedStructured ? { structuredContent: extractedStructured } : {}),
      };
      return [...content, newTp];
    });
  });

  // ── mcp-tool-error: MCP tool execution error ──
  const unsubMcpToolError = wsService.on('mcp-tool-error', (event) => {
    const payload = (event as any).payload as { toolCallId: string; toolName: string; error: string } | undefined;
    if (!payload?.toolCallId) return;
    const state = useChatStore.getState();
    // v18e: drop stale-session events before doing any state work
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    lastWsMessageType = 'mcp-tool-error';

    updateStreamingContent(state.currentSessionId, (content) => {
      const tp = findToolPart(content, payload.toolCallId);
      if (tp) {
        return content.map(c =>
          c === tp ? { ...tp, state: 'output-error' as const, errorText: payload.error } : c
        );
      }
      return content;
    });
  });

  // ── data-workspace-metadata: workspace data from backend ──
  const unsubDataWorkspace = wsService.on('data-workspace-metadata', (event) => {
    // Hide display
    // const payload = (event as any).payload as Record<string, unknown> | undefined;
    // if (!payload) return;
    // const state = useChatStore.getState();
    // if (!state.currentSessionId || !streamingMessageId) return;
    // lastWsMessageType = 'data-workspace-metadata';

    // updateStreamingContent(state.currentSessionId, (content) => {
    //   const dataPart: DataContent = {
    //     type: 'data',
    //     dataType: 'workspace-metadata',
    //     data: payload,
    //   };
    //   return [...content, dataPart];
    // });
  });

  // ── step-start: step boundary ──
  const unsubStepStart = wsService.on('step-start', () => {
    lastWsMessageType = 'step-start';
  });

  // ── step-finish: step completed ──
  // v18e: take `event` param so we can run session-isolation guard.
  const unsubStepFinish = wsService.on('step-finish', (event) => {
    const state = useChatStore.getState();
    if (!resolveEventSessionId(event, state)) return;
    if (!state.currentSessionId || !streamingMessageId) return;
    lastWsMessageType = 'step-finish';
    // Mark streaming text parts as completed
    updateStreamingContent(state.currentSessionId, (content) => {
      return content.map((c) => {
        if (c.type === 'text' && (c as TextContent).state === 'streaming') {
          return { ...c, state: 'completed' as const };
        }
        return c;
      });
    });
  });

  // ── message: ignored — all cleanup is handled by 'finish' ──
  const unsubMessage = wsService.on('message', () => {
    // Intentionally empty: backend cleanup is handled by 'finish'.
  });

  // ── finish: entire stream completed ──
  // v18e: take `event` param + session-isolation guard. CRITICAL — without
  // this, a late-arriving `finish` for a stream the user has already navigated
  // away from would (a) commitStreamingToMessages into the new session's
  // messages tree, and (b) clear the new session's streamingMessageId. Both
  // corrupt the active stream.
  const unsubFinish = wsService.on('finish', (event) => {
    const state = useChatStore.getState();
    if (!resolveEventSessionId(event, state)) return;
    // 后端在 finish 事件携带 metadata.source(如 'cron'|'webhook'),用于合并判定
    const eventMeta = (event as { metadata?: Record<string, unknown> }).metadata;
    if (eventMeta && Object.keys(eventMeta).length > 0) {
      useStreamingStore.getState().setMetadata(eventMeta);
    }
    // v19 race-fix (Start-gate): after cancel-ack flushes the queued send,
    // streamingMessageId = m_NEW but the NEW stream's `start` hasn't arrived
    // yet. A stale `finish` from the OLD (cancelled) stream landing in this
    // window would commit the empty NEW placeholder (→ auto-removed), clear
    // streamingMessageId → TypingDots vanish until a later `start` rebuilds
    // a 3rd placeholder. Drop it; the gate was armed in cancel-ack / 15s-
    // timeout and is cleared by NEW `start` (line ~936) or text-delta fallback.
    if (expectingNewStreamStart && streamingMessageId) return;
    const { currentSessionId } = state;

    // Mark all streaming reasoning/text parts as completed
    if (currentSessionId && streamingMessageId) {
      updateStreamingContent(currentSessionId, (content) => {
        return content.map((c) => {
          if (c.type === 'reasoning' && (c as ReasoningContent).state === 'streaming') {
            return { ...c, state: 'completed' as const };
          }
          if (c.type === 'text' && (c as TextContent).state === 'streaming') {
            return { ...c, state: 'completed' as const };
          }
          return c;
        });
      });

      // v3: commit accumulated content from streamingStore → messages tree
      // (one atomic update for the entire stream, NOT per-token)
      commitStreamingToMessages(currentSessionId);
    }

    // ── Auto-play TTS: flush trailing partial sentence (no terminal punctuation) ──
    if (autoPlayTextBuffer.trim() && streamingMessageId) {
      useTtsStore.getState().enqueueText(autoPlayTextBuffer.trim(), streamingMessageId);
    }
    autoPlayTextBuffer = '';

    // ── Signal TTS pipeline that no more sentences will arrive ──
    // finishStream sets pipelineNoMore=true, which gates ALL pipeline
    // completion checks (checkPipelineCompletion, checkNaturalCompletion,
    // time-based completion). Without this, the pipeline WS stays open
    // waiting for more audio, and only closes via 30s drain timeout.
    if (streamingMessageId) {
      useTtsStore.getState().finishStream(streamingMessageId);
    }

    useChatStore.setState({ isStreaming: false, streamingMessageId: null, streamingText: '' });
    // Clean up sequence tracking for the completed session
    if (streamingSessionId) sessionSequenceIds.delete(streamingSessionId);
    streamingMessageId = null;
    streamingSessionId = null;
    lastWsMessageType = null;
    pendingSearchKeywords = null;
    pendingSearchSources = null;
    pendingVideoResults = null;
    pendingSearchSessionId = null;
    // Stream finished cleanly — drop the watchdog so it can't fire on
    // the NEXT stream (which sendMessage will arm fresh).
    disarmStreamWatchdog();
  });

  // ── cancel-ack: cancel acknowledgment from backend ──
  // v18e: take `event` param + session-isolation guard. CRITICAL — without
  // this, a late-arriving `cancel-ack` for a stream the user already cancelled
  // (or switched away from) would clear the NEW session's streamingMessageId,
  // breaking the active stream's UI state.
  //
  // v19 (cancel-queue): the cancel-ack is now the trigger that flushes the
  // queued pendingSendAfterCancel — this is the gate that keeps
  // cancel-then-send strictly serial. The 15s timeout in cancelStream is the
  // safety net for when cancel-ack never arrives.
  const unsubCancelAck = wsService.on('cancel-ack', (event) => {
    const state = useChatStore.getState();
    if (!resolveEventSessionId(event, state)) return;

    // Stale-ack guard: if we're not expecting a cancel-ack, the 15s timeout
    // already fired (or we already processed one). Re-running finalize would
    // hit its unconditional `streamingMessageId=null; isStreaming=false`
    // block and clobber the NEW stream that the timeout's flush already
    // dispatched — the exact m_OLD-truncation bug class, now hitting m_NEW
    // (TypingDots vanish + text-delta for m_NEW dropped). Drop and bail.
    if (!expectingCancelAck) {
      logger.warn('Chat', 'stale cancel-ack dropped (timeout already fired or already processed)');
      return;
    }

    // Server confirmed the OLD stream is dead. Drop the timeout (no need
    // for the safety net anymore) and clear the wait flag.
    clearCancelAckTimer();
    expectingCancelAck = false;
    useChatStore.setState({ isWaitingForCancelAck: false });

    // v19B (delayed-commit): all housekeeping (commit m_OLD in-flight parts
    // → commit content → clear streaming state → arm start-gate → flush
    // queued send) is now unified in finalizeOldStreamAndFlush(). This
    // replaces the old `supersededByNewStream` dual-branch + inline flush
    // — because cancelStream no longer eagerly commits/clears, the ack
    // handler is the single point where m_OLD gets finalized for BOTH the
    // cancel-then-send path and pure-cancel (no queued send) path. When
    // pendingSendAfterCancel is null the flush inside is a no-op.
    finalizeOldStreamAndFlush();
  });

  // ── error: server error ──
  // v18e: CRITICAL — this is the actual root cause of the "session 已经改变"
  // toast at WS end. When a stream fails AFTER the user switched sessions,
  // the late-arriving `error` event would (a) set state.error to a confusing
  // stale message and (b) clear streamingMessageId for the new (possibly
  // active) stream. The session-isolation guard now drops any error whose
  // event.sessionId doesn't match the session the user is currently looking
  // at.
  const unsubError = wsService.on('error', (event) => {
    const errMsg = (event as any).error || 'Unknown WebSocket error';
    const state = useChatStore.getState();

    if (!resolveEventSessionId(event, state)) return;
    if (expectingCancelAck && streamingMessageId) return;
    // Server-side stream errors (e.g. "Fetch request has been canceled" from
    // upstream LLM gateway, network resets, timeouts) are surfaced purely via
    // logger — not state.error (which would trigger an Alert) and not Toast.
    // Rationale: these are server/network-layer issues the user cannot act on;
    // surfacing them as modal Alerts only interrupts the chat experience.
    // Stream state cleanup still runs so the UI exits the streaming state.
    logger.error('chat-ws', 'Server stream error', {
      error: errMsg,
      sessionId: resolveEventSessionId(event, state) ?? null,
      streamingMessageId,
      event,
    });
    // Mark streaming text parts as completed
    if (state.currentSessionId && streamingMessageId) {
      updateStreamingContent(state.currentSessionId, (content) => {
        return content.map((c) => {
          if (c.type === 'text' && (c as TextContent).state === 'streaming') {
            return { ...c, state: 'completed' as const };
          }
          return c;
        });
      });

      // v3: commit accumulated content before clearing
      commitStreamingToMessages(state.currentSessionId);
    }
    useChatStore.setState({
      isStreaming: false,
      streamingMessageId: null,
      streamingText: '',
    });
    // Clean up sequence tracking for the failed session
    if (streamingSessionId) sessionSequenceIds.delete(streamingSessionId);
    streamingMessageId = null;
    streamingSessionId = null;
    lastWsMessageType = null;
    // Server reported a stream error — the stream is dead. Drop the
    // watchdog so it can't fire on top of this cleanup and trigger a
    // redundant reconnect.
    disarmStreamWatchdog();
  });

  // ── session-title-updated ──
  const unsubTitleUpdate = wsService.on('session-title-updated', (event) => {
    const { sessionId, title } = event as any;
    if (sessionId && title) {
      useChatStore.setState((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId ? { ...sess, title } : sess,
        ),
      }));
      // SQLite: sync the title update
      syncSessionToDb(sessionId);
    }
  });

  // ── attach-ack: server confirmed attach request, replay starting ──
  const unsubAttachAck = wsService.on('attach-ack', (event) => {
    const payload = event as any;
    logger.info('chat-ws', 'Attach acknowledged — replay starting', {
      sessionId: payload?.sessionId,
      replayedCount: payload?.replayedCount,
      latestSequenceId: payload?.latestSequenceId,
      isStreaming: payload?.isStreaming,
    });
  });

  // ── attach-finished: stream already completed server-side, no replay ──
  const unsubAttachFinished = wsService.on('attach-finished', (event) => {
    const payload = event as any;
    const sessionId: string | undefined = payload?.sessionId;
    logger.info('chat-ws', 'Attach finished — stream already complete', { sessionId });
    if (sessionId) sessionSequenceIds.delete(sessionId);
    // Finalize the streaming placeholder if it belongs to this session
    if (streamingMessageId && streamingSessionId === sessionId) {
      const state = useChatStore.getState();
      if (state.currentSessionId) {
        commitStreamingToMessages(state.currentSessionId);
      }
      useChatStore.setState({ isStreaming: false, streamingMessageId: null, streamingText: '' });
      streamingMessageId = null;
      streamingSessionId = null;
      // Stream resumed then completed via attach-finished — drop the
      // watchdog so it can't fire after this terminal cleanup.
      disarmStreamWatchdog();
    }
  });

  // ── attach-stale: buffer too old, cannot resume ──
  const unsubAttachStale = wsService.on('attach-stale', (event) => {
    const payload = event as any;
    const sessionId: string | undefined = payload?.sessionId;
    logger.warn('chat-ws', 'Attach stale — buffer too old to resume', {
      sessionId,
      oldestSequenceId: payload?.oldestSequenceId,
    });
    if (sessionId) sessionSequenceIds.delete(sessionId);
    // Finalize whatever we have — cannot resume
    if (streamingMessageId) {
      const state = useChatStore.getState();
      if (state.currentSessionId) {
        commitStreamingToMessages(state.currentSessionId);
      }
      useChatStore.setState({ isStreaming: false, streamingMessageId: null, streamingText: '' });
      streamingMessageId = null;
      streamingSessionId = null;
      // Buffer too old to resume — stream is dead. Drop the watchdog.
      disarmStreamWatchdog();
    }
  });

  // ── attach-error: attach request failed ──
  const unsubAttachError = wsService.on('attach-error', (event) => {
    const payload = event as any;
    const sessionId: string | undefined = payload?.sessionId;
    logger.error('chat-ws', 'Attach error — cannot resume stream', {
      sessionId,
      error: payload?.error,
    });
    if (sessionId) sessionSequenceIds.delete(sessionId);
    // Finalize the streaming state
    if (streamingMessageId) {
      const state = useChatStore.getState();
      if (state.currentSessionId) {
        commitStreamingToMessages(state.currentSessionId);
      }
      useChatStore.setState({ isStreaming: false, streamingMessageId: null, streamingText: '' });
      streamingMessageId = null;
      streamingSessionId = null;
      // Attach request failed — stream cannot resume, drop the watchdog.
      disarmStreamWatchdog();
    }
  });

  const unsubConnected = wsService.on('__connected__', () => {
    useChatStore.setState({ wsConnected: true });
    // Unconditional log so watchdog-triggered reconnects are visible in
    // device logs — without this, the watchdog fires → reconnect() →
    // __connected__ silently setState, and the only evidence is the
    // absence of sendChat-reconnect warns on the next send (hard to spot).
    logger.info('chat-ws', 'WS connected', {
      hadActiveStream: !!streamingSessionId,
    });
    // ── Resume: if we have an active stream with tracked sequenceId,
    // send attach so the server replays missed chunks. ──
    if (streamingSessionId && sessionSequenceIds.has(streamingSessionId)) {
      const lastSeq = sessionSequenceIds.get(streamingSessionId)!;
      logger.info('chat-ws', 'WS reconnected — sending attach for resume', {
        sessionId: streamingSessionId,
        lastSequenceId: lastSeq,
      });
      wsService.sendAttach(streamingSessionId, lastSeq);
      return;
    }
    // ── No in-flight stream to resume (e.g. app came back from background
    // while an AI video finished). Reload the current session so messages
    // that completed while the socket was down (the "video is ready" message)
    // appear. Background refresh merges, it does not reset the list. ──
    const { currentSessionId } = useChatStore.getState();
    if (currentSessionId) {
      logger.info('chat-ws', 'WS reconnected — background refresh current session', {
        sessionId: currentSessionId,
      });
      useChatStore.getState().loadMessages(currentSessionId, { backgroundRefresh: true });
    }
  });

  // ── data-search-keywords: SearXNG decomposed keywords (may arrive before `start`) ──
  const unsubSearchKeywords = wsService.on('data-search-keywords', (event) => {
    const payload = (event as any).payload as { keywords?: string[]; userKeyword?: string } | undefined;
    if (!payload?.keywords || !Array.isArray(payload.keywords)) return;
    const keywords = payload.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0);
    if (keywords.length === 0) return;

    const state = useChatStore.getState();
    // v18e: use the unified session-isolation helper. This drops search-meta
    // events for any session other than the one the user is looking at, even
    // when no stream is in-flight (so a stale search-meta from a previous
    // session can't bleed into a fresh new session).
    const sessionId = resolveEventSessionId(event, state);
    if (!sessionId) return;

    if (streamingMessageId) {
      updateStreamingMeta(sessionId, { searchKeywords: keywords });
    } else {
      // `start` not yet arrived → buffer
      pendingSearchKeywords = keywords;
      pendingSearchSessionId = sessionId;
    }
  });

  // ── data-search-results: SearXNG search sources (may arrive before `start`) ──
  const unsubSearchResults = wsService.on('data-search-results', (event) => {
    const payload = (event as any).payload as { results?: Array<{ index: number; title: string; url: string; content?: string }> } | undefined;
    if (!payload?.results || !Array.isArray(payload.results)) return;
    const sources: SourceLink[] = payload.results
      .map((r) => ({ id: String(r.index), title: r.title, url: r.url }))
      .filter((s) => s.title && s.url);
    if (sources.length === 0) return;

    const state = useChatStore.getState();
    // v18e: same as data-search-keywords above — use helper for uniform
    // session-isolation behaviour.
    const sessionId = resolveEventSessionId(event, state);
    if (!sessionId) return;

    if (streamingMessageId) {
      updateStreamingMeta(sessionId, { sources });
    } else {
      pendingSearchSources = sources;
      pendingSearchSessionId = sessionId;
    }
  });

  // ── data-video-results: video search results from pipeline (may arrive before `start`) ──
  const unsubVideoResults = wsService.on('data-video-results', (event) => {
    const payload = (event as any).payload as { results?: Array<{ index?: number; title: string; url: string; thumbnail?: string; duration?: string; author?: string; description?: string; embedUrl?: string; publishedDate?: string }> } | undefined;
    if (!payload?.results || !Array.isArray(payload.results)) return;
    const videos: VideoResult[] = payload.results
      .map((r) => ({
        title: String(r.title ?? ''),
        url: String(r.url ?? ''),
        thumbnail: r.thumbnail ? String(r.thumbnail) : undefined,
        duration: r.duration ? String(r.duration) : undefined,
        author: r.author ? String(r.author) : undefined,
        description: r.description ? String(r.description) : undefined,
        embedUrl: r.embedUrl ? String(r.embedUrl) : undefined,
      }))
      .filter((v) => v.title && v.url);
    if (videos.length === 0) return;

    const state = useChatStore.getState();
    const sessionId = resolveEventSessionId(event, state);
    if (!sessionId) return;

    if (streamingMessageId) {
      updateStreamingMeta(sessionId, { videoResults: videos });
    } else {
      pendingVideoResults = videos;
      pendingSearchSessionId = sessionId;
    }
  });

  const unsubDisconnected = wsService.on('__disconnected__', () => {
    useChatStore.setState({ wsConnected: false });
    // Mirror the __connected__ log so the disconnect→reconnect cycle is
    // fully traceable in device logs (watchdog fire → disconnect →
    // connect → connected).
    logger.info('chat-ws', 'WS disconnected');
  });

  // ── Stream watchdog re-arm ───────────────────────────────────────
  // Any non-terminal WS event on an active stream proves the connection
  // (and the server-side stream) is still alive. Reset the 90s death
  // timer so it only fires on TRUE death (no activity whatsoever).
  //
  // emit() dispatches type-specific handlers first, then the wildcard,
  // so by the time we reach here the type-specific handler has either:
  //   • cleared streamingMessageId (finish / cancel-ack → disarm) — in
  //     which case the `!streamingMessageId` guard below short-circuits
  //     and we do NOT re-arm (correct: the stream is over).
  //   • kept streamingMessageId (text-delta / reasoning-* / tool-* /
  //     step-* → stream ongoing) — in which case we DO re-arm, pushing
  //     the 90s deadline forward by another 90s.
  //
  // Terminal / synthetic events are explicitly excluded: they don't
  // reflect stream activity (or indicate the stream is already dead).
  const unsubWatchdog = wsService.on('*', (event) => {
    if (!streamingMessageId) return;
    switch (event.type) {
      case 'finish':
      case 'cancel-ack':
      case 'error':
      case 'attach-error':
      case 'attach-stale':
      case '__connected__':
      case '__disconnected__':
      case '__reconnect_failed__':
        return;
      default:
        armStreamWatchdog();
    }
  });

  return () => {
    unsubStart();
    unsubDelta();
    unsubReasoningStart();
    unsubReasoningDelta();
    unsubReasoningEnd();
    unsubToolCall();
    unsubToolProgress();
    unsubToolResult();
    unsubToolError();
    unsubCreationJobUpdate();
    unsubCreationFailed();
    unsubCreationComplete();
    unsubToolApproval();
    unsubMcpToolCall();
    unsubMcpToolResult();
    unsubMcpToolError();
    unsubDataWorkspace();
    unsubStepStart();
    unsubStepFinish();
    unsubMessage();
    unsubFinish();
    unsubCancelAck();
    unsubError();
    unsubTitleUpdate();
    unsubConnected();
    unsubDisconnected();
    unsubAttachAck();
    unsubAttachFinished();
    unsubAttachStale();
    unsubAttachError();
    unsubSearchKeywords();
    unsubSearchResults();
    unsubVideoResults();
    unsubWatchdog();
    wsInitialized = false;
    // Drop any armed cancel-ack timer so it can't fire after teardown and
    // call finalizeOldStreamAndFlush() / flushPendingSendAfterCancel() on
    // a half-destroyed store (would attempt sendMessage on a torn-down WS).
    clearCancelAckTimer();
    // Drop the stream watchdog too — same rationale: a 90s timer firing
    // after teardown would call triggerStreamWatchdogTimeout() on a
    // half-destroyed store (would attempt wsService.reconnect() and
    // toast on a torn-down WS).
    disarmStreamWatchdog();
    streamingMessageId = null;
    streamingSessionId = null;
    expectingCancelAck = false;
    expectingNewStreamStart = false;
    lastWsMessageType = null;
    pendingSearchKeywords = null;
    pendingSearchSources = null;
    pendingVideoResults = null;
    pendingSearchSessionId = null;
    sessionSequenceIds.clear();
    // v3: reset streaming store on teardown
    useStreamingStore.getState().reset();
  };
}
