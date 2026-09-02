#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# 源码打包脚本
# 压缩 projects/app 下的源码文件，排除编译中间产物
#
# 用法:
#   ./scripts/pack-source.sh              # 输出到项目目录
#   ./scripts/pack-source.sh ~/Desktop    # 输出到指定目录
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 输出目录（参数指定，默认项目目录）
OUTPUT_DIR="${1:-$PROJECT_DIR}"
mkdir -p "$OUTPUT_DIR"

# 生成压缩文件名
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
ZIP_FILE="$OUTPUT_DIR/kdoo-app_source_${TIMESTAMP}.zip"

echo "📦 开始打包源码..."
echo "   项目目录: $PROJECT_DIR"
echo "   输出文件: $ZIP_FILE"
echo ""

# ──────────────────── 排除清单 ────────────────────
# 编译中间产物 / 依赖 / 缓存 / 系统文件
EXCLUDES=(
  "node_modules/*"            # npm/pnpm 依赖
  ".expo/*"                   # Expo 缓存
  ".DS_Store"                 # macOS 系统文件
  "*/.DS_Store"               # 子目录系统文件
  "ios/Pods/*"                # CocoaPods 依赖
  "ios/build/*"               # iOS 构建产物
  "ios/DerivedData/*"         # Xcode 构建缓存
  "ios/*.log"                 # iOS 构建日志
  "android/build/*"           # Android 构建产物
  "android/.gradle/*"         # Gradle 缓存
  "android/app/build/*"       # Android app 构建产物
  "android/local.properties"  # 机器相关 SDK 路径
  "dist/*"                    # Web 构建输出
  "web-build/*"               # Web 构建输出
  ".cache/*"                  # 通用缓存
  "*.log"                    # 所有日志文件
  "*/__pycache__/*"           # Python 缓存
  "modules/*/android/build/*"  # 原生模块构建产物
  "modules/*/android/.gradle/*" # 原生模块 Gradle 缓存
  "modules/*/ios/Pods/*"       # 原生模块 Pods
  "modules/*/ios/build/*"      # 原生模块构建产物
  "modules/*/ios/DerivedData/*" # 原生模块 Xcode 缓存
  "*_source_*.zip"            # 避免重复打包自身
)

# 构建 zip 排除参数
EXCLUDE_ARGS=()
for pattern in "${EXCLUDES[@]}"; do
  EXCLUDE_ARGS+=("-x" "$pattern")
done

# 执行压缩
cd "$PROJECT_DIR"
zip -r -q "$ZIP_FILE" . "${EXCLUDE_ARGS[@]}"

# 输出结果
ZIP_SIZE=$(du -h "$ZIP_FILE" | cut -f1)
FILE_COUNT=$(zipinfo -1 "$ZIP_FILE" 2>/dev/null | wc -l | tr -d ' ')

echo "✅ 打包完成"
echo "   文件:   $ZIP_FILE"
echo "   大小:   $ZIP_SIZE"
echo "   文件数: $FILE_COUNT"
echo ""
echo "💡 提示: 解压后运行 pnpm install 重建依赖"
