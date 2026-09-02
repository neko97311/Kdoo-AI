/**
 * Vertical music results list for chat messages.
 *
 * Renders music search tool output as a vertical list of compact framed
 * cards. Each card has a square (1:1) thumbnail on the left and
 * title/author/duration on the right, wrapped in a light bordered
 * container so each track reads as a distinct unit.
 *
 * Tapping a track hands it off to react-native-track-player:
 *   - Active + playing  → pause
 *   - Active + paused   → resume
 *   - Inactive          → replace queue with this track and play
 *
 * TrackPlayer runs in a headless background service (registered in
 * `_layout.tsx` + `services/PlaybackService.ts`) so audio keeps playing
 * after the user backgrounds the app, and the OS notification bar / iOS
 * lock screen / Control Center / Bluetooth media keys all reflect the
 * current track and can control it. This is the 豆包 (Doubao) style UX.
 *
 * Used by ChatBubble.tsx to render musicSearchTool output.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  Linking,
  Platform,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import {
  State,
  useActiveTrack,
  usePlaybackState,
} from 'react-native-track-player';
import { useI18n } from '@/hooks/useI18n';
import { useToastStore } from '@/stores/toast';
import {
  pausePlayback,
  playTracksFromIndex,
  useTrackPlayer,
  type PlayableTrackInput,
} from '@/hooks/useTrackPlayer';
import { useTtsStore } from '@/stores/tts';
import { releaseMusicDuck } from '@/utils/audio-coordination';

// ── Types ────────────────────────────────────────────────────────

export interface MusicResult {
  title: string;
  url: string;
  thumbnail?: string;
  duration?: string;
  author?: string;
  description?: string;
  publishedDate?: string;
  /** Locally-cached MP3 download URL (server-relative or absolute). */
  previewUrl?: string;
}

interface MusicCardListProps {
  results: MusicResult[];
  /**
   * Chat session this music result belongs to. Embedded into every track
   * in the playback queue so that a notification-bar tap can navigate the
   * user back to this session. Threaded from ChatMessage.sessionId via
   * ChatBubble → renderContent → MusicCardList.
   */
  sessionId?: string;
  /**
   * Whether to auto-start playback of the first track when this list's
   * results first arrive. Mirrors the Doubao "search → auto-play" UX.
   *
   * Named `autoPlayOnArrival` (NOT `autoPlay`) on purpose: the auth
   * store's `chatSetting.autoPlay` is the TTS auto-read-aloud toggle
   * and is unrelated to music. Music auto-play is gated by message
   * freshness (caller passes `isActiveStreaming`), NOT by the user's
   * TTS preference — so toggling the header play icon does NOT turn
   * music auto-play on/off. Music auto-plays whenever the AI returns
   * fresh music search results, regardless of the TTS setting.
   *
   * Interaction rules (豆包-style, see useEffect + stopTtsBeforeMusicStart):
   *   - Module-level Set dedupes by queue head URL, so the same result
   *     batch never auto-plays twice across re-mounts.
   *   - Fresh results REPLACE whatever is sounding: any in-flight music
   *     or TTS read-aloud is stopped before the first track starts
   *     ("search new song → play new song" semantics).
   *   - Still runs the notification permission gate so the media
   *     notification bar can render.
   */
  autoPlayOnArrival?: boolean;
}

/** Number of results shown before the "expand" button. */
const COLLAPSED_COUNT = 3;

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Resolve a potentially-relative audio URL to an absolute one.
 * Backend returns `/api/user/v1/oss/download/music/{uuid}.mp3` (public,
 * no auth). TrackPlayer needs an absolute URL to stream from.
 */
function resolveAudioUrl(uri: string): string {
  if (!uri) return uri;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  if (uri.startsWith('/')) {
    const base = process.env.EXPO_PUBLIC_API_URL || '';
    return `${base}${uri}`;
  }
  return uri;
}

/**
 * Ensure the OS notification permission is granted before starting music
 * playback so the media notification bar can render.
 *
 * `_layout.tsx` already requests POST_NOTIFICATIONS at login via
 * registerForPushNotifications(). This helper covers the case where the
 * user denied that initial prompt: when they tap play on a music card,
 * re-request once. On Android, after two denials the system stops
 * showing the dialog — in that case we silently proceed; playback still
 * works, only the notification bar stays hidden.
 *
 * Never throws and never blocks playback: the worst case is the
 * notification bar not showing, which is strictly better than refusing
 * to play audio.
 */
async function ensureNotificationPermissionForPlayback(): Promise<void> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return;
    if (current.canAskAgain) {
      await Notifications.requestPermissionsAsync();
    }
    // If canAskAgain is false, the user has permanently denied. Don't
    // block — playback still works, just without notification bar.
  } catch (e) {
    console.warn('[MusicCard] notification permission check failed:', e);
  }
}

/** Format an ISO date string or raw date string into a short locale date. */
function formatPublishedDate(dateStr?: string): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr; // fallback to raw string
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * 音乐启动让路：音乐开始时（卡片点击 / 恢复 / 新结果自动播放），
 * 正在进行的 TTS 播报必须停。先清 duck 标志 —— 否则 stopTtsPlayback
 * 的拆除路径会对即将被替换的旧队列再 play() 一次（旧歌响一瞬间又被切断）。
 * 见 @/utils/audio-coordination 协议。
 */
function stopTtsBeforeMusicStart(): void {
  releaseMusicDuck();
  useTtsStore.getState().stopTtsPlayback();
}

// ── Music card ───────────────────────────────────────────────────

interface MusicCardProps {
  item: MusicResult;
  /** Full play queue for the list this card belongs to (shared by siblings). */
  queue: PlayableTrackInput[];
  /** Index of THIS card's track within `queue`. */
  queueIndex: number;
}

function MusicCard({ item, queue, queueIndex }: MusicCardProps) {
  const { t } = useI18n();
  // Kick off player setup as soon as the list mounts so the first tap is
  // responsive. The hook is idempotent — all MusicCards share the same
  // in-flight setupPromise via useTrackPlayer's module-level singleton.
  useTrackPlayer();

  const activeTrack = useActiveTrack();
  const playbackState = usePlaybackState();

  const [thumbError, setThumbError] = useState(false);
  const [pending, setPending] = useState(false);

  // Identity check: is THIS card the track currently loaded in the player?
  // Uses the absolute audio URL as the unique key because the backend's
  // previewUrl is unique per file (uuid-named MP3).
  const resolvedAudioUrl = item.previewUrl
    ? resolveAudioUrl(item.previewUrl)
    : null;
  const isActive = !!(
    resolvedAudioUrl &&
    activeTrack?.url === resolvedAudioUrl
  );
  const isPlaying = isActive && playbackState.state === State.Playing;

  const handlePress = async () => {
    // No preview URL → fall back to opening the source page externally.
    if (!resolvedAudioUrl) {
      Linking.openURL(item.url).catch(() => {});
      return;
    }

    // Toggle: active + playing → pause. Saves a queue reset.
    if (isPlaying) {
      await pausePlayback();
      return;
    }

    // Active + paused → just resume (no need to reset the queue).
    // 音乐恢复 = 用户明确要听音乐 → 正在播报的 TTS 让路（停）。
    if (isActive) {
      stopTtsBeforeMusicStart();
      setPending(true);
      try {
        const TrackPlayer = (await import('react-native-track-player')).default;
        await TrackPlayer.play();
      } catch (e: any) {
        useToastStore
          .getState()
          .showToast({ message: e?.message ?? t('music.playbackFailed'), variant: 'warning' });
      } finally {
        setPending(false);
      }
      return;
    }

    // Inactive → load the full play queue starting from this card and play.
    // Loading all siblings (not just the tapped track) keeps the Android
    // MediaSession queue length > 1, which is what makes the notification
    // show both previous AND next buttons (豆包-style behavior).
    //
    // Permission note: we deliberately do NOT request POST_NOTIFICATIONS at
    // message-load time. _layout.tsx asks once on login for FCM push; if
    // the user denied that, we re-ask here on the first music play so the
    // media notification bar can render. See ensureNotificationPermissionForPlayback.
    //
    // 音乐让 TTS 停：用户点歌 = 明确要听音乐，停掉进行中的播报（含 duck 标志）。
    stopTtsBeforeMusicStart();
    setPending(true);
    try {
      if (Platform.OS !== 'web') {
        await ensureNotificationPermissionForPlayback();
      }
      await playTracksFromIndex(queue, queueIndex);
    } catch (e: any) {
      useToastStore
        .getState()
        .showToast({ message: e?.message ?? t('music.playbackFailed'), variant: 'warning' });
    } finally {
      setPending(false);
    }
  };

  const hasThumb = !!item.thumbnail && !thumbError;
  const publishedDate = formatPublishedDate(item.publishedDate);

  // Overlay icon: spinner while transitioning, pause if currently playing,
  // play otherwise. For the inactive card the static play icon is shown
  // without a dim overlay so the thumbnail stays readable.
  const renderOverlayIcon = () => {
    if (pending) {
      return <ActivityIndicator size="small" color="#fff" />;
    }
    if (isPlaying) {
      return <Ionicons name="pause" size={14} color="#fff" />;
    }
    return <Ionicons name="play" size={14} color="#fff" style={{ marginLeft: 2 }} />;
  };

  // Active card gets a subtle accent border to indicate "currently loaded".
  const cardBorderStyle = isActive
    ? { borderColor: 'rgba(124,58,237,0.45)' }
    : null;

  return (
    <Pressable
      onPress={handlePress}
      disabled={pending}
      style={({ pressed }) => [
        styles.card,
        cardBorderStyle,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={styles.cardBody}>
        {/* Thumbnail (square 1:1) */}
        <View style={styles.thumbWrapper}>
          {hasThumb ? (
            <Image
              source={{ uri: item.thumbnail! }}
              style={styles.thumbImage}
              resizeMode="cover"
              onError={() => setThumbError(true)}
            />
          ) : (
            <View style={styles.thumbPlaceholder}>
              <Ionicons name="musical-note" size={22} color="#9CA3AF" />
            </View>
          )}
          {/* Play / pause / loading overlay */}
          <View
            style={[
              styles.playOverlay,
              // Only dim the thumbnail for the active/pending states so
              // idle cards keep their full-color artwork.
              (isActive || pending) && styles.playOverlayActive,
            ]}
          >
            <View
              style={[
                styles.playButton,
                isPlaying && styles.playButtonActive,
              ]}
            >
              {renderOverlayIcon()}
            </View>
          </View>
        </View>

        {/* Info column */}
        <View style={styles.infoCol}>
          <Text
            style={[styles.cardTitle, isActive && styles.cardTitleActive]}
            numberOfLines={2}
          >
            {item.title}
          </Text>
          {item.author ? (
            <View style={styles.authorRow}>
              <Ionicons name="person-circle-outline" size={11} color="#9CA3AF" />
              <Text style={styles.authorText} numberOfLines={1}>
                {item.author}
              </Text>
            </View>
          ) : null}
          <View style={styles.metaRow}>
            {item.duration ? (
              <View style={styles.metaItem}>
                <Ionicons name="time-outline" size={11} color="#9CA3AF" />
                <Text style={styles.metaText}>{item.duration}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// ── Main list ────────────────────────────────────────────────────

/**
 * Module-level dedup of queue head URLs that have already been auto-played.
 * Survives component re-mounts (e.g. when the user scrolls away and back,
 * or when ChatBubble re-renders) so the same result batch never auto-plays
 * twice. Entries are short audio URLs; in practice this set stays tiny
 * (one entry per music_search the user has triggered this app lifetime).
 */
const autoPlayedResultHeads = new Set<string>();

export function MusicCardList({ results, sessionId, autoPlayOnArrival = false }: MusicCardListProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const visibleResults = expanded ? results : results.slice(0, COLLAPSED_COUNT);
  const hiddenCount = results.length - COLLAPSED_COUNT;
  const canExpand = !expanded && hiddenCount > 0;

  // Build the playback queue from ALL results that have a playable preview
  // URL. We use the full (un-collapsed) results so tapping a card after
  // expanding still enqueues everything — the notification next/prev
  // buttons remain useful regardless of expand state.
  //
  // Padding for Android MediaSession: Android hides the notification next
  // button whenever the active track is the LAST item in the queue
  // (MediaSession.hasNextMediaItem() returns false). Even with multiple
  // playable results, clicking the LAST card leaves the next button
  // invisible. To keep it visible per product decision ("button always
  // shows, click is no-op when there's no real next"), we ALWAYS append a
  // padding track — a duplicate of the queue's last entry tagged with a
  // `#pad` id suffix — so the last real song always has a "next" target.
  // PlaybackService's RemoteNext handler detects `#pad` and short-circuits
  // back to the last real song, making the press feel inert.
  //
  // The padding is invisible to MusicCard because we only build
  // `queueIndexByPreviewUrl` from real entries.
  //
  // The queue is recomputed only when results change (stable across
  // renders) so each MusicCard's queueIndex stays consistent.
  const { queue, queueIndexByPreviewUrl } = useMemo(() => {
    const q: PlayableTrackInput[] = [];
    const indexByUrl = new Map<string, number>();
    for (const r of results) {
      if (!r.previewUrl) continue;
      const resolved = resolveAudioUrl(r.previewUrl);
      indexByUrl.set(resolved, q.length);
      q.push({
        url: resolved,
        title: r.title,
        artist: r.author,
        artwork: r.thumbnail,
        id: resolved,
        // Embed sessionId so notification-bar taps can navigate back to
        // the originating session page.
        sessionId,
      });
    }
    // Always pad the end of the queue (when non-empty). See comment above.
    // The spread copies sessionId too, so pad tracks inherit the same
    // session association as their source.
    if (q.length >= 1) {
      const last = q[q.length - 1];
      q.push({ ...last, id: `${last.id}#pad` });
    }
    return { queue: q, queueIndexByPreviewUrl: indexByUrl };
  }, [results, sessionId]);

  // ── Auto-play on fresh result arrival ─────────────────────────────
  // Doubao-style UX: when the AI returns music search results, kick off
  // playback of the first track automatically — REPLACING whatever was
  // sounding before (music from a previous queue OR TTS read-aloud):
  // "搜新歌 → 播新歌", fresh results win.
  //
  // Guards:
  //   - never fires twice for the same result batch (module-level Set
  //     dedup by queue head URL, survives re-mounts)
  //   - stops in-flight TTS first (stopTtsBeforeMusicStart) and releases
  //     the music duck flag so TTS teardown can't re-play the replaced
  //     queue a split second later
  //
  // FIRE-AND-FORGET — we intentionally do NOT cancel on deps change or
  // unmount. Starting playback involves async work (notification
  // permission gate + RNTP queue setup, observed 500ms+ on first load),
  // and by the time it resolves the parent ChatBubble may have
  // re-rendered with autoPlayOnArrival=false (isActiveStreaming flipped
  // to false when the stream finished). Cancelling in cleanup would kill
  // auto-play entirely. TrackPlayer is a singleton that outlives any
  // single component, so completing the start after unmount is safe.
  useEffect(() => {
    if (!autoPlayOnArrival) return;
    if (queue.length === 0) return;
    const head = queue[0]?.url;
    if (!head) return;
    if (autoPlayedResultHeads.has(head)) return;
    autoPlayedResultHeads.add(head);

    void (async () => {
      try {
        stopTtsBeforeMusicStart();
        await ensureNotificationPermissionForPlayback();
        await playTracksFromIndex(queue, 0);
        console.log('[MusicCardList] auto-play started:', head);
      } catch (e: unknown) {
        console.warn('[MusicCardList] auto-play failed:', e);
      }
    })();
    // No cleanup function — see FIRE-AND-FORGET comment above.
  }, [autoPlayOnArrival, queue]);

  if (!results || results.length === 0) return null;

  return (
    <View style={styles.listContainer}>
      {visibleResults.map((item, index) => {
        const resolved = item.previewUrl
          ? resolveAudioUrl(item.previewUrl)
          : null;
        const queueIndex = resolved
          ? queueIndexByPreviewUrl.get(resolved) ?? -1
          : -1;
        return (
          <MusicCard
            key={`${index}-${item.url}`}
            item={item}
            queue={queue}
            queueIndex={queueIndex}
          />
        );
      })}

      {canExpand && (
        <Pressable
          onPress={() => setExpanded(true)}
          style={({ pressed }) => [styles.expandBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.expandText}>
            {t('music.showMore', { count: hiddenCount })}
          </Text>
          <Ionicons name="chevron-down" size={14} color="#1D4ED8" />
        </Pressable>
      )}
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── List container ──
  listContainer: {
    marginTop: 8,
    gap: 10,
  },
  // ── Card (framed container, light border) ──
  card: {
    flexDirection: 'column',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 10,
    borderWidth: 0.5,
    borderColor: 'rgba(0,0,0,0.06)',
    // iOS shadow (very subtle)
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.03,
    shadowRadius: 2,
    // Android elevation (minimal)
    elevation: 1,
  },
  cardBody: {
    flexDirection: 'row',
    gap: 10,
  },
  // ── Thumbnail (square 1:1) ──
  thumbWrapper: {
    position: 'relative',
    width: 64,
    height: 64,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#F3F4F6',
    borderWidth: 0.5,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  thumbPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Dim the thumbnail only when the card is active or pending a switch —
  // idle cards show the play button without dimming for visual clarity.
  playOverlayActive: {
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  playButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Currently-playing card: solid purple button so the pause icon pops.
  playButtonActive: {
    backgroundColor: '#1D4ED8',
  },
  // ── Info section (right of thumbnail) ──
  infoCol: {
    flex: 1,
    gap: 3,
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 17,
    color: '#1F2937',
  },
  // Active card title gets the brand color to reinforce "this is playing".
  cardTitleActive: {
    color: '#1D4ED8',
    fontWeight: '600',
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  authorText: {
    fontSize: 11,
    color: '#9CA3AF',
    flexShrink: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  metaText: {
    fontSize: 10,
    color: '#9CA3AF',
  },
  // ── Expand button ──
  expandBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(124,58,237,0.08)',
  },
  expandText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1D4ED8',
  },
});
