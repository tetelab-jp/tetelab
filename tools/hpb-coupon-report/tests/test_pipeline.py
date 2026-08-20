"""レポート読み取り〜照合〜出力までの通しの検証。"""

from openpyxl import load_workbook

from fixtures import (
    ISSUE_LABELS,
    RESERVED_COUPONS,
    SAMPLE_COUPONS,
    build_coupon_html,
    write_report_xlsx,
)
from hpb_coupon.excel_out import write_workbook
from hpb_coupon.pipeline import reconcile
from hpb_coupon.scrape import parse_coupon_html


def _write_inputs(tmp_path):
    report = write_report_xlsx(str(tmp_path / 'report.xlsx'))
    html = tmp_path / 'coupon.html'
    html.write_text(build_coupon_html(), encoding='utf-8')
    return report, str(html)


def test_クーポンHTMLからは価格と掲載順が取れる():
    coupons = parse_coupon_html(build_coupon_html())
    assert len(coupons) == len(SAMPLE_COUPONS)
    assert coupons[0].order == 1
    assert coupons[0].customer_type == SAMPLE_COUPONS[0][0]
    assert coupons[0].name == SAMPLE_COUPONS[0][1]
    assert coupons[0].price == 8100
    assert coupons[0].conditions == '他券併用不可1'


def test_掲載クーポン基準で予約数が並ぶ(tmp_path):
    report, html = _write_inputs(tmp_path)
    result = reconcile(report_path=report, coupon_html_paths=[html])

    assert len(result.rows) == len(SAMPLE_COUPONS)
    assert result.issue_labels == ISSUE_LABELS
    # 表記ゆれはすべて完全一致として吸収される
    assert result.exact_count == len(RESERVED_COUPONS)
    assert result.fuzzy_count == 0
    # 予約が多い順に並ぶ
    assert [r.total for r in result.rows] == sorted(
        [r.total for r in result.rows], reverse=True
    )
    assert result.rows[0].total == sum(RESERVED_COUPONS[0][2])
    assert result.rows[0].price == 8100


def test_予約ゼロの掲載クーポンが抽出される(tmp_path):
    report, html = _write_inputs(tmp_path)
    result = reconcile(report_path=report, coupon_html_paths=[html])
    zero = result.zero_reservation_rows
    assert len(zero) == 1
    assert zero[0].listed_name.startswith('ヘッドスパ15分')
    assert zero[0].method == 'unmatched'


def test_レポートだけでも照合できる(tmp_path):
    """サロンURLもHTMLも渡さない=通信なしの経路。"""
    report = write_report_xlsx(str(tmp_path / 'report.xlsx'))
    result = reconcile(report_path=report)
    assert 'レポート内' in result.coupon_source
    assert len(result.rows) == len(SAMPLE_COUPONS)
    assert result.exact_count == len(RESERVED_COUPONS)
    # レポート内の一覧には価格が無い
    assert all(row.price is None for row in result.rows)


def test_掲載していないクーポンの予約は未照合に回る(tmp_path):
    report, html = _write_inputs(tmp_path)
    # 1件を掲載一覧から外す = 掲載を止めたクーポンの予約が残っている状態
    trimmed = build_coupon_html().replace(SAMPLE_COUPONS[1][1], 'まったく別の名前のクーポン')
    other = tmp_path / 'trimmed.html'
    other.write_text(trimmed, encoding='utf-8')

    result = reconcile(report_path=report, coupon_html_paths=[str(other)])
    assert len(result.orphans) == 1
    assert result.orphans[0].name.startswith('カット+縮毛矯正')
    assert result.orphans[0].total == sum(RESERVED_COUPONS[1][2])


def test_出力xlsxのシート構成と件数(tmp_path):
    report, html = _write_inputs(tmp_path)
    result = reconcile(report_path=report, coupon_html_paths=[html])
    output = write_workbook(result, str(tmp_path / 'out.xlsx'))

    workbook = load_workbook(output)
    assert workbook.sheetnames == ['照合結果', '予約ゼロ', '未照合の予約', '要確認', '実行情報']

    match_sheet = workbook['照合結果']
    headers = [cell.value for cell in match_sheet[1]]
    assert headers[:4] == ['掲載順', '客区分', 'クーポン名(掲載)', '価格']
    for label in ISSUE_LABELS:
        assert label in headers
    assert match_sheet.max_row == len(SAMPLE_COUPONS) + 1
    assert workbook['予約ゼロ'].max_row == 2

    info = {row[0]: row[1] for row in workbook['実行情報'].iter_rows(min_row=2, values_only=True)}
    assert info['完全一致'] == len(RESERVED_COUPONS)
    assert info['予約数の総計'] == sum(sum(c[2]) for c in RESERVED_COUPONS)
