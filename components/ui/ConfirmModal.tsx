import { View, Text, Pressable, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useResolvedScheme } from '@/hooks/useColors';

interface ConfirmModalProps {
  visible: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}

export function ConfirmModal({
  visible,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  danger = false,
}: ConfirmModalProps) {
  const isDark = useResolvedScheme() === 'dark';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onCancel}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <Pressable className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#1a1b1e] px-6 pt-6 pb-5 active:scale-[0.98]">
          {/* Icon */}
          <View className="items-center mb-4">
            <View
              className={`w-12 h-12 rounded-full items-center justify-center ${
                danger
                  ? isDark
                    ? 'bg-red-500/20'
                    : 'bg-red-500/10'
                  : isDark
                    ? 'bg-[#4648d4]/20'
                    : 'bg-[#4648d4]/10'
              }`}
            >
              <Ionicons
                name={danger ? 'trash-outline' : 'shield-checkmark'}
                size={24}
                color={danger ? '#ef4444' : '#4648d4'}
              />
            </View>
          </View>

          {/* Title */}
          <Text className="text-base font-semibold text-center text-[#191c1e] dark:text-[#e6e8ea] mb-2">
            {title}
          </Text>

          {/* Message */}
          <Text className="text-sm text-center text-[#464554] dark:text-[#9a99a9] leading-5 mb-6">
            {message}
          </Text>

          {/* Buttons */}
          <Pressable
            className={`w-full h-12 ${danger ? 'bg-[#ef4444]' : 'bg-[#4648d4]'} rounded-full items-center justify-center mb-2.5 active:opacity-90`}
            onPress={onConfirm}
          >
            <Text className="text-sm font-semibold text-white">{confirmText}</Text>
          </Pressable>
          <Pressable
            className="w-full h-12 rounded-full items-center justify-center active:opacity-70"
            onPress={onCancel}
          >
            <Text className="text-sm font-medium text-[#464554] dark:text-[#9a99a9]">{cancelText}</Text>
          </Pressable>
        </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}
