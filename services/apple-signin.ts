import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';

/**
 * Generate a cryptographically secure nonce for Apple's replay protection.
 * Protocol: 32 random bytes → base64url encode → SHA-256 hash.
 * - hashed nonce → passed to Apple's signInAsync
 * - raw nonce → sent to backend for verification
 */
async function generateNonce(): Promise<{ raw: string; hashed: string }> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  const raw = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const hashed = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    raw,
    { encoding: Crypto.CryptoEncoding.HEX }
  );
  return { raw, hashed };
}

export interface AppleCredentialPayload {
  identityToken: string;
  authorizationCode: string | null;
  user: string;
  email: string | null;
  fullName: {
    givenName: string | null;
    familyName: string | null;
  } | null;
  rawNonce: string;
}

/** Check if Apple Sign-In is available on this device (iOS 13+) */
export async function isAppleSignInAvailable(): Promise<boolean> {
  return AppleAuthentication.isAvailableAsync();
}

/** Initiate Apple Sign-In. Returns credential payload or null if user cancelled. */
export async function signInWithApple(): Promise<AppleCredentialPayload | null> {
  try {
    const { raw, hashed } = await generateNonce();

    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashed,
    });

    return {
      identityToken: credential.identityToken!,
      authorizationCode: credential.authorizationCode,
      user: credential.user,
      email: credential.email,
      fullName: credential.fullName
        ? {
            givenName: credential.fullName.givenName,
            familyName: credential.fullName.familyName,
          }
        : null,
      rawNonce: raw,
    };
  } catch (e: any) {
    if (e.code === 'ERR_REQUEST_CANCELED') {
      return null;
    }
    throw e;
  }
}

/** Revoke Apple Sign-In tokens (call on account deletion) */
export async function revokeAppleToken(user: string): Promise<void> {
  await AppleAuthentication.signOutAsync({ user });
}