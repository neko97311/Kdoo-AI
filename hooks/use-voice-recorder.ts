// 录音 hook：克隆音色专用。
// 思路复制自 ChatInputBar（expo-audio 动态 import + 平台分支），
// 但不依赖 ChatInputBar 任何状态。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

export type RecorderStatus = 'idle' | 'recording' | 'finished' | 'error';

export interface UseVoiceRecorderResult {
  status: RecorderStatus;
  durationMs: number;
  uri: string | null;
  errorMessage: string | null;
  start: () => Promise<void>;
  stop: () => Promise<string | null>;
  reset: () => void;
  /**
   * Latest dBFS metering reading, or null if no recorder / no metering.
   * Used by VoiceCloneSheet's 50ms poll (mirrors ChatInputBar's metering
   * loop) to drive the VoiceOverlay waveform. Returns null on web where
   * no metering API exists.
   */
  getMetering: () => Promise<number | null>;
}

export function useVoiceRecorder(): UseVoiceRecorderResult {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [durationMs, setDurationMs] = useState(0);
  const [uri, setUri] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const recorderRef = useRef<any>(null);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 竞态处理：用户在 start() 的 async setup（import/权限/prepareToRecordAsync）
  // 期间点击 stop()，此时 recorder 尚未开始录音。
  // 设置 pendingStopRef，start() 在调 recorder.record() 前检查此 flag。
  // 模式复制自 ChatInputBar。
  const pendingStopRef = useRef(false);

  const stopTicker = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopTicker();
    pendingStopRef.current = false;
    recorderRef.current = null;
    startedAtRef.current = 0;
    setStatus('idle');
    setDurationMs(0);
    setUri(null);
    setErrorMessage(null);
  }, [stopTicker]);

  const start = useCallback(async () => {
    setErrorMessage(null);
    setUri(null);
    setDurationMs(0);
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
          setStatus('error');
          setErrorMessage('permission_denied');
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
        // Enables dBFS metering so the clone UI can read real-time volume via
        // getMetering() (mirrors ChatInputBar's isMeteringEnabled setting).
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
      // 竞态检查：stop() 在 prepareToRecordAsync 期间被调用
      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        try {
          await recorder.stop();
        } catch {
          /* noop */
        }
        setStatus('idle');
        return;
      }
      recorder.record();
      startedAtRef.current = Date.now();
      setStatus('recording');
      tickRef.current = setInterval(() => {
        setDurationMs(Date.now() - startedAtRef.current);
      }, 200);
    } catch (e: any) {
      setStatus('error');
      setErrorMessage(e?.message ?? String(e));
    }
  }, []);

  const stop = useCallback(async (): Promise<string | null> => {
    // 标记 stop 请求，处理 start() async setup 期间的竞态
    pendingStopRef.current = true;
    stopTicker();
    const recorder = recorderRef.current;
    if (!recorder) {
      setStatus('idle');
      return null;
    }
    try {
      await recorder.stop();
      const resultUri = recorder.uri ?? null;
      setUri(resultUri);
      setStatus('finished');
      return resultUri;
    } catch (e: any) {
      setStatus('error');
      setErrorMessage(e?.message ?? String(e));
      return null;
    }
  }, [stopTicker]);

  useEffect(() => {
    return () => stopTicker();
  }, [stopTicker]);

  const getMetering = useCallback(async (): Promise<number | null> => {
    const rec = recorderRef.current;
    if (!rec) return null;
    try {
      const status = await rec.getStatus();
      return typeof status.metering === 'number' ? status.metering : null;
    } catch {
      return null;
    }
  }, []);

  return { status, durationMs, uri, errorMessage, start, stop, reset, getMetering };
}
