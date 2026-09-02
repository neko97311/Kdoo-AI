import { api } from './api';
import type {
  LoginRequest,
  LoginResponseData,
  RegisterRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  SendVerificationRequest,
  SendCodeResponseData,
  VerifyCodeRequest,
  VerificationResponseData,
  CheckAuthResponseData,
} from '@/types';
import type { ApiResponse } from '@/types';

const BASE_PATH = '/api/user/v1';

// ============================================================
// Auth
// ============================================================

/** 邮箱/用户名/手机号 + 密码登录 */
export function login(data: LoginRequest) {
  return api.post<LoginResponseData>(
    `${BASE_PATH}/auth/login`,
    data
  );
}

/** 邮箱注册 */
export function register(data: RegisterRequest) {
  return api.post<LoginResponseData>(
    `${BASE_PATH}/auth/register`,
    data
  );
}

/** 忘记密码 - 一步发送验证码 */
export function forgotPassword(data: ForgotPasswordRequest) {
  return api.post<SendCodeResponseData>(
    `${BASE_PATH}/auth/forgot-password`,
    data
  );
}

/** 重置密码 */
export function resetPassword(data: ResetPasswordRequest) {
  return api.post<null>(
    `${BASE_PATH}/auth/reset-password`,
    data
  );
}

/** 直接修改密码（已登录，无需旧密码和验证码） */
export function changePasswordDirect(newPasswordBase64: string) {
  return api.put<null>(
    `${BASE_PATH}/profile/password-direct`,
    { newPassword: newPasswordBase64 }
  );
}

/** 退出登录 */
export function logout() {
  return api.post<null>(`${BASE_PATH}/auth/logout`);
}

/** 检查登录状态 */
export function checkAuth() {
  return api.get<CheckAuthResponseData>(
    `${BASE_PATH}/auth/check`
  );
}

// ============================================================
// Verification
// ============================================================

/** 发送验证码 */
export function sendVerificationCode(data: SendVerificationRequest) {
  return api.post<SendCodeResponseData>(
    `${BASE_PATH}/verification/send`,
    data
  );
}

/** 验证验证码 */
export function verifyCode(data: VerifyCodeRequest) {
  return api.post<VerificationResponseData>(
    `${BASE_PATH}/verification/verify`,
    data
  );
}