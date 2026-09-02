# Google Sign-In 配置说明

## 运行时配置

Google Sign-In 的 `clientId` 在运行时通过 `GoogleSignin.configure()` 设置，详见初始化代码。

## Native 配置（app.json）

### iOS：需要 URL Scheme

iOS 的 Google 登录流程依赖 **URL Scheme 回调** — 用户授权后，Safari 通过自定义 URL scheme 把结果回传给 App。因此必须在 `app.json`（`app.config.ts`）中声明。

通过 `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` 环境变量设置，格式为 `com.googleusercontent.apps.{REVERSED_CLIENT_ID}`（即 iOS Client ID 的反转格式）：

```
# .env
EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME=YOUR_GOOGLE_IOS_URL_SCHEME
```

注意：这个值不同于 `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`（完整格式带 `.apps.googleusercontent.com` 后缀），URL Scheme 需要的是 Client ID 的**反转格式**。

### Android：无需额外配置

Android 端不需要在 `app.json` 中声明任何内容，原因：

- **Android 不依赖 URL Scheme**。从 Android 12+ 起，Google 使用 **Credential Manager** API 进行登录，这是系统级的凭据选择器，不经过浏览器回调
- 所有配置（`androidClientId`、`webClientId`）在 `GoogleSignin.configure()` 运行时传入即可
- Expo prebuild 会自动处理 Android 原生的 OAuth 基础设施

### 为什么 `androidClientId` 不在 `app.json` 里？

`app.json` 是**构建时**静态配置，而 `androidClientId` 通过环境变量管理更灵活（不同环境用不同的 OAuth client）。Android 原生层也不需要提前知道这个值 — `GoogleSignin.configure()` 会在 App 启动时动态传入。

## 环境变量

```
# .env
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=xxx.apps.googleusercontent.com         # iOS Client ID（运行时用）
EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME=com.googleusercontent.apps.{REVERSED_ID}  # iOS URL Scheme（构建时用）
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=xxx.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=xxx.apps.googleusercontent.com
```

> `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` 是反转格式的 Client ID（去掉 `.apps.googleusercontent.com` 后缀并加上 `com.googleusercontent.apps.` 前缀），专门用于 iOS 的 `CFBundleURLSchemes` 构建配置。

## 文件清单

```
projects/app/
├── app.json                              # iOS URL Scheme（Android 无需配置）
├── .env                                  # OAuth Client ID 环境变量
└── services/                             # GoogleSignin.configure() 调用
```