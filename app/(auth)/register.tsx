import { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useI18n } from '@/hooks/useI18n';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { useForm } from '@/hooks/useForm';
import { v, required, email, minLength, match } from '@/utils/schema';
import { useToastStore } from '@/stores/toast';
import {
  sendVerificationCode as sendCodeApi,
  verifyCode as verifyCodeApi,
  register as registerApi,
} from '@/services/email-auth';
import base64 from 'base-64';
import type { SendCodeResponseData } from '@/types';
import { isIOS } from '@/utils/platform';
import { KeyboardAvoidingView } from '@/components/KeyboardAvoidingView';

/** 注册流程步骤 */
type Step = 'send' | 'verify' | 'register';

const CODE_LENGTH = 6;

export default function RegisterScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  // ── Step 1: email form (uses useForm) ──
  const emailForm = useForm({
    schema: { email: v<string>(required, email) },
    initialValues: { email: '' },
    onSubmit: async ({ email: emailValue }) => {
      const res: SendCodeResponseData = await sendCodeApi({
        email: emailValue.trim(),
        purpose: 'REGISTER',
      });
      setRetryAfter(res.retryAfter ?? 60);
      setStep('verify');
    },
  });

  // ── Shared state ──
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [step, setStep] = useState<Step>('send');
  const [retryAfter, setRetryAfter] = useState(0);

  // ── Verify step state ──
  const [code, setCode] = useState('');
  const [verificationToken, setVerificationToken] = useState('');
  const [codeError, setCodeError] = useState('');
  const codeInputRefs = useRef<(TextInput | null)[]>([]);

  // ── Register step state ──
  const registerForm = useForm({
    schema: {
      password: v<string>(required, minLength(6)),
      confirmPassword: v<string>(required, match('password')),
    },
    initialValues: { password: '', confirmPassword: '' },
    onSubmit: async ({ password }) => {
      await registerApi({
        email: emailForm.values.email.trim(),
        password: base64.encode(password),
        verificationToken,
      });
      useToastStore.getState().showToast({ message: t('register.successMessage') });
      router.replace('/(auth)/login');
    },
  });
  const [showPassword, setShowPassword] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [showAgreement, setShowAgreement] = useState(false);

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
  const handleVerifyCode = async () => {
    if (code.length !== CODE_LENGTH) {
      setCodeError(t('register.errorCodeIncomplete'));
      return;
    }
    setCodeError('');

    setVerifyLoading(true);
    try {
      const res = await verifyCodeApi({
        email: emailForm.values.email.trim(),
        code,
        purpose: 'REGISTER',
      });
      setVerificationToken(res.verificationToken);
      setStep('register');
    } catch (e: any) {
      // Inline error display — no Alert popup (per UX requirement).
      // Falls back to generic verify message if backend gave none.
      setCodeError(e?.message || t('register.errorCodeVerify'));
    } finally {
      setVerifyLoading(false);
    }
  };

  const handleCodeChange = (text: string, index: number) => {
    const digit = text.replace(/[^0-9]/g, '');
    if (digit.length > 1) return;

    const newCode = code.split('');
    newCode[index] = digit;
    setCode(newCode.join(''));

    if (digit && index < CODE_LENGTH - 1) {
      codeInputRefs.current[index + 1]?.focus();
    }
  };

  // ============================================================
  // Step 3: Register
  // ============================================================
  const handleRegister = () => {
    if (!agreed) {
      setShowAgreement(true);
      return;
    }
    registerForm.setSubmitError(null);
    void registerForm.handleSubmit();
  };

  const handleAgreementConfirm = () => {
    setAgreed(true);
    setShowAgreement(false);
    registerForm.setSubmitError(null);
    void registerForm.handleSubmit();
  };

  const handleResendCode = async () => {
    if (retryAfter > 0) return;
    setVerifyLoading(true);
    try {
      const res: SendCodeResponseData = await sendCodeApi({
        email: emailForm.values.email.trim(),
        purpose: 'REGISTER',
      });
      setRetryAfter(res.retryAfter ?? 60);
    } catch {
      // Silently fail, user can tap again
    } finally {
      setVerifyLoading(false);
    }
  };

  const handleBackToLogin = () => router.replace('/(auth)/login');

  const emailReg = emailForm.register('email');

  // ============================================================
  // Render: Step 1 — Enter email
  // ============================================================
  const renderSendStep = () => (
    <>
      <View className="items-center">
        <View className="w-20 h-20 rounded-3xl bg-[#6063ee] items-center justify-center mb-4 shadow-lg">
          <Ionicons name="person-add-outline" size={40} color="#fffbff" />
        </View>
        <Text className="text-2xl font-semibold text-[#191c1e] dark:text-[#e6e8ea] mb-2">
          {t('register.title')}
        </Text>
        <Text className="text-base text-[#464554] dark:text-[#9a99a9] text-center leading-6">
          {t('register.subtitle')}
        </Text>
      </View>

      <View className="mt-8">
        <View>
          <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9] ml-1 mb-1">
            {t('register.email')}
          </Text>
          <TextInput
            className={`w-full h-14 px-4 bg-white dark:bg-[#1a1b1e] border rounded-xl text-base text-[#191c1e] dark:text-[#e6e8ea] ${emailForm.touched.email && emailForm.errors.email ? 'border-red-500' : 'border-[#c7c4d7] dark:border-[#2a2b2f]'}`}
            placeholder={t('register.emailPlaceholder')}
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
            {emailForm.isSubmitting ? t('register.sending') : t('register.sendCode')}
          </Text>
          {!emailForm.isSubmitting && <Ionicons name="send-outline" size={20} color="#ffffff" />}
        </Pressable>
      </View>

      <View className="items-center mt-8">
        <Pressable className="flex-row items-center gap-1" onPress={handleBackToLogin}>
          <Ionicons name="arrow-back" size={18} color="#4648d4" />
          <Text className="text-base text-[#4648d4] font-semibold">
            {t('register.backToLogin')}
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
          {t('register.enterCode')}
        </Text>
        <Text className="text-base text-[#464554] dark:text-[#9a99a9] text-center leading-6">
          {t('register.codeSentTo')}
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
              value={code[index] || ''}
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
                ? t('register.resendIn', { seconds: retryAfter })
                : t('register.resendCode')}
            </Text>
          </Pressable>
        </View>

        <Pressable
          className={`w-full h-14 bg-[#4648d4] rounded-full items-center justify-center flex-row gap-2 mt-6 ${verifyLoading ? 'opacity-70' : 'active:opacity-90'}`}
          onPress={handleVerifyCode}
          disabled={verifyLoading}
        >
          <Text className="text-base font-semibold text-white">
            {verifyLoading ? t('register.verifying') : t('register.verifyCode')}
          </Text>
          {!verifyLoading && <Ionicons name="checkmark-circle-outline" size={20} color="#ffffff" />}
        </Pressable>
      </View>

      <View className="items-center mt-8">
        <Pressable className="flex-row items-center gap-1" onPress={handleBackToLogin}>
          <Ionicons name="arrow-back" size={18} color="#4648d4" />
          <Text className="text-base text-[#4648d4] font-semibold">
            {t('register.backToLogin')}
          </Text>
        </Pressable>
      </View>
    </>
  );

  // ============================================================
  // Render: Step 3 — Set password & register
  // ============================================================
  const renderRegisterStep = () => (
    <>
      <View className="items-center">
        <View className="w-20 h-20 rounded-full bg-green-100 dark:bg-green-900 items-center justify-center mb-4 will-change-variable">
          <Ionicons name="shield-checkmark-outline" size={40} color="#22c55e" />
        </View>
        <Text className="text-2xl font-semibold text-[#191c1e] dark:text-[#e6e8ea] mb-2">
          {t('register.setPassword')}
        </Text>
        <Text className="text-base text-[#464554] dark:text-[#9a99a9] text-center leading-6">
          {t('register.setPasswordHint')}
        </Text>
      </View>

      <View className="mt-8">
        {/* Password */}
        <View>
          <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9] ml-1 mb-1">
            {t('register.password')}
          </Text>
          <View className="relative">
            <TextInput
              className={`w-full h-14 px-4 pr-12 bg-white dark:bg-[#1a1b1e] border rounded-xl text-base text-[#191c1e] dark:text-[#e6e8ea] ${registerForm.touched.password && registerForm.errors.password ? 'border-red-500' : 'border-[#c7c4d7] dark:border-[#2a2b2f]'}`}
              placeholder={t('register.passwordPlaceholder')}
              placeholderTextColor="#9CA3AF"
              secureTextEntry={!showPassword}
              {...registerForm.register('password')}
            />
            <Pressable
              className="absolute right-4 top-1/2 -translate-y-1/2"
              onPress={() => setShowPassword(!showPassword)}
            >
              <Ionicons
                name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                size={22}
                color="#767586"
              />
            </Pressable>
          </View>
          {registerForm.touched.password && registerForm.errors.password ? (
            <Text className="text-sm text-red-500 ml-1 mt-1">{t(`validation.${registerForm.errors.password}`)}</Text>
          ) : null}
        </View>

        <Text className="text-xs text-[#9a99a9] mt-2 ml-1">
          {t('register.passwordHint')}
        </Text>

        {/* Confirm Password */}
        <View className="mt-4">
          <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9] ml-1 mb-1">
            {t('register.confirmPassword')}
          </Text>
          <View className="relative">
            <TextInput
              className={`w-full h-14 px-4 pr-12 bg-white dark:bg-[#1a1b1e] border rounded-xl text-base text-[#191c1e] dark:text-[#e6e8ea] ${registerForm.touched.confirmPassword && registerForm.errors.confirmPassword ? 'border-red-500' : 'border-[#c7c4d7] dark:border-[#2a2b2f]'}`}
              placeholder={t('register.confirmPasswordPlaceholder')}
              placeholderTextColor="#9CA3AF"
              secureTextEntry={!showPassword}
              {...registerForm.register('confirmPassword')}
            />
          </View>
          {registerForm.touched.confirmPassword && registerForm.errors.confirmPassword ? (
            <Text className="text-sm text-red-500 ml-1 mt-1">{t(`validation.${registerForm.errors.confirmPassword}`)}</Text>
          ) : null}
          {registerForm.submitError ? (
            <Text className="text-sm text-red-500 ml-1 mt-1">{registerForm.submitError}</Text>
          ) : null}
        </View>

        <Pressable
          className={`w-full h-14 bg-[#4648d4] rounded-full items-center justify-center flex-row gap-2 mt-6 ${registerForm.isSubmitting ? 'opacity-70' : 'active:opacity-90'}`}
          onPress={handleRegister}
          disabled={registerForm.isSubmitting}
        >
          <Text className="text-base font-semibold text-white">
            {registerForm.isSubmitting ? t('register.registering') : t('register.register')}
          </Text>
          {!registerForm.isSubmitting && <Ionicons name="person-add-outline" size={20} color="#ffffff" />}
        </Pressable>
      </View>

      <View className="items-center mt-8">
        <Pressable className="flex-row items-center gap-1" onPress={handleBackToLogin}>
          <Ionicons name="arrow-back" size={18} color="#4648d4" />
          <Text className="text-base text-[#4648d4] font-semibold">
            {t('register.backToLogin')}
          </Text>
        </Pressable>
      </View>

      {/* Checkbox agreement */}
      <View className="mt-4 px-3">
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
    </>
  );

  // ============================================================
  // Main render
  // ============================================================
  const stepRenderers: Record<Step, () => React.ReactNode> = {
    send: renderSendStep,
    verify: renderVerifyStep,
    register: renderRegisterStep,
  };

  return (
    <KeyboardAvoidingView
      keyboardVerticalOffset={insets.top}
      className="flex-1 bg-[#f7f9fb] dark:bg-[#0f1117]"
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
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

      <ConfirmModal
        visible={showAgreement}
        title={t('legal.alertTitle')}
        message={t('legal.alertMessage')}
        confirmText={t('legal.alertConfirm')}
        cancelText={t('legal.alertCancel')}
        onConfirm={handleAgreementConfirm}
        onCancel={() => setShowAgreement(false)}
      />
    </KeyboardAvoidingView>
  );
}