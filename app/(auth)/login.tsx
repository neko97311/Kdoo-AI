import { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/hooks/useAuth';
import { useI18n } from '@/hooks/useI18n';
import { useForm } from '@/hooks/useForm';
import { v, required, email, minLength, maxLength } from '@/utils/schema';
import { SocialLoginButton } from '@/components/ui';
import { LanguageBottomSheet } from '@/components/ui/LanguageBottomSheet';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { setAppLanguage } from '@/i18n';
import { isIOS } from '@/utils/platform';
import { KeyboardAvoidingView } from '@/components/KeyboardAvoidingView';

export default function LoginScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { login, googleLogin, appleLogin } = useAuth();
    const { t, locale } = useI18n();

    const [showPassword, setShowPassword] = useState(false);
    const [languageSheetOpen, setLanguageSheetOpen] = useState(false);
    const [agreed, setAgreed] = useState(false);
    const [showAgreement, setShowAgreement] = useState(false);
    const pendingAction = useRef<(() => void) | null>(null);

    const loginSchema = {
      email: v<string>(required, email),
      password: v<string>(required, minLength(6), maxLength(50)),
    };


    const {
      values,
      errors,
      touched,
      isValid,
      isSubmitting,
      submitError,
      setSubmitError,
      register,
      handleSubmit,
    } = useForm({
      schema: loginSchema,
      initialValues: { email: '', password: '' },
      onSubmit: async ({ email, password }) => {
        await login({ email, password });
        // No router.replace('/') — Stack.Protected auto-redirects
        // (auth)→index when isAuthenticated flips. Explicit navigation
        // here would double-navigate and cause ChatHome flash because
        // onLoginSuccess already pre-restored currentSessionId.
      },
    });

  const requireAgreement = (onProceed: () => void) => {
    if (agreed) {
      onProceed();
      return;
    }
    pendingAction.current = onProceed;
    setShowAgreement(true);
  };

  const handleAgreementConfirm = () => {
    setAgreed(true);
    setShowAgreement(false);
    pendingAction.current?.();
    pendingAction.current = null;
  };

  const handleAgreementCancel = () => {
    setShowAgreement(false);
    pendingAction.current = null;
  };

  const handleLogin = () => {
    requireAgreement(() => {
      void handleSubmit();
    });
  };

  const handleForgotPassword = () => router.push('/forgot-password');
  const handleGoogleSignIn = () => {
    requireAgreement(async () => {
      try {
        await googleLogin();
        // No router.replace('/') — see onSubmit comment above.
      } catch (e: any) {
        // User-initiated cancel — no error UI
        if (e?.message?.includes('cancel')) return;
        // Surface business/server errors as inline form banner instead of
        // a blocking Alert popup, matching email/password error UX.
        let details = e?.message || '';
        try {
          details = JSON.stringify(e, Object.getOwnPropertyNames(e));
        } catch {
          details = String(e);
        }
        console.error('[handleGoogleSignIn] full error:', details);
        setSubmitError(e?.message || t('login.googleFailed'));
      }
    });
  };
  const handleAppleSignIn = () => {
    requireAgreement(async () => {
      try {
        await appleLogin();
        // No router.replace('/') — see onSubmit comment above.
      } catch (e: any) {
        if (e?.message?.includes('cancel')) return;
        setSubmitError(e?.message || t('login.appleFailed'));
      }
    });
  };
  const handleCreateAccount = () => router.push('/register');
  const handleSelectLanguage = async (lang: string) => {
    await setAppLanguage(lang);
    setLanguageSheetOpen(false);
  };

  const emailReg = register('email');
  const passwordReg = register('password');

  return (
    <KeyboardAvoidingView keyboardVerticalOffset={insets.top} className="flex-1 bg-[#f7f9fb] dark:bg-[#0f1117]">
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
        <View className="flex-1 justify-center px-5 pt-12">
          <View className="w-full max-w-md self-center">
            <View className="items-center">
              <Image source={require('@/assets/images/icon.png')} className="w-20 h-20 rounded-3xl mb-4" />
              <Text className="text-2xl font-semibold text-[#191c1e] dark:text-[#e6e8ea] mb-2">{t('login.welcome')}</Text>
              <Text className="text-base text-[#464554] dark:text-[#9a99a9]">{t('login.subtitle')}</Text>
            </View>

            <View className="mt-8">
              <View>
                <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9] ml-1 mb-1">{t('login.email')}</Text>
                <TextInput
                  className={`w-full h-14 px-4 bg-white dark:bg-[#1a1b1e] border rounded-xl text-base text-[#191c1e] dark:text-[#e6e8ea] ${touched.email && errors.email ? 'border-red-500' : 'border-[#c7c4d7] dark:border-[#2a2b2f]'}`}
                  placeholder={t('login.emailPlaceholder')}
                  placeholderTextColor="#9CA3AF"
                  keyboardType="email-address"
                  autoCapitalize="none"
                  {...emailReg}
                />
                {touched.email && errors.email ? <Text className="text-sm text-red-500 ml-1 mt-1">{t(`validation.${errors.email}`)}</Text> : null}
              </View>

              <View className="mt-4">
                <View className="flex-row justify-between items-center ml-1 mb-1">
                  <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9]">{t('login.password')}</Text>
                  <Pressable onPress={handleForgotPassword}><Text className="text-sm font-medium text-[#4648d4]">{t('login.forgotPassword')}</Text></Pressable>
                </View>
                <View className="relative">
                  <TextInput
                    className={`w-full h-14 px-4 pr-12 bg-white dark:bg-[#1a1b1e] border rounded-xl text-base text-[#191c1e] dark:text-[#e6e8ea] ${touched.password && errors.password ? 'border-red-500' : 'border-[#c7c4d7] dark:border-[#2a2b2f]'}`}
                    placeholder="••••••••"
                    placeholderTextColor="#9CA3AF"
                    secureTextEntry={!showPassword}
                    {...passwordReg}
                  />
                  <Pressable className="absolute right-4 top-1/2 -translate-y-1/2" onPress={() => setShowPassword(!showPassword)}>
                    <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color="#767586" />
                  </Pressable>
                </View>
                {touched.password && errors.password ? <Text className="text-sm text-red-500 ml-1 mt-1">{t(`validation.${errors.password}`)}</Text> : null}
              </View>

              {submitError ? (
                <View className="mt-3 px-1">
                  <Text className="text-sm text-red-500">{submitError}</Text>
                </View>
              ) : null}

              <Pressable className={`w-full h-14 bg-[#4648d4] rounded-full items-center justify-center flex-row gap-2 mt-6 ${isSubmitting ? 'opacity-70' : 'active:opacity-90'}`} onPress={handleLogin} disabled={isSubmitting}>
                <Text className="text-base font-semibold text-white">{isSubmitting ? t('login.signingIn') : t('login.signIn')}</Text>
                {!isSubmitting && <Ionicons name="log-in-outline" size={20} color="#ffffff" />}
              </Pressable>
            </View>

            <View className="flex-row items-center gap-4 py-2 mt-8">
              <View className="flex-1 h-px bg-[#c7c4d7] dark:bg-[#2a2b2f]" />
              <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9]">{t('login.orSignInWith')}</Text>
              <View className="flex-1 h-px bg-[#c7c4d7] dark:bg-[#2a2b2f]" />
            </View>

            <View className="flex-row gap-4 mt-8">
              <SocialLoginButton title="Google" icon="logo-google" onPress={handleGoogleSignIn} />
              {isIOS() && (
                <SocialLoginButton title="Apple" icon="logo-apple" onPress={handleAppleSignIn} />
              )}
            </View>

            <View className="items-center mt-8">
              <Text className="text-base text-[#464554] dark:text-[#9a99a9]">
                {t('login.noAccount')}
                <Text className="text-[#4648d4] font-semibold" onPress={handleCreateAccount}>{t('login.createAccount')}</Text>
              </Text>
            </View>

            {/* Checkbox agreement */}
            <View className="mt-6 px-3">
              <Pressable className="flex-row items-start active:opacity-70" onPress={() => setAgreed(!agreed)}>
                <View className={`w-[20px] h-[20px] rounded-full items-center justify-center mt-[1px] mr-2.5 ${agreed ? 'bg-[#4648d4]' : 'bg-[#e8e6f0] dark:bg-[#2a2b2f]'}`}>
                  {agreed && <Ionicons name="checkmark" size={13} color="#fff" />}
                </View>
                <Text className="text-sm text-[#464554] dark:text-[#9a99a9] leading-5 flex-1">
                  {t('legal.checkboxLabel')}{' '}
                  <Text className="text-sm text-[#4648d4] font-medium" onPress={() => router.push('/terms-of-service')}>
                    {t('legal.termsOfService')}
                  </Text>
                  {' '}{t('legal.and')}{' '}
                  <Text className="text-sm text-[#4648d4] font-medium" onPress={() => router.push('/privacy-policy')}>
                    {t('legal.privacyPolicy')}
                  </Text>
                </Text>
              </Pressable>
            </View>

            {/* Language switch */}
            <View className="items-center mt-4">
              <Pressable
                className="flex-row items-center gap-1.5 px-3 py-1.5 rounded-full bg-white dark:bg-[#1a1b1e] border border-[#c7c4d7] dark:border-[#2a2b2f]"
                onPress={() => setLanguageSheetOpen(true)}
              >
                <Ionicons name="language" size={14} color="#464554" />
                <Text className="text-xs text-[#464554] dark:text-[#9a99a9]">
                  {t('legal.languageSelect')}: {locale === 'zh' ? '中文' : locale === 'pt' ? 'Português' : 'English'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </ScrollView>

      <LanguageBottomSheet
        visible={languageSheetOpen}
        onClose={() => setLanguageSheetOpen(false)}
        currentLanguage={locale}
        onSelectLanguage={handleSelectLanguage}
      />

      <ConfirmModal
        visible={showAgreement}
        title={t('legal.alertTitle')}
        message={t('legal.alertMessage')}
        confirmText={t('legal.alertConfirm')}
        cancelText={t('legal.alertCancel')}
        onConfirm={handleAgreementConfirm}
        onCancel={handleAgreementCancel}
      />
    </KeyboardAvoidingView>
  );
}
