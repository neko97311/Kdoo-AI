import { useRef, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isWeb } from '@/utils/platform';
import { KeyboardAvoidingView } from '@/components/KeyboardAvoidingView';
import { useKeyboard } from '@/hooks/useKeyboard';
import { Ionicons } from '@expo/vector-icons';
import { ChatHeader } from './ChatHeader';
import { ChatInputBar } from './ChatInputBar';
import { MessageListSkeleton } from './MessageListSkeleton';
import { useI18n } from '@/hooks/useI18n';
import { useChatStore } from '@/stores/chat';
import { useAuthStore } from '@/stores/auth';
import { useNewsRecommendations } from '@/hooks/useNewsRecommendations';

import type { WsContentBlock } from '@/types';

interface ChatHomeProps {
  onMenuPress: () => void;
  onActionPress: (label: string) => void;
  onSend: (text: string, blocks?: WsContentBlock[]) => void;
  isCreating?: boolean;
}

export function ChatHome({ onMenuPress, onActionPress, onSend, isCreating }: ChatHomeProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const pendingUserMessage = useChatStore((s) => s.pendingUserMessage);
  const isAutoPlay = useAuthStore((s) => s.user?.chatSetting.autoPlay ?? false);
  const toggleAutoPlay = useChatStore((s) => s.toggleAutoPlay);
  const showLoading = !!isCreating || pendingUserMessage;
  const scrollViewRef = useRef<ScrollView>(null);
  const { isKeyboardVisible } = useKeyboard();
  const { recommendations, handleNewsClick, getNewsTitleForLocale } = useNewsRecommendations();

  useEffect(() => {
    if (isKeyboardVisible) {
      const timer = setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isKeyboardVisible]);

  return (
    <View className="flex-1 bg-aura-surface">
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        keyboardVerticalOffset={insets.top}
      >
        <ChatHeader
          onMenuPress={onMenuPress}
          rightIcon="play"
          isAutoPlay={isAutoPlay}
          onToggleAutoPlay={toggleAutoPlay}
        />

        {showLoading ? (
          <MessageListSkeleton />
        ) : (
        <ScrollView
          ref={scrollViewRef}
          className="flex-1 px-4 pt-2"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            paddingBottom: 10,
            ...(isWeb
              ? { maxWidth: 600, alignSelf: 'center', width: '100%' }
              : {}),
          }}
        >
          <View>
            {/* Greeting */}
            <View className="mb-4">
              <Text className="text-headline-lg text-aura-on-surface">{t('chatHome.greeting')}</Text>
              <Text className="text-headline-lg text-aura-primary-container">{t('chatHome.howCanIHelp')}</Text>
            </View>

            {/* Action Cards — 今日新闻推荐，无数据则不渲染 */}
            {recommendations.length > 0 && (
              <View className="gap-3">
                {recommendations.map((item) => {
                  const label = getNewsTitleForLocale(item);
                  return (
                    <Pressable
                      key={item.id}
                      className="bg-aura-surface-container border border-[#0000000F] rounded-card px-4 py-2.5 flex-row items-center gap-3 active:opacity-80"
                      onPress={() => {
                        handleNewsClick(item);
                        onActionPress(label);
                      }}
                      disabled={showLoading}
                      style={showLoading ? { opacity: 0.5 } : undefined}
                    >
                      <View className="w-10 h-10 rounded-full bg-aura-primary/10 items-center justify-center">
                        <Ionicons name="newspaper-outline" size={20} color="#1D4ED8" />
                      </View>
                      <Text className="text-body-md text-aura-on-surface flex-1">{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>
        )}

        <View
          style={{
            paddingBottom: isKeyboardVisible
              ? Platform.select({
                  android: Math.max(insets.bottom, 15),
                  default: 0,
                })
              : Platform.select({
                  ios: Math.max(insets.bottom, 30),
                  android: Math.max(insets.bottom, 30),
                  default: Math.max(insets.bottom, 30),
                }),
          }}
        >
          <ChatInputBar onSend={onSend} isCreating={showLoading} />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
