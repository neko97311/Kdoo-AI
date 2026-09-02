import { useState, useRef, useEffect } from 'react';
import { Pressable, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { useI18n } from '@/hooks/useI18n';
import { useToastStore } from '@/stores/toast';

export interface VoicePreviewButtonProps {
  previewUrl: string;
  disabled?: boolean;
}

type PreviewState = 'idle' | 'loading' | 'playing';

/**
 * v1.0: 试听改为本地 Audio 直连播放（OSS / 静态托管 mp3/wav），
 * 不再走后端 WS TTS 合成。同一时刻只允许一个音频播放（模块级 mutex）。
 */
let currentOwner: { stop: () => void; resetState: () => void } | null = null;

export function stopCurrentPreview() {
  const owner = currentOwner;
  currentOwner = null;
  if (!owner) return;
  try {
    owner.stop();
  } catch {
    /* ignore */
  }
  try {
    owner.resetState();
  } catch {
    /* ignore */
  }
}

export function VoicePreviewButton({ previewUrl, disabled }: VoicePreviewButtonProps) {
  const { t } = useI18n();
  const [state, setState] = useState<PreviewState>('idle');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setState('idle');
      if (currentOwner && currentOwner.resetState === resetStateRef.current) {
        stopCurrentPreview();
      }
    };
  }, []);

  const resetState = () => {
    if (mounted.current) setState('idle');
  };
  const resetStateRef = useRef(resetState);
  resetStateRef.current = resetState;

  const onPress = async () => {
    if (disabled) return;

    if (state === 'playing' || state === 'loading') {
      stopCurrentPreview();
      return;
    }

    stopCurrentPreview();

    console.log('[voice-preview] play attempt', { previewUrl });
    setState('loading');
    let player: AudioPlayer | null = null;
    let sub: { remove: () => void } | null = null;
    try {
      const { createAudioPlayer, setAudioModeAsync } = await import('expo-audio');
      await setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
      player = createAudioPlayer({ uri: previewUrl });
      player.volume = 1.0;
      console.log('[voice-preview] player created', { uri: previewUrl, volume: player.volume });

      const stop = () => {
        try {
          player?.pause();
        } catch {
          /* ignore */
        }
        try {
          sub?.remove();
        } catch {
          /* ignore */
        }
        try {
          player?.release();
        } catch {
          /* ignore */
        }
      };

      const handle = { stop, resetState };
      currentOwner = handle;

      sub = player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
        console.log('[voice-preview] status', {
          isLoaded: status.isLoaded,
          isPlaying: (status as any).playing ?? (status as any).isPlaying,
          playbackState: status.playbackState,
          didJustFinish: status.didJustFinish,
          duration: (status as any).duration,
          currentTime: (status as any).currentTime,
          error: (status as any).error,
        });
        if (!mounted.current) return;
        if (status.didJustFinish) {
          setState('idle');
          if (currentOwner === handle) currentOwner = null;
          try {
            sub?.remove();
            player?.release();
          } catch {
            /* ignore */
          }
          return;
        }
        if (status.error) {
          setState('idle');
          if (currentOwner === handle) currentOwner = null;
          useToastStore
            .getState()
            .showToast({ message: String((status as any).error), variant: 'warning' });
          try {
            sub?.remove();
            player?.release();
          } catch {
            /* ignore */
          }
          return;
        }
        const isPlayingNow = (status as any).playing ?? (status as any).isPlaying;
        if (isPlayingNow) {
          setState('playing');
        } else if (!status.isLoaded || status.playbackState === 'loading') {
          setState('loading');
        }
      });
      player.play();
    } catch (e: any) {
      console.warn('[voice-preview] FAILED', { message: e?.message, code: e?.code, error: String(e) });
      if (mounted.current) {
        useToastStore
          .getState()
          .showToast({ message: e?.message ?? t('voiceSettings.previewFailed'), variant: 'warning' });
        setState('idle');
      }
      try {
        player?.release();
      } catch {
        /* ignore */
      }
    }
  };

  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      disabled={disabled || state === 'loading'}
      className={`w-7 h-7 items-center justify-center rounded-full ${
        state === 'playing'
          ? 'bg-aura-primary/20'
          : state === 'loading'
            ? 'bg-aura-outline-variant/60'
            : 'bg-aura-outline-variant/40'
      }`}
    >
      {state === 'playing' ? (
        <Ionicons name="stop" size={14} color="#685891" />
      ) : state === 'loading' ? (
        <ActivityIndicator size="small" color="#685891" />
      ) : (
        <Ionicons name="musical-note" size={14} color="#685891" />
      )}
    </Pressable>
  );
}
