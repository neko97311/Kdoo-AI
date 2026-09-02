/**
 * Background playback service for react-native-track-player.
 *
 * This module runs in the JS context that backs the OS media notification,
 * NOT inside any React component. It subscribes to "Remote*" events emitted
 * by the notification bar (Android), the iOS Now Playing Center (lock screen
 * / Control Center), Bluetooth media buttons, Android Auto, etc., and
 * translates them into TrackPlayer commands.
 *
 * Lifecycle:
 *   1. `app/_layout.tsx` calls `TrackPlayer.registerPlaybackService(() =>
 *      require('./services/PlaybackService').PlaybackService)` at module
 *      scope. The require() must NOT be inlined — RNTP keeps a long-lived
 *      reference and Metro/Expo's bundler needs a stable module id.
 *   2. RNTP boots the service when `setupPlayer()` resolves and keeps it
 *      alive for the lifetime of the player (including background).
 *
 * Scope: this file MUST stay free of React imports. Any side-effect imports
 * that touch React/NativeWind will crash the headless JS bundle on Android.
 *
 * @module services/playback-service
 */
import TrackPlayer, { Event } from 'react-native-track-player';

/**
 * The service handler that RNTP invokes. Returning a resolved promise signals
 * that initial event wiring is complete; RNTP does not await it for ongoing
 * playback (event listeners stay registered for the process lifetime).
 */
export async function PlaybackService(): Promise<void> {
  // ── Transport controls (notification + lock screen + Bluetooth) ────────
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    // 音乐恢复播放时 TTS 必须让路：若 TTS 正在播报，停掉它（含清除
    // duck 标志，防止 TTS 拆除路径随后又对音乐队列 play() 一次）。
    // 动态 import 保持本文件的 headless bundle 零 React 依赖约束 ——
    // 绝不能在这里静态 import stores/tts（zustand → react）。
    void (async () => {
      try {
        const { releaseMusicDuck } = await import('@/utils/audio-coordination');
        releaseMusicDuck();
        const { useTtsStore } = await import('@/stores/tts');
        useTtsStore.getState().stopTtsPlayback();
      } catch {
        // TTS 停止失败最多导致短暂叠音，不能让 RemotePlay 崩溃。
      }
    })();
    TrackPlayer.play();
  });
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());

  // Next/Previous reflect the queue order managed by useTrackPlayer.
  //
  // Boundary guard (next): Android's MediaSession hides the next button
  // whenever the active track is the LAST item in the queue. MusicCardList
  // compensates by always appending a padding track (id suffixed with
  // `#pad`, duplicate of the last real song) so the button stays visible.
  // We peek at the would-be next item BEFORE calling skipToNext: if it's
  // the padding track or out of bounds, we don't move. This makes the
  // press feel like a true no-op — no audio glitch, no position reset, no
  // metadata flicker (per product decision: "button always shows, click is
  // no-op when there's no real next").
  //
  // Boundary guard (prev): the prev button is hidden at index 0 by
  // MediaSession, but Bluetooth media keys can still fire RemotePrevious,
  // so we swallow at index 0.
  TrackPlayer.addEventListener(Event.RemoteNext, async () => {
    const [queue, currentIndex] = await Promise.all([
      TrackPlayer.getQueue(),
      TrackPlayer.getActiveTrackIndex(),
    ]);
    if (currentIndex === null) return;
    const next = queue[currentIndex + 1];
    // Next is padding or out of bounds → no-op. The active track stays
    // where it is; no skipToNext is invoked.
    if (!next || next.id?.endsWith('#pad')) {
      return;
    }
    await TrackPlayer.skipToNext().catch(() => {});
  });
  TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
    const currentIndex = await TrackPlayer.getActiveTrackIndex();
    if (currentIndex === null || currentIndex <= 0) {
      // At or before the first track — no-op.
      return;
    }
    await TrackPlayer.skipToPrevious().catch(() => {});
  });

  // ── Seek (lock-screen timeline scrubbing) ─────────────────────────────
  TrackPlayer.addEventListener(Event.RemoteSeek, (event) =>
    TrackPlayer.seekTo(event.position),
  );

  // ── Audio interruption handling ───────────────────────────────────────
  //
  // Event.RemoteDuck fires on iOS AVAudioSession interruptions (phone call,
  // Siri, another app playing audio, etc.) and on Android AudioFocus changes.
  //
  //   permanent=true  → another app stole focus permanently (pause + duck)
  //   permanent=false → transient duck (e.g. notification sound) — just lower
  //                     volume; paused=true means we should pause temporarily
  //                     and resume when the system says it's OK.
  TrackPlayer.addEventListener(Event.RemoteDuck, async (event) => {
    if (event.permanent) {
      await TrackPlayer.pause();
      return;
    }
    if (event.paused) {
      await TrackPlayer.pause();
      return;
    }
    if (typeof event.volumeMultiplier === 'number') {
      // Transient volume ducking (e.g. notification chime). RNTP's underlying
      // ExPlayer/AudioSession handles this on most platforms, but we set the
      // volume explicitly to honor the OS hint.
      await TrackPlayer.setVolume(event.volumeMultiplier);
    }
  });
}
