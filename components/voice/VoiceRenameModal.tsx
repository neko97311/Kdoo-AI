import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Modal,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useI18n } from '@/hooks/useI18n';
import { useResolvedScheme } from '@/hooks/useColors';
import type { Voice } from '@/types/voice';

/**
 * 用户克隆音色改名 Modal。
 *
 * 设计约束:
 *   - 视觉风格对齐 ConfirmModal/UpdateModal(rounded-2xl 卡片 + 半透明遮罩)。
 *   - 100% 离父组件控制;父组件按 (Voice | null) 传入 target,传 null 即关闭。
 *   - 提交时由父组件调 store.renameVoice()。本组件只负责输入校验与反馈。
 *
 * 校验:
 *   - 非空(去掉首尾空白)
 *   - ≤ 60 字符(用户层硬限制,后端契约 1-64;前端保守 4 字符 buffer 避免边界 413)
 *   - 带空格计算(用 String.length,即 UTF-16 code unit)
 *   - 与原名相同 → 视为未修改,关闭但不请求
 */
export interface VoiceRenameModalProps {
  target: Voice | null;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (name: string) => void | Promise<void>;
}

const MAX_NAME_LENGTH = 60;

export function VoiceRenameModal({
  target,
  submitting,
  onCancel,
  onConfirm,
}: VoiceRenameModalProps) {
  const { t } = useI18n();
  const isDark = useResolvedScheme() === 'dark';
  const inputRef = useRef<TextInput>(null);

  // 用 target 切换时强制重置输入内容(避免上一个目标残留)。
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (target) {
      setName(target.voiceName ?? '');
      setTouched(false);
      // 等 Modal 弹出动画完成再聚焦,避免 iOS 上键盘弹起时卡顿。
      const timer = setTimeout(() => inputRef.current?.focus(), 120);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [target]);

  const trimmed = name.trim();
  const tooLong = name.length > MAX_NAME_LENGTH;
  const empty = trimmed.length === 0;
  const unchanged = !!target && trimmed === (target.voiceName ?? '');
  const hasError = empty || tooLong;
  const errorKey: 'renameEmpty' | 'renameTooLong' | null = empty
    ? 'renameEmpty'
    : tooLong
      ? 'renameTooLong'
      : null;

  const visible = target !== null;
  const canSubmit = !submitting && !hasError && !unchanged;

  const handleConfirm = () => {
    if (!canSubmit) return;
    void onConfirm(trimmed);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={submitting ? undefined : onCancel}
    >
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}
        onPress={submitting ? undefined : onCancel}
      >
        <View
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}
        >
          <Pressable
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#1a1b1e] px-6 pt-6 pb-5 active:scale-[0.98]"
            onPress={(e) => e.stopPropagation?.()}
          >
            {/* Icon */}
            <View className="items-center mb-4">
              <View
                className={`w-12 h-12 rounded-full items-center justify-center ${
                  isDark ? 'bg-[#4648d4]/20' : 'bg-[#4648d4]/10'
                }`}
              >
                <Ionicons name="create-outline" size={24} color="#4648d4" />
              </View>
            </View>

            {/* Title */}
            <Text className="text-base font-semibold text-center text-[#191c1e] dark:text-[#e6e8ea] mb-3">
              {t('voiceSettings.renameTitle')}
            </Text>

            {/* Input */}
            <View
              className={`rounded-xl px-3 py-2 mb-1 flex-row items-center ${
                isDark ? 'bg-[#0f1117]' : 'bg-[#f7f8fa]'
              } ${
                touched && hasError
                  ? 'border border-red-500'
                  : 'border border-transparent'
              }`}
            >
              <TextInput
                ref={inputRef}
                value={name}
                onChangeText={setName}
                onBlur={() => setTouched(true)}
                placeholder={t('voiceSettings.renamePlaceholder')}
                placeholderTextColor="#9CA3AF"
                editable={!submitting}
                maxLength={MAX_NAME_LENGTH + 1 /* 允许多打 1 个以触发 error 提示 */}
                returnKeyType="done"
                onSubmitEditing={handleConfirm}
                className="flex-1 text-base text-[#191c1e] dark:text-[#e6e8ea]"
                style={{ paddingVertical: 6 }}
              />
              <Text className="text-[11px] text-[#9a99a9] ml-2">
                {name.length}/{MAX_NAME_LENGTH}
              </Text>
            </View>

            {/* Error hint */}
            <View className="min-h-[18px] mb-3">
              {touched && errorKey ? (
                <Text className="text-xs text-red-500">
                  {t(`voiceSettings.${errorKey}`)}
                </Text>
              ) : (
                <Text className="text-xs text-transparent">placeholder</Text>
              )}
            </View>

            {/* Buttons */}
            <Pressable
              disabled={!canSubmit}
              className={`w-full h-12 rounded-full items-center justify-center flex-row gap-2 mb-2.5 ${
                canSubmit ? 'bg-[#4648d4] active:opacity-90' : 'bg-[#4648d4]/40'
              }`}
              onPress={handleConfirm}
            >
              {submitting && <ActivityIndicator size="small" color="#ffffff" />}
              <Text className="text-sm font-semibold text-white">
                {t('voiceSettings.renameConfirm')}
              </Text>
            </Pressable>
            <Pressable
              disabled={submitting}
              className="w-full h-12 rounded-full items-center justify-center active:opacity-70"
              onPress={onCancel}
            >
              <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9]">
                {t('common.cancel')}
              </Text>
            </Pressable>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}
