@echo off
rem 単体アプリ(hpb-coupon-report.exe)をビルドする(Windows)。
rem 出力: dist\hpb-coupon-report.exe
setlocal
cd /d "%~dp0"

set VENV=.venv-build

if not exist "%VENV%" (
  echo ビルド環境を用意しています...
  python -m venv "%VENV%"
  "%VENV%\Scripts\python.exe" -m pip install --upgrade pip >nul
)
"%VENV%\Scripts\python.exe" -m pip install -r requirements.txt pyinstaller
if errorlevel 1 goto :failed

echo ビルド中...
"%VENV%\Scripts\pyinstaller.exe" --noconfirm --clean hpb-coupon-report.spec
if errorlevel 1 goto :failed

echo.
echo 完成しました: dist\hpb-coupon-report.exe
pause
exit /b 0

:failed
echo.
echo ビルドに失敗しました。上のメッセージを確認してください。
pause
exit /b 1
