"""単体アプリの入口。

PyInstallerでビルドするとき、ここが実行の起点になる。引数を付けずに起動すれば
GUI、引数を付ければコマンドラインとして動く。

GUIビルド(--windowed)では標準出力もコンソールも表示されないため、起動時に
予期しない例外が出ると何も出ずに落ちたように見える。それを避けるために、
ここで最後の受け皿を用意して、実行ファイルの隣にログを残しつつダイアログを出す。
"""

from __future__ import annotations

import os
import sys
import traceback
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CRASH_LOG_NAME = 'hpb-coupon-report-error.log'


def _app_dir() -> str:
    """実行ファイル(またはスクリプト)が置かれているフォルダ。"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _report_crash(detail: str) -> None:
    path = os.path.join(_app_dir(), CRASH_LOG_NAME)
    try:
        with open(path, 'a', encoding='utf-8') as handle:
            handle.write(f'\n===== {datetime.now():%Y-%m-%d %H:%M:%S} =====\n{detail}\n')
    except OSError:
        path = '(ログを書き出せませんでした)'

    sys.stderr.write(detail)
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(
            '起動できませんでした',
            f'{detail.strip().splitlines()[-1]}\n\n詳細をログに書き出しました:\n{path}',
        )
        root.destroy()
    except Exception:
        pass  # GUIも出せない環境なら標準エラー出力だけで諦める


def main() -> int:
    try:
        if len(sys.argv) > 1:
            from cli import main as cli_main

            return cli_main()
        from app import main as gui_main

        gui_main()
        return 0
    except SystemExit:
        raise
    except BaseException:
        _report_crash(traceback.format_exc())
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
