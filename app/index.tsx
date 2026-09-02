import { useState, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useChatStore, setupWebSocketHandlers } from '@/stores/chat';
import { useToastStore } from '@/stores/toast';
import { ChatHome } from '@/components/chat/ChatHome';
import { ChatView } from '@/components/chat/ChatView';
import { ChatDrawer } from '@/components/chat/ChatDrawer';
import { useI18n } from '@/hooks/useI18n';
import type { WsContentBlock } from '@/types';

export default function HomeScreen() {
  const { t } = useI18n();
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const isCreating = useChatStore((s) => s.isCreating);
  const isLoading = useChatStore((s) => s.isLoading);
  const error = useChatStore((s) => s.error);
  const loadAgents = useChatStore((s) => s.loadAgents);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const createSessionAsync = useChatStore((s) => s.createSessionAsync);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const connectWebSocket = useChatStore((s) => s.connectWebSocket);
  const clearError = useChatStore((s) => s.clearError);

  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const wsSetupDone = useRef(false);

  // Initialize: agents, WebSocket (sessions already loaded by _layout)
  useEffect(() => {
    loadAgents();
    connectWebSocket();
    if (!wsSetupDone.current) {
      setupWebSocketHandlers();
      wsSetupDone.current = true;
    }
  }, []);

  // Auto-load messages when switching to an existing session (not newly created)
  useEffect(() => {
    if (currentSessionId) {
      const sessionMessages = useChatStore.getState().messages[currentSessionId];
      const cursor = useChatStore.getState().messageCursors[currentSessionId];
      // Load from API when:
      // 1. No local state at all (undefined), OR
      // 2. hydrateFromSQLite filled messages but cursor is missing — need
      //    pagination info + server refresh so hasMoreMessages / pull-down
      //    load-more work correctly.
      // Skip when sessionMessages is [] (newly created session —
      // createSessionAsync inits an empty array and sendMessage follows
      // immediately; an API fetch here could return [] and overwrite the
      // just-added user message + streaming placeholder).
      if (sessionMessages === undefined || (sessionMessages.length > 0 && cursor === undefined)) {
        loadMessages(currentSessionId);
      }
    }
  }, [currentSessionId]);

  // Show error alerts
  useEffect(() => {
    if (error) {
      useToastStore.getState().showToast({ message: error, variant: 'warning' });
      clearError();
    }
  }, [error]);

  const handleHomeSend = async (text: string, blocks?: WsContentBlock[]) => {
    if (isCreating) return;
    const agentId = 'default';

    // Voice message: pendingAudioUri is set by ChatInputBar.stopRecording.
    // Transcribe FIRST — only create a session if there is recognized text
    // (or attachment blocks to send). Empty transcription → warning toast,
    // no session is created, no navigation happens.
    const state = useChatStore.getState();
    if (state.pendingAudioUri) {
      const audioUri = state.pendingAudioUri;
      state.setPendingAudioUri(null);
      state.setPendingUserMessage(true);
      setIsTranscribing(true);
      try {
        const { transcribeAudio } = await import('@/services/voice-service');
        const transcribedText = (await transcribeAudio(audioUri)).trim();
        const s = useChatStore.getState();
        s.setPendingUserMessage(false);
        if (transcribedText || (blocks && blocks.length > 0)) {
          // Combine transcribed text block with any attachment blocks
          const allBlocks: WsContentBlock[] = blocks ? [...blocks] : [];
          if (transcribedText) {
            allBlocks.unshift({ type: 'text', text: transcribedText });
          }
          const name = transcribedText || (blocks?.length ? 'Image' : 'Voice message');
          const sessionId = await createSessionAsync({ agentId, name });
          if (sessionId) {
            sendMessage(sessionId, transcribedText, allBlocks, agentId);
          }
        } else {
          // No text recognized and no attachments — warn the user, don't
          // create a session. Matches 豆包's "未识别到文字" feedback.
          useToastStore.getState().showToast({
            message: t('voiceOverlay.noTextRecognized'),
            variant: 'warning',
          });
        }
      } catch (err) {
        useChatStore.getState().setPendingUserMessage(false);
        console.warn('[Home] Voice transcription failed:', err);
      } finally {
        setIsTranscribing(false);
      }
      return;
    }

    const displayName = blocks?.length ? (text || 'Image') : text;
    const sessionId = await createSessionAsync({ agentId, name: displayName });
    if (sessionId) {
      sendMessage(sessionId, text, blocks, agentId);
    }
  };

  const handleActionPress = async (label: string) => {
    if (isCreating) return;
    const agentId = 'default';
    const sessionId = await createSessionAsync({ agentId, name: label });
    if (sessionId) {
      sendMessage(sessionId, label, undefined, agentId);
    }
  };

  return (
    <View className="flex-1 bg-white dark:bg-[#0f1117]">
      {currentSessionId ? (
        <ChatView
          onMenuPress={() => setIsDrawerOpen(true)}
        />
      ) : (
        <ChatHome
          onMenuPress={() => setIsDrawerOpen(true)}
          onActionPress={handleActionPress}
          onSend={handleHomeSend}
          isCreating={isCreating}
        />
      )}

      <ChatDrawer
        visible={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        isLoading={isLoading}
      />
    </View>
  );
}
