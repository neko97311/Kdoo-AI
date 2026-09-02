import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  Keyboard,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useI18n } from '@/hooks/useI18n';
import { useForm } from '@/hooks/useForm';
import { v, required, email, minLength, maxLength, match } from '@/utils/schema';
import {
  sendVerificationCode as sendCodeApi,
  verifyCode as verifyCodeApi,
  resetPassword as resetPasswordApi,
} from '@/services/email-auth';
import base64 from 'base-64';
import type { SendCodeResponseData } from '@/types';
import { KeyboardAvoidingView } from '@/components/KeyboardAvoidingView';

/** 忘记密码流程步骤 */
type Step = 'send' | 'verify' | 'reset';

const CODE_LENGTH = 6;

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  // ── Step 1: email form (uses useForm) ──
  const emailForm = useForm({
    schema: { email: v<string>(required, email) },
    initialValues: { email: '' },
    onSubmit: async ({ email }) => {
      const res: SendCodeResponseData = await sendCodeApi({
        email: email.trim(),
        purpose: 'RESET_PASSWORD',
      });
      setRetryAfter(res.retryAfter ?? 60);
      setStep('verify');
    },
  });

  // ── Step 3: reset password form (uses useForm) ──
  const resetForm = useForm({
    schema: {
      newPassword: v<string>(required, minLength(6), maxLength(50)),
      confirmPassword: v<string>(required, match('newPassword')),
    },
    initialValues: { newPassword: '', confirmPassword: '' },
    onSubmit: async ({ newPassword }) => {
      await resetPasswordApi({
        email: emailForm.values.email.trim(),
        verificationToken,
        newPassword: base64.encode(newPassword),
      });
      setResetSuccess(true);
      setCountdown(5);
    },
  });

  // ── Step machine + cross-step state ──
  const [step, setStep] = useState<Step>('send');
  const [retryAfter, setRetryAfter] = useState(0);

  // ── Verify step state (manual — ref-forwarding focus chain) ──
  const [codeDigits, setCodeDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const [verificationToken, setVerificationToken] = useState('');
  const [codeError, setCodeError] = useState('');
  const [verifyLoading, setVerifyLoading] = useState(false);
  const codeInputRefs = useRef<(TextInput | null)[]>([]);

  // ── Reset step UI state ──
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const code = codeDigits.join('');
  const emailReg = emailForm.register('email');
  const newPwReg = resetForm.register('newPassword');
  const confirmPwReg = resetForm.register('confirmPassword');

  const handleBackToLogin = useCallback(() => {
    router.replace('/login');
  }, [router]);

  // Countdown ticker — pure state update only
  useEffect(() => {
    if (!resetSuccess || countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => Math.max(prev - 1, 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [resetSuccess, countdown]);

  // Navigate back when countdown reaches 0
  useEffect(() => {
    if (resetSuccess && countdown === 0) {
      handleBackToLogin();
    }
  }, [resetSuccess, countdown, handleBackToLogin]);

  // ── Countdown timer for retry button ──
  useEffect(() => {
    if (retryAfter <= 0) return;
    const timer = setInterval(() => {
      setRetryAfter((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAfter]);

  // ============================================================
  // Step 1: Send verification code
  // ============================================================
  const handleSendCode = () => {
    emailForm.setSubmitError(null);
    void emailForm.handleSubmit();
  };

  // ============================================================
  // Step 2: Verify code
  // ============================================================
  const handleVerifyCode = useCallback(async () => {
    setCodeError('');

    if (code.length !== CODE_LENGTH) {
      setCodeError(t('forgotPassword.errorCodeIncomplete'));
      return;
    }

    Keyboard.dismiss();
    setVerifyLoading(true);
    try {
      const res = await verifyCodeApi({
        email: emailForm.values.email.trim(),
        code,
        purpose: 'RESET_PASSWORD',
      });
      setVerificationToken(res.verificationToken);
      setStep('reset');
    } catch (e: any) {
      setCodeError(e?.message || t('forgotPassword.errorCodeVerify'));
    } finally {
      setVerifyLoading(false);
    }
  }, [code, emailForm.values.email, t]);

  // Auto-verify when all 6 digits are entered
  useEffect(() => {
    if (step === 'verify' && code.length === CODE_LENGTH && !verifyLoading) {
      handleVerifyCode();
    }
  }, [code, step, verifyLoading, handleVerifyCode]);

  const handleCodeChange = (text: string, index: number) => {
    const digit = text.replace(/[^0-9]/g, '').slice(-1); // last char only, handles replace-on-type

    setCodeDigits(prev => {
      const next = [...prev];
      next[index] = digit;
      return next;
    });
    if (codeError) setCodeError('');

    if (digit && index < CODE_LENGTH - 1) {
      codeInputRefs.current[index + 1]?.focus();
    }
  };

  // ============================================================
  // Step 3: Reset password
  // ============================================================
  const handleResetPassword = () => {
    resetForm.setSubmitError(null);
    void resetForm.handleSubmit();
  };

  const handleResendCode = async () => {
    if (retryAfter > 0) return;
    setVerifyLoading(true);
    try {
      const res: SendCodeResponseData = await sendCodeApi({
        email: emailForm.values.email.trim(),
        purpose: 'RESET_PASSWORD',
      });
      setRetryAfter(res.retryAfter ?? 60);
    } catch {
    } finally {
      setVerifyLoading(false);
    }
  };

  // ============================================================
  // Render: Step 1 — Enter email
  // ============================================================
  const renderSendStep = () => (
    <>
      <View className="items-center">
        <View className="w-20 h-20 rounded-3xl bg-[#6063ee] items-center justify-center mb-4 shadow-lg">
          <Ionicons name="lock-closed-outline" size={40} color="#fffbff" />
        </View>
        <Text className="text-2xl font-semibold text-[#191c1e] dark:text-[#e6e8ea] mb-2">
          {t('forgotPassword.title')}
        </Text>
        <Text className="text-base text-[#464554] dark:text-[#9a99a9] text-center leading-6">
          {t('forgotPassword.subtitle')}
        </Text>
      </View>

      <View className="mt-8">
        <View>
          <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9] ml-1 mb-1">
            {t('forgotPassword.email')}
          </Text>
          <TextInput
            className={`w-full h-14 px-4 bg-white dark:bg-[#1a1b1e] border rounded-xl text-base text-[#191c1e] dark:text-[#e6e8ea] ${emailForm.touched.email && emailForm.errors.email ? 'border-red-500' : 'border-[#c7c4d7] dark:border-[#2a2b2f]'}`}
            placeholder={t('forgotPassword.emailPlaceholder')}
            placeholderTextColor="#9CA3AF"
            keyboardType="email-address"
            autoCapitalize="none"
            {...emailReg}
          />
          {emailForm.touched.email && emailForm.errors.email ? (
            <Text className="text-sm text-red-500 ml-1 mt-1">{t(`validation.${emailForm.errors.email}`)}</Text>
          ) : emailForm.submitError ? (
            <Text className="text-sm text-red-500 ml-1 mt-1">{emailForm.submitError}</Text>
          ) : null}
        </View>

        <Pressable
          className={`w-full h-14 bg-[#4648d4] rounded-full items-center justify-center flex-row gap-2 mt-6 ${emailForm.isSubmitting ? 'opacity-70' : 'active:opacity-90'}`}
          onPress={handleSendCode}
          disabled={emailForm.isSubmitting}
        >
          <Text className="text-base font-semibold text-white">
            {emailForm.isSubmitting ? t('forgotPassword.sending') : t('forgotPassword.sendCode')}
          </Text>
          {!emailForm.isSubmitting && <Ionicons name="send-outline" size={20} color="#ffffff" />}
        </Pressable>
      </View>

      <View className="items-center mt-8">
        <Pressable className="flex-row items-center gap-1" onPress={handleBackToLogin}>
          <Ionicons name="arrow-back" size={18} color="#4648d4" />
          <Text className="text-base text-[#4648d4] font-semibold">
            {t('forgotPassword.backToSignIn')}
          </Text>
        </Pressable>
      </View>
    </>
  );

  // ============================================================
  // Render: Step 2 — Enter verification code
  // ============================================================
  const renderVerifyStep = () => (
    <>
      <View className="items-center">
        <View className="w-20 h-20 rounded-full bg-blue-100 dark:bg-blue-900 items-center justify-center mb-4 will-change-variable">
          <Ionicons name="mail-outline" size={40} color="#4648d4" />
        </View>
        <Text className="text-2xl font-semibold text-[#191c1e] dark:text-[#e6e8ea] mb-2">
          {t('forgotPassword.enterCode')}
        </Text>
        <Text className="text-base text-[#464554] dark:text-[#9a99a9] text-center leading-6">
          {t('forgotPassword.codeSentTo')}
          <Text className="font-semibold">{emailForm.values.email}</Text>
        </Text>
      </View>

      <View className="mt-8">
        {/* 6-digit code inputs */}
        <View className="flex-row justify-center gap-3">
          {Array.from({ length: CODE_LENGTH }).map((_, index) => (
            <TextInput
              key={index}
              ref={(ref) => { codeInputRefs.current[index] = ref; }}
              style={{ width: 48, height: 56, backgroundColor: '#fff', borderWidth: 1, borderColor: '#c7c4d7', borderRadius: 12, textAlign: 'center', fontSize: 20, fontWeight: '600', color: '#191c1e' }}
              keyboardType="number-pad"
              maxLength={1}
              value={codeDigits[index] || ''}
              onChangeText={(text) => handleCodeChange(text, index)}
              selectTextOnFocus
            />
          ))}
        </View>

        {codeError ? (
          <Text className="text-sm text-red-500 text-center mt-2">{codeError}</Text>
        ) : null}

        {/* Resend link */}
        <View className="flex-row justify-center mt-4">
          <Pressable onPress={handleResendCode} disabled={retryAfter > 0 || verifyLoading}>
            <Text
              className={`text-sm font-medium ${retryAfter > 0 ? 'text-[#9a99a9]' : 'text-[#4648d4]'}`}
            >
              {retryAfter > 0
                ? t('forgotPassword.resendIn', { seconds: retryAfter })
                : t('forgotPassword.resendCode')}
            </Text>
          </Pressable>
        </View>

        <Pressable
          className={`w-full h-14 bg-[#4648d4] rounded-full items-center justify-center flex-row gap-2 mt-6 ${verifyLoading ? 'opacity-70' : 'active:opacity-90'}`}
          onPress={handleVerifyCode}
          disabled={verifyLoading}
        >
          <Text className="text-base font-semibold text-white">
            {verifyLoading ? t('forgotPassword.verifying') : t('forgotPassword.verifyCode')}
          </Text>
          {!verifyLoading && <Ionicons name="checkmark-circle-outline" size={20} color="#ffffff" />}
        </Pressable>
      </View>

      <View className="items-center mt-8">
        <Pressable className="flex-row items-center gap-1" onPress={handleBackToLogin}>
          <Ionicons name="arrow-back" size={18} color="#4648d4" />
          <Text className="text-base text-[#4648d4] font-semibold">
            {t('forgotPassword.backToSignIn')}
          </Text>
        </Pressable>
      </View>
    </>
  );

  // ============================================================
  // Render: Step 3 — Set new password
  // ============================================================
  const renderResetStep = () => {
    if (resetSuccess) {
      return (
        <View className="items-center">
          <View className="w-20 h-20 rounded-full bg-green-100 dark:bg-green-900 items-center justify-center mb-4">
            <Ionicons name="checkmark-circle" size={48} color="#22c55e" />
          </View>
          <Text className="text-2xl font-semibold text-[#191c1e] dark:text-[#e6e8ea] mb-2">
            {t('forgotPassword.successTitle')}
          </Text>
          <Text className="text-base text-[#464554] dark:text-[#9a99a9] text-center leading-6 mb-2">
            {t('forgotPassword.successMessage')}
          </Text>
          <View className="flex-row items-center justify-center gap-2 mb-8">
            <Text className="text-base text-[#464554] dark:text-[#9a99a9]">
              {t('forgotPassword.autoRedirect', { seconds: '' })}
            </Text>
            <View className="bg-green-500 rounded-lg px-2.5 py-0.5 min-w-[36px] items-center">
              <Text className="text-xl font-bold text-white">{countdown}</Text>
            </View>
            <Text className="text-base text-[#464554] dark:text-[#9a99a9]">s</Text>
          </View>
          <Pressable
            className="w-full h-14 bg-[#4648d4] rounded-full items-center justify-center flex-row gap-2 active:opacity-90"
            onPress={handleBackToLogin}
          >
            <Ionicons name="log-in-outline" size={20} color="#ffffff" />
            <Text className="text-base font-semibold text-white">
              {t('forgotPassword.backToSignIn')}
            </Text>
          </Pressable>
        </View>
      );
    }

    return (
    <>
      <View className="items-center">
        <View className="w-20 h-20 rounded-full bg-green-100 dark:bg-green-900 items-center justify-center mb-4 will-change-variable">
          <Ionicons name="shield-checkmark-outline" size={40} color="#22c55e" />
        </View>
        <Text className="text-2xl font-semibold text-[#191c1e] dark:text-[#e6e8ea] mb-2">
          {t('forgotPassword.setNewPassword')}
        </Text>
        <Text className="text-base text-[#464554] dark:text-[#9a99a9] text-center leading-6">
          {t('forgotPassword.setNewPasswordHint')}
        </Text>
      </View>

      <View className="mt-8">
        {/* New password */}
        <View>
          <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9] ml-1 mb-1">
            {t('forgotPassword.newPassword')}
          </Text>
          <View className="relative">
            <TextInput
              className={`w-full h-14 px-4 pr-12 bg-white dark:bg-[#1a1b1e] border rounded-xl text-base text-[#191c1e] dark:text-[#e6e8ea] ${resetForm.touched.newPassword && resetForm.errors.newPassword ? 'border-red-500' : 'border-[#c7c4d7] dark:border-[#2a2b2f]'}`}
              placeholder={t('forgotPassword.newPasswordPlaceholder')}
              placeholderTextColor="#9CA3AF"
              secureTextEntry={!showNewPassword}
              {...newPwReg}
            />
            {resetForm.touched.newPassword && resetForm.errors.newPassword ? (
              <Text className="text-sm text-red-500 ml-1 mt-1">{t(`validation.${resetForm.errors.newPassword}`)}</Text>
            ) : null}
            <Pressable
              className="absolute right-4 top-1/2 -translate-y-1/2"
              onPress={() => setShowNewPassword(!showNewPassword)}
            >
              <Ionicons
                name={showNewPassword ? 'eye-off-outline' : 'eye-outline'}
                size={22}
                color="#767586"
              />
            </Pressable>
          </View>
        </View>

        {/* Confirm password */}
        <View className="mt-4">
          <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9] ml-1 mb-1">
            {t('forgotPassword.confirmPassword')}
          </Text>
          <View className="relative">
            <TextInput
              className={`w-full h-14 px-4 pr-12 bg-white dark:bg-[#1a1b1e] border rounded-xl text-base text-[#191c1e] dark:text-[#e6e8ea] ${resetForm.touched.confirmPassword && resetForm.errors.confirmPassword ? 'border-red-500' : 'border-[#c7c4d7] dark:border-[#2a2b2f]'}`}
              placeholder={t('forgotPassword.confirmPasswordPlaceholder')}
              placeholderTextColor="#9CA3AF"
              secureTextEntry={!showConfirmPassword}
              {...confirmPwReg}
            />
            {resetForm.touched.confirmPassword && resetForm.errors.confirmPassword ? (
              <Text className="text-sm text-red-500 ml-1 mt-1">{t(`validation.${resetForm.errors.confirmPassword}`)}</Text>
            ) : null}
            <Pressable
              className="absolute right-4 top-1/2 -translate-y-1/2"
              onPress={() => setShowConfirmPassword(!showConfirmPassword)}
            >
              <Ionicons
                name={showConfirmPassword ? 'eye-off-outline' : 'eye-outline'}
                size={22}
                color="#767586"
              />
            </Pressable>
          </View>
          {resetForm.submitError ? (
            <Text className="text-sm text-red-500 ml-1 mt-1">{resetForm.submitError}</Text>
          ) : null}
        </View>

        <Pressable
          className={`w-full h-14 bg-[#4648d4] rounded-full items-center justify-center flex-row gap-2 mt-6 ${resetForm.isSubmitting ? 'opacity-70' : 'active:opacity-90'}`}
          onPress={handleResetPassword}
          disabled={resetForm.isSubmitting}
        >
          <Text className="text-base font-semibold text-white">
            {resetForm.isSubmitting ? t('forgotPassword.resetting') : t('forgotPassword.resetPassword')}
          </Text>
          {!resetForm.isSubmitting && <Ionicons name="lock-closed-outline" size={20} color="#ffffff" />}
        </Pressable>
      </View>

      <View className="items-center mt-8">
        <Pressable className="flex-row items-center gap-1" onPress={handleBackToLogin}>
          <Ionicons name="arrow-back" size={18} color="#4648d4" />
          <Text className="text-base text-[#4648d4] font-semibold">
            {t('forgotPassword.backToSignIn')}
          </Text>
        </Pressable>
      </View>
    </>
  );
  };

  // ============================================================
  // Main render
  // ============================================================
  const stepRenderers: Record<Step, () => React.ReactNode> = {
    send: renderSendStep,
    verify: renderVerifyStep,
    reset: renderResetStep,
  };

  return (
    <KeyboardAvoidingView
      keyboardVerticalOffset={insets.top}
      className="flex-1 bg-[#f7f9fb] dark:bg-[#0f1117]"
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
      >
        <View className="flex-1 justify-center px-5 pt-12">
          <View className="w-full max-w-md self-center">
            {stepRenderers[step]()}
          </View>
        </View>

        <View
          className="absolute -top-24 -left-24 w-64 h-64 rounded-full -z-10"
          style={{ backgroundColor: 'rgba(70, 72, 212, 0.05)' }}
        />
        <View
          className="absolute bottom-24 -right-24 w-80 h-80 rounded-full -z-10"
          style={{ backgroundColor: 'rgba(129, 39, 207, 0.05)' }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
