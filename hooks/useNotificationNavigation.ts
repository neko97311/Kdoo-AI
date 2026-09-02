import * as Notifications from 'expo-notifications';
import { DEFAULT_ACTION_IDENTIFIER } from 'expo-notifications';
import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import {
  parseNotificationPayload,
  resolveNavigationAction,
  executeNavigationAction,
  setPendingNavigation,
  type ResolveContext,
} from '@/services/notification-navigation';
import { useToastStore } from '@/stores/toast';
import { i18n } from '@/i18n';

/**
 * Registers notification tap listeners, handles cold-start retrieval, and
 * deduplicates responses. All routing/session mutations are delegated to
 * `executeNavigationAction`; the pending queue is managed at module scope
 * via `setPendingNavigation`.
 *
 * Two capture mechanisms run in parallel:
 *
 * 1. `addNotificationResponseReceivedListener` — the primary event-based
 *    listener. Reliable on Android; on iOS it may not fire for foreground
 *    notification taps or cold-start launches (expo/expo#14078, #18403).
 *
 * 2. `useLastNotificationResponse()` — a React hook that re-renders when
 *    the last notification response changes. Expo's recommended fallback
 *    for iOS where the event listener misses responses.
 *
 * Both feed into `handleResponse`, which deduplicates via
 * `consumedResponseId` so a single tap is never processed twice.
 *
 * `handleResponse` reads ctx from a ref (`ctxRef.current`), so it never
 * needs to be re-created and the event listener registers exactly once.
 * This avoids a race condition where sessions-array identity changes
 * could tear down the listener at the exact moment a tap arrives.
 */
export function useNotificationNavigation(ctx: ResolveContext): void {
  const consumedResponseId = useRef<string | null>(null);

  // Always-current ctx — handleResponse reads from this ref instead of
  // closing over ctx directly, making the callback stable.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const handleResponse = useCallback(
    (response: Notifications.NotificationResponse): void => {
      const c = ctxRef.current;

      console.warn('[notif-nav] handleResponse 收到响应', {
        actionIdentifier: response.actionIdentifier,
        identifier: response.notification.request.identifier,
        data: response.notification.request.content.data,
      });

      if (response.actionIdentifier !== DEFAULT_ACTION_IDENTIFIER) {
        console.warn('[notif-nav] ❌ actionIdentifier 不匹配, 跳过:', response.actionIdentifier);
        return;
      }

      const identifier = response.notification.request.identifier;
      if (identifier === consumedResponseId.current) {
        console.warn('[notif-nav] ❌ 重复响应, 已消费过:', identifier);
        return;
      }
      consumedResponseId.current = identifier;

      const payload = parseNotificationPayload(
        response.notification.request.content.data,
      );
      if (payload === null) {
        console.warn('[notif-nav] ❌ parseNotificationPayload 返回 null, data:', response.notification.request.content.data);
        return;
      }

      console.warn('[notif-nav] ✅ payload 解析成功:', payload);

      const action = resolveNavigationAction(payload, c);
      console.warn('[notif-nav] resolveNavigationAction 结果:', action, 'ctx:', { isAuthenticated: c.isAuthenticated, isReady: c.isReady, sessionCount: c.sessions.length, sessionExists: c.sessions.some(s => s.id === (payload as { sessionId?: string }).sessionId) });

      if (action.kind === 'ignore') {
        if (!c.isAuthenticated) {
          setPendingNavigation(payload);
          console.warn('[notif-nav] 未认证, 已存入 pending queue');
          return;
        }
        // 已认证但 session 不存在 → toast 提示
        if (payload.type === 'chat') {
          useToastStore.getState().showToast({
            message: i18n.t('chatView.sessionNotFound', { id: `${payload.sessionId.slice(0, 8)}…` }),
            variant: 'warning',
          });
        }
        console.warn('[notif-nav] 导航被忽略 (已认证但 session 不存在)');
        return;
      }

      console.warn('[notif-nav] 🚀 执行导航:', action.kind);
      executeNavigationAction(action).catch(console.error);
    },
    [],
  );

  // ── Mechanism 1: event-based listener (registers once) ────────────
  //
  // handleResponse is stable (reads ctx from ref), so this effect runs
  // exactly once on mount. Also drains any response that was pending
  // before the listener was registered (cold-start from notification tap).
  useEffect(() => {
    if (Platform.OS === 'web') return;

    console.warn('[notif-nav] 🔔 注册 response listener (once)');

    const last = Notifications.getLastNotificationResponse();
    if (last != null && last.actionIdentifier === DEFAULT_ACTION_IDENTIFIER) {
      console.warn('[notif-nav] 📥 发现 getLastNotificationResponse:', last.notification.request.identifier);
      consumedResponseId.current = last.notification.request.identifier;
      handleResponse(last);
    } else {
      console.warn('[notif-nav] getLastNotificationResponse 为 null 或 actionIdentifier 不匹配');
    }
    Notifications.clearLastNotificationResponse();

    const sub = Notifications.addNotificationResponseReceivedListener(
      handleResponse,
    );

    return () => {
      sub.remove();
    };
  }, [handleResponse]);

  // ── Mechanism 2: useLastNotificationResponse hook (iOS fallback) ───
  //
  // On iOS, addNotificationResponseReceivedListener may not fire reliably
  // (expo/expo#14078, #18403, #31322). This hook catches missed responses.
  // Dedup via consumedResponseId prevents double-processing when both
  // mechanisms fire for the same tap.
  const lastResponse = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!lastResponse) return;

    console.warn('[notif-nav] 🪝 useLastNotificationResponse 触发:', {
      identifier: lastResponse.notification.request.identifier,
      actionIdentifier: lastResponse.actionIdentifier,
    });

    handleResponse(lastResponse);
  }, [lastResponse, handleResponse]);
}
