import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

interface KdooAudioTranscoderInterface {
  transcodeToWav(inputUri: string, outputPath: string): Promise<{
    uri: string;
    sampleRate: number;
    channels: number;
    frames: number;
  }>;
}

const KdooNative =
  Platform.OS === 'android'
    ? requireNativeModule<KdooAudioTranscoderInterface>('KdooAudioTranscoder')
    : null;

export interface TranscodeResult {
  uri: string;
  sampleRate: number;
  channels: number;
  frames: number;
}

/**
 * Decode a compressed audio file (m4a/AAC, webm/Opus, 3gp/AMR) into a
 * 16 kHz mono 16-bit PCM WAV file. On Android only — iOS keeps its
 * existing JS-side CAF stripper in voice-service.ts.
 *
 * Throws if called on a non-Android platform or if the input cannot
 * be decoded.
 */
export async function transcodeToWav(
  inputUri: string,
  outputPath: string
): Promise<TranscodeResult> {
  if (Platform.OS !== 'android' || !KdooNative) {
    throw new Error('KdooAudioTranscoder is Android-only');
  }
  return KdooNative.transcodeToWav(inputUri, outputPath);
}
