import { Pressable, Text, type PressableProps } from 'react-native';

interface ButtonProps extends PressableProps {
  title: string;
  variant?: 'primary' | 'secondary' | 'outline';
  loading?: boolean;
}

export function Button({
  title,
  variant = 'primary',
  loading = false,
  disabled,
  ...props
}: ButtonProps) {
  const baseClasses = 'py-3 px-6 rounded-xl items-center justify-center flex-row';

  const variantClasses = {
    primary: 'bg-blue-500 active:bg-blue-600',
    secondary: 'bg-purple-500 active:bg-purple-600',
    outline: 'bg-transparent border-2 border-blue-500 active:bg-blue-50',
  };

  const textClasses = {
    primary: 'text-white font-semibold text-base',
    secondary: 'text-white font-semibold text-base',
    outline: 'text-blue-500 font-semibold text-base',
  };

  return (
    <Pressable
      className={`${baseClasses} ${variantClasses[variant]} ${disabled || loading ? 'opacity-50' : ''}`}
      disabled={disabled || loading}
      {...props}
    >
      <Text className={textClasses[variant]}>{loading ? 'Loading...' : title}</Text>
    </Pressable>
  );
}
