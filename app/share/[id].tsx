import { useEffect, useRef } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useShareIntakeStore } from '@/stores/share-intake';
import { useToastStore } from '@/stores/toast';
import { useI18n } from '@/hooks/useI18n';
import { forkShareApi } from '@/services/session-service';
import { logger } from '@/utils/logger';

/**
 * Deep-link intake page: opened when the app is launched (or resumed)
 * via a `kdoomobile://share/{id}` or `https://.../share/{id}` link.
 *
 * Flow:
 *   1. Read `{ id }` from the route params (expo-router already mapped
 *      the incoming URL to this file because of the `[id]` segment).
 *   2. If the user is not logged in, stash the token in
 *      `useShareIntakeStore` and redirect to the login screen. The
 *      root layout watches that store: when `isAuthenticated` flips
 *      to `true` after login, it consumes the token and runs the
 *      fork automatically — so the user lands on the new session
 *      without re-tapping the share link.
 *   3. If logged in, call `POST /api/share/{id}/fork` to clone the
 *      shared conversation into a new local session, set it as the
 *      current session, and navigate to the home page.
 *
 * The `triggered` ref guards against React 18 strict-mode double-invocation
 * and against re-entry when the auth state flips after a login.
 */
export default function ShareIntakePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => !!s.user);
  const addSession = useChatStore((s) => s.addSession);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const setPendingShare = useShareIntakeStore((s) => s.setPending);
  const showToast = useToastStore((s) => s.showToast);
  const { t } = useI18n();
  const triggered = useRef(false);

  useEffect(() => {
    if (!id || triggered.current) return;
    triggered.current = true;

    if (!isAuthenticated) {
      logger.info('ShareIntake', 'unauthenticated — stash token, redirect to login', { id });
      setPendingShare(id);
      showToast({
        message: t('share.pleaseLoginFirst'),
        variant: 'warning',
      });
      router.replace('/(auth)/login');
      return;
    }

    (async () => {
      try {
        const session = await forkShareApi(id);
        // CRITICAL: use `addSession` (not just `setCurrentSession`) so
        // the new session is in the `sessions[]` list. The root layout's
        // Gate effect runs `loadSessions().then(...)` after auth init,
        // and the cleanup guard at `_layout.tsx:312-314` calls
        // `setCurrentSession(null)` if the current session isn't in the
        // loaded list — which it wouldn't be on the first load (the
        // new session was just created on the server and won't appear
        // in the cached page 0 yet). `addSession` mirrors `createSession`
        // and persists the session to SQLite.
        //
        // NOTE: `addSession` initializes `messages[session.id]` to an
        // EMPTY array, so `index.tsx`'s auto-load effect (which treats
        // `[]` as a freshly-created empty session) will NOT fetch the
        // forked conversation's history. We must load it explicitly
        // here — otherwise the forked session opens as a blank chat
        // with no message content.
        addSession(session);
        loadMessages(session.id).catch(() => {
          // Best-effort: the chat still opens; messages load on the
          // next session entry if this fetch fails.
        });
        logger.info('ShareIntake', 'fork done, session activated', {
          id,
          sessionId: session.id,
        });
        router.replace('/');
      } catch (e) {
        logger.warn('ShareIntake', 'forkShareApi failed', {
          id,
          error: e instanceof Error ? e.message : String(e),
        });
        showToast({
          message: t('share.forkFailed'),
          variant: 'warning',
        });
        router.replace('/');
      }
    })();
  }, [id, isAuthenticated, router, addSession, loadMessages, setPendingShare, showToast, t]);

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator />
    </View>
  );
}
