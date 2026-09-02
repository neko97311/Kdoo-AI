import { View, Text, ScrollView } from 'react-native';

interface DataTableProps {
  headers: string[];
  rows: string[][];
  title?: string;
}

export function DataTable({ headers, rows, title }: DataTableProps) {
  return (
    <View className="w-full">
      {title ? (
        <Text className="text-body-md font-bold text-aura-on-surface mb-2">{title}</Text>
      ) : null}
      <View className="rounded-card border border-aura-outline-variant/50 overflow-hidden">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="min-w-full">
            <View className="flex-row bg-aura-surface-container border-b border-aura-outline-variant/50">
              {headers.map((header, i) => (
                <View
                  key={i}
                  className="py-2 px-3 flex-1"
                  style={{ minWidth: 80 }}
                >
                  <Text className="text-label-sm font-medium text-aura-on-surface">
                    {header}
                  </Text>
                </View>
              ))}
            </View>
            {rows.map((row, rowIdx) => (
              <View
                key={rowIdx}
                className={`flex-row ${rowIdx < rows.length - 1 ? 'border-b border-aura-outline-variant/50' : ''}`}
              >
                {row.map((cell, cellIdx) => (
                  <View
                    key={cellIdx}
                    className="py-2 px-3 flex-1"
                    style={{ minWidth: 80 }}
                  >
                    <Text className="text-body-md text-aura-on-surface">{cell}</Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}
