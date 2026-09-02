import React, { useMemo, useState, useCallback } from 'react';
import { View, Text, Pressable, Platform, Linking, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useTtsStore } from '@/stores/tts';
import { useStreamingStore, getStreamingSession } from '@/stores/streaming';
import * as Clipboard from 'expo-clipboard';
import type { ChatMessage, MessageContent, TextContent, FileContent, ReasoningContent, ToolInvocationContent, DataContent, McpToolCallPayload, SourceLink, CreationRefContent } from '@/types';
import type { MarkdownSession } from 'react-native-nitro-markdown';
import { CodeBlock } from './CodeBlock';
import { DataTable } from './DataTable';
import { ReasoningBlock } from './ReasoningBlock';
import { ToolInvocationCard } from './ToolInvocationCard';
import { MapToolRenderer } from './MapToolRenderer';
import { MyLocationToolRenderer } from './MyLocationToolRenderer';
import { NearbySearchToolRenderer } from './NearbySearchToolRenderer';
import { CallPhoneToolRenderer } from './CallPhoneToolRenderer';
import { GeneratingImagePlaceholder } from './GeneratingImagePlaceholder';
import { VideoCardList, type VideoResult } from './VideoCardList';
import { MusicCardList, type MusicResult } from './MusicCardList';
import { ImageCardList, type ImageResult } from './ImageCardList';
import { SearchMetaPanel } from './SearchMetaPanel';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ImageContent } from '@/components/chat/ImageContent';
import { VideoContent } from '@/components/chat/VideoContent';
import { TypingDots } from './TypingIndicator';
import { useI18n } from '@/hooks/useI18n';
import { formatFileSize } from '@/utils/attachments';
import { activateComposeSender } from '@/utils/photo-compose';
import { formatMessageTime } from '@/utils/time';

/**
 * Whitelist of tool names rendered as interactive cards in chat.
 * Tools not in this list are silently skipped during rendering.
 * txt2imageTool / textEditImageTool are handled separately above (progress placeholder only).
 */
const DISPLAYABLE_TOOLS = [
  'calculatorWithUI',
  'calculatorTool',
  'googleMapWithUI',
  'googleMapTool',
  'myLocationTool',
  'googleMyLocationWithUI',
  'nearbySearchTool',
  'googleNearbySearchWithUI',
];

/**
 * Extract video results array from a completed videoSearchTool output.
 * Returns null if output is missing, not an object, or has no results array.
 */
function extractVideoResults(tool: ToolInvocationContent): VideoResult[] | null {
  // App ToolInvocationContent uses `result` (not `output` like the AI SDK web type)
  const output = tool.result;
  if (!output || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;
  if (!('results' in record) || !Array.isArray(record.results)) return null;
  const arr = record.results as unknown[];
  if (arr.length === 0) return null;
  return arr.map((r) => {
    const item = r as Record<string, unknown>;
    return {
      title: String(item.title ?? ''),
      url: String(item.url ?? ''),
      thumbnail: item.thumbnail ? String(item.thumbnail) : undefined,
      duration: item.duration ? String(item.duration) : undefined,
      author: item.author ? String(item.author) : undefined,
      description: item.description ? String(item.description) : undefined,
      embedUrl: item.embedUrl ? String(item.embedUrl) : undefined,
      publishedDate: item.publishedDate ? String(item.publishedDate) : undefined,
    } as VideoResult;
  });
}

/**
 * Extract image results array from a completed imageSearchTool output.
 * Returns null if output is missing, not an object, or has no results array.
 */
function extractImageResults(tool: ToolInvocationContent): ImageResult[] | null {
  const output = tool.result;
  if (!output || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;
  if (!('results' in record) || !Array.isArray(record.results)) return null;
  const arr = record.results as unknown[];
  if (arr.length === 0) return null;
  return arr.map((r) => {
    const item = r as Record<string, unknown>;
    return {
      title: String(item.title ?? ''),
      url: String(item.url ?? ''),
      imageUrl: item.imageUrl ? String(item.imageUrl) : undefined,
      sourceDomain: item.sourceDomain ? String(item.sourceDomain) : undefined,
      description: item.description ? String(item.description) : undefined,
    } as ImageResult;
  });
}

/**
 * Extract music results array from a completed musicSearchTool output.
 * Returns null if output is missing, not an object, or has no results array.
 */
function extractMusicResults(tool: ToolInvocationContent): MusicResult[] | null {
  const output = tool.result;
  if (!output || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;
  if (!('results' in record) || !Array.isArray(record.results)) return null;
  const arr = record.results as unknown[];
  if (arr.length === 0) return null;
  return arr.map((r) => {
    const item = r as Record<string, unknown>;
    return {
      title: String(item.title ?? ''),
      url: String(item.url ?? ''),
      thumbnail: item.thumbnail ? String(item.thumbnail) : undefined,
      duration: item.duration ? String(item.duration) : undefined,
      author: item.author ? String(item.author) : undefined,
      description: item.description ? String(item.description) : undefined,
      publishedDate: item.publishedDate ? String(item.publishedDate) : undefined,
      previewUrl: item.previewUrl ? String(item.previewUrl) : undefined,
    } as MusicResult;
  });
}

interface ChatBubbleProps {
  message: ChatMessage;
  /** Whether this message is the last one in its role-group (turn). Determines
   *  whether action buttons (play/copy/time) are rendered. Defaults to true
   *  for standalone use without grouping. */
  isLastInGroup?: boolean;
  /** Aggregated plain text for the entire role-group this message belongs to.
   *  Used by copy/play actions so a multi-message AI turn copies/plays as one. */
  groupText?: string;
  onApproveTool?: (toolCallId: string) => void;
  onDenyTool?: (toolCallId: string) => void;
  onMcpToolCall?: (params: McpToolCallPayload) => void;
  /** External image-tap handler (e.g. conversation-wide gallery). When
   *  provided, replaces the internal per-message handleImagePress so
   *  swiping pages across ALL messages in the conversation, not just this
   *  one. Falls back to internal handler when undefined (standalone use). */
  onImagePress?: (uri: string) => void;
}

/** Build an authenticated image URI for OSS URLs (module-scoped so both
 *  renderContent and the messageImageUris tap-list share IDENTICAL output).
 *  - Relative paths resolve against EXPO_PUBLIC_API_URL
 *  - Full URLs are used as-is
 *  - token appended as query param since RN Image doesn't send cookies */
export function resolveAuthedImageUri(uri: string, authToken: string | null | undefined): string {
  if (!uri || uri.startsWith('data:')) return uri;
  let resolvedUri = uri;
  // Resolve relative OSS paths against env base URL
  if (uri.startsWith('/')) {
    const baseUrl = process.env.EXPO_PUBLIC_API_URL || '';
    resolvedUri = `${baseUrl}${uri}`;
  }
  // Replace server's internal host with env base URL if needed
  if (authToken) {
    const baseUrl = process.env.EXPO_PUBLIC_API_URL || '';
    if (baseUrl && resolvedUri.includes('/api/user/v1/oss/')) {
      try {
        const parsed = new URL(resolvedUri);
        const envParsed = new URL(baseUrl);
        if (parsed.host !== envParsed.host) {
          parsed.protocol = envParsed.protocol;
          parsed.host = envParsed.host;
          resolvedUri = parsed.toString();
        }
      } catch { }
    }
  }
  if (authToken && !resolvedUri.includes('token=')) {
    // Only append the auth token to INTERNAL OSS API URLs (which need it).
    // External presigned URLs (e.g. https://oss.kdoo.ai/...?X-Amz-Signature=...)
    // MUST pass through unchanged — adding any param breaks the S3 signature
    // and the resource fails to load/play.
    const isExternal = /^https?:\/\//.test(resolvedUri) && !resolvedUri.includes('/api/user/v1/oss/');
    if (!isExternal) {
      const sep = resolvedUri.includes('?') ? '&' : '?';
      resolvedUri = `${resolvedUri}${sep}token=${encodeURIComponent(authToken)}`;
    }
  }
  return resolvedUri;
}

function renderContent(
  content: MessageContent[],
  isUser: boolean,
  onApproveTool?: (toolCallId: string) => void,
  onDenyTool?: (toolCallId: string) => void,
  authToken?: string | null,
  onImagePress?: (uri: string) => void,
  onMcpToolCall?: (params: McpToolCallPayload) => void,
  sources?: SourceLink[],
  /**
   * Per-messageId native MarkdownSession (react-native-nitro-markdown
   * HybridObject). Undefined for non-streaming messages — MarkdownRenderer
   * falls back to static `<Markdown>{text}</Markdown>` rendering in that
   * case. Pass-through getter (not the session itself) so we don't create
   * a new prop reference on every render.
   */
  getMarkdownSession?: () => MarkdownSession | undefined,
  /** Chat session ID — threaded to MusicCardList for notification navigation. */
  sessionId?: string,
  /** Whether music search results in this message should auto-play on
   *  arrival. Caller passes `isActiveStreaming` - only fresh (still-
   *  streaming) assistant messages trigger music auto-play. Named
   *  `autoPlayOnArrival` (NOT `autoPlay`) to avoid conflation with the
   *  unrelated `chatSetting.autoPlay` TTS toggle in the auth store. */
  autoPlayOnArrival?: boolean,
  /** Message creation time - threaded to CallPhoneToolRenderer for its
   *  30s history guard (auto-dial only fires for fresh arrivals). */
  messageCreatedAt?: Date | string,
) {
  // textColor removed — use className="text-aura-on-surface" instead

  /** Build an authenticated Image source for OSS URLs (thin wrapper over the
   *  module-scoped resolveAuthedImageUri so render + tap-list stay in sync). */
  const authImageSource = (uri: string) => ({ uri: resolveAuthedImageUri(uri, authToken) });

  return content.map((item, idx) => {
    switch (item.type) {
      case 'text':
        // User messages are plain text (no markdown).
        if (isUser) {
          return (
            <Text
              key={idx}
              className="text-body-md leading-6 text-aura-on-surface"
              selectable
            >
              {item.text}
            </Text>
          );
        }
        // Assistant text: markdown rendering
        const textStyle = idx > 0 ? { marginTop: 8 } : undefined;
        // v18d: when this bubble is the active stream, pass the per-messageId
        // native session so MarkdownRenderer can use <MarkdownStream> with
        // RAF-throttled incremental parsing. Non-streaming messages pass
        // undefined → static <Markdown> path (zero native overhead).
        const session = getMarkdownSession?.();
        return (
          <MarkdownRenderer
            key={idx}
            text={item.text}
            style={textStyle}
            sources={sources}
            session={session}
          />
        );
      case 'image': {
        const imgSrc = authImageSource(item.uri || item.data || '');
        const imgUri = typeof imgSrc === 'object' ? imgSrc.uri : imgSrc;
        return (
          <View key={idx} style={idx > 0 ? { marginTop: 8 } : undefined}>
            <ImageContent uri={imgUri} alt={item.alt} onPress={onImagePress} />
          </View>
        );
      }
      case 'file': {
        const fileItem = item as FileContent;
        const fileDataUrl = fileItem.data || fileItem.uri;
        // Image MIME type → render as inline image preview
        if (fileItem.mediaType?.startsWith('image/')) {
          const fileImgSrc = authImageSource(fileDataUrl || '');
          const fileImgUri = typeof fileImgSrc === 'object' ? fileImgSrc.uri : fileImgSrc;
          return <ImageContent key={idx} uri={fileImgUri} alt={fileItem.name} onPress={onImagePress} maxWidth={150} />;
        }
        // Video MIME type → inline player (AI-creation completion video).
        // posterUrl (first-frame cover from the creation pipeline) becomes the
        // player poster so the bubble never shows a black frame while loading.
        if (fileItem.mediaType?.startsWith('video/')) {
          return (
            <VideoContent
              key={idx}
              uri={resolveAuthedImageUri(fileDataUrl || '', authToken)}
              posterUri={fileItem.posterUrl ? resolveAuthedImageUri(fileItem.posterUrl, authToken) : undefined}
            />
          );
        }
        // Non-image/video file → render as clickable link card
        return (
          <Pressable
            key={idx}
            className="flex-row items-center gap-3 rounded-card p-3 mt-1 border border-aura-outline-variant dark:border-white/10 bg-aura-surface-container"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              padding: 12,
              marginTop: 4,
              borderRadius: 8,
              borderWidth: 1,
              minWidth: 200,
            }}
            onPress={() => {
              if (fileDataUrl) {
                Linking.openURL(fileDataUrl).catch(() => { });
              }
            }}
          >
            <View style={{ width: 40, height: 40, borderRadius: 8, backgroundColor: '#EDE9FE', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons
                name={getFileIconName(fileItem.mediaType || '') as any}
                size={20}
                className="text-aura-primary"
              />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text className="text-label-sm font-semibold text-aura-on-surface" numberOfLines={1} style={{ fontSize: 14 }}>
                {fileItem.name}
              </Text>
              {fileItem.size ? (
                <Text className="text-label-xs text-aura-outline">
                  {formatFileSize(fileItem.size)}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      }
      case 'code':
        return (
          <View key={idx} className="mt-2">
            <CodeBlock language={item.language} code={item.code} />
          </View>
        );
      case 'table':
        return (
          <View key={idx} className="mt-2">
            <DataTable headers={item.headers} rows={item.rows} title={item.title} />
          </View>
        );
      case 'reasoning':
        return (
          <ReasoningBlock key={idx} content={item as ReasoningContent} />
        );
      // creation-ref is rendered at the very top of the bubble (extracted in
      // ChatBubbleBase); skip it here to avoid duplication.
      case 'creation-ref':
        return null;
      case 'tool-invocation': {
        const toolContent = item as ToolInvocationContent;
        const rawName = typeof toolContent.toolName === 'string'
          ? toolContent.toolName
          : String((toolContent.toolName as any)?.name ?? '');

        // txt2imageTool / textEditImageTool: render animated image-sized
        // placeholder (3:2) with centered percentage while the image is being
        // generated/edited. The final image is appended as a separate image
        // content part on tool-result.
        if (rawName === 'txt2imageTool' || rawName === 'textEditImageTool') {
          const p = toolContent.progress;
          if (p && p.max > 0) {
            const pct = Math.min(100, Math.round((p.value / p.max) * 100));
            return <GeneratingImagePlaceholder key={idx} percent={pct} />;
          }
          // No progress (or already completed) — don't render the card,
          // the image content part handles the result display.
          return null;
        }

        // videoSearchTool: render vertical video card list on completion.
        // Shows first 3 items with expand-to-all; YouTube videos open in-app.
        if (rawName === 'video_search' || rawName === 'videoSearchTool') {
          const videos = extractVideoResults(toolContent);
          if (videos) {
            return <VideoCardList key={idx} results={videos} />;
          }
          return null;
        }

        // musicSearchTool: render vertical music card list on completion.
        // Tapping a track opens the phone's default music player (external app).
        if (rawName === 'music_search' || rawName === 'musicSearchTool') {
          const tracks = extractMusicResults(toolContent);
          if (tracks) {
            return (
              <MusicCardList
                key={idx}
                results={tracks}
                sessionId={sessionId}
                autoPlayOnArrival={autoPlayOnArrival}
              />
            );
          }
          return null;
        }

        // imageSearchTool: render vertical image card list on completion.
        // Tapping a card opens the source page in the system browser.
        if (rawName === 'image_search' || rawName === 'imageSearchTool') {
          const images = extractImageResults(toolContent);
          if (images) {
            return <ImageCardList key={idx} results={images} />;
          }
          return null;
        }

        // Call tool — client-executed: the card dials the number passed by
        // the agent once on arrival (Android auto-call, iOS system confirm).
        if (rawName === 'callPhoneTool' || rawName === 'call_phone') {
          return <CallPhoneToolRenderer key={idx} content={toolContent} messageCreatedAt={messageCreatedAt} />;
        }

        // Filter: only render whitelisted tools as interactive cards.
        // Non-whitelisted tool invocations are hidden from the UI.
        if (!DISPLAYABLE_TOOLS.includes(rawName)) {
          return null;
        }
        // Map tool — render as compact preview card + full-screen Modal.
        // Inline McpWebView at 280x420 was too cramped: Start Navigation
        // button got clipped and the GPS handshake never completed.
        if (rawName === 'googleMapTool' || rawName === 'googleMapWithUI') {
          return (
            <MapToolRenderer
              key={toolContent.toolCallId ?? idx}
              content={toolContent}
              onMcpToolCall={onMcpToolCall}
            />
          );
        }
        // My Location tool — dedicated renderer with reverse-geocoded
        // address preview + open-in-maps shortcut. Routed here (not to
        // ToolInvocationCard) so the preview card gets the full bubble
        // width and a tappable mini-map banner.
        if (
          rawName === 'myLocationTool' ||
          rawName === 'googleMyLocationWithUI'
        ) {
          return (
            <MyLocationToolRenderer
              key={toolContent.toolCallId ?? idx}
              content={toolContent}
              onMcpToolCall={onMcpToolCall}
            />
          );
        }
        // Nearby Search tool — dedicated renderer with POI count preview
        // + navigate-to-first-result shortcut. The HTML auto-selects the
        // first POI; this preview surfaces a one-tap nav shortcut.
        if (
          rawName === 'nearbySearchTool' ||
          rawName === 'googleNearbySearchWithUI'
        ) {
          return (
            <NearbySearchToolRenderer
              key={toolContent.toolCallId ?? idx}
              content={toolContent}
              onMcpToolCall={onMcpToolCall}
            />
          );
        }
        return (
          <ToolInvocationCard
            key={idx}
            content={toolContent}
            onApprove={onApproveTool}
            onDeny={onDenyTool}
            onMcpToolCall={onMcpToolCall}
          />
        );
      }
      case 'data': {
        const dataContent = item as DataContent;
        return (
          <View key={idx} className="mt-1.5 rounded-card border border-aura-outline-variant/40 p-3">
            <View className="flex-row items-center gap-2 mb-1">
              <Ionicons name="server-outline" size={14} className="text-aura-outline" />
              <Text className="text-label-xs font-medium text-aura-outline uppercase">
                {dataContent.dataType}
              </Text>
            </View>
            <Text className="text-body-sm font-mono text-aura-on-surface" selectable>
              {typeof dataContent.data === 'object'
                ? JSON.stringify(dataContent.data, null, 2)
                : String(dataContent.data ?? '')}
            </Text>
          </View>
        );
      }
    }
  });
}

// ─── File display helpers ────────────────────────────────────

function getFileIconName(mime: string): string {
  if (mime.startsWith('image/')) return 'image-outline';
  if (mime.startsWith('video/')) return 'videocam-outline';
  if (mime.startsWith('audio/')) return 'musical-notes-outline';
  if (mime.includes('pdf')) return 'document-text-outline';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar')) return 'archive-outline';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) return 'grid-outline';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'easel-outline';
  if (mime.includes('word') || mime.includes('document')) return 'document-text-outline';
  return 'document-outline';
}

function ChatBubbleBase({
  message,
  isLastInGroup = true,
  groupText,
  onApproveTool,
  onDenyTool,
  onMcpToolCall,
  onImagePress,
}: ChatBubbleProps) {
  const isUser = message.role === 'user';

  // Fixed-pixel maxWidth avoids percentage-in-nested-flex measurement
  // ambiguity on Android's Yoga engine, where '90%' inside a non-stretch
  // child can be miscalculated, causing text to wrap before the bubble
  // reaches its full width. ScrollView content area = windowWidth - 32
  // (px-4 sides); capped at 600 for web's centered layout.
  const { width: windowWidth } = useWindowDimensions();
  const maxBubbleWidth = Math.floor(Math.min(windowWidth - 32, 600) * 0.9);

  const authToken = useAuthStore((s) => s.token);
  const router = useRouter();
  const { t } = useI18n();

  /** AI-creation completion message (backend marks metadata.source). Rendered
   *  with the user-request reference at top, a localized "video is ready"
   *  header, the inline video — and WITHOUT the copy/play action row. */
  const isCreationComplete =
    (message.metadata as { source?: string } | undefined)?.source === 'creation-complete';

  /** Failed video generation message — plain text, no action bar. */
  const isCreationFailed =
    (message.metadata as { source?: string } | undefined)?.source === 'creation-failed';

  /** Localized header text — backend sends it (matches the user's language);
   *  when absent, detect the language from the request reference text so a
   *  Chinese conversation never gets an English header. */
  const readyText = (() => {
    const backend = (message.metadata as { readyText?: string } | undefined)?.readyText;
    if (backend && backend.trim()) return backend;
    const ref = message.content.find((c) => c.type === 'creation-ref') as CreationRefContent | undefined;
    const text = ref?.text ?? '';
    if (/[\u4e00-\u9fff]/.test(text)) return '你的视频生成好了';
    if (/[àâãáéêíóôõúüç]/i.test(text)) return 'O seu vídeo está pronto';
    return t('chat.message.videoReady');
  })();

  /**
   * Merge consecutive text parts into a single text entry.
   * Prevents multi-step responses from rendering as separate markdown blocks.
   * Similar to the reference project's `mergedParts` computed.
   */
  const mergedContent = useMemo(() => {
    const merged: MessageContent[] = [];
    for (const item of message.content) {
      if (item.type === 'text') {
        const last = merged[merged.length - 1];
        if (last && last.type === 'text' && message.role != 'user') {
          merged[merged.length - 1] = {
            ...last,
            text: (last as TextContent).text + (item as TextContent).text,
            state: (item as TextContent).state ?? (last as TextContent).state,
          } as TextContent;
        } else {
          merged.push({ ...item });
        }
      } else if (item.type === 'reasoning') {
        const last = merged[merged.length - 1];
        if (last && last.type === 'reasoning') {
          merged[merged.length - 1] = {
            ...last,
            text: (last as ReasoningContent).text + (item as ReasoningContent).text,
            state: (item as ReasoningContent).state ?? (last as ReasoningContent).state,
          } as ReasoningContent;
        } else {
          merged.push({ ...item });
        }
      } else {
        merged.push({ ...item });
      }
    }
    return merged;
  }, [message.content]);

  /** The user's own request text (rendered as a quote at the very top). */
  const creationRefText = (() => {
    const ref = mergedContent.find((c) => c.type === 'creation-ref') as CreationRefContent | undefined;
    return ref?.text ?? '';
  })();

  /** This message's full previewable-image list (tokenized absolute URLs), in
   *  render order — tapping any one of them navigates to photo-compose with
   *  ALL of them pre-loaded so the viewer pages across the whole message.
   *  Shares resolveAuthedImageUri with renderContent (byte-identical output),
   *  so handleImagePress's indexOf(uri) is exactly the render-order index.
   *  Pushes even empty resolved URIs to stay index-aligned with rendering. */
  const messageImageUris = useMemo(() => {
    const uris: string[] = [];
    for (const item of mergedContent) {
      if (item.type === 'image') {
        uris.push(resolveAuthedImageUri(item.uri || item.data || '', authToken));
      } else if (item.type === 'file' && (item.mediaType ?? '').startsWith('image/')) {
        uris.push(resolveAuthedImageUri(item.data || item.uri || '', authToken));
      }
    }
    return uris;
  }, [mergedContent, authToken]);

  /**
   * Detect if this message is the one currently being streamed.
   * During streaming, action buttons below THIS message are hidden;
   * historical (already completed) messages keep their action row.
   */
  const storeStreamingId = useChatStore((s) => s.streamingMessageId);

  /** This specific message is the one actively being streamed. */
  const isActiveStreaming = storeStreamingId === message.id;

  // ── v18d 方案 B: per-messageId native MarkdownSession lookup ────────────
  // The session lives in a module-level Map owned by stores/streaming.ts.
  // We DO NOT subscribe directly to the Map from a Zustand selector — Map
  // references would change on every store mutation, and any identity change
  // would re-mount <MarkdownStream>, blowing away its listener subscription
  // and re-parsing the entire accumulated text.
  //
  // Instead we subscribe to a STABLE boolean ("does this messageId have a
  // session right now?") and look up the actual HybridObject on each render
  // via the exported `getStreamingSession` accessor (which reads the module-
  // scoped Map non-reactively). This gives us:
  //   - selector returns boolean → same identity across renders → no re-mount
  //   - getMarkdownSession always returns the live HybridObject (or undefined)
  //   - ChatBubble's React.memo on equality of `message` still works because
  //     the boolean selector changes only when stream-active state flips
  const hasActiveSession = useStreamingStore(
    // Iron rule v18p: StreamingState exposes `messageId`, not `isStreaming`.
    // The boolean "this message is the one currently streaming" is
    // `state.messageId === message.id`. We still gate on `storeStreamingId`
    // first as a cheap short-circuit — when the global stream is for a
    // DIFFERENT message (or idle), we never touch the streaming store at all.
    (s) => (storeStreamingId === message.id ? s.messageId === message.id : false),
  );
  const getMarkdownSession = useCallback((): MarkdownSession | undefined => {
    if (!hasActiveSession) return undefined;
    return getStreamingSession(message.id);
  }, [hasActiveSession, message.id]);

  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    // Prefer groupText (aggregated across the entire turn group) so that
    // a multi-message AI response copies as a single block.
    const text = groupText ?? mergedContent
      .filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text.trim())
      .filter(Boolean)
      .join('\n');
    if (!text) return;
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn('[ChatBubble] Copy failed:', err);
    }
  }, [groupText, mergedContent]);

  // ─── TTS playback ───────────────────────────────────────
  const ttsPlayingId = useTtsStore((s) => s.currentlyPlayingId);
  const ttsIsPlaying = useTtsStore((s) => s.isPlaying);
  const ttsIsLoading = useTtsStore((s) => s.isLoading);
  const ttsPlayVoice = useTtsStore((s) => s.playVoice);

  // Text used for TTS playback. When part of a turn group, use the
  // aggregated groupText so the whole turn is read as one utterance.
  const actionText = useMemo(() => {
    if (groupText != null) return groupText;
    return mergedContent
      .filter((c): c is TextContent => c.type === 'text')
      .map((c) => c.text.trim())
      .filter(Boolean)
      .join('\n');
  }, [groupText, mergedContent]);

  const isThisTtsLoading = ttsPlayingId === message.id && ttsIsLoading;
  const isThisTtsPlaying = ttsPlayingId === message.id && ttsIsPlaying;

  const handlePlayVoice = useCallback(() => {
    ttsPlayVoice(actionText, message.id);
  }, [ttsPlayVoice, actionText, message.id]);

  // ── v13: stabilize the image-tap callback ──
  // An inline `(uri) => …` arrow creates a new reference on every render.
  // During WS streaming, ChatBubble re-renders on every token, so a new
  // reference would flow into `renderContent` → MarkdownRenderer subtree,
  // busting memoization and forcing a full Markdown re-parse each token.
  // A stable reference lets memo'd children skip unnecessary re-renders.
  //
  // Tapping an inline chat image opens the photo-compose page (image on top,
  // caption bar + send below) — NOT a fullscreen viewer — pre-loaded with ALL
  // images of this message and the tapped one as the starting page, so the
  // compose viewer's existing horizontal paging covers the whole message.
  // Send there attaches the images + text back into THIS conversation via the
  // persistent compose sender (ChatInputBar registers it on mount; we activate
  // it right before push so emitComposeResult has a live one-shot handler). The
  // uris are already tokenized by authImageSource, so zoom/save/send work off
  // them directly.
  const handleImagePress = useCallback(
    (uri: string) => {
      const index = messageImageUris.indexOf(uri); // 点的是第几张
      const list = index >= 0 ? messageImageUris : [uri]; // 理论上不会 <0,兜底
      const start = Math.max(0, index);
      const attachments = list.map((u, i) => ({
        id: `chat-img-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'image' as const,
        name: list.length > 1 ? `image-${i + 1}.jpg` : 'image.jpg',
        uri: u,
        mediaType: 'image/jpeg',
      }));
      activateComposeSender();
      router.push({
        pathname: '/photo-compose',
        params: { initial: JSON.stringify(attachments), initialIndex: String(start) },
      });
    },
    [router, messageImageUris],
  );

  if (isUser) {
    // Route-1: client UUID is the final id (server upsert is idempotent),
    // so the user message is durable the moment it is added to state.
    // Render the real content immediately — no "..." placeholder phase.
    return (
      <View className="flex-col items-end gap-0.5 self-end" style={{ maxWidth: maxBubbleWidth }}>
        <View
          className="bg-[#E8F3FF] dark:bg-[#1a2a3e] px-4 py-2"
          style={{
            borderRadius: 8,
            borderTopRightRadius: 2,
            borderWidth: 1,
            borderColor: 'rgba(22,119,255,0.15)',
            // minWidth:0 guards against long unbreakable strings pushing
            // past the 90% max-w cap on the parent. No flexShrink — it
            // starved the width baseline and caused premature wrapping.
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          {renderContent(mergedContent, true, onApproveTool, onDenyTool, authToken, onImagePress ?? handleImagePress, onMcpToolCall)}
        </View>
        {isLastInGroup && message.createdAt && (
          <Text className="text-label-sm text-aura-outline font-mono px-1">
            {formatMessageTime(message.createdAt)}
          </Text>
        )}
      </View>
    );
  }

  // AI bubble width strategy (固定 width + stretch 链):
  //
  // nitro-markdown 是原生组件,内部 Text 在 Yoga 测量阶段需要一个确定的
  // 数字宽度才能正确计算换行点。此前用 `maxWidth` + `alignSelf: flex-start`
  // 的方案不可行:alignSelf flex-start 让 bubble 根据内容测量自身宽度,而
  // 内容(原生 Markdown)又依赖父级的宽度约束 → 循环依赖,原生 Markdown
  // 回退到偏小默认宽度,文本没到最大宽度就提前换行。
  //
  // 修复:外层 View 固定 `width: maxBubbleWidth`,内层 bubble 不设
  // alignSelf(默认 stretch 占满父级 width)。这样 Yoga 宽度约束链:
  //   外层固定 width → bubble stretch → MarkdownRenderer stretch
  //   → 原生 Markdown 拿到确定 width → 文本在正确位置换行。
  //
  // 短消息(如"好的")的气泡背景会占满 maxBubbleWidth 宽度,这与
  // ChatGPT 等 app 的 AI 消息气泡行为一致,可接受。
  //
  // 当没有文本内容(只有 TypingDots "..." 或 reasoning)时不设 width,
  // 气泡自动缩到最窄内容。
  // Any visible content block (text / image / file / code / table / data /
  // tool-invocation) needs the fixed width so it lays out fully. Empty
  // content only occurs while a stream is starting (TypingDots) — there the
  // bubble should stay narrow and auto-size. This single check replaces the
  // previous per-type hasTextContent / hasVideoContent / hasMusicContent /
  // hasImageContent flags: video/music/image tool cards are content blocks,
  // so mergedContent.length > 0 already covers every one of them.
  const hasAnyContent = mergedContent.length > 0;

  // Search-meta-only messages: interrupted streams can commit a message whose
  // `content` is EMPTY (data-search-keywords / data-search-results parts are
  // extracted into message.searchKeywords / message.sources and skipped in
  // apiMessageToChatMessage) but which still renders a SearchMetaPanel. Those
  // messages have mergedContent.length === 0, so hasAnyContent misses them —
  // without this flag the bubble shrinks to the SearchMetaPanel width and
  // every reference row wraps at the same narrow column. Treat any message
  // carrying keywords/sources as needing the fixed width too. This is
  // deterministic (the persisted content has no text part), so it applies
  // identically during streaming, after API reload, and after SQLite hydrate.
  const hasSearchMeta = (message.searchKeywords?.length ?? 0) > 0 ||
    (message.sources?.length ?? 0) > 0;

  // MCP interactive tools (maps, calculators) render an iframe that needs
  // the full bubble width to display the map canvas and action buttons
  // legibly. Without this, a pure MCP tool message (no text part) lets the
  // bubble collapse to ~280px, clipping the Open-in-Maps button label and
  // squeezing the map tiles into an unreadable strip.

  // Inline video content (AI-creation completion video). Such messages
  // must NOT show the copy/play action row — the video already carries its
  // own playback. Detected from the file part's mediaType (robust even when
  // the backend's metadata.source isn't preserved by the app pipeline).
  const hasInlineVideo = mergedContent.some((c) => {
    const cc = c as { mediaType?: string; dataType?: string };
    return (c.type === 'file' && typeof cc.mediaType === 'string' && cc.mediaType.startsWith('video/')) ||
      (c.type === 'data' && typeof cc.dataType === 'string' && cc.dataType.startsWith('video/'));
  });

  // Check if image generation/editing is in progress (txt2imageTool /
  // textEditImageTool with active progress). When true, hide TypingDots "..."
  // — the animated placeholder already indicates loading.
  const hasGeneratingImage = mergedContent.some(
    (c) => c.type === 'tool-invocation' &&
      ((c as ToolInvocationContent).toolName === 'txt2imageTool' ||
        (c as ToolInvocationContent).toolName === 'textEditImageTool') &&
      !!(c as ToolInvocationContent).progress,
  );

  return (
    <View
      className="flex-col self-start gap-0.5"
      style={{
        ...((hasAnyContent || hasSearchMeta) ? { width: maxBubbleWidth } : {}),
      }}
    >
      <View
        className="bg-aura-surface-container px-4 py-2"
        style={{
          borderRadius: 8,
          borderTopLeftRadius: 2,
          borderWidth: 1,
          borderColor: 'rgba(124,58,237,0.12)',
          // 不设 alignSelf: bubble 默认 stretch 占满外层固定 width。
          // minWidth:0 允许收缩到任意窄度以容纳长不可断字符串(URL/代码)。
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {/* Search meta panel — collapsible keywords + sources toggle.
            Per design doc 4.4: message-level metadata, assistant role only.
            Placed ABOVE the answer content so the search context is visible
            before reading the response. Default collapsed; toggle shows
            "N keywords · M results" summary. Renders only when there is
            something to show (keywords, sources, or loading state). */}
        <SearchMetaPanel
          keywords={message.searchKeywords ?? []}
          sources={message.sources ?? []}
          loading={isActiveStreaming && (!message.sources || message.sources.length === 0) && !!(message.searchKeywords && message.searchKeywords.length > 0)}
        />
        {message.videoResults && message.videoResults.length > 0 && (
          <View style={{ marginTop: 8, marginBottom: 4 }}>
            <VideoCardList results={message.videoResults} />
          </View>
        )}
        {/* Doubao-style reference quote at the VERY TOP (the user's request) */}
        {creationRefText ? (
          <View
            className="flex-row items-center gap-2 rounded-card px-3 py-1.5"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 10,
              paddingVertical: 6,
              marginBottom: 6,
              borderLeftWidth: 3,
              borderLeftColor: '#757575',
              borderRadius: 6,
              backgroundColor: 'rgba(0,0,0,0.04)',
            }}
          >
            <Ionicons name="chatbubble-ellipses-outline" size={14} color="#86909C" />
            <Text
              className="text-label-sm text-aura-outline"
              style={{ fontSize: 12, flex: 1 }}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {creationRefText}
            </Text>
          </View>
        ) : null}
        {/* Doubao-style "video is ready" header for the AI-creation completion message */}
        {isCreationComplete ? (
          <Text className="text-body-md font-medium text-aura-on-surface" style={{ marginBottom: 4 }}>
            {readyText}
          </Text>
        ) : null}
        {renderContent(mergedContent, false, onApproveTool, onDenyTool, authToken, onImagePress ?? handleImagePress, onMcpToolCall, message.sources, getMarkdownSession, message.sessionId, isActiveStreaming, message.createdAt)}
        {isActiveStreaming && !hasGeneratingImage && (
          <View style={{ marginTop: mergedContent.length > 0 ? 6 : 0, paddingVertical: 4 }}>
            <TypingDots color="#1D4ED8" />
          </View>
        )}
      </View>
      {/* Action row (play/copy/time) for the last message of an assistant
          turn group. Previously hidden for map tool cards (hasMcpContent) to
          avoid icon collision with the map widget's own action buttons — but
          the web build shows this row, so align the app with web. Map cards
          keep their in-widget actions AND show the standard row here. */}
      {!isActiveStreaming && isLastInGroup && !hasInlineVideo && !isCreationComplete && !isCreationFailed && (
        <View className="flex-row items-center gap-3">
          <Pressable
            className="p-1 rounded-full active:bg-black/5"
            onPress={handlePlayVoice}
            hitSlop={8}
            disabled={!actionText.trim()}
          >
            <Ionicons
              className="text-aura-outline"
              name={isThisTtsPlaying ? 'stop-outline' : isThisTtsLoading ? 'hourglass-outline' : 'volume-high-outline'}
              size={16}
              color={isThisTtsPlaying || isThisTtsLoading ? '#1D4ED8' : '#86909C'}
            />
          </Pressable>
          <Pressable
            className="p-1 rounded-full active:bg-black/5"
            onPress={handleCopy}
            hitSlop={8}
          >
            <Ionicons
              name={copied ? 'checkmark' : 'copy-outline'}
              size={16}
              className={copied ? 'text-green-500' : 'text-aura-outline'}
            />
          </Pressable>
          {message.createdAt && (
            <Text className="text-label-sm text-aura-outline font-mono">
              {formatMessageTime(message.createdAt)}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

// React.memo: during WS streaming, only the actively-streaming message's
// reference changes (updateStreamingContent creates a new object only for
// the streaming messageId; all other messages keep their original object
// reference). Without memo, ChatView's per-token re-render would re-execute
// EVERY ChatBubble in the session — for 100 messages that's 100 needless
// function executions per token, saturating the JS thread and starving
// native touch/scroll event dispatch (the root cause of "scrolling and
// buttons became unresponsive during streaming"). With memo, only the
// streaming bubble re-renders; all others are skipped via shallow prop
// comparison. PREREQUISITE: callers must pass stable callback references
// (useCallback) for memo to take effect — see ChatView's onMcpToolCall.
export const ChatBubble = React.memo(ChatBubbleBase);
