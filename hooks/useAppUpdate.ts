import { useCallback, useRef, useState } from 'react';
import Constants from 'expo-constants';
import { fetchAppVersion, AppVersionInfo } from '@/services/version-service';
import { compareVersions } from '@/utils/version';
import { isAndroid } from '@/utils/platform';

export interface UpdateModalState {
  visible: boolean;
  latestVersion: string;
  releaseNotes: string;
  downloadUrl: string | null;
}

export interface UseAppUpdateResult {
  state: UpdateModalState;
  check: () => Promise<void>;
  dismiss: () => void;
}

const INITIAL_STATE: UpdateModalState = {
  visible: false,
  latestVersion: '',
  releaseNotes: '',
  downloadUrl: null,
};

/**
 * Hook that checks for app updates on cold start.
 * Android release only: __DEV__ / iOS / Web never enter the check.
 * Runs at most once per app session.
 * Silently swallows API errors so a network failure never bothers the user.
 */

export function useAppUpdate(): UseAppUpdateResult {
  const [state, setState] = useState<UpdateModalState>(INITIAL_STATE);
  const checkedRef = useRef(false);

  const check = useCallback(async () => {
    if (!isAndroid()) return;
    if (__DEV__) return;
    if (checkedRef.current) return;
    checkedRef.current = true;

    const localVersion = Constants.expoConfig?.version ?? '0.0.0';

    try {
      const info: AppVersionInfo = await fetchAppVersion();
      if (!info.latestVersion) {
        console.warn('[useAppUpdate] empty latestVersion, skip');
        return;
      }
      if (compareVersions(localVersion, info.latestVersion) < 0) {
        setState({
          visible: true,
          latestVersion: info.latestVersion,
          releaseNotes: info.releaseNotes ?? '',
          downloadUrl: info.downloadUrl ?? null,
        });
      } else {
        console.log('[useAppUpdate] up to date:', localVersion, '>=', info.latestVersion);
      }
    } catch (e) {
      console.warn('[useAppUpdate] check failed:', e);
    }
  }, []);

  const dismiss = useCallback(() => {
    setState((s) => ({ ...s, visible: false }));
  }, []);

  return { state, check, dismiss };
}
