#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Android local.properties 生成脚本
# 用于解决 prebuild/gradle 报 "SDK location not found" 的问题
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ANDROID_DIR="$PROJECT_DIR/android"
LOCAL_PROPS="$ANDROID_DIR/local.properties"

echo "🔧 生成 Android local.properties..."

# 1. 优先级解析 SDK 路径
#    a) ANDROID_HOME / ANDROID_SDK_ROOT 环境变量
#    b) macOS 标准路径 ~/Library/Android/sdk
#    c) Linux 标准路径 ~/Android/Sdk
#    d) /opt/android-sdk (Linux 备选)
resolve_sdk_dir() {
  if [ -n "${ANDROID_HOME:-}" ] && [ -d "${ANDROID_HOME}" ]; then
    echo "${ANDROID_HOME}"
    return
  fi

  if [ -n "${ANDROID_SDK_ROOT:-}" ] && [ -d "${ANDROID_SDK_ROOT}" ]; then
    echo "${ANDROID_SDK_ROOT}"
    return
  fi

  if [ -d "$HOME/Library/Android/sdk" ]; then
    echo "$HOME/Library/Android/sdk"
    return
  fi

  if [ -d "$HOME/Android/Sdk" ]; then
    echo "$HOME/Android/Sdk"
    return
  fi

  if [ -d "/opt/android-sdk" ]; then
    echo "/opt/android-sdk"
    return
  fi

  return 1
}

SDK_DIR="$(resolve_sdk_dir || true)"

if [ -z "${SDK_DIR}" ]; then
  echo "❌ 未找到 Android SDK 路径，请通过以下任一方式设置："
  echo "   1. 安装 Android Studio（推荐，路径: ~/Library/Android/sdk）"
  echo "   2. 设置环境变量: export ANDROID_HOME=/path/to/android-sdk"
  echo "   3. 手动创建 ${LOCAL_PROPS} 并写入 sdk.dir=/path/to/android-sdk"
  exit 1
fi

if [ ! -d "$ANDROID_DIR" ]; then
  echo "❌ android 目录不存在: $ANDROID_DIR"
  echo "   请先运行: pnpm prebuild:android"
  exit 1
fi

cat > "$LOCAL_PROPS" <<EOF
sdk.dir=${SDK_DIR}
EOF

echo "✅ 已生成: $LOCAL_PROPS"
echo "   sdk.dir=$SDK_DIR"
echo ""
echo "💡 提示: local.properties 已被 .gitignore 忽略，每台机器需要单独生成。"
