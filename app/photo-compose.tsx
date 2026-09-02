import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  ScrollView,
  Image,
  Dimensions,
  Platform,
  ActivityIndicator,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type ViewStyle,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { KeyboardAvoidingView } from '@/components/KeyboardAvoidingView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { setStatusBarHidden } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { ZoomableImage } from '@/components/chat/ZoomableImage';
import { useColors } from '@/hooks/useColors';
import { useI18n } from '@/hooks/useI18n';
import { takePhoto, pickMultipleImagesFromGallery } from '@/utils/attachments';
import { SaveImageError, saveImageToAlbum } from '@/utils/save-image';
import { ShareImageError, shareImage } from '@/utils/share-image';
import {
  emitComposeResult,
  clearComposeResultHandler,
  parseInitialAttachments,
} from '@/utils/photo-compose';
import { setCameraResultHandler } from '@/utils/camera-bridge';
import { useToastStore } from '@/stores/toast';
import type { Attachment } from '@/types';

// ──────────────────── Helpers ────────────────────

/** Full-screen page width — each preview page is exactly one screen wide
 *  so pagingEnabled snaps cleanly. Captured once (the screen does not
 *  support rotation/orientation changes mid-edit). */
const ITEM_WIDTH = Dimensions.get('window').width;

// ──────────────────── Save-to-album feedback tunables ────────────────────
// Mirror ImagePreviewOverlay.native's state machine so the inline save button
// on this page feels identical: spinner while saving, checkmark on success
// (reverts after a beat), and a global Toast for BOTH success and failure
// (auto-dismissing pill — the root ToastHost covers this Stack screen).

/** "已保存"对勾停留时长,之后回到下载图标。 */
const SAVED_REVERT_MS = 1600;

type SavePhase = 'idle' | 'saving' | 'saved';

// ──────────────────── Thumbnail strip ────────────────────

/** Bottom thumbnail strip: one small image per attachment. The current
 *  page's thumbnail is highlighted with a border. Tapping a thumbnail
 *  scrolls the pager to that page. Hidden when there's only one image. */
function ThumbnailStrip({
  attachments,
  activeIndex,
  onSelect,
}: {
  attachments: Attachment[];
  activeIndex: number;
  onSelect: (index: number) => void;
}) {
  if (attachments.length <= 1) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 4 }}
    >
      {attachments.map((att, i) => (
        <Pressable
          key={att.id}
          onPress={() => onSelect(i)}
          style={{
            width: 48,
            height: 48,
            borderRadius: 6,
            overflow: 'hidden',
            borderWidth: i === activeIndex ? 2 : 0,
            borderColor: '#1D4ED8',
          }}
        >
          <Image source={{ uri: att.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        </Pressable>
      ))}
    </ScrollView>
  );
}

// ──────────────────── Image page (pinch-zoomable) ────────────────────

/** A single full-screen preview page. The image is pinch-zoomable via
 *  ZoomableImage (pinch 1-4x, double-tap 2.5x, pan when zoomed). When
 *  zoomed, horizontal paging is disabled so the pan gesture doesn't fight
 *  the FlatList's native horizontal swipe. */
function ComposeImage({
  uri,
  width,
  onZoomChange,
}: {
  uri: string;
  width: number;
  onZoomChange?: (zoomed: boolean) => void;
}) {
  return (
    <View style={{ width, flex: 1 }}>
      <ZoomableImage uri={uri} onZoomChange={onZoomChange} />
    </View>
  );
}

// ──────────────────── Main screen ────────────────────

export default function PhotoComposeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const c = useColors();
  const { initial, initialIndex, mode } = useLocalSearchParams<{ initial?: string; initialIndex?: string; mode?: string }>();
  const isViewMode = mode === 'view';

  const [attachments, setAttachments] = useState<Attachment[]>(() =>
    parseInitialAttachments(initial),
  );
  const [text, setText] = useState('');
  const [zoomed, setZoomed] = useState(false);
  const [savePhase, setSavePhase] = useState<SavePhase>('idle');
  const [sharing, setSharing] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [busyCamera, setBusyCamera] = useState(false);
  const [busyGallery, setBusyGallery] = useState(false);

  const { t } = useI18n();

  const flatListRef = useRef<FlatList<Attachment>>(null);

  // Starting page when a gallery flow pre-selects an image (e.g. tapping the
  // 3rd of a message's images opens the composer on page 3). Clamped into the
  // attachment range; NaN/absent → 0. attachments exists by this point.
  const startIndex = (() => {
    const parsed = parseInt(initialIndex ?? '', 10);
    if (Number.isNaN(parsed)) return 0;
    return Math.max(0, Math.min(parsed, Math.max(0, attachments.length - 1)));
  })();
  // The settled page index. Held in a ref for handleSave / handleSend
  // (immediate reads without stale-closure risk) and as state for the
  // thumbnail strip highlight (re-renders on page settle). Seeded with
  // startIndex so gallery flows open on the pre-selected page.
  const activeIndexRef = useRef(startIndex);
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const prevLenRef = useRef(attachments.length);

  const hasAttachments = attachments.length > 0;
  const hasText = text.trim().length > 0;
  const canSend = hasAttachments || hasText;

  // ── Page tracking ────────────────────────────────────────────────────
  // The settled page index — used by the thumbnail strip highlight, the
  // per-page delete button, and handleSend (view mode: send only current)
  // — is derived from onMomentumScrollEnd / onScrollEndDrag so React state
  // updates only when the pager actually lands on a page, not on every
  // scroll frame.
  const updateActiveIndex = useCallback((offsetX: number) => {
    const idx = Math.round(offsetX / ITEM_WIDTH);
    const clamped = Math.max(0, Math.min(idx, Math.max(0, attachments.length - 1)));
    activeIndexRef.current = clamped;
    setCurrentIndex(clamped);
  }, [attachments.length]);

  const onMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => updateActiveIndex(e.nativeEvent.contentOffset.x),
    [updateActiveIndex],
  );
  const onScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => updateActiveIndex(e.nativeEvent.contentOffset.x),
    [updateActiveIndex],
  );

  // ── Thumbnail tap → scroll the pager to that page ────────────────────
  const handleThumbnailSelect = useCallback((index: number) => {
    flatListRef.current?.scrollToIndex({ index, animated: true });
    activeIndexRef.current = index;
    setCurrentIndex(index);
  }, []);

  // ── After a deletion: clamp active page + snap. After an add: jump to
  // the newly added photo so it's immediately selected. ──────────────────
  useEffect(() => {
    const len = attachments.length;
    const prev = prevLenRef.current;
    prevLenRef.current = len;
    if (len === 0) {
      activeIndexRef.current = 0;
      setCurrentIndex(0);
      return;
    }
    if (len < prev) {
      const clamped = Math.min(activeIndexRef.current, len - 1);
      activeIndexRef.current = clamped;
      setCurrentIndex(clamped);
      requestAnimationFrame(() => {
        flatListRef.current?.scrollToIndex({ index: clamped, animated: false });
      });
    } else if (len > prev) {
      // New photo(s) added — jump to the last one (the newly captured/picked).
      const newIndex = len - 1;
      activeIndexRef.current = newIndex;
      setCurrentIndex(newIndex);
      requestAnimationFrame(() => {
        flatListRef.current?.scrollToIndex({ index: newIndex, animated: true });
      });
    }
  }, [attachments.length]);

  // ── Jump to the pre-selected page once after mount ────────────────────
  // Gallery flows (chat image tap, image-search card tap) pass an initialIndex
  // so the composer opens on the tapped image instead of page 1. The initial
  // position is now handled declaratively by FlatList's `initialScrollIndex`
  // (coupled with getItemLayout), which sets the offset before the native view
  // is created — far more reliable than a post-mount requestAnimationFrame
  // scrollToIndex, which could silently fail on the very first frame (the old
  // onScrollToIndexFailed swallowed it, leaving the pager stuck on page 0 even
  // when the user tapped the 2nd/3rd image). No runtime scroll is needed here;
  // thumbnail highlight already starts at `currentIndex === startIndex`.

  // ── ALWAYS clear the compose handler on unmount ──────────────────────
  // Covers cancel, send (emit is one-shot, clearing again is a no-op),
  // Android hardware-back, and iOS swipe-back — none of these should leave
  // a dangling handler that a later flow could accidentally trigger.
  useEffect(() => {
    return () => clearComposeResultHandler();
  }, []);

  // ── Clean up all pending save-feedback timers on unmount ───────────
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.length = 0;
    };
  }, []);

  // ── Re-hide the system status bar after the push transition settles ───
  // The Stack.Screen statusBarHidden option (in _layout) hides the bar
  // declaratively at mount, but react-native-screens applies window traits
  // per-screen and the previous screen's fragment lifecycle re-shows the
  // bar after the push animation finishes. An imperative re-hide ~400ms in
  // (default push animation is ~350ms) wins that final race for this screen.
  useEffect(() => {
    const id = setTimeout(() => setStatusBarHidden(true), 400);
    return () => clearTimeout(id);
  }, []);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    if (isViewMode) {
      // View mode (conversation image): send ONLY the current page.
      const current = attachments[activeIndexRef.current];
      emitComposeResult(text.trim(), current ? [current] : []);
    } else {
      emitComposeResult(text.trim(), attachments);
    }
    router.back();
  }, [canSend, text, attachments, isViewMode, router]);

  const handleCancel = useCallback(() => {
    // Cancel never emits — just drop the handler and return to chat.
    clearComposeResultHandler();
    router.back();
  }, [router]);

  const handleTakePhoto = useCallback(async () => {
    if (Platform.OS === 'web') {
      setBusyCamera(true);
      try {
        const result = await takePhoto();
        if (result) {
          setAttachments((prev) => [...prev, result]);
        }
        // null (user cancelled / permission denied) is a silent no-op — the
        // picker utils already surface their own permission prompts.
      } finally {
        setBusyCamera(false);
      }
    } else {
      // Native: route to the in-app expo-camera screen instead of the system
      // camera. The captured photo is delivered back through the one-shot
      // camera bridge; cancelling the camera screen clears the handler.
      setCameraResultHandler((photo) => setAttachments((prev) => [...prev, photo]));
      router.push('/camera');
    }
  }, []);

  const handlePickGallery = useCallback(async () => {
    setBusyGallery(true);
    try {
      const results = await pickMultipleImagesFromGallery();
      if (results.length > 0) {
        setAttachments((prev) => [...prev, ...results]);
      }
      // empty array (user cancelled) is a silent no-op.
    } finally {
      setBusyGallery(false);
    }
  }, []);

  const handleDeleteActive = useCallback(() => {
    const idx = activeIndexRef.current;
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // ── Save the current page's image to the system album ──────────────
  // Mirrors ImagePreviewOverlay.native's state machine: idle → saving →
  // saved (checkmark + global Toast) / error (warning Toast).
  // Haptics for feel. Toast (auto-dismissing pill) handles feedback text;
  // the root ToastHost already covers this Stack screen.
  const handleSave = useCallback(async () => {
    const current = attachments[activeIndexRef.current];
    if (!current || savePhase === 'saving') return;
    setSavePhase('saving');
    try {
      await saveImageToAlbum(current.uri);
      setSavePhase('saved');
      // 成功提示:Toast "已保存到相册" + 对勾 + 振动,缺一不可。
      useToastStore.getState().showToast({ message: t('imagePreview.saved') });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const revertTimer = setTimeout(() => setSavePhase('idle'), SAVED_REVERT_MS);
      timersRef.current.push(revertTimer);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // SaveImageError 的 message 已是完整本地化句子,原样展示;
      // 未知异常套上通用"保存失败"文案并附上原始信息。
      const display =
        e instanceof SaveImageError ? e.message : `${t('imagePreview.saveFailed')}: ${msg}`;
      useToastStore.getState().showToast({ message: display, variant: 'warning' });
      setSavePhase('idle');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    }
  }, [attachments, savePhase, t]);

  // ── Share the current page's image via the system share sheet ──────
  // Mirrors handleSave's structure. User cancelling the share sheet is not
  // an error (shareImage resolves normally), so no Toast on success — the
  // sheet itself is the feedback. Only failures get a warning Toast.
  const handleShare = useCallback(async () => {
    const current = attachments[activeIndexRef.current];
    if (!current || sharing) return;
    setSharing(true);
    try {
      await shareImage(current.uri);
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      const display = e instanceof ShareImageError ? e.message : `${t('imagePreview.shareFailed')}: ${msg}`;
      useToastStore.getState().showToast({ message: display, variant: 'warning' });
    } finally {
      setSharing(false);
    }
  }, [attachments, sharing, t]);

  // ── Header ───────────────────────────────────────────────────────────
  // Matches ScreenHeader's height/padding language (the root layout
  // already applies the top safe-area inset, so we only pad the bottom).
  // Send lives on the caption row (same affordance as the chat input bar),
  // so the right header slot is gone and the title stays centered.
  const header = (
    <View className="relative flex-row items-center px-4 pb-3 bg-aura-surface border-b border-aura-outline-variant">
      {/* The title is declared FIRST so the cancel button paints above it —
          in RN later siblings stack on top, and with the title declared
          after the button it sat above the tap target on some devices even
          though pointerEvents="none" is set (kept as belt-and-braces). */}
      <Text
        pointerEvents="none"
        className="absolute left-0 right-0 text-center text-headline-sm font-bold text-aura-primary"
      >
        {t('photoCompose.title')}
      </Text>

      <Pressable
        onPress={handleCancel}
        hitSlop={8}
        className="flex-row items-center gap-0.5 active:opacity-60"
      >
        <Ionicons name="chevron-back" size={24} className="text-aura-primary" />
        <Text className="text-body-md font-medium text-aura-primary">
          {t('photoCompose.cancel')}
        </Text>
      </Pressable>
    </View>
  );

  // ── Preview region (dominant, flex-1) ────────────────────────────────
  // Dark neutral letterbox so contained photos pop; matches the shared
  // ImagePreviewOverlay which also renders on near-black.
  const preview: ViewStyle = { flex: 1 };

  const renderItem = useCallback(
    ({ item }: { item: Attachment }) => (
      <ComposeImage uri={item.uri} width={ITEM_WIDTH} onZoomChange={setZoomed} />
    ),
    [],
  );

  const getItemLayout = useCallback(
    (_data: ArrayLike<Attachment> | null | undefined, index: number) => ({
      length: ITEM_WIDTH,
      offset: ITEM_WIDTH * index,
      index,
    }),
    [],
  );

  const previewRegion = (
    <View className="bg-black" style={preview}>
      {hasAttachments ? (
        <>
          <FlatList
            ref={flatListRef}
            data={attachments}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            horizontal
            pagingEnabled
            scrollEnabled={!zoomed}
            showsHorizontalScrollIndicator={false}
            getItemLayout={getItemLayout}
            initialScrollIndex={startIndex}
            onMomentumScrollEnd={onMomentumScrollEnd}
            onScrollEndDrag={onScrollEndDrag}
            onScrollToIndexFailed={(info) => {
              // 首帧 layout 未就绪时 scrollToIndex 会失败。initialScrollIndex
              // 已处理初始定位;这里仅兜底删除/极端首帧场景 —— 延迟重试一次。
              setTimeout(() => {
                flatListRef.current?.scrollToIndex({
                  index: info.index,
                  animated: false,
                });
              }, 50);
            }}
          />

          {/* Top-right actions: save current page (+ delete in compose mode). */}
          <View pointerEvents="box-none" className="absolute top-3 right-3 flex-row items-center gap-2">
            <Pressable
              onPress={handleSave}
              disabled={savePhase === 'saving'}
              hitSlop={8}
              className="w-9 h-9 rounded-full items-center justify-center bg-black/45 active:opacity-70"
            >
              {savePhase === 'saving' ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : savePhase === 'saved' ? (
                <Ionicons name="checkmark" size={22} color="#FFFFFF" />
              ) : (
                <Ionicons name="download-outline" size={20} color="#FFFFFF" />
              )}
            </Pressable>
            {isViewMode && (
              <Pressable
                onPress={handleShare}
                disabled={sharing}
                hitSlop={8}
                className="w-9 h-9 rounded-full items-center justify-center bg-black/45 active:opacity-70"
              >
                {sharing ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Ionicons name="arrow-redo-outline" size={20} color="#FFFFFF" />
                )}
              </Pressable>
            )}
            {!isViewMode && (
              <Pressable
                onPress={handleDeleteActive}
                hitSlop={8}
                className="w-9 h-9 rounded-full items-center justify-center bg-black/45 active:opacity-70"
              >
                <Ionicons name="close" size={20} color="#FFFFFF" />
              </Pressable>
            )}
          </View>

          {/* Thumbnail strip — bottom center, replaces dots. */}
          <View className="absolute bottom-3 left-0 right-0 px-4">
            <ThumbnailStrip
              attachments={attachments}
              activeIndex={currentIndex}
              onSelect={handleThumbnailSelect}
            />
          </View>
        </>
      ) : (
        // Edge case: user deleted every photo. Keep the region usable — a
        // muted camera glyph invites them to add one via the row below.
        <View className="flex-1 items-center justify-center">
          <Ionicons name="camera-outline" size={56} color="#9CA3AF" />
        </View>
      )}
    </View>
  );

  // ── Caption input (compose mode: camera/gallery icons inline) ───────
  // One bordered pill — camera/gallery icons + text field + send circle
  // all INSIDE it, matching ChatInputBar's affordance (icons + field + send
  // in one row). In view mode (conversation image preview), no add-photo
  // buttons appear — the user is just previewing a chat image and optionally
  // re-sending it. The pill stays clear of the keyboard via the app-wide KAV
  // wrapper — the same component ChatView uses, which handles RN 0.85's
  // edge-to-edge Android (manual padding off keyboard events, since
  // adjustResize is broken there) and iOS (native padding + insets.top offset).
  const caption = (
    <View
      className="px-4 pt-2 bg-aura-surface"
      style={{ paddingBottom: Math.max(insets.bottom, 8) }}
    >
      <View className="flex-row items-center rounded-xl px-4 py-1.5 bg-aura-surface-container border border-aura-outline-variant">
        {/* Camera button — left inside the pill (compose mode only). */}
        {!isViewMode && (
          <Pressable
            onPress={handleTakePhoto}
            disabled={busyCamera}
            hitSlop={8}
            className="mr-2 active:opacity-60"
          >
            {busyCamera ? (
              <ActivityIndicator size={18} color="#1D4ED8" />
            ) : (
              <Ionicons name="camera-outline" size={22} color="#1D4ED8" />
            )}
          </Pressable>
        )}
        <TextInput
          className="flex-1 py-2 text-body-md text-aura-on-surface"
          placeholder={isViewMode ? t('photoCompose.placeholderView') : t('photoCompose.placeholder')}
          placeholderTextColor={c.outline}
          value={text}
          onChangeText={setText}
          multiline
          style={{ minHeight: 36, maxHeight: 120 }}
        />

        {/* Send button: appears when there's content. */}
        {canSend && (
          <Pressable
            onPress={handleSend}
            className="ml-2 rounded-full items-center justify-center active:opacity-80"
            style={{ width: 29, height: 29, backgroundColor: '#1D4ED8' }}
          >
            <Ionicons name="arrow-up" size={18} color="white" />
          </Pressable>
        )}
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      keyboardVerticalOffset={insets.top}
      className="bg-aura-surface"
    >
      {header}
      {previewRegion}
      {caption}

    </KeyboardAvoidingView>
  );
}
