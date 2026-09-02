// --- Auth Types ---

export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatar?: string;
}

// --- User Profile Types ---

export interface ChatSetting {
  id: string;
  userId: string;
  theme: 'light' | 'dark' | 'system';
  language: 'en' | 'zh' | 'pt';
  autoScroll: boolean;
  enableRichText: boolean;
  requireCmdEnter: boolean;
  hideThinking: boolean;
  channelSharedAgent: boolean;
  autoPlay: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  id: string;
  username: string | null;
  email: string | null;
  phone: string | null;
  type: 'END_USER' | 'API_USER' | 'ADMIN';
  role: 'user' | 'vip' | 'admin';
  status: 'ACTIVE' | 'INACTIVE' | 'BANNED' | 'DELETED';
  displayName: string | null;
  avatar: string | null;
  bio: string | null;
  creditLimit: number | null;
  monthlyQuota: number | null;
  usedQuota: number;
  balance: number;
  createdAt: string;
  updatedAt: string;
  chatSetting: ChatSetting;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

/** Memory management: cross-session working memory & observational memory read results (Markdown/plain-text strings) */
export interface MemoryData {
  /** Working memory content (Markdown text, may be an empty string) */
  workingMemory: string;
  /** Memory template (Markdown text, used to render empty state / refill after reset) */
  template: string;
  /** Observational memory summary text (read-only, may be an empty string) */
  observations: string;
}

export interface ApiResponse<T = unknown> {
  code: string;
  message: string;
  data: T;
}

// --- Email Auth API Types ---

/** 登录请求（password 为明文，store 层负责 Base64 编码） */
export interface LoginRequest {
  email?: string;
  username?: string;
  phone?: string;
  password: string;
}

/** 登录/注册 成功响应中的 tokens */
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // 秒
  tokenType: 'Bearer';
}

/** 登录响应 data */
export interface LoginResponseData {
  user: User;
  tokens: TokenPair;
}

/** 注册请求（password 为明文，调用方负责 Base64 编码） */
export interface RegisterRequest {
  email: string;
  password: string;
  username?: string;
  displayName?: string;
  verificationToken: string;
}

/** 发送验证码请求 */
export interface SendVerificationRequest {
  email: string;
  purpose: VerificationPurpose;
}

/** 验证码用途 */
export type VerificationPurpose = 'REGISTER' | 'RESET_PASSWORD' | 'BIND_EMAIL';

/** 验证验证码请求 */
export interface VerifyCodeRequest {
  email: string;
  code: string; // 6 位数字验证码
  purpose: VerificationPurpose;
}

/** 验证码验证响应 data */
export interface VerificationResponseData {
  verificationToken: string;
}

/** 发送验证码响应 data */
export interface SendCodeResponseData {
  retryAfter: number;
}

/** 忘记密码请求 */
export interface ForgotPasswordRequest {
  email: string;
}

/** 重置密码请求（newPassword 为明文，调用方负责 Base64 编码） */
export interface ResetPasswordRequest {
  email: string;
  verificationToken: string;
  newPassword: string;
}

/** 检查登录状态响应 data */
export interface CheckAuthResponseData {
  isLoggedIn: boolean;
  user: {
    userId: string;
    username: string;
  };
}

// DEPRECATED: 保留兼容，推荐使用 LoginRequest
export interface LoginCredentials {
  email: string;
  password: string;
}

// --- Chat Types ---

export interface ChatSession {
  id: string;
  title: string;
  lastMessage?: string;
  updatedAt: Date;
  isPinned?: boolean;
}

export type MessageRole = 'user' | 'assistant';

export type MessageContentType = 'text' | 'image' | 'file' | 'code' | 'table' | 'reasoning' | 'tool-invocation' | 'data';

export interface TextContent {
  type: 'text';
  text: string;
  state?: 'streaming' | 'completed' | 'error';
}

export interface ImageContent {
  type: 'image';
  /** 本地文件 URI（用于显示） */
  uri: string;
  /** base64 data URI 或远程 URL（用于发送/回显） */
  data?: string;
  /** MIME 类型 */
  mediaType?: string;
  alt?: string;
}

export interface FileContent {
  type: 'file';
  /** 文件名 */
  name: string;
  /** 本地文件 URI（用于显示） */
  uri: string;
  /** base64 data（用于发送） */
  data?: string;
  /** MIME 类型 */
  mediaType?: string;
  /** 文件大小（byte） */
  size?: number;
  /** 视频封面 URL（AI 创作视频的首帧图）— 播放器海报，避免加载期黑屏 */
  posterUrl?: string;
}

/** AI 创作完成消息的请求引用部分（豆包式：视频上方展示用户原始请求） */
export interface CreationRefContent {
  type: 'creation-ref';
  /** 用户原始请求文本 */
  text: string;
}

export interface CodeContent {
  type: 'code';
  language: string;
  code: string;
}

export interface TableContent {
  type: 'table';
  headers: string[];
  rows: string[][];
  title?: string;
}

/** AI 推理/思考过程内容 */
export interface ReasoningContent {
  type: 'reasoning';
  text: string;
  state?: 'streaming' | 'completed';
  expanded: boolean
}

/** Tool progress info (e.g., image generation sampling steps) */
export interface ToolProgress {
  /** Current progress value */
  value: number;
  /** Maximum progress value */
  max: number;
  /** Optional step/phase label */
  step?: string;
}

/** 工具调用内容 */
export interface ToolInvocationContent {
  type: 'tool-invocation';
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  state?: 'input-streaming' | 'input-available' | 'approval-requested' | 'output-available' | 'output-error' | 'output-denied';
  errorText?: string;
  /** Real-time progress for long-running tools (e.g., image generation) */
  progress?: ToolProgress;
  /** MCP structured content from interactive tools (e.g., calculatorTool) */
  structuredContent?: McpStructuredContent;
}

/** 数据内容（workspace-metadata 等） */
export interface DataContent {
  type: 'data';
  dataType: string;
  data: unknown;
}

export type MessageContent = TextContent | ImageContent | FileContent | CodeContent | TableContent | ReasoningContent | ToolInvocationContent | DataContent | CreationRefContent;

/** 输入框中的附件（未发送前） */
export interface Attachment {
  id: string;
  type: 'image' | 'file';
  name: string;
  uri: string;
  mediaType: string;
  size?: number;
  /** base64 编码后的数据（发送时使用） */
  base64?: string;
}

/** 系统分享进来的内容（Share-into），归一化后的草稿 */
export interface ShareIntoDraft {
  /** 拼接的文本/URL 行，用于弹窗预填 */
  text: string | null;
  /** 第一张分享图片，自动挂到聊天输入栏 */
  image: { uri: string; mediaType: string; name?: string } | null;
}

/** Search reference source (mapped from data-search-results, aligned with web SourceReference) */
export interface SourceLink {
  id: string;       // String(index) or fallback to url/title
  title: string;
  url: string;
}

/**
 * Video search result entry (from data-video-results / persisted metadata).
 * Aligned with VideoCardList's VideoResult interface — structural typing
 * makes the two interchangeable. The pipeline emits additional fields
 * (index, publishedDate) that are dropped here since the UI doesn't use them.
 */
export interface VideoResult {
  title: string;
  url: string;
  thumbnail?: string;
  duration?: string;
  author?: string;
  description?: string;
  embedUrl?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: MessageContent[];
  createdAt: Date;
  /** Search keywords (from data-search-keywords / persisted metadata) */
  searchKeywords?: string[];
  /** Search reference sources (from data-search-results / persisted metadata) */
  sources?: SourceLink[];
  /** Video search results (from data-video-results / persisted metadata) */
  videoResults?: VideoResult[];
  /** 后端透传的消息元数据(含 source: 'cron'|'webhook' 等标签,用于合并判定) */
  metadata?: Record<string, unknown>;
  /** Optimistic send status — 'sending' while awaiting server confirmation, 'saved' once confirmed */
  sendStatus?: 'sending' | 'saved';
  /** Client-side temp ID used to correlate with server's real messageId via user-message-saved event */
  tempId?: string;
}

// --- WebSocket / Message Types ---

/** API 返回的消息格式（/messages 接口） */
export interface ApiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: {
    format?: string;
    parts?: Array<{ type: string; text?: string;[key: string]: unknown }>;
    content?: string;
    /** Backend-attached metadata: searchResults, searchKeywords, attachments, etc. */
    metadata?: Record<string, unknown>;
  };
  createdAt: string;
  threadId?: string;
  resourceId?: string;
}

/** 消息分页响应 */
export interface MessagesResponse {
  items: ApiMessage[];
  nextCursor?: string;
  hasMore: boolean;
}

/** WebSocket 聊天消息内容块 */
export interface WsContentBlock {
  type: 'text' | 'image' | 'audio' | 'file' | 'tool' | 'reasoning' | 'data';
  text?: string;
  image?: string; // base64 data URI
  audio?: string; // base64 data URI
  data?: string;  // base64 data (for file type)
  mediaType?: string;
  mimeType?: string;
  filename?: string;
  toolCallId?: string;
  toolName?: string;
  result?: string;
  args?: Record<string, unknown>;
  state?: string;
  errorText?: string;
  dataType?: string;
  /** MCP structured content from interactive tools */
  structuredContent?: McpStructuredContent;
}

/** WebSocket 聊天消息内容格式 */
export interface WsChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | WsContentBlock[];
  /** Route-1: client-generated UUID for the user message. Backend uses
   *  this id for upsert (INSERT ... ON DUPLICATE KEY UPDATE), so retries
   *  with the same id are idempotent. Omitted for assistant messages
   *  (server assigns the id). */
  id?: string;
}

/** WebSocket 发送的 chat 消息 */
export interface WsChatPayload {
  type: 'chat';
  sessionId: string;
  messages: WsChatMessage[];
  agentId?: string;
  skillIds?: string[];
  debug?: boolean;
}

/** WebSocket attach request (client → server, for stream resume after reconnect) */
export interface WsAttachPayload {
  type: 'attach';
  sessionId: string;
  /** Last sequenceId received for this session; 0 if none */
  lastSequenceId: number;
}

/** All client → server WebSocket message types */
export type WsClientMessage = WsChatPayload | WsAttachPayload;

/** WebSocket 服务端推送事件（协议定义：数据在 payload 中）
 *
 *  Stream-resume fields (optional, present when server-side ChatStreamBuffer is active):
 *  - `sequenceId`: monotonically increasing per-session chunk index assigned by server
 *  - `replay`: true when this chunk is a replayed historical chunk (not live)
 *  These fields let the client deduplicate chunks received before/after reconnect.
 */
export type WsServerEvent =
  | { type: 'start'; payload: { id?: string; messageId: string }; sessionId?: string; detail?: boolean; msgId?: string; sequenceId?: number; replay?: boolean }
  | { type: 'step-start'; payload: { messageId?: string;[k: string]: unknown }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'text-delta'; payload: { id?: string; text: string }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'reasoning-start'; payload: { id?: string;[k: string]: unknown }; sessionId?: string; detail?: boolean; msgId?: string; sequenceId?: number; replay?: boolean }
  | { type: 'reasoning-delta'; payload: { id?: string; text: string }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'reasoning-end'; payload: { id?: string;[k: string]: unknown }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'tool-call'; payload: { toolCallId: string; toolName: string; args: Record<string, unknown> }; sessionId?: string; detail?: boolean; msgId?: string; sequenceId?: number; replay?: boolean }
  | { type: 'tool-result'; payload: { toolCallId: string; toolName: string; result: unknown }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'tool-progress'; payload: { toolCallId?: string; toolName: string; value: number; max: number; step?: string }; sessionId?: string; detail?: boolean; msgId?: string; sequenceId?: number; replay?: boolean }
  | { type: 'tool-error'; payload: { toolCallId: string; toolName: string; error: string }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'tool-call-approval'; payload: { toolCallId: string; toolName: string; args: Record<string, unknown>; runId: string }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'mcp-tool-call'; payload: { toolCallId: string; toolName: string; args: Record<string, unknown> }; sessionId?: string; detail?: boolean; msgId?: string; sequenceId?: number; replay?: boolean }
  | { type: 'mcp-tool-result'; payload: { toolCallId: string; toolName: string; result: unknown; structuredContent?: McpStructuredContent }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'mcp-tool-error'; payload: { toolCallId: string; toolName: string; error: string }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'data-workspace-metadata'; payload: Record<string, unknown>; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'data-search-keywords'; payload: { keywords: string[]; userKeyword?: string }; sessionId?: string; detail?: boolean; msgId?: string; sequenceId?: number; replay?: boolean }
  | { type: 'data-search-results'; payload: { results: Array<{ index: number; title: string; url: string; content?: string }> }; sessionId?: string; detail?: boolean; msgId?: string; sequenceId?: number; replay?: boolean }
  | { type: 'data-video-results'; payload: { results: Array<{ index?: number; title: string; url: string; thumbnail?: string; duration?: string; author?: string; description?: string; embedUrl?: string; publishedDate?: string }> }; sessionId?: string; detail?: boolean; msgId?: string; sequenceId?: number; replay?: boolean }
  | { type: 'step-finish'; payload: { messageId?: string;[k: string]: unknown }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'message'; payload: { role?: string; content?: string; parts?: Array<{ type: string;[k: string]: unknown }>; createdAt?: string }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  // --- AI creation (video/image) async job events ---
  | { type: 'creation-job-update'; payload: { toolCallId?: string; status?: string; progress?: number; artifacts?: unknown[]; error?: { code?: string; message?: string } | null }; sessionId?: string; sequenceId?: number }
  | { type: 'creation-complete'; payload: { messageId?: string; role?: string; parts?: Array<Record<string, unknown>> }; sessionId?: string; sequenceId?: number }
  | { type: 'finish'; payload?: { reason?: string }; sessionId?: string; detail?: boolean; sequenceId?: number; replay?: boolean }
  | { type: 'cancel-ack'; sessionId: string; message: string }
  | { type: 'error'; error: string; sessionId?: string }
  | { type: 'session-title-updated'; sessionId: string; title: string }
  | { type: 'user-message-saved'; sessionId: string; messageId: string; sequenceId?: number }
  // --- Stream-resume (Plan B) handshake events ---
  | { type: 'attach-ack'; sessionId: string; replayedCount: number; latestSequenceId: number; isStreaming: boolean }
  | { type: 'attach-finished'; sessionId: string }
  | { type: 'attach-stale'; sessionId: string; message: string }
  | { type: 'attach-error'; sessionId?: string; error: string }
  | { type: string;[key: string]: unknown };

// --- MCP Apps / JSON-RPC Bridge Types ---

/**
 * MCP structured content — returned by interactive tools (e.g., calculatorTool).
 * Contains a resourceUri (e.g., "ui://calculator/main") that identifies the
 * interactive app to render in a WebView.
 */
export interface McpStructuredContent {
  resourceUri?: string;
  [key: string]: unknown;
}

/** JSON-RPC 2.0 request */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 notification (no id) */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

/** Host capabilities sent during ui/initialize handshake */
export interface McpUiHostCapabilities {
  tools: { call: boolean };
  messages: boolean;
  context: { update: boolean };
  links: { open: boolean };
  files: { download: boolean };
  display: { resize: boolean; mode: boolean };
  theme: 'dark' | 'light';
}

/** MCP app state response from REST hydration endpoint */
export interface McpAppState {
  toolInput?: { toolName: string; input: unknown };
  toolResult?: { toolName: string; result: unknown };
  structuredContent?: McpStructuredContent;
}

/** Tool call payload emitted by the MCP app bridge */
export interface McpToolCallPayload {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  responseId: string | number;
}

/**
 * Strip thinking tags from text and extract them as reasoning segments.
 * Handles both <think>...</think> and <thinking>...</thinking> variants.
 */
export function extractThinkingSegments(
  text: string
): Array<{ type: 'text' | 'reasoning'; text: string }> {
  const segments: Array<{ type: 'text' | 'reasoning'; text: string }> = [];
  const thinkOpenTags = ['<think>', '<thinking>'];
  const thinkCloseTags = ['</think>', '</thinking>'];

  let remaining = text;
  while (remaining.length > 0) {
    // Find the earliest opening tag
    let earliestOpen = remaining.length;
    let openTag = '';
    let openLen = 0;
    for (const tag of thinkOpenTags) {
      const pos = remaining.indexOf(tag);
      if (pos !== -1 && pos < earliestOpen) {
        earliestOpen = pos;
        openTag = tag;
        openLen = tag.length;
      }
    }

    if (openTag === '' || earliestOpen === remaining.length) {
      // No more open tags, rest is plain text
      const trimmed = remaining;
      if (trimmed) {
        segments.push({ type: 'text', text: trimmed });
      }
      break;
    }

    // Text before the open tag
    const before = remaining.slice(0, earliestOpen);
    if (before) {
      segments.push({ type: 'text', text: before });
    }

    remaining = remaining.slice(earliestOpen + openLen);

    // Find the closing tag
    let earliestClose = remaining.length;
    let closeTag = '';
    let closeLen = 0;
    for (const tag of thinkCloseTags) {
      const pos = remaining.indexOf(tag);
      if (pos !== -1 && pos < earliestClose) {
        earliestClose = pos;
        closeTag = tag;
        closeLen = tag.length;
      }
    }

    if (closeTag === '' || earliestClose === remaining.length) {
      // Unclosed thinking block - treat rest as reasoning (incomplete)
      const trimmed = remaining;
      if (trimmed) {
        segments.push({ type: 'reasoning', text: trimmed });
      }
      break;
    }

    // Extract the thinking content
    const thinkingContent = remaining.slice(0, earliestClose);
    if (thinkingContent) {
      segments.push({ type: 'reasoning', text: thinkingContent });
    }

    remaining = remaining.slice(earliestClose + closeLen);
  }

  return segments;
}

/**
 * Apply extractThinkingSegments to a text string and return MessageContent[].
 * Text segments become TextContent, reasoning segments become ReasoningContent.
 */
export function extractThinkingFromText(text: string, textState?: TextContent['state']): MessageContent[] {
  const segments = extractThinkingSegments(text);
  if (segments.length === 1 && segments[0].type === 'text') {
    // No thinking tags — return single text entry
    return [{ type: 'text', text: segments[0].text, state: textState }];
  }
  return segments.map(s =>
    s.type === 'reasoning'
      ? { type: 'reasoning' as const, text: s.text, state: 'completed' as const, expanded: false }
      : { type: 'text' as const, text: s.text, state: textState }
  );
}

/**
 * 合并连续同 role 的 assistant 消息(后端 OM 拆分场景)。
 * 任一方带 metadata.source(cron/webhook/...)则独立,不合并。
 * user 消息永不参与合并(由调用前的 role 判断保证)。
 */
export function mergeItemParts(apiMsgs: ApiMessage[]): ApiMessage[] {
  const items: ApiMessage[] = [];
  for (const msg of apiMsgs) {
    const lastItem = items[items.length - 1];
    if (shouldMergeApiMessages(lastItem, msg)) {
      // parts 数组拼接
      if (msg.content.parts?.length) {
        if (!lastItem!.content.parts) lastItem!.content.parts = [];
        lastItem!.content.parts.push(...msg.content.parts);
      }
      // createdAt 取较早的
      if (msg.createdAt && lastItem!.createdAt) {
        const t1 = new Date(lastItem!.createdAt).getTime();
        const t2 = new Date(msg.createdAt).getTime();
        if (t2 < t1) lastItem!.createdAt = msg.createdAt;
      } else if (msg.createdAt && !lastItem!.createdAt) {
        lastItem!.createdAt = msg.createdAt;
      }
      // id 取最新(最后一条的 id,便于后续操作定位)
      lastItem!.id = msg.id;
      // metadata 取首条(不覆盖) — 仅当首条无 metadata 时才用新条的
      if (!lastItem!.content.metadata && msg.content.metadata) {
        lastItem!.content.metadata = msg.content.metadata;
      }
    } else {
      items.push(msg);
    }
  }
  // 过滤内部 part 后无可见内容的气泡丢弃(规范 §2.3)
  return items.filter(item => {
    if (item.role !== 'assistant') return true;
    const parts = item.content.parts ?? [];
    const hasVisible = parts.some(p => !isInternalApiPart(p));
    return hasVisible;
  });
}

/**
 * 判定两条连续 assistant 消息是否应合并为一个气泡。
 * 规则:role 都是 'assistant' && threadId 相等 && 任一方 metadata.source 都为空。
 * 任一方带 source 标签 → 返回 false(独立气泡)。
 */
function shouldMergeApiMessages(prev: ApiMessage | undefined, cur: ApiMessage): boolean {
  if (!prev) return false;
  if (prev.role !== 'assistant' || cur.role !== 'assistant') return false;
  // threadId 比较(可能 undefined,相等才合并 — 包括双方都 undefined 的场景)
  if (prev.threadId !== cur.threadId) return false;
  // 任一方带 source 就独立(规范明确要求)
  const prevSource = (prev.content.metadata as { source?: string } | undefined)?.source;
  const curSource  = (cur.content.metadata  as { source?: string } | undefined)?.source;
  if (prevSource || curSource) return false;
  return true;
}

const INTERNAL_API_PART_TYPES = new Set([
  'step-start',
  'step-finish',
]);

const INTERNAL_API_DATA_PREFIXES = [
  'data-om-',
  'data-sandbox-',
];

export function isInternalApiPart(part: { type: string;[key: string]: unknown }): boolean {
  if (INTERNAL_API_PART_TYPES.has(part.type)) return true;
  if (part.type.startsWith('data-')) {
    return INTERNAL_API_DATA_PREFIXES.some(p => part.type.startsWith(p));
  }
  // 防御性:嵌套形 { type: 'data', dataType: 'data-om-*' / 'data-sandbox-*' }(规范字面描述)
  if (part.type === 'data' && typeof part.dataType === 'string') {
    return INTERNAL_API_DATA_PREFIXES.some(p => (part.dataType as string).startsWith(p));
  }
  return false;
}

/** 将 ApiMessage 转换为本地 ChatMessage */
export function apiMessageToChatMessage(apiMsg: ApiMessage, sessionId: string): ChatMessage | null {
  if (!apiMsg) return null;
  const content: MessageContent[] = [];
  const debugInfo: string[] = [];

  // ── Parts first: if parts exist, use them exclusively ──
  const apiContent = apiMsg.content as ApiMessage['content']
  const parts = apiContent?.parts;

  // ── Extract search metadata attached by backend searchEngineProcessor ──
  const searchMeta = apiContent?.metadata as { searchResults?: unknown; searchKeywords?: unknown; videoResults?: unknown } | undefined;
  const extractedKeywords = extractKeywords(searchMeta?.searchKeywords);
  const extractedSources = extractSources(searchMeta?.searchResults);
  const extractedVideos = extractVideoResults(searchMeta?.videoResults);
  const meta = {
    ...(extractedKeywords.length > 0 && { searchKeywords: extractedKeywords }),
    ...(extractedSources.length > 0 && { sources: extractedSources }),
    ...(extractedVideos.length > 0 && { videoResults: extractedVideos }),
  };
  const apiContentContentStr = apiContent?.content
  if (parts?.length) {
    debugInfo.push('parts[]');
    for (const part of parts) {
      if (isInternalApiPart(part)) continue;
      if (apiMsg.role == 'user' && part.type === 'text' && part.text) {
        if (part.mimeType) {
          if ((part.mimeType as string).startsWith('image/')) {
            content.push({
              type: 'image',
              uri: part.url as string || '',
              mediaType: part.mimeType as string,
            });
          } else {
            content.push({
              type: 'file',
              name: (part.filename as string) || 'file',
              uri: part.url as string || '',
              mediaType: part.mimeType as string,
            });
          }
        } else {
          content.push({
            type: 'text',
            text: part.text
          });
        }
      } else if (part.type === 'text' && part.text) {
        // Do NOT require `apiContent.content` to be present — cron/webhook
        // pushes from the backend only carry `parts` + `metadata`, with no
        // pre-joined content string. Requiring it would silently drop the
        // text part and turn the whole message into a null (empty bubble).
        let trimmed = part.text;
        trimmed = trimmed.replace(/<\/mm:think>\s*/, '')
        if (!trimmed) {
          continue;
        }
        content.push({
          type: 'text',
          text: trimmed
        });
      } else if (part.type === 'tool-invocation' && ((part as any).toolInvocation?.toolName == 'txt2imageTool' || (part as any).toolInvocation?.toolName == 'textEditImageTool')) {
        // Special handling: image generation/editing tools display the result
        // image directly instead of a tool card.
        const imgUrl = (part as any).toolInvocation?.result?.imageUrl;
        // Failure protocol: imageUrl is null/undefined or an "Error: ..." string
        // — skip rather than render a broken image.
        if (typeof imgUrl !== 'string' || imgUrl.startsWith('Error:')) {
          continue;
        }
        content.push({
          type: 'image',
          uri: imgUrl,
          mediaType: imgUrl.startsWith('data:')
            ? imgUrl.split(';')[0].replace('data:', '')
            : 'image/png',
        });
      } else if (part.type === 'image_url' && (part as any).image_url?.url) {
        const imgUrl = String((part as any).image_url.url);
        content.push({
          type: 'image',
          uri: imgUrl,
          mediaType: imgUrl.startsWith('data:')
            ? imgUrl.split(';')[0].replace('data:', '')
            : 'image/png',
        });
      } else if (part.type === 'image' && (part as any).image) {
        content.push({
          type: 'image',
          uri: (part as any).image,
          mediaType: (part as any).mediaType as string | undefined,
        });
      } else if (part.type === 'file') {
        const partMediaType = (part as any).mediaType || (part as any).mimeType;
        const partData = (part as any).data || (part as any).image;
        // If the file is actually an image, convert to ImageContent for proper rendering
        if (partMediaType?.startsWith('image/')) {
          content.push({
            type: 'image',
            uri: partData,
            data: partData,
            mediaType: partMediaType,
          });
        } else {
          content.push({
            type: 'file',
            name: (part as any).filename || 'file',
            uri: partData,
            mediaType: partMediaType,
            size: (part as any).size,
            // AI-creation videos carry a first-frame cover (posterUrl) so the
            // player shows a poster instead of a black frame while loading.
            posterUrl: (part as any).posterUrl,
          });
        }
      } else if (part.type === 'creation-ref') {
        const refText = (part as any).text;
        if (typeof refText === 'string' && refText.trim()) {
          const ref: CreationRefContent = { type: 'creation-ref', text: refText };
          content.push(ref);
        }
      } else if (part.type === 'reasoning') {
        const reasoningText = (part as any).reasoning || '';
        if (reasoningText) {
          content.push({
            type: 'reasoning',
            text: reasoningText,
            state: 'completed',
            expanded: false
          });
        } else if ((part as any).details) {
          const reasoningText = (part as any).details[0]?.text || '';
          content.push({
            type: 'reasoning',
            text: reasoningText,
            state: 'completed',
            expanded: false
          });
        }
      }
      // Tool invocation conversion — restores tool cards from API message history
      else if (part.type === 'tool-invocation') {
        const ti = (part as any).toolInvocation || part;
        const rawToolName = ti.toolName ?? '';
        // structuredContent may be at top level or nested inside result
        // (Vercel AI SDK stores it as result.structuredContent)
        const resultObj = (ti.result ?? ti.output) as Record<string, unknown> | undefined;
        const structuredContent = ti.structuredContent ?? resultObj?.structuredContent;
        content.push({
          type: 'tool-invocation',
          toolCallId: String(ti.toolCallId ?? ''),
          toolName: typeof rawToolName === 'string' ? rawToolName : String((rawToolName as any)?.name ?? JSON.stringify(rawToolName)),
          args: ti.args || ti.input,
          result: ti.result || ti.output,
          state: (ti.state || 'output-available') as ToolInvocationContent['state'],
          errorText: typeof ti.errorText === 'string' ? ti.errorText : undefined,
          structuredContent: structuredContent as McpStructuredContent | undefined,
        });
      }
    }

    // Merge adjacent text parts into one.
    // Backend may store each text-delta as a separate part; without merging,
    // each delta renders as an independent markdown block (e.g. "##" alone
    // is invalid heading syntax). This mirrors appendTextDelta's behavior
    // during streaming, where consecutive text-deltas accumulate into one part.
    const mergedContent: MessageContent[] = [];
    for (const c of content) {
      const last = mergedContent[mergedContent.length - 1];
      if (last && last.type === 'text' && c.type === 'text') {
        mergedContent[mergedContent.length - 1] = {
          ...(last as TextContent),
          text: (last as TextContent).text + (c as TextContent).text,
        };
      } else {
        mergedContent.push(c);
      }
    }

    if (mergedContent.length === 0) {
      return null;
    }
    return buildResult(apiMsg, sessionId, mergedContent, meta, apiContent?.metadata as Record<string, unknown> | undefined);
  }

  // ── Fallback: only when no parts — parse content.content string ──
  // if (typeof apiMsg.content.content === 'string') {
  //   const raw = apiMsg.content.content.trim();
  //   // Check if it looks like JSON (stringified WsContentBlock[] or single block)
  //   if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
  //     try {
  //       const parsed = JSON.parse(raw);
  //       const blocks = Array.isArray(parsed) ? parsed : [parsed];
  //       debugInfo.push(`content.content=JSON${Array.isArray(parsed) ? '[]' : '{}'}`);
  //       for (const block of blocks) {
  //         if (block.type === 'text' && block.text) {
  //           // Only keep plain text (no thinking extraction), normalize \n\n → \n
  //           const normalized = block.text.replace(/\n\n/g, '\n');
  //           content.push({ type: 'text', text: normalized, state: 'completed' });
  //         } else if (block.type === 'image' && (block.image || block.data)) {
  //           content.push({
  //             type: 'image',
  //             uri: block.image || block.data || '',
  //             mediaType: block.mediaType,
  //             alt: block.alt,
  //           });
  //         } else if (block.type === 'file' && (block.data || block.file)) {
  //           content.push({
  //             type: 'file',
  //             name: block.filename || 'file',
  //             uri: '',
  //             data: block.data || block.file || '',
  //             mediaType: block.mediaType,
  //             size: block.size,
  //           });
  //         } else if (block.image || block.data) {
  //           // Has image/data field but missing type — treat as image
  //           content.push({
  //             type: 'image',
  //             uri: block.image || block.data,
  //             mediaType: block.mediaType,
  //           });
  //         } else {
  //           // Unknown block type — fallback to text
  //           const fallback = JSON.stringify(block).slice(0, 200);
  //           content.push({ type: 'text', text: fallback });
  //         }
  //       }
  //       return buildResult(apiMsg, sessionId, content);
  //     } catch {}
  //   }

  //   // Plain string or data URI
  //   if (raw.startsWith('data:') || raw.startsWith('blob:')) {
  //     debugInfo.push('content.content=data URI — treated as image');
  //     content.push({
  //       type: 'image',
  //       uri: raw,
  //       mediaType: raw.startsWith('data:') ? raw.split(';')[0].replace('data:', '') : 'image/png',
  //     });
  //   } else {
  //     // Only keep plain text (no thinking extraction), normalize \n\n → \n
  //     const normalized = raw.replace(/\n\n/g, '\n');
  //     content.push({ type: 'text', text: normalized, state: 'completed' });
  //   }
  // }
  // ── Final fallback: ensure at least one content block ──
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  if (debugInfo.length > 0) {
    console.log('[apiMessageToChatMessage]', debugInfo.join(', '), 'session:', sessionId.slice(0, 8));
  }

  return buildResult(apiMsg, sessionId, content, meta, apiContent?.metadata as Record<string, unknown> | undefined);
}

function buildResult(
  apiMsg: ApiMessage,
  sessionId: string,
  content: MessageContent[],
  meta?: { searchKeywords?: string[]; sources?: SourceLink[]; videoResults?: VideoResult[] },
  metadata?: Record<string, unknown>,
): ChatMessage {
  return {
    id: apiMsg.id,
    sessionId,
    role: apiMsg.role,
    content,
    createdAt: new Date(apiMsg.createdAt),
    ...(meta?.searchKeywords && meta.searchKeywords.length > 0 && { searchKeywords: meta.searchKeywords }),
    ...(meta?.sources && meta.sources.length > 0 && { sources: meta.sources }),
    ...(meta?.videoResults && meta.videoResults.length > 0 && { videoResults: meta.videoResults }),
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Coerce the searchResults metadata into typed SourceLink[].
 * Defensive against backend shape drift: drops entries missing title/url.
 * Aligned with web extractSources (useChatMessages.ts:636).
 */
function extractSources(raw: unknown): SourceLink[] {
  if (!Array.isArray(raw)) return [];
  const out: SourceLink[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title : '';
    const url = typeof obj.url === 'string' ? obj.url : '';
    const id = typeof obj.id === 'string'
      ? obj.id
      : typeof obj.index === 'number'
        ? String(obj.index)
        : url || title;
    if (!title || !url) continue;
    out.push({ id, title, url });
  }
  return out;
}

/**
 * Coerce the searchKeywords metadata into string[].
 * Drops empty/non-string entries. Aligned with web extractKeywords (useChatMessages.ts:660).
 */
function extractKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === 'string' && k.trim().length > 0);
}

/**
 * Coerce the videoResults metadata into typed VideoResult[].
 * Defensive against backend shape drift: drops entries missing title/url.
 * Aligned with web extractVideoResults (useChatMessages.ts).
 */
function extractVideoResults(raw: unknown): VideoResult[] {
  if (!Array.isArray(raw)) return [];
  const out: VideoResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const title = typeof obj.title === 'string' ? obj.title : '';
    const url = typeof obj.url === 'string' ? obj.url : '';
    if (!title || !url) continue;
    out.push({
      title,
      url,
      thumbnail: typeof obj.thumbnail === 'string' ? obj.thumbnail : undefined,
      // duration may come as number (seconds) from SearXNG; convert to string
      duration: typeof obj.duration === 'number' ? String(obj.duration)
        : typeof obj.duration === 'string' ? obj.duration : undefined,
      author: typeof obj.author === 'string' ? obj.author : undefined,
      description: typeof obj.description === 'string' ? obj.description : undefined,
      embedUrl: typeof obj.embedUrl === 'string' ? obj.embedUrl : undefined,
    });
  }
  return out;
}

// --- API Types ---

export interface ApiSession {
  id: string;
  userId: string;
  agentId: string;
  channelId: string;
  channelType?: string;
  name?: string;
  isPinned?: boolean;
  type: 'PERSISTENT' | 'TEMPORARY';
  status: string;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
  parentSessionId?: string;
  spawnDepth?: number;
}

export interface ApiAgentSkill {
  id: string;
  name: string;
  description?: string;
}

export interface ApiAgent {
  id: string;
  name: string;
  description?: string;
  isActive?: boolean;
  modelMappingId?: string;
  skills?: ApiAgentSkill[];
}

export interface ApiDataResponse<T> {
  code: string;
  data: T;
  message?: string;
}

export interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
}

// --- Google Auth API Types ---

/** Google App 登录请求 */
export interface GoogleAppLoginRequest {
  idToken: string;
}

/** Google App 登录响应 data */
export interface GoogleAppLoginResponseData {
  user: User;
  tokens: TokenPair;
  isNewUser: boolean;
}
