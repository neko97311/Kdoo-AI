import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Image,
  Platform,
  Dimensions,
  PanResponder,
  Keyboard,
} from 'react-native';
import { useVoiceStore } from '@/stores/voice';
import { isWeb } from '@/utils/platform';
import { useKeyboard } from '@/hooks/useKeyboard';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { VoiceOverlay } from './VoiceOverlay';
import { ImagePreviewOverlay } from './ImagePreviewOverlay';
import { useI18n } from '@/hooks/useI18n';
import { useToastStore } from '@/stores/toast';
import type { Attachment, WsContentBlock } from '@/types';
import { takePhoto, pickDocument, pickMultipleImagesFromGallery } from '@/utils/attachments';
import { setComposeResultHandler, registerComposeSender } from '@/utils/photo-compose';
import { setCameraResultHandler } from '@/utils/camera-bridge';
import { attachmentToContentBlockWithUpload } from '@/services/upload-service';
import { createMessageBlocks } from '@/utils/message-blocks';
import { useChatStore } from '@/stores/chat';
import { useShareIntoUiStore } from '@/stores/share-into-ui';
import { pauseForRecording, resumeAfterRecording } from '@/stores/tts';
import { createTrackPlayerProbe } from '@/utils/audio-coordination';
import { useColors } from '@/hooks/useColors';
import { safeHapticImpact, ImpactFeedbackStyle } from '@/utils/haptics';
import { logger } from '@/utils/logger';

interface ChatInputBarProps {
  onSend: (text: string, blocks: WsContentBlock[]) => void;
  isCreating?: boolean;
  /** v19 cancel-then-send: while waiting for the old stream's cancel-ack,
   *  ChatInputBar is locked — pressing the send button is a no-op and the
   *  TextInput's editable flag flips off so the user can't type or queue a
   *  second message (which would never get sent and would confuse the queue). */
  isSendingDisabled?: boolean;
  onRecordingChange?: (recording: boolean) => void;
}

const INPUT_PILL_RADIUS = 8;
/** Minimum recording duration (ms). Recordings shorter than this are
 *  silently discarded — no send, no tip. */
const MIN_RECORDING_MS = 1000;
/** Input area minHeight — compensates for platform-specific TextInput internal padding.
 *  Voice mode uses a plain View (no internal padding), Text mode uses TextInput
 *  which has platform-specific internal padding that can't be fully zeroed. */
const INPUT_MIN_HEIGHT = Platform.select({ android: 36, ios: 36, default: 32 });
/** Input area maxHeight — caps multi-line growth. Beyond this the input
 *  scrolls internally (native) or via overflow (web). ~5 lines. */
const INPUT_MAX_HEIGHT = 120;

/** Map a dBFS metering value to a 0..1 amplitude using a sqrt curve so
 *  quieter voices still get visible bar movement. Silence gating is now
 *  handled by the adaptive noise floor in the metering poller (see
 *  startRecording / metering effect), NOT here — this function is a pure
 *  loudness-to-height mapping called only when speech is detected.
 *
 *  Reference: 0 dB = full scale; -35 dB ≈ very quiet speech; -60 dB ≈
 *  noise floor. We map the [-60, 0] dB range to [0, 1]. */
function dbToAmplitude(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0;
  if (db >= 0) return 1;
  return Math.sqrt((db + 60) / 60);
}

/** Get a display icon name for a file type (inlined to avoid heavy module import) */
function getFileIconName(mediaType: string): string {
  if (mediaType.startsWith('image/')) return 'image-outline';
  if (mediaType.startsWith('video/')) return 'videocam-outline';
  if (mediaType.startsWith('audio/')) return 'musical-notes-outline';
  if (mediaType.includes('pdf')) return 'document-text-outline';
  if (mediaType.includes('zip') || mediaType.includes('rar') || mediaType.includes('tar'))
    return 'archive-outline';
  if (mediaType.includes('spreadsheet') || mediaType.includes('excel') || mediaType.includes('csv'))
    return 'grid-outline';
  if (mediaType.includes('presentation') || mediaType.includes('powerpoint'))
    return 'easel-outline';
  if (mediaType.includes('word') || mediaType.includes('document'))
    return 'document-text-outline';
  return 'document-outline';
}

export function ChatInputBar({ onSend, isCreating, isSendingDisabled, onRecordingChange }: ChatInputBarProps) {
  const { t } = useI18n();
  const c = useColors();
  const router = useRouter();
  const { isKeyboardVisible } = useKeyboard();
  const [inputText, setInputText] = useState('');
  const [isVoiceMode, setIsVoiceMode] = useState(true);
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isSlideCancel, setIsSlideCancel] = useState(false);
  const [preview, setPreview] = useState<{ uris: string[]; index: number } | null>(null);
  const [touchX, setTouchX] = useState(0);
  const [touchY, setTouchY] = useState(0);
  const [amplitude, setAmplitude] = useState(0);
  const [isTextInputFocused, setIsTextInputFocused] = useState(false);
  const webInputWrapRef = useRef<View>(null);
  const hasText = inputText.trim().length > 0;
  const hasAttachments = attachments.length > 0;
  const isSlideCancelRef = useRef(false);
  const isRecordingRef = useRef(false);
  const recordingRef = useRef<{
    recorder: any;
    stop: () => Promise<string>;
  } | null>(null);
  const audioRecorderRef = useRef<any>(null);
  const pendingStopRef = useRef(false);
  const recordingStartedAtRef = useRef(0);
  // ── 录音 ↔ 音乐让路 ─────────────────────────────────────────────
  // 录音开始时若背景音乐（react-native-track-player）正在播放则暂停，
  // 否则麦克风会把 BGM 噪声录进 ASR；录音任何退出路径（发送/取消/
  // 过短/权限拒绝/失败）对称恢复。只暂停"当时确实在播"的音乐，
  // 别人暂停的（如被 TTS duck）不碰，避免错误恢复。
  // musicPauseOpRef 让 resume 先 await 进行中的暂停操作 —— 快速点按
  // 时不会出现"暂停还没做完就 resume → 音乐被永久停在暂停态"的竞态。
  const musicPauseOpRef = useRef<Promise<void> | null>(null);
  const musicPausedByRecordingRef = useRef(false);
  const meteringTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Adaptive noise floor for VAD-like silence gating. Tracks the ambient
  // room level via EMA so the waveform stays still when the user isn't
  // talking, regardless of environment (quiet office, HVAC, cafe). Speech
  // must exceed noiseFloor + VAD_MARGIN_DB to register as voice. Reset to
  // INITIAL_NOISE_FLOOR at the start of every recording so each session
  // re-calibrates. Tuned values from the rn-vad reference implementation.
  const INITIAL_NOISE_FLOOR_DB = -45;
  const VAD_MARGIN_DB = 15;
  const VAD_ADAPTATION_RATE = 0.995; // EMA weight: ~0.5s to converge at 50ms poll
  const noiseFloorRef = useRef(INITIAL_NOISE_FLOOR_DB);
  const setPendingUserMessage = useChatStore((s) => s.setPendingUserMessage);
  const textInputRef = useRef<TextInput>(null);
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  // v19: mirror isSendingDisabled into a ref so handleSend can read the
  // current value without taking it as a dep (which would force re-creating
  // the function on every flag flip and bust downstream memoization).
  const isSendingDisabledRef = useRef(!!isSendingDisabled);
  isSendingDisabledRef.current = !!isSendingDisabled;
  // Mirror isUploading so buildBlocksAndSend — which is also invoked
  // asynchronously from the photo-compose callback bridge — reads the
  // current value via ref instead of capturing a stale state closure.
  const isUploadingRef = useRef(false);
  isUploadingRef.current = isUploading;
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachments;
  const inputTextRef = useRef('');
  inputTextRef.current = inputText;

  useEffect(() => {
    onRecordingChange?.(isRecording);
  }, [isRecording, onRecordingChange]);

  // ─── Shared send pipeline ──────────────────────────────────
  // Extracted from the former handleSend so both the classic chat send and
  // the photo-compose result send funnel through the SAME guards, block
  // construction, upload, onSend call, and error handling. Uses refs
  // (isSendingDisabledRef / isUploadingRef / onSendRef) so it is safe to
  // call from a deferred context (the compose callback bridge stores this
  // function and invokes it when the user taps Send on /photo-compose).
  const buildBlocksAndSend = useCallback(
    async (text: string, attachmentsToSend: Attachment[]) => {
      // v19 cancel-then-send: while the old stream's cancel-ack is still in
      // flight, ignore send attempts. The UI also disables the Pressable +
      // TextInput for visual feedback, but this guard prevents a race where
      // two sends land in the queue between the cancelStream and the ack.
      if (isSendingDisabledRef.current) return;
      if (!text && attachmentsToSend.length === 0) return;
      if (isUploadingRef.current) return;

      setIsUploading(true);
      setPendingUserMessage(true);
      try {
        const blocks = await createMessageBlocks(text, attachmentsToSend);
        onSendRef.current(text, blocks);
      } catch (err: any) {
        setPendingUserMessage(false);
        useToastStore
          .getState()
          .showToast({ message: err.message || t('chatInput.uploadFailed'), variant: 'warning' });
      } finally {
        setIsUploading(false);
      }
    },
    [],
  );

  // Bridge entry-point for the photo-compose page: receives the final
  // (text, attachments) collected on /photo-compose and funnels them into
  // the exact same pipeline as handleSend — all guards shared by
  // construction.
  const sendFromCompose = useCallback(
    (text: string, attachments: Attachment[]) => buildBlocksAndSend(text, attachments),
    [buildBlocksAndSend],
  );

  // Register sendFromCompose as the PERSISTENT default compose sender while the
  // chat screen (this input bar) is mounted. /photo-compose can now be opened
  // from ANY entry point — not just this bar's own picker handlers — and still
  // deliver its result: a ChatBubble image tap calls activateComposeSender()
  // before pushing, which promotes this default into the one-shot slot. The
  // bar's own handlePickImage/handleTakePhoto still call setComposeResultHandler
  // explicitly, so those flows are unaffected.
  useEffect(() => {
    registerComposeSender(sendFromCompose);
  }, [sendFromCompose]);

  // Share-into image bridge: an image shared from the system sheet lands in
  // the input bar as a pending attachment chip; the user adds text & sends.
  const pendingShareImage = useShareIntoUiStore((s) => s.pendingImage);
  useEffect(() => {
    if (!pendingShareImage) return;
    const att = useShareIntoUiStore.getState().consumePendingImage();
    if (att) setAttachments((prev) => [...prev, att]);
  }, [pendingShareImage]);

  const handleSend = async () => {
    // Capture values and clear UI IMMEDIATELY so the input box is empty
    // before the loading indicator appears (Bug 2 fix).
    const textToSend = inputText.trim();
    const attachmentsToSend = [...attachments];
    setInputText('');
    setAttachments([]);
    // Dismiss keyboard so the user can see the AI response streaming in.
    // Without this, the keyboard stays open and obscures the bottom portion
    // of the conversation after every send.
    if (!isWeb) {
      Keyboard.dismiss();
      // iOS autocorrect (联想) fix: a pending correction is "marked text"
      // that only gets committed into the native TextInput when editing ends
      // (keyboard dismiss) — which runs AFTER React already cleared `value`
      // and does NOT fire onChangeText. So the suggestion text silently
      // lands back in the input box. Imperatively force the native field
      // back to empty once the commit has landed.
      if (Platform.OS === 'ios') {
        setTimeout(() => textInputRef.current?.setNativeProps({ text: '' }), 150);
      }
    }

    await buildBlocksAndSend(textToSend, attachmentsToSend);
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const toggleMode = () => {
    const willBeTextMode = isVoiceMode;
    setIsVoiceMode(!isVoiceMode);
    setIsActionsOpen(false);
    // Auto-focus TextInput when switching to text mode on mobile
    if (willBeTextMode && !isWeb) {
      setTimeout(() => textInputRef.current?.focus(), 100);
    }
  };

  const toggleActions = () => {
    setIsActionsOpen(!isActionsOpen);
  };

  // Web-only: on each inputText change, imperatively apply the standard
  // reset-measure-set pattern to the underlying <textarea> DOM.
  //
  // WHY IMPERATIVE: declarative height via onContentSizeChange creates a
  // feedback loop (ResizeObserver reports rendered height → state updates →
  // element grows → observer fires again → unbounded growth).
  //
  // WHY rows=1: HTML <textarea> defaults to rows=2, giving an initial height
  // of ~2 lines. scrollHeight would then report 2 lines even for empty input,
  // making the textarea appear as "two lines tall" with placeholder sitting on
  // the top line (NOT vertically centered). Forcing rows=1 collapses the
  // baseline to a single line so scrollHeight reflects true content.
  useLayoutEffect(() => {
    if (!isWeb) return;
    const wrap = webInputWrapRef.current as unknown as HTMLDivElement | null;
    if (!wrap) return;
    const ta = wrap.querySelector('textarea');
    if (!ta) return;
    // Collapse to single-row baseline before measuring true content height.
    ta.setAttribute('rows', '1');
    ta.style.height = 'auto';
    const wanted = ta.scrollHeight;
    const min = INPUT_MIN_HEIGHT ?? 32;
    const final = Math.max(min, Math.min(wanted, INPUT_MAX_HEIGHT));
    ta.style.height = `${final}px`;
  }, [inputText]);

  // ─── Picker handlers (lazy-loaded imports) ─────────────────

  const handlePickImage = async () => {
    const photos = await pickMultipleImagesFromGallery();
    if (photos.length > 0) {
      setComposeResultHandler(sendFromCompose);
      router.push({ pathname: '/photo-compose', params: { initial: JSON.stringify(photos) } });
    }
    setIsActionsOpen(false);
  };

  const handleTakePhoto = async () => {
    if (Platform.OS === 'web') {
      const photo = await takePhoto();
      if (photo) {
        setComposeResultHandler(sendFromCompose);
        router.push({ pathname: '/photo-compose', params: { initial: JSON.stringify([photo]) } });
      }
    } else {
      setCameraResultHandler((photo) => {
        setComposeResultHandler(sendFromCompose);
        router.push({ pathname: '/photo-compose', params: { initial: JSON.stringify([photo]) } });
      });
      router.push('/camera');
    }
    setIsActionsOpen(false);
  };

  const handlePickDocument = async () => {
    const result = await pickDocument();
    if (result) {
      setAttachments((prev) => [...prev, result]);
    }
    setIsActionsOpen(false);
  };

  const handleVoiceCall = async () => {
    setIsActionsOpen(false);

    let sessionId = useChatStore.getState().currentSessionId;
    if (!sessionId) {
      try {
        const now = new Date();
        const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const newId = await useChatStore.getState().createSessionAsync({
          agentId: 'default',
          name: t('voiceCall.sessionName', { ts }),
        });
        if (!newId) {
          useToastStore
            .getState()
            .showToast({ message: t('voiceCall.sessionCreateFailed'), variant: 'warning' });
          return;
        }
        sessionId = newId;
      } catch (e) {
        logger.error('voice-call', 'create session failed', e);
        return;
      }
    }

    useVoiceStore.getState().prepareCall();
    useVoiceStore.getState().openVoiceCall({ sessionId });
  };

  // ─── Voice recording ───────────────────────────────────────

  // Restore playback-friendly audio mode after recording. expo-audio's
  // setAudioModeAsync({ allowsRecording: true }) keeps the iOS session
  // in recording mode; without flipping it back, audioCtx.resume() may
  // fail to reactivate the playback session. MUST be awaited before
  // calling resumeAfterRecording so the session is in playback mode.
  const restorePlaybackAudioMode = useCallback(async () => {
    if (isWeb) return;
    try {
      const { setAudioModeAsync } = await import('expo-audio');
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    } catch (e) {
        logger.warn('ChatInputBar', 'restore audio mode failed', e);
    }
  }, []);

  // 录音开始 → 暂停正在播放的音乐。fire-and-forget：不阻塞按住说话
  // 手势的响应速度；resumeMusicAfterRecording 会先 await 本操作再恢复。
  const pauseMusicForRecording = useCallback(() => {
    if (isWeb) return;
    musicPauseOpRef.current = (async () => {
      try {
        const probe = await createTrackPlayerProbe();
        if (!probe) return;
        if (await probe.isPlaying()) {
          await probe.pause();
          musicPausedByRecordingRef.current = true;
        }
      } catch (e) {
        logger.warn('ChatInputBar', 'pause music for recording failed', e);
      }
    })();
  }, []);

  // 录音退出 → 对称恢复音乐。必须先 await 进行中的暂停操作完成，
  // 再检查"是否由我们暂停"，两者才不会竞态。
  const resumeMusicAfterRecording = useCallback(async () => {
    const op = musicPauseOpRef.current;
    musicPauseOpRef.current = null;
    if (op) {
      try {
        await op;
      } catch {
        // pauseMusicForRecording 内部已记日志。
      }
    }
    if (!musicPausedByRecordingRef.current) return;
    musicPausedByRecordingRef.current = false;
    try {
      const probe = await createTrackPlayerProbe();
      await probe?.play();
    } catch (e) {
      logger.warn('ChatInputBar', 'resume music after recording failed', e);
    }
  }, []);

  const startRecording = useCallback(async () => {
    setIsRecording(true);
    isRecordingRef.current = true;
    pendingStopRef.current = false;
    recordingStartedAtRef.current = Date.now();
    // Pause TTS pipeline so recording gets exclusive use of the audio
    // session (iOS AVAudioSession conflict). No-op if no pipeline is
    // active. The WS stays open so the server keeps synthesizing; PCM
    // chunks buffer in pendingChunks and flush seamlessly on resume.
    pauseForRecording();
    // 同样让背景音乐让路：避免 ASR 录进 BGM（退出路径对称恢复）。
    pauseMusicForRecording();
    try {
      if (isWeb) {
        const { isMediaRecorderSupported, startWebRecording } = await import('@/services/voice-service');
        if (isMediaRecorderSupported()) {
          const web = startWebRecording();
          // Wrap the web shim to match the mobile shape (`recorder` is
          // undefined on web because MediaRecorder has no metering API,
          // so the metering effect simply no-ops on this platform).
          recordingRef.current = {
            recorder: undefined,
            stop: web.stop,
          };
          return;
        }
      }
      // Mobile: dynamically import expo-audio ONLY when user actually records.
      // This prevents the native audio module from loading at component mount,
      // which would trigger iOS microphone permission prompt on app launch.
      // NOTE: AudioRecorder is NOT a named export of expo-audio — it's only
      // accessible as AudioModule.AudioRecorder.
      const {
        AudioModule,
        IOSOutputFormat,
        AudioQuality,
        setAudioModeAsync,
        getRecordingPermissionsAsync,
        requestRecordingPermissionsAsync,
      } = await import('expo-audio');
      const permStatus = await getRecordingPermissionsAsync();
      if (!permStatus.granted) {
        const { granted } = await requestRecordingPermissionsAsync();
        if (!granted) {
          setIsRecording(false);
          isRecordingRef.current = false;
          // Recording never started — undo the pause so TTS can resume.
          resumeAfterRecording();
          void resumeMusicAfterRecording();
          return;
        }
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      // Native 16 kHz mono. Container differs per platform because
      // Android's MediaRecorder cannot emit raw PCM and iOS's
      // AVAudioRecorder cannot write a WAV container. The downstream
      // voice-service.ts strips the container and re-packs the samples
      // as a standard RIFF/WAVE blob so the STT upstream sees exactly
      // what it expects.
      //
      // IMPORTANT: the top-level `extension` field is read by expo-audio
      // on BOTH platforms (see expo-audio's Kotlin AudioRecorder.kt
      // `recording-${UUID}${options.extension}`). Mismatching the
      // extension with the actual container produces a file whose name
      // lies about its content — voice-service then tries to parse the
      // wrong format and falls back to raw upload. We pick the top-level
      // extension per platform so the filename always matches reality.
      const recordingExtension = Platform.OS === 'android' ? '.m4a' : '.caf';
      const wavLikeRecordingOptions = {
        extension: recordingExtension,
        sampleRate: 16000,
        numberOfChannels: 1,
        bitRate: 256000,
        // Enables dBFS metering on the recorder so the HoldSpeak overlay
        // can read real-time volume via `recorder.getStatus().metering`.
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
      // Create a fresh AudioRecorder instance per recording session.
      // Reusing the same instance across sessions would reuse the same
      // output file path (UUID is generated once at construction on the
      // native side), so subsequent recordings would either overwrite the
      // previous file or — depending on the native prepare path — record
      // to the same stale URI. Always allocate a new recorder so each
      // session gets its own `recording-{UUID}.{caf,m4a}` on disk.
      audioRecorderRef.current = new AudioModule.AudioRecorder(wavLikeRecordingOptions);
      const recorder = audioRecorderRef.current;
      // [VoiceDiag] log: recorder instance created — first or reuse?
      logger.debug(
        'VoiceDiag',
        `[${new Date().toISOString().slice(11, 23)}] new AudioRecorder created, ref.id=${recorder?.id ?? '?'} audioRecorderRef.wasNull=${audioRecorderRef.current === recorder ? 'first' : 'reuse'}`,
      );
      try {
        await recorder.prepareToRecordAsync();
        logger.debug('VoiceDiag', `[${new Date().toISOString().slice(11, 23)}] prepareToRecordAsync ok`);
      } catch (prepErr: any) {
        // Recorder may already be prepared — safe to continue
        logger.debug('VoiceDiag', `[${new Date().toISOString().slice(11, 23)}] prepareToRecordAsync THREW (silently swallowed):`, prepErr?.message ?? prepErr);
      }
      // If user released finger during async setup, stop immediately
      if (pendingStopRef.current) {
        recorder.record();
        await recorder.stop();
        setIsRecording(false);
        isRecordingRef.current = false;
        pendingStopRef.current = false;
        // Recording was paused but immediately cancelled — resume TTS.
        resumeAfterRecording();
        void resumeMusicAfterRecording();
        return;
      }
      // [VoiceDiag] log: record() is a Swift `Function` (not Async) that
      // internally `throws`. Expo modules wrap throws in a Promise
      // rejection — so NOT awaiting it can turn "allowRecording denied"
      // / "permission denied" into an unhandled rejection that bypasses
      // our outer try/catch and leaves isRecording=true while the native
      // recorder never actually starts.
      try {
        const recordResult = recorder.record();
        logger.debug(
          'VoiceDiag',
          `[${new Date().toISOString().slice(11, 23)}] recorder.record() returned (sync)`,
          { isPromise: typeof recordResult?.then === 'function', keys: recordResult ? Object.keys(recordResult) : null },
        );
        if (recordResult && typeof recordResult.then === 'function') {
          const resolved = await recordResult;
          logger.debug('VoiceDiag', `[${new Date().toISOString().slice(11, 23)}] record() promise resolved:`, resolved);
        }
      } catch (recordErr: any) {
        logger.warn('VoiceDiag', 'recorder.record() THREW', recordErr?.message ?? recordErr);
        throw recordErr;
      }
      recordingRef.current = {
        recorder,
        stop: async () => {
          await recorder.stop();
          return recorder.uri || '';
        },
      };
    } catch (err) {
      logger.warn('ChatInputBar', 'Failed to start recording', err);
      setIsRecording(false);
      isRecordingRef.current = false;
      // Recording failed to start — undo the pause so TTS can resume.
      resumeAfterRecording();
      void resumeMusicAfterRecording();
    }
  }, []);

  const stopRecording = useCallback(async () => {
    logger.debug('VoiceDebug', `[${new Date().toISOString().slice(11, 23)}] stopRecording ENTRY — isRecordingRef:${isRecordingRef.current} recordingRef:${!!recordingRef.current} pendingStop:${pendingStopRef.current}`);
    setIsRecording(false);
    isRecordingRef.current = false;

    // If recording hasn't fully started yet (async still in flight),
    // flag it so startRecording can clean up after prepare completes
    if (!recordingRef.current) {
      logger.debug('VoiceDebug', 'recordingRef null → pendingStop path (async prepare still in flight)');
      pendingStopRef.current = true;
      setPendingUserMessage(false);
      return;
    }

    // Silently discard recordings shorter than MIN_RECORDING_MS.
    // No send, no tip — the user just tapped too briefly.
    const durationMs = Date.now() - recordingStartedAtRef.current;
    logger.debug('VoiceDebug', `duration=${durationMs}ms (MIN=${MIN_RECORDING_MS}ms)`);
    if (durationMs < MIN_RECORDING_MS) {
      try {
        if (recordingRef.current) {
          await recordingRef.current.stop();
          recordingRef.current = null;
        }
      } catch (err) {
        logger.warn('ChatInputBar', 'Failed to stop short recording', err);
      }
      setPendingUserMessage(false);
      // Restore playback audio mode, then resume TTS pipeline. Order
      // matters: iOS needs the session flipped back to playback before
      // audioCtx.resume() can reactivate.
      await restorePlaybackAudioMode();
      resumeAfterRecording();
      void resumeMusicAfterRecording();
      return;
    }

    // Capture and clear input IMMEDIATELY for UI responsiveness (Bug 2 fix).
    const pendingAttachments = [...attachmentsRef.current];
    const pendingText = inputTextRef.current.trim();
    setInputText('');
    setAttachments([]);

    setPendingUserMessage(true);
    try {
      let audioUri = '';
      if (recordingRef.current) {
        audioUri = await recordingRef.current.stop();
        recordingRef.current = null;
      }
      logger.debug('VoiceDebug', `[${new Date().toISOString().slice(11, 23)}] recorder.stop() returned audioUri="${audioUri ? audioUri.slice(0, 50) + '…' : '(empty)'}" len=${audioUri.length}`);
      // Recording is fully stopped — flip iOS session back to playback
      // mode, then resume the TTS pipeline (flush any buffered PCM
      // chunks so playback continues from where it left off).
      await restorePlaybackAudioMode();
      resumeAfterRecording();
      void resumeMusicAfterRecording();
      if (audioUri) {
        // Upload any pending attachments so they're sent alongside voice (Bug 1 fix).
        const blocks: WsContentBlock[] = [];
        for (const att of pendingAttachments) {
          const block = await attachmentToContentBlockWithUpload(att);
          blocks.push(block);
        }
        // Store audioUri for async transcription in handleHomeSend / ChatView.
        useChatStore.getState().setPendingAudioUri(audioUri);
        logger.debug('VoiceDebug', `setPendingAudioUri done → calling onSend(text="${pendingText.slice(0, 20)}", ${blocks.length} blocks)`);
        // Pass attachment blocks so they're included in the voice send flow.
        onSendRef.current(pendingText, blocks);
      } else {
        logger.warn('VoiceDebug', '⚠ audioUri EMPTY — no send, no toast (silent drop)');
        setPendingUserMessage(false);
      }
    } catch (err) {
      logger.warn('VoiceDebug', '⚠ EXCEPTION in stopRecording', err);
      setPendingUserMessage(false);
      logger.warn('ChatInputBar', 'Failed to stop recording', err);
      // Best-effort: restore playback mode + resume TTS even on error
      // so a recorder failure doesn't leave TTS permanently paused.
      await restorePlaybackAudioMode();
      resumeAfterRecording();
      void resumeMusicAfterRecording();
    }
  }, []);

  const cancelRecording = useCallback(async () => {
    setIsRecording(false);
    isRecordingRef.current = false;
    if (!recordingRef.current) {
      pendingStopRef.current = true;
      return;
    }
    try {
      if (recordingRef.current) {
        await recordingRef.current.stop();
        recordingRef.current = null;
      }
    } catch (err) {
      logger.warn('ChatInputBar', 'Failed to cancel recording', err);
    }
    // Restore playback mode + resume TTS pipeline (recording was cancelled,
    // so any buffered PCM chunks flush and playback continues).
    await restorePlaybackAudioMode();
    resumeAfterRecording();
    void resumeMusicAfterRecording();
  }, []);

  const ARC_RATIO = 0.25;
  const screenH = Dimensions.get('screen').height;
  const arcExitY = screenH * (1 - ARC_RATIO * 1.1);
  const arcEnterY = screenH * (1 - ARC_RATIO * 0.9);

  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleGestureStart = useCallback(
    (absoluteX: number, absoluteY: number) => {
      // Haptic feedback the instant recording engages (holdTimer fires).
      // Fire-and-forget — no await, never blocks the gesture chain.
      // Web is a no-op (Haptics module no-ops on web).
      safeHapticImpact(ImpactFeedbackStyle.Medium);
      logger.debug('Voice', `start y=${Math.round(absoluteY)}`);
      isSlideCancelRef.current = false;
      setTouchX(absoluteX);
      setTouchY(absoluteY);
      setIsSlideCancel(false);
      startRecording();
    },
    [startRecording],
  );

  const handleGestureUpdate = useCallback(
    (absoluteX: number, absoluteY: number) => {
      setTouchX(absoluteX);
      setTouchY(absoluteY);
      if (!isRecordingRef.current) return;
      const shouldCancel = !isSlideCancelRef.current && absoluteY < arcExitY;
      const shouldRecover = isSlideCancelRef.current && absoluteY > arcEnterY;
      if (shouldCancel) {
        logger.debug('Voice', `→ cancel y=${Math.round(absoluteY)}`);
        // Haptic on entering cancel zone (lighter than the press-down Medium
        // so the user can feel the state transition without being heavy).
        safeHapticImpact(ImpactFeedbackStyle.Light);
        isSlideCancelRef.current = true;
        setIsSlideCancel(true);
      } else if (shouldRecover) {
        logger.debug('Voice', `→ recover y=${Math.round(absoluteY)}`);
        // Haptic on leaving cancel zone (back to send zone).
        safeHapticImpact(ImpactFeedbackStyle.Light);
        isSlideCancelRef.current = false;
        setIsSlideCancel(false);
      }
    },
    [arcEnterY, arcExitY],
  );

  const handleGestureEnd = useCallback(() => {
    logger.debug('Voice', `end cancel=${isSlideCancelRef.current}`);
    if (!isRecordingRef.current) return;
    if (isSlideCancelRef.current) {
      cancelRecording();
    } else {
      stopRecording();
    }
    isSlideCancelRef.current = false;
    setIsSlideCancel(false);
  }, [cancelRecording, stopRecording]);

  const handleGestureFinalize = useCallback(() => {
    isSlideCancelRef.current = false;
    setIsSlideCancel(false);
  }, []);

  const cbRef = useRef({ handleGestureStart, handleGestureUpdate, handleGestureEnd, handleGestureFinalize });
  cbRef.current = { handleGestureStart, handleGestureUpdate, handleGestureEnd, handleGestureFinalize };

  // Short-press handler — invoked when a tap on a panHandlers surface lifts
  // before the 100ms hold threshold (i.e. didn't engage recording). In text
  // mode with no text + keyboard dismissed, this focuses the TextInput so the
  // user can start typing; null in voice mode (short tap is a no-op there).
  const shortPressHandlerRef = useRef<(() => void) | null>(null);

  // PanResponder replaces RNGH GestureDetector. RNGH's native gesture
  // recognizers conflict with iOS system gestures ("System gesture gate
  // timed out") and sibling ScrollView pan recognizers, causing complete
  // gesture failure on iOS. PanResponder uses RN's built-in JS responder
  // system which is cooperative and reliable.
  const voicePanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const { pageX, pageY } = e.nativeEvent;
        holdTimerRef.current = setTimeout(() => {
          cbRef.current.handleGestureStart(pageX, pageY);
        }, 100);
      },
      onPanResponderMove: (e) => {
        if (!isRecordingRef.current) return;
        const { pageX, pageY } = e.nativeEvent;
        cbRef.current.handleGestureUpdate(pageX, pageY);
      },
      onPanResponderRelease: () => {
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
          // Short tap: lifted before the 100ms hold threshold, so recording
          // never engaged. If a short-press handler is registered (text mode:
          // focus TextInput to let the user type), fire it now.
          if (shortPressHandlerRef.current) {
            shortPressHandlerRef.current();
          }
        }
        if (isRecordingRef.current) {
          cbRef.current.handleGestureEnd();
        }
      },
      onPanResponderTerminate: () => {
        if (holdTimerRef.current) {
          clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
        }
        if (isRecordingRef.current) {
          cbRef.current.handleGestureEnd();
        }
      },
    }),
  ).current;

  // ─── Metering polling (mobile-only) ────────────────────────────
  // expo-audio exposes dBFS on `recorder.getStatus().metering`. We poll
  // every 50ms while recording so the waveform stays responsive without
  // burning CPU.
  //
  // ADAPTIVE NOISE FLOOR (VAD-lite): instead of a fixed -35dB cutoff
  // (which fails when ambient noise is louder than the cutoff), we track
  // the room's noise floor with an EMA and only treat audio as "speech"
  // when it exceeds floor + 15dB. The floor adapts in real time so the
  // waveform stays still in silence but responds immediately when the
  // user speaks — matching the Doubao (豆包) visual behaviour without a
  // server round-trip. This is an energy-based heuristic, not a neural
  // VAD: transient noises (coughs, keyboard taps) can still trigger it.
  useEffect(() => {
    if (!isRecording) {
      if (meteringTimerRef.current) {
        clearInterval(meteringTimerRef.current);
        meteringTimerRef.current = null;
      }
      setAmplitude(0);
      return;
    }
    // Reset noise floor at the start of each recording so it
    // re-calibrates to the current environment.
    noiseFloorRef.current = INITIAL_NOISE_FLOOR_DB;
    let meteringDiagCount = 0;
    meteringTimerRef.current = setInterval(async () => {
      const rec = recordingRef.current?.recorder;
      if (!rec) return;
      try {
        const status = await rec.getStatus();
        // [VoiceDiag] log first 3 ticks so we see the raw status shape
        // (does metering exist? is isRecording true on native side?).
        meteringDiagCount += 1;
        if (meteringDiagCount <= 3) {
          logger.debug(
            'VoiceDiag',
            `[${new Date().toISOString().slice(11, 23)}] metering tick #${meteringDiagCount}`,
            { isRecording: status?.isRecording, metering: status?.metering, canRecord: status?.canRecord, statusKeys: status ? Object.keys(status) : null },
          );
        }
        if (typeof status.metering !== 'number') return;
        const db = status.metering;
        const threshold = noiseFloorRef.current + VAD_MARGIN_DB;
        if (db < threshold) {
          // Silence — update the noise floor estimate so it tracks the
          // real ambient level. Only update when NOT speaking, otherwise
          // we'd average speech energy into the floor and raise it.
          noiseFloorRef.current =
            noiseFloorRef.current * VAD_ADAPTATION_RATE + db * (1 - VAD_ADAPTATION_RATE);
          setAmplitude(0);
        } else {
          // Speech detected — drive the waveform with the raw loudness.
          setAmplitude(dbToAmplitude(db));
        }
      } catch {
        // Polling errors are non-fatal — keep the previous amplitude.
      }
    }, 50);
    return () => {
      if (meteringTimerRef.current) {
        clearInterval(meteringTimerRef.current);
        meteringTimerRef.current = null;
      }
    };
  }, [isRecording]);

  // ─── Preview chips ────────────────────────────────────────

  // The horizontal ScrollView that hosts attachment preview chips uses
  // iOS's native pan recognizer to drive horizontal scrolling. That
  // recognizer competes with the RNGH LongPress/Pan gesture attached to
  // the voice button — when the user starts a hold inside the voice
  // button, the ScrollView's pan recognizer claims the touch sequence
  // first and the LongPress timer is cancelled mid-hold (onEnd reports
  // success=false). The fix is to keep the ScrollView's pan recognizer
  // out of the way whenever the user is in voice input mode — there is
  // no useful chip scrolling during voice recording anyway.
  // All image attachments — tapping an image chip opens the fullscreen
  // viewer over the WHOLE image set (tapped one first), not just that image.
  const imageAttachments = attachments.filter((a) => a.type === 'image');

  const previewChips = hasAttachments ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      scrollEnabled={!isVoiceMode}
      className="flex-row pb-1 pt-1"
      contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingRight: 12 }}
    >
      {attachments.map((att) =>
        att.type === 'image' ? (
          // Square tile, contain-fit (like Doubao): whole image visible,
          // rounded square, X badge at the top-right corner.
          <View key={att.id} style={{ position: 'relative' }}>
            <Pressable
              onPress={() =>
                setPreview({
                  uris: imageAttachments.map((a) => a.uri),
                  index: imageAttachments.indexOf(att),
                })
              }
              style={{
                width: 64,
                height: 64,
                borderRadius: 12,
                backgroundColor: '#ECECEF',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              <Image
                source={{ uri: att.uri }}
                style={{ width: 64, height: 64 }}
                resizeMode="contain"
              />
            </Pressable>
            <Pressable
              onPress={() => removeAttachment(att.id)}
              hitSlop={6}
              style={{
                position: 'absolute',
                top: 4,
                right: 4,
                width: 20,
                height: 20,
                borderRadius: 10,
                backgroundColor: 'rgba(60,60,67,0.75)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="close" size={12} color="#fff" />
            </Pressable>
          </View>
        ) : (
          <View
            key={att.id}
            className="flex-row items-center bg-aura-surface-container rounded-lg px-2 py-1 gap-1.5"
            style={{ maxWidth: 160 }}
          >
            <Ionicons
              name={getFileIconName(att.mediaType) as any}
              size={16}
              className="text-aura-on-surface-variant"
            />
            <Text className="text-label-xs text-aura-on-surface" numberOfLines={1} style={{ flexShrink: 1 }}>
              {att.name}
            </Text>
            <Pressable onPress={() => removeAttachment(att.id)} hitSlop={8} style={{ flexShrink: 0 }}>
              <Ionicons name="close-circle" size={16} className="text-aura-outline" />
            </Pressable>
          </View>
        ),
      )}
    </ScrollView>
  ) : null;

  // Wire short-press → focus TextInput, but only in text mode when the
  // long-press-to-record overlay is actually shown (no text + not focused).
  // Voice mode leaves this null so short taps stay a no-op.
  shortPressHandlerRef.current =
    !isVoiceMode && !hasText && !isTextInputFocused
      ? () => textInputRef.current?.focus()
      : null;

  const inputContent = (
    <View
      className="flex-col w-full"
      style={isRecording ? { opacity: 0 } : undefined}
      pointerEvents={isRecording ? 'none' : 'auto'}
    >
      {/* Preview chips (shown for both modes when attachments exist) */}
      {previewChips}

      {isVoiceMode ? (
        /* Voice Mode — also shows send button when attachments exist */
        <View className="flex-row items-center px-4 py-2 gap-2">
          <Pressable
            onPress={handleTakePhoto}
            style={{ minWidth: 32, minHeight: 32, justifyContent: 'center', alignItems: 'center' }}
          >
            <Ionicons name="camera-outline" size={22} className="text-aura-on-surface-variant" />
          </Pressable>
          <View
            className="flex-1 items-center justify-center py-1"
            style={{ minHeight: INPUT_MIN_HEIGHT }}
            {...voicePanResponder.panHandlers}
          >
            <Text
              className="text-label-md font-bold text-aura-on-surface-variant select-none"
              numberOfLines={2}
            >
              {isRecording
                ? t('chatInput.listening')
                : hasText
                  ? inputText
                  : t('chatInput.holdToSpeak')}
            </Text>
          </View>
          <View className="flex-row items-center gap-2">
            <Pressable
              onPress={toggleMode}
              style={{ minWidth: 32, minHeight: 32, justifyContent: 'center', alignItems: 'center' }}
            >
              <MaterialIcons name="keyboard" size={22} className="text-aura-on-surface-variant" />
            </Pressable>
            {(hasText || hasAttachments) ? (
              <Pressable
                onPress={handleSend}
                disabled={(!hasText && !hasAttachments) || !!isCreating || isUploading || !!isSendingDisabled}
                className="rounded-full items-center justify-center"
                style={{
                  width: 29,
                  height: 29,
                  backgroundColor: '#1D4ED8',
                  opacity: (hasText || hasAttachments) && !isCreating && !isUploading && !isSendingDisabled ? 1 : 0.4,
                }}
              >
                {isUploading ? (
                  <ActivityIndicator size={14} color="white" />
                ) : (
                  <Ionicons name="arrow-up" size={18} color="white" />
                )}
              </Pressable>
            ) : (
              <Pressable
                onPress={toggleActions}
                style={{ minWidth: 32, minHeight: 32, justifyContent: 'center', alignItems: 'center' }}
              >
                <Ionicons
                  name={isActionsOpen ? 'close' : 'add'}
                  size={22}
                  className={isActionsOpen ? 'text-aura-primary' : 'text-aura-on-surface-variant'}
                />
              </Pressable>
            )}
          </View>
        </View>
      ) : (
        /* Text Mode */
        <View>
          <View className="flex-row items-center px-4 py-2 gap-2">
            {!hasText && (
              <Pressable
                onPress={handleTakePhoto}
                style={{ minWidth: 32, minHeight: 32, justifyContent: 'center', alignItems: 'center' }}
              >
                <Ionicons name="camera-outline" size={22} className="text-aura-on-surface-variant" />
              </Pressable>
            )}
            {/* Wrapper provides DOM ref for imperative auto-grow on web.
                On native, this is just a transparent flex container. */}
            <View
              ref={webInputWrapRef}
              className="flex-1"
            >
              <TextInput
                ref={textInputRef}
                className="w-full text-label-md text-aura-on-surface"
                placeholder={isTextInputFocused ? t('chatInput.messagePlaceholder') : t('chatInput.messagePlaceholderHold')}
                placeholderTextColor={c.outline}
                value={inputText}
                onChangeText={setInputText}
                onFocus={() => setIsTextInputFocused(true)}
                onBlur={() => setIsTextInputFocused(false)}
                multiline
                editable={!isCreating && !isUploading && !isSendingDisabled}
                style={{
                  minHeight: INPUT_MIN_HEIGHT,
                  maxHeight: INPUT_MAX_HEIGHT,
                  // iOS: omit lineHeight — forcing it shifts the placeholder
                  // baseline and breaks vertical centering in the row.
                ...(Platform.OS === 'web' && {
                  lineHeight: 22,
                  // Explicit CSS properties (not RN shorthand paddingVertical,
                  // which RNW may not expand in inline styles).
                  // (minHeight 32 - lineHeight 22) / 2 = 5px symmetric padding
                  // → text vertically centered in single-line mode.
                  paddingTop: 5,
                  paddingBottom: 5,
                  // border-box so minHeight includes padding (content area = 22px = 1 line).
                  boxSizing: 'border-box' as any,
                  // Imperative auto-grow (via useLayoutEffect) sets height on the
                  // DOM directly. Don't set height here — it would conflict.
                  borderWidth: 0,
                  outlineWidth: 0,
                  resize: 'none' as any,
                  overflowY: 'auto' as any,
                }),
                  // Android: use symmetric padding instead of textAlignVertical.
                  // 'top' pushes single-line text up; 'center' breaks multi-line
                  // growth. Padding keeps single-line centered and lets content
                  // grow downward naturally.
                  ...(Platform.OS === 'android' && { paddingVertical: 8 }),
                }}
              />
              {/* Long-press-to-record overlay — shown only in text mode when
                  there's no text and the keyboard is dismissed. Transparent;
                  the TextInput's own placeholder ("Type or hold to speak...")
                  shows through. Long-press (>100ms) → start recording (reuses
                  voicePanResponder); short tap → focus TextInput to type. */}
              {!hasText && !isTextInputFocused && (
                <View
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                  {...voicePanResponder.panHandlers}
                />
              )}
            </View>
            <View className="flex-row items-center gap-2">
              {!hasText && !hasAttachments && (
                <Pressable
                  onPress={toggleMode}
                  style={{ minWidth: 32, minHeight: 32, justifyContent: 'center', alignItems: 'center' }}
                >
                  <MaterialIcons name="settings-voice" size={22} className="text-aura-on-surface-variant" />
                </Pressable>
              )}
              <Pressable
                onPress={toggleActions}
                style={{ minWidth: 32, minHeight: 32, justifyContent: 'center', alignItems: 'center' }}
              >
                <Ionicons
                  name={isActionsOpen ? 'close' : 'add'}
                  size={22}
                  className={isActionsOpen ? 'text-aura-primary' : 'text-aura-on-surface-variant'}
                />
              </Pressable>
              {(hasText || hasAttachments) && (
                <Pressable
                  onPress={handleSend}
                  disabled={(!hasText && !hasAttachments) || !!isCreating || isUploading}
                  className="rounded-full items-center justify-center"
                  style={{
                    width: 29,
                    height: 29,
                    backgroundColor: '#1D4ED8',
                    opacity: (hasText || hasAttachments) && !isCreating && !isUploading ? 1 : 0.4,
                  }}
                >
                  {isUploading ? (
                    <ActivityIndicator size={14} color="white" />
                  ) : (
                    <Ionicons name="arrow-up" size={18} color="white" />
                  )}
                </Pressable>
              )}
            </View>
          </View>
        </View>
      )}
    </View>
  );

  return (
    <View
      className="px-4 py-1.5 border-t border-aura-outline-variant bg-aura-surface/85"
      style={isRecording ? { opacity: 0 } : undefined}
      pointerEvents={isRecording ? 'box-none' : 'auto'}
    >
      <View className="w-full relative" style={{ maxWidth: 600, alignSelf: 'center' }}>
        {/* Input pill with gradient border */}
        <LinearGradient
          colors={['#2563EB', '#1D4ED8']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ borderRadius: INPUT_PILL_RADIUS, padding: 1 }}
        >
          <View
            className="bg-aura-surface-container"
            style={{ borderRadius: INPUT_PILL_RADIUS - 1, overflow: 'hidden' }}
          >
            {inputContent}
          </View>
        </LinearGradient>

        {/* Actions grid — below input pill (九宫格 layout) */}
        {isActionsOpen && (
          <>
            {/* Full-screen transparent backdrop — tap anywhere to close */}
            <Pressable
              style={{ position: 'absolute', top: -9999, bottom: -9999, left: -9999, right: -9999, zIndex: 40 }}
              onPress={() => setIsActionsOpen(false)}
            />
            <View className="flex-row justify-around items-start pt-3 pb-1 relative z-50">
              {/* Images */}
              <Pressable
                className="items-center gap-1.5 active:opacity-70"
                style={{ flex: 1 }}
                onPress={handlePickImage}
              >
                <View className="w-14 h-14 rounded-full bg-aura-surface-container-high items-center justify-center">
                  <Ionicons name="image-outline" size={32} color="#1D4ED8" />
                </View>
                <Text className="text-sm text-aura-on-surface-variant">{t('chatInput.images')}</Text>
              </Pressable>
              {/* Camera */}
              <Pressable
                className="items-center gap-1.5 active:opacity-70"
                style={{ flex: 1 }}
                onPress={handleTakePhoto}
              >
                <View className="w-14 h-14 rounded-full bg-aura-surface-container-high items-center justify-center">
                  <Ionicons name="camera-outline" size={32} color="#1D4ED8" />
                </View>
                <Text className="text-sm text-aura-on-surface-variant">{t('chatInput.camera')}</Text>
              </Pressable>
              {/* Files */}
              <Pressable
                className="items-center gap-1.5 active:opacity-70"
                style={{ flex: 1 }}
                onPress={handlePickDocument}
              >
                <View className="w-14 h-14 rounded-full bg-aura-surface-container-high items-center justify-center">
                  <Ionicons name="document-text-outline" size={32} color="#1D4ED8" />
                </View>
                <Text className="text-sm text-aura-on-surface-variant">{t('chatInput.files')}</Text>
              </Pressable>
              {/* Voice Call */}
              <Pressable
                className="items-center gap-1.5 active:opacity-70"
                style={{ flex: 1 }}
                onPress={handleVoiceCall}
              >
                <View className="w-14 h-14 rounded-full bg-aura-surface-container-high items-center justify-center">
                  <Ionicons name="call-outline" size={32} color="#1D4ED8" />
                </View>
                <Text className="text-sm text-aura-on-surface-variant">{t('chatInput.voiceCall')}</Text>
              </Pressable>
            </View>
          </>
        )}

        {/* Voice Recording Overlay */}
        <VoiceOverlay
          visible={isRecording}
          onClose={stopRecording}
          isSlideCancel={isSlideCancel}
          touchX={touchX}
          touchY={touchY}
          amplitude={amplitude}
        />

        {/* Image Preview Overlay */}
        <ImagePreviewOverlay uris={preview?.uris ?? []} initialIndex={preview?.index ?? 0} onClose={() => setPreview(null)} />
      </View>
    </View>
  );
}
