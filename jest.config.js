/**
 * Jest configuration.
 *
 * `preset: 'jest-expo'` auto-mocks `react-native` and every `expo-*` module
 * (required so the runtime imports in utils/attachments.ts — react-native,
 * expo-image-picker, expo-document-picker, expo-file-system — resolve under
 * node without loading native code) and configures babel-jest to transform
 * TS/TSX consistently with babel-preset-expo.
 *
 * `moduleNameMapper` wires the `@/` path alias that babel module-resolver
 * provides at runtime but which is absent in the jest environment — this is
 * what lets both source modules and tests resolve `@/services/...`,
 * `@/utils/...`, `@/types` etc.
 *
 * `setupFiles` installs the official AsyncStorage jest mock via jest.setup.js
 * (https://react-native-async-storage.github.io/async-storage/docs/advanced/jest)
 * — the native module is null under node and sources that import it at the
 * top level (e.g. services/notification-navigation.ts) fail to load otherwise.
 */
module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  setupFiles: ['<rootDir>/jest.setup.js'],
};
