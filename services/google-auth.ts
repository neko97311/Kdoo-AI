import { api } from './api';
import type {
  GoogleAppLoginRequest,
  GoogleAppLoginResponseData,
} from '@/types';

/** Google App 登录（发送 idToken） */
export function googleAppLogin(data: GoogleAppLoginRequest) {
  return api.post<GoogleAppLoginResponseData>(
      `/api/user/v1/google/login/app-login`,
      data
  );
}