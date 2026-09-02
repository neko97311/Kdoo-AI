// 声音克隆遮罩组件。
// 设计目标：仿微信/豆包 "按住说话" 风格——
//   1. 大半屏弹层(占屏 92%, minHeight 620)+ 大号朗读样本卡片(醒目居中)
//   2. 底部一个长方形"按住录音"按钮: 按下立即 startRecording(无 holdTimer 延迟)
//   3. 按下后整个 sheet 内容隐藏,VoiceOverlay 用 mode='clone' 全屏接管
//      录音视觉(弧形+波形+上划取消),与 chat 完全一致
//   4. 手指上划超过 80px 切换为"松开取消"红色状态
//   5. 松开：正常 → 转码+提交；上划取消 → 不提交
//   6. 录音完成关闭弹层，不弹 Alert;列表显示"训练中"
//
// 不复用 useVoiceRecorder hook(hook 不暴露原生 recorder / metering);
// 此处自管录音 session，录音参数 / 平台分支完全复制 use-voice-recorder.ts
// 与 ChatInputBar 的实现。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  ActivityIndicator,
  Platform,
  Dimensions,
  PanResponder,
  type GestureResponderEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { File as ExpoFile } from 'expo-file-system';
import { safeHapticImpact, ImpactFeedbackStyle } from '@/utils/haptics';

import { useI18n } from '@/hooks/useI18n';
import { useVoiceManagementStore } from '@/stores/voice-management';
import { convertMobileRecordingToWav } from '@/services/voice-service';
import { VoiceApiError } from '@/types/voice';
import { VoiceOverlay } from '@/components/chat/VoiceOverlay';

const MIN_DURATION_MS = 5_000;
const MAX_DURATION_MS = 30_000;
/** 上划超过这个距离(px)切换为「松开取消」状态 */
const SLIDE_CANCEL_THRESHOLD_PX = 80;

/** Map a dBFS metering value to a 0..1 amplitude using a sqrt curve so
 *  quieter voices still get visible bar movement. Copied verbatim from
 *  ChatInputBar so the waveform behaviour matches the chat input. */
function dbToAmplitude(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 1;
  return Math.sqrt((db + 60) / 60);
}

/** Restore iOS audio session back to playback mode after a recording so the
 *  next TTS playback can reactivate its audio context. Best-effort, no-op on
 *  web. Same helper used by ChatInputBar. */
async function restorePlaybackAudioMode() {
  if (Platform.OS === 'web') return;
  try {
    const { setAudioModeAsync } = await import('expo-audio');
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
  } catch {
    /* noop */
  }
}

export interface VoiceCloneSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function VoiceCloneSheet({ visible, onClose }: VoiceCloneSheetProps) {
  const { t, locale } = useI18n();
  const submitClone = useVoiceManagementStore((s) => s.submitClone);
  const quota = useVoiceManagementStore((s) => s.quota);

  // Phase machine.
  const [phase, setPhase] = useState<'idle' | 'recording' | 'submitting' | 'closing'>('idle');
  const [durationMs, setDurationMs] = useState(0);
  const [amplitude, setAmplitude] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  /** 手指上划距离,>= SLIDE_CANCEL_THRESHOLD_PX 时切为取消状态 */
  const [slideOffsetY, setSlideOffsetY] = useState(0);

  // Native refs.
  const recorderRef = useRef<any>(null);
  const startedAtRef = useRef(0);
  const pressStartYRef = useRef<number | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const meteringTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Adaptive noise floor (VAD-lite) — same config as ChatInputBar.
  const noiseFloorRef = useRef(-45);
  /**
   * 同步标记"用户已按下 button, 录音启动中".
   *
   * 关键原因: startRecording() 是 async (要 await setAudioModeAsync / prepareToRecordAsync),
   * 完成前 phase state 仍是 'idle'. 如果用户在 startRecording 完成前松开手指,
   * handleSheetTouchEnd 同步触发时 phase==='idle', 会走"关闭弹层"分支,
   * 导致按一下 button 立即关闭弹层 (历史 bug m0216: "按住的没了, 一按就返回").
   *
   * 解决方案: button onTouchStart 时**同步**设这个 ref 为 true, handleSheetTouchEnd
   * 同步检查 —— 不依赖 setState 时序. startRecording 失败时同步清掉.
   */
  const intentToRecordRef = useRef(false);

  const screenH = Dimensions.get('screen').height;
  const sheetMaxHeight = Math.round(screenH * 0.92);
  const recording = phase === 'recording';
  const submitting = phase === 'submitting';
  const isSlideCancel = recording && slideOffsetY >= SLIDE_CANCEL_THRESHOLD_PX;

  const stopTimers = useCallback(() => {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    if (meteringTimerRef.current) {
      clearInterval(meteringTimerRef.current);
      meteringTimerRef.current = null;
    }
  }, []);

  // Reset everything when the sheet closes.
  useEffect(() => {
    if (!visible) {
      setPhase('idle');
      setDurationMs(0);
      setAmplitude(0);
      setErrorMsg(null);
      setSlideOffsetY(0);
      pressStartYRef.current = null;
      stopTimers();
      recorderRef.current = null;
    }
  }, [visible, stopTimers]);

  // Auto-stop at MAX_DURATION_MS.
  useEffect(() => {
    if (phase === 'recording' && durationMs >= MAX_DURATION_MS) {
      void finalizeRecording(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, durationMs]);

  // Cleanup on unmount.
  useEffect(() => stopTimers, [stopTimers]);

  const startRecording = useCallback(async () => {
    setErrorMsg(null);
    setDurationMs(0);
    setSlideOffsetY(0);
    try {
      const expoAudio = await import('expo-audio');
      const {
        AudioModule,
        IOSOutputFormat,
        AudioQuality,
        setAudioModeAsync,
        getRecordingPermissionsAsync,
        requestRecordingPermissionsAsync,
      } = expoAudio;

      const perm = await getRecordingPermissionsAsync();
      if (!perm.granted) {
        const next = await requestRecordingPermissionsAsync();
        if (!next.granted) {
          setErrorMsg(t('voiceSettings.clonePermissionDenied'));
          setPhase('idle');
          return;
        }
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      const ext = Platform.OS === 'android' ? '.m4a' : '.caf';
      const options = {
        extension: ext,
        sampleRate: 16000,
        numberOfChannels: 1,
        bitRate: 256000,
        isMeteringEnabled: true,
        android: {
          outputFormat: 'aac_adts' as const,
          audioEncoder: 'aac' as const,
          extension: '.m4a',
        },
        ios: {
          extension: '.caf',
          outputFormat: IOSOutputFormat.LINEARPCM,
          audioQuality: AudioQuality.HIGH,
          sampleRate: 16000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
      };

      const recorder = new AudioModule.AudioRecorder(options);
      recorderRef.current = recorder;
      try {
        await recorder.prepareToRecordAsync();
      } catch {
        /* may already be prepared */
      }
      recorder.record();
      startedAtRef.current = Date.now();
      // 检查用户是否在 startRecording 进行中已松手.
      // intentToRecordRef 在 handleSheetTouchEnd 中已被清为 false,
      // 说明用户松手时 phase 还在 idle —— 这是无效按压, 立即停掉录音回到 idle.
      if (!intentToRecordRef.current) {
        try {
          await recorder.stop();
        } catch {
          /* noop */
        }
        await restorePlaybackAudioMode();
        recorderRef.current = null;
        setPhase('idle');
        return;
      }
      setPhase('recording');

      // Duration ticker.
      durationTimerRef.current = setInterval(() => {
        setDurationMs(Date.now() - startedAtRef.current);
      }, 200);

      // Metering ticker — adaptive noise floor (copied from ChatInputBar).
      noiseFloorRef.current = -45;
      meteringTimerRef.current = setInterval(async () => {
        const rec = recorderRef.current;
        if (!rec) return;
        try {
          const status = await rec.getStatus();
          const db = status?.metering;
          if (typeof db !== 'number') return;
          const threshold = noiseFloorRef.current + 15;
          if (db < threshold) {
            // Silence — slowly adapt the floor toward ambient.
            noiseFloorRef.current =
              noiseFloorRef.current * 0.995 + db * 0.005;
            setAmplitude(0);
          } else {
            setAmplitude(dbToAmplitude(db));
          }
        } catch {
          /* noop */
        }
      }, 50);
    } catch (e: any) {
      setErrorMsg(e?.message ?? t('voiceClone.errorGeneric'));
      setPhase('idle');
    }
  }, [t]);

  /**
   * Finalize the current recording.
   * @param committed true = 松开时未上划取消,正常提交;false = 上划取消,丢弃录音
   */
  const finalizeRecording = useCallback(
    async (committed: boolean) => {
      if (phase !== 'recording') return;
      stopTimers();
      setAmplitude(0);
      const recorder = recorderRef.current;
      const wasSlideCancel = isSlideCancel;

      // 取消路径:直接 stop + 不提交 + 回到 idle
      if (!committed || wasSlideCancel) {
        try {
          if (recorder) await recorder.stop();
        } catch {
          /* noop */
        }
        await restorePlaybackAudioMode();
        recorderRef.current = null;
        setPhase('idle');
        setSlideOffsetY(0);
        pressStartYRef.current = null;
        return;
      }

      if (!recorder) {
        setPhase('idle');
        return;
      }
      const finalDuration = Date.now() - startedAtRef.current;
      let uri: string | null = null;
      try {
        await recorder.stop();
        uri = recorder.uri ?? null;
      } catch {
        /* fall through to error handling below */
      }
      await restorePlaybackAudioMode();

      if (!uri || finalDuration < MIN_DURATION_MS) {
        setErrorMsg(t('voiceClone.errorTooShort'));
        setPhase('idle');
        recorderRef.current = null;
        return;
      }

      setPhase('submitting');

      try {
        const wav = await convertMobileRecordingToWav(uri);
        const file = new ExpoFile(wav.uri);
        const refText = t('voiceSettings.cloneSampleText');
        // 默认名 = i18n 模板("我的声音 {{suffix}}" / "My voice {{suffix}}" / "Minha voz {{suffix}}")
        // + 毫秒时间戳数字串,既直观又好认,后端同毫秒并发也能保证唯一。
        // 防御性截断到 60 字符(对齐 rename modal 上限),理论上 `我的声音 + 13 位时间戳` ≈ 18 字符不可能超。
        const name = t('voiceSettings.cloneDefaultName', { suffix: String(Date.now()) }).slice(0, 60);
        // 等待提交完成，失败时显示错误
        await submitClone(file, name, refText, locale);
        setPhase('closing');
        onClose();
      } catch (e: any) {
        const code = e instanceof VoiceApiError ? e.code : null;
        if (code === 'QUOTA_EXCEEDED') {
          setErrorMsg(
            t('voiceClone.errorQuota', {
              used: quota?.cloned_used ?? 0,
              max: quota?.max_cloned ?? 3,
            }),
          );
        } else if (
          typeof e?.message === 'string' &&
          (e.message.toLowerCase().includes('convert') ||
            e.message.toLowerCase().includes('caf') ||
            e.message.toLowerCase().includes('pcm'))
        ) {
          setErrorMsg(t('voiceClone.errorConvert'));
        } else if (
          typeof e?.message === 'string' &&
          (e.message.toLowerCase().includes('network') ||
            e.message.toLowerCase().includes('fetch') ||
            e.message.toLowerCase().includes('http'))
        ) {
          setErrorMsg(t('voiceClone.errorSubmit'));
        } else {
          setErrorMsg(e?.message ?? t('voiceClone.errorGeneric'));
        }
        setPhase('idle');
      } finally {
        recorderRef.current = null;
      }
    },
    [phase, isSlideCancel, quota, t, submitClone, onClose, stopTimers],
  );

  // 长条按钮手势 —— 由 buttonPanResponder 接管 (见下方).
  // 这里不再单独定义 onTouchStart handler, PanResponder 已完整处理 grant/move/release.

  /*
   * Button 手势接管 —— 用 PanResponder 而非 View.onTouch*.
   *
   * 历史问题 (m0241 "按住的没了" / m0243 "按钮没效果"):
   *   1. 纯 View.onTouchStart/Move/End 不会被 RN 触发 —— View 默认不是响应者.
   *   2. 给外层 View 加 onStartShouldSetResponderCapture=true → 它抢响应者,
   *      导致 button 完全收不到事件.
   *
   * 最终方案:
   *   - 外层蒙层: Pressable + onPress (点击空白处关闭)
   *   - button: 挂 PanResponder, 强制自己当响应者, 接管 grant/move/release.
   *     一旦 grant, 即使手指移出 button 区域 (录音中 button pointerEvents='none'
   *     让 VoiceOverlay 全屏接管), PanResponder 仍持续接收 move/release 事件.
   *
   * PanResponder 回调通过 ref 桥接 phase/isSlideCancel/finalizeRecording,
   * 避免回调陈旧 (因为 PanResponder.create 只在组件 mount 时执行一次).
   * 与 ChatInputBar 的 cbRef 模式一致.
   */
  const buttonCbRef = useRef({
    phase: 'idle' as typeof phase,
    isSlideCancel: false,
    finalizeRecording: async (_committed: boolean) => {},
    startRecording: async () => {},
  });
  buttonCbRef.current.phase = phase;
  buttonCbRef.current.isSlideCancel = isSlideCancel;
  buttonCbRef.current.finalizeRecording = finalizeRecording;
  buttonCbRef.current.startRecording = startRecording;

  const buttonPanResponder = useRef(
    PanResponder.create({
      // 强制 button 在 capture 阶段就抢响应者, 绕开外层 Pressable 的 bubble 抢占.
      // (capture 阶段从最外层 Modal 开始往 target 走, button 是最深 target,
      // capture 后被问到; Pressable 的 onStartShouldSetResponder 默认 true 但只在
      // bubble 阶段, 此时 button 已 grant, 不再询问.)
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      // bubble 阶段也保持 true 作为兜底.
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // 不使用 capture —— 避免和外层 Pressable 抢响应者.
      // (Pressable 是 button 的祖先, capture 阶段先被问到, capture=true 会
      // 让 Pressable 抢响应者, button 完全无效 —— 历史教训.)

      onPanResponderGrant: (e) => {
        pressStartYRef.current = e.nativeEvent.pageY;
        // 同步标记"用户按下 button, 录音启动中" —— 防止后续 onPanResponderRelease
        // 触发时 phase 还是 'idle' (startRecording async) 引发误操作.
        intentToRecordRef.current = true;
        safeHapticImpact(ImpactFeedbackStyle.Medium);
        void buttonCbRef.current.startRecording();
      },

      onPanResponderMove: (e) => {
        if (
          buttonCbRef.current.phase !== 'recording' ||
          pressStartYRef.current == null
        ) {
          return;
        }
        const startY = pressStartYRef.current;
        const currentY = e.nativeEvent.pageY;
        const upwardDistance = Math.max(0, startY - currentY);
        setSlideOffsetY(upwardDistance);
      },

      onPanResponderRelease: () => {
        pressStartYRef.current = null;
        intentToRecordRef.current = false;
        const cb = buttonCbRef.current;
        // 录音中 → finalize 提交/取消
        if (cb.phase === 'recording') {
          safeHapticImpact(ImpactFeedbackStyle.Light);
          void cb.finalizeRecording(!cb.isSlideCancel);
          return;
        }
        // phase==='idle' 且刚刚 grant 过 (intent=true → false 后是 false):
        // startRecording 进行中用户已松手 —— 无效按压, 不关闭弹层, 让
        // startRecording 跑完时通过 intentToRecordRef.current 检查自动回滚.
      },

      onPanResponderTerminate: () => {
        pressStartYRef.current = null;
        intentToRecordRef.current = false;
      },
    }),
  ).current;

  // 录音中: sheet 内容区隐藏(Header/样本卡片/错误条), 但 sheet 容器(蒙层 + 卡片) 仍渲染.
  // 理由: 录音中按钮需要继续接收 onPressOut / onTouchMove 才能完成"松开提交" + "上划取消".
  // 视觉上 VoiceOverlay 在 sheet 之上全屏接管(弧形 + 波形 + 提示), 完全遮挡 sheet.
  // 这与 chat 行为一致 —— 进入录音时, UI 完全让位给 VoiceOverlay.
  const showContent = !recording;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/*
       * 外层蒙层: 纯 View (非 Pressable).
       *
       * 关键决策: 不用 Pressable + onPress 实现"点击空白关闭" —— Pressable 会
       * 注册为响应者, 与 button 的 PanResponder 抢响应者, 导致 button 的
       * onStartShouldSetPanResponder 即使返回 true 也会被 Pressable 的 bubble
       * 阶段抢走, button.onTouchStart 完全收不到事件 (历史 bug m0243).
       *
       * 空白关闭改为:
       *   1. Modal.onRequestClose: Android 物理返回键 + iOS 下滑手势关闭.
       *   2. Header X 按钮 Pressable.onPress: 显式关闭按钮.
       * 用户可以拖动 Modal 下滑关闭 (iOS 默认行为, RN Modal transparent 支持).
       *
       * 与 ChatInputBar 结构对齐 —— 它的外层也不是 Pressable.
       */}
      <View
        className="flex-1 bg-black/60 justify-end"
      >
        <View
          style={{ maxHeight: sheetMaxHeight, minHeight: 620 }}
          className="bg-aura-surface rounded-t-3xl px-6 pt-5 pb-8"
        >
          {/* Header —— 仅在未录音时显示 */}
          {showContent && (
            <View className="flex-row items-center justify-between mb-4">
              <Text className="text-headline-sm font-bold text-aura-primary">
                {t('voiceClone.title')}
              </Text>
              <Pressable
                onPress={onClose}
                hitSlop={12}
                disabled={submitting}
                className="p-1 rounded-full"
              >
                <Ionicons name="close" size={24} className="text-aura-on-surface-variant" />
              </Pressable>
            </View>
          )}

          {/* prompt 提示 —— 仅在未录音时显示（让位给 VoiceOverlay） */}
          {showContent && (
            <Text className="text-sm text-aura-on-surface/70 mb-3 text-center">
              {t('voiceClone.prompt')}
            </Text>
          )}
          {/* 朗读样本卡片 —— 录音时也保留显示,方便用户照着稿子念 */}
          <View className="bg-aura-surface-container rounded-2xl px-5 py-6 mb-5">
            <Text className="text-[22px] leading-9 text-aura-on-surface font-medium text-center">
              {t('voiceSettings.cloneSampleText')}
            </Text>
          </View>

          {/* 提交中 */}
          {submitting && (
            <View className="items-center mb-5">
              <ActivityIndicator />
              <Text className="text-xs text-aura-on-surface/60 mt-2">
                {t('voiceClone.submitting')}
              </Text>
            </View>
          )}

          {/* 错误提示 —— 非录音、非提交时显示 */}
          {errorMsg && !recording && !submitting && (
            <View className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2 mb-3">
              <Text className="text-sm text-red-500">{errorMsg}</Text>
            </View>
          )}

          {/* 长方形 "按住录音" 按钮:
               - 未录音: 显示"按住 录制"文案 (purple)
               - 按下立即 startRecording, 无颜色变深反馈 (无 holdTimer)
               - 录音中: opacity 0 + pointerEvents=none, 完全让位给 VoiceOverlay 全屏接管
                 (与 ChatInputBar.micButton 行为一致)
               - 上划取消: 红色 (录音中虽不可见, 内部 isSlideCancel 状态仍驱动 VoiceOverlay 弧形变红)
               - VoiceOverlay 全屏覆盖其上, 效果与 chat 完全一致 */}
          <View className="items-center mt-auto">
            {/*
             * button 改成纯 View + onTouchStart 而非 Pressable.
             * 关键原因: Pressable 会自动注册为响应者, 抢走外层 sheet 的
             * onTouchMove/onTouchEnd —— 这就是历史上"上滑不能取消"的根因.
             * 纯 View 不会成为响应者, sheet 层 onTouchMove/onTouchEnd 才能正常接收.
             *
             * 录音中 button pointerEvents='none' 让 VoiceOverlay 接管视觉.
             * 上划/松手由 sheet 外层 View 统一处理.
             */}
            <View
              // PanResponder 接管所有手势: grant → startRecording,
              // move → slideOffsetY, release → finalizeRecording.
              // 用 {...panResponder.panHandlers} 展开所有响应者回调到 View.
              {...buttonPanResponder.panHandlers}
              // 录音中 button pointerEvents='none' 让 VoiceOverlay 接管视觉 + hit test,
              // 防止 button 在录音中误接收触摸 —— 与 ChatInputBar 一致.
              pointerEvents={recording ? 'none' : 'auto'}
              style={{
                width: '100%',
                height: 56,
                borderRadius: 16,
                backgroundColor: isSlideCancel
                  ? '#DC2626'
                  : recording
                    ? '#4F46E5'
                    : '#1D4ED8',
                opacity: submitting ? 0.5 : recording ? 0 : 1,
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'row',
                shadowColor: '#000',
                shadowOpacity: 0.2,
                shadowRadius: 8,
                shadowOffset: { width: 0, height: 2 },
                elevation: 4,
              }}
            >
              <Ionicons
                name={recording ? 'mic' : 'mic-outline'}
                size={22}
                color="white"
                style={{ marginRight: 8 }}
              />
              <Text className="text-white font-semibold text-base">
                {recording
                  ? t('voiceClone.recording')
                  : t('voiceClone.holdToRecord')}
              </Text>
            </View>
          </View>
        </View>
      </View>

      {/*
       * VoiceOverlay 用 mode='clone' 渲染: 弧形背景 + 波形 + 上划提示,
       * 行为/视觉与 chat 完全一致. TouchGlowLayer 在 clone 模式下不渲染
       * (因为 sheet 长条按钮不需要跟随手指绘制光晕).
       */}
      <VoiceOverlay
        visible={recording}
        onClose={() => {
          /* no-op — gesture drives lifecycle in VoiceCloneSheet */
        }}
        mode="clone"
        amplitude={amplitude}
        isSlideCancel={isSlideCancel}
      />
    </Modal>
  );
}
