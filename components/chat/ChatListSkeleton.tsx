import { View } from 'react-native';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Skeleton placeholder for the chat session list (ChatDrawer).
 *
 * Mirrors the layout of a real session row (px-4 py-3) so the visual
 * swap from skeleton → real data is jitter-free. Each row shows a title
 * bar plus an occasional subtitle bar to mimic the optional lastMessage.
 */
export function ChatListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <View className="mt-2">
      {Array.from({ length: rows }).map((_, i) => (
        <View
          key={i}
          className="flex-row items-center px-4 py-3"
          style={{ minHeight: 44 }}
        >
          <View className="flex-1 pr-2 gap-1.5">
            {/* Title bar — width varies slightly per row for a natural look */}
            <Skeleton
              className={i % 3 === 0 ? 'h-4 w-1/2 rounded-full' : 'h-4 w-3/4 rounded-full'}
            />
            {/* Subtitle bar — only on some rows, mimics optional lastMessage */}
            {i % 2 === 0 && (
              <Skeleton className="h-3 w-2/5 rounded-full" />
            )}
          </View>
        </View>
      ))}
    </View>
  );
}
