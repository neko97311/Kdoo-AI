import React, { useMemo, memo } from 'react';
import { useStreamingStore } from '@/stores/streaming';
import { useChatStore } from '@/stores/chat';
import { ChatBubble } from './ChatBubble';
import type { ChatMessage, TextContent, McpToolCallPayload } from '@/types';

interface StreamingBubbleProps {
  onMcpToolCall?: (params: McpToolCallPayload) => void;
}

/**
 * ── Streaming Isolation Component ──────────────────────────────────
 *
 * ROOT CAUSE FIX (Round-13):
 * ChatView subscribed to 4 useStreamingStore selectors (messageId / content /
 * searchKeywords / sources). Every WS token (~100ms) caused the entire
 * ChatView to re-render:
 *   1. ChatView function body runs (re-creates inline arrows, all useMemos
 *      that DO change like streamingMessage/streamingGroupText)
 *   2. JSX tree for N historical ChatBubbles gets re-diffed (memo saves
 *      the actual re-render but the React reconciler still walks the tree)
 *   3. ScrollView itself re-renders, which on Android can briefly drop
 *      native events before the next token
 *
 * Combined with MarkdownRenderer's MarkdownIt.parse (O(text.length) on a
 * growing text) the JS thread saturates and native ScrollView events pile
 * up. When the JS thread recovers, React dispatches the queued events
 * synchronously → handleScroll fires nested setStates (setShowScrollToBottom
 * in particular) → Maximum update depth exceeded.
 *
 * (After migrating to react-native-nitro-markdown, parsing moved off the JS
 * thread entirely — md4c C++ over JSI, ~4× faster than MarkdownIt — so the
 * thread-saturation root cause is gone. The isolation here remains as a
 * belt-and-suspenders against future regressions.)
 *
 * FIX: subscribe to the 4 streaming-store fields HERE, in a tiny child
 * component. ChatView no longer re-renders per token — only StreamingBubble
 * does. Historical ChatBubbles remain frozen (memo).
 *
 * StreamingBubble itself wraps ChatBubble so the rendering path is
 * unchanged: ChatBubble's React.memo, mergedContent useMemo, MarkdownRenderer
 * pipeline all work identically. We just isolate the re-render scope.
 *
 * renderMessages.filter() at the ChatView level already excludes this
 * streaming message from the historical list, so there's no double render.
 */
function StreamingBubbleBase({ onMcpToolCall }: StreamingBubbleProps) {
  const streamingMessageId = useStreamingStore((s) => s.messageId);
  const streamingContent = useStreamingStore((s) => s.content);
  const streamingSearchKeywords = useStreamingStore((s) => s.searchKeywords);
  const streamingSources = useStreamingStore((s) => s.sources);
  const streamingVideoResults = useStreamingStore((s) => s.videoResults);
  const currentSessionId = useChatStore((s) => s.currentSessionId);

  // Build the synthetic message. We use `new Date(0)` so action buttons
  // (which key off createdAt) never render — the live bubble never shows
  // play/copy/time during streaming (isActiveStreaming guard hides them
  // in ChatBubble.tsx).
  const streamingMessage = useMemo<ChatMessage | null>(() => {
    if (!streamingMessageId) return null;
    return {
      id: streamingMessageId,
      sessionId: currentSessionId ?? '',
      role: 'assistant',
      content: streamingContent,
      createdAt: new Date(0),
      searchKeywords: streamingSearchKeywords,
      sources: streamingSources,
      videoResults: streamingVideoResults,
    };
  }, [streamingMessageId, streamingContent, streamingSearchKeywords, streamingSources, streamingVideoResults, currentSessionId]);

  // Aggregated plain text of the streaming content — used by ChatBubble's
  // copy action. Recomputed only when content array reference changes
  // (which happens every token, matching the previous ChatView behavior).
  const streamingGroupText = useMemo(() => {
    let text = '';
    for (const p of streamingContent) {
      if (p.type === 'text') {
        const t = (p as TextContent).text.trim();
        if (t) text += (text ? '\n' : '') + t;
      }
    }
    return text;
  }, [streamingContent]);

  if (!streamingMessage) return null;

  return (
    <ChatBubble
      key={`streaming-${streamingMessage.id}`}
      message={streamingMessage}
      isLastInGroup={true}
      groupText={streamingGroupText}
      onMcpToolCall={onMcpToolCall}
    />
  );
}

/**
 * React.memo: when the parent ChatView re-renders for any reason OTHER than
 * the 4 streaming selectors (e.g. sessionMessages updated, isStreaming
 * toggled, focus changed), the onMcpToolCall prop must be referentially
 * stable for this memo to skip work. ChatView declares handleMcpToolCall
 * via useCallback([currentSessionId]) — stable across tokens for the same
 * session.
 */
export const StreamingBubble = memo(StreamingBubbleBase);
