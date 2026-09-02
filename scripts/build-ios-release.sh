#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
IOS_DIR="$PROJECT_DIR/ios"
DERIVED_DATA="$IOS_DIR/build"

# Default proxy for outbound HTTPS to github.com (required when GitHub Releases
# is unreachable from the build host). Override with environment variables below.
DEFAULT_HTTP_PROXY="${HTTP_PROXY:-${http_proxy:-http://127.0.0.1:1080}}"
DEFAULT_HTTPS_PROXY="${HTTPS_PROXY:-${https_proxy:-${DEFAULT_HTTP_PROXY}}}"
DEFAULT_ALL_PROXY="${ALL_PROXY:-${all_proxy:-socks5://127.0.0.1:1080}}"

export HTTP_PROXY="$DEFAULT_HTTP_PROXY"
export HTTPS_PROXY="$DEFAULT_HTTPS_PROXY"
export ALL_PROXY="$DEFAULT_ALL_PROXY"
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export all_proxy="$ALL_PROXY"

echo "📦 开始 iOS 本地发布构建..."
echo "   项目目录: $PROJECT_DIR"
echo "   代理: HTTP_PROXY=${HTTP_PROXY}, ALL_PROXY=${ALL_PROXY}"

if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "❌ node_modules 不存在，请先运行 pnpm install"
  exit 1
fi

# 1. 生成开源许可证数据
echo ""
echo "📄 生成开源许可证数据..."
cd "$PROJECT_DIR"
node scripts/generate-licenses.mjs

# 2. 预下载 react-native-audio-api 原生二进制
# 该包的 podspec 通过 prepare_command 调用 download-prebuilt-binaries.sh，
# 但 GitHub Releases 在某些网络下不可达，pod install 阶段会静默卡死。
# 在 prebuild 之前显式预下载，能让失败尽早暴露，并复用上面设置的代理。
echo ""
echo "🎵 预下载 react-native-audio-api 原生二进制..."
AUDIO_DIR="$(find "$PROJECT_DIR/../../node_modules/.pnpm" -type d -name 'react-native-audio-api' 2>/dev/null | head -1 || true)"
if [ -n "$AUDIO_DIR" ] && [ -d "$AUDIO_DIR" ]; then
  if [ ! -d "$AUDIO_DIR/common/cpp/audioapi/external/iphoneos" ]; then
    # The download script uses $(pwd) to resolve paths, so we must cd into the package first.
    if (cd "$AUDIO_DIR" && bash scripts/download-prebuilt-binaries.sh ios); then
      echo "✅ 音频二进制下载完成"
    else
      echo "❌ 音频二进制下载失败！请检查网络或代理设置" >&2
      echo "   可手动重试: cd \"$AUDIO_DIR\" && bash scripts/download-prebuilt-binaries.sh ios" >&2
      exit 1
    fi
  else
    echo "   音频二进制已存在，跳过下载"
  fi
else
  echo "   未找到 react-native-audio-api，跳过"
fi

# 3. 生成原生代码
echo ""
echo "🔧 生成原生代码..."
cd "$PROJECT_DIR"
npx expo prebuild --platform ios --no-install

# 4. 安装 CocoaPods（prebuild 已下载二进制，CocoaPods 此时能正确注册 xcframework）
echo ""
echo "🔧 安装 CocoaPods..."
cd "$IOS_DIR"
pod install

# 5. Xcode archive
echo ""
echo "🔨 Xcode archive..."
WORKSPACE=$(ls -d "$IOS_DIR"/*.xcworkspace | head -1)
SCHEME="kdoomobile"

xcodebuild archive \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -archivePath "$DERIVED_DATA/$SCHEME.xcarchive" \
  -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates

# 6. 导出 IPA
echo ""
echo "📦 导出 IPA..."
xcodebuild -exportArchive \
  -archivePath "$DERIVED_DATA/$SCHEME.xcarchive" \
  -exportPath "$DERIVED_DATA" \
  -exportOptionsPlist "$IOS_DIR/ExportOptions.plist" \
  -allowProvisioningUpdates

echo ""
echo "✅ 构建完成！"
find "$DERIVED_DATA" -name "*.ipa" -exec ls -lh {} \; 2>/dev/null || echo "   (未找到 IPA)"
