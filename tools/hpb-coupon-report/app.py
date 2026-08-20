"""HPBクーポン予約数 照合ツール(デスクトップGUI)。

サーバーは立てない。Python標準の Tkinter でウィンドウを開き、処理も保存も
すべて実行端末の中で完結する。外部通信はHPBのクーポンページを取りにいくときだけで、
それも「レポート内の掲載一覧を使う」を選べば発生しない。

起動:  python app.py   (または run.sh / run.bat)
"""

from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import traceback
from datetime import datetime

try:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
except ImportError:  # pragma: no cover - Linuxで python3-tk が無い場合
    sys.stderr.write(
        'Tkinter が見つかりません。\n'
        'Windows / macOS の python.org 版 Python には標準で入っています。\n'
        'Linux の場合は「sudo apt install python3-tk」を実行してください。\n'
        'GUIを使わずに処理したい場合は cli.py を使ってください。\n'
    )
    raise SystemExit(1)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from hpb_coupon.excel_out import write_workbook  # noqa: E402
from hpb_coupon.pipeline import reconcile  # noqa: E402

SOURCE_REPORT = 'report'
SOURCE_SCRAPE = 'scrape'
SOURCE_HTML = 'html'


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title('HPBクーポン予約数 照合ツール')
        self.geometry('820x620')
        self.minsize(720, 560)

        self.report_path = tk.StringVar()
        self.salon_url = tk.StringVar()
        self.output_path = tk.StringVar()
        self.coupon_source = tk.StringVar(value=SOURCE_REPORT)
        self.html_paths: list[str] = []
        self.html_label = tk.StringVar(value='(未選択)')
        self.status = tk.StringVar(value='レポートを選んで「実行」を押してください。')

        self._queue: queue.Queue[tuple[str, object]] = queue.Queue()
        self._running = False
        self._last_output = ''

        self._build_widgets()
        self.after(100, self._drain_queue)

    # ------------------------------------------------------------------ UI

    def _build_widgets(self) -> None:
        padding = {'padx': 10, 'pady': 6}

        frame_report = ttk.LabelFrame(self, text='1. サロンレポート (PDF または Acrobat変換済みxlsx)')
        frame_report.pack(fill='x', **padding)
        ttk.Entry(frame_report, textvariable=self.report_path).pack(
            side='left', fill='x', expand=True, padx=8, pady=8
        )
        ttk.Button(frame_report, text='選択...', command=self._pick_report).pack(
            side='left', padx=8, pady=8
        )

        frame_source = ttk.LabelFrame(self, text='2. 掲載クーポンの取得元')
        frame_source.pack(fill='x', **padding)

        ttk.Radiobutton(
            frame_source,
            text='レポート内の「■貴店クーポン情報(Net)」を使う（通信なし・最も確実）',
            value=SOURCE_REPORT,
            variable=self.coupon_source,
            command=self._sync_source_state,
        ).pack(anchor='w', padx=8, pady=(8, 2))

        ttk.Radiobutton(
            frame_source,
            text='HPBのサロンページから取得する（価格・掲載順も取れる）',
            value=SOURCE_SCRAPE,
            variable=self.coupon_source,
            command=self._sync_source_state,
        ).pack(anchor='w', padx=8, pady=2)
        row_url = ttk.Frame(frame_source)
        row_url.pack(fill='x', padx=28, pady=(0, 4))
        ttk.Label(row_url, text='サロンURL:').pack(side='left')
        self.entry_url = ttk.Entry(row_url, textvariable=self.salon_url)
        self.entry_url.pack(side='left', fill='x', expand=True, padx=6)

        ttk.Radiobutton(
            frame_source,
            text='保存したクーポンページのHTMLを使う（通信が塞がれている場合）',
            value=SOURCE_HTML,
            variable=self.coupon_source,
            command=self._sync_source_state,
        ).pack(anchor='w', padx=8, pady=2)
        row_html = ttk.Frame(frame_source)
        row_html.pack(fill='x', padx=28, pady=(0, 8))
        self.button_html = ttk.Button(row_html, text='HTMLを選択...', command=self._pick_html)
        self.button_html.pack(side='left')
        ttk.Label(row_html, textvariable=self.html_label).pack(side='left', padx=8)

        frame_output = ttk.LabelFrame(self, text='3. 出力先')
        frame_output.pack(fill='x', **padding)
        ttk.Entry(frame_output, textvariable=self.output_path).pack(
            side='left', fill='x', expand=True, padx=8, pady=8
        )
        ttk.Button(frame_output, text='選択...', command=self._pick_output).pack(
            side='left', padx=8, pady=8
        )

        frame_actions = ttk.Frame(self)
        frame_actions.pack(fill='x', **padding)
        self.button_run = ttk.Button(frame_actions, text='実行', command=self._run)
        self.button_run.pack(side='left')
        self.button_open = ttk.Button(
            frame_actions, text='出力フォルダを開く', command=self._open_output, state='disabled'
        )
        self.button_open.pack(side='left', padx=8)
        self.progress = ttk.Progressbar(frame_actions, mode='determinate', value=0)
        self.progress.pack(side='left', fill='x', expand=True, padx=8)

        ttk.Label(self, textvariable=self.status, anchor='w').pack(
            side='bottom', fill='x', padx=12, pady=(0, 8)
        )

        frame_log = ttk.LabelFrame(self, text='ログ')
        frame_log.pack(fill='both', expand=True, **padding)
        self.log = tk.Text(frame_log, height=14, wrap='word', state='disabled')
        scrollbar = ttk.Scrollbar(frame_log, command=self.log.yview)
        self.log.configure(yscrollcommand=scrollbar.set)
        self.log.pack(side='left', fill='both', expand=True, padx=(8, 0), pady=8)
        scrollbar.pack(side='right', fill='y', padx=(0, 8), pady=8)

        self._sync_source_state()

    def _sync_source_state(self) -> None:
        source = self.coupon_source.get()
        self.entry_url.configure(state='normal' if source == SOURCE_SCRAPE else 'disabled')
        self.button_html.configure(state='normal' if source == SOURCE_HTML else 'disabled')

    # --------------------------------------------------------------- 入力選択

    def _pick_report(self) -> None:
        path = filedialog.askopenfilename(
            title='サロンレポートを選択',
            filetypes=[
                ('サロンレポート', '*.pdf *.xlsx *.xlsm'),
                ('PDF', '*.pdf'),
                ('Excel', '*.xlsx *.xlsm'),
                ('すべて', '*.*'),
            ],
        )
        if not path:
            return
        self.report_path.set(path)
        if not self.output_path.get():
            stem = os.path.splitext(os.path.basename(path))[0]
            stamp = datetime.now().strftime('%Y%m%d_%H%M')
            self.output_path.set(
                os.path.join(os.path.dirname(path), f'{stem}_クーポン照合_{stamp}.xlsx')
            )

    def _pick_html(self) -> None:
        paths = filedialog.askopenfilenames(
            title='保存したクーポンページのHTMLを選択(複数可)',
            filetypes=[('HTML', '*.html *.htm'), ('すべて', '*.*')],
        )
        if not paths:
            return
        self.html_paths = list(paths)
        self.html_label.set(f'{len(self.html_paths)}件を選択')

    def _pick_output(self) -> None:
        path = filedialog.asksaveasfilename(
            title='出力先を指定',
            defaultextension='.xlsx',
            filetypes=[('Excel', '*.xlsx')],
        )
        if path:
            self.output_path.set(path)

    def _open_output(self) -> None:
        if not self._last_output or not os.path.exists(self._last_output):
            return
        folder = os.path.dirname(os.path.abspath(self._last_output))
        try:
            if sys.platform.startswith('win'):
                os.startfile(folder)  # type: ignore[attr-defined]
            elif sys.platform == 'darwin':
                subprocess.run(['open', folder], check=False)
            else:
                subprocess.run(['xdg-open', folder], check=False)
        except Exception as exc:
            messagebox.showwarning('フォルダを開けません', str(exc))

    # ------------------------------------------------------------------ 実行

    def _log(self, message: str) -> None:
        self.log.configure(state='normal')
        self.log.insert('end', message + '\n')
        self.log.see('end')
        self.log.configure(state='disabled')

    def _validate(self) -> str | None:
        if not self.report_path.get():
            return 'サロンレポートを選んでください。'
        if not os.path.exists(self.report_path.get()):
            return 'サロンレポートのファイルが見つかりません。'
        if not self.output_path.get():
            return '出力先を指定してください。'
        source = self.coupon_source.get()
        if source == SOURCE_SCRAPE and not self.salon_url.get().strip():
            return 'サロンURLを入力してください。'
        if source == SOURCE_HTML and not self.html_paths:
            return 'クーポンページのHTMLを選んでください。'
        return None

    def _run(self) -> None:
        if self._running:
            return
        error = self._validate()
        if error:
            messagebox.showwarning('入力を確認してください', error)
            return

        source = self.coupon_source.get()
        params = {
            'report_path': self.report_path.get(),
            'salon_url': self.salon_url.get().strip() if source == SOURCE_SCRAPE else '',
            'coupon_html_paths': list(self.html_paths) if source == SOURCE_HTML else None,
            'output_path': self.output_path.get(),
        }

        self._running = True
        self.button_run.configure(state='disabled')
        self.button_open.configure(state='disabled')
        self.progress.configure(mode='indeterminate')
        self.progress.start(12)
        self.status.set('処理中...')
        self._log('=' * 60)
        self._log(f'開始: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
        threading.Thread(target=self._worker, args=(params,), daemon=True).start()

    def _worker(self, params: dict) -> None:
        try:
            result = reconcile(
                report_path=params['report_path'],
                salon_url=params['salon_url'],
                coupon_html_paths=params['coupon_html_paths'],
                progress=lambda message: self._queue.put(('log', message)),
            )
            output = write_workbook(result, params['output_path'])
            self._queue.put(('done', (result, output)))
        except Exception:
            self._queue.put(('error', traceback.format_exc()))

    def _drain_queue(self) -> None:
        try:
            while True:
                kind, payload = self._queue.get_nowait()
                if kind == 'log':
                    self._log(str(payload))
                elif kind == 'done':
                    self._finish(*payload)  # type: ignore[misc]
                elif kind == 'error':
                    self._fail(str(payload))
        except queue.Empty:
            pass
        self.after(100, self._drain_queue)

    def _stop_progress(self) -> None:
        self.progress.stop()
        self.progress.configure(mode='determinate', value=0)

    def _finish(self, result, output: str) -> None:
        self._running = False
        self._stop_progress()
        self.button_run.configure(state='normal')
        self.button_open.configure(state='normal')
        self._last_output = output

        self._log('')
        self._log(f'掲載クーポンの取得元: {result.coupon_source}')
        self._log(f'集計対象の月号      : {" / ".join(result.issue_labels) or "(不明)"}')
        self._log(f'掲載クーポン        : {len(result.rows)}件')
        self._log(f'  うち完全一致      : {result.exact_count}件')
        self._log(f'  うちあいまい一致  : {result.fuzzy_count}件  ← 「要確認」シートで確認')
        self._log(f'  うち予約ゼロ      : {len(result.zero_reservation_rows)}件  ← 「予約ゼロ」シート')
        self._log(f'未照合の予約データ  : {len(result.orphans)}件  ← 掲載を止めた/改名したクーポン')
        for warning in result.warnings:
            self._log(f'[警告] {warning}')
        self._log(f'保存しました: {output}')
        self.status.set(f'完了: {output}')

    def _fail(self, detail: str) -> None:
        self._running = False
        self._stop_progress()
        self.button_run.configure(state='normal')
        self._log(detail)
        self.status.set('エラーが発生しました。ログを確認してください。')
        messagebox.showerror('エラー', detail.strip().splitlines()[-1])


def main() -> None:
    App().mainloop()


if __name__ == '__main__':
    main()
