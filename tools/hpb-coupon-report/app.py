"""HPBクーポン予約数 照合ツール(デスクトップGUI)。

サーバーは立てない。CustomTkinter(Tkinterの上に描画する見た目のライブラリ)で
ウィンドウを開き、処理も保存もすべて実行端末の中で完結する。外部通信はHPBの
クーポンページを取りにいくときだけで、それも「レポート内の一覧を使う」を選べば
発生しない。

見た目にCustomTkinterを使っているのは、macOSのTkが標準の 'aqua' テーマだと
配色をほとんど変更できないため。CustomTkinterは自前でウィジェットを描くので、
Windows/macOS/Linuxで同じ見た目になる。

画面まわりだけを持ち、照合の中身は hpb_coupon/pipeline.py にある。

起動:  python main.py   (または run.sh / run.bat)
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
    from tkinter import filedialog, font as tkfont, messagebox
except ImportError:  # pragma: no cover - Linuxで python3-tk が無い場合
    sys.stderr.write(
        'Tkinter が見つかりません。\n'
        'Windows / macOS の python.org 版 Python には標準で入っています。\n'
        'Linux の場合は「sudo apt install python3-tk」を実行してください。\n'
        'GUIを使わずに処理したい場合は cli.py を使ってください。\n'
    )
    raise SystemExit(1)

import customtkinter as ctk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from hpb_coupon.excel_out import write_workbook  # noqa: E402
from hpb_coupon.pipeline import reconcile  # noqa: E402

SOURCE_REPORT = 'report'
SOURCE_SCRAPE = 'scrape'
SOURCE_HTML = 'html'

# 配色。出力xlsxのヘッダ(#1F3864)を基準にしている。
NAVY = '#1F3864'
NAVY_HOVER = '#2C4B7C'
ACCENT = '#2C5FA8'
DANGER = '#C0392B'
SUCCESS = '#1F7A45'
PAGE_BG = '#F4F6FA'
CARD_BG = '#FFFFFF'
LINE = '#E3E7EF'
SUBTLE_BG = '#EDF0F6'
SUBTLE_HOVER = '#DFE4EE'
TEXT = '#1B1F27'
MUTED = '#6B7484'

# OSごとの日本語が出せるUIフォント候補。CustomTkinterの既定(Roboto)は
# 日本語の字形を持たないので、明示的に選ぶ。
FONT_CANDIDATES = {
    'darwin': ['Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Arial Unicode MS'],
    'win32': ['Yu Gothic UI', 'Meiryo UI', 'Meiryo', 'MS UI Gothic'],
}
FONT_FALLBACK = ['Noto Sans CJK JP', 'Noto Sans JP', 'IPAexGothic', 'TakaoPGothic', 'DejaVu Sans']


def _pick_font_family() -> str:
    """実行環境に入っている日本語UIフォントを選ぶ。無ければ空文字(既定に任せる)。"""
    available = {name.lower() for name in tkfont.families()}
    for name in FONT_CANDIDATES.get(sys.platform, []) + FONT_FALLBACK:
        if name.lower() in available:
            return name
    return ''


class App(ctk.CTk):
    def __init__(self) -> None:
        ctk.set_appearance_mode('light')
        super().__init__(fg_color=PAGE_BG)
        self.title('HPBクーポン予約数 照合ツール')
        self.geometry('920x900')
        self.minsize(860, 760)

        self._family = _pick_font_family()

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
        self._stat_values: dict[str, ctk.CTkLabel] = {}

        self._build_widgets()
        self.after(100, self._drain_queue)

    def _font(self, size: int = 13, weight: str = 'normal') -> ctk.CTkFont:
        if self._family:
            return ctk.CTkFont(family=self._family, size=size, weight=weight)
        return ctk.CTkFont(size=size, weight=weight)

    # ------------------------------------------------------------------ UI

    def _build_widgets(self) -> None:
        self._build_header()

        body = ctk.CTkFrame(self, fg_color='transparent')
        body.pack(fill='both', expand=True, padx=22, pady=(14, 16))

        self._build_report_card(body)
        self._build_source_card(body)
        self._build_output_card(body)
        self._build_actions(body)
        self._build_stats(body)
        self._build_log(body)

        self._sync_source_state()

    def _build_header(self) -> None:
        header = ctk.CTkFrame(self, fg_color=NAVY, corner_radius=0, height=76)
        header.pack(fill='x')
        header.pack_propagate(False)
        ctk.CTkLabel(
            header,
            text='HPBクーポン予約数 照合ツール',
            font=self._font(19, 'bold'),
            text_color='#FFFFFF',
        ).pack(anchor='w', padx=26, pady=(16, 0))
        ctk.CTkLabel(
            header,
            text='サロンレポートから、掲載中クーポンの予約数を突き合わせます',
            font=self._font(12),
            text_color='#B9C6DE',
        ).pack(anchor='w', padx=26)

    def _card(self, parent, step: str, title: str):
        """番号付きの見出しを持つカードを作り、中身を入れる枠を返す。"""
        outer = ctk.CTkFrame(
            parent, fg_color=CARD_BG, corner_radius=12, border_width=1, border_color=LINE
        )
        outer.pack(fill='x', pady=(0, 12))

        heading = ctk.CTkFrame(outer, fg_color='transparent')
        heading.pack(fill='x', padx=18, pady=(14, 0))
        ctk.CTkLabel(
            heading,
            text=step,
            width=24,
            height=24,
            corner_radius=12,
            fg_color=NAVY,
            text_color='#FFFFFF',
            font=self._font(12, 'bold'),
        ).pack(side='left')
        ctk.CTkLabel(
            heading, text=title, font=self._font(14, 'bold'), text_color=TEXT
        ).pack(side='left', padx=10)

        inner = ctk.CTkFrame(outer, fg_color='transparent')
        inner.pack(fill='x', padx=18, pady=(8, 14))
        return inner

    def _entry(self, parent, variable: tk.StringVar) -> ctk.CTkEntry:
        entry = ctk.CTkEntry(
            parent,
            textvariable=variable,
            font=self._font(12),
            height=36,
            corner_radius=8,
            border_color=LINE,
            fg_color='#FFFFFF',
            text_color=TEXT,
        )
        entry.pack(side='left', fill='x', expand=True)
        return entry

    def _subtle_button(self, parent, text: str, command, width: int = 88) -> ctk.CTkButton:
        return ctk.CTkButton(
            parent,
            text=text,
            command=command,
            width=width,
            height=36,
            corner_radius=8,
            font=self._font(12),
            fg_color=SUBTLE_BG,
            hover_color=SUBTLE_HOVER,
            text_color=NAVY,
        )

    def _build_report_card(self, body) -> None:
        card = self._card(body, '1', 'サロンレポート  (PDF または Acrobat変換済みxlsx)')
        self._entry(card, self.report_path)
        self._subtle_button(card, '選択...', self._pick_report).pack(side='left', padx=(10, 0))

    def _build_source_card(self, body) -> None:
        card = self._card(body, '2', '掲載クーポンの取得元')

        def radio(value: str, label: str, note: str):
            row = ctk.CTkFrame(card, fg_color='transparent')
            row.pack(fill='x', pady=3)
            ctk.CTkRadioButton(
                row,
                text=label,
                variable=self.coupon_source,
                value=value,
                command=self._sync_source_state,
                font=self._font(12),
                text_color=TEXT,
                radiobutton_width=18,
                radiobutton_height=18,
                border_width_unchecked=2,
                fg_color=ACCENT,
                hover_color=ACCENT,
            ).pack(side='left')
            ctk.CTkLabel(row, text=note, font=self._font(11), text_color=MUTED).pack(
                side='left', padx=10
            )
            return row

        radio(SOURCE_REPORT, 'レポート内の「■貴店クーポン情報(Net)」を使う', '通信なし・最も確実')

        radio(SOURCE_SCRAPE, 'HPBのサロンページから取得する', '価格・掲載順も取れる')
        row_url = ctk.CTkFrame(card, fg_color='transparent')
        row_url.pack(fill='x', padx=28, pady=(2, 6))
        ctk.CTkLabel(row_url, text='サロンURL', font=self._font(11), text_color=MUTED).pack(
            side='left', padx=(0, 8)
        )
        self.entry_url = self._entry(row_url, self.salon_url)

        radio(SOURCE_HTML, '保存したクーポンページのHTMLを使う', '通信が塞がれている場合')
        row_html = ctk.CTkFrame(card, fg_color='transparent')
        row_html.pack(fill='x', padx=28, pady=(2, 0))
        self.button_html = self._subtle_button(row_html, 'HTMLを選択...', self._pick_html, width=130)
        self.button_html.pack(side='left')
        ctk.CTkLabel(
            row_html, textvariable=self.html_label, font=self._font(11), text_color=MUTED
        ).pack(side='left', padx=10)

    def _build_output_card(self, body) -> None:
        card = self._card(body, '3', '出力先')
        self._entry(card, self.output_path)
        self._subtle_button(card, '選択...', self._pick_output).pack(side='left', padx=(10, 0))

    def _build_actions(self, body) -> None:
        actions = ctk.CTkFrame(body, fg_color='transparent')
        actions.pack(fill='x', pady=(2, 14))

        self.button_run = ctk.CTkButton(
            actions,
            text='実行',
            command=self._run,
            width=150,
            height=42,
            corner_radius=10,
            font=self._font(15, 'bold'),
            fg_color=NAVY,
            hover_color=NAVY_HOVER,
        )
        self.button_run.pack(side='left')

        self.button_open = ctk.CTkButton(
            actions,
            text='出力フォルダを開く',
            command=self._open_output,
            width=170,
            height=42,
            corner_radius=10,
            font=self._font(12),
            fg_color=SUBTLE_BG,
            hover_color=SUBTLE_HOVER,
            text_color=NAVY,
            state='disabled',
        )
        self.button_open.pack(side='left', padx=10)

        self.label_status = ctk.CTkLabel(
            actions, textvariable=self.status, font=self._font(12), text_color=MUTED, anchor='w'
        )
        self.label_status.pack(side='left', padx=8, fill='x', expand=True)

        self.progress = ctk.CTkProgressBar(
            actions, width=170, height=8, corner_radius=4, progress_color=NAVY
        )
        self.progress.set(0)  # pack は実行中だけ行う(待機中に出しっぱなしだと紛らわしい)

    def _build_stats(self, body) -> None:
        """結果を数字で見せる。ログを読まなくても判断できるようにするため。"""
        stats = ctk.CTkFrame(body, fg_color='transparent')
        stats.pack(fill='x', pady=(0, 12))

        tiles = [
            ('listed', '掲載クーポン', TEXT),
            ('exact', '完全一致', ACCENT),
            ('zero', '予約ゼロ', DANGER),
            ('orphan', '未照合の予約', MUTED),
        ]
        for index, (key, label, color) in enumerate(tiles):
            stats.grid_columnconfigure(index, weight=1)
            tile = ctk.CTkFrame(
                stats, fg_color=CARD_BG, corner_radius=12, border_width=1, border_color=LINE
            )
            tile.grid(row=0, column=index, sticky='ew', padx=(0 if index == 0 else 10, 0))
            value = ctk.CTkLabel(tile, text='—', font=self._font(30, 'bold'), text_color=color)
            value.pack(pady=(12, 0))
            ctk.CTkLabel(tile, text=label, font=self._font(11), text_color=MUTED).pack(pady=(0, 12))
            self._stat_values[key] = value

    def _build_log(self, body) -> None:
        frame = ctk.CTkFrame(
            body, fg_color=CARD_BG, corner_radius=12, border_width=1, border_color=LINE
        )
        frame.pack(fill='both', expand=True)
        ctk.CTkLabel(frame, text='ログ', font=self._font(12, 'bold'), text_color=MUTED).pack(
            anchor='w', padx=18, pady=(12, 4)
        )
        self.log = ctk.CTkTextbox(
            frame,
            font=self._font(11),
            fg_color='#FBFCFE',
            border_width=1,
            border_color=LINE,
            corner_radius=8,
            text_color='#2A2F3A',
            wrap='word',
        )
        self.log.pack(fill='both', expand=True, padx=18, pady=(0, 14))
        self.log.configure(state='disabled')

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
        self.progress.pack(side='right')
        self.progress.configure(mode='indeterminate')
        self.progress.start()
        self.status.set('処理中...')
        self.label_status.configure(text_color=MUTED)
        for value in self._stat_values.values():
            value.configure(text='—')
        self._log('=' * 52)
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
        self.progress.configure(mode='determinate')
        self.progress.set(0)
        self.progress.pack_forget()

    def _finish(self, result, output: str) -> None:
        self._running = False
        self._stop_progress()
        self.button_run.configure(state='normal')
        self.button_open.configure(state='normal')
        self._last_output = output

        self._stat_values['listed'].configure(text=str(len(result.rows)))
        self._stat_values['exact'].configure(text=str(result.exact_count))
        self._stat_values['zero'].configure(text=str(len(result.zero_reservation_rows)))
        self._stat_values['orphan'].configure(text=str(len(result.orphans)))

        self._log('')
        self._log(f'掲載クーポンの取得元: {result.coupon_source}')
        self._log(f'集計対象の月号      : {" / ".join(result.issue_labels) or "(不明)"}')
        self._log(f'掲載クーポン        : {len(result.rows)}件')
        self._log(f'  うち完全一致      : {result.exact_count}件')
        self._log(f'  うちあいまい一致  : {result.fuzzy_count}件  ← 「要確認」シート')
        self._log(f'  うち予約ゼロ      : {len(result.zero_reservation_rows)}件  ← 「予約ゼロ」シート')
        renamed = sum(1 for row in result.rows if row.listing_status == '改名')
        self._log(f'  うち改名を検出    : {renamed}件')
        self._log(f'未照合の予約データ  : {len(result.orphans)}件  ← 掲載を止めた/改名したクーポン')
        for warning in result.warnings:
            self._log(f'[警告] {warning}')
        self._log(f'保存しました: {output}')

        self.status.set('完了しました。')
        self.label_status.configure(text_color=SUCCESS)

    def _fail(self, detail: str) -> None:
        self._running = False
        self._stop_progress()
        self.button_run.configure(state='normal')
        self._log(detail)
        self.status.set('エラーが発生しました。ログを確認してください。')
        self.label_status.configure(text_color=DANGER)
        messagebox.showerror('エラー', detail.strip().splitlines()[-1])


def main() -> None:
    App().mainloop()


if __name__ == '__main__':
    main()
