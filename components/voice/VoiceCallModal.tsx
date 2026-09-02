/**
 * Voice call modal — full-screen RN Modal hosting the AI voice conversation UI.
 *
 * Why RN Modal instead of an Expo Router screen?
 *   The voice-call page needs to paint its own gradient background over the
 *   status bar / Dynamic Island region. An Expo Router screen lives inside the
 *   root SafeAreaView's padding box, whose background is the parent (white),
 *   so the gradient cannot reach the top safe area. RN Modal is a native
 *   overlay (UIViewController on iOS, Dialog on Android) that sits above the
 *   entire app and can fill the whole screen.
 *
 * Mounted once at the root layout (`app/_layout.tsx`); visibility is driven
 * by `useVoiceStore.isModalOpen`.
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ViewStyle, Modal, StatusBar, Platform, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { setupIOSAudioManagement } from '@livekit/react-native';
import { useI18n } from '@/hooks/useI18n';
import { useCallColors } from '@/hooks/useColors';
import { useVoiceStore } from '@/stores/voice';
import { RealTimeWaveform } from '@/components/chat/RealTimeWaveform';
import { VoiceTranscriptList } from '@/components/voice/VoiceTranscriptList';

const BTN_SIZE = 60;
const AVATAR_SIZE = 200;

export function VoiceCallModal() {
  const { t } = useI18n();
  const cc = useCallColors();
  const insets = useSafeAreaInsets();

  const {
    isModalOpen,
    connectionState,
    hasConnectedOnce,
    isMicEnabled,
    isScreenShareEnabled,
    isCameraEnabled,
    agentIdentity,
    agentState,
    isUserSpeaking,
    amplitude,
    error,
    viewMode,
    connect,
    closeVoiceCall,
    toggleMic,
    toggleScreenShare,
    toggleCamera,
    setViewMode,
  } = useVoiceStore();

  const hasConnectedRef = useRef(false);
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const networkErrorFlashRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [networkErrorFlash, setNetworkErrorFlash] = useState(false);

  // Connect on mount; teardown on unmount via closeVoiceCall.
  useEffect(() => {
    if (!isModalOpen) return;

    let cleanup: (() => void) | undefined;
    if (Platform.OS === 'ios') {
      cleanup = setupIOSAudioManagement(true);
    }

    if (!hasConnectedRef.current) {
      hasConnectedRef.current = true;
      connect().catch((err) => {
        console.warn('[voice-call] connect failed:', err);
      });
    }

    return () => {
      hasConnectedRef.current = false;
      cleanup?.();
    };
  }, [isModalOpen, connect]);

  // After a mid-call drop, LiveKit goes Reconnecting → Disconnected.
  // Auto-close after a 2s grace so the user sees the error briefly.
  useEffect(() => {
    if (!isModalOpen) return;
    const ended = hasConnectedOnce && connectionState === 'disconnected';
    if (!ended) {
      if (autoCloseTimerRef.current) {
        clearTimeout(autoCloseTimerRef.current);
        autoCloseTimerRef.current = null;
      }
      return;
    }
    if (autoCloseTimerRef.current) return;
    console.log('[voice-call] connection dropped — auto-close in 2s');
    autoCloseTimerRef.current = setTimeout(() => {
      autoCloseTimerRef.current = null;
      console.log('[voice-call] auto-close firing closeVoiceCall');
      closeVoiceCall();
    }, 2000);
    return () => {
      if (autoCloseTimerRef.current) {
        clearTimeout(autoCloseTimerRef.current);
        autoCloseTimerRef.current = null;
      }
    };
  }, [isModalOpen, hasConnectedOnce, connectionState, closeVoiceCall]);

  // Brief red "poor network" flash (3s) on connection issues, then revert
  // to the steady "Connecting..." spinner so the user sees continuous
  // progress feedback instead of getting stuck on an error message.
  useEffect(() => {
    if (!isModalOpen) return;
    const shouldFlash =
      connectionState === 'reconnecting' ||
      (hasConnectedOnce && connectionState === 'disconnected') ||
      (!!error && connectionState !== 'connected');
    if (!shouldFlash) {
      if (networkErrorFlashRef.current) {
        clearTimeout(networkErrorFlashRef.current);
        networkErrorFlashRef.current = null;
      }
      setNetworkErrorFlash(false);
      return;
    }
    if (networkErrorFlash) return;
    setNetworkErrorFlash(true);
    if (networkErrorFlashRef.current) clearTimeout(networkErrorFlashRef.current);
    networkErrorFlashRef.current = setTimeout(() => {
      networkErrorFlashRef.current = null;
      setNetworkErrorFlash(false);
    }, 3000);
    return () => {
      if (networkErrorFlashRef.current) {
        clearTimeout(networkErrorFlashRef.current);
        networkErrorFlashRef.current = null;
      }
    };
  }, [isModalOpen, connectionState, hasConnectedOnce, error, networkErrorFlash]);

  // User-visible state: only two real states — "connecting" (with spinner)
  // and "connected". Anything else (reconnecting / disconnected / error)
  // shows the spinner; if the network flash is active, briefly show red.
  // Deliberately NOT gated on `agentIdentity`: that flag only updates via
  // ParticipantConnected, which can be missed when the Agent joins before the
  // client — causing an already-working call to appear stuck "connecting".
  const isConnecting = connectionState !== 'connected';
  const isConnected = !isConnecting;

  const statusTextColor =
    networkErrorFlash && isConnecting ? cc.errorText : cc.statusText;

  const getStatusText = () => {
    if (networkErrorFlash && isConnecting) {
      return t('voiceCall.noNetwork');
    }
    if (isConnecting) return t('voiceCall.connecting');
    switch (agentState) {
      case 'listening':
        return t('voiceCall.listening');
      case 'thinking':
        return t('voiceCall.thinking');
      case 'speaking':
        return t('voiceCall.speaking');
      default:
        return t('voiceCall.connecting');
    }
  };

  const showSpinner = isConnecting;
  const showPulsingDots = isConnected && !isUserSpeaking;

  // 波形图：用户在说话时显示（来源 LiveKit server ActiveSpeakersChanged）。
  // 不说话时隐藏，避免冻在最后状态。amplitude 仍驱动波形起伏视觉效果。
  // 三点和波形图互斥：说话时显示波形图，不说话时显示三个点呼吸动画。
  const showWaveform = isConnected && isUserSpeaking;

  return (
    <Modal
      visible={isModalOpen}
      animationType="slide"
      presentationStyle="overFullScreen"
      transparent={false}
      statusBarTranslucent
      onRequestClose={closeVoiceCall}
    >
      <StatusBar barStyle="default" />
      {/* No SafeAreaView here — RN Modal already covers the full screen including
          the status bar / Dynamic Island. The gradient is painted from edge to
          edge. Bottom padding is applied manually via insets.bottom to keep
          controls clear of the home indicator. */}
      <View style={{ flex: 1, backgroundColor: cc.gradientFrom }}>
        <LinearGradient
          colors={[cc.gradientFrom, cc.gradientTo]}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        />

        {/* Top bar */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 20,
            paddingTop: insets.top + 10,
          }}
        >
          {/* Left: reserved for future (e.g. settings), currently hidden */}
          <View style={{ width: 40 }} />

          {/* Center: reserved for scene picker, currently hidden */}
          <View style={{ flex: 1 }} />

          {/* Right: transcript/avatar view toggle */}
          <View style={{ width: 40, alignItems: 'center' }}>
            <Pressable
              onPress={() => setViewMode(viewMode === 'avatar' ? 'text' : 'avatar')}
              hitSlop={8}
            >
              <Ionicons
                name={viewMode === 'avatar' ? 'document-text-outline' : 'person-outline'}
                size={22}
                color={cc.statusText}
              />
            </Pressable>
          </View>
        </View>

        {/* Avatar / transcript section */}
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          {viewMode === 'avatar' ? (
            <View
              style={{
                width: AVATAR_SIZE,
                height: AVATAR_SIZE,
                borderRadius: AVATAR_SIZE / 2,
                backgroundColor: cc.avatarBg,
                borderWidth: 5,
                borderColor: cc.avatarBorder,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Ionicons name="person" size={120} color={cc.avatarIcon} />
            </View>
          ) : (
            <VoiceTranscriptList />
          )}
        </View>

        {/* Status section: three dots / waveform + status text — fixed-height
            slots so nothing jumps when state changes. Sits just above the
            bottom mic controls. */}
        <View style={{ alignItems: 'center', paddingHorizontal: 20 }}>
          {/* Three dots / waveform / spinner row: same height slot, mutually exclusive */}
          <View style={{ height: 40, justifyContent: 'center', alignItems: 'center' }}>
            {showSpinner ? (
              <ActivityIndicator size="small" color={statusTextColor} />
            ) : showWaveform ? (
              <View style={{ width: 110 }}>
                <RealTimeWaveform
                  amplitude={amplitude}
                  isSlideCancel={false}
                  colorOverride={statusTextColor}
                  barCount={10}
                />
              </View>
            ) : showPulsingDots ? (
              <Text style={{ fontSize: 18, color: statusTextColor, letterSpacing: 2 }}>
                {'\u25CF \u25CF \u25CF'}
              </Text>
            ) : null}
          </View>

          {/* Status text */}
          <Text
            style={{
              fontSize: 16,
              color: statusTextColor,
              textAlign: 'center',
              marginBottom: 24,
              ...(networkErrorFlash && isConnecting ? { fontWeight: '500' } : {}),
            }}
          >
            {getStatusText()}
          </Text>
        </View>

        {/* Bottom controls: mic · screen share · camera · hangup */}
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 20,
            paddingBottom: insets.bottom + 50,
          }}
        >
          <RoundButton
            onPress={toggleMic}
            backgroundColor={cc.buttonBg}
            accessibilityLabel={t('voiceCall.micToggle')}
          >
            <Ionicons
              name={isMicEnabled ? 'mic' : 'mic-off'}
              size={28}
              color={cc.buttonIcon}
            />
          </RoundButton>

          <RoundButton
            onPress={toggleScreenShare}
            backgroundColor={isScreenShareEnabled ? cc.hangupBg : cc.buttonBg}
            disabled={!isConnected}
            accessibilityLabel={t('voiceCall.screenShare')}
          >
            <Ionicons
              name={isScreenShareEnabled ? 'desktop' : 'desktop-outline'}
              size={26}
              color={isScreenShareEnabled ? cc.hangupIcon : cc.buttonIcon}
            />
          </RoundButton>

          <RoundButton
            onPress={toggleCamera}
            backgroundColor={cc.buttonBg}
            disabled={!isConnected}
            accessibilityLabel={t('voiceCall.camera')}
          >
            <Ionicons
              name={isCameraEnabled ? 'videocam' : 'videocam-off'}
              size={26}
              color={cc.buttonIcon}
            />
          </RoundButton>

          <RoundButton
            onPress={closeVoiceCall}
            backgroundColor={cc.hangupBg}
            accessibilityLabel={t('voiceCall.hangup')}
          >
            <Ionicons name="close" size={28} color={cc.hangupIcon} />
          </RoundButton>
        </View>

        {/* Footer */}
        <View style={{ paddingBottom: insets.bottom + 15, alignItems: 'center' }}>
          <Text style={{ fontSize: 12, color: cc.footerText }}>
            {t('voiceCall.contentByAI')}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

// ─── Round Button Component ───────────────────────────────────

interface RoundButtonProps {
  onPress: () => void;
  backgroundColor: string;
  children: React.ReactNode;
  style?: ViewStyle;
  disabled?: boolean;
  accessibilityLabel?: string;
}

function RoundButton({
  onPress,
  backgroundColor,
  children,
  style,
  disabled,
  accessibilityLabel,
}: RoundButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={{
        width: BTN_SIZE,
        height: BTN_SIZE,
        borderRadius: BTN_SIZE / 2,
        backgroundColor,
        justifyContent: 'center',
        alignItems: 'center',
        opacity: disabled ? 0.45 : 1,
        ...style,
      }}
    >
      {children}
    </Pressable>
  );
}
