import { View, Modal, ActivityIndicator, Text } from 'react-native';

interface LoadingProps {
  message?: string;
  fullScreen?: boolean;
}

export function Loading({ message = 'Loading...', fullScreen = false }: LoadingProps) {
  if (fullScreen) {
    return (
      <Modal visible transparent animationType="fade">
        <View className="flex-1 items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}>
          <View className="items-center gap-3 px-8 py-6 rounded-card bg-white dark:bg-[#1a1b1e]">
            <ActivityIndicator size="large" color="#1D4ED8" />
            <Text className="text-body-md text-aura-on-surface-variant">{message}</Text>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <View className="items-center justify-center py-8">
      <ActivityIndicator size="large" color="#1D4ED8" />
      <Text className="text-body-md text-aura-on-surface-variant mt-3">{message}</Text>
    </View>
  );
}
