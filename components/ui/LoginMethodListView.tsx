import { View, Text, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useI18n } from '@/hooks/useI18n';

export type LoginMethodStatus = 'enabled' | 'disabled' | 'no_data';

export interface LoginMethod {
  provider: string;
  name: string;
  enabled: boolean;
  hasAccount: boolean;
}

interface LoginMethodListViewProps {
  loginMethods?: LoginMethod[];
  isLoading?: boolean;
}

type IconName = keyof typeof Ionicons.glyphMap;

function resolveIcon(provider: string): { name: IconName; color: string } {
  switch (provider) {
    case 'google':
      return { name: 'logo-google', color: '#4285F4' };
    case 'apple':
      return { name: 'logo-apple', color: '#000000' };
    case 'email':
      return { name: 'mail-outline', color: '#464554' };
    case 'phiz':
      return { name: 'person-circle-outline', color: '#1D4ED8' };
    default:
      return { name: 'shield-checkmark-outline', color: '#1D4ED8' };
  }
}

function getStatus(method: LoginMethod): LoginMethodStatus {
  if (!method.hasAccount) return 'no_data';
  return method.enabled ? 'enabled' : 'disabled';
}

export function LoginMethodListView({ loginMethods, isLoading = false }: LoginMethodListViewProps) {
  const { t } = useI18n();
  const methods = loginMethods ?? [];

  const statusText = (status: LoginMethodStatus): string => {
    switch (status) {
      case 'enabled':
        return t('loginMethod.statusEnabled');
      case 'disabled':
        return t('loginMethod.statusDisabled');
      case 'no_data':
        return t('loginMethod.statusNoData');
    }
  };

  const resolveName = (method: LoginMethod): string => {
    const key = `loginMethod.providers.${method.provider}`;
    const localized = t(key);
    // Fallback when provider is unknown or missing translation: show backend-provided name
    return localized === key ? method.name : localized;
  };

  return (
    <View className="px-5">
      {isLoading ? (
        <View className="items-center py-10">
          <ActivityIndicator size="small" color="#1D4ED8" />
        </View>
      ) : methods.length === 0 ? (
        <View className="items-center py-10">
          <Text className="text-sm text-[#464554] dark:text-[#9a99a9]">—</Text>
        </View>
      ) : (
        <View className="gap-3">
          {methods.map((method) => {
            const status = getStatus(method);
            const { name: iconName, color: iconColor } = resolveIcon(method.provider);

            const statusClass =
              status === 'enabled'
                ? 'text-[#22C55E]'
                : status === 'disabled'
                  ? 'text-[#F59E0B]'
                  : 'text-[#464554] dark:text-[#9a99a9]';

            return (
              <View
                key={method.provider}
                className="flex-row items-center gap-3 p-3 rounded-xl bg-white dark:bg-[#1a1b1e] border border-[#c7c4d7] dark:border-[#2a2b2f]"
              >
                <View className="w-10 h-10 rounded-lg items-center justify-center bg-[#f7f8fa] dark:bg-[#222326] border border-[#c7c4d7] dark:border-[#2a2b2f]">
                  <Ionicons name={iconName} size={22} color={iconColor} />
                </View>

                <View className="flex-1 min-w-0">
                  <Text
                    className="text-sm font-medium text-[#191c1e] dark:text-[#e6e8ea]"
                    numberOfLines={1}
                  >
                    {resolveName(method)}
                  </Text>
                  <Text className={`text-xs mt-0.5 ${statusClass}`} numberOfLines={1}>
                    {statusText(status)}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
