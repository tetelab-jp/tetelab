# -*- mode: python ; coding: utf-8 -*-
"""PyInstallerのビルド定義(Windows / macOS / Linux 共通)。

    pyinstaller --noconfirm hpb-coupon-report.spec

onefile(単一の実行ファイル)にしている。月に一度使う道具なので、起動が数秒
遅くなるより「1つのファイルを置くだけ」のほうが扱いやすい。

pdfplumber は pdfminer.six と pypdfium2(ネイティブライブラリ)に依存していて、
PyInstallerの自動検出だけではデータファイルを取りこぼす。customtkinter も
テーマのjsonとフォントをデータとして持っている。どちらも collect_all で
明示的に全部入れる。
"""

import os
import sys

from PyInstaller.utils.hooks import collect_all

APP_NAME = 'hpb-coupon-report'
HERE = os.path.abspath(os.getcwd())

datas, binaries, hiddenimports = [], [], []
for package in ('pdfplumber', 'pdfminer', 'pypdfium2', 'rapidfuzz', 'customtkinter'):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

if sys.platform.startswith('win'):
    icon = os.path.join(HERE, 'assets', 'icon.ico')
elif sys.platform == 'darwin':
    icon = os.path.join(HERE, 'assets', 'icon.icns')
else:
    icon = None

analysis = Analysis(
    ['main.py'],
    pathex=[HERE],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    # 使っていない重量級のライブラリを巻き込まないようにする
    excludes=['matplotlib', 'numpy', 'pandas', 'scipy', 'PyQt5', 'PySide2', 'pytest'],
    noarchive=False,
)
pyz = PYZ(analysis.pure)

executable = EXE(
    pyz,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name=APP_NAME,
    debug=False,
    strip=False,
    upx=False,  # UPX圧縮はウイルス対策ソフトの誤検知を招きやすいので使わない
    console=False,  # GUIアプリなので黒いコンソールを出さない
    icon=icon,
)

if sys.platform == 'darwin':
    app = BUNDLE(
        executable,
        name=f'{APP_NAME}.app',
        icon=icon,
        bundle_identifier='jp.tetelab.hpb-coupon-report',
        info_plist={
            'CFBundleName': 'HPBクーポン照合',
            'CFBundleDisplayName': 'HPBクーポン予約数 照合ツール',
            'NSHighResolutionCapable': True,
        },
    )
