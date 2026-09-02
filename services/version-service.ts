import { api } from '@/services/api';
import { isAndroid, isIOS } from '@/utils/platform';

export interface AppVersionInfo {
  latestVersion: string;
  releaseNotes?: string;
  downloadUrl?: string;
  forceUpdate?: boolean;
}

const VERSION_ENDPOINT = '/api/app/v1/version';

/** Uppercase platform name matching backend enum (e.g. ANDROID, IOS, WEB). */
function getPlatformParam(): string {
  if (isAndroid()) return 'ANDROID';
  if (isIOS()) return 'IOS';
  return 'WEB';
}

/** Fetch active app version. Throws on error; caller should handle. */
export async function fetchAppVersion(): Promise<AppVersionInfo> {
  return await api.get<AppVersionInfo>(VERSION_ENDPOINT, {
    params: { platform: getPlatformParam() },
  });
}
