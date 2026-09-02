import { api } from './api';

const BASE_PATH = '/api/user/v1/devices';

export type DevicePlatform = 'android' | 'ios';

export interface DeviceRegistration {
  platform: DevicePlatform;
  token: string;
  appId?: string;
}

export interface DeviceInfo {
  id?: string;
  platform: string;
  token: string;
  active: boolean;
  createdAt?: string;
}

/**
 * 向后端注册设备推送 token
 * @param reg 设备注册信息（平台、token）
 * @returns 注册成功返回设备信息，失败返回 undefined
 */
export async function registerDevice(reg: DeviceRegistration): Promise<DeviceInfo | undefined> {
  try {
    console.log('[device] 📤 注册请求:', {
      platform: reg.platform,
      tokenPreview: reg.token.substring(0, 50) + '...',
    });
    const result = await api.post<DeviceInfo>(BASE_PATH, reg);
    if (!result) {
      console.warn('[device] ⚠️ 注册返回 undefined');
      return undefined;
    }
    console.log('[device] ✅ 注册成功:', {
      id: result.id,
      platform: result.platform,
      active: result.active,
    });
    return result;
  } catch (error) {
    console.warn('[device] ❌ registerDevice 失败:', error);
    return undefined;
  }
}

export async function unregisterDevice(token: string): Promise<boolean> {
  try {
    await api.delete(BASE_PATH, { body: { token } });
    return true;
  } catch (error) {
    console.warn('[device] unregisterDevice failed', error);
    return false;
  }
}

export async function getDevices(): Promise<DeviceInfo[] | undefined> {
  try {
    const result = await api.get<DeviceInfo[]>(BASE_PATH);
    if (!result) {
      console.warn('[device] getDevices returned undefined');
      return undefined;
    }
    return result;
  } catch (error) {
    console.warn('[device] getDevices failed', error);
    return undefined;
  }
}
