import { Platform } from 'react-native';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import {
  parseNotificationPayload,
  savePendingToStorage,
} from '@/services/notification-navigation';

const NOTIFICATION_TAP_TASK = 'notification-tap';

// Define the task ONLY if on Android (avoids iOS registration issues).
// Background tasks run in an independent JS context — they do NOT share
// module-level variables with the main thread. Communication must go
// through AsyncStorage (via savePendingToStorage). Do NOT reference
// router / setCurrentSession / pendingPayload here.
if (Platform.OS === 'android' && !TaskManager.isTaskDefined(NOTIFICATION_TAP_TASK)) {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    NOTIFICATION_TAP_TASK,
    async ({ data, error }) => {
      try {
        if (error) {
          console.warn('[notification-tap] Task error:', error);
          return Notifications.BackgroundNotificationTaskResult.NoData;
        }

        const payload = parseNotificationPayload(data);

        if (payload !== null) {
          await savePendingToStorage(payload);
        }

        return Notifications.BackgroundNotificationTaskResult.NoData;
      } catch (e) {
        // MUST NOT throw — throws silently fail in the background task
        // context (G6). Returning NoData (not Failed) prevents retry storms.
        console.warn('[notification-tap] Unexpected error:', e);
        return Notifications.BackgroundNotificationTaskResult.NoData;
      }
    },
  );
}

/**
 * Register the Android-only notification-tap background task.
 *
 * When the app is killed and the user taps a notification, Android relaunches
 * the app and runs the task to persist the payload to AsyncStorage. The main
 * thread then consumes it via `loadPendingFromStorage()` on next foreground.
 * This bridge is required because the background task has its own JS context
 * and cannot share module-level state with the UI thread.
 */
export async function registerNotificationBackgroundTask(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  if (!TaskManager.isTaskDefined(NOTIFICATION_TAP_TASK)) {
    return;
  }

  try {
    await Notifications.registerTaskAsync(NOTIFICATION_TAP_TASK);
  } catch (e) {
    console.warn('[notification-tap] Registration failed:', e);
  }
}
