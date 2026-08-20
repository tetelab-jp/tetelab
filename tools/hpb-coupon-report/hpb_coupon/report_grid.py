"""サロンレポートを「セル格子(grid)」として読み取る共通ロジック。

入力がAcrobat変換xlsxでもPDF直読みでも、いったん list[list[object]] の格子に
変換してしまえば同じコードで解析できる。Acrobatのxlsx変換がやっているのは
まさに「PDFの文字を座標に従ってセルに置く」ことなので、PDFから同じ格子を
組み立てれば、xlsxで検証済みのロジックをそのまま流用できる。

レポートは月号ごとに行番号・列番号が動くため、座標は決め打ちしない。
'■クーポン別ネット予約数' というセクション見出しをアンカーにして相対的に読む。

レポートの構造(2026年07月号 sunny.西中島店で確認):
    469行目  1列:■スタイリスト別… 15列:■メニュー別… 28列:■クーポン別ネット予約数
    471行目  28列:メッセージ 30列:クーポン名 37/38/39列:05月号/06月号/07月号
             42列:メッセージ 43列:クーポン名 48/49/50列:05月号/06月号/07月号
    472行目〜 データ本体

同じ行に並ぶ '■' がセクションの横方向の区切りになるので、
'■クーポン別ネット予約数' の列以降を担当範囲とする。表は横に折り返されることが
あるので、セクション内の 'クーポン名' 見出しはすべて拾う。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

COUPON_SECTION_MARKER = '■クーポン別ネット予約数'
COUPON_INFO_MARKER = '■貴店クーポン情報'

_ISSUE_LABEL = re.compile(r'^\d{1,2}月号$')
_HEADER_NAME = 'クーポン名'
_MAX_HEADER_LOOKAHEAD = 6   # 見出し行から何行以内にヘッダ行があるか
_MAX_BLANK_RUN = 3          # 空行がこれだけ続いたら表の終わりとみなす


@dataclass
class ReservationRow:
    """クーポン1件分の予約数。"""

    name: str
    monthly: dict[str, int] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return sum(self.monthly.values())


@dataclass
class SalonReport:
    salon_name: str = ''
    issue: str = ''
    updated_at: str = ''
    issue_labels: list[str] = field(default_factory=list)
    reservations: list[ReservationRow] = field(default_factory=list)
    listed_in_report: list[tuple[str, str]] = field(default_factory=list)  # (客区分, クーポン名)
    source: str = ''
    warnings: list[str] = field(default_factory=list)


def _cell_text(value: object) -> str:
    if value is None:
        return ''
    return str(value).replace('\n', ' ').strip()


def _to_count(value: object) -> int | None:
    """予約数セルを整数にする。空欄はその月の予約が0件を意味する。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().replace(',', '')
    if not text or text in {'-', 'ー', '−'}:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def _find_marker(grid: list[list[object]], marker: str) -> tuple[int, int] | None:
    for r, row in enumerate(grid):
        for c, value in enumerate(row):
            if value is not None and marker in _cell_text(value):
                return r, c
    return None


def _section_column_range(grid: list[list[object]], row: int, col: int) -> tuple[int, int]:
    """見出し行の '■' 同士でセクションの列範囲を決める。"""
    width = max((len(r) for r in grid), default=0)
    end = width
    for c in range(col + 1, len(grid[row])):
        if _cell_text(grid[row][c]).startswith('■'):
            end = c
            break
    return col, end


def _find_header_row(
    grid: list[list[object]], start_row: int, col_start: int, col_end: int
) -> int | None:
    for r in range(start_row, min(start_row + _MAX_HEADER_LOOKAHEAD, len(grid))):
        row = grid[r]
        for c in range(col_start, min(col_end, len(row))):
            if _cell_text(row[c]) == _HEADER_NAME:
                return r
    return None


def _parse_blocks(
    header: list[object], col_start: int, col_end: int
) -> list[tuple[int, list[tuple[int, str]]]]:
    """ヘッダ行から (クーポン名の列, [(予約数の列, 月号ラベル)]) のブロック一覧を作る。"""
    name_cols = [
        c
        for c in range(col_start, min(col_end, len(header)))
        if _cell_text(header[c]) == _HEADER_NAME
    ]
    blocks: list[tuple[int, list[tuple[int, str]]]] = []
    for i, name_col in enumerate(name_cols):
        limit = name_cols[i + 1] if i + 1 < len(name_cols) else col_end
        # 次ブロックの 'メッセージ' 見出しは前ブロックの範囲に含めない
        for c in range(name_col + 1, min(limit, len(header))):
            if _cell_text(header[c]) == 'メッセージ':
                limit = c
                break
        months = [
            (c, _cell_text(header[c]))
            for c in range(name_col + 1, min(limit, len(header)))
            if _ISSUE_LABEL.match(_cell_text(header[c]))
        ]
        if months:
            blocks.append((name_col, months))
    return blocks


def _read_name(row: list[object], name_col: int, stop_col: int) -> str:
    """クーポン名を読む。セル結合のずれを考慮して名前列から数列ぶん探す。"""
    for c in range(name_col, min(stop_col, len(row))):
        text = _cell_text(row[c])
        if text and not _ISSUE_LABEL.match(text):
            return text
    return ''


def _find_reservation_anchor(
    grid: list[list[object]], allow_continuation: bool
) -> tuple[int, int, int] | None:
    """予約数表の (ヘッダ行, 開始列, 終了列) を返す。見つからなければ None。

    通常は '■クーポン別ネット予約数' の見出しを起点にする。表がページを跨いだ
    続き(見出しが無い側)については、allow_continuation=True のときに限り、
    'クーポン名' と月号列を備えたヘッダ行を直接探しにいく。
    """
    found = _find_marker(grid, COUPON_SECTION_MARKER)
    if found:
        marker_row, marker_col = found
        col_start, col_end = _section_column_range(grid, marker_row, marker_col)
        header_row = _find_header_row(grid, marker_row + 1, col_start, col_end)
        if header_row is not None:
            return header_row, col_start, col_end
        return None

    if not allow_continuation:
        return None

    width = max((len(r) for r in grid), default=0)
    for r, row in enumerate(grid):
        if any(_cell_text(v) == _HEADER_NAME for v in row) and _parse_blocks(row, 0, width):
            return r, 0, width
    return None


def parse_reservation_section(
    grid: list[list[object]], report: SalonReport, allow_continuation: bool = False
) -> None:
    """'■クーポン別ネット予約数' を読み取って report.reservations を埋める。"""
    anchor = _find_reservation_anchor(grid, allow_continuation)
    if anchor is None:
        if not allow_continuation:
            report.warnings.append(
                f'「{COUPON_SECTION_MARKER}」の見出しが見つかりませんでした。'
                'レポートのページ範囲が足りているか確認してください。'
            )
        return

    header_row, col_start, col_end = anchor
    blocks = _parse_blocks(grid[header_row], col_start, col_end)
    if not blocks:
        report.warnings.append('クーポン別ネット予約数の月号列(例: 07月号)が見つかりませんでした。')
        return

    for _, months in blocks:
        for _, label in months:
            if label not in report.issue_labels:
                report.issue_labels.append(label)

    # 同じクーポンが複数ブロック/複数ページに現れることがあるので、名前で束ねる
    seen = {row.name: row for row in report.reservations}
    blank_run = 0
    for r in range(header_row + 1, len(grid)):
        row = grid[r]
        picked_any = False
        for name_col, months in blocks:
            stop_col = months[0][0]
            name = _read_name(row, name_col, stop_col)
            if not name or name.startswith('※') or name.startswith('■'):
                continue
            picked_any = True
            monthly = {
                label: (_to_count(row[c]) if c < len(row) else None) or 0
                for c, label in months
            }
            existing = seen.get(name)
            if existing is None:
                entry = ReservationRow(name=name, monthly=monthly)
                seen[name] = entry
                report.reservations.append(entry)
            else:
                for label, count in monthly.items():
                    existing.monthly[label] = existing.monthly.get(label, 0) + count
        if picked_any:
            blank_run = 0
        else:
            blank_run += 1
            if blank_run >= _MAX_BLANK_RUN:
                break


def parse_listed_section(grid: list[list[object]], report: SalonReport) -> None:
    """'■貴店クーポン情報(Net)' の最新月号列を読み取る(スクレイピング結果の照合用)。

    このセクションは登録数順の上位60件しか載らず、価格も掲載順も無いので、
    掲載クーポン一覧の代わりにはならない。スクレイピングの取りこぼし検知に使う。
    """
    from .normalize import split_customer_type

    found = _find_marker(grid, COUPON_INFO_MARKER)
    if not found:
        return
    marker_row, marker_col = found
    col_start, col_end = _section_column_range(grid, marker_row, marker_col)

    header_row = None
    issue_cols: list[tuple[int, str]] = []
    for r in range(marker_row + 1, min(marker_row + _MAX_HEADER_LOOKAHEAD, len(grid))):
        cols = [
            (c, _cell_text(grid[r][c]))
            for c in range(col_start, min(col_end, len(grid[r])))
            if _ISSUE_LABEL.match(_cell_text(grid[r][c]))
        ]
        if cols:
            header_row = r
            issue_cols = cols
            break
    if header_row is None or not issue_cols:
        return

    latest_col = issue_cols[-1][0]  # 一番右が最新月号
    blank_run = 0
    for r in range(header_row + 1, len(grid)):
        row = grid[r]
        text = _cell_text(row[latest_col]) if latest_col < len(row) else ''
        if not text or text.startswith('※') or text.startswith('■'):
            blank_run += 1
            if blank_run >= _MAX_BLANK_RUN:
                break
            continue
        blank_run = 0
        report.listed_in_report.append(split_customer_type(text))


def parse_metadata(grid: list[list[object]], report: SalonReport) -> None:
    """貴店名・ご掲載月号・データ最終更新日を拾う。

    ラベルと値が同じ行に並ぶ場合(貴店名)と、ラベルの直下に値が来る場合
    (データ最終更新日)の両方がある。
    """
    labels = {'貴店名': 'salon_name', 'ご掲載月号': 'issue', 'データ最終更新日': 'updated_at'}
    for r, row in enumerate(grid[:6]):
        for c, value in enumerate(row):
            key = _cell_text(value)
            if key not in labels or getattr(report, labels[key]):
                continue
            for c2 in range(c + 1, min(c + 8, len(row))):
                text = _cell_text(row[c2])
                if text:
                    setattr(report, labels[key], text)
                    break
            else:
                # 同じ行に無ければ直下の行の同じ列を見る
                for r2 in range(r + 1, min(r + 3, len(grid))):
                    if c < len(grid[r2]):
                        text = _cell_text(grid[r2][c])
                        if text and text not in labels:
                            setattr(report, labels[key], text)
                            break


def parse_grid(
    grid: list[list[object]], report: SalonReport, allow_continuation: bool = False
) -> bool:
    """1ページ分/1シート分の格子を解析して report に足し込む。

    予約数を1件でも読めたら True を返す。False なら呼び出し側が次のページ/
    シートを試す。allow_continuation=True にすると、見出しの無い「表の続き」の
    ページも拾いにいく(PDFで表がページを跨いだ場合に使う)。
    """
    if not grid:
        return False
    before = len(report.reservations)
    parse_metadata(grid, report)
    if _find_marker(grid, COUPON_SECTION_MARKER) or allow_continuation:
        parse_reservation_section(grid, report, allow_continuation=allow_continuation)
    parse_listed_section(grid, report)
    return len(report.reservations) > before
