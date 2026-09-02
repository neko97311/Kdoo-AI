import { useCallback, useMemo } from 'react';
import { i18n, setI18nLocale, useLocaleStore } from '@/i18n';
import { useAuthStore } from '@/stores/auth';

/**
 * Hook that provides i18n translation function and syncs locale
 * with the user's language preference.
 *
 * Locale resolution priority:
 *   1. Auth store (user.chatSetting.language) — for logged-in users
 *   2. useLocaleStore — for unauthenticated users (login/register pages)
 *
 * Usage:
 *   const { t } = useI18n();
 *   <Text>{t('login.welcome')}</Text>
 */
export function useI18n() {
  const userLanguage = useAuthStore((s) => s.user?.chatSetting?.language);
  const isInitialized = useAuthStore((s) => s.isInitialized);
  const storeLocale = useLocaleStore((s) => s.locale);

  // Before the auth store finishes initializing from AsyncStorage, a logged-in
  // user's language preference hasn't been restored yet. Falling back to the
  // device locale during this window causes a flash of the wrong language
  // (e.g. Chinese device + English user setting → brief Chinese on cold start).
  // Default to 'en' until auth is ready, then use the locale store for
  // unauthenticated users.
  const locale = userLanguage || (isInitialized ? storeLocale : 'en');

  // Sync i18n locale whenever the resolved locale changes
  useMemo(() => {
    setI18nLocale(locale);
  }, [locale]);

  const t = useCallback(
    (key: string, options?: Record<string, string | number>) => {
      return i18n.t(key, options);
    },
    [locale] // Re-create when locale changes to bust any memoization cache
  );

  return { t, i18n, locale };
}
