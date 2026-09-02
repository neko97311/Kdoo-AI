# Chat Page Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor `app/(tabs)/index.tsx` from a simple 132-line single-file page into a full-featured chat interface with two states (home/chat), following Stitch designs with light theme colors.

**Architecture:** The page conditionally renders `ChatHome` (no active session) or `ChatView` (active chat session) based on `currentSessionId` from a Zustand chat store. All chat-specific components live in `components/chat/`. A `ChatDrawer` (session list sidebar) is accessible from both states via the header menu button. The design follows the Stitch HTML output using Material Design 3 light theme colors.

**Tech Stack:** React Native, Expo Router, NativeWind (className), Zustand, TypeScript, Ionicons

**Color System (Stitch HTML Light Theme):**

| Token | Hex | NativeWind |
|---|---|---|
| Background/Surface | `#f7f9fb` | `bg-[#f7f9fb]` |
| Primary | `#4648d4` | `bg-[#4648d4]` / `text-[#4648d4]` |
| Surface Container | `#eceef0` | `bg-[#eceef0]` |
| Surface Container Lowest (cards) | `#ffffff` | `bg-white` |
| Surface Container High | `#e6e8ea` | `bg-[#e6e8ea]` |
| On Surface (text) | `#191c1e` | `text-[#191c1e]` |
| On Surface Variant | `#464554` | `text-[#464554]` |
| Outline Variant | `#c7c4d7` | `border-[#c7c4d7]` |
| Outline | `#767586` | `border-[#767586]` |
| Primary Fixed | `#e1e0ff` | `bg-[#e1e0ff]` / `text-[#e1e0ff]` |
| Inverse Surface | `#2d3133` | `bg-[#2d3133]` |
| Inverse On Surface | `#eff1f3` | `text-[#eff1f3]` |
| Secondary | `#8127cf` | `bg-[#8127cf]` / `text-[#8127cf]` |
| Error | `#ba1a1a` | `text-[#ba1a1a]` |

**Spacing Token Mapping (from Stitch tailwind-config):**

| Stitch Token | px | NativeWind |
|---|---|---|
| `unit` | 4px | `gap-1`, `p-1`, `mb-1` |
| `stack-sm` | 8px | `gap-2`, `p-2`, `mb-2` |
| `stack-md` | 16px | `gap-4`, `p-4`, `mb-4` |
| `gutter` | 24px | `gap-6`, `p-6`, `mb-6` |
| `stack-lg` | 32px | `gap-8`, `p-8`, `mb-8` |
| `margin-mobile` | 20px | `px-5` |

---

## Component Architecture

```
app/(tabs)/index.tsx                    ← Page entry (state router)
components/chat/
├── index.ts                            ← Barrel export
├── ChatHome.tsx                        ← No-session home (welcome + action cards)
├── ChatView.tsx                        ← In-session chat main view
├── ChatHeader.tsx                      ← Top bar (menu + title + more)
├── ChatBubble.tsx                      ← Message bubble (AI/user, text/image/code/table)
├── ChatInputBar.tsx                    ← Bottom input bar (+btn/mic/send)
├── ChatDrawer.tsx                      ← Left session list drawer
├── ChatBottomSheet.tsx                 ← Right more-actions bottom sheet
├── CodeBlock.tsx                       ← Code block (lang label + copy btn)
├── DataTable.tsx                        ← Data table component
├── TypingIndicator.tsx                 ← AI typing dots
└── VoiceOverlay.tsx                    ← Voice input animation overlay
stores/
└── chat.ts                             ← Chat Zustand store
types/
└── index.ts                            ← Add chat types (append to existing)
```

---

### Task 1: Chat Types

**Files:**
- Modify: `types/index.ts` (append)

**Step 1: Add chat types to types/index.ts**

Append after the existing `LoginCredentials` interface:

```typescript
// --- Chat Types ---

export interface ChatSession {
  id: string;
  title: string;
  lastMessage?: string;
  updatedAt: Date;
  isPinned?: boolean;
}

export type MessageRole = 'user' | 'assistant';

export type MessageContentType = 'text' | 'image' | 'code' | 'table';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  uri: string;
  alt?: string;
}

export interface CodeContent {
  type: 'code';
  language: string;
  code: string;
}

export interface TableContent {
  type: 'table';
  headers: string[];
  rows: string[][];
  title?: string;
}

export type MessageContent = TextContent | ImageContent | CodeContent | TableContent;

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: MessageContent[];
  createdAt: Date;
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit` (from `projects/app/`)
Expected: No errors

**Step 3: Commit**

```bash
git add types/index.ts
git commit -m "feat: add chat types (session, message, content types)"
```

---

### Task 2: Chat Zustand Store

**Files:**
- Create: `stores/chat.ts`

**Step 1: Create the chat store**

```typescript
import { create } from 'zustand';
import type { ChatSession, ChatMessage } from '@/types';

interface ChatStore {
  sessions: ChatSession[];
  currentSessionId: string | null;
  messages: Record<string, ChatMessage[]>;
  isDrawerOpen: boolean;
  isTyping: boolean;

  // Session actions
  createSession: (title?: string) => string;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  togglePinSession: (id: string) => void;
  setCurrentSession: (id: string | null) => void;

  // Message actions
  addMessage: (sessionId: string, message: Omit<ChatMessage, 'id' | 'createdAt'>) => void;

  // UI actions
  toggleDrawer: () => void;
  setDrawerOpen: (open: boolean) => void;
  setTyping: (typing: boolean) => void;
}

let messageCounter = 0;
let sessionCounter = 0;

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: [
    // Mock data for development
    { id: 's1', title: 'Rio Trip Plan', lastMessage: 'Day 3: Santa Teresa...', updatedAt: new Date(), isPinned: true },
    { id: 's2', title: 'Museum Research', lastMessage: 'Valongo Wharf is...', updatedAt: new Date(), isPinned: true },
    { id: 's3', title: 'AI Art Concepts', lastMessage: 'Generated image of...', updatedAt: new Date(), isPinned: true },
    { id: 's4', title: 'Cooking Recipes', lastMessage: 'Try this pasta...', updatedAt: new Date(), isPinned: false },
    { id: 's5', title: 'Travel Logistics', lastMessage: 'Flight at 8am...', updatedAt: new Date(), isPinned: false },
  ],
  currentSessionId: null,
  messages: {
    // Mock messages for s1 session
    s1: [
      {
        id: 'm1',
        sessionId: 's1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello! I\'m here to help you. How can I assist today? I can create itineraries, generate images, or answer complex questions.' }],
        createdAt: new Date(),
      },
      {
        id: 'm2',
        sessionId: 's1',
        role: 'user',
        content: [{ type: 'text', text: 'Plan a 3-day trip to Rio de Janeiro with a focus on historical sites.' }],
        createdAt: new Date(),
      },
      {
        id: 'm3',
        sessionId: 's1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure! Here is a proposed historical itinerary for Rio:\n\n**Day 1: Historical Center**\nStart at Paço Imperial, visit the Convent of Saint Anthony and the National Library.\n\n**Day 2: Little Africa and Museums**\nExplore Valongo Wharf (UNESCO World Heritage) and the Rio Museum of Art.\n\n**Day 3: Santa Teresa and Lapa Arches**\nTake a tram ride through the slopes of Santa Teresa and end at the iconic Lapa Arches.' },
        ],
        createdAt: new Date(),
      },
    ],
  },
  isDrawerOpen: false,
  isTyping: false,

  createSession: (title?: string) => {
    const id = `s_${++sessionCounter}_${Date.now()}`;
    const session: ChatSession = {
      id,
      title: title || 'New chat',
      updatedAt: new Date(),
      isPinned: false,
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
      messages: { ...state.messages, [id]: [] },
    }));
    return id;
  },

  deleteSession: (id) => {
    set((state) => {
      const { [id]: _, ...remainingMessages } = state.messages;
      return {
        sessions: state.sessions.filter((s) => s.id !== id),
        messages: remainingMessages,
        currentSessionId: state.currentSessionId === id ? null : state.currentSessionId,
      };
    });
  },

  renameSession: (id, title) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, title } : s
      ),
    }));
  },

  togglePinSession: (id) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, isPinned: !s.isPinned } : s
      ),
    }));
  },

  setCurrentSession: (id) => {
    set({ currentSessionId: id });
  },

  addMessage: (sessionId, message) => {
    const fullMessage: ChatMessage = {
      ...message,
      id: `m_${++messageCounter}_${Date.now()}`,
      createdAt: new Date(),
    };
    set((state) => ({
      messages: {
        ...state.messages,
        [sessionId]: [...(state.messages[sessionId] || []), fullMessage],
      },
    }));
  },

  toggleDrawer: () => {
    set((state) => ({ isDrawerOpen: !state.isDrawerOpen }));
  },

  setDrawerOpen: (open) => {
    set({ isDrawerOpen: open });
  },

  setTyping: (typing) => {
    set({ isTyping: typing });
  },
}));
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add stores/chat.ts
git commit -m "feat: add chat Zustand store with session/message management"
```

---

### Task 3: TypingIndicator Component

**Files:**
- Create: `components/chat/TypingIndicator.tsx`

**Step 1: Create TypingIndicator**

```tsx
import { View } from 'react-native';

export function TypingIndicator() {
  return (
    <View className="flex-row items-center gap-1 px-4 py-4">
      <View className="w-2 h-2 rounded-full bg-[#4648d4]/40 animate-bounce" />
      <View className="w-2 h-2 rounded-full bg-[#4648d4]/70 animate-bounce" style={{ animationDelay: '0.2s' }} />
      <View className="w-2 h-2 rounded-full bg-[#4648d4] animate-bounce" style={{ animationDelay: '0.4s' }} />
    </View>
  );
}
```

**Step 2: Commit**

```bash
git add components/chat/TypingIndicator.tsx
git commit -m "feat: add TypingIndicator component"
```

---

### Task 4: CodeBlock Component

**Files:**
- Create: `components/chat/CodeBlock.tsx`

**Step 1: Create CodeBlock**

```tsx
import { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface CodeBlockProps {
  language: string;
  code: string;
}

export function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    // TODO: Use Clipboard API when available
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View className="bg-[#2d3133] rounded-lg overflow-hidden">
      {/* Header */}
      <View className="flex-row justify-between items-center px-3 py-1.5 bg-[#2d3133]/80 border-b border-[#c7c4d7]/20">
        <Text className="text-[#eff1f3] text-xs font-medium">{language}</Text>
        <Pressable onPress={handleCopy}>
          <Text className="text-[#eff1f3] text-xs font-medium">
            {copied ? 'Copied!' : 'Copy'}
          </Text>
        </Pressable>
      </View>
      {/* Code */}
      <View className="p-3">
        <Text className="text-[#eff1f3] font-mono text-sm" selectable>
          {code}
        </Text>
      </View>
    </View>
  );
}
```

**Step 2: Commit**

```bash
git add components/chat/CodeBlock.tsx
git commit -m "feat: add CodeBlock component with copy button"
```

---

### Task 5: DataTable Component

**Files:**
- Create: `components/chat/DataTable.tsx`

**Step 1: Create DataTable**

```tsx
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
        <Text className="text-base font-bold text-[#191c1e] mb-2">{title}</Text>
      ) : null}
      <View className="rounded-lg border border-[#c7c4d7]/30 overflow-hidden">
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="min-w-full">
            {/* Header Row */}
            <View className="flex-row bg-[#e6e8ea] border-b border-[#c7c4d7]/30">
              {headers.map((header, i) => (
                <View
                  key={i}
                  className="py-2 px-3 flex-1"
                  style={{ minWidth: 80 }}
                >
                  <Text className="text-sm font-medium text-[#191c1e]">
                    {header}
                  </Text>
                </View>
              ))}
            </View>
            {/* Data Rows */}
            {rows.map((row, rowIdx) => (
              <View
                key={rowIdx}
                className={`flex-row ${rowIdx < rows.length - 1 ? 'border-b border-[#c7c4d7]/30' : ''}`}
              >
                {row.map((cell, cellIdx) => (
                  <View
                    key={cellIdx}
                    className="py-2 px-3 flex-1"
                    style={{ minWidth: 80 }}
                  >
                    <Text className="text-base text-[#191c1e]">{cell}</Text>
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
```

**Step 2: Commit**

```bash
git add components/chat/DataTable.tsx
git commit -m "feat: add DataTable component for chat messages"
```

---

### Task 6: ChatBubble Component

**Files:**
- Create: `components/chat/ChatBubble.tsx`

**Step 1: Create ChatBubble**

This is the core component that renders AI or user message bubbles with different content types.

```tsx
import { View, Text, Pressable, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ChatMessage, MessageContent } from '@/types';
import { CodeBlock } from './CodeBlock';
import { DataTable } from './DataTable';

interface ChatBubbleProps {
  message: ChatMessage;
  isLast?: boolean;
}

function renderContent(content: MessageContent[]) {
  return content.map((item, idx) => {
    const isLast = idx === content.length - 1;
    switch (item.type) {
      case 'text':
        return (
          <Text
            key={idx}
            className={`text-base text-[#191c1e] leading-6 ${!isLast ? 'mb-2' : ''}`}
            selectable
          >
            {item.text}
          </Text>
        );
      case 'image':
        return (
          <Image
            key={idx}
            source={{ uri: item.uri }}
            className={`rounded-xl ${!isLast ? 'mb-2' : ''}`}
            style={{ width: '100%', aspectRatio: 1 }}
            resizeMode="cover"
            accessibilityLabel={item.alt}
          />
        );
      case 'code':
        return (
          <View key={idx} className={`${!isLast ? 'mb-2' : ''}`}>
            <CodeBlock language={item.language} code={item.code} />
          </View>
        );
      case 'table':
        return (
          <View key={idx} className={`${!isLast ? 'mb-2' : ''}`}>
            <DataTable headers={item.headers} rows={item.rows} title={item.title} />
          </View>
        );
    }
  });
}

export function ChatBubble({ message, isLast }: ChatBubbleProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <View className="flex flex-col items-end gap-2 self-end max-w-[85%]">
        <View className="bg-[#4648d4] shadow-md rounded-2xl px-4 py-3"
          style={{ borderBottomRightRadius: 4 }}
        >
          {renderContent(message.content)}
        </View>
        {message.createdAt && (
          <Text className="text-xs text-[#464554] mr-2">
            {message.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}
      </View>
    );
  }

  // AI message
  return (
    <View className="flex flex-col items-start gap-2 max-w-[85%]">
      {/* AI Avatar */}
      <View className="flex-row items-center gap-2 mb-1">
        <View className="w-8 h-8 rounded-full bg-[#4648d4] items-center justify-center">
          <Ionicons name="sparkles" size={16} color="#ffffff" />
        </View>
      </View>
      {/* Bubble */}
      <View className="bg-[#eceef0] shadow-sm border border-[#c7c4d7]/30 rounded-2xl px-4 py-3"
        style={{ borderBottomLeftRadius: 4 }}
      >
        {renderContent(message.content)}
      </View>
      {/* Action buttons */}
      <View className="flex-row gap-1 ml-2">
        <Pressable className="p-2 rounded-full">
          <Ionicons name="volume-high-outline" size={18} color="#464554" />
        </Pressable>
        <Pressable className="p-2 rounded-full">
          <Ionicons name="copy-outline" size={18} color="#464554" />
        </Pressable>
      </View>
    </View>
  );
}
```

**Step 2: Commit**

```bash
git add components/chat/ChatBubble.tsx
git commit -m "feat: add ChatBubble component supporting text/image/code/table"
```

---

### Task 7: VoiceOverlay Component

**Files:**
- Create: `components/chat/VoiceOverlay.tsx`

**Step 1: Create VoiceOverlay**

```tsx
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface VoiceOverlayProps {
  visible: boolean;
  onClose: () => void;
}

export function VoiceOverlay({ visible, onClose }: VoiceOverlayProps) {
  if (!visible) return null;

  return (
    <View className="absolute inset-0 bg-white rounded-[28px] flex-row items-center justify-center gap-6 z-10">
      {/* Wave bars - static visual placeholder; animate with react-native-reanimated later */}
      <View className="flex-row items-center gap-1">
        {[20, 32, 24, 36, 20].map((h, i) => (
          <View
            key={i}
            className="w-[3px] bg-[#4648d4] rounded-full"
            style={{ height: h }}
          />
        ))}
      </View>
      <Text className="text-sm font-medium text-[#4648d4] animate-pulse">
        Listening...
      </Text>
      <Pressable
        className="absolute right-4 w-8 h-8 items-center justify-center rounded-full"
        onPress={onClose}
      >
        <Ionicons name="close" size={20} color="#464554" />
      </Pressable>
    </View>
  );
}
```

**Step 2: Commit**

```bash
git add components/chat/VoiceOverlay.tsx
git commit -m "feat: add VoiceOverlay component"
```

---

### Task 8: ChatInputBar Component

**Files:**
- Create: `components/chat/ChatInputBar.tsx`

**Step 1: Create ChatInputBar**

Based on Stitch HTML: fixed bottom input with rounded-[28px] container, textarea, +button, mic button, send button.

```tsx
import { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { VoiceOverlay } from './VoiceOverlay';

interface ChatInputBarProps {
  onSend: (text: string) => void;
}

export function ChatInputBar({ onSend }: ChatInputBarProps) {
  const [inputText, setInputText] = useState('');
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const hasText = inputText.trim().length > 0;

  const handleSend = () => {
    if (!hasText) return;
    onSend(inputText.trim());
    setInputText('');
  };

  const toggleActions = () => {
    setIsActionsOpen(!isActionsOpen);
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="bg-[#f7f9fb] px-4 pt-2 pb-1"
    >
      <View className="max-w-[1200px] mx-auto relative">
        {/* Expanded Actions Menu */}
        {isActionsOpen && (
          <View className="absolute bottom-full left-0 mb-4 bg-white rounded-2xl shadow-xl border border-[#c7c4d7]/30 p-2 min-w-[160px] z-20">
            <Pressable className="flex-row items-center gap-3 px-4 py-3 rounded-xl active:bg-[#f2f4f6]">
              <Ionicons name="image-outline" size={20} color="#4648d4" />
              <Text className="text-sm font-medium text-[#191c1e]">Images</Text>
            </Pressable>
            <Pressable className="flex-row items-center gap-3 px-4 py-3 rounded-xl active:bg-[#f2f4f6]">
              <Ionicons name="document-text-outline" size={20} color="#4648d4" />
              <Text className="text-sm font-medium text-[#191c1e]">Files</Text>
            </Pressable>
          </View>
        )}

        {/* Voice Overlay */}
        <VoiceOverlay
          visible={isVoiceActive}
          onClose={() => setIsVoiceActive(false)}
        />

        {/* Input Container */}
        <View className="bg-white border border-[#c7c4d7]/50 shadow-lg rounded-[28px] py-2">
          <View className="flex-col w-full gap-2 p-1">
            <TextInput
              className="w-full px-4 py-2 text-base text-[#191c1e]"
              placeholder="Type your message..."
              placeholderTextColor="#767586"
              value={inputText}
              onChangeText={setInputText}
              multiline
              style={{ maxHeight: 200, minHeight: 40 }}
            />
            <View className="flex-row items-center justify-between px-2 pb-1">
              <View className="flex-row items-center gap-1">
                {/* + button */}
                <Pressable
                  className="w-10 h-10 items-center justify-center rounded-full bg-[#e6e8ea] active:scale-90"
                  onPress={toggleActions}
                >
                  <Ionicons
                    name={isActionsOpen ? 'close' : 'add'}
                    size={20}
                    color="#191c1e"
                  />
                </Pressable>
                {/* Mic button */}
                <Pressable
                  className="w-10 h-10 items-center justify-center rounded-full bg-[#e1e0ff] active:scale-95"
                  onPress={() => setIsVoiceActive(true)}
                >
                  <Ionicons name="mic" size={20} color="#4648d4" />
                </Pressable>
              </View>
              {/* Send button */}
              <Pressable
                onPress={handleSend}
                disabled={!hasText}
                className={`w-10 h-10 rounded-full items-center justify-center shadow-sm active:scale-95 ${
                  hasText ? 'bg-[#4648d4]' : 'bg-[#4648d4]/40'
                }`}
              >
                <Ionicons name="arrow-up" size={20} color="white" />
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
```

**Step 2: Commit**

```bash
git add components/chat/ChatInputBar.tsx
git commit -m "feat: add ChatInputBar component with actions menu and voice"
```

---

### Task 9: ChatHeader Component

**Files:**
- Create: `components/chat/ChatHeader.tsx`

**Step 1: Create ChatHeader**

```tsx
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface ChatHeaderProps {
  onMenuPress: () => void;
  onMorePress: () => void;
  title?: string;
}

export function ChatHeader({ onMenuPress, onMorePress, title = 'KDOO AI' }: ChatHeaderProps) {
  return (
    <View className="flex-row justify-between items-center px-4 h-14 bg-[#f7f9fb]/85 border-b border-[#c7c4d7]/10">
      <Pressable
        className="p-2 rounded-full active:opacity-70"
        onPress={onMenuPress}
      >
        <Ionicons name="menu" size={24} color="#4648d4" />
      </Pressable>
      <Text className="text-xl font-bold text-[#191c1e]">{title}</Text>
      <Pressable
        className="p-2 rounded-full active:opacity-70"
        onPress={onMorePress}
      >
        <Ionicons name="ellipsis-vertical" size={24} color="#464554" />
      </Pressable>
    </View>
  );
}
```

**Step 2: Commit**

```bash
git add components/chat/ChatHeader.tsx
git commit -m "feat: add ChatHeader component"
```

---

### Task 10: ChatDrawer Component

**Files:**
- Create: `components/chat/ChatDrawer.tsx`

**Step 1: Create ChatDrawer**

Left side drawer with session list, search, "New chat" button. Animated slide from left.

```tsx
import { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useChatStore } from '@/stores/chat';

interface ChatDrawerProps {
  visible: boolean;
  onClose: () => void;
}

export function ChatDrawer({ visible, onClose }: ChatDrawerProps) {
  const { sessions, currentSessionId, setCurrentSession, createSession } = useChatStore();
  const [searchText, setSearchText] = useState('');

  const pinnedSessions = sessions.filter((s) => s.isPinned);
  const recentSessions = sessions.filter((s) => !s.isPinned);

  const filteredPinned = pinnedSessions.filter((s) =>
    s.title.toLowerCase().includes(searchText.toLowerCase())
  );
  const filteredRecent = recentSessions.filter((s) =>
    s.title.toLowerCase().includes(searchText.toLowerCase())
  );

  const handleNewChat = () => {
    createSession();
    onClose();
  };

  const handleSelectSession = (id: string) => {
    setCurrentSession(id);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      {/* Backdrop */}
      <Pressable className="flex-1 bg-black/50" onPress={onClose} />

      {/* Drawer */}
      <View className="absolute top-0 left-0 h-full w-[280px] bg-[#eceef0] shadow-xl">
        <View className="p-4 flex-col gap-6">
          {/* Search */}
          <View className="relative">
            <Ionicons
              name="search"
              size={20}
              color="#464554"
              style={{ position: 'absolute', left: 12, top: 12 }}
            />
            <TextInput
              className="w-full pl-10 pr-4 py-3 bg-[#e6e8ea] rounded-full text-base text-[#191c1e]"
              placeholder="Search chats"
              placeholderTextColor="#767586"
              value={searchText}
              onChangeText={setSearchText}
            />
          </View>

          {/* New Chat */}
          <Pressable
            className="flex-row items-center gap-3 px-4 py-2 rounded-xl active:bg-[#c7c4d7]/20"
            onPress={handleNewChat}
          >
            <Ionicons name="create" size={20} color="#191c1e" />
            <Text className="text-sm font-medium text-[#191c1e]">New chat</Text>
          </Pressable>

          {/* Session List */}
          <ScrollView showsVerticalScrollIndicator={false} className="max-h-[70%]">
            {/* Pinned */}
            {filteredPinned.length > 0 && (
              <View className="mb-4">
                <Text className="text-xs font-semibold text-[#464554] uppercase tracking-wider px-4 py-2">
                  Pinned
                </Text>
                {filteredPinned.map((session) => (
                  <Pressable
                    key={session.id}
                    className={`flex-row items-center justify-between px-4 py-3 rounded-xl ${
                      session.id === currentSessionId ? 'bg-[#e1e0ff]' : 'active:bg-[#c7c4d7]/20'
                    }`}
                    onPress={() => handleSelectSession(session.id)}
                  >
                    <Text
                      className="text-base text-[#191c1e] flex-1 pr-2"
                      numberOfLines={1}
                    >
                      {session.title}
                    </Text>
                    <Ionicons name="pin" size={16} color="#4648d4" />
                  </Pressable>
                ))}
              </View>
            )}

            {/* Recent */}
            {filteredRecent.length > 0 && (
              <View>
                <Text className="text-xs font-semibold text-[#464554] uppercase tracking-wider px-4 py-2">
                  Recent
                </Text>
                {filteredRecent.map((session) => (
                  <Pressable
                    key={session.id}
                    className={`flex-row items-center px-4 py-3 rounded-xl ${
                      session.id === currentSessionId ? 'bg-[#e1e0ff]' : 'active:bg-[#c7c4d7]/20'
                    }`}
                    onPress={() => handleSelectSession(session.id)}
                  >
                    <Text
                      className="text-base text-[#191c1e] flex-1 pr-2"
                      numberOfLines={1}
                    >
                      {session.title}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
```

**Step 2: Commit**

```bash
git add components/chat/ChatDrawer.tsx
git commit -m "feat: add ChatDrawer component with session list"
```

---

### Task 11: ChatBottomSheet Component

**Files:**
- Create: `components/chat/ChatBottomSheet.tsx`

**Step 1: Create ChatBottomSheet**

```tsx
import { View, Text, Pressable, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface ChatBottomSheetProps {
  visible: boolean;
  onClose: () => void;
  onPin?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}

export function ChatBottomSheet({
  visible,
  onClose,
  onPin,
  onRename,
  onDelete,
}: ChatBottomSheetProps) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      {/* Backdrop */}
      <Pressable className="flex-1 bg-black/50" onPress={onClose} />

      {/* Sheet */}
      <View className="absolute bottom-0 left-0 right-0 bg-[#f7f9fb] rounded-t-[28px] shadow-2xl pb-8">
        {/* Handle */}
        <View className="w-full items-center py-4">
          <View className="w-10 h-1 rounded-full bg-[#c7c4d7]" />
        </View>

        <View className="px-4 gap-1">
          <Pressable
            className="flex-row items-center gap-4 px-4 py-4 rounded-2xl active:bg-[#e6e8ea]"
            onPress={() => { onPin?.(); onClose(); }}
          >
            <Ionicons name="pin-outline" size={20} color="#464554" />
            <Text className="text-sm font-medium text-[#191c1e]">Pin</Text>
          </Pressable>

          <Pressable
            className="flex-row items-center gap-4 px-4 py-4 rounded-2xl active:bg-[#e6e8ea]"
            onPress={() => { onRename?.(); onClose(); }}
          >
            <Ionicons name="create-outline" size={20} color="#464554" />
            <Text className="text-sm font-medium text-[#191c1e]">Rename</Text>
          </Pressable>

          <Pressable
            className="flex-row items-center gap-4 px-4 py-4 rounded-2xl active:bg-[#ba1a1a]/5"
            onPress={() => { onDelete?.(); onClose(); }}
          >
            <Ionicons name="trash-outline" size={20} color="#ba1a1a" />
            <Text className="text-sm font-medium text-[#ba1a1a]">Delete</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
```

**Step 2: Commit**

```bash
git add components/chat/ChatBottomSheet.tsx
git commit -m "feat: add ChatBottomSheet component"
```

---

### Task 12: ChatHome Component

**Files:**
- Create: `components/chat/ChatHome.tsx`

**Step 1: Create ChatHome**

No-session state: gradient welcome title + action cards.

```tsx
import { View, Text, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ChatHeader } from './ChatHeader';

interface ActionCard {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  iconBg: string;
  iconColor: string;
}

const actionCards: ActionCard[] = [
  {
    icon: 'sparkles',
    label: 'Plan a 3-day trip to Rio de Janeiro',
    iconBg: 'bg-[#4648d4]/10',
    iconColor: '#4648d4',
  },
  {
    icon: 'image',
    label: 'Create an image of an astronaut dog',
    iconBg: 'bg-[#8127cf]/10',
    iconColor: '#8127cf',
  },
];

interface ChatHomeProps {
  onMenuPress: () => void;
  onMorePress: () => void;
  onActionPress: (label: string) => void;
}

export function ChatHome({ onMenuPress, onMorePress, onActionPress }: ChatHomeProps) {
  return (
    <View className="flex-1 bg-[#f7f9fb]">
      <ChatHeader onMenuPress={onMenuPress} onMorePress={onMorePress} />

      {/* Main Content */}
      <View className="flex-1 pt-8 px-6 pb-32 max-w-[600px] mx-auto w-full">
        {/* Welcome Section */}
        <View className="mb-8">
          <Text className="text-5xl font-bold text-[#191c1e] leading-tight">
            Hello,{'\n'}
            <Text className="text-[#4648d4]">how can I help you?</Text>
          </Text>
        </View>

        {/* Action Cards */}
        <View className="gap-4">
          {actionCards.map((card, idx) => (
            <Pressable
              key={idx}
              className="bg-white border border-[#c7c4d7]/30 rounded-xl p-6 shadow-sm flex-row items-center gap-6 active:shadow-md"
              onPress={() => onActionPress(card.label)}
            >
              <View className={`w-12 h-12 rounded-full ${card.iconBg} items-center justify-center`}>
                <Ionicons name={card.icon} size={24} color={card.iconColor} />
              </View>
              <Text className="text-base text-[#191c1e] flex-1">
                {card.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}
```

**Step 2: Commit**

```bash
git add components/chat/ChatHome.tsx
git commit -m "feat: add ChatHome component (no-session state)"
```

---

### Task 13: ChatView Component

**Files:**
- Create: `components/chat/ChatView.tsx`

**Step 1: Create ChatView**

In-session state: header + scrollable message list + input bar.

```tsx
import { useRef } from 'react';
import { View, ScrollView } from 'react-native';
import { useChatStore } from '@/stores/chat';
import { ChatHeader } from './ChatHeader';
import { ChatBubble } from './ChatBubble';
import { ChatInputBar } from './ChatInputBar';
import { TypingIndicator } from './TypingIndicator';

interface ChatViewProps {
  onMenuPress: () => void;
  onMorePress: () => void;
}

export function ChatView({ onMenuPress, onMorePress }: ChatViewProps) {
  const { currentSessionId, messages, isTyping, addMessage, createSession } = useChatStore();
  const scrollViewRef = useRef<ScrollView>(null);

  const sessionMessages = currentSessionId ? messages[currentSessionId] || [] : [];

  const handleSend = (text: string) => {
    if (!currentSessionId) return;

    addMessage(currentSessionId, {
      sessionId: currentSessionId,
      role: 'user',
      content: [{ type: 'text', text }],
    });

    // TODO: Call AI API, for now add mock response
    setTimeout(() => {
      addMessage(currentSessionId, {
        sessionId: currentSessionId,
        role: 'assistant',
        content: [{ type: 'text', text: 'I received your message. This is a placeholder response.' }],
      });
    }, 1000);
  };

  return (
    <View className="flex-1 bg-[#f7f9fb]">
      <ChatHeader onMenuPress={onMenuPress} onMorePress={onMorePress} />

      {/* Chat Messages */}
      <ScrollView
        ref={scrollViewRef}
        className="flex-1 px-4 pt-4 pb-24"
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
      >
        <View className="gap-6 py-8">
          {sessionMessages.map((msg) => (
            <ChatBubble key={msg.id} message={msg} />
          ))}
          {isTyping && <TypingIndicator />}
        </View>
      </ScrollView>

      {/* Input Bar */}
      <ChatInputBar onSend={handleSend} />
    </View>
  );
}
```

**Step 2: Commit**

```bash
git add components/chat/ChatView.tsx
git commit -m "feat: add ChatView component (in-session state)"
```

---

### Task 14: Barrel Export + Main Page Rewrite

**Files:**
- Create: `components/chat/index.ts`
- Modify: `app/(tabs)/index.tsx` (full rewrite)

**Step 1: Create barrel export**

```typescript
export { ChatHome } from './ChatHome';
export { ChatView } from './ChatView';
export { ChatHeader } from './ChatHeader';
export { ChatBubble } from './ChatBubble';
export { ChatInputBar } from './ChatInputBar';
export { ChatDrawer } from './ChatDrawer';
export { ChatBottomSheet } from './ChatBottomSheet';
export { CodeBlock } from './CodeBlock';
export { DataTable } from './DataTable';
export { TypingIndicator } from './TypingIndicator';
export { VoiceOverlay } from './VoiceOverlay';
```

**Step 2: Rewrite index.tsx**

```tsx
import { useState } from 'react';
import { View } from 'react-native';
import { useChatStore } from '@/stores/chat';
import { ChatHome } from '@/components/chat/ChatHome';
import { ChatView } from '@/components/chat/ChatView';
import { ChatDrawer } from '@/components/chat/ChatDrawer';
import { ChatBottomSheet } from '@/components/chat/ChatBottomSheet';

export default function HomeScreen() {
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isBottomSheetOpen, setIsBottomSheetOpen] = useState(false);

  return (
    <View className="flex-1 bg-[#f7f9fb]">
      {currentSessionId ? (
        <ChatView
          onMenuPress={() => setIsDrawerOpen(true)}
          onMorePress={() => setIsBottomSheetOpen(true)}
        />
      ) : (
        <ChatHome
          onMenuPress={() => setIsDrawerOpen(true)}
          onMorePress={() => setIsBottomSheetOpen(true)}
          onActionPress={(label) => {
            // Create a new session with the action label as first message
            const id = useChatStore.getState().createSession(label);
            useChatStore.getState().addMessage(id, {
              sessionId: id,
              role: 'user',
              content: [{ type: 'text', text: label }],
            });
          }}
        />
      )}

      <ChatDrawer
        visible={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
      />

      <ChatBottomSheet
        visible={isBottomSheetOpen}
        onClose={() => setIsBottomSheetOpen(false)}
      />
    </View>
  );
}
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Verify no forbidden patterns**

Check:
- No `StyleSheet.create`
- No `SafeAreaView`
- No `TouchableOpacity`
- No `react-navigation` imports
- All text wrapped in `<Text>`
- All `<Image>` have dimensions

**Step 5: Commit**

```bash
git add components/chat/index.ts app/(tabs)/index.tsx
git commit -m "feat: rewrite index.tsx with ChatHome/ChatView state routing + barrel exports"
```

---

### Task 15: Update Tab Layout for Light Theme Consistency

**Files:**
- Modify: `app/(tabs)/_layout.tsx`

**Step 1: Update tab layout to match light theme**

The tab bar needs to match the Stitch light theme instead of the current dark header style.

```tsx
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#4648d4',
        tabBarInactiveTintColor: '#767586',
        tabBarStyle: {
          borderTopWidth: 1,
          borderTopColor: '#c7c4d7',
          backgroundColor: '#f7f9fb',
        },
        headerStyle: {
          backgroundColor: '#f7f9fb',
        },
        headerTintColor: '#191c1e',
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '发现',
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="compass-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="favorites"
        options={{
          title: '收藏',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="star-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: '我的',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
```

**Step 2: Commit**

```bash
git add app/(tabs)/_layout.tsx
git commit -m "feat: update tab layout to light theme matching Stitch design"
```

---

## Summary

| Task | Component | Type |
|---|---|---|
| 1 | Types | Modify types/index.ts |
| 2 | Store | Create stores/chat.ts |
| 3 | TypingIndicator | Create components/chat/TypingIndicator.tsx |
| 4 | CodeBlock | Create components/chat/CodeBlock.tsx |
| 5 | DataTable | Create components/chat/DataTable.tsx |
| 6 | ChatBubble | Create components/chat/ChatBubble.tsx |
| 7 | VoiceOverlay | Create components/chat/VoiceOverlay.tsx |
| 8 | ChatInputBar | Create components/chat/ChatInputBar.tsx |
| 9 | ChatHeader | Create components/chat/ChatHeader.tsx |
| 10 | ChatDrawer | Create components/chat/ChatDrawer.tsx |
| 11 | ChatBottomSheet | Create components/chat/ChatBottomSheet.tsx |
| 12 | ChatHome | Create components/chat/ChatHome.tsx |
| 13 | ChatView | Create components/chat/ChatView.tsx |
| 14 | Barrel + Page | Create index.ts, rewrite index.tsx |
| 15 | Tab Layout | Modify _layout.tsx for light theme |

**Parallelizable groups:**
- Tasks 3-11 can all be implemented in parallel (independent components)
- Tasks 12-13 depend on 6, 8, 9 (ChatBubble, ChatInputBar, ChatHeader)
- Task 14 depends on all above
- Task 15 is independent
