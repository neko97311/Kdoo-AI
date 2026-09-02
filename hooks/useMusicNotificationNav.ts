/**
 * Notification-bar click → session page navigation for music playback.
 *
 * When the user taps the react-native-track-player notification (or lock
 * screen media controls content area), Android delivers an intent with
 * `data = Uri.parse("trackplayer://notification.click")` to MainActivity.
 * RN translates this into a Linking URL event.
 *
 * The `linking-interceptor` module (installed in `_layout.tsx` before
 * expo-router mounts) diverts `trackplayer://` URLs into a private channel
 * so expo-router never tries to route them (which would flash a 404).
 *
 * This hook consumes that private channel via `getTrackPlayerInitialURL()`
 * (cold start) and `addTrackPlayerURLListener()` (foreground/background),
 * reads the **active track's** `sessionId` metadata (embedded by
 * MusicCardList when building the queue), and navigates the user to the
 * originating chat session page.
 *
 * Both paths reuse the existing `notification-navigation.ts` infrastructure
 * (`resolveNavigationAction` + `executeNavigationAction`) for consistency
 * with FCM push notification navigation.
 *
 * @module hooks/useMusicNotificationNav
 */
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import {
  getTrackPlayerInitialURL,
  addTrackPlayerURLListener,
} from '@/utils/linking-interceptor';
import { ensurePlayerReady } from '@/hooks/useTrackPlayer';
import {
  NOTIFICATION_PAYLOAD_VERSION,
  resolveNavigationAction,
  executeNavigationAction,
  type NotificationPayload,
  type ResolveContext,
} from '@/services/notification-navigation';

/** RNTP notification PendingIntent URI scheme. */
const TRACKPLAYER_SCHEME = 'trackplayer://';

/**
 * Minimum interval between processing consecutive notification taps.
 * Prevents double-fire when `getInitialURL` + `addEventListener('url')`
 * both deliver the same cold-start intent.
 */
const CLICK_DEBOUNCE_MS = 800;

interface UseMusicNotificationNavArgs extends ResolveContext {}

export function useMusicNotificationNav(
  args: UseMusicNotificationNavArgs,
): void {
  // Keep the latest ctx in a ref so the Linking listener (created once)
  // always reads current auth/session state without needing to re-subscribe.
  const ctxRef = useRef(args);
  ctxRef.current = args;

  useEffect(() => {
    // Linking URL events are only relevant on native (Android/iOS).
    // On web, `trackplayer://` has no meaning.
    if (Platform.OS === 'web') return;

    const { isAuthenticated, isReady } = ctxRef.current;
    if (!isReady || !isAuthenticated) return;

    let lastProcessedAt = 0;

    /**
     * Core handler: extract sessionId from the active track and navigate.
     *
     * Guards:
     * - URL must start with `trackplayer://` (ignore deep links, FCM, etc.)
     * - Debounced to prevent double-fire on cold start
     * - Active track must have a `sessionId` field (music tracks only)
     * - Session must exist in the user's session list (resolveNavigationAction)
     */
    const handleClick = async (url: string | null): Promise<void> => {
      if (!url || !url.startsWith(TRACKPLAYER_SCHEME)) return;

      const now = Date.now();
      if (now - lastProcessedAt < CLICK_DEBOUNCE_MS) return;
      lastProcessedAt = now;

      try {
        // Wait for player setup (idempotent — cached promise after first call).
        // On cold start the player service is already running in the background
        // (appKilledPlaybackBehavior: ContinuePlayback), but the JS-side
        // setupPlayer() may not have completed yet.
        await ensurePlayerReady();

        const activeTrack = await TrackPlayer.getActiveTrack();
        if (!activeTrack) return;

        // sessionId is embedded by MusicCardList when building the queue.
        // Tracks without sessionId (e.g. from other sources) are skipped.
        const sessionId = activeTrack.sessionId;
        if (!sessionId || typeof sessionId !== 'string') return;

        const payload: NotificationPayload = {
          v: NOTIFICATION_PAYLOAD_VERSION,
          type: 'chat',
          sessionId,
        };

        const ctx = ctxRef.current;
        const action = resolveNavigationAction(payload, ctx);
        if (action.kind === 'ignore') return;

        await executeNavigationAction(action);
      } catch (e) {
        // Swallow — notification tap should never crash the app.
        // The user simply lands on whatever screen was last visible.
        console.warn('[MusicNav] Notification click navigation failed:', e);
      }
    };

    // Cold start: check if app was launched from a notification tap.
    // getTrackPlayerInitialURL() reads the ORIGINAL (un-patched)
    // getInitialURL so the interceptor filter doesn't hide it.
    getTrackPlayerInitialURL()
      .then(handleClick)
      .catch(() => {});

    // Foreground/background: each notification tap delivers a new URL event
    // via our dedicated trackplayer:// channel (filtered out of
    // expo-router's Linking listener by the interceptor).
    const unsubscribe = addTrackPlayerURLListener((url) => {
      handleClick(url);
    });

    return () => {
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.isAuthenticated, args.isReady]);
}
