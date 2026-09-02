import { useColorScheme } from 'react-native';
import { useAuthStore } from '@/stores/auth';

type ResolvedScheme = 'light' | 'dark';

/**
 * Returns the *effective* color scheme, mirroring the decision logic in
 * useTheme.tsx / ThemeProvider.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ user.theme = 'light' / 'dark'  → fixed                    │
 * │ user.theme = null / 'system'   → follow device             │
 * └──────────────────────────────────────────────────────────┘
 *
 * Use this anywhere JS-level color resolution is needed (Ionicons color
 * prop, Markdown style objects, ActivityIndicator color, etc.).
 * For className-based styling, prefer aura tokens (text-aura-*) instead.
 */
export function useResolvedScheme(): ResolvedScheme {
  const pref = useAuthStore((s) => s.user?.chatSetting?.theme);
  const sys = useColorScheme();
  if (pref === 'light' || pref === 'dark') return pref;
  return (sys ?? 'light') as ResolvedScheme;
}

/**
 * JS color tokens — mirrors the aura design system defined in global.css.
 *
 * Single source of truth for colors that cannot use className:
 *   <Ionicons color={c.outline} />
 *   <ActivityIndicator color={c.primary} />
 *   <TextInput placeholderTextColor={c.outline} />
 *
 * Values MUST stay in sync with global.css @theme + @media(dark) overrides.
 */
const LIGHT = {
  primary: '#1D4ED8',
  secondary: '#2563EB',
  tertiary: '#A78BFA',
  onSurface: '#1D2129',
  onSurfaceVariant: '#4E5969',
  outline: '#86909C',
  outlineVariant: '#E5E6EB',
  surface: '#FFFFFF',
  surfaceContainer: '#F7F8FA',
  surfaceContainerHigh: '#F0F1F3',
  error: '#F53F3F',
} as const;

const DARK = {
  primary: '#1D4ED8',
  secondary: '#2563EB',
  tertiary: '#A78BFA',
  onSurface: '#e0e0e0',
  onSurfaceVariant: '#9CA3AF',
  outline: '#9CA3AF',
  outlineVariant: '#2a2b2f',
  surface: '#0f1117',
  surfaceContainer: '#1a1b1e',
  surfaceContainerHigh: '#222326',
  error: '#F53F3F',
} as const;

export type ColorTokens = typeof LIGHT;

export function useColors(): ColorTokens {
  // LIGHT and DARK have identical keys but different value literals (their
  // `as const` types are non-overlapping). Cast to the shared LIGHT shape so
  // TypeScript narrows the union to LIGHT — call sites use the literal string
  // values from whichever branch is active at runtime.
  return (useResolvedScheme() === 'dark' ? DARK : LIGHT) as ColorTokens;
}

/**
 * Voice-call page brand palette tokens.
 *
 * Mirrors `--color-call-*` CSS variables in global.css. Kept as a separate
 * hook (not part of useColors) because the call page is an immersive,
 * brand-driven surface that intentionally diverges from the neutral aura
 * tokens used everywhere else.
 *
 * Always update BOTH this file AND global.css when changing these colors.
 */
const LIGHT_CALL = {
  gradientFrom: '#fce4ec',
  gradientTo: '#e3f2fd',
  buttonBg: 'rgba(255,255,255,0.8)',
  buttonIcon: '#333333',
  pillBg: 'rgba(255,255,255,0.6)',
  statusText: '#666666',
  errorText: '#d32f2f',
  errorBg: 'rgba(211,47,47,0.08)',
  footerText: '#aaaaaa',
  avatarBg: '#bbdefb',
  avatarBorder: '#ffffff',
  avatarIcon: '#ffffff',
  hangupBg: '#ffcdd2',
  hangupIcon: '#F53F3F',
} as const;

const DARK_CALL = {
  gradientFrom: '#1a1b2e',
  gradientTo: '#16213e',
  buttonBg: 'rgba(255,255,255,0.12)',
  buttonIcon: '#f0f0f0',
  pillBg: 'rgba(255,255,255,0.08)',
  statusText: '#b0b0b0',
  errorText: '#ff6b6b',
  errorBg: 'rgba(255,107,107,0.12)',
  footerText: '#6a6a6a',
  avatarBg: '#2c3e50',
  avatarBorder: '#3a4a5c',
  avatarIcon: '#cfd6e0',
  hangupBg: '#4a1a1a',
  hangupIcon: '#ff5252',
} as const;

export type CallColorTokens = typeof LIGHT_CALL;

export function useCallColors(): CallColorTokens {
  // Same reasoning as useColors: cast to the shared LIGHT shape so the union
  // narrows correctly even though DARK_CALL has different value literals.
  return (useResolvedScheme() === 'dark' ? DARK_CALL : LIGHT_CALL) as CallColorTokens;
}
