import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, type Href } from 'expo-router';
import { openBrowserAsync } from 'expo-web-browser';
import { useChatStore } from '@/stores/chat';
import { markNewsClicked } from '@/services/news';

export const NOTIFICATION_PAYLOAD_VERSION = 1;
export const PENDING_NAVIGATION_STORAGE_KEY = '@kdoo/pending-navigation';
export const SAFE_URL_SCHEMES = ['http', 'https'] as const;
export const SCREEN_TO_ROUTE: Record<NotificationScreen, string> = {
  home: '/',
  'search-chats': '/search-chats',
};

const VALID_NOTIFICATION_SCREENS = new Set<NotificationScreen>([
  'home',
  'search-chats',
]);

export type NotificationScreen =
  | 'home'
  | 'search-chats';

export type NotificationPayload =
  | { v: typeof NOTIFICATION_PAYLOAD_VERSION; type: 'chat'; sessionId: string }
  | { v: typeof NOTIFICATION_PAYLOAD_VERSION; type: 'new_chat'; messageText: string; newsId?: string }
  | { v: typeof NOTIFICATION_PAYLOAD_VERSION; type: 'page'; screen: NotificationScreen }
  | { v: typeof NOTIFICATION_PAYLOAD_VERSION; type: 'url'; url: string };

export type NavigationAction =
  | { kind: 'navigate'; path: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'newChat'; messageText: string; newsId?: string }
  | { kind: 'url'; url: string }
  | { kind: 'ignore' };

export type ResolveContext = {
  isAuthenticated: boolean;
  isReady: boolean;
  sessions: { id: string }[];
};

function assertNever(x: never): never {
  throw new Error(`Unexpected payload: ${JSON.stringify(x)}`);
}

export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'http:' || parsed.protocol === 'https:'
    );
  } catch {
    return false;
  }
}

export function parseNotificationPayload(data: unknown): NotificationPayload | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }

  const obj = data as Record<string, unknown>;

  // FCM 在 Android 上会将 data 值全部转为字符串（如 "1"），需做类型归一化
  if (Number(obj.v) !== NOTIFICATION_PAYLOAD_VERSION) {
    return null;
  }

  const type = obj.type;
  if (type !== 'chat' && type !== 'new_chat' && type !== 'page' && type !== 'url') {
    return null;
  }

  if (type === 'chat') {
    const sessionId = obj.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return null;
    }
    return { v: NOTIFICATION_PAYLOAD_VERSION, type: 'chat', sessionId };
  }

  if (type === 'new_chat') {
    const messageText = obj.messageText;
    if (typeof messageText !== 'string' || messageText.length === 0) {
      return null;
    }
    const newsId = obj.newsId;
    return {
      v: NOTIFICATION_PAYLOAD_VERSION,
      type: 'new_chat',
      messageText,
      ...(typeof newsId === 'string' && newsId.length > 0 ? { newsId } : {}),
    };
  }

  if (type === 'page') {
    const screen = obj.screen;
    if (
      typeof screen !== 'string' ||
      !VALID_NOTIFICATION_SCREENS.has(screen as NotificationScreen)
    ) {
      return null;
    }
    return {
      v: NOTIFICATION_PAYLOAD_VERSION,
      type: 'page',
      screen: screen as NotificationScreen,
    };
  }

  const url = obj.url;
  if (typeof url !== 'string' || url.length === 0 || !isSafeUrl(url)) {
    return null;
  }
  return { v: NOTIFICATION_PAYLOAD_VERSION, type: 'url', url };
}

export function resolveNavigationAction(
  payload: NotificationPayload,
  ctx: ResolveContext,
): NavigationAction {
  switch (payload.type) {
    case 'chat': {
      if (!ctx.isAuthenticated || !ctx.isReady) {
        return { kind: 'ignore' };
      }
      const exists = ctx.sessions.some((s) => s.id === payload.sessionId);
      if (!exists) {
        return { kind: 'ignore' };
      }
      return { kind: 'session', sessionId: payload.sessionId };
    }
    case 'new_chat': {
      // 创建新会话不需要校验 sessions 列表（会话还没建），
      // 但仍需认证和就绪，否则等到 ready 后由 pending queue 消费
      if (!ctx.isAuthenticated || !ctx.isReady) {
        return { kind: 'ignore' };
      }
      return {
        kind: 'newChat',
        messageText: payload.messageText,
        ...(payload.newsId ? { newsId: payload.newsId } : {}),
      };
    }
    case 'page': {
      if (!ctx.isAuthenticated) {
        return { kind: 'ignore' };
      }
      return { kind: 'navigate', path: SCREEN_TO_ROUTE[payload.screen] };
    }
    case 'url': {
      return { kind: 'url', url: payload.url };
    }
    default:
      return assertNever(payload);
  }
}

export async function executeNavigationAction(action: NavigationAction): Promise<void> {
  switch (action.kind) {
    case 'navigate':
      router.navigate(action.path as Href);
      return;
    case 'session':
      useChatStore.getState().setCurrentSession(action.sessionId);
      router.navigate('/');
      return;
    case 'newChat': {
      // 推送点击：记录 newsId 到 clicked + 后台上报（fire-and-forget）
      if (action.newsId) {
        markNewsClicked(action.newsId);
      }

      const chat = useChatStore.getState();
      // 确保 ws 已连——sendMessage 依赖 ws，未连会走 fail 分支清掉消息
      chat.connectWebSocket();

      // name 缺省用 messageText 截断，避免空标题
      const name = action.messageText.slice(0, 30).trim()
        || `新会话 ${new Date().toLocaleString()}`;

      const sessionId = await chat.createSessionAsync({ agentId: 'default', name });
      if (!sessionId) {
        // createSessionAsync 内部已 set error，ChatView 会 Alert；这里静默返回
        return;
      }

      // createSessionAsync 已 setCurrentSession，这里显式再调一次保证一致
      chat.setCurrentSession(sessionId);
      // 触发 AI 回复：sendMessage 内部会 addMessage(user) + addMessage(assistant placeholder) + ws.sendChat
      chat.sendMessage(sessionId, action.messageText, undefined, 'default');
      router.navigate('/');
      return;
    }
    case 'url':
      await openBrowserAsync(action.url);
      return;
    case 'ignore':
      return;
    default:
      assertNever(action);
  }
}

let pendingPayload: NotificationPayload | null = null;

export function setPendingNavigation(payload: NotificationPayload): void {
  pendingPayload = payload;
}

export function consumePendingNavigation(): NotificationPayload | null {
  const payload = pendingPayload;
  pendingPayload = null;
  return payload;
}

export function clearPendingNavigation(): void {
  pendingPayload = null;
}

export async function savePendingToStorage(payload: NotificationPayload): Promise<void> {
  await AsyncStorage.setItem(
    PENDING_NAVIGATION_STORAGE_KEY,
    JSON.stringify(payload),
  );
}

export async function loadPendingFromStorage(): Promise<NotificationPayload | null> {
  const raw = await AsyncStorage.getItem(PENDING_NAVIGATION_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return parseNotificationPayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function clearPendingFromStorage(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_NAVIGATION_STORAGE_KEY);
}
