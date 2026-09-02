import { useAuthStore } from '@/stores/auth';
import type { LoginRequest, RegisterRequest } from '@/types';

export function useAuth() {
  const {
    user,
    token,
    isAuthenticated,
    isLoading,
    login: storeLogin,
    register: storeRegister,
    logout: storeLogout,
    googleLogin: storeGoogleLogin,
    appleLogin: storeAppleLogin,
    initialize,
  } = useAuthStore();

  const login = async (credentials: LoginRequest) => {
    await storeLogin(credentials);
  };

  const register = async (data: RegisterRequest) => {
    await storeRegister(data);
  };

  const logout = async () => {
    await storeLogout();
  };

  const googleLogin = async () => {
    await storeGoogleLogin();
  };

  const appleLogin = async () => {
    await storeAppleLogin();
  };

  return {
    user,
    token,
    isAuthenticated,
    isLoading,
    login,
    register,
    logout,
    googleLogin,
    appleLogin,
    initialize,
  };
}
