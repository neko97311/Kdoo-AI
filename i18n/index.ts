import { getLocales } from 'expo-localization';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { I18n } from 'i18n-js';
import en from './en';
import zh from './zh';
import pt from './pt';

const SUPPORTED_LOCALES = ['zh', 'en', 'pt'];
const APP_LANGUAGE_KEY = 'app_preferred_language';

const i18n = new I18n({ en, zh, pt });

// Enable fallback to English if a key is missing
i18n.enableFallback = true;
i18n.defaultLocale = 'en';

// Resolve initial locale from device
function resolveInitialLocale(deviceLocale: string | undefined): string {
  const normalized = deviceLocale?.toLowerCase().slice(0, 2) ?? '';
  return SUPPORTED_LOCALES.includes(normalized) ? normalized : 'en';
}

const initialLocale = resolveInitialLocale(getLocales().at(0)?.languageCode ?? undefined);
i18n.locale = initialLocale;

/**
 * Reactive locale store for unauthenticated users.
 *
 * When a user is logged in, locale is managed by the auth store
 * (user.chatSetting.language). For unauthenticated screens (login, register,
 * forgot-password), this store provides the reactive source so that language
 * changes trigger UI re-renders.
 */
interface LocaleState {
  locale: string;
  setLocale: (locale: string) => void;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: initialLocale,
  setLocale: (locale) => set({ locale }),
}));

// Set locale immediately from device (will be overridden by AsyncStorage if available)
// Async: load persisted language preference and override if exists
export async function initializeLocale(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(APP_LANGUAGE_KEY);
    if (stored && SUPPORTED_LOCALES.includes(stored)) {
      i18n.locale = stored;
      useLocaleStore.getState().setLocale(stored);
      return stored;
    }
  } catch {
    // AsyncStorage unavailable, keep device locale
  }
  return i18n.locale;
}

/** Pure i18n.locale setter — safe to call during render (no store/state updates). */
export function setI18nLocale(locale: string) {
  i18n.locale = locale;
}

export async function setAppLanguage(locale: string): Promise<void> {
  i18n.locale = locale;
  useLocaleStore.getState().setLocale(locale);
  try {
    await AsyncStorage.setItem(APP_LANGUAGE_KEY, locale);
  } catch {
    // AsyncStorage unavailable, locale change is session-only
  }
}

export function getSupportedLocales(): string[] {
  return SUPPORTED_LOCALES;
}

export { i18n };
