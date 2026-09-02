#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
IOS_DIR="$PROJECT_DIR/ios"
DERIVED_DATA="$IOS_DIR/build"

if [ -z "${APP_STORE_API_KEY:-}" ] || [ -z "${APP_STORE_API_ISSUER_ID:-}" ]; then
  echo "❌ APP_STORE_API_KEY 和 APP_STORE_API_ISSUER_ID 环境变量未设置"
  exit 1
fi

echo "🚀 上传到 TestFlight..."
IPA=$(find "$DERIVED_DATA" -name "*.ipa" -type f | head -1)

if [ -z "$IPA" ]; then
  echo "❌ 未找到 IPA 文件，请先运行 pnpm build:ios"
  exit 1
fi

IPA_SIZE=$(du -h "$IPA" | cut -f1)
echo "   IPA: $IPA (${IPA_SIZE})"
echo ""

xcrun altool --upload-app \
  -f "$IPA" \
  -t ios \
  --apiKey "$APP_STORE_API_KEY" \
  --apiIssuer "$APP_STORE_API_ISSUER_ID" &
ALT_PID=$!

SPINNER=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
i=0
while kill -0 "$ALT_PID" 2>/dev/null; do
  printf "\r   %s 上传中..." "${SPINNER[i % ${#SPINNER[@]}]}"
  sleep 0.1
  ((i++))
done
wait "$ALT_PID"
EXIT_CODE=$?

printf "\r                         \r"
if [ $EXIT_CODE -ne 0 ]; then
  echo "❌ 上传失败 (exit code: $EXIT_CODE)"
  exit $EXIT_CODE
fi

echo ""
echo "✅ TestFlight 上传完成"