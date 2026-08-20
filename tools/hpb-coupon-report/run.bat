@echo off
rem HPBクーポン予約数 照合ツールを起動する(Windows)。
rem 初回だけ .venv を作って依存を入れ、2回目以降はそのまま起動する。
setlocal
cd /d "%~dp0"

if not exist ".venv" (
  echo 初回セットアップ中です^（1〜2分かかります^）...
  python -m venv .venv
  ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

".venv\Scripts\pythonw.exe" app.py %*
if errorlevel 1 pause
endlocal
