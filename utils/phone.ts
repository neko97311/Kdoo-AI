import { Linking, PermissionsAndroid, Platform } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { logger } from '@/utils/logger';

/**
 * Outcome of a dial attempt.
 * - called:    Android placed the call directly (ACTION_CALL)
 * - prompted:  iOS handed off to Phone app; the system dialog decides
 * - dialer:    Android permission denied / ACTION_CALL failed → dialer opened
 * - unsupported: device has no telephony (e.g. Wi-Fi-only tablet)
 * - failed:    everything errored
 */
export type DialResult = 'called' | 'prompted' | 'dialer' | 'unsupported' | 'failed';

/** Tolerant arg extraction: the agent may send the number under several keys. */
export function extractPhoneNumber(args: unknown): string | null {
  if (!args) return null;
  const obj = typeof args === 'string' ? safeParse(args) : args;
  if (obj && typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    for (const key of ['phoneNumber', 'phone_number', 'phone', 'number', 'tel']) {
      const v = rec[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Dial a phone number with the best behavior each platform allows:
 * Android auto-calls via ACTION_CALL (runtime CALL_PHONE permission,
 * falls back to the dialer app); iOS always shows the system confirm
 * dialog (Apple forbids zero-interaction calls).
 */
export async function dialPhoneNumber(rawNumber: string): Promise<DialResult> {
  const number = rawNumber.trim();
  if (!number) return 'failed';
  const tel = `tel:${number}`;

  if (Platform.OS === 'android') {
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CALL_PHONE,
      );
      if (granted === PermissionsAndroid.RESULTS.GRANTED) {
        await IntentLauncher.startActivityAsync('android.intent.action.CALL', {
          data: tel,
        });
        return 'called';
      }
      logger.warn('Phone', 'CALL_PHONE permission denied, fallback to dialer');
    } catch (e) {
      logger.warn('Phone', 'ACTION_CALL failed, fallback to dialer', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    try {
      await Linking.openURL(tel);
      return 'dialer';
    } catch {
      return 'failed';
    }
  }

  if (Platform.OS === 'ios') {
    try {
      const supported = await Linking.canOpenURL(tel);
      if (!supported) return 'unsupported';
      await Linking.openURL(tel);
      return 'prompted';
    } catch {
      return 'failed';
    }
  }

  return 'unsupported';
}
