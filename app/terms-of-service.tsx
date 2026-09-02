import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '@/hooks/useI18n';
import { ScreenHeader } from '@/components/chat/ScreenHeader';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { TERMS_OF_SERVICE_EN } from '@/constants/legal/terms-of-service.en';
import { TERMS_OF_SERVICE_ZH } from '@/constants/legal/terms-of-service.zh';
import { TERMS_OF_SERVICE_PT } from '@/constants/legal/terms-of-service.pt';

const contentMap: Record<string, string> = {
  zh: TERMS_OF_SERVICE_ZH,
  en: TERMS_OF_SERVICE_EN,
  pt: TERMS_OF_SERVICE_PT,
};

export default function TermsOfServiceScreen() {
  const { t, locale } = useI18n();
  const markdownContent = contentMap[locale] || contentMap.en;

  return (
    <View className="flex-1 bg-aura-surface">
      <ScreenHeader title={t('legal.termsOfService')} rightIcon="none" />
      <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
        <ScrollView
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 20 }}
        >
          <MarkdownRenderer text={markdownContent} />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
