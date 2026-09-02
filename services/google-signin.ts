import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';

/** 配置 Google Sign-In SDK */
export async function configureGoogleSignIn(): Promise<void> {
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  GoogleSignin.configure({
    webClientId,
    iosClientId: "YOUR_GOOGLE_IOS_CLIENT_ID.apps.googleusercontent.com",
    offlineAccess: false,
  });
}

/** 发起 Google Sign-In，返回 idToken 或 null（用户取消） */
export async function signInWithGoogle(): Promise<string | null> {
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const userInfo = await GoogleSignin.signIn();
    return userInfo.data?.idToken ?? null;
  } catch (e: any) {
    // 用户取消，静默忽略
    if (e.code === statusCodes.SIGN_IN_CANCELLED) {
      return null;
    }
    throw e;
  }
}

/** 登出 Google 账号（断开连接） */
export async function signOutGoogle(): Promise<void> {
  try {
    await GoogleSignin.signOut();
  } catch {
    // 忽略 signOut 错误
  }
}
