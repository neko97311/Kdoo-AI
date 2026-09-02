import { useState } from 'react';
import { Pressable, View, Text, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Voice } from '@/types/voice';
import { useI18n } from '@/hooks/useI18n';
import { useResolvedScheme } from '@/hooks/useColors';
import { VoicePreviewButton } from '@/components/voice/VoicePreviewButton';
import { resolveAudioUrl } from '@/services/voice-management-service';
import { ConfirmModal } from '@/components/ui/ConfirmModal';

export interface VoiceCardProps {
  voice: Voice;
  selected: boolean;
  /** 切换为默认音色（单选语义：再点已选则取消） */
  onToggle: () => void;
  onDelete?: () => void;
  /**
   * 改名回调(打开 Modal 场景)。仅克隆音色会传入,系统音色无意义。
   * 父组件负责弹窗与提交,与本组件解耦。
   */
  onRename?: () => void;
  /** 禁用交互（如训练中） */
  disabled?: boolean;
}

export function VoiceCard({
  voice,
  selected,
  onToggle,
  onDelete,
  onRename,
  disabled,
}: VoiceCardProps) {
  const { t } = useI18n();
  const isDark = useResolvedScheme() === 'dark';
  const [confirmDeleteVisible, setConfirmDeleteVisible] = useState(false);

  // v1.1: pending/processing 都是未完成态;failed 永久保留在 mine 列表.
  const training = voice.status === 'pending' || voice.status === 'processing';
  const failed = voice.status === 'failed';
  // 删除仅对克隆音色(source='cloned')有效;系统音色只读。
  // 训练中禁用任何编辑(防并发);failed 状态允许删除(用户想清掉失败记录)。
  // 被选中的音色不显示删除按钮 —— 当前正在用的音色删了会回退到 null,
  // 体验上突兀;让用户先切到别的再删。
  const canDelete = voice.source === 'cloned' && !training && !selected;
  // 改名与 selected 解耦 —— 被选中的音色也能改名字(选中和改名字是两件事)。
  // failed 不允许改名(失败卡片的名字是创建时定的,改没意义;UI 上也更克制)。
  const canRename = voice.source === 'cloned' && !training && !failed;

  const containerCls = selected
    ? 'border-aura-primary bg-aura-primary/10'
    : failed
      ? 'border-red-500'
      : 'border-aura-outline-variant bg-aura-surface';

  // 把 disabled/training 透传 Pressable.同时给视觉 opacity 反馈,避免用户点"看似可点实际无反应"的卡片。
  const isInteractive = !disabled && !training;

  return (
    <Pressable
      disabled={!isInteractive}
      onPress={() => {
        if (disabled || training || failed) return;
        onToggle();
      }}
      className={`rounded-xl border p-3 ${containerCls}`}
    >
      <View className="flex-row items-center justify-between mb-1">
        <View className="flex-row items-center gap-2 flex-1 mr-2">
          <Text
            className={`text-sm font-medium ${isDark ? 'text-aura-on-surface' : 'text-[#191c1e]'}`}
            numberOfLines={1}
            style={{ flexShrink: 1 }}
          >
            {voice.voiceName}
          </Text>
          {voice.genderLabel && (
            <View className="px-1.5 py-0.5 rounded bg-aura-primary/10">
              <Text className="text-[10px] font-medium text-aura-primary" numberOfLines={1}>
                {voice.genderLabel}
              </Text>
            </View>
          )}
        </View>
        {canRename && onRename && (
          <Pressable
            onPress={onRename}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={t('voiceSettings.rename')}
            className="flex-row items-center justify-center ml-1 px-2 py-1 rounded-md bg-aura-primary/10 active:bg-aura-primary/20"
          >
            <Ionicons name="pencil-outline" size={16} color="#685891" />
          </Pressable>
        )}
        {canDelete && onDelete && (
          <Pressable
            onPress={() => setConfirmDeleteVisible(true)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={t('common.delete')}
            className="flex-row items-center justify-center ml-1 px-2 py-1 rounded-md bg-red-500/10 active:bg-red-500/20"
          >
            <Ionicons name="trash-outline" size={16} color="#ef4444" />
          </Pressable>
        )}
        {selected && <Ionicons name="checkmark-circle" size={18} color="#685891" />}
      </View>

      {/* 训练失败的卡片: 不再渲染 description (里面可能残留后端错误码/Prompt 等冗余信息),
          只保留底部 "失败 + 重试" 即可. */}
      {voice.description && !failed && (
        <Text className="text-xs text-aura-on-surface/70 mb-2" numberOfLines={2}>
          {voice.description}
        </Text>
      )}

      <View className="flex-row items-center justify-between mt-1">
        <View className="flex-row items-center gap-2" style={{ flexShrink: 0 }}>
          {voice.originalAudioUrl && !training && (
            <VoicePreviewButton previewUrl={resolveAudioUrl(voice.originalAudioUrl)} />
          )}
          {training && (
            <View className="flex-row items-center gap-1">
              <ActivityIndicator size="small" />
              <Text className="text-xs text-aura-on-surface/70">
                {t('voiceSettings.training')}
              </Text>
            </View>
          )}
          {failed && (
            <Text className="text-xs text-red-500" numberOfLines={1}>
              {t('voiceSettings.failedShort')}
            </Text>
          )}
        </View>
      </View>
      <ConfirmModal
        visible={confirmDeleteVisible}
        danger
        title={t('voiceSettings.deleteConfirmTitle')}
        message={t('voiceSettings.deleteConfirmBody', { name: voice.voiceName })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={() => {
          setConfirmDeleteVisible(false);
          onDelete?.();
        }}
        onCancel={() => setConfirmDeleteVisible(false)}
      />
    </Pressable>
  );
}
