/**
 * Initialization + queue helpers for react-native-track-player.
 *
 * `setupPlayer()` is idempotent but must only be called while the app is in
 * the foreground on Android (RNTP throws `android_cannot_setup_player_in_
 * background` otherwise). To make this safe from any component mount order,
 * the hook guards via a module-level promise: the first caller wins and
 * every subsequent caller awaits the same in-flight setup.
 *
 * Capabilities registered here determine which buttons appear in the
 * notification bar (Android) and the iOS Now Playing Center (lock screen):
 *
 *   Play, Pause, SkipToNext, SkipToPrevious, SeekTo
 *
 * These mirror what 豆包 (Doubao) exposes — app-internal player, the
 * notification collapses when audio stops, and the lock-screen timeline is
 * draggable. `compactCapabilities` controls the 1×3 collapsed notification
 * on Android; the rest are available in the expanded view.
 *
 * @module hooks/useTrackPlayer
 */
import { useEffect, useRef } from 'react';
import TrackPlayer, {
  AppKilledPlaybackBehavior,
  Capability,
  State,
} from 'react-native-track-player';

// ── Types ──────────────────────────────────────────────────────────

export interface PlayableTrackInput {
  /** Absolute or server-relative audio URL (resolved at call time). */
  url: string;
  title: string;
  artist?: string;
  /** Artwork image URL — shown in notification + lock screen. */
  artwork?: string;
  /** Optional duration hint in seconds (filled in by RNTP once playback starts). */
  duration?: number;
  /** Free-form id used for deduplication and "is this the active track?" checks. */
  id?: string;
  /**
   * Chat session this track originated from. Stored verbatim in RNTP track
   * metadata so that a notification-bar tap can navigate the user back to
   * the session page where the music was found. Consumed by
   * `useMusicNotificationNav` (Linking URL listener for `trackplayer://`).
   */
  sessionId?: string;
}

// ── Singleton setup state ──────────────────────────────────────────

let setupPromise: Promise<void> | null = null;

export async function ensurePlayerReady(): Promise<void> {
  if (setupPromise) return setupPromise;

  // Sanity check: the default export from react-native-track-player
  // should always expose setupPlayer. If it doesn't, the most likely
  // cause is an incorrect named import (`import { TrackPlayer }`)
  // elsewhere in the app, which yields undefined at runtime.
  if (
    !TrackPlayer ||
    typeof (TrackPlayer as { setupPlayer?: unknown }).setupPlayer !== 'function'
  ) {
    throw new Error(
      '[RNTP] TrackPlayer binding is missing setupPlayer(). ' +
        'Check that react-native-track-player is imported as a default ' +
        'export (`import TrackPlayer from "react-native-track-player"`), ' +
        'not a named import.',
    );
  }

  setupPromise = (async () => {
    await TrackPlayer.setupPlayer({
      // Let the OS decide buffer/AVAudioSession category defaults. The user
      // may switch between voice calls (LiveKit) and music; RNTP will pause
      // for phone calls via RemoteDuck handled in PlaybackService.
      autoHandleInterruptions: true,
    });

    await TrackPlayer.updateOptions({
      android: {
        // 豆包-style: keep playing when user swipes the app away from recents.
        // Notification remains and can resume.
        appKilledPlaybackBehavior:
          AppKilledPlaybackBehavior.ContinuePlayback,
        // When a transient interruption ends (notification sound), give the
        // system a 5s grace period before demoting the foreground service.
        stopForegroundGracePeriod: 5,
      },
      // Capabilities MUST be declared here for the matching remote events to
      // fire in PlaybackService. The intersection of (capabilities ∩
      // notificationCapabilities) becomes the rendered button set.
      capabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
        Capability.SeekTo,
      ],
      // Buttons visible in the compact (unexpanded) Android notification.
      // iOS Now Playing Center picks from this set for its primary row.
      compactCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToNext,
      ],
      // Render these inside the expanded Android notification. Excludes
      // Stop to keep the notification persistent (豆包-style).
      notificationCapabilities: [
        Capability.Play,
        Capability.Pause,
        Capability.SkipToNext,
        Capability.SkipToPrevious,
      ],
      // Scrub accuracy in the lock-screen timeline. RNTP also uses this as
      // the jump distance for jump-forward/jump-backward remote events,
      // which we don't expose but the constant still needs to be valid.
      forwardJumpInterval: 15,
      backwardJumpInterval: 15,
      // Emit PlaybackProgressUpdated every 1s so a future in-app progress
      // bar can subscribe via useProgress() without polling.
      progressUpdateEventInterval: 1,
    });
  })().catch((err) => {
    // Allow a retry on the next call if setup fails (e.g. race with a
    // background-only boot on Android). Resetting the cache is safe because
    // setupPlayer has no side effects observable from JS on failure.
    setupPromise = null;
    throw err;
  });

  return setupPromise;
}

// ── Public hook ────────────────────────────────────────────────────

export interface UseTrackPlayerResult {
  /** Resolves once setupPlayer + updateOptions have completed. */
  ready: Promise<void>;
}

/**
 * Ensures the player is set up exactly once per app session. Safe to call
 * from multiple components — all callers await the same in-flight promise.
 *
 * NOTE: This hook deliberately does NOT subscribe to playback state in
 * React — `MusicCardList` only needs to know whether a SPECIFIC track id is
 * the active one, which it reads via `TrackPlayer.getActiveTrack()` on tap
 * (imperative, no re-render needed). If a future component needs reactive
 * state, use RNTP's `useActiveTrack()` / `usePlaybackState()` hooks instead.
 */
export function useTrackPlayer(): UseTrackPlayerResult {
  const localReady = useRef<Promise<void> | null>(null);
  if (!localReady.current) {
    localReady.current = ensurePlayerReady();
  }

  // No-op teardown. Player outlives any single component so the user can
  // background the app while audio keeps playing.
  useEffect(() => {
    void localReady.current;
  }, []);

  return { ready: localReady.current };
}

// ── Queue helpers (callable without React) ─────────────────────────

/**
 * Replace the queue with a single track and start playback immediately.
 *
 * Convenience wrapper around [playTracksFromIndex] for the single-track
 * case.
 *
 * @param input Track to play. `url` may be absolute or server-relative;
 *   the caller is responsible for any needed URL resolution (this helper
 *   keeps the URL verbatim so it works for both remote and `file://` paths).
 */
export async function playTrackNow(input: PlayableTrackInput): Promise<void> {
  await playTracksFromIndex([input], 0);
}

/**
 * Replace the queue with multiple tracks and start from `startIndex`.
 *
 * Why a multi-track queue matters: Android's MediaSession hides the
 * notification "next" button when `hasNext()` returns false, i.e. when
 * the queue has only one item. Enqueuing all playable results keeps
 * next/previous visible so the notification matches the 豆包 (Doubao) UX.
 *
 * @param tracks Full queue to load (must be non-empty).
 * @param startIndex Zero-based index of the track to begin playback from.
 *   Clamped to `[0, tracks.length - 1]`.
 */
export async function playTracksFromIndex(
  tracks: PlayableTrackInput[],
  startIndex: number = 0,
): Promise<void> {
  await ensurePlayerReady();
  if (tracks.length === 0) return;

  // reset() clears the queue AND stops playback. Cleaner than add() + skip()
  // because it guarantees no leftover sibling tracks from a previous tap.
  await TrackPlayer.reset();

  // Batch-add all tracks in one call so RNTP sets up the full queue atomically.
  await TrackPlayer.add(tracks);

  const clampedIndex = Math.max(0, Math.min(startIndex, tracks.length - 1));
  if (clampedIndex > 0) {
    await TrackPlayer.skip(clampedIndex);
  }

  await TrackPlayer.play();
}

/**
 * Pause playback. No-op if the player is already paused or no track is loaded.
 */
export async function pausePlayback(): Promise<void> {
  await ensurePlayerReady();
  await TrackPlayer.pause();
}

/**
 * Toggle play/pause based on the current state. Returns the new effective
 * "isPlaying" boolean so callers can update UI without an extra round-trip.
 */
export async function togglePlayback(): Promise<boolean> {
  await ensurePlayerReady();
  const state = await TrackPlayer.getPlaybackState();
  // State.Playing → user expects pause; anything else (Paused, Ended,
  // Ready, None) → user expects play (resumes from current position).
  const isPlaying = state.state === State.Playing;
  if (isPlaying) {
    await TrackPlayer.pause();
    return false;
  }
  await TrackPlayer.play();
  return true;
}

/**
 * Stop and clear the queue. Used on logout / session-expiry cleanup to
 * ensure no audio lingers after the user signs out (the notification
 * would otherwise persist with stale data).
 *
 * GUARD: if the player was never initialized this app session
 * (`setupPromise` still null), return WITHOUT initializing it. Forcing
 * `setupPlayer()` purely for cleanup would leave a live player +
 * foreground service behind for a user who never played any music.
 */
export async function stopAndClearQueue(): Promise<void> {
  if (!setupPromise) return;
  await setupPromise;
  await TrackPlayer.reset();
}
