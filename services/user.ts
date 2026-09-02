import { api } from './api';
import type { UserProfile, ChatSetting } from '@/types';

const BASE_PATH = '/api/user/v1';

export async function getProfile(): Promise<UserProfile> {
  return api.get<UserProfile>(`${BASE_PATH}/profile/me`);
}

/** Get current chat settings */
export async function getChatSettings(): Promise<ChatSetting> {
  return api.get<ChatSetting>(`${BASE_PATH}/chat-settings`);
}

/** Update chat settings (theme, language, etc.) */
export async function updateChatSettings(
  data: Partial<Pick<ChatSetting, 'theme' | 'language' | 'autoScroll' | 'enableRichText' | 'requireCmdEnter' | 'hideThinking' | 'channelSharedAgent' | 'autoPlay'>>
): Promise<ChatSetting> {
  return api.put<ChatSetting>(`${BASE_PATH}/chat-settings`, data);
}

// ──────────────────── Account Settings ────────────────────

/** Fields that can be updated via the account settings page */
export interface UpdateProfileInput {
  displayName?: string;
  bio?: string;
}

export async function updateProfile(data: UpdateProfileInput): Promise<UserProfile> {
  return api.put<UserProfile>(`${BASE_PATH}/profile/me`, data);
}

export async function updateAvatar(filename: string): Promise<{ avatar: string }> {
  return api.put<{ avatar: string }>(`${BASE_PATH}/profile/me/avatar`, { avatar: filename });
}

/** Permanently delete the account and all of its data (irreversible). */
export async function deleteAccount(): Promise<{ deleted: boolean }> {
  return api.post<{ deleted: boolean }>(`${BASE_PATH}/profile/delete-account`);
}

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'https://api.example.com';

/**
 * Resolve an avatar field to a full usable URL for Image source.
 *
 * Compatible with three formats:
 *   - `/api/user/v1/oss/download/xxx.png` → prepend API_BASE_URL
 *   - `api/user/v1/oss/download/xxx.png`  → prepend `/` then API_BASE_URL
 *   - `xxx.png` (bare filename)           → construct full OSS download path
 */
export function resolveAvatarUrl(avatar?: string | null): string {
  if (!avatar) return '';

  // If avatar is already a complete HTTP/HTTPS URL (e.g. CDN), return it directly
  if (avatar.startsWith('http://') || avatar.startsWith('https://')) {
    return avatar;
  }

  const downloadPrefix = '/api/user/v1/oss/download/';
  let relativePath: string;

  if (avatar.startsWith(downloadPrefix)) {
    relativePath = avatar;
  } else if (avatar.startsWith('api/user/v1/oss/download/')) {
    relativePath = `/${avatar}`;
  } else {
    relativePath = `${downloadPrefix}${avatar}`;
  }

  return `${API_BASE_URL}${relativePath}`;
}