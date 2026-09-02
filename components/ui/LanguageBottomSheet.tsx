import { View, Text, Pressable, Modal, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '@/hooks/useI18n';
import { useSheetSlideAnimation } from '@/hooks/useSheetSlideAnimation';

interface LanguageBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  currentLanguage: string;
  onSelectLanguage: (lang: string) => void;
}

const LANGUAGES = [
  { key: 'zh', labelKey: 'profileSettings.langChinese' as const },
  { key: 'en', labelKey: 'profileSettings.langEnglish' as const },
  { key: 'pt', labelKey: 'profileSettings.langPortuguese' as const },
];

export function LanguageBottomSheet({
  visible,
  onClose,
  currentLanguage,
  onSelectLanguage,
}: LanguageBottomSheetProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const translateY = useSheetSlideAnimation(visible);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.4)' }}
        onPress={onClose}
      />
      <Animated.View
        className="absolute bottom-0 left-0 right-0"
        style={{ paddingBottom: insets.bottom, transform: [{ translateY }] }}
      >
        <View className="bg-aura-surface-container rounded-t-2xl px-6 pt-6 pb-8">
          <View className="w-10 h-1 rounded-full bg-aura-outline-variant mx-auto mb-6" />
          <Text className="text-xl font-semibold text-aura-on-surface mb-4">
            {t('profileSettings.languageSettings')}
          </Text>
          {LANGUAGES.map((lang) => (
            <Pressable
              key={lang.key}
              className="flex-row items-center gap-4 p-4 rounded-xl"
              onPress={() => {
                onSelectLanguage(lang.key);
                onClose();
              }}
            >
              <Ionicons name="language" size={20} className="text-aura-on-surface" />
              <Text className="text-sm font-medium text-aura-on-surface flex-1">
                {t(lang.labelKey)}
              </Text>
              {currentLanguage === lang.key && (
                <Ionicons name="checkmark-circle" size={20} color="#4caf50" />
              )}
            </Pressable>
          ))}
        </View>
      </Animated.View>
    </Modal>
  );
}
