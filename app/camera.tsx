import { type ComponentProps, useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { CameraType, FlashMode } from 'expo-camera';
import { emitCameraResult, clearCameraResultHandler } from '@/utils/camera-bridge';
import { pickMultipleImagesFromGallery } from '@/utils/attachments';
import { useI18n } from '@/hooks/useI18n';
import { setStatusBarHidden } from 'expo-status-bar';
import type { Attachment } from '@/types';

// ──────────────────── Constants ────────────────────

/**
 * The flash states we expose, in cycle order. CameraView's `FlashMode` union
 * also includes `'screen'` (uses the display as a selfie flash); we deliberately
 * keep the UX to the three states users actually expect, mirroring the native
 * camera apps. The displayed glyph tracks the CURRENT state, not the next one.
 */
const FLASH_CYCLE = ['off', 'on', 'auto'] as const satisfies readonly FlashMode[];

/** Ionicons glyph name — the narrow union the `name` prop accepts, not `string`. */
type IconName = ComponentProps<typeof Ionicons>['name'];

/** Maps each current flash state to its Ionicons glyph. */
const FLASH_ICON: Record<FlashMode, IconName> = {
  off: 'flash-off-outline',
  on: 'flash-outline',
  auto: 'flash',
  screen: 'flash',
};

// ──────────────────── Screen ────────────────────

/**
 * Full-screen in-app viewfinder. Replaces expo-image-picker's system camera
 * (which always shows an unremovable "retake / use photo" confirmation page)
 * so a captured photo flows straight into the caller's send page with zero
 * platform confirmation.
 *
 * Entry-agnostic: this screen knows nothing about who opened it. Callers
 * register a one-shot result handler via `@/utils/camera-bridge`; we just
 * `emitCameraResult(attachment)` on capture and pop back. Cancelling, hardware
 * back, or an iOS swipe-back clears the handler on unmount so a stale handler
 * can never fire from an unrelated flow later.
 */
export default function CameraScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  // useCameraPermissions() returns [PermissionResponse | null, request, requestAgain].
  // It is null only on the very first render, before the permission check resolves.
  const [permission, requestPermission] = useCameraPermissions();

  const [facing, setFacing] = useState<CameraType>('back');
  const [flashIndex, setFlashIndex] = useState(0);
  const flash = FLASH_CYCLE[flashIndex];

  // takePictureAsync must only be called once onCameraReady has fired; gating
  // the shutter on this flag prevents capturing a not-yet-ready frame. Flipping
  // the camera re-initialises the native preview, so we reset it there and let
  // onCameraReady re-arm it.
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [pickingGallery, setPickingGallery] = useState(false);

  const cameraRef = useRef<CameraView>(null);

  // ── ALWAYS clear the bridge handler on unmount ──────────────────────
  // Covers cancel, capture (emit is one-shot, so clearing again is a no-op),
  // Android hardware-back, and iOS swipe-back — none of these should leave a
  // dangling handler that a later flow could accidentally trigger.
  useEffect(() => () => clearCameraResultHandler(), []);

  // ── Re-hide the system status bar once the preview is ready ──────────
  // The Stack.Screen statusBarHidden option hides it declaratively, but
  // react-native-screens applies window traits per-screen, and after the
  // push animation the previous screen's fragment lifecycle briefly
  // re-shows the bar. Re-hiding at preview-ready time (well past any
  // transition settling) pins the final hidden state. No cleanup restore
  // is needed: on back-navigation the chat screen's own traits re-show it.
  useEffect(() => {
    if (!cameraReady) return;
    setStatusBarHidden(true);
  }, [cameraReady]);

  const handleCancel = useCallback(() => {
    clearCameraResultHandler();
    router.back();
  }, [router]);

  const handleFlip = useCallback(() => {
    setCameraReady(false);
    setFacing((f) => (f === 'back' ? 'front' : 'back'));
  }, []);

  const handleCycleFlash = useCallback(() => {
    setFlashIndex((i) => (i + 1) % FLASH_CYCLE.length);
  }, []);

  const handleCapture = useCallback(async () => {
    if (!cameraReady || capturing) return;
    setCapturing(true);
    try {
      // Optional chaining yields Promise<CameraCapturedPicture> | undefined,
      // so a null ref resolves to `undefined` and we simply stay on screen.
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.8 });
      if (!photo) return;
      const attachment: Attachment = {
        id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'image',
        name: `photo_${Date.now()}.jpg`,
        uri: photo.uri,
        mediaType: 'image/jpeg',
        size: undefined,
      };
      // back FIRST, then emit. emit invokes the consumer (ChatInputBar), which
      // router.push('/photo-compose'). If emitted before back, back() would pop
      // the freshly pushed compose route and the photo would be lost (observed:
      // screen stuck on camera, two captures per session, compose never shown).
      router.back();
      emitCameraResult(attachment);
    } catch (error) {
      // A thrown capture (e.g. camera torn down mid-shot) is a silent no-op:
      // stay on screen and let the user retry.
      console.warn('[Camera] takePictureAsync failed', error);
    } finally {
      setCapturing(false);
    }
  }, [cameraReady, capturing, router]);

  // ── Pick from gallery instead of capturing ──────────────────────────
  // Same one-shot bridge as capture: back first, then emit. The camera
  // bridge handler (registered by photo-compose's handleTakePhoto) adds
  // the photo to the compose attachments, exactly like a capture.
  const handlePickFromGallery = useCallback(async () => {
    setPickingGallery(true);
    try {
      const results = await pickMultipleImagesFromGallery();
      if (results.length === 0) return;
      router.back();
      emitCameraResult(results[0]);
    } catch (error) {
      console.warn('[Camera] gallery pick failed', error);
    } finally {
      setPickingGallery(false);
    }
  }, [router]);

  // ── Permission gating ───────────────────────────────────────────────
  // null  → still resolving; dark loading screen, no prompt (avoids a flash
  //         of the request UI before the cached status lands).
  // granted → viewfinder.
  // undetermined → centered request prompt (user taps to ask once).
  // denied / blocked → hint + 返回. We never auto-re-prompt, so there is no
  //         loop; the only way forward is the user changing it in Settings.
  if (permission && !permission.granted) {
    const undetermined = permission.status === 'undetermined';
    return (
      <View className="flex-1 bg-black items-center justify-center px-8">
        {undetermined ? (
          <>
            <Ionicons name="camera-outline" size={56} color="#FFFFFF" />
            <Text className="mt-5 text-center text-body-lg font-medium text-white">
              {t('cameraScreen.permissionTitle')}
            </Text>
            <Pressable
              onPress={() => void requestPermission()}
              hitSlop={8}
              className="mt-8 rounded-full bg-white px-7 py-3 active:opacity-70"
            >
              <Text className="text-body-md font-semibold text-black">{t('cameraScreen.enableCamera')}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Ionicons name="camera-outline" size={56} color="#9CA3AF" />
            <Text className="mt-5 text-center text-body-lg font-medium text-white">
              {t('cameraScreen.deniedTitle')}
            </Text>
            <Text className="mt-2 text-center text-body-sm text-white/60">
              {t('cameraScreen.deniedHint')}
            </Text>
            <Pressable
              onPress={() => router.back()}
              hitSlop={8}
              className="mt-8 rounded-full bg-white/15 px-7 py-3 active:opacity-70"
            >
              <Text className="text-body-md font-semibold text-white">{t('cameraScreen.back')}</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  if (!permission) {
    // First render, permission response not yet resolved.
    return (
      <View className="flex-1 bg-black items-center justify-center">
        <ActivityIndicator size="large" color="#FFFFFF" />
      </View>
    );
  }

  // ── Viewfinder + dark chrome overlay ────────────────────────────────
  // The root View is the positioning ancestor (RN defaults position:relative),
  // so the CameraView fills it and the control rows overlay it absolutely.
  const canCapture = cameraReady && !capturing;

  return (
    <View className="flex-1 bg-black">
      <CameraView
        ref={cameraRef}
        style={{ flex: 1 }}
        facing={facing}
        flash={flash}
        animateShutter
        mirror={facing === 'front'}
        onCameraReady={() => setCameraReady(true)}
        onMountError={(event) => console.warn('[Camera] mount error', event.message)}
      />

      {/* Top controls — safe-area top inset keeps them clear of the notch. */}
      <View style={{ paddingTop: insets.top }} className="absolute top-0 inset-x-0">
        <View className="flex-row items-center justify-between px-4 pb-2">
          <Pressable
            onPress={handleCancel}
            hitSlop={10}
            className="flex-row items-center gap-0.5 py-1 active:opacity-60"
          >
            <Ionicons name="chevron-back" size={28} color="#FFFFFF" />
            <Text className="text-body-md font-medium text-white">{t('cameraScreen.cancel')}</Text>
          </Pressable>

          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={handleCycleFlash}
              hitSlop={8}
              className="w-11 h-11 rounded-full items-center justify-center bg-white/20 active:opacity-70"
            >
              <Ionicons name={FLASH_ICON[flash]} size={22} color="#FFFFFF" />
            </Pressable>
            <Pressable
              onPress={handleFlip}
              hitSlop={8}
              className="w-11 h-11 rounded-full items-center justify-center bg-white/20 active:opacity-70"
            >
              <Ionicons name="camera-reverse-outline" size={22} color="#FFFFFF" />
            </Pressable>
          </View>
        </View>
      </View>

      {/* Bottom controls — gallery (left) + shutter (center). */}
      <View style={{ paddingBottom: insets.bottom }} className="absolute bottom-0 inset-x-0">
        <View className="flex-row items-center justify-between px-8 py-6">
          {/* Gallery picker — left. */}
          <Pressable
            onPress={handlePickFromGallery}
            disabled={pickingGallery}
            hitSlop={8}
            className="w-12 h-12 rounded-full items-center justify-center bg-white/20 active:opacity-70"
          >
            {pickingGallery ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Ionicons name="images-outline" size={24} color="#FFFFFF" />
            )}
          </Pressable>

          {/* Shutter — center. */}
          <Pressable
            onPress={handleCapture}
            disabled={!canCapture}
            className={`w-[72px] h-[72px] rounded-full border-[3px] border-white items-center justify-center active:opacity-70 ${
              canCapture ? 'opacity-100' : 'opacity-50'
            }`}
          >
            <View
              className={`rounded-full bg-white ${
                capturing ? 'w-7 h-7' : 'w-[58px] h-[58px]'
              }`}
            />
          </Pressable>

          {/* Spacer — keeps shutter centered. */}
          <View className="w-12" />
        </View>
      </View>
    </View>
  );
}
