import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { ZoomableImage } from '@/components/chat/ZoomableImage';
import { ToastHost } from '@/components/ui/Toast';
import { useToastStore } from '@/stores/toast';
import { SaveImageError, saveImageToAlbum } from '@/utils/save-image';
import { i18n } from '@/i18n';

interface ImagePreviewOverlayProps {
  /** 图片列表;空数组 = 不显示(与原 previewUri === null 语义一致)。 */
  uris: string[];
  /** 初始展示哪一张(越界自动钳制)。默认 0。 */
  initialIndex?: number;
  onClose: () => void;
}

// ─── Tunables ──────────────────────────────────────────────

/** "已保存"对勾停留时长,之后回到下载图标。 */
const SAVED_REVERT_MS = 1600;
const CHROME_FADE_MS = 200;

/** 每一页的宽度 = 整屏宽,pagingEnabled 精准吸附。只取一次:查看器不支持
 *  查看中途旋转屏幕(与 photo-compose 的 ITEM_WIDTH 同理)。 */
const ITEM_WIDTH = Dimensions.get('window').width;

type SavePhase = 'idle' | 'saving' | 'saved';

/** 把页码钳制进 [0, length - 1];length 为 0 时归零。 */
function clampIndex(raw: number, length: number): number {
  return Math.max(0, Math.min(raw, Math.max(0, length - 1)));
}

export function ImagePreviewOverlay({ uris, initialIndex = 0, onClose }: ImagePreviewOverlayProps) {
  const [savePhase, setSavePhase] = useState<SavePhase>('idle');
  /** 放大态:为 true 时关闭横向分页,让 ZoomableImage 的平移手势独占横向
   *  拖动(与 photo-compose 一致的缩放/翻页冲突解法)。 */
  const [zoomed, setZoomed] = useState(false);
  /** 当前页码(0 起):驱动计数器与"保存哪一张"。初值按列表长度钳制。 */
  const [currentIndex, setCurrentIndex] = useState(() => clampIndex(initialIndex, uris.length));
  /** Last image list handed in — used to spot a newly-opened set, since the
   *  overlay stays mounted between previews (uris = [] while closed). */
  const [prevUris, setPrevUris] = useState(uris);

  const chromeOpacity = useSharedValue(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (savedTimer.current) {
      clearTimeout(savedTimer.current);
      savedTimer.current = null;
    }
  }, []);

  // 挂载时淡入 chrome —— 只跑一次;翻页不重跑淡入。
  useEffect(() => {
    chromeOpacity.value = withTiming(1, { duration: CHROME_FADE_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 翻页落定后:重置"逐图"的保存状态机(不重跑 chrome 淡入)。
  useEffect(() => {
    clearTimers();
    setSavePhase('idle');
  }, [currentIndex, clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  // ── 翻页索引跟踪(与 photo-compose 一致:落定才更新,不平移逐帧更新) ──
  const handleZoomChange = setZoomed;

  const onPageSettle = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const idx = Math.round(e.nativeEvent.contentOffset.x / ITEM_WIDTH);
      setCurrentIndex(clampIndex(idx, uris.length));
    },
    [uris.length],
  );

  // ── 保存到相册 ──
  // 成功/失败均通过全局 Toast 弹出自动消失的提示(RN Modal 是独立原生
  // 层级,根 ToastHost 照不到这里,故在本 Modal 内自带一个 ToastHost)。
  const handleSave = useCallback(async () => {
    const target = uris[currentIndex];
    if (!target || savePhase === 'saving') return;
    clearTimers();
    setSavePhase('saving');
    try {
      await saveImageToAlbum(target);
      setSavePhase('saved');
      useToastStore.getState().showToast({ message: i18n.t('imagePreview.saved') });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {
        // 触感反馈尽力而为(模拟器/部分设备会 reject),静默忽略。
      });
      savedTimer.current = setTimeout(() => setSavePhase('idle'), SAVED_REVERT_MS);
    } catch (error) {
      setSavePhase('idle');
      const message = error instanceof Error ? error.message : String(error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {
        // 同上。
      });
      // SaveImageError 的 message 已是完整本地化句子,原样展示;
      // 未知异常套上通用"保存失败"文案并附上原始信息。
      const display =
        error instanceof SaveImageError
          ? error.message
          : `${i18n.t('imagePreview.saveFailed')}: ${message}`;
      useToastStore.getState().showToast({ message: display, variant: 'warning' });
      console.warn('[ImagePreviewOverlay] 保存图片失败', error);
    }
  }, [uris, currentIndex, savePhase, clearTimers]);

  const chromeStyle = useAnimatedStyle(() => ({ opacity: chromeOpacity.value }));

  // When the parent swaps in a new non-empty set, reset the active page to
  // the requested initialIndex. Done synchronously during render so the
  // freshly-mounting FlatList reads the corrected initialScrollIndex (that
  // prop is consulted only on mount, never on later updates).
  if (uris !== prevUris && uris.length > 0) {
    setPrevUris(uris);
    setCurrentIndex(clampIndex(initialIndex, uris.length));
  }

  if (uris.length === 0) return null;

  return (
    <Modal
      visible={uris.length > 0}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* RN <Modal> 渲染在独立的原生层级里,app 根部的 GestureHandlerRootView
          在 iOS 上覆盖不到这棵子树 —— 这里自带一个。 */}
      <GestureHandlerRootView style={styles.root}>
        <FlatList<string>
          data={uris}
          keyExtractor={(uri, i) => `${i}-${uri}`}
          renderItem={({ item }) => (
            <View style={styles.page}>
              <ZoomableImage
                uri={item}
                onTap={onClose}
                onSwipeClose={onClose}
                onZoomChange={handleZoomChange}
              />
            </View>
          )}
          horizontal
          pagingEnabled
          scrollEnabled={!zoomed}
          showsHorizontalScrollIndicator={false}
          getItemLayout={(_data, index) => ({
            length: ITEM_WIDTH,
            offset: ITEM_WIDTH * index,
            index,
          })}
          initialNumToRender={1}
          initialScrollIndex={clampIndex(currentIndex, uris.length)}
          onMomentumScrollEnd={onPageSettle}
          onScrollEndDrag={onPageSettle}
          onScrollToIndexFailed={() => {
            /* 布局可能尚未就绪;安全忽略(与 photo-compose 一致) */
          }}
        />

        {/* Toast 宿主:RN Modal 是独立原生窗口,根 ToastHost 被本 Modal
            遮挡,需在 Modal 内自带一个才能弹出自动消失的提示。 */}
        <ToastHost />

        <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, chromeStyle]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={i18n.t('imagePreview.close')}
            onPress={onClose}
            style={styles.closeButton}
          >
            <Ionicons name="close" size={26} color="#fff" />
          </Pressable>

          {uris.length > 1 && (
            <Text style={styles.pageCounter}>
              {currentIndex + 1} / {uris.length}
            </Text>
          )}

          <View style={styles.saveArea}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={i18n.t('imagePreview.download')}
              disabled={savePhase === 'saving'}
              onPress={handleSave}
              style={styles.saveButton}
            >
              {savePhase === 'saving' ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : savePhase === 'saved' ? (
                <Ionicons name="checkmark" size={26} color="#fff" />
              ) : (
                <Ionicons name="download-outline" size={24} color="#fff" />
              )}
            </Pressable>
            <Text style={styles.saveLabel}>{i18n.t('imagePreview.save')}</Text>
          </View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },
  // 每一页占满整屏宽,配合 pagingEnabled 吸附;ZoomableImage 自身 flex:1 撑满页高。
  page: {
    width: ITEM_WIDTH,
    flex: 1,
  },
  pageCounter: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    zIndex: 2,
    fontSize: 13,
    color: 'rgba(255,255,255,0.8)',
  },
  closeButton: {
    position: 'absolute',
    top: 52,
    left: 16,
    zIndex: 2,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.16)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  saveArea: {
    position: 'absolute',
    bottom: 48,
    alignSelf: 'center',
    zIndex: 2,
    alignItems: 'center',
  },
  saveButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.16)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  saveLabel: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
  },
});
