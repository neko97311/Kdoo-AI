/**
 * Safe haptic feedback that no-ops on the iOS Simulator.
 *
 * CoreHaptics on the iOS Simulator logs a flood of
 *   "Failed to read pattern library data: hapticpatternlibrary.plist"
 * errors on every call because the simulator's Tunings directory does
 * not ship the haptic pattern library. Real devices are unaffected.
 *
 * `expo-haptics` is a fire-and-forget API — every call returns a
 * Promise that rejects with the CHHapticPattern error. We swallow the
 * rejection (`.catch(() => {})`) AND short-circuit on simulator so the
 * errors never surface in the JS console / native log.
 *
 * Usage:
 *   import { safeHapticImpact } from '@/utils/haptics';
 *   safeHapticImpact(Haptics.ImpactFeedbackStyle.Medium);
 *
 * Keep this wrapper thin. If you need a selection or notification haptic,
 * extend it the same way.
 */

import * as Haptics from 'expo-haptics';
import * as Device from 'expo-device';

export const ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle;

/**
 * `Device.isDevice === false` means we're running on a Simulator.
 * The haptic pattern library only exists on real hardware.
 */
const isRealDevice = Device.isDevice === true;

export function safeHapticImpact(style: Haptics.ImpactFeedbackStyle): void {
  if (!isRealDevice) return;
  // Fire-and-forget; if CHHapticPattern still fails on some other platform,
  // swallow the rejection so we never log an unhandled promise warning.
  Haptics.impactAsync(style).catch(() => {});
}
