// Polyfill Appearance.setColorScheme for web — react-native-css and nativewind
// call it during module init but it doesn't exist on the web polyfill.
import { Appearance } from 'react-native';
if (!Appearance.setColorScheme) {
  Appearance.setColorScheme = () => {};
}

// Install Linking interceptor BEFORE expo-router mounts its navigation
// container. This patches Linking.getInitialURL and addEventListener to
// filter `trackplayer://` URLs so expo-router doesn't flash a 404 page
// when the user taps the music notification bar.
//
// ESM hoists all imports before the module body runs, so this call
// executes before `import { Stack } from 'expo-router'` is used in JSX.
import { installLinkingInterceptor, addShareIntoListener } from '@/utils/linking-interceptor';
installLinkingInterceptor();

import '../global.css';

// LiveKit: register WebRTC globals — must run before any LiveKit component loads
import { registerGlobals } from '@livekit/react-native';
registerGlobals();

// react-native-track-player: register the background playback service at
// module scope so it is alive before any component mounts. The factory
// callback MUST be a require() that returns the service handler function;
// RNTP keeps a long-lived reference and Metro/Expo bundler needs a stable
// module id. Registering inside useEffect is too late — the first call to
// TrackPlayer.add() would race against service startup on Android.
//
// The service itself (services/PlaybackService.ts) subscribes to Remote*
// events (notification bar taps, lock-screen buttons, Bluetooth media keys,
// iOS Now Playing Center, AudioFocus changes). It runs in a headless JS
// context that survives backgrounding — DO NOT inline it here.
import TrackPlayer from 'react-native-track-player';
TrackPlayer.registerPlaybackService(
  () => require('../services/PlaybackService').PlaybackService,
);

import { LogBox } from 'react-native';
LogBox.ignoreLogs([
  'Console Error',
  '[promise] Unhandled rejection',
  'ConnectionError',
  'ServerUnreachable',
  'fetch failed: java.net.ConnectException',
  'ping timeout triggered',
]);

import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, View } from 'react-native';
import Constants from 'expo-constants';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore, LAST_SESSION_KEY } from '@/stores/auth';
import { useChatStore } from '@/stores/chat';
import { useShareIntakeStore } from '@/stores/share-intake';
import { presentIncomingShare, sendPendingShareContent } from '@/utils/share-intake-send';
import { ShareIntoModal } from '@/components/share-into/ShareIntoModal';
import { replayUnsyncedTranscripts } from '@/stores/voice';
import { initDb, isDbReady } from '@/lib/db';
import { reconcileCurrentSessionId } from '@/lib/session-reconcile';
import { Loading } from '@/components/ui';
import { MessageListSkeleton } from '@/components/chat/MessageListSkeleton';
import { ToastHost } from '@/components/ui/Toast';
import { UpdateModal } from '@/components/ui/UpdateModal';
import { VoiceCallModal } from '@/components/voice/VoiceCallModal';
import { useI18n } from '@/hooks/useI18n';
import { useToastStore } from '@/stores/toast';
import { forkShareApi } from '@/services/session-service';
import { useAppUpdate } from '@/hooks/useAppUpdate';
import { ThemeProvider } from '@/hooks/useTheme';
import { initializeLocale, setI18nLocale } from '@/i18n';
import { registerForPushNotifications, registerForegroundNotificationListener } from '@/services/notifications';
import { initNewsIfNeeded } from '@/hooks/useNewsRecommendations';
import { useNotificationNavigation } from '@/hooks/useNotificationNavigation';
import { useMusicNotificationNav } from '@/hooks/useMusicNotificationNav';
import { registerNotificationBackgroundTask } from '@/services/notification-background-task';
import { installGlobalErrorHooks, logger } from '@/utils/logger';

installGlobalErrorHooks();
import {
  consumePendingNavigation,
  resolveNavigationAction,
  executeNavigationAction,
  loadPendingFromStorage,
  clearPendingFromStorage,
  clearPendingNavigation,
} from '@/services/notification-navigation';

// Prevent native splash from auto-hiding — we'll hide it manually once
// auth init + session cache are ready (SWR pattern). No-op on web.
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const { isAuthenticated, isInitialized, initialize } = useAuthStore();
  const { t } = useI18n();
  const { state: updateState, check: checkUpdate, dismiss: dismissUpdate } = useAppUpdate();

  const loadSessions = useChatStore((s) => s.loadSessions);
  const setCurrentSession = useChatStore((s) => s.setCurrentSession);
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);

  // ── Derived gate ───────────────────────────────────────────────────
  //
  // isReady is derived purely from actual render-time state:
  //   isReady = isInitialized
  //           && (not authenticated                     → show login
  //               || has currentSessionId                → cached/skeleton
  //               || restoredAuth === isAuthenticated    → restore attempted)
  //
  // On re-login, onLoginSuccess() pre-restores currentSessionId from
  // AsyncStorage BEFORE flipping isAuthenticated. So when the gate
  // opens, index renders ChatView directly (with skeleton) — no
  // ChatHome flash, no Loading.
  //
  // The Stack.Protected swap animation (login → index) is disabled
  // via `animation: 'none'` on those screens — see the Stack below.
  const [restoredAuth, setRestoredAuth] = useState<boolean | null>(null);
  const [lastSeenAuth, setLastSeenAuth] = useState(isAuthenticated);

  // Synchronous reset when auth changes — React re-renders immediately
  // without committing the intermediate frame (no visual flash).
  if (isAuthenticated !== lastSeenAuth) {
    setLastSeenAuth(isAuthenticated);
    setRestoredAuth(null);
  }

  const isReady = !!(
    isInitialized &&
    (!isAuthenticated || currentSessionId || restoredAuth === isAuthenticated)
  );

  useEffect(() => {
    // Preheat nitro-markdown module graph during app init to eliminate
    // FOUC (Flash of Unstyled Content) on first chat render.
    //
    // MarkdownRenderer.native.tsx wraps Markdown/MarkdownStream in
    // React.lazy(() => import(...)) because a static top-level import
    // triggers installWorkletsSupport() → recursive NitroModules proxy
    // → stack overflow at boot. The lazy import defers evaluation safely,
    // but on first chat render the async import hasn't resolved yet, so
    // <Suspense fallback={<Text>}> briefly shows raw unstyled text before
    // the real Markdown component swaps in.
    //
    // This fire-and-forget import() kicks off module evaluation during the
    // splash-screen phase (while auth/session restore runs). By the time
    // the user sees the chat UI, the module is cached and React.lazy()
    // resolves synchronously — no fallback, no FOUC.
    if (Platform.OS !== 'web') {
      void import('react-native-nitro-markdown').catch(() => {});
    }
    initialize();
  }, []);

  useEffect(() => {
    initializeLocale().then((locale) => {
      setI18nLocale(locale);
    });
  }, []);

  // Push notification registration: cold-start, foreground retry, and token rotation
  // expo-notifications is not available on Web — skip entirely.
  useEffect(() => {
    logger.debug('push', `useEffect 触发: isInitialized=${isInitialized} isAuthenticated=${isAuthenticated}`);
    if (Platform.OS === 'web' || !isInitialized || !isAuthenticated) {
      logger.debug('push', 'useEffect 跳过: 认证未就绪');
      return;
    }

    registerForPushNotifications(true);

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        registerForPushNotifications();
      }
    });

    const tokenSub = Notifications.addPushTokenListener(() => {
      registerForPushNotifications();
    });

    // 前台通知接收探针 — 记录 app 在前台时收到的推送
    const notifSub = registerForegroundNotificationListener();

    return () => {
      appStateSub.remove();
      tokenSub.remove();
      notifSub.remove();
    };
  }, [isInitialized, isAuthenticated]);

  // Today news preload: 判断今天有没有拉过，未拉则后台拉取（每日刷新一次）
  // 登录成功（isAuthenticated: false → true）时强制重拉，避免沿用前一用户数据
  const prevWasAuthedRef = useRef(false);
  useEffect(() => {
    if (Platform.OS === 'web' || !isInitialized || !isAuthenticated) {
      prevWasAuthedRef.current = isAuthenticated;
      return;
    }
    // 登录成功（上一次 false 当前 true）→ force=true 强制重拉 + 重置 clicked
    const forceLogin = !prevWasAuthedRef.current && isAuthenticated;
    prevWasAuthedRef.current = isAuthenticated;
    initNewsIfNeeded(forceLogin).catch((e) => {
      logger.warn('news', 'initNewsIfNeeded failed', e);
    });
  }, [isInitialized, isAuthenticated]);

  // ── Share-into wakeup: content shared into the app ──────────────
  //
  // Registers a listener for system-share-sheet wakeups. When the app is
  // opened via `kdoomobile://expo-sharing`, send the shared content to the
  // chat (stashing it first if the user is logged out).
  useEffect(() => {
    const unsubscribe = addShareIntoListener(() => {
      void presentIncomingShare();
    });
    return unsubscribe;
  }, []);

  // ── Share-link intake: login-resume ─────────────────────────────
  //
  // When the user taps a `kdoomobile://share/{id}` link while not
  // logged in, `app/share/[id].tsx` stashes the token in
  // `useShareIntakeStore` and redirects to the login screen. This
  // effect watches the store: as soon as `isAuthenticated` flips to
  // `true` AND the store still has a pending token, we consume it
  // (atomically read-and-clear), fork the share via the API, set the
  // new session as current, and route to the home page.
  //
  // We rely on `consume()` to be idempotent so this is safe to call
  // even if the user logs in and out across the same share token.
  const consumeShareIntake = useShareIntakeStore((s) => s.consume);
  const addSessionForIntake = useChatStore((s) => s.addSession);
  const loadMessagesForIntake = useChatStore((s) => s.loadMessages);
  const showIntakeToast = useToastStore((s) => s.showToast);
  useEffect(() => {
    if (Platform.OS === 'web' || !isInitialized || !isAuthenticated) return;
    const pendingToken = consumeShareIntake();
    if (!pendingToken) return;
    logger.info('ShareIntake', 'login-resume: consume pending share token', { pendingToken });
    (async () => {
      try {
        const session = await forkShareApi(pendingToken);
        // Same fix as `app/share/[id].tsx`: use `addSession` (not just
        // `setCurrentSession`) so the new session lands in `sessions[]`
        // before the Gate effect's `loadSessions` cleanup guard runs.
        addSessionForIntake(session);
        // `addSession` initializes `messages[session.id]` to an empty
        // array, so `index.tsx`'s auto-load logic treats it as a
        // freshly-created empty session and will NOT fetch the forked
        // conversation's history — load it explicitly or the forked
        // session opens blank.
        loadMessagesForIntake(session.id).catch(() => {
          // Best-effort: messages fetch on next session entry on failure.
        });
        logger.info('ShareIntake', 'login-resume fork done, session activated', {
          pendingToken,
          sessionId: session.id,
        });
        router.replace('/');
      } catch (e) {
        logger.warn('ShareIntake', 'login-resume forkShareApi failed', {
          pendingToken,
          error: e instanceof Error ? e.message : String(e),
        });
        showIntakeToast({ message: t('share.forkFailed'), variant: 'warning' });
        router.replace('/');
      }
    })();
    // `consume`/`addSession` are stable zustand actions; `showToast`,
    // `t`, `router` are also stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialized, isAuthenticated]);

  // ── Share-into login-resume: send content stashed while logged out ─
  //
  // When a share arrived while logged out, presentIncomingShare stashed
  // it in the intake store. Once authenticated, flush it to the chat.
  // sendPendingShareContent is idempotent (no-op with nothing pending).
  useEffect(() => {
    if (Platform.OS === 'web' || !isInitialized || !isAuthenticated) return;
    void sendPendingShareContent();
  }, [isInitialized, isAuthenticated]);

  // ── Session restore + background refresh ──────────────────────────
  //
  // Runs when auth state changes or initialization completes.
  //
  // Cold start (MMKV has cache):
  //   currentSessionId is already set from MMKV persist (synchronous).
  //   Gate opens immediately — ChatView shows cached messages.
  //   Background: initDb → hydrateFromSQLite → loadSessions (refresh).
  //
  // Re-login (MMKV cleared on logout):
  //   currentSessionId is null. Gate stays closed (Loading) while
  //   AsyncStorage restores the last session ID (~20ms). Once set,
  //   gate opens → ChatView shows skeleton (messagesNotLoaded) →
  //   background refresh fills data from API.
  useEffect(() => {
    if (!isInitialized || !isAuthenticated) return;

    const chatState = useChatStore.getState();
    logger.info('Gate', 'effect fire', {
      isInitialized,
      isAuthenticated,
      hasCachedSessionId: !!chatState.currentSessionId,
      cachedSessionsCount: chatState.sessions.length,
      cachedMessagesKeys: Object.keys(chatState.messages),
    });

    // ── Background refresh chain (shared by both paths) ──────────
    const runBackgroundRefresh = () => {
      const userId = useAuthStore.getState().user?.id;
      const tDb = Date.now();
      logger.info('Gate', `initDb START userId=${userId ?? 'null'}`);
      const hydratePromise = userId
        ? initDb(userId)
            .then(() => {
              logger.info('Gate', `initDb done @ ${Date.now() - tDb}ms, isDbReady=${isDbReady()}`);
              return useChatStore.getState().hydrateFromSQLite();
            })
            .then(() => {
              const after = useChatStore.getState();
              logger.info('Gate', `hydrateFromSQLite done @ ${Date.now() - tDb}ms`, {
                sessionsCount: after.sessions.length,
                messagesCount: after.currentSessionId
                  ? after.messages[after.currentSessionId]?.length ?? 'undefined'
                  : 0,
              });
            })
            .catch((e) => logger.warn('Restore', 'SQLite hydrate failed', e))
        : Promise.resolve();

      hydratePromise.then(() => {
        const tApi = Date.now();
        replayUnsyncedTranscripts().catch((e) =>
          logger.warn('Restore', 'transcript replay failed', e),
        );
        loadSessions()
          .then(() => {
            const { currentSessionId: savedId, sessions } = useChatStore.getState();
            logger.info('Gate', `loadSessions done @ ${Date.now() - tApi}ms`, {
              sessionsCount: sessions.length,
              savedIdStillExists: savedId ? sessions.some((s) => s.id === savedId) : 'no-saved',
            });
            const reconciled = reconcileCurrentSessionId(savedId, sessions);
            if (reconciled !== savedId) {
              setCurrentSession(reconciled);
            }
          })
          .catch((e) => logger.warn('Restore', 'Background refresh failed', e));

        // Background refresh current session messages — merge mode so we
        // don't lose local optimistic messages whose SQLite sync was lost
        // when the OS killed the app. This closes the gap where MMKV had
        // 8 messages but SQLite had 4 and no API refresh was triggered
        // (because cursors were restored from MMKV).
        const { currentSessionId: cid } = useChatStore.getState();
        if (cid) {
          const loadMessages = useChatStore.getState().loadMessages;
          loadMessages(cid, { backgroundRefresh: true })
            .then(() => {
              logger.info('Gate', `background loadMessages done @ ${Date.now() - tApi}ms`);
            })
            .catch((e) => logger.warn('Restore', 'Background loadMessages failed', e));
        }
      });
    };

    // ── Fast path: MMKV has cached session ───────────────────────
    if (chatState.currentSessionId) {
      logger.info('Gate', 'MMKV has currentSessionId → fast open (no Loading)');
      setRestoredAuth(isAuthenticated);
      runBackgroundRefresh();
      return;
    }

    // ── Slow path: no cached session (re-login / first login) ────
    logger.info('Gate', 'no cached session → restoring...');
    (async () => {
      const t0 = Date.now();

      // Try AsyncStorage restore (last_session_id)
      try {
        const savedSessionId = await AsyncStorage.getItem(LAST_SESSION_KEY);
        logger.info('Gate', `AsyncStorage restored sessionId: ${savedSessionId} (${Date.now() - t0}ms)`);
        if (savedSessionId && !useChatStore.getState().currentSessionId) {
          setCurrentSession(savedSessionId);
        }
      } catch (e) {
        logger.warn('Restore', 'AsyncStorage fallback failed', e);
      }

      // No saved session → show home page (ChatHome).
      // Session list is loaded by runBackgroundRefresh below; the
      // drawer will populate in the background.
      setRestoredAuth(isAuthenticated);
      logger.info('Gate', `restoredAuth=${isAuthenticated} @ ${Date.now() - t0}ms`);
      runBackgroundRefresh();
    })();
  }, [isInitialized, isAuthenticated]);

  // Hide native splash screen once app content is ready to render.
  // On native, the splash covers the <Loading> fallback so the user
  // sees a smooth splash → content transition instead of a spinner.
  useEffect(() => {
    if (isInitialized && isReady) {
      SplashScreen.hideAsync().catch(() => {});
    }
  }, [isInitialized, isReady]);

  // Save current session ID to AsyncStorage (only after ready).
  // NOTE: intentionally do NOT remove the key when currentSessionId
  // becomes null — during logout, the chat store resets (currentSessionId
  // → null) BEFORE isAuthenticated flips to false, which would prematurely
  // delete the key and break session restore on re-login. The restored ID
  // is validated against the loaded session list after loadSessions.
  useEffect(() => {
    if (!isAuthenticated || !isReady) return;
    if (currentSessionId) {
      AsyncStorage.setItem(LAST_SESSION_KEY, currentSessionId);
    }
  }, [currentSessionId, isAuthenticated, isReady]);

  // Cold-start version check (skipped in __DEV__ and deduped inside the hook)
  useEffect(() => {
    if (isInitialized) {
      checkUpdate();
    }
  }, [isInitialized, checkUpdate]);

  // Notification navigation: register listeners (safe to always call — hook
  // guards via isReady dependency; won't process navigation until ready)
  useNotificationNavigation({ isAuthenticated, isReady, sessions });

  // Music notification-bar click → session page navigation.
  // Listens for `trackplayer://` URL events (notification content area tap)
  // and navigates to the active track's originating chat session.
  useMusicNotificationNav({ isAuthenticated, isReady, sessions });

  // Consume pending navigation (memory queue + AsyncStorage bridge) once the
  // app is ready and authenticated.
  useEffect(() => {
    if (!isReady || !isAuthenticated) return;

    (async () => {
      // 1. Consume memory queue (foreground/background tap while app was running)
      const pending = consumePendingNavigation();
      if (pending) {
        const action = resolveNavigationAction(pending, { isAuthenticated, isReady, sessions });
        if (action.kind !== 'ignore') {
          await executeNavigationAction(action);
        }
      }

      // 2. Consume AsyncStorage bridge (Android killed-state background task)
      const stored = await loadPendingFromStorage();
      if (stored) {
        const action = resolveNavigationAction(stored, { isAuthenticated, isReady, sessions });
        if (action.kind !== 'ignore') {
          await executeNavigationAction(action);
        }
        await clearPendingFromStorage();
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, isAuthenticated]);

  // Register Android-only background task for killed-state notification taps
  useEffect(() => {
    registerNotificationBackgroundTask();
  }, []);

  // G9: clear stale pending notifications on logout
  const prevAuthRef = useRef(isAuthenticated);
  useEffect(() => {
    const wasAuthenticated = prevAuthRef.current;
    if (wasAuthenticated && !isAuthenticated) {
      clearPendingNavigation();
      clearPendingFromStorage();
    }
    prevAuthRef.current = isAuthenticated;
  }, [isAuthenticated]);

  // Gate closed: covers app start and session restoration.
  // - Not authenticated → Loading spinner (AsyncStorage initialize)
  // - Authenticated but session not ready → skeleton (session restore)
  //
  // The skeleton → ChatView transition is visually seamless: ChatView
  // also shows MessageListSkeleton while messagesNotLoaded, so the user
  // sees continuous skeleton bubbles until real messages fill in.
  if (!isReady) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          {isAuthenticated ? (
            <View className="flex-1 bg-white dark:bg-[#0f1117]">
              <SafeAreaView style={{ flex: 1 }} edges={['top']}>
                <MessageListSkeleton count={6} />
              </SafeAreaView>
            </View>
          ) : (
            <Loading fullScreen message={t('app.loading')} />
          )}
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <StatusBar style="auto" />
          <View className="flex-1 bg-aura-surface">
            <SafeAreaView style={{ flex: 1 }} edges={['top']}>
              {/* animation: 'fade' (not iOS-default slide) avoids the brief
                  flash of the outgoing screen's ScreenHeader at the left
                  edge during push transition. index and (auth) override
                  with 'none' so the Stack.Protected swap on login/logout
                  is instant. */}
              <Stack screenOptions={{ headerShown: false, animation: 'none' }}>
                <Stack.Protected guard={isAuthenticated}>
                  <Stack.Screen name="index" options={{ animation: 'none' }} />
                  <Stack.Screen name="search-chats" />
                  <Stack.Screen name="profile-settings" />
                  <Stack.Screen name="account-settings" />
                  <Stack.Screen name="login-methods" />
                  <Stack.Screen name="change-password" />
                  <Stack.Screen name="report-problem" />
                  <Stack.Screen name="debug" />
                  <Stack.Screen name="open-source-licenses" />
                  <Stack.Screen name="memory" />
                  {/* Full-screen capture / caption flow: immersive via the
                      native stack so react-native-screens hides the status
                      bar while either screen is focused — no clock strip
                      over the viewfinder or photo. The bar returns
                      automatically when popping back to chat. */}
                  {/* Each screen also imperatively re-hides the status bar once
                      its push transition settles: react-native-screens applies
                      window traits per-screen, and the previous screen's
                      fragment lifecycle briefly re-shows the bar after the push
                      animation finishes. */}
                  <Stack.Screen name="camera" options={{ statusBarHidden: true }} />
                  <Stack.Screen name="photo-compose" options={{ statusBarHidden: true }} />
                </Stack.Protected>

                <Stack.Protected guard={!isAuthenticated}>
                  <Stack.Screen name="(auth)" options={{ animation: 'none' }} />
                </Stack.Protected>

                {/* Legal pages — accessible to all users */}
                <Stack.Screen name="terms-of-service" />
                <Stack.Screen name="privacy-policy" />
                <Stack.Screen name="webview" />
              </Stack>
            </SafeAreaView>
            <UpdateModal
              visible={updateState.visible}
              currentVersion={Constants.expoConfig?.version ?? '0.0.0'}
              latestVersion={updateState.latestVersion}
              releaseNotes={updateState.releaseNotes}
              downloadUrl={updateState.downloadUrl}
              onDismiss={dismissUpdate}
            />
            <VoiceCallModal />
            <ShareIntoModal />
            <ToastHost />
          </View>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
