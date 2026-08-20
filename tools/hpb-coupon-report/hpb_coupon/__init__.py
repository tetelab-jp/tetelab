"""HPBクーポン予約数 照合ツール(ローカル完結)。

サロンボードのレポート(PDF/Acrobat変換xlsx)から「クーポン別ネット予約数」を、
HPB公開ページから「現在の掲載クーポン一覧」を取得し、両者を突き合わせて
xlsxに出力する。サーバーは立てず、すべて実行端末内で完結する。
"""

__all__ = [
    'normalize',
    'matching',
    'report_xlsx',
    'report_pdf',
    'scrape',
    'excel_out',
    'pipeline',
]
