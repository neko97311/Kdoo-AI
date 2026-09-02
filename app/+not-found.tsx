import { View, Text } from 'react-native';
import { Link } from 'expo-router';
import { useI18n } from '@/hooks/useI18n';

export default function NotFoundScreen() {
  const { t } = useI18n();

  return (
    <View className="flex-1 bg-white dark:bg-[#1a1b1e] items-center justify-center px-6">
      <Text className="text-6xl font-bold text-gray-200 dark:text-gray-700">404</Text>
      <Text className="text-xl font-semibold text-gray-900 dark:text-gray-100 mt-4">
        {t('notFound.title')}
      </Text>
      <Text className="text-gray-500 dark:text-gray-400 text-center mt-2">
        {t('notFound.message')}
      </Text>
      <Link href="/" className="mt-6 text-blue-500 font-semibold">
        {t('notFound.goHome')}
      </Link>
    </View>
  );
}
