# kdoo-client

基于 Expo SDK 56 的 React Native 生产级脚手架，开箱即用的文件路由、认证流程、状态管理和 UI 组件库。

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Expo SDK | 56 | 核心框架 |
| Expo Router | v4 | 文件路由 + 深度链接 |
| TypeScript | 5.x | 类型安全 |
| NativeWind | v4 | Tailwind CSS 样式方案 |
| Tailwind CSS | v3 | 原子化 CSS |
| Zustand | 5.x | 状态管理 |
| AsyncStorage | — | 本地持久化存储 |

## 快速开始

### 环境要求

- Node.js 18+
- npm 或 pnpm
- iOS 模拟器（需 Xcode）或 Android 模拟器，用于原生调试
- Expo Go App，用于真机调试

### 安装与运行

```bash
# 克隆项目
git clone <repo-url> mobile_native
cd mobile_native

# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，设置 EXPO_PUBLIC_API_URL

# 启动开发服务器
pnpm dev

# 指定平台启动
pnpm ios       # iOS 模拟器
pnpm android    # Android 模拟器
pnpm web        # 浏览器
```

启动后会自动打开 Expo Dev Tools。扫码即可在真机上通过 Expo Go 预览。

## 项目结构

```
mobile_native/
├── app/                        # Expo Router 页面（文件路由）
│   ├── _layout.tsx             # 根布局：Auth 保护逻辑 + NativeWind CSS 导入
│   ├── +not-found.tsx          # 404 页面
│   ├── (auth)/                 # 未认证路由组
│   │   ├── _layout.tsx         # Auth Stack 布局
│   │   └── login.tsx           # 登录页
│   └── (tabs)/                 # 已认证路由组（Tab 导航）
│       ├── _layout.tsx         # Tab Bar 布局（Home + Profile）
│       ├── index.tsx           # 首页
│       └── profile.tsx         # 个人中心
├── components/ui/              # 通用 UI 组件
│   ├── Button.tsx              # 按钮（primary/secondary/outline，loading 状态）
│   ├── Input.tsx               # 输入框（label + error 展示）
│   ├── Loading.tsx             # 加载指示器（fullScreen 模式）
│   └── index.ts                # Barrel export
├── constants/
│   └── Colors.ts               # 主题色常量（primary, secondary, background 等）
├── hooks/
│   └── useAuth.ts              # 认证 Hook（login/logout/initialize）
├── services/
│   └── api.ts                  # HTTP 请求层（自动 Bearer token 注入）
├── stores/
│   └── auth.ts                 # Zustand Auth Store（AsyncStorage 持久化，mock login）
├── types/
│   └── index.ts                # TypeScript 类型定义
├── global.css                  # Tailwind CSS 入口
├── tailwind.config.js          # NativeWind preset + content paths
├── babel.config.js             # jsxImportSource + nativewind/babel 插件
├── metro.config.js             # withNativeWind 包装器
├── nativewind-env.d.ts         # TypeScript className 类型声明
├── app.json                    # Expo 配置（typedRoutes, deep linking）
└── tsconfig.json               # 严格模式 + @/* 路径别名
```

## 核心功能详解

### 路由系统

项目使用 Expo Router v4 的文件路由方案，页面路径由 `app/` 目录下的文件结构自动生成。

**Route Groups（路由组）**

括号目录 `(auth)` 和 `(tabs)` 是路由组，不会出现在实际 URL 中，用于组织页面和共享布局：

- `(auth)/` — 未登录用户看到的页面，当前包含登录页
- `(tabs)/` — 已登录用户看到的 Tab 导航页面，包含首页和个人中心

**Stack.Protected 认证保护**

根布局 `_layout.tsx` 中使用 `Stack.Protected` 实现路由守卫：

```tsx
<Stack.Protected guard={isAuthenticated}>
  <Stack.Screen name="(tabs)" />
</Stack.Protected>
<Stack.Protected guard={!isAuthenticated}>
  <Stack.Screen name="(auth)" />
</Stack.Protected>
```

当 `isAuthenticated` 为 `true` 时，`(tabs)` 路由组可见；为 `false` 时，`(auth)` 路由组可见。框架会自动处理重定向，未授权用户无法通过手动输入 URL 访问受保护页面。

**类型安全路由**

`app.json` 中开启了 `experiments.typedRoutes: true`，`Link` 和 `href` 会有 TypeScript 类型检查，拼错路由名会在编译期报错。

### 认证流程

```
App 启动
  │
  ▼
useAuthStore.initialize()
  │
  ├─ AsyncStorage 中有 token
  │     │
  │     ▼
  │   isAuthenticated = true
  │     │
  │     ▼
  │   Stack.Protected 展示 (tabs) 路由组
  │   用户进入首页
  │
  └─ AsyncStorage 中无 token
        │
        ▼
      isAuthenticated = false
        │
        ▼
      Stack.Protected 展示 (auth) 路由组
      用户进入登录页

登录（当前为 mock）
  │
  ▼
写入 token 到 AsyncStorage
isAuthenticated = true
  │
  ▼
自动跳转到 (tabs) 首页

登出
  │
  ▼
清除 AsyncStorage
isAuthenticated = false
  │
  ▼
自动跳转到 (auth)/login
```

**关键实现：**

- `stores/auth.ts` — Zustand store，管理 `token`、`isAuthenticated`、`user` 等状态
- `hooks/useAuth.ts` — 封装 `login`、`logout`、`initialize` 方法，供组件调用
- `initialize()` 在根布局挂载时调用，从 AsyncStorage 恢复登录态
- 当前登录为 mock 实现，替换为真实 API 只需修改 store 中的 `login` 方法

### 状态管理

使用 Zustand 作为状态管理方案，轻量且不需要 Provider 包裹。

**Auth Store 结构（`stores/auth.ts`）：**

```ts
interface AuthState {
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  login: (credentials: LoginCredentials) => Promise<void>;
  logout: () => Promise<void>;
  initialize: () => Promise<void>;
}
```

**AsyncStorage 持久化：**

token 和 user 信息通过 `zustand/middleware` 的 `persist` 中间件自动同步到 AsyncStorage。App 重启后，`initialize()` 从 AsyncStorage 读取数据，恢复登录态。

### 网络请求

**API 层（`services/api.ts`）：**

- 基础 URL 来自环境变量 `EXPO_PUBLIC_API_URL`，默认 `https://api.example.com`
- 每次请求自动从 AsyncStorage 读取 token，注入 `Authorization: Bearer <token>` 头
- 泛型方法，返回类型安全的数据：

```ts
import { api } from '@/services/api';

// GET 请求
const data = await api.get<User[]>('/users');

// POST 请求
const result = await api.post<AuthResponse>('/auth/login', {
  email: 'test@example.com',
  password: '123456',
});

// PUT 请求
const updated = await api.put<User>('/users/1', { name: 'New Name' });

// DELETE 请求
await api.delete('/users/1');
```

### 样式系统

项目使用 NativeWind v4，让你可以在 React Native 组件中用 Tailwind CSS 的 `className` 写样式。

**基本用法：**

```tsx
<View className="flex-1 items-center justify-center bg-white">
  <Text className="text-lg font-bold text-gray-900">Hello</Text>
</View>
```

**暗色模式：**

NativeWind 支持 `dark:` 前缀：

```tsx
<View className="bg-white dark:bg-gray-900">
  <Text className="text-black dark:text-white">自适应文本</Text>
</View>
```

**工作原理：**

1. `global.css` — Tailwind 入口文件，导入 `nativewind`
2. `tailwind.config.js` — 配置 NativeWind preset 和内容扫描路径
3. `babel.config.js` — 设置 `jsxImportSource: nativewind` 和 `nativewind/babel` 插件
4. `metro.config.js` — 用 `withNativeWind` 包装 Metro 配置
5. `nativewind-env.d.ts` — 让 TypeScript 识别 `className` 属性

根布局 `_layout.tsx` 中导入了 `../global.css`，确保 NativeWind 在所有页面生效。

## UI 组件文档

### Button

可复用按钮组件，支持多种样式变体和加载状态。

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| title | `string` | — | 按钮文本 |
| variant | `'primary' \| 'secondary' \| 'outline'` | `'primary'` | 样式变体 |
| onPress | `() => void` | — | 点击回调 |
| loading | `boolean` | `false` | 是否显示加载动画 |
| disabled | `boolean` | `false` | 是否禁用 |

**示例：**

```tsx
import { Button } from '@/components/ui';

<Button title="提交" variant="primary" onPress={handleSubmit} />
<Button title="取消" variant="outline" disabled />
<Button title="加载中" variant="secondary" loading />
```

### Input

带标签和错误提示的输入框组件。

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| label | `string` | — | 输入框标签 |
| placeholder | `string` | — | 占位文本 |
| value | `string` | — | 当前值 |
| onChangeText | `(text: string) => void` | — | 文本变更回调 |
| error | `string` | — | 错误提示文本 |
| secureTextEntry | `boolean` | `false` | 是否为密码框 |

**示例：**

```tsx
import { Input } from '@/components/ui';

<Input
  label="邮箱"
  placeholder="请输入邮箱"
  value={email}
  onChangeText={setEmail}
/>
<Input
  label="密码"
  placeholder="请输入密码"
  value={password}
  onChangeText={setPassword}
  secureTextEntry
  error={passwordError}
/>
```

### Loading

加载指示器，支持全屏遮罩模式。

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| message | `string` | — | 加载提示文本 |
| fullScreen | `boolean` | `false` | 是否全屏遮罩 |

**示例：**

```tsx
import { Loading } from '@/components/ui';

<Loading message="加载中..." />
<Loading fullScreen message="正在启动..." />
```

## 开发指南

### 添加新页面

Expo Router 根据文件路径自动生成路由，在 `app/` 目录下新建文件即可。

**在 (tabs) 中添加页面（需要登录）：**

```bash
# 创建新 Tab 页
touch app/(tabs)/settings.tsx
```

然后编辑 `app/(tabs)/_layout.tsx`，在 `Tabs` 中添加对应的 `Tab.Screen`。

**在 (auth) 中添加页面（无需登录）：**

```bash
touch app/(auth)/register.tsx
```

路由会自动注册为 `/register`。

**添加独立页面（不属于任何路由组）：**

```bash
touch app/modal.tsx
```

路由为 `/modal`。需要在 `_layout.tsx` 中声明 `Stack.Screen name="modal"`。

**跳转页面：**

```tsx
import { Link, router } from 'expo-router';

// 声明式
<Link href="/(tabs)">进入首页</Link>

// 命令式
router.push('/(tabs)/profile');
router.back();
```

### 添加新 Store

```tsx
// stores/cart.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface CartItem {
  id: string;
  name: string;
  quantity: number;
}

interface CartState {
  items: CartItem[];
  addItem: (item: CartItem) => void;
  removeItem: (id: string) => void;
  clearCart: () => void;
}

export const useCartStore = create<CartState>()(
  persist(
    (set) => ({
      items: [],
      addItem: (item) =>
        set((state) => ({ items: [...state.items, item] })),
      removeItem: (id) =>
        set((state) => ({ items: state.items.filter((i) => i.id !== id) })),
      clearCart: () => set({ items: [] }),
    }),
    {
      name: 'cart-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
```

### 添加新 API 接口

```tsx
import { api } from '@/services/api';
import type { User, ApiResponse } from '@/types';

// 获取用户列表
const getUsers = () => api.get<ApiResponse<User[]>>('/users');

// 创建用户
const createUser = (data: Omit<User, 'id'>) =>
  api.post<ApiResponse<User>>('/users', data);

// 在组件中使用
const handleSubmit = async () => {
  try {
    const result = await createUser(formData);
    console.log(result);
  } catch (error) {
    console.error('创建失败', error);
  }
};
```

### 添加新 UI 组件

新建组件放在 `components/ui/` 目录下，使用 `className` 写样式：

```tsx
// components/ui/Card.tsx
import { View, Text } from 'react-native';

interface CardProps {
  title: string;
  children: React.ReactNode;
}

export function Card({ title, children }: CardProps) {
  return (
    <View className="rounded-lg bg-white p-4 shadow-sm dark:bg-gray-800">
      <Text className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
        {title}
      </Text>
      {children}
    </View>
  );
}
```

然后在 `components/ui/index.ts` 中导出：

```ts
export { Card } from './Card';
```

**className 注意事项：**

- 所有样式用 `className` 属性，不要用 `style`
- NativeWind 支持大部分 Tailwind 工具类，但不是 100% 覆盖。比如 `shadow-sm` 在 Android 上可能表现不同
- 条件样式用模板字符串：`` className={`p-2 ${active ? 'bg-blue-500' : 'bg-gray-200'}`} ``
- 复杂动画或平台特定样式，可以混合 `style` 属性

### 路径别名

`tsconfig.json` 中配置了 `@/*` 指向项目根目录：

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./*"]
    }
  }
}
```

导入时使用：

```ts
import { Button } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { api } from '@/services/api';
import type { User } from '@/types';
```

避免使用 `../../` 这样的相对路径，保持导入清晰。

## 环境配置

项目使用 Expo 的环境变量方案，以 `EXPO_PUBLIC_` 开头的变量会暴露到客户端代码中。

### 环境变量

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `EXPO_PUBLIC_API_URL` | 否 | `https://api.example.com` | API 基础地址 |

### .env 文件

在项目根目录创建 `.env` 文件：

```bash
# .env
EXPO_PUBLIC_API_URL=https://your-api-domain.com
```

代码中通过 `process.env.EXPO_PUBLIC_API_URL` 读取。修改 `.env` 后需要重启开发服务器才能生效。

**多环境配置：**

```bash
.env                # 默认
.env.local          # 本地覆盖（不提交到 Git）
.env.production     # 生产环境
.env.staging        # 预发布环境
```

## 构建与部署

### 开发命令

```bash
pnpm dev            # 启动开发服务器
pnpm ios            # iOS 模拟器
pnpm android        # Android 模拟器
pnpm web            # 浏览器
```

### 预览与构建

```bash
# 本地预览生产包
npx expo export
npx serve dist

# EAS Build（Expo Application Services）
# 首次使用需安装 EAS CLI
pnpm add -g eas-cli
eas login
eas build:configure

# 构建
eas build --platform ios      # iOS 构建
eas build --platform android   # Android 构建
eas build --platform all       # 全平台构建

# 提交到应用商店
eas submit --platform ios
eas submit --platform android
```

### EAS Build 简介

EAS Build 是 Expo 提供的云构建服务，无需本地配置 Xcode 或 Android Studio 即可生成发布包。`eas.json` 可配置构建类型（development、preview、production）、环境变量和构建缓存。

## 常见问题

### 1. NativeWind 样式不生效

**现象：** `className` 写了但页面上没有效果。

**排查：**

- 确认根布局 `_layout.tsx` 中导入了 `../global.css`
- 确认 `babel.config.js` 包含 `nativewind/babel` 插件和 `jsxImportSource: nativewind`
- 确认 `metro.config.js` 用 `withNativeWind` 包装了配置
- 修改 `global.css` 或 `tailwind.config.js` 后，清除缓存重启：`npx expo start -c`

### 2. 路径别名 @/ 报错

**现象：** IDE 报 `Cannot find module '@/stores/auth'`。

**解决：**

- 确认 `tsconfig.json` 中有 `paths: { "@/*": ["./*"] }` 配置
- 重启 TypeScript 语言服务（VSCode 中 `Cmd+Shift+P` → `TypeScript: Restart TS Server`）
- 如果用 Babel 运行时报错，确认 `babel.config.js` 中有 `module-resolver` 插件

### 3. 清除缓存解决奇怪问题

开发中遇到热更新异常、样式错乱、路由跳转不对等问题，先清缓存：

```bash
# 清除所有缓存并重启
npx expo start -c

# 如果还不行，清除 Metro 和 Babel 缓存
rm -rf node_modules/.cache
npx expo start -c
```

### 4. AsyncStorage 数据残留导致登录态异常

**现象：** 开发过程中 token 脏数据导致自动登录到错误账号。

**解决：**

- 模拟器中卸载重装 App（最彻底）
- 或者在代码中临时调用 `AsyncStorage.clear()` 清空所有数据
- 开发时可以在 `stores/auth.ts` 中加一个 `reset` 方法用于调试

### 5. Expo Go 扫码连不上开发服务器

**排查：**

- 确认手机和电脑在同一局域网
- 尝试切换连接方式：开发服务器界面按 `s` 切换 Tunnel/LAN/Localhost
- 公司网络可能屏蔽了 Expo 默认端口，用 Tunnel 模式（按 `s` → 选择 Tunnel）
- 确认防火墙没有阻止 8081 端口

### 6. typedRoutes 报路由类型错误

**现象：** 使用 `Link` 或 `router.push` 时 TypeScript 提示路由不存在。

**解决：**

- 这是 `app.json` 中 `experiments.typedRoutes: true` 的预期行为，它在帮你检查路由拼写
- 确认路由名与 `app/` 目录下的文件路径一致
- 新增页面后重启 TypeScript 服务
- 如果路由组不需要出现在路径中，确保用括号语法：`(auth)`、`(tabs)`
