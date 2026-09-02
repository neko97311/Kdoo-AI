import { Pressable, Text, type PressableProps } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface SocialLoginButtonProps extends PressableProps {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
}

export function SocialLoginButton({
  title,
  icon,
  disabled,
  ...props
}: SocialLoginButtonProps) {
  return (
    <Pressable
      className={`flex-1 h-14 flex-row items-center justify-center gap-3 bg-white border border-[#c7c4d7] rounded-xl active:bg-[#e6e8ea] ${disabled ? 'opacity-50' : ''}`}
      disabled={disabled}
      {...props}
    >
      <Ionicons name={icon} size={20} color="#191c1e" />
      <Text className="text-sm font-medium text-[#191c1e]">{title}</Text>
    </Pressable>
  );
}
