#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Android 本地发布构建脚本
# 使用 Gradle 直接构建 release APK/AAB
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ANDROID_DIR="$PROJECT_DIR/android"

echo "📦 开始 Android 本地发布构建..."
echo "   项目目录: $PROJECT_DIR"

# 1. 确保 node_modules 存在
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "❌ node_modules 不存在，请先运行 pnpm install"
  exit 1
fi

# 2. 生成开源许可证数据
echo ""
echo "📄 生成开源许可证数据..."
cd "$PROJECT_DIR"
node scripts/generate-licenses.mjs

# 3. 生成原生代码（如已存在则跳过 clean）
echo ""
echo "🔧 生成原生代码..."
cd "$PROJECT_DIR"
npx expo prebuild --platform android --no-install

# 3. 构建 release APK
echo ""
echo "🔨 使用 Gradle 构建 release APK..."
cd "$ANDROID_DIR"

# 强制为 Gradle daemon 与子进程提供大堆内存，避免 OOM (尤其资源 crunch / dex 合并阶段)
export GRADLE_OPTS="${GRADLE_OPTS:-} -Xmx8192m -XX:MaxMetaspaceSize=2g -Dfile.encoding=UTF-8"
export JAVA_OPTS="${JAVA_OPTS:-} -Xmx8192m -XX:MaxMetaspaceSize=2g -Dfile.encoding=UTF-8"
export _JAVA_OPTIONS="${_JAVA_OPTIONS:-} -Xmx8192m -XX:MaxMetaspaceSize=2g"

BUILD_TYPE="${1:-apk}"

case "$BUILD_TYPE" in
  aab)
    echo "   构建目标: Android App Bundle (AAB)"
    ./gradlew bundleRelease
    EXT="aab"
    OUTPUT_DIR="app/build/outputs/bundle/release"
    ;;
  apk|*)
    echo "   构建目标: APK"
    ./gradlew assembleRelease
    EXT="apk"
    OUTPUT_DIR="app/build/outputs/apk/release"
    ;;
esac

# 4. 输出构建结果
echo ""
echo "✅ 构建完成！"
echo "   输出目录: $ANDROID_DIR/$OUTPUT_DIR"
echo ""
echo "   产物文件:"
find "$ANDROID_DIR/$OUTPUT_DIR" -name "*.$EXT" -exec ls -lh {} \; 2>/dev/null || echo "   (未找到 .$EXT 文件)"

echo ""
echo "📱 安装到设备: adb install <apk路径>"