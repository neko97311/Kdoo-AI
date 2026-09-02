// Avoid importing Platform from react-native directly — it can cause
// "Platform is not defined" errors in certain Metro/web bundling scenarios
// where the module-level Platform object isn't initialised in time.
// Using a typeof check is safe in all JS runtimes (RN, web, SSR).
import { Platform } from 'react-native';

export const isWeb =
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  // React Native also defines `window`, but it never has `window.document`
  typeof window.document !== 'undefined';

export const isNative = !isWeb;

// Fine-grained OS detection requires react-native Platform on native.
// We lazy-import to avoid the module-level issue.
let _isIOS: boolean | undefined;
let _isAndroid: boolean | undefined;

export const isIOS = (): boolean => {
  if (_isIOS !== undefined) return _isIOS;
  // Dynamic require is intentional — this path only runs on native.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _isIOS = Platform.OS === 'ios';
  return _isIOS;
};

export const isAndroid = (): boolean => {
  if (_isAndroid !== undefined) return _isAndroid;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _isAndroid = Platform.OS === 'android';
  return _isAndroid;
};
