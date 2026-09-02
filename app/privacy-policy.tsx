import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '@/hooks/useI18n';
import { ScreenHeader } from '@/components/chat/ScreenHeader';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { PRIVACY_POLICY_EN } from '@/constants/legal/privacy-policy.en';
import { PRIVACY_POLICY_ZH } from '@/constants/legal/privacy-policy.zh';
import { PRIVACY_POLICY_PT } from '@/constants/legal/privacy-policy.pt';

const contentMap: Record<string, string> = {
  zh: PRIVACY_POLICY_ZH,
  en: PRIVACY_POLICY_EN,
  pt: PRIVACY_POLICY_PT,
};

export default function PrivacyPolicyScreen() {
  const { t, locale } = useI18n();
  const markdownContent = contentMap[locale] || contentMap.en;

  return (
    <View className="flex-1 bg-aura-surface">
      <ScreenHeader title={t('legal.privacyPolicy')} rightIcon="none" />
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
