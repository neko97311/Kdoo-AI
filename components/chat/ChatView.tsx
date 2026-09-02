import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { View, ScrollView, Text, ActivityIndicator, Platform, Pressable } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { isWeb } from '@/utils/platform';
import { detectUserSwipedUp, shouldResumeFollow } from '@/utils/scrollFollow';
import { KeyboardAvoidingView } from '@/components/KeyboardAvoidingView';
import { useKeyboard } from '@/hooks/useKeyboard';
import { useChatStore } from '@/stores/chat';
import { useToastStore } from '@/stores/toast';
import { useAuthStore } from '@/stores/auth';
import { useStreamingStore } from '@/stores/streaming';
import { useI18n } from '@/hooks/useI18n';
import { useSessionShare } from '@/hooks/useSessionShare';
import { ChatHeader } from './ChatHeader';
import { ChatBubble, resolveAuthedImageUri } from './ChatBubble';
import { StreamingBubble } from './StreamingBubble';
import { ChatInputBar } from './ChatInputBar';
import { TypingIndicator } from './TypingIndicator';
import { MessageListSkeleton } from './MessageListSkeleton';
import type { WsContentBlock, McpToolCallPayload, TextContent, ChatMessage } from '@/types';
import { wsService } from '@/services/websocket';
import { useIsFocused, useRouter } from 'expo-router';
import { useTtsStore } from '@/stores/tts';
import { logger } from '@/utils/logger';
import { activateComposeSender } from '@/utils/photo-compose';
import { registerChatScrollToBottom } from '@/utils/chat-scroll';

const ts = () => new Date().toISOString().slice(11, 23);

interface ChatViewProps {
  onMenuPress: () => void;
}

const SCROLL_TOP_THRESHOLD = 60;
const SCROLL_BOTTOM_THRESHOLD = 100;

// CRITICAL: module-level stable empty array. The sessionMessages selector below
// MUST return a referentially stable value when the session has no messages.
// Zustand v5 uses Object.is on the selector result; an inline `[]` literal in
// the selector creates a NEW array reference on every call while messages are
// undefined (e.g. during initial load / session switch), which trips
// useSyncExternalStore's cache check → "getSnapshot should be cached" warning
// → infinite re-render → "Maximum update depth exceeded" → blank screen.
// Returning this shared constant keeps the reference identical across calls.
const EMPTY_MESSAGES: ChatMessage[] = [];

export function ChatView({ onMenuPress }: ChatViewProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  // When ChatView loses focus (user navigated to a sub-screen like settings
  // or search), freeze the messages snapshot so WS streaming tokens don't
  // reconcile an invisible tree. Each ~100ms token would otherwise re-render
  // the last ChatBubble + MarkdownRenderer, blocking the JS thread and
  // starving touch events on the foreground screen — the root cause of
  // "buttons don't respond after navigating during streaming" + GO_BACK
  // event flooding. The cached ref keeps the same array reference while
  // unfocused → Zustand's Object.is check skips re-render entirely. On
  // refocus, the selector picks up the latest messages in one batch.
  const isFocused = useIsFocused();
  const cachedMessagesRef = useRef<ChatMessage[]>(EMPTY_MESSAGES);
  // Fine-grained selectors: subscribe to each field independently so that
  // a streaming token (which only changes `messages[sessionId]`) triggers
  // exactly ONE re-render of this component (via sessionMessages), not a
  // re-render per unrelated field. Previously `useChatStore()` with no
  // selector subscribed to the ENTIRE store object — every setState (even
  // unrelated ones) caused a re-render. Combined with ChatBubble having no
  // React.memo, this produced an O(messages × tokens) reconciliation storm
  // that saturated the JS thread and starved native scroll/touch events.
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const sessionMessages = useChatStore((s) => {
    if (!isFocused || !s.currentSessionId) return cachedMessagesRef.current;
    const msgs = s.messages[s.currentSessionId] ?? EMPTY_MESSAGES;
    cachedMessagesRef.current = msgs;
    return msgs;
  });
  const isLoadingMore = useChatStore((s) => s.isLoadingMore);
  // messagesNotLoaded: per-session "never fetched" flag.
  // More reliable than global isLoading (shared between loadSessions and
  // loadMessages → race condition where loadSessions finishing first hides
  // the skeleton before loadMessages completes).
  const messagesNotLoaded = useChatStore((s) =>
    s.currentSessionId ? s.messages[s.currentSessionId] === undefined : false,
  );
  const isStreaming = useChatStore((s) => s.isStreaming);
  const pendingUserMessage = useChatStore((s) => s.pendingUserMessage);
  const isWaitingForCancelAck = useChatStore((s) => s.isWaitingForCancelAck);
  const pendingSendAfterCancel = useChatStore((s) => s.pendingSendAfterCancel);
  const setPendingSendAfterCancel = useChatStore((s) => s.setPendingSendAfterCancel);
  const loadMoreMessages = useChatStore((s) => s.loadMoreMessages);
  const hasMoreMessages = useChatStore((s) => s.hasMoreMessages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const cancelStream = useChatStore((s) => s.cancelStream);
  const isAutoPlay = useAuthStore((s) => s.user?.chatSetting.autoPlay ?? false);
  const toggleAutoPlay = useChatStore((s) => s.toggleAutoPlay);
  const authToken = useAuthStore((s) => s.token);
  const router = useRouter();

  // ── Streaming store subscriptions REMOVED (Round-13 fix) ──────────
  // The 4 useStreamingStore selectors used to live here, but subscribing
  // them at ChatView level meant EVERY WS token re-rendered the entire
  // ChatView function body: re-creates inline arrows, re-runs all useMemos
  // that DO depend on streaming state, AND reconciles the whole JSX tree
  // (ScrollView + N historical ChatBubbles). Combined with the 250ms-
  // throttled MarkdownRenderer running MarkdownIt.parse (O(text.length))
  // on every ChatView render, JS thread saturated and Android native
  // touch/scroll events queued → "Maximum update depth exceeded" +
  // stuck gestures. Fix: subscribe to streaming fields inside the
  // isolated StreamingBubble component — only that one bubble re-renders
  // per token; ChatView's tree (and historical ChatBubbles) stays frozen.
  // See components/chat/StreamingBubble.tsx for the leaf subscriber.

  const scrollViewRef = useRef<ScrollView>(null);
  const { isKeyboardVisible } = useKeyboard();

  // Scroll position tracking
  const prevContentHeight = useRef(0);
  const wasNearBottom = useRef(true); // start at bottom
  // lastNearBottom: GROUND TRUTH of whether the user is visually at the
  //   bottom, updated on every onScroll event. Unlike wasNearBottom, this
  //   has NO gesture/streaming logic — it's pure position. Used by
  //   handleContentSizeChange to correct stale wasNearBottom=false values
  //   left over from mid-stream micro-gestures (regression 2): after the
  //   stream ends, new content (e.g. markdown re-render) may arrive while
  //   wasNearBottom is stale false; if the user is actually at the bottom
  //   (lastNearBottom=true), we restore follow.
  const lastNearBottom = useRef(true);
  const loadingMoreScrollAdjust = useRef(false);
  // Previous scroll offset — used to compute dy on every onScroll event.
  // dy is the key signal for distinguishing user gestures from programmatic
  // scrolls (see handleScroll comment).
  const lastOffsetY = useRef(0);

  // ── Scroll-follow refs ──
  // lastViewH: tracks ScrollView height to detect keyboard-induced layout
  //   changes. When viewH jumps >10px between events, the scroll event is
  //   from a layout change (keyboard open/close), NOT a user gesture.
  const lastViewH = useRef(0);

  // prevContentHScroll: tracks contentSize.height BETWEEN onScroll events
  //   (distinct from prevContentHeight, which is for handleContentSizeChange).
  //   Used to detect user-initiated upward scrolls via the "contentUnchanged
  //   && dy<0" signal — the reliable fallback when onScrollBeginDrag does
  //   NOT fire on Android during post-stream content mutations. See
  //   handleScroll Path B for the full rationale.
  const prevContentHScroll = useRef(0);

  // isUserGesturing: true while the user is actively touching/dragging the
  //   ScrollView OR while momentum scroll is in progress. Set true by
  //   onScrollBeginDrag, set false by onMomentumScrollEnd (or by a timeout
  //   in onScrollEndDrag when no momentum follows).
  //
  //   This flag is the SOLE gate for the wasNearBottom=false logic in
  //   handleScroll. Without it, Android's contentSize-growth-induced offset
  //   adjustments during WS streaming produce negative dy that looks exactly
  //   like a user swipe-up, permanently disabling follow.
  //
  //   Follow-resume (wasNearBottom = true) is handled ONLY at gesture end
  //   (onScrollEndDrag / onMomentumScrollEnd), gated by BOTH net direction
  //   (netDelta > 10 = downward) AND position (nearBottom). Position alone is
  //   insufficient: during WS streaming, content growth can make nearBottom=true
  //   even after an upward swipe. The direction gate is the critical fix for
  //   the round-7 "yanked back to bottom" regression.
  const isUserGesturing = useRef(false);

  // gestureStartOffsetY: records the scroll offset at the start of each user
  //   gesture (onScrollBeginDrag). At gesture end, we compare the final offset
  //   to this value to determine NET movement direction. Only a deliberate
  //   DOWNWARD scroll (netDelta > 10) that ends near the bottom resumes
  //   auto-follow. This prevents WS content-growth from making nearBottom=true
  //   at gesture end (round-7 root cause), which falsely resumed follow and
  //   yanked the user back to the bottom after an upward swipe.
  const gestureStartOffsetY = useRef(0);

  // gestureMinOffsetY: tracks the MINIMUM offsetY reached during the current
  //   user gesture. Updated on every onScroll event while isUserGesturing
  //   (and not a layout-change event). Reset to lastOffsetY at gesture start
  //   (handleScrollBeginDrag).
  //
  //   PURPOSE: At gesture end, we compare gestureMinOffsetY to
  //   gestureStartOffsetY to detect whether the user ACTUALLY swiped up
  //   at any point during the gesture. This is the critical signal for
  //   the "userSwipedUp" gate on follow-resume.
  //
  //   WHY THIS IS NEEDED (root cause for problem 1 — "swipe up then auto
  //   return to bottom"): During/after WS streaming, Android's native
  //   ScrollView re-anchors offsetY forward on every contentSize growth
  //   (the same native yank behavior Plan 5 counters, but Plan 5 only
  //   catches dy>400 during-gesture / dy>50 non-gesture). SMALLER native
  //   yanks (dy<400 during gesture) accumulate forward motion that the
  //   round-9 netDelta>10 gate cannot distinguish from a legitimate
  //   downward flick. Result: user swipes up, multiple small native yanks
  //   push offsetY forward, at gesture end netDelta reads positive/downward
  //   → follow-resume fires → wasNearBottom=true → next contentSize change
  //   yanks user to bottom. Real-device log evidence:
  //     [DragDebug] onMomentumScrollEnd offsetY:5245 follow:false→true
  //       netDelta:1006 nearBottom:true isStreaming:false
  //   The user swiped up but netDelta=+1006 (impossible for a finger
  //   flick — that's 1006px of accumulated native yanks).
  //
  //   WHY gestureMinOffsetY IS A SAFE SIGNAL: native yanks ONLY ever
  //   INCREASE offsetY (forward re-anchor on content growth). They NEVER
  //   decrease offsetY. So gestureMinOffsetY reflects genuine user upward
  //   motion — the only way it can drop below gestureStartOffsetY-10 is
  //   if the user's finger actually moved upward. Plan 5's counter-scroll
  //   (scrollTo back to prevOffsetY) does not affect this because the
  //   counter-scroll restores a HIGHER position, not a lower one.
  const gestureMinOffsetY = useRef(0);

  // dragEndTimeout: when the user lifts their finger (onScrollEndDrag),
  //   we start a short timeout. If onMomentumScrollBegin fires within it,
  //   the timeout is cancelled (momentum will be handled by
  //   onMomentumScrollEnd). If the timeout expires, there was no momentum
  //   and the drag-end position is the final position.
  const dragEndTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // programMomentumActive: distinguishes user-gesture momentum from
  //   programmatic-scroll momentum. On Android, scrollToEnd/scrollTo
  //   (including the streaming polling at line ~243) fires the FULL
  //   momentum sequence (onMomentumScrollBegin + onMomentumScrollEnd),
  //   even with animated:false. Without distinguishing, these programmatic
  //   momentum events reset isUserGesturing mid-user-drag and run
  //   follow-resume logic, which was the ROOT CAUSE of the round-7
  //   "user scrolled up during streaming but got yanked back to bottom"
  //   regression: polling scrollToEnd → onMomentumScrollEnd →
  //   isUserGesturing=false → onScroll dy-gate closed → wasNearBottom
  //   never set to false → polling kept yanking user to bottom.
  //
  //   DETECTION: a user-gesture momentum sequence ALWAYS follows
  //   onScrollEndDrag within the 100ms dragEndTimeout window, so
  //   onMomentumScrollBegin sees dragEndTimeout as ACTIVE. A programmatic
  //   momentum sequence has NO preceding onScrollEndDrag, so
  //   onMomentumScrollBegin sees dragEndTimeout as NULL → set this flag.
  //   onMomentumScrollEnd then consumes the flag and skips gesture-end
  //   processing entirely.
  const programMomentumActive = useRef(false);

  // isStreamingRef: mirrors the isStreaming store value into a ref so the
  //   gesture-end callbacks (handleScrollEndDrag / handleMomentumScrollEnd),
  //   which use empty-dependency useCallback, can read the current streaming
  //   state without being re-created on every stream start/stop.
  //
  //   This is the SOLE gate for follow-resume suppression during WS
  //   streaming (Plan 4). Root cause for round-8 failure: netDelta > 10 was
  //   trusted during streaming, but WS content growth inflates offsetY so
  //   that even a tiny 25px upward-then-back jitter reads as netDelta > 0,
  //   falsely resuming follow and yanking the user back to the bottom.
  //   During streaming, we NEVER auto-resume follow at gesture end — the
  //   user must explicitly tap the "scroll to bottom" button.
  const isStreamingRef = useRef(isStreaming);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // 页面失去焦点(切换到其他页面)时停止 TTS 播报。
  // 用 isFocused(已在 L55 声明)而非 unmount cleanup:ChatView 在主页
  // index.tsx 中,Stack 导航 push 新页面时底层组件不 unmount,cleanup 不会触发。
  // 切后台(AppState → background)不影响 navigation focus,播报继续。
  //
  // 抑制策略:只在 WS 流式传输中(isStreaming)才设 playbackSuppressed。
  // 切回来时不清除 — 由 finishStream(WS 结束)或新 messageId 的
  // enqueueText 自动清除。这确保切回来后当前这条消息不会继续播放,
  // 但下次新 WS 消息恢复自动播放。
  useEffect(() => {
    if (!isFocused) {
      const tts = useTtsStore.getState();
      tts.stopTtsPlayback();
      // 只有 WS 在流式传输时才抑制后续 enqueueText。
      // 手动播放(无 WS 流)不需要抑制 — 切回来后用户可正常发新消息。
      if (isStreamingRef.current) {
        tts.setPlaybackSuppressed(true);
      }
    }
    // 切回来时不清除 suppressed — 见上方注释
  }, [isFocused]);

  // ── DEBUG: streaming guard instrumentation (Round-12) ──
  // Tracks Plan 5 hit count, STREAMING-SUPPRESSION hit count, and current
  // setState stack depth. Logged once per second during WS streaming so we
  // can verify (a) the !isStreamingRef guard is actually short-circuiting
  // counter-scroll, (b) the suppression branch is engaging, and (c) catch
  // any new nested-setState path BEFORE it throws Maximum update depth.
  // These counters are zero-cost when NOT streaming (only incremented inside
  // the hot path).
  const debugCountersRef = useRef({
    plan5Hits: 0,
    streamingSuppressionHits: 0,
    peakStackDepth: 0,
    startedAt: 0,
    lastReportAt: 0,
    sessionId: '',
  });

  // suppressRogueCounter: set true right before any legitimate programmatic
  //   scrollTo that could be misdetected by Plan 5 as a rogue native jump.
  //   Specifically the loadMore anchor scroll: user is at top (wasNearBottom
  //   =false), older messages prepend, handleContentSizeChange does
  //   scrollTo({y: diff}) to keep the anchor message in view. That produces
  //   a large positive dy indistinguishable from a native yank — without
  //   this flag Plan 5 would counter-scroll it back to y=0, snapping the
  //   user to the very top. Cleared after one onScroll cycle in handleScroll.
  //   Safe because diff>0 guarantees a position change → onScroll fires.
  const suppressRogueCounter = useRef(false);

  // ── Post-send scroll burst ──
  // After sendMessage, the user bubble + streaming bubble render asynchronously
  // (React commit → native layout → markdown parse → height re-measure).
  // A single scrollToEnd races against this pipeline and lands short — the
  // user sees only the top half of their bubble. The session-switch effect
  // (L417) solved the exact same problem by firing scrollToEnd 10×/150ms.
  // We reuse that proven pattern here. The ref lets a new burst cancel a
  // still-running one (rapid re-send under cancel-then-send).
  const scrollBurstRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const triggerScrollBurst = useCallback(() => {
    if (scrollBurstRef.current) clearInterval(scrollBurstRef.current);
    logger.debug('BubbleDebug', `[${ts()}] BURST START — scrollEnabled=${!isInputRecordingRef.current} isStreaming=${isStreamingRef.current}`);
    let count = 0;
    scrollBurstRef.current = setInterval(() => {
      scrollViewRef.current?.scrollToEnd({ animated: false });
      count++;
      // Each tick: confirm scrollToEnd was invoked + scrollEnabled
      // state at invoke time. Actual resulting offsetY is logged in handleScroll
      // (burst-guarded) — that's the ground truth of whether the scroll landed.
      logger.debug('BubbleDebug', `burst tick ${count}/10 — scrollEnabled=${!isInputRecordingRef.current}`);
      if (count >= 10) {
        if (scrollBurstRef.current) clearInterval(scrollBurstRef.current);
        scrollBurstRef.current = null;
        logger.debug('BubbleDebug', `[${ts()}] BURST END`);
      }
    }, 150);
  }, []);

  // Clear any pending scroll burst on unmount.
  useEffect(() => {
    return () => {
      if (scrollBurstRef.current) clearInterval(scrollBurstRef.current);
    };
  }, []);

  // ── Map-modal send → scroll to bottom ──
  // MapChatInput (inside the full-screen map/nearby/my-location modals) sends
  // through the chat store directly, bypassing handleSend. It fires the
  // chat-scroll bridge instead; here we subscribe and resume follow + burst
  // so the sent message + AI reply come into view once the modal closes.
  useEffect(() => {
    return registerChatScrollToBottom(() => {
      logger.debug('BubbleDebug', `[${ts()}] chat-scroll bridge fired — resuming follow + burst`);
      isUserGesturing.current = false;
      wasNearBottom.current = true;
      triggerScrollBurst();
    });
  }, [triggerScrollBurst]);

  // Reset debug counters when a new streaming session begins. The session
  // ID is captured so multi-session logs can be correlated.
  useEffect(() => {
    if (isStreaming) {
      const now = Date.now();
      debugCountersRef.current = {
        plan5Hits: 0,
        streamingSuppressionHits: 0,
        peakStackDepth: 0,
        startedAt: now,
        lastReportAt: now,
        sessionId: currentSessionId ?? 'unknown',
      };
      const streamTs = new Date(now).toISOString().split('T')[1].replace('Z', '');
      logger.debug(
        'StreamDebug',
        `[${streamTs}] BEGIN session=${currentSessionId ?? 'unknown'} — armed: plan5=0 supp=0 peak=0`
      );
    } else {
      // Stream ended (isStreaming true→false). The StreamingBubble will be
      // replaced by a real ChatBubble; this causes contentSize jitter and,
      // critically, a NET SHRINK if the real bubble is shorter than the
      // streamed text. RN ScrollView native-clamps offsetY back to the new
      // (smaller) maxOffset — which can land in the MIDDLE of the user's
      // bubble, making it look "half-visible" again. Fire a burst to chase
      // this post-stream layout and pin the view to the bottom.
      //
      // BUT: only chase the bottom if the user is actually following the
      // stream (wasNearBottom). If the user manually scrolled up to read
      // history during the stream, respect their position and do NOT yank
      // them back down. The half-visible bubble fix is irrelevant when the
      // user isn't looking at the bottom anyway.
      logger.debug('BubbleDebug', `[${ts()}] isStreaming→false — wasNearBottom=${wasNearBottom.current} burstGuard=${wasNearBottom.current}`);
      if (wasNearBottom.current) {
        triggerScrollBurst();
      }
    }
  }, [isStreaming, currentSessionId]);

  // ── Streaming scroll-follow poll ──
  // During WS streaming, content grows rapidly (every ~100ms per token).
  // handleContentSizeChange fires per growth and calls scrollToEnd, but on
  // Android a single scrollToEnd often lands short — the native ScrollView
  // clamps to a stale contentSize that hasn't settled yet, leaving the
  // latest text half-hidden behind the input bar.
  //
  // Fix: poll scrollToEnd every 150ms throughout the entire streaming
  // duration, gated by wasNearBottom && !isUserGesturing (same condition
  // as handleContentSizeChange L1005). Each poll re-attempts the scroll,
  // catching up to content that grew since the last attempt. When the user
  // scrolls up (wasNearBottom=false) or is actively dragging
  // (isUserGesturing=true), the poll skips — no interference.
  //
  // STALE wasNearBottom SELF-CORRECTION:
  //   wasNearBottom is set to false by handleScroll Path A/B when the user
  //   swipes up. But Path A requires isUserGesturing=true (set by
  //   onScrollBeginDrag, which does NOT reliably fire on Android — see
  //   L783-787), and Path B requires contentUnchanged (false during
  //   streaming because content grows every token). If neither path fires,
  //   wasNearBottom stays stale true → the poll yanks the user back to the
  //   bottom every 150ms, and triggerScrollBurst at stream-end (L366-368)
  //   yanks again — matching the user-reported bug "上滑后不动，当ws结束
  //   的时候，滚动条回跳其他位置".
  //
  //   Fix: use lastNearBottom.current (GROUND TRUTH position, updated on
  //   every onScroll event regardless of gesture state) to self-correct.
  //   If lastNearBottom has been false for 2+ consecutive ticks (300ms+),
  //   the user has genuinely scrolled up — not a transient content-growth
  //   gap between poll cycles. Clear wasNearBottom so the poll, the
  //   stream-end burst, and handleContentSizeChange all stop yanking.
  useEffect(() => {
    if (!isStreaming) return;
    let notAtBottomTicks = 0;
    const interval = setInterval(() => {
      if (!lastNearBottom.current && !isUserGesturing.current) {
        notAtBottomTicks++;
        if (notAtBottomTicks >= 2 && wasNearBottom.current) {
          logger.debug(
            'DragDebug',
            `[${ts()}] Poll self-correct — wasNearBottom cleared (not at bottom for ${notAtBottomTicks} ticks, lastNearBottom=false)`,
          );
          wasNearBottom.current = false;
        }
      } else {
        notAtBottomTicks = 0;
      }
      if (wasNearBottom.current && !isUserGesturing.current) {
        scrollViewRef.current?.scrollToEnd({ animated: false });
      }
    }, 150);
    return () => clearInterval(interval);
  }, [isStreaming]);

  // ── Scroll-to-bottom button visibility ──
  // Separate from wasNearBottom ref so UI re-renders when state changes.
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // When the user is holding-to-record in ChatInputBar, the message-list
  // ScrollView's native pan recognizer must be disabled — otherwise it
  // steals touches from the RNGH Pan gesture tracking the finger's
  // vertical position (slide-up-to-cancel). On iOS the native recognizer
  // fires `onScrollBeginDrag` the moment the finger enters the
  // ScrollView's frame, causing RNGH Pan to receive state=FAILED.
  const [isInputRecording, setIsInputRecording] = useState(false);
  // Mirror into ref (render-time sync, same pattern as isStreamingRef L243-245)
  // so triggerScrollBurst's stale useCallback closure can read the REAL
  // scrollEnabled value for [BubbleDebug] diagnostics.
  const isInputRecordingRef = useRef(isInputRecording);
  isInputRecordingRef.current = isInputRecording;

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  // Header share button: 1-tap share of the current session (the drawer's
  // "..." sheet stays as the secondary entry). Hidden when no session is open.
  const shareSession = useSessionShare();
  const handleHeaderShare = useCallback(() => {
    if (currentSession) shareSession(currentSession.id, currentSession.title);
  }, [currentSession, shareSession]);

  // sessionMessages comes from the fine-grained selector above (line 38-40),
  // NOT a re-derivation here — re-declaring would both duplicate the identifier
  // and reference the non-existent bare `messages` variable.
  const hasMore = currentSessionId ? hasMoreMessages(currentSessionId) : false;

  // ── v3: exclude the streaming placeholder from the historical render list ──
  // During streaming, the placeholder (empty content) exists in the messages
  // tree but its live content is in useStreamingStore. Filtering it out
  // prevents rendering an empty bubble; the live content is rendered by
  // the streaming ChatBubble appended at the end of the list.
  // We still need to know the streaming messageId here (to filter), but
  // subscribing at ChatView level would re-run this useMemo every token.
  // Solution: subscribe ONLY to messageId (string, cheap comparison) —
  // the renderMessages reference doesn't change during streaming because
  // sessionMessages is frozen and the filter result for the same id is
  // referentially stable. The expensive streamingContent/searchKeywords/
  // sources selectors live in StreamingBubble, so ChatView's tree stays
  // frozen per token.
  const streamingMessageId = useStreamingStore((s) => s.messageId);
  const renderMessages = useMemo(() => {
    if (!streamingMessageId) return sessionMessages;
    return sessionMessages.filter((msg) => msg.id !== streamingMessageId);
  }, [sessionMessages, streamingMessageId]);

  // Debug: track skeleton condition changes
  useEffect(() => {
    const shouldShowSkeleton = renderMessages.length === 0 && messagesNotLoaded && !isStreaming;
    logger.info('ChatView', 'render state', {
      currentSessionId,
      renderMessagesCount: renderMessages.length,
      messagesNotLoaded,
      isStreaming,
      shouldShowSkeleton,
    });
  }, [renderMessages.length, messagesNotLoaded, isStreaming, currentSessionId]);

  // ── Group consecutive messages by role ─────────────────────
  // Same role in a row = one "turn group". Action buttons (play/copy/time)
  // only render on the last message of each group. Copy/play use the
  // aggregated plain text of the entire group.
  // Computed on renderMessages (filtered list) so indices align with the
  // rendered list. During streaming, renderMessages is frozen → this
  // computation is stable across every WS token (previously it recomputed
  // per-token because sessionMessages changed on every updateStreamingContent).
  const groupMeta = useMemo(() => {
    const n = renderMessages.length;
    // Per-index metadata: isLastInGroup + aggregated group plain text
    const meta = new Array<{ isLastInGroup: boolean; groupText: string }>(n);
    // Walk backwards: when role changes vs. next, this is the group's tail.
    // Accumulate text within each group in one backward sweep.
    let i = n - 1;
    while (i >= 0) {
      const role = renderMessages[i].role;
      // Find start of this role-run (scan left while same role)
      let start = i;
      while (start > 0 && renderMessages[start - 1].role === role) {
        start--;
      }
      // Aggregate plain text from start..i (in order). The action buttons
      // (play/copy/time) attach to the LAST message in the group that carries
      // TEXT — so a text answer followed by a generated video / tool card
      // still shows its actions, while pure video/tool tail messages don't.
      let text = '';
      let lastTextIdx = -1;
      for (let k = start; k <= i; k++) {
        const parts = renderMessages[k].content;
        let hasText = false;
        for (const p of parts) {
          if (p.type === 'text') {
            const t = (p as TextContent).text.trim();
            if (t) {
              text += (text ? '\n' : '') + t;
              hasText = true;
            }
          }
        }
        if (hasText) lastTextIdx = k;
        meta[k] = { isLastInGroup: false, groupText: text };
      }
      if (lastTextIdx >= 0) {
        meta[lastTextIdx] = { isLastInGroup: true, groupText: text };
      }
      i = start - 1;
    }
    return meta;
  }, [renderMessages]);

  // ── Conversation-wide image gallery (role-filtered) ───────────────────
  // Collects previewable image URIs across the conversation, split by role
  // (sent vs received). When the user taps an inline image,
  // handleConversationImagePress finds the URI in its role group and opens
  // /photo-compose with ONLY that role's images pre-loaded — swiping stays
  // within sent or received, never crossing roles. Uses renderMessages
  // (excludes the live streaming message) so the list is frozen during
  // streaming; the streaming bubble falls back to its own per-message
  // handleImagePress.
  const conversationImagesByRoleRef = useRef<{ sent: string[]; received: string[] }>({ sent: [], received: [] });
  const conversationImagesByRole = useMemo(() => {
    const sent: string[] = [];
    const received: string[] = [];
    for (const msg of renderMessages) {
      const target = msg.role === 'user' ? sent : received;
      for (const item of msg.content) {
        if (item.type === 'image') {
          target.push(resolveAuthedImageUri(item.uri || item.data || '', authToken));
        } else if (item.type === 'file' && (item.mediaType ?? '').startsWith('image/')) {
          target.push(resolveAuthedImageUri(item.data || item.uri || '', authToken));
        }
      }
    }
    return { sent, received };
  }, [renderMessages, authToken]);
  conversationImagesByRoleRef.current = conversationImagesByRole;

  const handleConversationImagePress = useCallback(
    (uri: string) => {
      const { sent, received } = conversationImagesByRoleRef.current;
      let list = sent;
      let index = sent.indexOf(uri);
      if (index < 0) {
        list = received;
        index = received.indexOf(uri);
      }
      const start = Math.max(0, index);
      const fallback = index >= 0 ? list : [uri];
      const attachments = fallback.map((u, i) => ({
        id: `chat-img-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'image' as const,
        name: fallback.length > 1 ? `image-${i + 1}.jpg` : 'image.jpg',
        uri: u,
        mediaType: 'image/jpeg',
      }));
      activateComposeSender();
      router.push({
        pathname: '/photo-compose',
        params: { initial: JSON.stringify(attachments), initialIndex: String(start), mode: 'view' },
      });
    },
    [router],
  );

  // ── v3 streaming message: MOVED into StreamingBubble (Round-13) ──────────
  // The synthetic streaming message + groupText aggregation now live inside
  // components/chat/StreamingBubble.tsx. That component subscribes to
  // useStreamingStore directly and is wrapped in React.memo, so ChatView
  // no longer re-renders on every WS token. Historical bubbles + ScrollView
  // stay frozen; only the streaming bubble reconciles.
  //
  // ── Scroll to bottom on session switch ──
  // On Android, scrollToEnd called during onContentSizeChange is unreliable
  // because layout may not be finished. Poll briefly to catch all cases
  // (cached messages, async API load, delayed MD rendering).
  useEffect(() => {
    wasNearBottom.current = true;
    lastNearBottom.current = true;
    prevContentHeight.current = 0;
    lastOffsetY.current = 0;
    lastViewH.current = 0;
    gestureStartOffsetY.current = 0;
    // Reset gestureMinOffsetY on session switch to prevent stale state from
    // a previous session's gesture from contaminating the new session's
    // userSwipedUp detection. Without this, switching from a session where
    // the user had swiped up (gestureMinOffsetY < gestureStartOffsetY) to a
    // fresh session could leave gestureMinOffsetY at a low value, causing
    // the FIRST gesture in the new session to falsely detect userSwipedUp
    // and block follow-resume.
    gestureMinOffsetY.current = 0;
    isUserGesturing.current = false;
    if (dragEndTimeout.current) {
      clearTimeout(dragEndTimeout.current);
      dragEndTimeout.current = null;
    }
    setShowScrollToBottom(false);

    let count = 0;
    const interval = setInterval(() => {
      scrollViewRef.current?.scrollToEnd({ animated: false });
      count++;
      if (count >= 10) clearInterval(interval);
    }, 150);
    return () => clearInterval(interval);
  }, [currentSessionId]);

  // ── Scroll to bottom when keyboard opens ──
  // On Android with adjustResize, the window resizes when keyboard appears.
  // The ScrollView doesn't auto-scroll to bottom, so we must manually
  // push the latest messages into view.
  // 🔴 v20: keyboard open/close must NOT scroll the message list. The map
  // full-screen modals (MapChatInput) share the GLOBAL Keyboard events, so a
  // keyboard opening inside a map modal used to yank the chat list to the
  // bottom even though no message was sent. Scrolling is now driven ONLY by
  // sending a message (handleSend sets wasNearBottom=true → contentSizeChange
  // follows) and by user-initiated actions.

  // ── v3: streaming auto-follow via onContentSizeChange ──────────
  // PREVIOUSLY: 100ms setInterval polling called scrollToEnd 10×/sec.
  // This added unnecessary JS thread work during streaming — exactly
  // when we need the JS thread to be free for touch/scroll events.
  //
  // v3: with physical isolation, only the streaming ChatBubble changes
  // per token. Its height growth triggers ScrollView's onContentSizeChange
  // → handleContentSizeChange → scrollToEnd. Combined with Q3's 250ms
  // markdown throttle, contentSize events fire at most ~4×/sec — smooth,
  // reliable, and zero polling overhead.
  //
  // Safety: handleContentSizeChange already has the wasNearBottom &&
  // !isUserGesturing gate, so manual scroll-up still stops auto-follow.

  // ── Pending voice transcription (from ChatHome) ──
  // When user records voice on ChatHome, audioUri is stored in the store.
  // After session creation → ChatView mounts → this effect transcribes
  // and sends the message. pendingUserMessage stays true during transcription,
  // showing the TypingIndicator until sendMessage completes.
  // Also handles attachments stored as pendingBlocks (Bug 1 fix).
  useEffect(() => {
    const state = useChatStore.getState();
    if (state.pendingAudioUri && currentSessionId) {
      const audioUri = state.pendingAudioUri;
      const pendingBlocks = state.pendingBlocks;
      state.setPendingAudioUri(null); // Clear immediately to prevent re-processing
      state.setPendingBlocks(null);
      (async () => {
        try {
          const { transcribeAudio } = await import('@/services/voice-service');
          const transcribedText = (await transcribeAudio(audioUri)).trim();
          const s = useChatStore.getState();
          if (transcribedText) {
            // Combine transcribed text with any attachment blocks
            const allBlocks: WsContentBlock[] = [
              { type: 'text', text: transcribedText },
              ...(pendingBlocks || []),
            ];
            s.sendMessage(currentSessionId, transcribedText, allBlocks);
          } else if (pendingBlocks?.length) {
            s.sendMessage(currentSessionId, '', pendingBlocks);
          } else {
            s.setPendingUserMessage(false);
          }
        } catch (err) {
          useChatStore.getState().setPendingUserMessage(false);
          logger.warn('ChatView', 'Voice transcription failed', err);
        }
      })();
    }
  }, [currentSessionId]);

  // ── Scroll handler with layout-change filter + gesture gate ──
  //
  // THREE root causes identified from real-device logs across 6 debug rounds:
  //
  // ROOT CAUSE 1 — Keyboard layout change (dy false positive):
  //   When keyboard opens/closes, the ScrollView height (viewH) changes
  //   abruptly (e.g. 339→603). This causes a large offsetY jump that looks
  //   exactly like a fast swipe-up (dy: -101, -263). The old dy < -5 check
  //   falsely triggered "user swiped up" → wasNearBottom = false → follow
  //   stopped, even though the user never touched the screen.
  //   FIX: Detect viewH mutations. If |viewH - lastViewH| > 10px, classify
  //   the event as a layout change and skip ALL dy-based follow logic.
  //
  // ROOT CAUSE 2 — contentSize-growth-induced negative dy (THE KILLER):
  //   During WS streaming, each new token grows contentSize at the bottom.
  //   Android auto-adjusts offsetY to maintain the user's visual position,
  //   producing negative dy values that look EXACTLY like a user swipe-up.
  //   FIX: Gate ALL dy-based logic on isUserGesturing (set by
  //   onScrollBeginDrag, cleared by onMomentumScrollEnd). System offset
  //   adjustments never have this flag set → ignored entirely.
  //
  // ROOT CAUSE 3 — Unconditional position-based follow-resume (FIXED):
  //   The round-7 approach set wasNearBottom = nearBottom at every gesture end.
  //   During WS streaming, content growth can make nearBottom=true even after
  //   an upward swipe (Android auto-adjusts offsetY), so this yanked the user
  //   back to the bottom.
  //   FIX: Follow-resume at gesture end now requires BOTH a net downward
  //   movement (netDelta > 10 vs gestureStartOffsetY) AND nearBottom. Upward
  //   swipes never satisfy the direction gate, so wasNearBottom stays false.
  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const prevOffsetY = lastOffsetY.current;
    const dy = contentOffset.y - prevOffsetY;
    const viewH = layoutMeasurement.height;
    const viewHDelta = Math.abs(viewH - lastViewH.current);
    const contentH = contentSize.height;
    lastViewH.current = viewH;
    lastOffsetY.current = contentOffset.y;

    // [BubbleDebug] ONLY log during an active post-send burst — shows the
    // ACTUAL offsetY after each scrollToEnd tick vs the target (contentH-viewH).
    // If offsetY << target, scrollToEnd is not reaching the bottom (stale
    // contentSize, native clamp, or scrollEnabled race). This is the ground
    // truth that the burst-tick log can't see.
    if (scrollBurstRef.current) {
      const target = contentH - viewH;
      logger.debug(
        'BubbleDebug',
        `onScroll during burst — offsetY:${Math.round(contentOffset.y)} target:${Math.round(target)} contentH:${Math.round(contentH)} viewH:${Math.round(viewH)} gap:${Math.round(target - contentOffset.y)} scrollEnabled=${!isInputRecordingRef.current}`,
      );
    }

    // ── DEBUG block removed (v13) ──
    // Previously: stack depth tracking + 1Hz throttled counters
    //   (created a `new Error().stack?.split('\n')` per scroll tick during
    //   streaming → high CPU overhead + log spam).
    // We now rely on `[streaming.updateContent]` stack-trace logs (added
    // in stores/streaming.ts v13) to locate any setState loop. If
    // "Maximum update depth exceeded" reappears, the stack trace there
    // will point at the true re-entrant caller.

    // ── Rogue native jump detection (Plan 5) ──
    // ROOT CAUSE (confirmed via 10th-batch real-device logs): Android's
    // native ScrollView (ReactScrollView.java) forcibly re-anchors the
    // scroll offset forward when content is appended at the bottom, EVEN
    // WHEN the user has scrolled up. This native behavior is invisible
    // to all JS-side gates (wasNearBottom / isStreamingRef / gesture
    // state) because it happens entirely in native code on the layout
    // pass, not via any JS scrollToEnd call.
    //
    // DECISIVE LOG EVIDENCE (non-gesture):
    //   [ScrollDebug] dy=+441 isGesturing=false wasNearBottom=false
    //                 viewHDelta=0  NO [YankDebug] nearby
    //   [ScrollDebug] dy=+237 isGesturing=false wasNearBottom=false
    //                 viewHDelta=0  NO [YankDebug] nearby
    // DECISIVE LOG EVIDENCE (during-gesture — previously MISSED):
    //   [ScrollDebug] dy=+981 isGesturing=true  wasNearBottom=false
    //                 viewHDelta=0  → yanked forward while finger on screen
    //   [ScrollDebug] dy=+102 isGesturing=true  wasNearBottom=false
    //                 viewHDelta=0  → smaller during-gesture yank
    // The dy=981 case is clearly a native yank: real user drag max per-event
    // dy observed ≈ 228, so dy>400 gives a safe >1.7x margin above any
    // legitimate flick (a 400px/16ms = 25000px/s velocity is beyond any
    // physical finger speed).
    //
    // DETECTION — two branches by gesture state:
    //   NON-GESTURE (isUserGesturing=false): dy>50 suffices. Momentum is
    //     excluded (isUserGesturing=true during momentum), our scrollToEnd
    //     has wasNearBottom=true, keyboard has viewHDelta>10.
    //   DURING-GESTURE (isUserGesturing=true): dy>400 required AND direction
    //     gate (prevOffsetY <= gestureStartOffsetY + 50). Real user drags max
    //     out around dy≈228 per event; a single-event dy>400 is physically a
    //     native layout-pass re-anchor, not a finger move. The direction gate
    //     distinguishes native yank from legitimate downward flick momentum:
    //       - prevOffsetY <= gestureStartOffsetY + 50  → user scrolling UP
    //         or stationary → positive dy>400 = native yank → counter-scroll.
    //       - prevOffsetY >  gestureStartOffsetY + 50  → user scrolling DOWN
    //         → positive dy>400 = flick momentum → SKIP (user wants down).
    //     ROOT CAUSE of the direction gate (6th-batch logs): without it, a
    //     user flick DOWN from offset 14019 produced dy=422 (momentum, not
    //     yank) and was counter-scrolled back, preventing the user from
    //     reaching the bottom to restore follow ("触底不跟随").
    //     KNOWN LIMITATION: dy≈102 during-gesture yanks (observed in logs)
    //     fall within user-drag range and cannot be distinguished by dy
    //     alone. Catching these would require gesture-velocity correlation,
    //     deferred until more data confirms it's worth the complexity.
    //
    // FIX: counter-scroll back to the user's intended position. The
    // resulting onScroll event has dy≈0, so no loop. NO cooldown — every
    // native yank must be countered, otherwise consecutive yanks (from
    // multiple MD re-renders) push the user to the bottom.
    //
    // SUPPRESS GUARD: consume the suppress flag FIRST. If set, this onScroll
    // came from our own loadMore anchor scrollTo — NOT a rogue native jump.
    // Skip Plan 5 for this one event and let normal handling proceed.
    if (suppressRogueCounter.current) {
      suppressRogueCounter.current = false;
    }

    const nearBottom =
      contentOffset.y + layoutMeasurement.height >= contentSize.height - SCROLL_BOTTOM_THRESHOLD;
    lastNearBottom.current = nearBottom;

    // ── Layout-change filter (Root Cause 1) ──
    const isLayoutChange = viewHDelta > 10;

    // ── contentSize-change tracking for Path B fallback ──
    // contentUnchanged means NO new content was appended between this
    // onScroll event and the previous one. Combined with dy<0 this is the
    // decisive signal for a real user upward swipe (see Path B below).
    const contentUnchanged =
      prevContentHScroll.current > 0 && contentH === prevContentHScroll.current;
    prevContentHScroll.current = contentH;

    // ── Gesture gate (Root Cause 2) ──
    // Only process dy-based logic during a REAL user gesture. Outside of
    // gestures, onScroll events come from contentSize-growth auto-adjustments
    // or programmatic scrolls — these must NEVER change wasNearBottom.
    if (!isLayoutChange) {
      // Track minimum offsetY during gesture for userSwipedUp detection
      // at gesture end. Native yanks only inflate offsetY (positive dy),
      // so the minimum reflects genuine user upward motion. See
      // gestureMinOffsetY ref doc for the full rationale.
      if (isUserGesturing.current && contentOffset.y < gestureMinOffsetY.current) {
        gestureMinOffsetY.current = contentOffset.y;
      }

      // Path A — gesture-driven real-time swipe-up detection (Fix 4):
      //   isUserGesturing is true → this is a real touch-drag. We use
      //   detectUserSwipedUp(gestureMinOffsetY, gestureStartOffsetY) instead
      //   of single-event `dy < -5` because streaming native yanks pollute
      //   per-event dy. During WS streaming, each onScroll event's dy
      //   reflects BOTH the user's finger motion AND the native forward
      //   re-anchor from content growth. A user swiping up 30px while the
      //   native yank pushes forward 25px produces dy=-5 — barely triggering
      //   the old gate, or not at all if the yank is larger.
      //
      //   gestureMinOffsetY is immune to this pollution: native yanks ONLY
      //   INCREASE offsetY, so gestureMinOffsetY can only drop below
      //   gestureStartOffsetY via genuine user upward motion. This is the
      //   same signal already trusted at gesture-end (handleScrollEndDrag /
      //   handleMomentumScrollEnd). Fix 4 extends it to real-time detection
      //   so wasNearBottom flips to false DURING the gesture, immediately
      //   stopping streaming polling (L354) and contentSizeChange (L749)
      //   from yanking the user back.
      if (
        isUserGesturing.current &&
        detectUserSwipedUp(gestureMinOffsetY.current, gestureStartOffsetY.current)
      ) {
        const prevFollow = wasNearBottom.current;
        wasNearBottom.current = false;
        if (prevFollow) {
          logger.debug(
            'DragDebug',
            `[${ts()}] Path A swipe-up — min:${Math.round(gestureMinOffsetY.current)} start:${Math.round(gestureStartOffsetY.current)} offsetY:${Math.round(contentOffset.y)}`,
          );
        }
      }
      // Path B — contentSize-confirmed user swipe (FALLBACK):
      //   onScrollBeginDrag does NOT reliably fire on Android during
      //   post-stream content mutations (confirmed via real-device logs:
      //   dy=-534/-263 user upward swipes with NO [DragDebug]
      //   onScrollBeginDrag). Without this fallback, wasNearBottom stays
      //   true → scrollToEnd yanks the user back to the bottom.
      //
      //   WHY contentUnchanged is a SAFE gate: the ONLY sources of offsetY
      //   decrease are (1) user upward swipe, (2) native over-scroll bounce
      //   (small magnitude). Programmatic scrollToEnd/scrollTo only ever
      //   INCREASE offsetY (toward bottom). Content-growth auto-adjust
      //   changes contentSize (so contentUnchanged is false). Therefore
      //   contentUnchanged && dy<-5 can ONLY be a real user upward swipe.
      //   loadMore's anchor scrollTo is excluded by the suppressRogueCounter
      //   flag and produces dy>0 anyway.
      else if (contentUnchanged && dy < -5) {
        wasNearBottom.current = false;
      }
      // NOTE: Follow-resume is intentionally NOT handled here.
      // Resume is handled by onScrollEndDrag / onMomentumScrollEnd at gesture
      // end, gated by net direction + position (see Root Cause 3).
    }

    // Real-time UI: show/hide scroll-to-bottom button
    setShowScrollToBottom((prev) => {
      const canScrollDown = contentSize.height > layoutMeasurement.height + SCROLL_BOTTOM_THRESHOLD;
      const next = !nearBottom && canScrollDown;
      return prev === next ? prev : next;
    });

    // Near top → load older messages
    if (
      contentOffset.y <= SCROLL_TOP_THRESHOLD &&
      hasMore &&
      !loadingMoreScrollAdjust.current &&
      currentSessionId
    ) {
      loadingMoreScrollAdjust.current = true;
      prevContentHeight.current = contentSize.height;
      loadMoreMessages(currentSessionId).finally(() => {
        // Don't reset loadingMoreScrollAdjust here — handleContentSizeChange owns it
      });
    }
  }, [hasMore, currentSessionId, loadMoreMessages]);

  // ── User gesture lifecycle handlers ──
  // These four events form a precise state machine for tracking real user
  // interaction, replacing the unreliable time-window approach:
  //
  //   onScrollBeginDrag → isUserGesturing = true; record gestureStartOffsetY
  //   onScrollEndDrag   → start no-momentum timeout (100ms)
  //   onMomentumScrollBegin → cancel timeout (momentum will follow)
  //   onMomentumScrollEnd   → isUserGesturing = false; resume follow ONLY if
  //                            net downward scroll (netDelta > 10) AND nearBottom
  //
  // Follow-resume uses DIRECTION + POSITION, not position alone. Requiring
  // a net downward movement prevents WS content-growth from falsely resuming
  // follow after an upward swipe (round-7 root cause). Requiring nearBottom
  // prevents follow from resuming when the user scrolled down but is still
  // in the middle of a long conversation.

  const handleScrollBeginDrag = useCallback(() => {
    isUserGesturing.current = true;
    gestureStartOffsetY.current = lastOffsetY.current;
    // Reset gestureMinOffsetY to the gesture start position. As the user
    // swipes up (offsetY decreases), gestureMinOffsetY tracks the minimum.
    gestureMinOffsetY.current = lastOffsetY.current;
    if (dragEndTimeout.current) {
      clearTimeout(dragEndTimeout.current);
      dragEndTimeout.current = null;
    }
    logger.debug('DragDebug', `[${ts()}] onScrollBeginDrag — gesture started at offset: ${Math.round(gestureStartOffsetY.current)}`);
  }, []);

  const handleScrollEndDrag = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // User lifted finger. Momentum MAY follow. Start a short timeout:
    // if onMomentumScrollBegin fires, it cancels this timeout.
    // If the timeout expires, there was no momentum → this is the final pos.
    // Destructure BEFORE setTimeout — nativeEvent may be recycled.
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const offsetY = contentOffset.y;
    const contentH = contentSize.height;
    const viewH = layoutMeasurement.height;

    if (dragEndTimeout.current) {
      clearTimeout(dragEndTimeout.current);
    }
    dragEndTimeout.current = setTimeout(() => {
      dragEndTimeout.current = null;
      isUserGesturing.current = false;
      const nearBottom = offsetY + viewH >= contentH - SCROLL_BOTTOM_THRESHOLD;
      const netDelta = offsetY - gestureStartOffsetY.current;
      // userSwipedUp gate (problem 1 fix): if the user's finger actually
      // moved upward at any point during this gesture, do NOT auto-resume
      // follow — even if netDelta is positive due to native yank
      // accumulation. Native yanks inflate offsetY forward but cannot
      // reduce gestureMinOffsetY below gestureStartOffsetY, so this gate
      // cleanly separates real upward intent from native-yank-faked
      // downward motion. The user must tap "scroll to bottom" to resume.
      const userSwipedUp = detectUserSwipedUp(gestureMinOffsetY.current, gestureStartOffsetY.current);
      const prev = wasNearBottom.current;
      // Resume follow — delegated to pure function shouldResumeFollow()
      // (see utils/scrollFollow.ts). handleScrollEndDrag does NOT require
      // nearBottom (post-stream MD re-renders inflate contentSize faster
      // than user can scroll, making nearBottom permanently false).
      const shouldResume = shouldResumeFollow({
        isStreaming: isStreamingRef.current,
        userSwipedUp,
        netDelta,
        nearBottom,
        requireNearBottom: false,
      });
      if (shouldResume) {
        wasNearBottom.current = true;
      }
      if (prev !== wasNearBottom.current) {
        logger.debug('DragDebug', `[${ts()}] onScrollEndDrag — offsetY:${Math.round(offsetY)} follow:${prev}→${wasNearBottom.current} netDelta:${Math.round(netDelta)} userSwipedUp:${userSwipedUp} isStreaming:${isStreamingRef.current}`);
      }
    }, 100);
  }, []);

  const handleMomentumScrollBegin = useCallback(() => {
    // Distinguish user-gesture momentum from programmatic-scroll momentum.
    // See programMomentumActive docs for the full rationale.
    if (dragEndTimeout.current) {
      // User just ended a drag within the 100ms window → this momentum
      // belongs to the user gesture. Cancel the timeout (MomentumEnd owns
      // gesture teardown). programMomentumActive stays false.
      clearTimeout(dragEndTimeout.current);
      dragEndTimeout.current = null;
    } else {
      // No active dragEndTimeout → no preceding onScrollEndDrag → this
      // momentum was triggered by a programmatic scrollTo/scrollToEnd
      // (e.g. streaming polling, keyboard follow, loadMore anchor).
      // Mark it so onMomentumScrollEnd skips gesture-end processing.
      programMomentumActive.current = true;
    }
  }, []);

  const handleMomentumScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Consume programmatic momentum flag FIRST. If this momentum sequence
    // was triggered by a programmatic scrollTo/scrollToEnd (no preceding
    // onScrollEndDrag), skip ALL gesture-end processing — do NOT reset
    // isUserGesturing and do NOT run follow-resume. This is the fix for
    // the round-7 regression where streaming polling's scrollToEnd fired
    // onMomentumScrollEnd mid-user-drag, falsely resetting isUserGesturing
    // and re-enabling follow that yanked the user back to the bottom.
    if (programMomentumActive.current) {
      programMomentumActive.current = false;
      return;
    }
    isUserGesturing.current = false;
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const nearBottom =
      contentOffset.y + layoutMeasurement.height >= contentSize.height - SCROLL_BOTTOM_THRESHOLD;
    const netDelta = contentOffset.y - gestureStartOffsetY.current;
    // userSwipedUp gate (problem 1 fix — see handleScrollEndDrag for full
    // rationale): if the user's finger actually moved upward at any point
    // during this gesture, do NOT auto-resume follow, even if netDelta is
    // positive due to native yank accumulation.
    const userSwipedUp = detectUserSwipedUp(gestureMinOffsetY.current, gestureStartOffsetY.current);
    const prev = wasNearBottom.current;
    // Resume follow — delegated to pure function shouldResumeFollow()
    // (see utils/scrollFollow.ts). handleMomentumScrollEnd DOES require
    // nearBottom (this is the definitive gesture-end position after
    // momentum settles).
    const shouldResume = shouldResumeFollow({
      isStreaming: isStreamingRef.current,
      userSwipedUp,
      netDelta,
      nearBottom,
      requireNearBottom: true,
    });
    if (shouldResume) {
      wasNearBottom.current = true;
    }
    if (prev !== wasNearBottom.current) {
      logger.debug('DragDebug', `[${ts()}] onMomentumScrollEnd — offsetY:${Math.round(contentOffset.y)} follow:${prev}→${wasNearBottom.current} netDelta:${Math.round(netDelta)} userSwipedUp:${userSwipedUp} nearBottom:${nearBottom} isStreaming:${isStreamingRef.current}`);
    }
  }, []);

  const handleScrollToBottom = useCallback(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
    // User explicitly asked to return to bottom — clear all gesture state
    isUserGesturing.current = false;
    if (dragEndTimeout.current) {
      clearTimeout(dragEndTimeout.current);
      dragEndTimeout.current = null;
    }
    wasNearBottom.current = true;
    setShowScrollToBottom(false);
  }, []);

  const handleContentSizeChange = useCallback((_w: number, h: number) => {
    const prev = prevContentHeight.current;
    prevContentHeight.current = h;

    if (prev === 0) {
      logger.debug('BubbleDebug', 'contentSize prev=0 — SKIP (session init)');
      return;
    }
    const diff = h - prev;
    // diff<=0 early-exit: normally a net content shrink (TypingIndicator
    // removed) needs no scroll action. BUT during an active post-send burst,
    // the TypingIndicator removal happens concurrently with the real bubble
    // appearing — each fires its own contentSize event, and the shrink event
    // may arrive AFTER the growth event, leaving the scroll position stale.
    // Skip the early-exit during burst so the burst's scrollToEnd can correct.
    if (diff <= 0 && !scrollBurstRef.current) {
      logger.debug('BubbleDebug', `contentSize diff=${Math.round(diff)}<=0 — SKIP (net shrink: TypingIndicator removed?)`);
      return;
    }

    let action = 'no-op';
    if (loadingMoreScrollAdjust.current) {
      // Set suppress flag so Plan 5 in handleScroll doesn't counter-scroll
      // this legitimate anchor adjustment. loadMore adds diff px at the top;
      // the resulting scrollTo({y: diff}) looks like a large forward jump.
      // Without this guard, Plan 5 would snap the user back to y=0.
      suppressRogueCounter.current = true;
      scrollViewRef.current?.scrollTo({ y: diff, animated: false });
      loadingMoreScrollAdjust.current = false;
      action = 'loadMore-anchor';
    } else if (wasNearBottom.current && !isUserGesturing.current) {
      // Streaming content grew at bottom and user was near bottom → follow
      // to bottom. The isUserGesturing guard closes the race window between
      // onScrollBeginDrag (sets isUserGesturing=true) and the first onScroll
      // tick that flips wasNearBottom to false. Without it, a content-growth
      // event arriving in that gap would yank the user back to bottom.
      scrollViewRef.current?.scrollToEnd({ animated: false });
      action = 'follow';
    }
    // Otherwise: content grew but user scrolled up → don't interfere.
    //
    // NOTE: The previous "post-stream-stale-fix" branch that trusted
    // lastNearBottom to override wasNearBottom=false has been REMOVED.
    // After the shouldResumeFollow fix (round 11), wasNearBottom=false is
    // ONLY ever set by genuine user upward swipes — never stale. So if
    // wasNearBottom is false, the user actively scrolled up and their
    // position must be respected, even if they stopped within 100px of
    // the bottom (lastNearBottom=true). The old branch caused a visible
    // "twitch" at stream end: StreamingBubble→ChatBubble replacement fired
    // contentSize change, which forced scrollToEnd and yanked the user
    // back to bottom despite their upward swipe.
    logger.debug(
      'BubbleDebug',
      `contentSize prev:${Math.round(prev)} new:${Math.round(h)} diff:${Math.round(diff)} wasNearBottom:${wasNearBottom.current} isGesturing:${isUserGesturing.current} isStreaming:${isStreamingRef.current} burstActive:${scrollBurstRef.current !== null} → ${action}`,
    );
  }, []);

  // Extracted as useCallback so the reference is stable across renders. An
  // inline arrow here would create a NEW function every render, busting
  // ChatBubble's React.memo (shallow prop compare) and re-rendering every
  // bubble on each streaming token — exactly the JS-thread storm we fixed.
  // Deps: [currentSessionId] — wsService is a stable module singleton.
  const handleMcpToolCall = useCallback(
    (params: McpToolCallPayload) => {
      if (!currentSessionId) return;
      wsService.sendMcpToolCall(
        currentSessionId,
        params.toolCallId,
        params.toolName,
        params.args,
        params.responseId,
      );
    },
    [currentSessionId],
  );

  const handleSend = (text: string, blocks?: WsContentBlock[]) => {
    if (!currentSessionId) return;

    // ── Cancel-then-send queue (v19) ──
    // If a stream is in-flight, we MUST NOT send a new message directly —
    // late-arriving tokens from the old stream would corrupt the new
    // bubble's content (m_old's text-delta would land in m_new because
    // useStreamingStore.messageId is overwritten in start()).
    //
    // Strict-serial protocol:
    //   1. Park the message in pendingSendAfterCancel (UI shows only the
    //      TypingIndicator — no original text, no preview).
    //   2. Tell the store to cancel the old stream and wait for cancel-ack.
    //   3. Return early. ChatInputBar already cleared its local inputText
    //      before calling onSend (see ChatInputBar.handleSend line 124),
    //      so the user sees an empty input + disabled send button.
    //   4. When cancel-ack arrives (or 15s timeout fires), the store's
    //      flushPendingSendAfterCancel() routes the queued message through
    //      sendMessage normally.
    if (isStreaming) {
      setPendingSendAfterCancel({ text, blocks: blocks ?? null });
      cancelStream();
      return;
    }

    // User is sending a message → resume auto-follow so the streaming
    // response scrolls into view via handleContentSizeChange. Without
    // this, if the user scrolled up then sent a message, wasNearBottom
    // would stay false and the view would never follow the new response.
    isUserGesturing.current = false;
    if (dragEndTimeout.current) {
      clearTimeout(dragEndTimeout.current);
      dragEndTimeout.current = null;
    }
    wasNearBottom.current = true;

    // Voice message: pendingAudioUri is set by ChatInputBar.stopRecording.
    // Also handles voice + attachments: blocks may contain uploaded attachments
    // that should be sent alongside the transcribed text (Bug 1 fix).
    const state = useChatStore.getState();
    if (!text && state.pendingAudioUri) {
      const audioUri = state.pendingAudioUri;
      state.setPendingAudioUri(null);
      // Show TypingIndicator immediately AND chase its async layout via burst.
      // Without the burst here, the indicator's +39px contentSize growth lands
      // via a single handleContentSizeChange→scrollToEnd that reads stale
      // layoutMeasurement → the indicator shows only its top half. transcribeAudio
      // takes ~4s; we cannot wait until it completes to fire the burst.
      state.setPendingUserMessage(true);
      triggerScrollBurst();
      (async () => {
        try {
          const { transcribeAudio } = await import('@/services/voice-service');
          logger.debug('BubbleDebug', `[${ts()}] handleSend VOICE — transcribeAudio begin`);
          const transcribedText = (await transcribeAudio(audioUri)).trim();
          logger.debug('BubbleDebug', `[${ts()}] handleSend VOICE — transcribed: "${transcribedText.slice(0, 30)}${transcribedText.length > 30 ? '…' : ''}" (${transcribedText.length} chars)`);
          const s = useChatStore.getState();
          if (transcribedText) {
            // Combine transcribed text block with any attachment blocks
            const allBlocks: WsContentBlock[] = [
              { type: 'text', text: transcribedText },
              ...(blocks || []),
            ];
            // ── Voice concurrency guard ─────────────────────────────────
            // handleSend 入口的 isStreaming 检查是同步的，但 voice 路径是
            // async IIFE（transcribeAudio ~4s）。这 4s 内前一条消息可能
            // 已经 sendMessage 并把 isStreaming 置 true。此处必须重新检
            // 查，否则 streamingMessageId 会被覆盖，前一条的 AI token 会
            // 串到这一条的气泡（v19 race condition ①）。
            // JS 单线程 + Zustand set 同步 ⇒ IIFE1 的 set(isStreaming:true)
            // 必然在 IIFE2 此检查之前完成，TOCTOU 窗口为 0。
            if (s.isStreaming) {
              // 复用 text 路径的 cancel-then-send 队列：排队 → cancel 旧流
              // → 等 cancel-ack → flushPendingSendAfterCancel 自动 sendMessage
              setPendingSendAfterCancel({ text: transcribedText, blocks: allBlocks });
              cancelStream();
              triggerScrollBurst();
              return;
            }
            s.sendMessage(currentSessionId!, transcribedText, allBlocks);
            // Post-send scroll burst: chase async bubble layout (see
            // triggerScrollBurst doc). 10×/150ms catches markdown re-renders
            // and TypingIndicator-removal-induced contentSize jitter.
            triggerScrollBurst();
          } else if (blocks?.length) {
            // Transcription empty but attachments exist — send them.
            // Same concurrency guard as the text branch above.
            if (s.isStreaming) {
              setPendingSendAfterCancel({ text: '', blocks });
              cancelStream();
              triggerScrollBurst();
              return;
            }
            s.sendMessage(currentSessionId!, '', blocks);
            triggerScrollBurst();
          } else {
            // No text recognized and no attachments — don't send, show a
            // brief warning toast at the top of the screen. Matches 豆包's
            // "未识别到文字" feedback.
            s.setPendingUserMessage(false);
            useToastStore.getState().showToast({
              message: t('voiceOverlay.noTextRecognized'),
              variant: 'warning',
            });
          }
        } catch (err) {
          useChatStore.getState().setPendingUserMessage(false);
          logger.warn('ChatView', 'Voice transcription failed', err);
        }
      })();
      return;
    }

    sendMessage(currentSessionId, text, blocks);
    // Post-send scroll burst (see triggerScrollBurst doc).
    logger.debug('BubbleDebug', `[${ts()}] handleSend TEXT — sendMessage done, firing burst`);
    triggerScrollBurst();
  };

  return (
    <View className="flex-1 bg-aura-surface">
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        keyboardVerticalOffset={insets.top}
      >
        <ChatHeader
          onMenuPress={onMenuPress}
          rightIcon="play"
          isAutoPlay={isAutoPlay}
          onToggleAutoPlay={toggleAutoPlay}
          title={currentSession?.title || t('app.title')}
          onSharePress={currentSession ? handleHeaderShare : undefined}
          shareLabel={t('chatDrawer.share')}
        />

        {/* Scroll area wrapper — provides positioning context for the scroll-to-bottom button */}
        <View style={{ flex: 1, position: 'relative' }}>
        <ScrollView
          ref={scrollViewRef}
          className="flex-1 px-4 pt-4"
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          scrollEnabled={!isInputRecording}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          onScroll={handleScroll}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScrollEndDrag={handleScrollEndDrag}
          onMomentumScrollBegin={handleMomentumScrollBegin}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          onContentSizeChange={handleContentSizeChange}
          contentContainerStyle={{
            paddingBottom: 20,
            ...(isWeb
              ? { maxWidth: 600, alignSelf: 'center', width: '100%' }
              : {}),
          }}
        >
          <View className="gap-2 py-4">
            {/* Loading indicator at top when fetching older messages */}
            {isLoadingMore && (
              <View className="items-center py-2">
                <ActivityIndicator size="small" color="#1D4ED8" />
                <Text className="text-label-sm text-aura-outline mt-1">{t('chatView.loadingOlder')}</Text>
              </View>
            )}

            {/* Skeleton when messages for this session haven't been fetched yet.
                 Uses messagesNotLoaded (per-session) instead of isLoading (global)
                 to avoid the loadSessions/loadMessages race condition where
                 loadSessions finishing first prematurely hides the skeleton. */}
            {renderMessages.length === 0 && messagesNotLoaded && !isStreaming && (
              <MessageListSkeleton />
            )}

            {renderMessages.map((msg, idx) => (
              <ChatBubble
                key={msg.id}
                message={msg}
                isLastInGroup={groupMeta[idx]?.isLastInGroup ?? true}
                groupText={groupMeta[idx]?.groupText ?? ''}
                onMcpToolCall={handleMcpToolCall}
                onImagePress={handleConversationImagePress}
              />
            ))}

            {/* v3 Physical Isolation (Round-13): live streaming bubble.
                StreamingBubble subscribes to useStreamingStore directly
                inside its own memoized component, so ChatView no longer
                re-renders per WS token. Only this bubble reconciles on
                each text-delta; historical bubbles + ScrollView freeze.
                ChatBubble's internal isActiveStreaming check
                (useChatStore.streamingMessageId === message.id) still
                shows TypingDots and hides action buttons during the stream. */}
            <StreamingBubble onMcpToolCall={handleMcpToolCall} />

            {/* Pending indicator while user message is being uploaded */}
            {pendingUserMessage && <TypingIndicator variant="user" />}

            {/* v19 cancel-then-send: while we're waiting for the OLD stream's
                cancel-ack to land, show only a TypingIndicator (no preview of
                the queued text). The new bubble will appear normally once
                flushPendingSendAfterCancel() routes the message through
                sendMessage in the cancel-ack handler. */}
            {pendingSendAfterCancel && isWaitingForCancelAck && (
              <TypingIndicator variant="user" />
            )}
          </View>
        </ScrollView>

        {/* Scroll-to-bottom button — only visible when user has scrolled up
            and keyboard is hidden (no need to compete with the input bar). */}
        {showScrollToBottom && !isKeyboardVisible && (
          <Pressable
            onPress={handleScrollToBottom}
            accessibilityLabel="Scroll to bottom"
            hitSlop={4}
            style={{
              position: 'absolute',
              right: 16,
              bottom: 16,
              width: 40,
              height: 40,
              borderRadius: 20,
              backgroundColor: '#FFFFFF',
              alignItems: 'center',
              justifyContent: 'center',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.15,
              shadowRadius: 4,
              elevation: 4,
              borderWidth: 1,
              borderColor: 'rgba(124,58,237,0.15)',
            }}
          >
            <Ionicons name="chevron-down" size={22} color="#1D4ED8" />
          </Pressable>
        )}
        </View>

        <View
          style={{
            paddingBottom: isKeyboardVisible
              ? Platform.select({
                  android: Math.max(insets.bottom, 15),
                  default: 0,
                })
              : Platform.select({
                  ios: Math.max(insets.bottom, 30),
                  android: Math.max(insets.bottom, 30),
                  default: Math.max(insets.bottom, 30),
                }),
          }}
        >
          <ChatInputBar
            onSend={handleSend}
            isCreating={false}
            isSendingDisabled={isWaitingForCancelAck}
            onRecordingChange={setIsInputRecording}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
