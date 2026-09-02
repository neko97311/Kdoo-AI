import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

interface KdooSignatureInterface {
  getSha1(): string;
}

const KdooNative = Platform.OS === 'android'
  ? requireNativeModule<KdooSignatureInterface>('KdooSignature')
  : null;

export default {
  getSha1(): string {
    if (Platform.OS === 'android' && KdooNative) {
      return KdooNative.getSha1();
    }
    if (Platform.OS === 'ios') {
      return 'N/A (iOS - no SHA1 signature available)';
    }
    return 'N/A (unsupported platform)';
  },
};