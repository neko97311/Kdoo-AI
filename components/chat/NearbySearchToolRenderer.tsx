/**
 * Nearby Search tool renderer — compact preview card + full-screen map.
 *
 * Architecture:
 *
 *   ┌─ Preview card (inline in chat bubble) ──────────────────┐
 *   │  ┌─ Mini-map banner (live WebView, previewMode) ──────┐ │
 *   │  │  POI markers + anchor pin, no UI chrome             │ │
 *   │  │  Tap → opens full-screen modal                      │ │
 *   │  └─────────────────────────────────────────────────────┘ │
 *   │  [magnify] Searching nearby...                          │
 *   │             N places found                       [nav]   │
 *   └──────────────────────────────────────────────────────────┘
 *                         │
 *                         │ user taps banner or info area
 *                         ▼
 *   ┌─ <Modal> full-screen map ──────────────────────────────┐
 *   │  - Full McpWebView instance with all UI chrome visible  │
 *   │  - Map + list pane, tap any POI to navigate             │
 *   │  - User can pan/zoom/scroll                              │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Why not reuse MapToolRenderer?
 *   - MapToolRenderer is route-planning specific: mode chips,
 *     route info protocol, distance/duration row, AMap/Google
 *     navigation deep links for turn-by-turn to a destination.
 *   - Nearby Search has no single route. POIs are dynamic and
 *     user-selectable. Its preview shows count + a single
 *     "navigate to first POI" shortcut (auto-selected by the HTML).
 *   - The HTML already auto-selects the first POI; this preview
 *     surfaces a one-tap shortcut to launch native maps at that
 *     POI's coords.
 *
 * Preview→Host message flow:
 *   1. WebView runs the POI search client-side.
 *   2. On success, HTML emits `{type:'nearbyResult', count, firstPoi, anchor}`
 *      via postToHost().
 *   3. McpWebView forwards it to this renderer via `onNearbyResult`.
 *   4. This renderer stores it in state and uses it for:
 *        - count label ("N places found")
 *        - navigate button (jump to firstPoi coords)
 *
 * @module components/chat/NearbySearchToolRenderer
 */

import React, { useMemo, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  StatusBar,
  StyleSheet,
  ActivityIndicator,
  Platform,
  Linking,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useResolvedScheme } from '@/hooks/useColors';
import { useI18n } from '@/hooks/useI18n';
import { useToastStore } from '@/stores/toast';
import { ToastHost } from '@/components/ui/Toast';
import { McpWebView } from './McpWebView';
import { MapChatInput } from './MapChatInput';
import { KeyboardAvoidingView } from '@/components/KeyboardAvoidingView';
import type { NearbyResultInfo } from './McpWebView';
import type { ToolInvocationContent, McpToolCallPayload } from '@/types';

interface NearbySearchToolRendererProps {
  content: ToolInvocationContent;
  onMcpToolCall?: (params: McpToolCallPayload) => void;
}

/**
 * Extract the `category` argument passed by the tool. The args shape is
 * `{ category: string, radius?, maxResults?, anchor?, anchorLabel? }`.
 * Falls back to the localized "Nearby Places" string when absent.
 */
function extractCategory(args: unknown, fallback: string): string {
  if (!args) return fallback;
  const obj = typeof args === 'string' ? safeParse(args) : args;
  if (obj && typeof obj === 'object' && 'category' in obj) {
    const cat = (obj as Record<string, unknown>).category;
    if (typeof cat === 'string' && cat.trim()) return cat;
  }
  return fallback;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

export function NearbySearchToolRenderer({
  content,
  onMcpToolCall,
}: NearbySearchToolRendererProps) {
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [resultInfo, setResultInfo] = useState<NearbyResultInfo | null>(null);
  const scheme = useResolvedScheme();
  const insets = useSafeAreaInsets();
  const isDark = scheme === 'dark';
  const { t } = useI18n();

  const resourceUri = content.structuredContent?.resourceUri;

  const safeToolName =
    typeof content.toolName === 'string'
      ? content.toolName
      : String(
          (content.toolName as { name?: string } | undefined)?.name ??
            'nearbySearchTool',
        );

  const category = extractCategory(content.args, t('map.nearbySearch'));

  const toolInput = useMemo(
    () =>
      content.args
        ? { toolName: safeToolName, input: content.args }
        : undefined,
    [safeToolName, content.args],
  );
  const toolResult = useMemo(
    () =>
      content.result !== undefined
        ? { toolName: safeToolName, result: content.result }
        : undefined,
    [safeToolName, content.result],
  );

  /**
   * Launch the native map app (Google Maps / AMap) with turn-by-turn
   * directions to the first POI. Triggered by the nav icon in the
   * preview card. If the HTML hasn't emitted nearbyResult yet (e.g.,
   * search still running), show a friendly prompt to open the modal.
   *
   * Strategy mirrors MapToolRenderer: try native scheme first, fall
   * back to https URL. Do NOT use Linking.canOpenURL() as a gate —
   * see the comment in MapToolRenderer for the Android 11+ reason.
   */
  const navigateToFirstPoi = useCallback(async () => {
    const target = resultInfo?.firstPoi;
    if (!target || typeof target.lat !== 'number' || typeof target.lng !== 'number') {
      useToastStore
        .getState()
        .showToast({ message: t('map.noPlacesFound'), variant: 'warning' });
      return;
    }
    const { lat, lng } = target;
    const label = encodeURIComponent(target.name || category);
    const schemes =
      Platform.select<{ primary: string; fallback: string }>({
        android: {
          primary: `androidamap://navi?sourceApplication=kdoo&lat=${lat}&lon=${lng}&dev=0&style=2`,
          fallback: `https://uri.amap.com/navigation?to=${lng},${lat},${label}&mode=car`,
        },
        ios: {
          primary: `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`,
          fallback: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
        },
        default: {
          primary: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
          fallback: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
        },
      }) ?? { primary: '', fallback: '' };

    console.log(
      '[NearbySearchToolRenderer NAV] start:',
      JSON.stringify({ lat, lng, primary: schemes.primary }),
    );
    if (schemes.primary) {
      try {
        await Linking.openURL(schemes.primary);
        console.log(
          '[NearbySearchToolRenderer NAV] Primary scheme opened:',
          schemes.primary,
        );
        return;
      } catch (err) {
        console.warn(
          '[NearbySearchToolRenderer NAV] Primary failed:',
          schemes.primary,
          JSON.stringify(err),
        );
      }
    }
    try {
      console.log(
        '[NearbySearchToolRenderer NAV] Falling back to https:',
        schemes.fallback,
      );
      await Linking.openURL(schemes.fallback);
    } catch (err) {
      console.warn(
        '[NearbySearchToolRenderer NAV] Fallback also failed:',
        JSON.stringify(err),
      );
      useToastStore
        .getState()
        .showToast({ message: t('map.navUnavailableMsg'), variant: 'warning' });
    }
  }, [resultInfo?.firstPoi, category, t]);

  // Banner height: taller on mobile so the POI markers on the preview map
  // aren't crammed/cut off; even taller on web.
  const bannerHeight = Platform.select({ web: 340, default: 280 });

  // Theme tokens
  const cardBg = isDark ? '#1a1a2e' : '#f8f9fa';
  const cardBorder = isDark ? '#2a2a3e' : '#e5e7eb';
  const titleColor = isDark ? '#e5e7eb' : '#1e293b';
  const subColor = isDark ? '#9CA3AF' : '#6B7280';
  const accent = '#4f46e5';
  const thumbBg = isDark ? '#1e3a5f' : '#dbeafe';

  // Sub-label hierarchy (richer than count-only):
  //   1. Search pending  -> "Searching nearby..."
  //   2. 0 results       -> "No places found"
  //   3. 1 result        -> first POI name
  //   4. N>1 results     -> "First POI Name (+N-1 more)"
  // Falls back to the count template if firstPoi.name is missing.
  const subLabel = useMemo(() => {
    if (!resultInfo) return t('map.searchingNearby');
    if (resultInfo.count === 0) return t('map.noPlacesFound');
    const firstName = resultInfo.firstPoi?.name;
    if (!firstName) {
      return t('map.placesFound').replace('{n}', String(resultInfo.count));
    }
    const extra = resultInfo.count - 1;
    if (extra <= 0) return firstName;
    return `${firstName} ${t('map.andNMore').replace('{n}', String(extra))}`;
  }, [resultInfo, t]);

  // ChatGPT-style first-result summary for the preview card: photo + name +
  // rating · category · price · open/closed status (+N more).
  const firstSummary = useMemo(() => {
    const fp = resultInfo?.firstPoi;
    if (!fp?.name) return null;
    const parts: string[] = [];
    if (typeof fp.rating === 'number') parts.push(`★ ${fp.rating.toFixed(1)}`);
    if (fp.category) parts.push(fp.category);
    if (typeof fp.priceLevel === 'number' && fp.priceLevel > 0) {
      parts.push('$'.repeat(Math.min(fp.priceLevel, 4)));
    }
    if (fp.openNow === true) parts.push(t('map.openNow'));
    else if (fp.openNow === false) parts.push(t('map.closed'));
    const extra = resultInfo ? resultInfo.count - 1 : 0;
    if (extra > 0) parts.push(t('map.andNMore').replace('{n}', String(extra)));
    return { name: fp.name, meta: parts.join(' · ') };
  }, [resultInfo, t]);

  const firstPoiPhoto = resultInfo?.firstPoi?.photo || undefined;

  // Streaming / no resourceUri yet — placeholder card, no WebView yet.
  if (!resourceUri) {
    return (
      <View
        style={[styles.previewCard, { backgroundColor: cardBg, borderColor: cardBorder }]}
      >
        <View
          style={[
            styles.previewBannerWrap,
            { height: bannerHeight, backgroundColor: thumbBg },
          ]}
        >
          <ActivityIndicator size="small" color={accent} />
        </View>
        <View style={styles.previewInfoArea}>
          <Text style={[styles.previewTitle, { color: titleColor }]} numberOfLines={1}>
            {category}
          </Text>
          <Text style={[styles.previewSub, { color: subColor }]}>
            {t('map.preparing')}
          </Text>
        </View>
      </View>
    );
  }

  const canNavigate =
    !!resultInfo?.firstPoi &&
    typeof resultInfo.firstPoi.lat === 'number' &&
    typeof resultInfo.firstPoi.lng === 'number';

  return (
    <View style={styles.root}>
      {/* ── Preview card (inline in chat bubble) ──
          Layout:
            1. Mini-map banner (live WebView in previewMode)
               - POI markers + anchor pin underneath
               - previewMode CSS hides .nearby-header + .list-pane, leaving
                 only the .map-pane visible.
               - Whole banner tappable to open modal.
            2. Bottom info panel (opaque, themed):
               Row 1: category label
               Row 2: count or "searching..."    ┐
               jump icon (navigate to first POI) ↗ */}
      <View
        style={[styles.previewCard, { backgroundColor: cardBg, borderColor: cardBorder }]}
      >
        <Pressable
          onPress={() => setOverlayOpen(true)}
          style={({ pressed }) => [
            styles.previewBannerWrap,
            { height: bannerHeight },
            pressed && { opacity: 0.85 },
          ]}
        >
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <McpWebView
              resourceUri={resourceUri}
              toolCallId={content.toolCallId}
              toolInput={toolInput}
              toolResult={toolResult}
              onNearbyResult={setResultInfo}
              previewMode
              fillContainer
            />
          </View>
          <Pressable
            onPress={() => setOverlayOpen(true)}
            style={styles.bannerExpandBtn}
            hitSlop={8}
          >
            <View style={styles.expandHint}>
              <Ionicons name="expand-outline" size={14} color="#ffffff" />
            </View>
          </Pressable>
        </Pressable>

        <View style={[styles.bottomPanel, { backgroundColor: cardBg }]}>
          <View style={styles.infoRow}>
            <Pressable
              onPress={() => setOverlayOpen(true)}
              style={({ pressed }) => [styles.infoLeft, pressed && { opacity: 0.6 }]}
            >
              <View style={styles.firstRow}>
                {firstPoiPhoto ? (
                  <Image
                    source={{ uri: firstPoiPhoto }}
                    style={styles.firstThumb}
                    resizeMode="cover"
                  />
                ) : (
                  <View
                    style={[
                      styles.firstThumb,
                      styles.firstThumbPlaceholder,
                      { backgroundColor: thumbBg },
                    ]}
                  >
                    <MaterialCommunityIcons
                      name="store-search-outline"
                      size={20}
                      color={accent}
                    />
                  </View>
                )}
                <View style={styles.firstInfo}>
                  <Text
                    style={[styles.firstName, { color: titleColor }]}
                    numberOfLines={1}
                  >
                    {firstSummary?.name || category}
                  </Text>
                  <Text
                    style={[styles.firstMeta, { color: subColor }]}
                    numberOfLines={1}
                  >
                    {firstSummary?.meta || subLabel}
                  </Text>
                </View>
              </View>
            </Pressable>
            <Pressable
              onPress={() => setOverlayOpen(true)}
              hitSlop={8}
              style={({ pressed }) => [
                styles.jumpIcon,
                pressed && { opacity: 0.5 },
              ]}
            >
              <MaterialCommunityIcons
                name="open-in-new"
                size={22}
                color={accent}
              />
            </Pressable>
          </View>
        </View>
      </View>

      {/* ── Full-screen Modal (mounted only while open) ── */}
      <Modal
        visible={overlayOpen}
        animationType="slide"
        presentationStyle="overFullScreen"
        transparent={false}
        statusBarTranslucent
        onRequestClose={() => setOverlayOpen(false)}
      >
        <KeyboardAvoidingView style={styles.modalRoot} keyboardVerticalOffset={insets.top}>
          <StatusBar barStyle="light-content" />
          {/* Local ToastHost — the app-root ToastHost cannot render above this
           *  native <Modal>, so we mount one inside the modal subtree to surface
           *  navigation errors (fallback Linking.openURL failures) triggered
           *  while the full-screen map is open. */}
          <ToastHost />
          <McpWebView
            resourceUri={resourceUri}
            toolCallId={content.toolCallId}
            toolInput={toolInput}
            toolResult={toolResult}
            onToolCall={onMcpToolCall}
            onNearbyResult={setResultInfo}
            fillContainer
            topInset={insets.top}
          />
          {/* Keep chatting with the AI while viewing the map (ChatGPT-style). */}
          <MapChatInput onSent={() => setOverlayOpen(false)} />
          <Pressable
            onPress={() => setOverlayOpen(false)}
            style={[styles.closeBtnFloat, { top: insets.top }]}
            hitSlop={8}
          >
            <View style={styles.closeBtnRing}>
              <View style={styles.closeBtnCore}>
                <Ionicons name="chevron-back" size={26} color="#0f172a" />
              </View>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {},
  previewCard: {
    marginTop: 6,
    marginRight: 4,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  previewBannerWrap: {
    width: '100%',
    overflow: 'hidden',
  },
  bannerExpandBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 2,
  },
  expandHint: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottomPanel: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  infoLeft: {
    flex: 1,
    gap: 3,
  },
  // ChatGPT-style first-result summary row inside the preview card.
  firstRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  firstThumb: {
    width: 52,
    height: 52,
    borderRadius: 10,
  },
  firstThumbPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  firstInfo: {
    flex: 1,
    gap: 2,
  },
  firstName: {
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  firstMeta: {
    fontSize: 12,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  infoDestination: {
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
  },
  infoSub: {
    fontSize: 12,
  },
  jumpIcon: {
    width: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewInfoArea: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  previewTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  previewSub: {
    fontSize: 12,
    marginTop: 2,
  },
  // ── Modal ──
  modalRoot: {
    flex: 1,
  },
  closeBtnFloat: {
    position: 'absolute',
    left: 8,
    zIndex: 10,
    elevation: 5,
  },
  closeBtnRing: {
    padding: 0,
    borderRadius: 26,
    backgroundColor: 'transparent',
  },
  closeBtnCore: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.15)',
  },
});
