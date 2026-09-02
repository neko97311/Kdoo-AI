import { View } from 'react-native';
import { Skeleton } from '@/components/ui/Skeleton';

interface MessageListSkeletonProps {
  /** Number of fake message bubbles to render. */
  count?: number;
}

/**
 * Skeleton placeholder for the chat message list (ChatView).
 *
 * Renders alternating left/right bubbles to mimic a conversation. Each
 * bubble is a column of 2-3 text lines with varying widths. Kept visually
 * lightweight so the transition to real messages feels instant.
 */
export function MessageListSkeleton({ count = 4 }: MessageListSkeletonProps) {
  return (
    <View className="flex-1 px-4 py-6 gap-6">
      {Array.from({ length: count }).map((_, i) => {
        const isRight = i % 2 === 1;
        return (
          <View
            key={i}
            className={isRight ? 'items-end' : 'items-start'}
          >
            <View className="gap-2 max-w-[75%]">
              <Skeleton className="h-4 rounded-full" />
              <Skeleton
                className={
                  isRight
                    ? 'h-4 w-[85%] rounded-full self-end'
                    : 'h-4 w-[90%] rounded-full'
                }
              />
              {i % 2 === 0 && (
                <Skeleton
                  className={
                    isRight
                      ? 'h-4 w-[60%] rounded-full self-end'
                      : 'h-4 w-[55%] rounded-full'
                  }
                />
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}
