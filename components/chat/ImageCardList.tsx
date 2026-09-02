/**
 * Horizontal image results list for chat messages.
 *
 * Renders image search tool output as a horizontal scrolling row of
 * compact image cards. Each card shows a fixed-width thumbnail on top
 * and a single-line description (ellipsised) below.
 *
 * Interaction:
 * - Tap thumbnail → open the locally-cached image in an in-app
 *   fullscreen preview (ImagePreviewOverlay). Falls back to opening
 *   the source page when no local image is available.
 *
 * Notes:
 * - No source-domain chip / link is shown. The horizontal layout keeps
 *   cards visually tight (one image + one description line); a tap on
 *   the thumbnail opens the image itself, while a missing local image
 *   falls back to the source URL in the system browser.
 *
 * Used by ChatBubble.tsx to render imageSearchTool output.
 */
import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Image,
  Linking,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ImagePreviewOverlay } from './ImagePreviewOverlay';

// ── Types ────────────────────────────────────────────────────────

export interface ImageResult {
  title: string;
  /** Source page URL where the image was found (opens in browser). */
  url: string;
  /** Locally-cached, stable image URL for direct display. */
  imageUrl?: string;
  /** Domain of the source page (e.g. "wikipedia.org"). */
  sourceDomain?: string;
  /** Short snippet / description of the image. */
  description?: string;
}

interface ImageCardListProps {
  results: ImageResult[];
}

/** Width of each card in the horizontal list. */
const CARD_WIDTH = 200;
/** Gap between cards. */
const CARD_GAP = 10;

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Resolve a potentially-relative image URL to an absolute one.
 *
 * Backend returns `/api/user/v1/oss/download/image-search/{uuid}.{ext}`
 * (public, no auth — same convention as the music OSS endpoint).
 * RN Image needs an absolute URL to load from.
 */
function resolveImageUrl(uri: string): string {
  if (!uri) return uri;
  if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
  if (uri.startsWith('/')) {
    const base = process.env.EXPO_PUBLIC_API_URL || '';
    return `${base}${uri}`;
  }
  return uri;
}

// ── Image card ───────────────────────────────────────────────────

interface ImageCardProps {
  item: ImageResult;
  onPress: (item: ImageResult) => void;
}

function ImageCard({ item, onPress }: ImageCardProps) {
  const [imgError, setImgError] = useState(false);

  const resolvedImageUrl = item.imageUrl ? resolveImageUrl(item.imageUrl) : '';
  const hasImage = !!resolvedImageUrl && !imgError;

  return (
    <Pressable
      onPress={() => onPress(item)}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.thumbWrapper}>
        {hasImage ? (
          <Image
            source={{ uri: resolvedImageUrl }}
            style={styles.thumbImage}
            resizeMode="cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <View style={styles.thumbPlaceholder}>
            <Ionicons name="image-outline" size={24} color="#9CA3AF" />
          </View>
        )}
      </View>
      {item.description ? (
        <Text style={styles.desc} numberOfLines={1}>
          {item.description}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ── Main list ────────────────────────────────────────────────────

export function ImageCardList({ results }: ImageCardListProps) {
  /** All results that carry a local cached image (tokenized absolute URLs),
   *  in list order — tapping any card opens the viewer over the whole set
   *  so the user can page left/right. */
  const galleryUris = useMemo(
    () => results.filter((r) => r.imageUrl).map((r) => resolveImageUrl(r.imageUrl as string)),
    [results],
  );
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  /**
   * Tap on a card → open the locally-cached image in an in-app
   * fullscreen preview. Falls back to the source page only when no
   * local image is available (imageUrl missing or load failed).
   */
  const handlePress = useCallback(
    (item: ImageResult) => {
      if (item.imageUrl) {
        const resolved = resolveImageUrl(item.imageUrl);
        const idx = galleryUris.indexOf(resolved);
        if (idx >= 0) setPreviewIndex(idx);
      } else if (item.url) {
        Linking.openURL(item.url).catch(() => {});
      }
    },
    [galleryUris],
  );

  const closePreview = useCallback(() => setPreviewIndex(null), []);

  if (!results || results.length === 0) return null;

  return (
    <View style={styles.listContainer}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {results.map((item, index) => (
          <ImageCard
            key={`${index}-${item.url}`}
            item={item}
            onPress={handlePress}
          />
        ))}
      </ScrollView>

      <ImagePreviewOverlay
        uris={previewIndex === null ? [] : galleryUris}
        initialIndex={previewIndex ?? 0}
        onClose={closePreview}
      />
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // ── List container ──
  listContainer: {
    marginTop: 8,
  },
  // ── Horizontal scroll row ──
  scrollContent: {
    gap: CARD_GAP,
    paddingRight: 4, // breathing room past the last card
  },
  // ── Card (vertical: thumb on top, description below) ──
  card: {
    width: CARD_WIDTH,
    gap: 6,
  },
  // ── Thumbnail (fixed 4:3, fills card width) ──
  thumbWrapper: {
    position: 'relative',
    width: '100%',
    aspectRatio: 4 / 3,
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
  // ── Description (single-line, ellipsised) ──
  desc: {
    fontSize: 12,
    lineHeight: 16,
    color: '#6B7280',
  },
});
