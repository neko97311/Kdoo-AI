/**
 * Vertical video results list for chat messages.
 *
 * Renders video search tool output as a vertical list of compact video
 * cards.  Each card has a 16:9 thumbnail on the left and title/author/
 * duration on the right.  Tapping a YouTube video opens an in-app
 * player modal; other videos open in the system browser.
 *
 * Default: shows first 3 results.  An "expand" button below reveals
 * all remaining results.  Once expanded, the button disappears (no
 * collapse — one-way expand only).
 *
 * Used by ChatBubble.tsx to render videoSearchTool output.
 */
import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  Pressable,
  Image,
  Modal,
  ActivityIndicator,
  Linking,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import YoutubePlayer from 'react-native-youtube-iframe';
import { useI18n } from '@/hooks/useI18n';

// ── Types ────────────────────────────────────────────────────────

export interface VideoResult {
  title: string;
  url: string;
  thumbnail?: string;
  duration?: string;
  author?: string;
  description?: string;
  embedUrl?: string;
  publishedDate?: string;
}

interface VideoCardListProps {
  results: VideoResult[];
}

/** Number of results shown before the "expand" button. */
const COLLAPSED_COUNT = 3;

// ── YouTube helpers ──────────────────────────────────────────────

/**
 * Extract the YouTube video ID from any common YouTube URL format:
 *   - https://www.youtube.com/watch?v=VIDEO_ID
 *   - https://youtu.be/VIDEO_ID
 *   - https://m.youtube.com/watch?v=VIDEO_ID
 *   - https://www.youtube.com/embed/VIDEO_ID
 *   - https://www.youtube.com/shorts/VIDEO_ID  (portrait)
 * Returns { id, isPortrait } or null for non-YouTube URLs.
 */
function extractYouTubeInfo(url: string): { id: string; isPortrait: boolean } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.slice(1);
      return id ? { id, isPortrait: false } : null;
    }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') {
        const id = u.searchParams.get('v');
        return id ? { id, isPortrait: false } : null;
      }
      const embedMatch = u.pathname.match(/^\/embed\/([^/?#]+)/);
      if (embedMatch) return { id: embedMatch[1], isPortrait: false };
      const shortsMatch = u.pathname.match(/^\/shorts\/([^/?#]+)/);
      if (shortsMatch) return { id: shortsMatch[1], isPortrait: true };
    }
  } catch {
    // not a valid URL
  }
  return null;
}

// ── YouTube player modal ─────────────────────────────────────────

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

interface YouTubePlayerModalProps {
  videoId: string | null;
  video: VideoResult | null;
  isPortrait: boolean;
  onClose: () => void;
}

function YouTubePlayerModal({ videoId, video, isPortrait, onClose }: YouTubePlayerModalProps) {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const playerRef = useRef(null);
  const [isReady, setIsReady] = useState(false);

  // Reset readiness when video changes
  React.useEffect(() => {
    setIsReady(false);
  }, [videoId]);

  // Player dimensions adapt to orientation.
  // Landscape: 92% screen width, 16:9 ratio.
  // Portrait (Shorts): 80% screen height, 9:16 ratio.
  let playerW: number;
  let playerH: number;
  if (isPortrait) {
    playerH = Math.floor(Math.min(screenHeight * 0.7, screenWidth * 16 / 9));
    playerW = Math.floor(playerH * 9 / 16);
  } else {
    playerW = Math.floor(screenWidth * 0.92);
    playerH = Math.floor(playerW * 9 / 16);
  }

  const publishedDate = formatPublishedDate(video?.publishedDate);

  return (
    <Modal
      visible={!!videoId}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        {/* Close button — top-right, matches ImagePreviewOverlay */}
        <Pressable
          onPress={onClose}
          hitSlop={8}
          style={styles.closeBtn}
        >
          <Ionicons name="close" size={28} color="#fff" />
        </Pressable>

        {/* Video player */}
        <View style={{ width: playerW, height: playerH }}>
          {videoId && (
            <YoutubePlayer
              ref={playerRef}
              videoId={videoId}
              height={playerH}
              width={playerW}
              play={isReady}
              onReady={() => setIsReady(true)}
              webViewProps={{
                allowsInlineMediaPlayback: true,
                allowsFullscreenVideo: true,
                mediaPlaybackRequiresUserAction: false,
                startInLoadingState: true,
                renderLoading: () => (
                  <View style={styles.loadingOverlay}>
                    <ActivityIndicator size="large" color="#1D4ED8" />
                  </View>
                ),
              }}
              onError={(e) => console.warn('[YouTubePlayer] error:', e)}
            />
          )}
        </View>

        {/* Info section below the player */}
        {video && (
          <View style={styles.playerInfo}>
            <Text style={styles.playerTitle} numberOfLines={2}>
              {video.title}
            </Text>
            <View style={styles.playerMetaRow}>
              {video.author && (
                <>
                  <Ionicons name="person-circle-outline" size={13} color="rgba(255,255,255,0.6)" />
                  <Text style={styles.playerMetaText} numberOfLines={1}>
                    {video.author}
                  </Text>
                </>
              )}
              {video.duration && (
                <>
                  <Text style={styles.playerMetaDot}>·</Text>
                  <Ionicons name="time-outline" size={12} color="rgba(255,255,255,0.6)" />
                  <Text style={styles.playerMetaText}>{video.duration}</Text>
                </>
              )}
              {publishedDate && (
                <>
                  <Text style={styles.playerMetaDot}>·</Text>
                  <Ionicons name="calendar-outline" size={12} color="rgba(255,255,255,0.6)" />
                  <Text style={styles.playerMetaText}>{publishedDate}</Text>
                </>
              )}
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ── Video card ───────────────────────────────────────────────────

interface VideoCardProps {
  item: VideoResult;
  onPress: (item: VideoResult) => void;
}

function VideoCard({ item, onPress }: VideoCardProps) {
  const [thumbError, setThumbError] = useState(false);
  const hasThumb = !!item.thumbnail && !thumbError;

  return (
    <Pressable
      onPress={() => onPress(item)}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
    >
      {/* Thumbnail (fixed 16:9) */}
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
            <Ionicons name="videocam-outline" size={24} color="#9CA3AF" />
          </View>
        )}
        {/* Duration badge */}
        {item.duration ? (
          <View style={styles.durationBadge}>
            <Text style={styles.durationText}>{item.duration}</Text>
          </View>
        ) : null}
        {/* Play overlay */}
        <View style={styles.playOverlay}>
          <View style={styles.playButton}>
            <Ionicons name="play" size={16} color="#fff" style={{ marginLeft: 2 }} />
          </View>
        </View>
      </View>

      {/* Info column */}
      <View style={styles.infoCol}>
        <Text style={styles.cardTitle} numberOfLines={2}>
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
      </View>
    </Pressable>
  );
}

// ── Main list ────────────────────────────────────────────────────

export function VideoCardList({ results }: VideoCardListProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [playingVideo, setPlayingVideo] = useState<{
    videoId: string;
    video: VideoResult;
    isPortrait: boolean;
  } | null>(null);

  const handlePress = useCallback((item: VideoResult) => {
    // Try YouTube in-app player first
    const yt = extractYouTubeInfo(item.url);
    if (yt) {
      setPlayingVideo({ videoId: yt.id, video: item, isPortrait: yt.isPortrait });
      return;
    }
    // Fallback: use embedUrl if available
    if (item.embedUrl) {
      const embedYt = extractYouTubeInfo(item.embedUrl);
      if (embedYt) {
        setPlayingVideo({ videoId: embedYt.id, video: item, isPortrait: embedYt.isPortrait });
        return;
      }
    }
    // Non-YouTube: open in system browser
    Linking.openURL(item.url).catch(() => {});
  }, []);

  const handleClosePlayer = useCallback(() => {
    setPlayingVideo(null);
  }, []);

  if (!results || results.length === 0) return null;

  const visibleResults = expanded ? results : results.slice(0, COLLAPSED_COUNT);
  const hiddenCount = results.length - COLLAPSED_COUNT;
  const canExpand = !expanded && hiddenCount > 0;

  return (
    <View style={styles.listContainer}>
      {visibleResults.map((item, index) => (
        <VideoCard key={`${index}-${item.url}`} item={item} onPress={handlePress} />
      ))}

      {canExpand && (
        <Pressable
          onPress={() => setExpanded(true)}
          style={({ pressed }) => [styles.expandBtn, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.expandText}>
            {t('video.showMore', { count: hiddenCount })}
          </Text>
          <Ionicons name="chevron-down" size={14} color="#1D4ED8" />
        </Pressable>
      )}

      <YouTubePlayerModal
        videoId={playingVideo?.videoId ?? null}
        video={playingVideo?.video ?? null}
        isPortrait={playingVideo?.isPortrait ?? false}
        onClose={handleClosePlayer}
      />
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
  // ── Card (vertical: thumb on top, info below) ──
  card: {
    flexDirection: 'column',
    gap: 8,
  },
  // ── Thumbnail (full-width, 16:9) ──
  thumbWrapper: {
    position: 'relative',
    width: '100%',
    aspectRatio: 16 / 9,
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
  durationBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(0,0,0,0.8)',
    borderRadius: 4,
  },
  durationText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
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
  playButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // ── Info section (below thumbnail) ──
  infoCol: {
    gap: 3,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 17,
    color: '#1F2937',
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
  // ── YouTube player modal (overlay style — matches ImagePreviewOverlay) ──
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 48,
    right: 16,
    zIndex: 2,
  },
  // ── Player info section (below player) ──
  playerInfo: {
    marginTop: 16,
    paddingHorizontal: 24,
    width: '100%',
    alignItems: 'center',
    gap: 6,
  },
  playerTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  playerMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  playerMetaText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
  },
  playerMetaDot: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 12,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 20,
    backgroundColor: '#000',
  },
});
