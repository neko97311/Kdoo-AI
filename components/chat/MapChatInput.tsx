/**
 * MapChatInput — compact chat input shown at the bottom of the full-screen
 * map modals (Nearby Search / My Location / Navigation). Lets the user keep
 * chatting with the AI (e.g. "find cheaper restaurants") without closing the
 * map — like ChatGPT's map view. Styled to match the message-page input.
 *
 * Sending reuses the chat store's sendMessage (session-scoped), so the AI
 * responds in the conversation behind the map.
 *
 * @module components/chat/MapChatInput
 */
import { useState } from 'react';
import { View, TextInput, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useResolvedScheme } from '@/hooks/useColors';
import { useI18n } from '@/hooks/useI18n';
import { useChatStore } from '@/stores/chat';
import { requestChatScrollToBottom } from '@/utils/chat-scroll';

export function MapChatInput({ onSent }: { onSent?: () => void }) {
  const [text, setText] = useState('');
  const scheme = useResolvedScheme();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const isDark = scheme === 'dark';

  const canSend = text.trim().length > 0;

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const sid = useChatStore.getState().currentSessionId;
    if (sid) {
      // agentId defaults to 'default' inside the store.
      useChatStore.getState().sendMessage(sid, trimmed);
    }
    setText('');
    // Ask the chat list to scroll to the bottom so the sent message + the
    // AI reply come into view once the modal closes. Sending from here
    // bypasses ChatView.handleSend (which normally fires the scroll burst),
    // so we route through the chat-scroll bridge instead.
    requestChatScrollToBottom();
    // Return to the chat session so the user sees the sent message.
    onSent?.();
  };

  const barBg = isDark ? '#0f1117' : '#f8f9fa';
  const border = isDark ? '#2a2a3e' : '#e5e7eb';
  const fieldBg = isDark ? '#1a1a2e' : '#ffffff';
  const textColor = isDark ? '#e5e7eb' : '#1e293b';
  const placeholderColor = isDark ? '#9CA3AF' : '#6B7280';

  return (
    <View
      style={[
        styles.wrap,
        { backgroundColor: barBg, borderTopColor: border, paddingBottom: insets.bottom + 8 },
      ]}
    >
      <View style={[styles.inputRow, { backgroundColor: fieldBg, borderColor: border }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t('chatInput.messagePlaceholder')}
          placeholderTextColor={placeholderColor}
          style={[styles.input, { color: textColor }]}
          multiline
          returnKeyType="send"
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        <Pressable
          onPress={handleSend}
          disabled={!canSend}
          style={({ pressed }) => [
            styles.sendBtn,
            !canSend && { opacity: 0.4 },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Ionicons name="arrow-up" size={18} color="white" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingHorizontal: 12,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 14,
    paddingRight: 6,
    paddingTop: 6,
    paddingBottom: 6,
    gap: 8,
  },
  input: {
    flex: 1,
    maxHeight: 96,
    minHeight: 34,
    fontSize: 15,
    paddingVertical: 4,
  },
  sendBtn: {
    width: 29,
    height: 29,
    borderRadius: 15,
    backgroundColor: '#1D4ED8',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
