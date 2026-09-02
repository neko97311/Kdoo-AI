import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

interface ScreenHeaderProps {
  title: string;
  rightIcon?: 'close' | 'none';
  onBack?: () => void;
}

export function ScreenHeader({ title, rightIcon = 'close', onBack }: ScreenHeaderProps) {
  const router = useRouter();

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      router.back();
    }
  };

  return (
    <View className="flex-row justify-between items-center px-5 pb-3 bg-aura-surface border-b border-aura-outline-variant">
      <Pressable className="p-2 -ml-2 rounded-full" onPress={handleBack}>
        <Ionicons name="arrow-back" size={24} className="text-aura-primary" />
      </Pressable>
      <Text
        className="flex-1 text-center text-headline-sm font-bold text-aura-primary"
        numberOfLines={1}
      >
        {title}
      </Text>
      {rightIcon === 'close' ? (
        <Pressable className="p-2 rounded-full" onPress={handleBack}>
          <Ionicons name="close" size={24} className="text-aura-on-surface-variant" />
        </Pressable>
      ) : (
        <View className="w-10" />
      )}
    </View>
  );
}
