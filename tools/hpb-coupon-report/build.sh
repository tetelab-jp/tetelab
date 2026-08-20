#!/usr/bin/env bash
# 単体アプリ(実行ファイル)をビルドする(macOS / Linux)。
# 出力: dist/hpb-coupon-report      (Linux)
#       dist/hpb-coupon-report.app  (macOS)
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
VENV=.venv-build

if [ ! -d "$VENV" ]; then
  echo "ビルド環境を用意しています..."
  "$PYTHON" -m venv "$VENV"
  ./"$VENV"/bin/python -m pip install --upgrade pip >/dev/null
fi
./"$VENV"/bin/python -m pip install -r requirements.txt pyinstaller

echo "ビルド中..."
./"$VENV"/bin/pyinstaller --noconfirm --clean hpb-coupon-report.spec

echo
echo "完成しました:"
ls -la dist/
