import Constants from 'expo-constants';
import { i18n } from '@/i18n';

export type TimeGroup = 'today' | 'yesterday' | 'last7' | 'lastMonth' | 'older';

export function getTimeGroup(date: Date): TimeGroup {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfLast7 = new Date(startOfToday);
  startOfLast7.setDate(startOfLast7.getDate() - 7);
  const startOfLastMonth = new Date(startOfToday);
  startOfLastMonth.setDate(startOfLastMonth.getDate() - 30);

  if (date >= startOfToday) return 'today';
  if (date >= startOfYesterday) return 'yesterday';
  if (date >= startOfLast7) return 'last7';
  if (date >= startOfLastMonth) return 'lastMonth';
  return 'older';
}

export const timeGroupOrder: TimeGroup[] = ['today', 'yesterday', 'last7', 'lastMonth', 'older'];

/**
 * 格式化聊天消息的时间戳显示。
 *
 * 规则(纯数字、不依赖 locale,保证 iOS/Android/Web 一致):
 *   - 今天的消息 → 24 小时制时分,如 "14:05"
 *   - 非今天的消息 → 年月日,如 "2025-01-15"
 *
 * 之所以不用 toLocaleTimeString():该 API 在不同平台/locale 下行为
 * 不一致(可能 12 小时制带 AM/PM),且无法区分今天与非今天。
 */
export function formatMessageTime(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return i18n.t('time.justNow');
  if (diffMins < 60) return `${diffMins}${i18n.t('time.minutesAgo')}`;
  if (diffHours < 24) return `${diffHours}${i18n.t('time.hoursAgo')}`;
  if (diffDays === 1) return i18n.t('time.yesterday');
  if (diffDays < 7) return `${diffDays}${i18n.t('time.daysAgo')}`;
  return date.toLocaleDateString();
}

/** Format a build timestamp (epoch seconds injected by app.config.ts) as a human-readable local time string. */
export function formatBuildTime(buildTimestamp: string | number | null | undefined): string {
  if (buildTimestamp === null || buildTimestamp === undefined) {
    return i18n.t('debug.notAvailable');
  }
  const raw = String(buildTimestamp).trim();
  if (!raw || raw === 'null' || raw === 'undefined') {
    return i18n.t('debug.notAvailable');
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    // Fallback: Android may expose versionCode ("1.0.0") — show as-is.
    return raw;
  }
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return i18n.t('debug.notAvailable');
  }
  const pad = (n: number) => n.toString().padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Extract the raw build timestamp value injected by app.config.ts.
 *
 * Prefers the platform-specific key (CFBundleVersion on iOS, versionCode on
 * Android) because those are the values that survive prebuild into the
 * native Info.plist / build.gradle and are therefore readable in Dev
 * Client builds — unlike the deprecated `Constants.nativeBuildVersion`
 * API, which is not exposed by expo-constants and is null here.
 */
export function getRawBuildTimestamp(): string | null {
  const expoConfig = Constants.expoConfig as
    | { ios?: { buildNumber?: unknown }; android?: { versionCode?: unknown } }
    | null
    | undefined;
  const os = Constants.platform?.os;
  const iosBuild = (Constants.platform?.ios as { buildNumber?: unknown } | undefined)?.buildNumber;
  const androidVersion = (Constants.platform?.android as { versionCode?: unknown } | undefined)?.versionCode;
  if (os === 'ios') {
    const v = iosBuild ?? expoConfig?.ios?.buildNumber;
    return v == null ? null : String(v);
  }
  if (os === 'android') {
    const v = androidVersion ?? expoConfig?.android?.versionCode;
    return v == null ? null : String(v);
  }
  const v = expoConfig?.ios?.buildNumber ?? expoConfig?.android?.versionCode;
  return v == null ? null : String(v);
}
