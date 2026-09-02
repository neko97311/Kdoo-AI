import { useEffect, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useI18n } from '@/hooks/useI18n';
import { useShareIntoUiStore } from '@/stores/share-into-ui';
import { sendShareModalText } from '@/utils/share-intake-send';

/**
 * Bottom sheet shown when text/URL is shared into the app. Pre-filled with
 * the shared content; the user edits then taps Share to send it to the chat.
 */
export function ShareIntoModal() {
  const modalText = useShareIntoUiStore((s) => s.modalText);
  const closeShareModal = useShareIntoUiStore((s) => s.closeShareModal);
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const visible = modalText !== null;

  useEffect(() => {
    if (modalText !== null) {
      setText(modalText);
      setSending(false);
    }
  }, [modalText]);

  const canSend = text.trim().length > 0 && !sending;

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await sendShareModalText(text);
      closeShareModal();
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={closeShareModal}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}>
          <Pressable style={{ flex: 1 }} onPress={closeShareModal} />
          <View
            style={{
              backgroundColor: '#F7F7F9',
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              paddingHorizontal: 20,
              paddingTop: 12,
              paddingBottom: 24,
            }}
          >
            <View style={{ marginBottom: 12 }}>
              <View style={{ alignItems: 'center' }}>
                <Image
                  source={require('@/assets/images/icon.png')}
                  style={{ width: 40, height: 40, borderRadius: 20 }}
                />
              </View>
              <Pressable
                onPress={closeShareModal}
                hitSlop={12}
                style={{ position: 'absolute', right: 0, top: 8 }}
              >
                <Text style={{ color: '#666', fontSize: 16 }}>{t('share.cancel')}</Text>
              </Pressable>
            </View>

            <TextInput
              value={text}
              onChangeText={setText}
              multiline
              autoFocus
              textAlignVertical="top"
              style={{
                backgroundColor: '#ECECEF',
                borderRadius: 12,
                minHeight: 320,
                padding: 14,
                fontSize: 16,
                color: '#111',
                marginBottom: 16,
              }}
            />

            <Pressable
              onPress={handleSend}
              disabled={!canSend}
              style={{
                backgroundColor: canSend ? '#1D4ED8' : '#9DB8EE',
                borderRadius: 24,
                paddingVertical: 14,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: '#fff', fontSize: 17, fontWeight: '600' }}>
                {t('share.send')}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
