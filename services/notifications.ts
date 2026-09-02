import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerDevice, type DevicePlatform } from './device';
import { logger } from '@/utils/logger';

export const PUSH_TOKEN_CACHE_KEY = 'push_token_cache';

// Prevents feedback loop: getDevicePushTokenAsync() can trigger addPushTokenListener,
// which calls this function again before the cache write completes.
let isRegistering = false;

// Must stay at module scope — moving this into a function silently drops all foreground notifications.
// Guard: expo-notifications native module is not available on Web.
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      // Foreground: do NOT surface the system banner/list/sound — the app is
      // open, so the notification is handled in-app (registerForegroundNotificationListener
      // logs it and can refresh the message list / show a toast). Showing a
      // system banner while the app is in the foreground is the reported bug
      // ("生成图片时 app 已打开仍弹通知").
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: true,
    }),
  });
}

export async function ensureNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  try {
    await Notifications.setNotificationChannelAsync('default', {
      name: '默认',
      importance: AndroidImportance.HIGH,
    });
  } catch (error) {
    logger.warn('notifications', 'ensureNotificationChannel failed', error);
  }
}

/**
 * 请求通知权限并返回授权状态
 * @returns true 表示已授权
 */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    const status = await Notifications.requestPermissionsAsync();
    logger.debug('push', '权限详情', {
      granted: status.granted,
      status: status.status,
      ios: (status as { ios?: { status?: string } }).ios?.status,
      android: (status as { android?: { status?: string } }).android?.status,
    });
    return status.granted === true;
  } catch (error) {
    logger.warn('push', 'requestNotificationPermission 异常', error);
    return false;
  }
}

/**
 * 注册推送通知：请求权限 → 获取 token → 向后端注册设备
 * @param force 是否强制重新注册（忽略缓存）
 * @returns 设备推送 token，失败返回 null
 */
export async function registerForPushNotifications(force = false): Promise<string | null> {
  logger.debug('push', `registerForPushNotifications 被调用, force=${force}`);
  if (isRegistering) {
    logger.debug('push', '跳过：正在注册中');
    return null;
  }
  isRegistering = true;
  try {
    // 1. 权限请求
    const granted = await requestNotificationPermission();
    if (!granted) {
      logger.info('push', '权限未授予，退出注册');
      return null;
    }

    await ensureNotificationChannel();

    // 2. 获取原生设备推送 token (FCM/APNs)
    // SECURITY: only the token TYPE is logged at info; the full token is
    // intentionally truncated to first 8 + last 4 chars with a mask so it
    // never lands in the JSONL log file (which gets uploaded to the
    // backend by services/log-upload.ts). On real devices the push token
    // IS a long-lived bearer credential — leaking it grants push-send
    // capability to whoever reads the logs.
    const { type, data } = await Notifications.getDevicePushTokenAsync();
    const maskedToken = data.length > 12 ? `${data.slice(0, 8)}…${data.slice(-4)}` : '***';
    logger.info('push', `Token 获取成功 type=${type} masked=${maskedToken}`);

    // 3. 缓存检查（非强制时跳过未变化的 token）
    if (!force) {
      const cachedToken = await AsyncStorage.getItem(PUSH_TOKEN_CACHE_KEY);
      if (cachedToken === data) {
        logger.debug('push', 'Token 未变化，跳过重注册');
        return data;
      }
    }

    // 4. 向后端注册设备
    logger.info('push', `向/后端注册设备... force=${force}`);
    const device = await registerDevice({ platform: type as DevicePlatform, token: data });
    if (!device) {
      logger.warn('push', '后端注册返回 undefined');
      return data;
    }
    logger.info('push', '后端注册成功', { deviceId: device.id, platform: device.platform });

    await AsyncStorage.setItem(PUSH_TOKEN_CACHE_KEY, data);
    logger.info('push', '全链路完成，Token 已缓存');

    return data;
  } catch (error) {
    logger.warn('push', 'registerForPushNotifications 失败', error);
    return null;
  } finally {
    isRegistering = false;
  }
}

/**
 * 注册前台通知接收监听器，记录 app 在前台时收到的推送通知
 * @param callback 可选回调，在收到前台通知时触发（如刷新消息列表）
 * @returns 订阅对象，调用 .remove() 清理
 */
export function registerForegroundNotificationListener(
  callback?: (notification: Notifications.Notification) => void,
): Notifications.Subscription {
  return Notifications.addNotificationReceivedListener((notification) => {
    logger.debug('push', '前台收到通知', {
      title: notification.request.content.title,
      body: notification.request.content.body,
      data: notification.request.content.data,
      identifier: notification.request.identifier,
    });
    callback?.(notification);
  });
}

/**
 * 获取当前推送通知状态（权限 + 缓存的 token），用于调试页面展示
 * @returns 权限状态和缓存的 token
 */
export async function getPushNotificationStatus(): Promise<{
  permissionStatus: string | null;
  token: string | null;
}> {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    const token = await AsyncStorage.getItem(PUSH_TOKEN_CACHE_KEY);
    return { permissionStatus: status, token };
  } catch (error) {
    logger.warn('push', 'getPushNotificationStatus error', error);
    return { permissionStatus: null, token: null };
  }
}
