import { api } from './api';

export interface AppleAppLoginRequest {
  identityToken: string;
  authorizationCode: string | null;
  user: string;
  email: string | null;
  givenName: string | null;
  familyName: string | null;
  rawNonce: string;
}

export interface AppleAppLoginResponseData {
  user: import('@/types').UserProfile;
  tokens: import('@/types').TokenPair;
  isNewUser: boolean;
}

export function appleAppLogin(data: AppleAppLoginRequest) {
  return api.post<AppleAppLoginResponseData>(
    '/api/user/v1/apple/login/app-login',
    data
  );
}