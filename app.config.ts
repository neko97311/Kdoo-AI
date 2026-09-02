import type { ExpoConfig } from 'expo/config';
import {
  AndroidConfig,
  withProjectBuildGradle,
  withAppBuildGradle,
  withDangerousMod,
  withAndroidManifest,
  withStringsXml,
  withInfoPlist,
} from 'expo/config-plugins';
import fs from 'node:fs';
import path from 'node:path';

const iosUrlScheme = process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;

/**
 * Universal Link / App Link domain.
 *
 * Set via `EXPO_PUBLIC_UNIVERSAL_LINK_DOMAIN` (e.g. `www.kdoo.ai`).
 * The same domain must:
 *   1. Host `apple-app-site-association` at `/.well-known/` (iOS) and
 *      `assetlinks.json` at `/.well-known/` (Android).
 *   2. Be listed in the iOS app's Associated Domains entitlement
 *      (`applinks:<domain>`) and in the Android app's intent-filter
 *      (`<data android:scheme="https" android:host="<domain>">`).
 *
 * If left empty, the app will still receive `kdoomobile://` custom-scheme
 * deep links but **not** `https://` universal links (users will see a
 * "Open in app" confirmation banner in Safari).
 */
const universalLinkDomain = process.env.EXPO_PUBLIC_UNIVERSAL_LINK_DOMAIN || 'www.kdoo.ai';

// Add Google Services Gradle plugin for Android FCM (expo-notifications doesn't include it)
function withGoogleServices(config: ExpoConfig): ExpoConfig {
  config = withProjectBuildGradle(config, (config) => {
    const contents = config.modResults.contents;
    if (!contents.includes('com.google.gms:google-services')) {
      config.modResults.contents = contents.replace(
        /dependencies\s*{/,
        `dependencies {\n    classpath('com.google.gms:google-services:4.4.2')`
      );
    }
    return config;
  });

  config = withAppBuildGradle(config, (config) => {
    const contents = config.modResults.contents;
    if (!contents.includes('com.google.gms.google-services')) {
      config.modResults.contents = contents + `\napply plugin: "com.google.gms.google-services"\n`;
    }
    return config;
  });

  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const { projectRoot } = config.modRequest;
      const src = path.join(projectRoot, 'google-services.json');
      const dest = path.join(projectRoot, 'android', 'app', 'google-services.json');
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
      return config;
    },
  ]);

  return config;
}

/**
 * Declare <queries> in AndroidManifest.xml for map navigation schemes.
 *
 * Android 11+ (API 30) enforces package visibility filtering. Apps can no
 * longer discover other installed apps without explicit declaration.
 * React Native's Linking.openURL() internally calls intent.resolveActivity()
 * which returns null for undeclared schemes, causing openURL to reject and
 * fall through to the https fallback (browser) instead of the native map APK.
 *
 * This plugin declares the custom schemes used by the MCP Google Map tool's
 * "Start Navigation" button so resolveActivity() returns the correct handler.
 *
 * Schemes declared:
 *   - androidamap://  (AMap / Gaode Maps)
 *   - googlemaps://   (Google Maps)
 *
 * NOTE: This requires a development build (expo-dev-client) rebuild.
 * Changes to AndroidManifest.xml are NOT applied via hot reload.
 */
function withMapQueries(config: ExpoConfig): ExpoConfig {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    if (!manifest.queries) {
      manifest.queries = [];
    }
    // Idempotent: skip if already declared
    const serialized = JSON.stringify(manifest.queries);
    if (serialized.includes('androidamap')) return config;

    manifest.queries.push({
      intent: [
        {
          action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
          data: [{ $: { 'android:scheme': 'androidamap' } }],
        },
        {
          action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
          data: [{ $: { 'android:scheme': 'googlemaps' } }],
        },
      ],
    });
    return config;
  });
}

/**
 * Force `android:autoVerify="true"` on every https intent-filter we just
 * declared, so Android 6+ performs the Digital Asset Links handshake
 * (fetches `/.well-known/assetlinks.json`, verifies the SHA-256 fingerprint
 * matches this app's signing certificate, and silently opens our app for
 * matching links without showing the chooser dialog).
 *
 * Without this attribute, even with the right intent-filter declared,
 * Android shows "Open with..." every time the user taps a matching link.
 *
 * Idempotent: skips filters that already have autoVerify set.
 */
function withAppLinkAutoVerify(config: ExpoConfig): ExpoConfig {
  return withAndroidManifest(config, (config) => {
    const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(
      config.modResults,
    );
    const activities = (mainApplication as { activity?: unknown[] }).activity;
    if (!Array.isArray(activities)) return config;
    for (const activity of activities) {
      if (!activity || typeof activity !== 'object') continue;
      const filters = (activity as Record<string, unknown>)['intent-filter'];
      if (!Array.isArray(filters)) continue;
      for (const filter of filters) {
        if (!filter || typeof filter !== 'object') continue;
        const f = filter as Record<string, unknown>;
        // Only autoVerify https intent-filters (custom-scheme ones are fine without)
        const data = f.data;
        if (!Array.isArray(data)) continue;
        const hasHttps = data.some((d) => {
          if (!d || typeof d !== 'object') return false;
          const scheme = (d as Record<string, unknown>).$ as
            | Record<string, unknown>
            | undefined;
          return scheme?.['android:scheme'] === 'https';
        });
        if (!hasHttps) continue;
        const attrs = (f.$ = (f.$ as Record<string, unknown>) || {});
        if (!attrs['android:autoVerify']) {
          attrs['android:autoVerify'] = 'true';
        }
      }
    }
    return config;
  });
}

function withDisplayName(config: ExpoConfig): ExpoConfig {
  const displayName = (config as ExpoConfig & { displayName?: string }).displayName;
  if (!displayName) return config;

  config = withStringsXml(config, (config) => {
    const resources = config.modResults;
    const existing = resources.resources?.string ?? [];
    const next = existing.filter((s) => s.$.name !== 'app_name');
    next.unshift({ $: { name: 'app_name' }, _: displayName });
    resources.resources = { ...resources.resources, string: next };
    return config;
  });

  config = withInfoPlist(config, (config) => {
    config.modResults.CFBundleDisplayName = displayName;
    return config;
  });

  return config;
}

const config: ExpoConfig & { displayName?: string } = {
  name: 'kdoomobile',
  displayName: 'Elioo',
  slug: 'kdoo',
  version: process.env.EXPO_PUBLIC_APP_VERSION ?? '1.0.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  scheme: 'kdoomobile',
  userInterfaceStyle: 'automatic',
  ios: {
    deploymentTarget: '16.4',
    supportsTablet: true,
    bundleIdentifier: 'com.kdoo.app',
    buildNumber: String(Math.floor(Date.now() / 1000)),
    usesAppleSignIn: true,
    // Universal Link / App Link: when an `https://www.kdoo.ai/share/{id}`
    // link is opened on iOS, iOS will hand the URL to this app *without*
    // showing the "Open in app?" confirmation banner, as long as
    // `apple-app-site-association` is hosted at the matching domain and
    // the bundle ID is listed in it. The list of `associatedDomains` is
    // also written into the `.entitlements` file at prebuild time.
    associatedDomains: [`applinks:${universalLinkDomain}`],
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      UIBackgroundModes: ['audio', 'fetch', 'remote-notification'],
      // Default values — overridden by Localizable.xcstrings for zh-Hans/pt
      NSMicrophoneUsageDescription: 'KDOO needs microphone access for voice calls and recording',
      NSCameraUsageDescription: 'KDOO needs camera access for video calls',
      // Required by expo-media-library: the fullscreen image viewer saves
      // images to the user's album. The Add-only string covers the
      // save-only prompt; the full read string matches the plugin above.
      NSPhotoLibraryUsageDescription: 'KDOO needs photo library access to save images to your album',
      NSPhotoLibraryAddUsageDescription: 'KDOO needs permission to save images to your album',
      // Required by MCP Google Map tool: lets the WebView acquire the user's
      // GPS location to compute driving/walking directions to the destination.
      NSLocationWhenInUseUsageDescription: 'KDOO needs your location to show directions and distance on the map',
      // Allow ws:// (insecure) connections for dev LiveKit server.
      // Remove this once the server uses wss:// (TLS) in production.
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
        NSAllowsLocalNetworking: true,
      },
      // CFBundleURLTypes is set explicitly here. When this key is present,
      // Expo drops the top-level `scheme: 'kdoomobile'` from the generated
      // Info.plist — so `kdoomobile` MUST be listed below explicitly,
      // otherwise the app has no custom-scheme handler and the expo-sharing
      // Share Extension cannot wake it via `kdoomobile://expo-sharing`.
      CFBundleURLTypes: [
        {
          CFBundleURLSchemes: ['kdoomobile'],
        },
        ...(iosUrlScheme
          ? [
              {
                CFBundleURLSchemes: [iosUrlScheme],
              },
            ]
          : []),
      ],
    },
  },
  android: {
    adaptiveIcon: {
      backgroundColor: '#FFFFFF',
      foregroundImage: './assets/images/icon-android.png',
      // Expo generates ic_launcher_background.webp from this image, not from backgroundColor.
      backgroundImage: './assets/images/icon-android-background.png',
      monochromeImage: './assets/images/icon-android.png',
    },
    predictiveBackGestureEnabled: false,
    package: 'com.kdoo.app',
    versionCode: Math.floor(Date.now() / 1000),
    // Android App Link: `https://www.kdoo.ai/share/{id}` will be handed
    // directly to this app on Android 6+ (with `autoVerify="true"`)
    // when `assetlinks.json` at the matching domain lists this package
    // and the signing certificate's SHA-256 fingerprint.
    intentFilters: [
      {
        action: 'VIEW',
        category: ['BROWSABLE', 'DEFAULT'],
        data: [
          {
            scheme: 'https',
            host: universalLinkDomain,
            pathPrefix: '/share',
          },
        ],
      },
      {
        // Custom-scheme fallback: `kdoomobile://share/{id}`.
        // Top-level `scheme: 'kdoomobile'` already registers the
        // package-wide handler, but listing it as an explicit
        // intent-filter ensures OEM browsers that strip the implicit
        // scheme (Huawei Browser, MIUI Browser) can still resolve
        // the link to this app.
        action: 'VIEW',
        category: ['BROWSABLE', 'DEFAULT'],
        data: { scheme: 'kdoomobile' },
      },
    ],
    permissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.INTERNET',
      'android.permission.CAMERA',
      // callPhoneTool: direct dialing via ACTION_CALL. Without it the app
      // degrades to opening the dialer app with the number pre-filled.
      'android.permission.CALL_PHONE',
      // expo-media-library: saving images to the album from the fullscreen
      // image viewer. Scoped storage (Android 10+) ignores these; they are
      // still requested at runtime on older devices.
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.BLUETOOTH',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.WAKE_LOCK',
      // Required by MCP Google Map tool: WebView's navigator.geolocation needs
      // runtime location permissions to acquire the user's GPS coordinates.
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      // react-native-track-player background audio service. FOREGROUND_SERVICE
      // is the base permission for any foreground service; the typed variant
      // is additionally required on Android 14 (API 34) so the OS allows the
      // media-playback service to enter the foreground state.
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
      // LiveKit Android screen share: MediaProjection foreground service
      // (handled by @livekit/react-native-webrtc). Required on API 34+.
      'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
    ],
  },
  web: {
    bundler: 'metro',
    // Use 'single' (SPA shell, client-side only) instead of 'static' (SSG).
    // 'static' triggers SSR/SSG rendering of _layout.tsx in Node, which crashes
    // because @livekit/react-native -> @livekit/react-native-webrtc calls
    // requireNativeComponent('RTCView') at module top level (no native runtime in Node).
    // 'single' emits a static HTML shell and renders everything in the browser,
    // so native-only modules are never evaluated server-side.
    output: 'single',
    favicon: './assets/images/favicon.png',
  },
  plugins: [
    'expo-router',
    'expo-apple-authentication',
    'react-native-audio-api',
    [
      'expo-splash-screen',
      {
        image: './assets/images/icon-loading.png',
        resizeMode: 'contain',
        backgroundColor: '#ffffff',
      },
    ],
    [
      'expo-notifications',
      {
        // Android status bar notification icon: pure white transparent PNG,
        // system uses only the alpha channel silhouette.
        icon: './assets/images/notification_icon.png',
        color: '#ffffff',
        // Align with setNotificationChannelAsync('default', ...) in services/notifications.ts
        defaultChannel: 'default',
      },
    ],
    [
      'expo-dev-client',
      {
        launchMode: 'most-recent',
        toolsButton: true,
        showMenuAtLaunch: false,
      },
    ],
    // LiveKit — enable MediaProjection FGS so setScreenShareEnabled works.
    [
      '@livekit/react-native-expo-plugin',
      {
        android: {
          enableScreenShareService: true,
        },
      },
    ],
    '@config-plugins/react-native-webrtc',
    // Background audio playback (in-app + notification bar + lock screen).
    // react-native-track-player is a bare RN module — it does NOT ship a
    // config plugin and must NOT be listed here (doing so makes Expo try
    // to load its TS source as a plugin → SyntaxError). It auto-links via
    // standard React Native autolinking during `expo prebuild`.
    // Required setup lives elsewhere:
    //   - iOS: `infoPlist.UIBackgroundModes: ['audio']` (see ios section above)
    //   - Android: FOREGROUND_SERVICE + FOREGROUND_SERVICE_MEDIA_PLAYBACK
    //     permissions (see android.permissions below)
    //   - Entry point: TrackPlayer.registerPlaybackService() in app/_layout.tsx
    // Allow cleartext HTTP traffic on Android — Cobalt (http://100.64.0.16:9000)
    // and SearXNG (http://100.64.0.16:8080) are served over plain HTTP on the
    // intranet. Without this flag, Android Pie+ blocks playback of MP3s whose
    // resolved URL is http:// (TrackPlayer fails with a generic playback error).
    [
      'expo-build-properties',
      {
        android: {
          usesCleartextTraffic: true,
        },
        ios: {
          // iOS already permits arbitrary loads via NSAppTransportSecurity above.
        },
      },
    ],
    // In-app camera screen (Plan B): expo-camera config plugin. The
    // cameraPermission string mirrors the existing NSCameraUsageDescription
    // in ios.infoPlist so the prebuilt permission prompt stays consistent.
    ['expo-camera', { cameraPermission: 'KDOO needs camera access for video calls' }],
    // Save previewed images to the photo album (ImagePreviewOverlay download
    // button). The permission strings mirror the ios.infoPlist entries
    // below. Android 10+ uses scoped storage/MediaStore without runtime
    // prompts; READ/WRITE_EXTERNAL_STORAGE cover older Android versions
    // (declared in android.permissions below).
    [
      'expo-media-library',
      {
        photosPermission: 'KDOO needs photo library access to save images to your album',
        savePhotosPermission: 'KDOO needs permission to save images to your album',
      },
    ],
    // Receive content shared INTO the app from the system share sheet
    // (text / URL / images). This enables the iOS Share Extension target
    // and Android SEND intent-filter so Elioo appears as a share destination.
    // Requires `expo prebuild` + a native rebuild to take effect.
    [
      'expo-sharing',
      {
        ios: {
          enabled: true,
          activationRule: {
            supportsText: true,
            supportsWebUrlWithMaxCount: 1,
            supportsImageWithMaxCount: 1,
          },
        },
        android: {
          enabled: true,
          singleShareMimeTypes: ['text/*', 'image/*'],
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default withAppLinkAutoVerify(
  withMapQueries(withGoogleServices(withDisplayName(config as ExpoConfig))),
);