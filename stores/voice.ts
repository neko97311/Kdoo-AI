/**
 * Voice call state store — Zustand store for AI voice conversation.
 *
 * Tracks: connection state, mic status, agent presence/state, mic
 * amplitude (for waveform), errors. Wraps livekit-service.ts for
 * imperative operations.
 */

import { create } from 'zustand';
import { ConnectionState } from 'livekit-client';
import type { VoiceConnectionState, AgentState } from '@/services/livekit-service';
import {
  connectToRoom,
  disconnectRoom,
  fetchLiveKitToken,
  prepareConnection as prepareConnectionSvc,
  toggleMicrophone,
  toggleScreenShare as toggleScreenShareSvc,
  toggleCamera as toggleCameraSvc,
  onConnectionStateChange,
  onMicEnabledChange,
  onScreenShareEnabledChange,
  onCameraEnabledChange,
  onAgentPresenceChange,
  onAgentStateChange,
  onAmplitudeChange,
  onErrorChange,
  onUserSpeakingChange,
  onTranscript,
  startMetering,
  stopMetering,
} from '@/services/livekit-service';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';
import { useTtsStore } from '@/stores/tts';
import { voiceTranscriptService } from '@/services/voice-transcript-service';
import { isDbReady } from '@/lib/db';
import { upsertMessages, markSynced, getUnsyncedMessages } from '@/lib/db/repositories/message-repo';
import {
  transcriptToChatMessage,
  makeTranscriptLocalId,
} from '@/lib/voice-transcript-encode';
import type { ChatMessage } from '@/types';
import type {
  TranscriptItem,
  FailedTranscriptJob,
  VoiceViewMode,
} from '@/types/voice-transcript';
import { logger } from '@/utils/logger';
import { releaseMusicDuck } from '@/utils/audio-coordination';

interface VoiceState {
  connectionState: VoiceConnectionState;
  isMicEnabled: boolean;
  isScreenShareEnabled: boolean;
  isCameraEnabled: boolean;
  agentIdentity: string | undefined;
  agentState: AgentState;
  isUserSpeaking: boolean;
  amplitude: number;
  error: string | null;

  /** Modal visibility — voice call renders via a top-level RN Modal so it
   *  can paint its own background over the safe-area / status bar region. */
  isModalOpen: boolean;

  /** True once the room has reached `connected` state during the current
   *  modal-open session. Reset to `false` by `openVoiceCall`. Used by the
   *  modal to decide whether a `disconnected` status should show "Call
   *  ended" or fall back to "Connecting..." (avoids the entrance flash
   *  where the modal briefly renders the stale Disconnected state from a
   *  previous call as "Call ended"). */
  hasConnectedOnce: boolean;

  /** Session ID captured at openVoiceCall time; null when no call is active.
   *  Distinct from chatStore.currentSessionId — frozen at call start so
   *  mid-call session switches don't misroute transcripts. */
  captureSessionId: string | null;
  transcripts: TranscriptItem[];
  failedQueue: FailedTranscriptJob[];
  viewMode: VoiceViewMode;

  connect: () => Promise<void>;
  prepareCall: () => Promise<void>;
  disconnect: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleScreenShare: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  openVoiceCall: (opts?: { sessionId?: string }) => void;
  closeVoiceCall: () => Promise<void>;
  appendTranscript: (item: TranscriptItem) => void;
  updateTranscript: (segmentId: string, patch: Partial<TranscriptItem>) => void;
  commitTranscript: (item: TranscriptItem) => Promise<void>;
  enqueueFailedTranscript: (job: FailedTranscriptJob) => void;
  setViewMode: (mode: VoiceViewMode) => void;
  resetTranscriptState: () => void;
  _setConnectionState: (state: VoiceConnectionState) => void;
  _setHasConnectedOnce: (v: boolean) => void;
  _setMicEnabled: (enabled: boolean) => void;
  _setScreenShareEnabled: (enabled: boolean) => void;
  _setCameraEnabled: (enabled: boolean) => void;
  _setAgentIdentity: (identity: string | undefined) => void;
  _setAgentState: (state: AgentState) => void;
  _setUserSpeaking: (speaking: boolean) => void;
  _setAmplitude: (amplitude: number) => void;
  _setError: (error: string | null) => void;
}

// Wire up service event listeners once
let listenersInitialized = false;

/** Module-scoped reentrancy lock for closeVoiceCall. Non-null while a close
 *  sequence is in flight (disconnect + flush + loadMessages). openVoiceCall
 *  and connect check this to bail out when a close is still running. Keeps
 *  rapid double-tap of the hangup button (or dialing while a call is
 *  closing) from racing the cleanup logic. Not a store field to avoid
 *  accidental persistence / re-render churn. */
let closingPromise: Promise<void> | null = null;

// ── Transcript batching / persistence ──────────────────────────────

/**
 * Merge an incoming interim ASR hypothesis into the currently displayed
 * text for the same segment.
 *
 * LiveKit's `lk.transcription` stream sends "current best hypothesis" on
 * every interim update — these are NOT monotonic appends. The ASR decoder
 * can rewind, re-segment, or rebuild the partial text within the same
 * segmentId (observed in production: "...你在干什么？你叫啥名字？喂。"
 * followed by "喂喂" on the same segment, then back to the long version).
 * Naive overwrite causes the UI to flash short text mid-utterance.
 *
 * Strategy (prefix-aware merge):
 *   1. incoming starts with current → normal streaming append, accept
 *   2. current starts with incoming → server rewind/truncation, keep current
 *   3. incoming longer (no prefix relation) → server rebuilt with more, accept
 *   4. incoming shorter (no prefix relation) → transient noise, keep current
 *
 * Empty incoming is treated as noise (keep current) — the server sends
 * empty streams for various control reasons; never shrink display to "".
 *
 * Note: FINAL messages bypass this function entirely (see onTranscript)
 * — the finalised text always overwrites unconditionally because ASR
 * post-processing may legitimately shorten the result (dedup, etc.).
 */
function mergeInterim(current: string, incoming: string): string {
  if (incoming.length === 0) return current;
  if (current.length === 0) return incoming;
  // 1. Normal streaming append
  if (incoming.startsWith(current)) return incoming;
  // 2. Server rewind — current is a prefix of incoming's shorter form
  if (current.startsWith(incoming)) return current;
  // 3. Rebuild with more content
  if (incoming.length > current.length) return incoming;
  // 4. Shorter, no prefix relation — transient ASR noise, keep current
  return current;
}

/** Throttle interval for batch-flushing in-flight transcripts to SQLite
 *  during an active call. Caps data loss window when the OS kills the app
 *  mid-conversation. */
const TRANSCRIPT_THROTTLE_MS = 2000;

/** Grace period after disconnect — gives the LiveKit data channel time
 *  to deliver any trailing `isFinal=true` transcripts the server was
 *  sending as the call ended. After this elapses we forcibly mark all
 *  uncommitted items as final and flush. */
const TRANSCRIPT_GRACE_MS = 1200;
const DISCONNECT_TIMEOUT_MS = 5000;
const POST_TIMEOUT_MS = 8000;
const SAVE_BATCH_MAX_RETRIES = 3;
const SAVE_BATCH_BACKOFF_MS = [500, 1000, 2000];
const LOAD_MESSAGES_RETRY_DELAY_MS = 1000;

/** SQLite write retry for flushTranscriptsToSQLiteNow — independent from
 *  SAVE_BATCH_* (network POST) since failure modes differ. */
const SQLITE_WRITE_MAX_RETRIES = 3;
const SQLITE_WRITE_BACKOFF_MS = [500, 1000, 2000];
const CONNECT_TIMEOUT_MS = 15000;

/** Race a promise against a timeout. Rejects if the inner promise rejects;
 *  resolves undefined on timeout (so callers can treat timeout as "no result"). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      logger.warn('voice', '${label} timed out after ${ms}ms');
      resolve(undefined);
    }, ms);
    p.then((v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      logger.warn('voice', '${label} rejected:', e?.message || e);
      reject(e);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let throttleTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a batch flush of the current transcript buffer to SQLite
 *  (synced=0). Leading-edge guarded: subsequent calls within the throttle
 *  window coalesce into the in-flight timer. The flush runs against a
 *  snapshot of `transcripts` at fire time, so items appended while the
 *  write is in flight are picked up by the next scheduled flush. */
function scheduleTranscriptFlush(getState: () => VoiceState): void {
  if (throttleTimer) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    flushTranscriptsToSQLiteNow(getState).catch((e) =>
      logger.warn('voice-store', 'scheduled flush error:', e),
    );
  }, TRANSCRIPT_THROTTLE_MS);
}

/** Execute one batch upsert of all current transcripts into the SQLite
 *  cache (synced=0). No-op when there's no active session, no transcripts,
 *  DB not initialised, or no logged-in user. Best-effort — errors are
 *  logged, not thrown, since the next throttle tick will retry. */
async function flushTranscriptsToSQLiteNow(
  getState: () => VoiceState,
): Promise<void> {
  const { transcripts, captureSessionId } = getState();
  if (!captureSessionId || transcripts.length === 0) {
    logger.debug('voice', 'flush skip: sessionId=${captureSessionId ?? \'null\'} transcripts=${transcripts.length}');
    return;
  }
  if (!isDbReady()) {
    logger.debug('voice', 'flush skip: DB not ready');
    return;
  }
  const uid = getCurrentUserId();
  if (!uid) {
    logger.debug('voice', 'flush skip: no user id');
    return;
  }

  const rows: ChatMessage[] = transcripts.map((t) =>
    transcriptToChatMessage(t, captureSessionId, makeTranscriptLocalId(t.segmentId)),
  );

  for (let attempt = 1; attempt <= SQLITE_WRITE_MAX_RETRIES; attempt++) {
    try {
      await upsertMessages(rows, uid, 0);
      logger.debug('voice', 'flush → SQLite: ${rows.length} rows (synced=0) on attempt ${attempt}');
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      return; // success — done
    } catch (e) {
      logger.warn('voice-store', 'flush attempt ${attempt}/${SQLITE_WRITE_MAX_RETRIES} failed:', e);
      if (attempt < SQLITE_WRITE_MAX_RETRIES) {
        await sleep(SQLITE_WRITE_BACKOFF_MS[attempt - 1] ?? 2000);
      }
    }
  }

  // All retries exhausted — schedule a new flush on the next throttle tick
  // so transcripts are not lost. Buffer (transcripts array) is intentionally
  // left untouched; the next scheduleTranscriptFlush will re-attempt.
  logger.warn('voice-store', 'flush failed after ${SQLITE_WRITE_MAX_RETRIES} attempts, will retry on next throttle tick');
  scheduleTranscriptFlush(getState);
}

function ensureListeners(store: VoiceState) {
  if (listenersInitialized) return;
  listenersInitialized = true;

  onConnectionStateChange((cs) => store._setConnectionState(cs));
  onMicEnabledChange((enabled) => store._setMicEnabled(enabled));
  onScreenShareEnabledChange((enabled) => store._setScreenShareEnabled(enabled));
  onCameraEnabledChange((enabled) => store._setCameraEnabled(enabled));
  onAgentPresenceChange((identity) => store._setAgentIdentity(identity));
  onAgentStateChange((agentState) => store._setAgentState(agentState));
  onAmplitudeChange((amp) => store._setAmplitude(amp));
  onErrorChange((err) => store._setError(err));
  onUserSpeakingChange((speaking) => store._setUserSpeaking(speaking));

  onTranscript((segmentId, role, text, isFinal) => {
    logger.debug('voice', 'transcript ${isFinal ? \'FINAL\' : \'interim\'} ${role}: "${text.slice(0, 40)}${text.length > 40 ? \'…\' : \'\'}" seg=${segmentId.slice(0, 12)}');
    const existing = useVoiceStore
      .getState()
      .transcripts.find((t) => t.segmentId === segmentId);

    if (!existing) {
      useVoiceStore.getState().appendTranscript({
        segmentId,
        role,
        text,
        isFinal,
        createdAt: Date.now(),
      });
    } else if (isFinal && !existing.isFinal) {
      useVoiceStore.getState().commitTranscript({
        segmentId,
        role,
        text,
        isFinal: true,
        createdAt: existing.createdAt,
      });
    } else if (!isFinal) {
      const next = mergeInterim(existing.text, text);
      if (next !== existing.text) {
        useVoiceStore.getState().updateTranscript(segmentId, { text: next });
      }
    }
  });
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  connectionState: ConnectionState.Disconnected,
  isMicEnabled: false,
  isScreenShareEnabled: false,
  isCameraEnabled: false,
  agentIdentity: undefined,
  agentState: 'connecting',
  isUserSpeaking: false,
  amplitude: 0,
  error: null,
  isModalOpen: false,
  hasConnectedOnce: false,
  captureSessionId: null,
  transcripts: [],
  failedQueue: [],
  viewMode: 'avatar',

  openVoiceCall: (opts) => {
    if (get().isModalOpen || closingPromise) return;

    // 语音通话接管音频通道：打开 Modal 前先停掉正在进行的 TTS 播报。
    // 通话页是 RN Modal（非路由），打开它不会改变 navigation focus，
    // ChatView 里基于 useIsFocused 的停止逻辑不会触发，必须在此显式停止。
    //
    // 顺序与 MusicCardList.stopTtsBeforeMusicStart 相同：先清 duck 标志，
    // 否则 stopTtsPlayback 的拆除路径会 resume 被让路的音乐，
    // 通话接通的瞬间音乐会响出来。若 AI 回复还在流式输出，同时抑制
    // 后续 enqueueText 自动播放（否则接下来的 chunk 会在通话中重新开播）；
    // 抑制由 finishStream（WS 结束）自动解除，与 ChatView 失焦策略一致。
    releaseMusicDuck();
    const tts = useTtsStore.getState();
    tts.stopTtsPlayback();
    if (useChatStore.getState().isStreaming) {
      tts.setPlaybackSuppressed(true);
    }

    const sessionId =
      opts?.sessionId ?? useChatStore.getState().currentSessionId ?? null;
    set({
      captureSessionId: sessionId,
      isModalOpen: true,
      transcripts: [],
      failedQueue: [],
      viewMode: 'avatar',
      hasConnectedOnce: false,
      isMicEnabled: false,
      isScreenShareEnabled: false,
      isCameraEnabled: false,
      agentIdentity: undefined,
      agentState: 'connecting',
      isUserSpeaking: false,
      amplitude: 0,
      error: null,
    });
  },

  closeVoiceCall: async () => {
    if (closingPromise) {
      logger.debug('voice', 'closeVoiceCall: already closing, returning same promise');
      return closingPromise;
    }

    const sessionId = get().captureSessionId;
    logger.debug('voice', 'closeVoiceCall START session=${sessionId ?? \'null\'}, transcripts=${get().transcripts.length}');

    // 1. IMMEDIATELY close the modal + zero UI state. The user sees the
    //    hangup the instant they tap it; everything below runs in the
    //    background and is invisible.
    set({
      isModalOpen: false,
      connectionState: ConnectionState.Disconnected,
      isMicEnabled: false,
      isScreenShareEnabled: false,
      isCameraEnabled: false,
      agentIdentity: undefined,
      agentState: 'connecting',
      isUserSpeaking: false,
      amplitude: 0,
      error: null,
    });
    stopMetering().catch((e) => logger.warn('voice-store', 'stopMetering error:', e));

    closingPromise = (async () => {
      try {
        // 2. Drop the LiveKit room. Wrap with timeout — if WS close hangs,
        //    we still need to proceed with flush + POST.
        await withTimeout(disconnectRoom(), DISCONNECT_TIMEOUT_MS, 'disconnectRoom');
        logger.debug('voice', 'close step 2: disconnected (or timed out)');

        // 3. Cancel any pending throttle timer — the forced flush at the
        //    end of the grace period takes over.
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = null;
          logger.debug('voice', 'close step 3: cancelled pending throttle');
        }

        // 4. Dynamic grace period: wait up to TRANSCRIPT_GRACE_MS, but exit
        //    early if a final transcript arrives (cheap signal that the
        //    server-side pipeline has nothing more to send). Cheap polling:
        //    check every 100ms whether transcripts grew or any interim
        //    flipped to final since we started waiting.
        logger.debug('voice', 'close step 4: grace period up to ${TRANSCRIPT_GRACE_MS}ms');
        const graceStartTranscripts = get().transcripts.length;
        const graceStartFinalCount = get().transcripts.filter((t) => t.isFinal).length;
        const graceDeadline = Date.now() + TRANSCRIPT_GRACE_MS;
        while (Date.now() < graceDeadline) {
          await sleep(100);
          const nowTranscripts = get().transcripts;
          if (nowTranscripts.length > graceStartTranscripts) break;
          const nowFinalCount = nowTranscripts.filter((t) => t.isFinal).length;
          if (nowFinalCount > graceStartFinalCount) break;
        }
        logger.debug('voice', 'close step 4: grace ended after ${Date.now() - (graceDeadline - TRANSCRIPT_GRACE_MS)}ms');

        if (!sessionId) {
          get().resetTranscriptState();
          return;
        }

        // 5. Force-mark any still-streaming segments as final (barge-in
        //    case: server never sends isFinal=true because the user cut
        //    off the assistant mid-utterance).
        const transcriptsSnapshot = get().transcripts;
        const finalizable = transcriptsSnapshot.filter(
          (t) => !t.isFinal && t.text.trim(),
        );
        if (finalizable.length > 0) {
          logger.debug('voice', 'close step 5: force-finalize ${finalizable.length} barge-in segments');
          finalizable.forEach((t) =>
            get().updateTranscript(t.segmentId, { isFinal: true }),
          );
        }

        // 6. Force-flush the entire buffer to SQLite (synced=0) so any
        //    rows that haven't been POSTed yet survive an OS kill.
        await flushTranscriptsToSQLiteNow(get);
        logger.debug('voice', 'close step 6: force-flushed ${get().transcripts.length} transcripts to SQLite');

        // 7. Batch-POST everything we have, then mark synced. Failure
        //    here leaves rows at synced=0 — the post-launch replay path
        //    picks them up.
        const finalTranscripts = get().transcripts.filter((t) => t.text.trim());
        if (finalTranscripts.length > 0) {
          const turns = finalTranscripts.map((t) => ({
            role: t.role,
            text: t.text,
            ts: t.createdAt,
            segmentId: t.segmentId,
          }));
          logger.debug('voice', 'close step 7: POST saveBatch turns=${turns.length} (max ${SAVE_BATCH_MAX_RETRIES} retries)');
          let saved = false;
          for (let attempt = 1; attempt <= SAVE_BATCH_MAX_RETRIES; attempt++) {
            try {
              await withTimeout(
                voiceTranscriptService.saveBatch(sessionId, turns),
                POST_TIMEOUT_MS,
                `saveBatch attempt ${attempt}`,
              );
              logger.debug('voice', 'close step 7: POST OK on attempt ${attempt}');
              saved = true;
              break;
            } catch (e) {
              logger.warn('voice', 'close step 7: attempt ${attempt} failed:', (e as any)?.message || e);
              if (attempt < SAVE_BATCH_MAX_RETRIES) {
                await sleep(SAVE_BATCH_BACKOFF_MS[attempt - 1] ?? 2000);
              }
            }
          }
          if (saved) {
            if (isDbReady()) {
              const uid = getCurrentUserId();
              if (uid) {
                const ids = finalTranscripts.map((t) => makeTranscriptLocalId(t.segmentId));
                await markSynced(ids, uid);
                logger.debug('voice', 'close step 7: markSynced ${ids.length} rows');
              }
            }
          } else {
            logger.warn('voice', 'close step 7: all retries failed, leaving synced=0 for next launch');
          }
        } else {
          logger.debug('voice', 'close step 7: no transcripts to POST');
        }

        // 8. Refresh chat history. Retry once on failure.
        try {
          await sleep(200);
          logger.debug('voice', 'close step 8: loadMessages');
          await useChatStore.getState().loadMessages(sessionId);
          logger.debug('voice', 'close step 8: loadMessages OK');
        } catch (e: any) {
          logger.warn('voice', 'close step 8: loadMessages failed, retrying in 1s...', e?.message || e);
          await sleep(LOAD_MESSAGES_RETRY_DELAY_MS);
          try {
            await useChatStore.getState().loadMessages(sessionId);
            logger.debug('voice', 'close step 8: loadMessages retry OK');
          } catch (e2: any) {
            logger.warn('voice', 'close step 8: loadMessages retry failed', e2?.message || e2);
          }
        }

        // 9. Clear local voice-call state.
        get().resetTranscriptState();
        logger.debug('voice', 'closeVoiceCall DONE session=${sessionId}');
      } finally {
        closingPromise = null;
      }
    })().catch((e) =>
      logger.warn('voice-store', 'closeVoiceCall background error:', e),
    );

    return closingPromise;
  },

  connect: async () => {
    if (closingPromise) return;
    set({ error: null });
    try {
      const { requestRecordingPermissionsAsync } = await import('expo-audio');
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        set({ error: 'Microphone permission denied' });
        return;
      }
      const tokenRes = await withTimeout(
        fetchLiveKitToken(),
        CONNECT_TIMEOUT_MS,
        'fetchLiveKitToken',
      );
      if (!tokenRes?.token) {
        throw new Error('LiveKit token unavailable');
      }
      await withTimeout(
        connectToRoom(tokenRes.wsUrl, tokenRes.token),
        CONNECT_TIMEOUT_MS,
        'connectToRoom',
      );
      set({ isMicEnabled: true });
      startMetering();
    } catch (err: any) {
      logger.warn('voice', 'connect failed:', err?.message || err);
      set({ error: err?.message || 'Failed to connect' });
      setTimeout(() => {
        logger.debug('voice', 'auto-closing modal after connect failure');
        get().closeVoiceCall();
      }, 1500);
    }
  },

  prepareCall: async () => {
    try {
      const { token, wsUrl } = await fetchLiveKitToken();
      await prepareConnectionSvc(wsUrl, token);
    } catch {
      // prepareCall is best-effort; real errors surface in connect().
    }
  },

  disconnect: async () => {
    try {
      await disconnectRoom();
      await stopMetering();
    } catch (err: any) {
      logger.warn('voice-store', 'disconnect error:', err);
    } finally {
      set({
        connectionState: ConnectionState.Disconnected,
        isMicEnabled: false,
        isScreenShareEnabled: false,
        isCameraEnabled: false,
        agentIdentity: undefined,
        agentState: 'connecting',
        amplitude: 0,
        error: null,
      });
    }
  },

  toggleMic: async () => {
    const prev = get().isMicEnabled;
    logger.debug('voice', 'toggleMic: optimistic ${prev} → ${!prev}');
    set({ isMicEnabled: !prev });
    try {
      const enabled = await toggleMicrophone();
      set({ isMicEnabled: enabled });
      logger.debug('voice', 'toggleMic: server confirmed = ${enabled}');
    } catch (err: any) {
      logger.warn('voice-store', 'toggleMic error:', err);
      set({ isMicEnabled: prev });
    }
  },

  toggleScreenShare: async () => {
    if (get().connectionState !== ConnectionState.Connected) return;
    const prev = get().isScreenShareEnabled;
    logger.debug('voice', 'toggleScreenShare: optimistic ${prev} → ${!prev}');
    set({ isScreenShareEnabled: !prev, error: null });
    try {
      const enabled = await toggleScreenShareSvc();
      set({ isScreenShareEnabled: enabled });
      logger.debug('voice', 'toggleScreenShare: confirmed = ${enabled}');
    } catch (err: any) {
      logger.warn('voice-store', 'toggleScreenShare error:', err);
      set({
        isScreenShareEnabled: prev,
        error: err?.message || 'Failed to toggle screen share',
      });
    }
  },

  toggleCamera: async () => {
    if (get().connectionState !== ConnectionState.Connected) return;
    const prev = get().isCameraEnabled;
    if (!prev) {
      try {
        const { Camera } = await import('expo-camera');
        const perm = await Camera.requestCameraPermissionsAsync();
        if (!perm.granted) {
          set({ error: 'Camera permission denied' });
          return;
        }
      } catch (err: any) {
        logger.warn('voice-store', 'camera permission error:', err);
        set({ error: err?.message || 'Camera permission denied' });
        return;
      }
    }
    logger.debug('voice', 'toggleCamera: optimistic ${prev} → ${!prev}');
    set({ isCameraEnabled: !prev, error: null });
    try {
      const enabled = await toggleCameraSvc();
      set({ isCameraEnabled: enabled });
      logger.debug('voice', 'toggleCamera: confirmed = ${enabled}');
    } catch (err: any) {
      logger.warn('voice-store', 'toggleCamera error:', err);
      set({
        isCameraEnabled: prev,
        error: err?.message || 'Failed to toggle camera',
      });
    }
  },

  _setConnectionState: (cs) =>
    set((state) => ({
      connectionState: cs,
      hasConnectedOnce: state.hasConnectedOnce || cs === ConnectionState.Connected,
    })),
  _setHasConnectedOnce: (v) => set({ hasConnectedOnce: v }),
  _setMicEnabled: (enabled) => set({ isMicEnabled: enabled }),
  _setScreenShareEnabled: (enabled) => set({ isScreenShareEnabled: enabled }),
  _setCameraEnabled: (enabled) => set({ isCameraEnabled: enabled }),
  _setAgentIdentity: (identity) => set({ agentIdentity: identity }),
  _setAgentState: (agentState) => set({ agentState }),
  _setUserSpeaking: (speaking) => set({ isUserSpeaking: speaking }),
  _setAmplitude: (amplitude) => set({ amplitude }),
  _setError: (error) => set({ error }),

  appendTranscript: (item) => {
    set((state) => ({ transcripts: [...state.transcripts, item] }));
    scheduleTranscriptFlush(get);
  },

  updateTranscript: (segmentId, patch) => {
    set((state) => ({
      transcripts: state.transcripts.map((t) =>
        t.segmentId === segmentId ? { ...t, ...patch } : t,
      ),
    }));
    scheduleTranscriptFlush(get);
  },

  commitTranscript: async (item) => {
    const sessionId = get().captureSessionId;
    if (!sessionId) return;
    logger.debug('voice', 'commitTranscript seg=${item.segmentId.slice(0, 12)} text="${item.text.slice(0, 40)}${item.text.length > 40 ? \'…\' : \'\'}"');

    get().updateTranscript(item.segmentId, { isFinal: true, text: item.text });

    // 1. Force-flush the entire transcript buffer (synced=0) so the
    //    finalised segment is persisted immediately, not on the next
    //    throttle tick. Avoids losing it if the OS kills us between the
    //    network POST and the next scheduled batch.
    await flushTranscriptsToSQLiteNow(get);

    // 2. POST to server + mark synced. Network failure leaves the row
    //    at synced=0 — the post-launch replay path picks it up later.
    try {
      await withTimeout(
        voiceTranscriptService.save(sessionId, {
          role: item.role,
          text: item.text,
          ts: item.createdAt,
          segmentId: item.segmentId,
        }),
        POST_TIMEOUT_MS,
        'commitTranscript POST',
      );
      logger.debug('voice', 'commitTranscript POST OK seg=${item.segmentId.slice(0, 12)}');
      if (isDbReady()) {
        const uid = getCurrentUserId();
        if (uid) {
          await markSynced([makeTranscriptLocalId(item.segmentId)], uid);
        }
      }
    } catch (e: any) {
      logger.warn('voice', 'commitTranscript POST first failed (${e?.message || e}), retrying in 500ms...');
      await sleep(500);
      try {
        await withTimeout(
          voiceTranscriptService.save(sessionId, {
            role: item.role,
            text: item.text,
            ts: item.createdAt,
            segmentId: item.segmentId,
          }),
          POST_TIMEOUT_MS,
          'commitTranscript retry POST',
        );
        logger.debug('voice', 'commitTranscript POST retry OK seg=${item.segmentId.slice(0, 12)}');
        if (isDbReady()) {
          const uid = getCurrentUserId();
          if (uid) {
            await markSynced([makeTranscriptLocalId(item.segmentId)], uid);
          }
        }
      } catch (e2) {
        logger.warn('voice', 'commitTranscript retry failed, will be caught by closeVoiceCall saveBatch:', (e2 as any)?.message || e2);
      }
    }
  },

  enqueueFailedTranscript: (job) => {
    set((state) => ({ failedQueue: [...state.failedQueue, job] }));
  },

  setViewMode: (mode) => set({ viewMode: mode }),

  resetTranscriptState: () => {
    set({ transcripts: [], failedQueue: [], captureSessionId: null, viewMode: 'avatar' });
  },
}));

// Initialize listeners on module load
ensureListeners(useVoiceStore.getState());

/** Full voice store reset (used by auth logout to prevent cross-user state leakage). */
export function resetVoiceState(): void {
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  useVoiceStore.setState({
    isModalOpen: false,
    captureSessionId: null,
    transcripts: [],
    failedQueue: [],
    connectionState: ConnectionState.Disconnected,
    isMicEnabled: false,
    isScreenShareEnabled: false,
    isCameraEnabled: false,
    agentIdentity: undefined,
    agentState: 'connecting',
    isUserSpeaking: false,
    amplitude: 0,
    error: null,
    hasConnectedOnce: false,
    viewMode: 'avatar',
  });
}

// ============================================================
// Replay unsynced voice transcripts on app startup
// ============================================================

/** Get the current logged-in user's ID (null if not logged in). */
function getCurrentUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

/**
 * Replay locally-cached voice transcripts that never made it to the server
 * on the previous run. Called from the app root layout after auth + DB init.
 *
 * Groups unsynced messages by sessionId and POSTs each batch via
 * voiceTranscriptService.saveBatch. On success, marks them synced.
 * On failure, leaves them unsynced — they'll retry on next launch.
 *
 * Fire-and-forget from the caller's perspective: errors are logged and
 * swallowed so they never block UI render or other restore steps.
 */
export async function replayUnsyncedTranscripts(): Promise<{
  retried: number;
  succeeded: number;
}> {
  if (!isDbReady()) return { retried: 0, succeeded: 0 };
  const uid = getCurrentUserId();
  if (!uid) return { retried: 0, succeeded: 0 };

  const { isModalOpen, captureSessionId } = useVoiceStore.getState();
  if (isModalOpen && captureSessionId) {
    logger.debug('voice-replay', 'skipping — voice call in progress on session ${captureSessionId.slice(0, 8)}');
  }

  let rows: ChatMessage[];
  try {
    rows = await getUnsyncedMessages(uid);
  } catch (e) {
    logger.warn('voice-replay', 'query unsynced failed:', e);
    return { retried: 0, succeeded: 0 };
  }
  if (rows.length === 0) return { retried: 0, succeeded: 0 };

  logger.debug('voice-replay', 'found ${rows.length} unsynced rows across ${new Set(rows.map(r => r.sessionId)).size} sessions');

  const grouped = new Map<string, ChatMessage[]>();
  for (const row of rows) {
    if (isModalOpen && row.sessionId === captureSessionId) continue;
    const list = grouped.get(row.sessionId) ?? [];
    list.push(row);
    grouped.set(row.sessionId, list);
  }

  let succeeded = 0;
  for (const [sessionId, msgs] of grouped) {
    const turns: Array<{
      role: 'user' | 'assistant';
      text: string;
      ts: number;
      segmentId: string;
    }> = [];
    const idMap = new Map<string, string>();
    for (const m of msgs) {
      const textContent = m.content.find((c) => c.type === 'text');
      const text =
        textContent && textContent.type === 'text' ? textContent.text : '';
      if (!text.trim()) continue;
      const segmentId = m.id.startsWith('vt_') ? m.id.slice(3) : m.id;
      turns.push({
        role: m.role as 'user' | 'assistant',
        text,
        ts: m.createdAt.getTime(),
        segmentId,
      });
      idMap.set(segmentId, m.id);
    }
    if (turns.length === 0) continue;

    try {
      await voiceTranscriptService.saveBatch(sessionId, turns);
      logger.debug('voice-replay', 'session ${sessionId.slice(0, 8)} POST OK turns=${turns.length}');
      const ids = turns
        .map((t) => idMap.get(t.segmentId))
        .filter((id): id is string => !!id);
      await markSynced(ids, uid);
      succeeded += ids.length;
    } catch (e) {
      logger.warn('voice-replay', `retry failed for session ${sessionId}`, e);
    }
  }
  logger.debug('voice-replay', 'DONE retried=${rows.length} succeeded=${succeeded}');
  return { retried: rows.length, succeeded };
}
