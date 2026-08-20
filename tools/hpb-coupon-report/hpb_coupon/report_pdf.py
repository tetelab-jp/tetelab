"""サロンレポートPDFを直接読み取る(Acrobat変換を不要にする経路)。

やっていることは Acrobat の xlsx 変換と同じで、「PDF内の文字を座標に従って
セルに置き直す」だけ。行はY座標で、列はX座標でクラスタリングして格子を作り、
あとは report_grid.py の解析ロジックに渡す。xlsx経路と同じコードを通るので、
検証済みの読み取り規則がそのまま効く。

副次的な利点として、Acrobat変換で混入していた表記ゆれ(全角'￥'が'\\'になる等)が
発生しない、あるいは発生の仕方が変わる可能性がある。いずれにせよ normalize.py が
吸収するので、照合精度には影響しない。
"""

from __future__ import annotations

from bisect import bisect_right

from .report_grid import SalonReport, parse_grid

# 座標クラスタリングの許容幅(ポイント)。レポートは9pt前後の文字なので、
# 行は3pt、列は4ptを目安にすると本文行と表の列がきれいに分かれる。
ROW_TOLERANCE = 3.0
COLUMN_TOLERANCE = 4.0


def _cluster_starts(values: list[float], tolerance: float) -> list[float]:
    """近接する座標をまとめ、各グループの開始座標を返す。"""
    starts: list[float] = []
    for value in sorted(values):
        if not starts or value - starts[-1] > tolerance:
            starts.append(value)
    return starts


def page_to_grid(page) -> list[list[object]]:
    """pdfplumberのPageを list[list[str|None]] の格子に変換する。"""
    words = page.extract_words(
        keep_blank_chars=False,
        use_text_flow=False,
        x_tolerance=1.5,
        y_tolerance=2.0,
    )
    if not words:
        return []

    column_starts = _cluster_starts([w['x0'] for w in words], COLUMN_TOLERANCE)
    row_starts = _cluster_starts([w['top'] for w in words], ROW_TOLERANCE)
    if not column_starts or not row_starts:
        return []

    cells: dict[tuple[int, int], list[tuple[float, str]]] = {}
    for word in words:
        r = max(0, bisect_right(row_starts, word['top']) - 1)
        c = max(0, bisect_right(column_starts, word['x0']) - 1)
        cells.setdefault((r, c), []).append((word['x0'], word['text']))

    grid: list[list[object]] = [
        [None] * len(column_starts) for _ in range(len(row_starts))
    ]
    for (r, c), parts in cells.items():
        # 日本語は語間に空白が無いので、同一セル内は詰めて連結する
        grid[r][c] = ''.join(text for _, text in sorted(parts))
    return grid


def parse_report_pdf(path: str) -> SalonReport:
    """サロンボードのレポートPDFを読み取る。

    pdfplumber が必要。未インストールなら、その旨を warnings に入れて空の
    SalonReport を返す(GUI側でxlsx経路を案内する)。
    """
    report = SalonReport(source=path)
    try:
        import pdfplumber
    except ImportError:
        report.warnings.append(
            'pdfplumber が入っていないため、PDFを直接読み取れません。'
            'requirements.txt を入れ直すか、Acrobat変換したxlsxを指定してください。'
        )
        return report

    with pdfplumber.open(path) as pdf:
        found_page = False
        for page in pdf.pages:
            grid = page_to_grid(page)
            if not grid:
                continue
            # 表の続きを拾うのは、見出しのあるページを見つけた直後だけに限定する。
            # 無条件に許すと、無関係なページの表を予約数として取り込みかねない。
            parsed = parse_grid(grid, report, allow_continuation=found_page)
            if parsed:
                found_page = True

    if not report.reservations:
        report.warnings.append(
            'PDFから「■クーポン別ネット予約数」を読み取れませんでした。'
            'スキャン画像のPDF(文字情報を持たないPDF)の可能性があります。'
            'その場合はAcrobat変換したxlsxを指定してください。'
        )
    # 見出しが無いページで出た警告は、他ページで読めていれば意味がないので消す
    if report.reservations:
        report.warnings = [w for w in report.warnings if '見出しが見つかりません' not in w]
    return report
