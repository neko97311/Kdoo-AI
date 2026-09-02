import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, Modal, Pressable, Image, useWindowDimensions, StyleSheet, ActivityIndicator,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { useI18n } from '@/hooks/useI18n';
import { useToastStore } from '@/stores/toast';
import { pauseForRecording, resumeAfterRecording } from '@/stores/tts';
import { ToastHost } from '@/components/ui/Toast';
import { shareVideo, ShareVideoError } from '@/utils/share-video';

interface Props {
  uri: string;
  /** First-frame cover from the AI-creation pipeline. Shown as an instant
   *  poster so the bubble/fullscreen never renders a black frame while the
   *  MP4 is still loading. Absent for videos without a generated cover. */
  posterUri?: string;
}

/**
 * Doubao-style AI video player:
 * - List view: shows ONLY a poster (dark) with a download icon (bottom-left)
 *   and a play icon (top-right). No live player in the list — so returning
 *   from fullscreen always shows the poster, never a black frame.
 * - Fullscreen: auto-loop, bottom timeline; play/pause (left) + volume (right)
 *   above the timeline; save (top-right); close (top-left). A SEPARATE
 *   transparent tap-layer (not wrapping the video) toggles the controls, so
 *   tapping never pauses the video by accident. Controls fade when idle.
 */
export function VideoContent({ uri, posterUri }: Props) {
  const { t } = useI18n();
  const { width: windowWidth } = useWindowDimensions();
  const player = useVideoPlayer(uri, (p) => {
    p.loop = true; // auto-loop
    p.muted = true; // silent list preview; fullscreen has the volume toggle
    p.timeUpdateEventInterval = 0.5;
  });
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Once the video has actually rendered/played, the fullscreen poster is
  // retired permanently (pausing must show the paused frame, not the poster).
  const [everPlayed, setEverPlayed] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [isMuted, setIsMuted] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durRef = useRef(0);
  const trackWidthRef = useRef(0);
  // Whether THIS component paused TTS when opening fullscreen. If the component
  // unmounts while fullscreen is still up (e.g. the chat list recycles the
  // message, or the screen unmounts), resumeAfterRecording would otherwise
  // never run and TTS would stay paused forever. The cleanup effect below uses
  // this ref to release the pause exactly once.
  const ttsPausedByVideoRef = useRef(false);

  useEffect(
    () => () => {
      if (ttsPausedByVideoRef.current) {
        ttsPausedByVideoRef.current = false;
        resumeAfterRecording();
      }
    },
    []
  );

  const bubbleContentWidth = Math.min(windowWidth - 32, 600) * 0.9 - 32 - 8;
  const width = Math.max(240, Math.min(bubbleContentWidth, 560));
  // List box uses the video's real aspect ratio once known (sourceLoad gives
  // availableVideoTracks[0].size). Until then we do NOT guess a ratio:
  //   - A 16:9 default leaves left/right black bars on 9:16 (portrait) videos
  //     under contentFit="contain".
  //   - A 9:16 default makes landscape videos flash a box ~3-4x too tall.
  // Instead, before the size is known we use a modest FIXED height with
  // contentFit="cover" (first frame fills the box, no bars), then switch to
  // the real aspect ratio + "contain" once known (box ratio == video ratio,
  // so there are never letterbox bars on any orientation).
  const hasVideoSize = !!videoSize && videoSize.height > 0;
  const ar = hasVideoSize ? videoSize.width / videoSize.height : 1;
  const height = hasVideoSize
    ? Math.min(width / ar, width * (16 / 9) * 1.4)
    : Math.min(200, Math.max(160, width * 0.56)); // fixed placeholder height
  const posterContentFit: 'cover' | 'contain' = hasVideoSize ? 'contain' : 'cover';

  useEffect(() => {
    const subs = [
      player.addListener('statusChange', ({ status }) => {
        if (status === 'error') setFailed(true);
      }),
      player.addListener('sourceLoad', ({ availableVideoTracks }) => {
        const track = Array.isArray(availableVideoTracks) && availableVideoTracks[0];
        if (track && track.size && track.size.width > 0 && track.size.height > 0) {
          setVideoSize({ width: track.size.width, height: track.size.height });
        }
      }),
      player.addListener('playingChange', ({ isPlaying }) => {
        setPlaying(isPlaying);
        if (isPlaying) setEverPlayed(true);
      }),
      player.addListener('timeUpdate', ({ currentTime }) => {
        setCur(currentTime);
        if (player.duration && player.duration !== durRef.current) {
          durRef.current = player.duration;
          setDur(player.duration);
        }
      }),
      player.addListener('playToEnd', () => setPlaying(true)),
    ];
    return () => { subs.forEach((s) => s.remove()); };
  }, [player]);

  const hideControlsSoon = () => {
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = setTimeout(() => setControlsVisible(false), 2500);
  };

  const toggleControls = useCallback(() => {
    setControlsVisible((v) => {
      const next = !v;
      if (next) hideControlsSoon();
      return next;
    });
  }, []);

  const togglePlay = useCallback(() => {
    if (playing) player.pause(); else player.play();
    hideControlsSoon();
  }, [playing, player]);

  const toggleMute = useCallback(() => {
    setIsMuted((m) => {
      player.muted = m; // m=true (currently muted) → unmute; else mute
      return !m;
    });
    hideControlsSoon();
  }, [player]);

  const openFullscreen = useCallback(() => {
    setFullscreen(true);
    setControlsVisible(true);
    hideControlsSoon();
    // 🔴 Pause auto-read-aloud (TTS) while the video plays so the two audios
    // do not overlap. The completion message itself never triggers auto-play
    // (no text-delta), but a long reply in the same session could still be
    // playing when the user opens the video. resumeAfterRecording() runs in
    // closeFullscreen to resume from the pause point.
    pauseForRecording();
    ttsPausedByVideoRef.current = true;
    // 🔴 Sound ON by default in fullscreen (Doubao-style). The list preview
    // stays muted (p.muted=true), so we MUST clear muted here — setting volume
    // alone does NOT unmute while muted is still true.
    player.muted = false;
    player.volume = 1;
    setIsMuted(false);
    setTimeout(() => player.play(), 120);
  }, [player]);

  const closeFullscreen = useCallback(() => {
    setFullscreen(false);
    // Reset so reopening starts from the beginning and the poster (list view)
    // never shows a mid-video/black frame. Pause the video FIRST (so its audio
    // stops), THEN resume auto-read-aloud (TTS) from the pause point to avoid
    // a brief audio overlap between the video and the resumed voice.
    player.pause();
    player.currentTime = 0;
    setCur(0);
    ttsPausedByVideoRef.current = false;
    resumeAfterRecording();
  }, [player]);

  const seek = (seconds: number) => {
    const d = player.duration || durRef.current || dur;
    player.currentTime = Math.max(0, Math.min(seconds, d));
    setCur(player.currentTime);
    hideControlsSoon();
  };

  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
  };

  const handleSave = useCallback(async () => {
    if (!uri || saving) return;
    setSaving(true);
    // Remember playback state so we can resume after the download/save
    // (permission dialog / media library access interrupts playback).
    const wasPlaying = playing;
    try {
      const dest = new File(Paths.cache, `ai-video-${Date.now()}.mp4`);
      await File.downloadFileAsync(uri, dest);
      // Guard against a silent empty/corrupt download.
      if (!dest.exists || dest.size <= 0) {
        throw new Error(`downloaded video is empty (${dest.size} bytes)`);
      }

      // Try saving to the device gallery first (legacy API — the top-level
      // saveToLibraryAsync is deprecated in SDK 56 and fails; the legacy
      // import matches the working image save util).
      const { status } = await MediaLibrary.requestPermissionsAsync(true);
      if (status === 'granted') {
        try {
          await MediaLibrary.saveToLibraryAsync(dest.uri);
          if (wasPlaying) player.play();
          useToastStore.getState().showToast({ message: t('chat.message.videoDownloaded'), variant: 'success' });
          return;
        } catch (e) {
          console.warn('[VideoContent] Gallery save failed, falling back to share:', e);
        }
      }
      // Fallback: open the share sheet so the user can save the video
      // anywhere (works on Expo Go / simulators where MediaLibrary fails).
      if (await Sharing.isAvailableAsync()) {
        if (wasPlaying) player.play();
        await Sharing.shareAsync(dest.uri, { mimeType: 'video/mp4' });
        return;
      }
      useToastStore.getState().showToast({ message: t('chat.message.videoDownloadFailed'), variant: 'warning' });
    } catch (e) {
      console.warn('[VideoContent] Save failed:', e);
      useToastStore.getState().showToast({ message: t('chat.message.videoDownloadFailed'), variant: 'warning' });
    } finally {
      setSaving(false);
    }
  }, [uri, saving, playing, player, t]);

  // Share the video (reference the image share util @/utils/share-image).
  // Downloads the video and opens the system share sheet. The user choosing
  // "cancel" in the share sheet resolves normally — no feedback needed.
  const handleShare = useCallback(async () => {
    if (!uri || sharing) return;
    setSharing(true);
    try {
      await shareVideo(uri);
    } catch (e) {
      const display = e instanceof ShareVideoError ? e.message : `${t('imagePreview.shareFailed')}: ${e instanceof Error ? e.message : String(e)}`;
      useToastStore.getState().showToast({ message: display, variant: 'warning' });
    } finally {
      setSharing(false);
    }
  }, [uri, sharing, t]);

  if (failed) {
    return (
      <View style={{ width, borderRadius: 8, marginTop: 4, padding: 16, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.04)' }}>
        <Text style={{ color: '#86909C', fontSize: 12 }}>{t('chat.message.videoLoadFailed')}</Text>
      </View>
    );
  }

  return (
    <>
      {/* ── Poster view (list) — shows the REAL first frame (muted, paused),
          not a black placeholder. Overlays: play (top-right), download
          (bottom-left). Video container pointerEvents="none" so touches only
          hit the overlay buttons, never pause the native video. ── */}
      <View style={{ width, marginTop: 4 }}>
        <Pressable
          onPress={openFullscreen}
          style={{ width, height, borderRadius: 8, overflow: 'hidden', backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' }}
        >
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <VideoView player={player} style={StyleSheet.absoluteFill} contentFit={posterContentFit} nativeControls={false} />
            {/* Server-provided first-frame cover — renders instantly while the
                MP4 is still loading, so the list box is never a black frame. */}
            {posterUri ? (
              <Image source={{ uri: posterUri }} style={StyleSheet.absoluteFill} resizeMode={posterContentFit} />
            ) : null}
          </View>
          {/* Top-right play icon */}
          <Pressable
            onPress={(e) => { e.stopPropagation(); openFullscreen(); }}
            hitSlop={8}
            style={[styles.fabBtn, { top: 10, right: 10 }]}
          >
            <Ionicons name="play" size={18} color="#fff" style={{ marginLeft: 2 }} />
          </Pressable>
          {/* Bottom-left download icon (icon only) */}
          <Pressable
            onPress={(e) => { e.stopPropagation(); handleSave(); }}
            disabled={saving}
            hitSlop={8}
            style={[styles.fabBtn, { bottom: 10, left: 10 }, saving && { opacity: 0.6 }]}
          >
            {saving ? <ActivityIndicator size={16} color="#fff" /> : <Ionicons name="download-outline" size={18} color="#fff" />}
          </Pressable>
        </Pressable>
      </View>

      {/* ── Fullscreen player ── */}
      <Modal visible={fullscreen} presentationStyle="fullScreen" animationType="fade" onRequestClose={closeFullscreen}>
        <View style={styles.fsRoot}>
          {/* Local ToastHost — the app-root ToastHost renders below native
              Modals, so save success/failure feedback must mount here. */}
          <ToastHost />
          {/* Video fills the screen. Container pointerEvents="none" so the
              native video NEVER receives touches (can't pause on tap); all
              interaction goes through the tap-layer + control buttons. */}
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <VideoView player={player} style={StyleSheet.absoluteFill} contentFit="contain" nativeControls={false} />
            {/* First-frame cover ABOVE the (opaque-black) VideoView until the
                video actually plays once — eliminates the black frame while
                the MP4 buffers. Retired permanently after first playback so
                pausing shows the paused frame, not the poster. */}
            {posterUri && !everPlayed ? (
              <Image source={{ uri: posterUri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
            ) : null}
          </View>

          {/* Separate transparent tap-layer ABOVE the video for toggling
              controls — tapping never triggers a native pause. */}
          <Pressable style={[StyleSheet.absoluteFill, { zIndex: 1 }]} onPress={toggleControls} />

          {/* Close (top-left) */}
          {controlsVisible && (
            <Pressable onPress={closeFullscreen} hitSlop={8} style={[styles.fsBtn, { top: 54, left: 14, zIndex: 2 }]}>
              <Ionicons name="chevron-back" size={26} color="#fff" />
            </Pressable>
          )}
          {/* Share (top-right, before the download button) */}
          {controlsVisible && (
            <Pressable onPress={handleShare} disabled={sharing} hitSlop={8}
              style={[styles.fsBtn, { top: 54, right: 66, zIndex: 2 }, sharing && { opacity: 0.6 }]}>
              {sharing ? <ActivityIndicator size={18} color="#fff" /> : <Ionicons name="share-social-outline" size={22} color="#fff" />}
            </Pressable>
          )}
          {/* Save (top-right) */}
          {controlsVisible && (
            <Pressable onPress={handleSave} disabled={saving} hitSlop={8}
              style={[styles.fsBtn, { top: 54, right: 14, zIndex: 2 }, saving && { opacity: 0.6 }]}>
              {saving ? <ActivityIndicator size={18} color="#fff" /> : <Ionicons name="download-outline" size={22} color="#fff" />}
            </Pressable>
          )}

          {/* Bottom controls */}
          {controlsVisible && (
            <View style={[styles.fsControls, { zIndex: 2 }]}>
              <View style={styles.fsControlRow}>
                <Pressable onPress={togglePlay} hitSlop={10} style={styles.fsIconBtn}>
                  <Ionicons name={playing ? 'pause' : 'play'} size={24} color="#fff" style={{ marginLeft: 2 }} />
                </Pressable>
                <Text style={styles.fsTime}>{fmt(cur)} / {fmt(dur)}</Text>
                <Pressable onPress={toggleMute} hitSlop={10} style={styles.fsIconBtn}>
                  <Ionicons name={isMuted ? 'volume-mute' : 'volume-high'} size={22} color="#fff" />
                </Pressable>
              </View>
              <Pressable
                onPress={(e) => {
                  const track = e.nativeEvent.locationX;
                  if (trackWidthRef.current > 0) seek((track / trackWidthRef.current) * (player.duration || dur));
                }}
                style={styles.fsTimeline}
                onLayout={(e) => { trackWidthRef.current = e.nativeEvent.layout.width; }}
              >
                <View style={styles.fsTimelineTrack} />
                <View
                  style={[
                    styles.fsTimelineFill,
                    { width: `${dur > 0 ? Math.min(100, (cur / dur) * 100) : 0}%` as `${number}%` },
                  ]}
                />
              </Pressable>
            </View>
          )}

          {/* Persistent "downloading" spinner — rendered whenever saving,
              INDEPENDENT of controls visibility, so the user always sees
              progress even after the control buttons auto-hide. Icon only,
              no text. */}
          {saving && (
            <View
              pointerEvents="none"
              style={[styles.fsBtn, { top: 54, right: 14, zIndex: 3, backgroundColor: 'rgba(0,0,0,0.6)' }]}
            >
              <ActivityIndicator size="small" color="#fff" />
            </View>
          )}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fabBtn: { position: 'absolute', width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  fsRoot: { flex: 1, backgroundColor: '#000' },
  fsBtn: { position: 'absolute', width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
  fsControls: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingBottom: 40, paddingTop: 12, backgroundColor: 'rgba(0,0,0,0.45)' },
  fsControlRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 },
  fsIconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  fsTime: { flex: 1, color: '#fff', fontSize: 12, fontVariant: ['tabular-nums'] },
  fsTimeline: { height: 20, justifyContent: 'center' },
  fsTimelineTrack: { position: 'absolute', left: 0, right: 0, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)' },
  fsTimelineFill: { position: 'absolute', left: 0, height: 3, borderRadius: 2, backgroundColor: '#fff' },
});
