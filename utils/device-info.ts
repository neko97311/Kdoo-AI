// Device info caching utilities for server-side telemetry headers.
//
// 设备信息在 App 生命周期内不变，因此模块级懒加载缓存一次即可。
// Web 端不发设备 header（产品需求：仅针对 iOS/Android 移动端）。

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { isWeb } from '@/utils/platform';

/** 设备埋点 Header 名称 */
export const DEVICE_HEADER = {
  MODEL: 'x-device-model',
  OS_NAME: 'x-os-name',
  OS_VERSION: 'x-os-version',
  APP_VERSION: 'x-app-version',
} as const;

export interface DeviceInfo {
  /** 设备机型，如 "iPhone 15 Pro" / "Pixel 8" */
  model: string;
  /** 操作系统名，如 "iOS" / "Android" */
  osName: string;
  /** 操作系统版本，如 "17.4.1" */
  osVersion: string;
  /** App 版本号，来自 app.json/app.config */
  appVersion: string;
}

let cached: DeviceInfo | null = null;

/**
 * 获取设备信息（模块级缓存，App 生命周期内只计算一次）。
 *
 * 兜底逻辑：expo-device 在模拟器/某些环境下可能返回 null，
 * 此时退回 `Platform.OS` / `Platform.Version`，确保字段总有非空值。
 */
export function getDeviceInfo(): DeviceInfo {
  if (cached) return cached;

  cached = {
    model:
      Device.modelName ||
      (Platform.OS === 'ios' ? 'iOS Device' : 'Android Device'),
    osName: Device.osName || Platform.OS || 'unknown',
    osVersion:
      Device.osVersion ||
      (Platform.Version != null ? String(Platform.Version) : 'unknown'),
    appVersion: Constants.expoConfig?.version || 'unknown',
  };

  return cached;
}

/**
 * 构造设备埋点 HTTP headers。
 *
 * Web 端返回空对象（产品需求：仅移动端发送设备 header）。
 * 移动端返回 4 个 header：x-device-model / x-os-name / x-os-version / x-app-version。
 */
export function getDeviceHeaders(): Record<string, string> {
  // Web 端不发设备 header
  if (isWeb) return {};

  const info = getDeviceInfo();
  return {
    [DEVICE_HEADER.MODEL]: info.model,
    [DEVICE_HEADER.OS_NAME]: info.osName,
    [DEVICE_HEADER.OS_VERSION]: info.osVersion,
    [DEVICE_HEADER.APP_VERSION]: info.appVersion,
  };
}
