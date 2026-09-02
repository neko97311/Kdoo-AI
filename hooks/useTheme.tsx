import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { colorScheme } from 'react-native-css';
import { useAuthStore } from '@/stores/auth';
import { setI18nLocale } from '@/i18n';

type ResolvedTheme = 'light' | 'dark';

/**
 * Read the REAL system color scheme.
 * Since we NEVER call Appearance.setColorScheme(), this always
 * returns the true device value on all platforms.
 */
function getSystemTheme(): ResolvedTheme {
  return (Appearance.getColorScheme() as ResolvedTheme) ?? 'light';
}

/**
 * Apply theme via react-native-css colorScheme observable.
 *
 * On native: only updates the internal observable that NativeWind's
 * dark: variant reads. Does NOT touch Appearance API at all.
 * On web: delegates to Appearance.setColorScheme (fine for web).
 */
function applyTheme(theme: ResolvedTheme) {
  colorScheme.set(theme);
}

/**
 * ThemeProvider.
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │ user null / theme = system  → follow device (real-time)      │
 * │ theme = light / dark        → fixed                          │
 * └──────────────────────────────────────────────────────────────┘
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const themePreference = useAuthStore((s) => s.user?.chatSetting?.theme);
  const language = useAuthStore((s) => s.user?.chatSetting?.language);

  const isFixed = themePreference === 'light' || themePreference === 'dark';

  // ──── Apply on preference change ────
  useEffect(() => {
    if (isFixed) {
      applyTheme(themePreference as ResolvedTheme);
    } else {
      // System mode: read real system value (never polluted)
      applyTheme(getSystemTheme());
    }
  }, [isFixed, themePreference]);

  // ──── Listen to REAL system changes ────
  // Since we NEVER call Appearance.setColorScheme(), this listener
  // always fires with the true device value.
  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme: sys }) => {
      if (sys !== 'light' && sys !== 'dark') return;

      if (isFixed) {
        // System changed but user wants fixed theme.
        // react-native-css's internal listener already updated the
        // observable to the system value — re-assert our fixed value.
        applyTheme(themePreference as ResolvedTheme);
      } else {
        // System mode: apply the real system change
        applyTheme(sys);
      }
    });
    return () => sub.remove();
  }, [isFixed, themePreference]);

  // Sync language
  useEffect(() => {
    if (language) {
      setI18nLocale(language);
    }
  }, [language]);

  return <>{children}</>;
}