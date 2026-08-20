#!/usr/bin/env bash
# HPBクーポン予約数 照合ツールを起動する(macOS / Linux)。
# 初回だけ .venv を作って依存を入れ、2回目以降はそのまま起動する。
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"

if [ ! -d .venv ]; then
  echo "初回セットアップ中です（1〜2分かかります）..."
  "$PYTHON" -m venv .venv
  ./.venv/bin/python -m pip install --upgrade pip >/dev/null
  ./.venv/bin/python -m pip install -r requirements.txt
fi

exec ./.venv/bin/python main.py "$@"
