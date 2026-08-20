"""レポート読み取りの検証(xlsx経路とPDF直読み経路)。"""

import pytest

from fixtures import (
    ISSUE,
    ISSUE_LABELS,
    REPORTED_NAMES,
    RESERVED_COUPONS,
    SALON_NAME,
    SAMPLE_COUPONS,
    build_grid,
    write_report_pdf,
    write_report_xlsx,
)
from hpb_coupon.report_grid import SalonReport, parse_grid
from hpb_coupon.report_pdf import parse_report_pdf
from hpb_coupon.report_xlsx import parse_report_xlsx


def _assert_report_ok(report: SalonReport) -> None:
    assert report.issue_labels == ISSUE_LABELS
    assert len(report.reservations) == len(RESERVED_COUPONS)
    totals = {row.name: row.total for row in report.reservations}
    for _, name, counts in RESERVED_COUPONS:
        reported = REPORTED_NAMES.get(name, name)
        assert reported in totals, f'{reported} がレポートから読めていない'
        assert totals[reported] == sum(counts)


def test_格子から予約数を読み取れる():
    report = SalonReport()
    assert parse_grid(build_grid(), report)
    _assert_report_ok(report)
    assert report.salon_name == SALON_NAME
    assert report.issue == ISSUE
    assert len(report.listed_in_report) == len(SAMPLE_COUPONS)


def test_予約数は月ごとに読み分けられる():
    report = SalonReport()
    parse_grid(build_grid(), report)
    first = report.reservations[0]
    assert first.monthly == dict(zip(ISSUE_LABELS, RESERVED_COUPONS[0][2]))


def test_注記行で表の読み取りが止まる():
    report = SalonReport()
    parse_grid(build_grid(), report)
    assert not any(row.name.startswith('※') for row in report.reservations)


def test_見出しが無ければ警告を出す(tmp_path):
    from openpyxl import Workbook

    workbook = Workbook()
    workbook.active.append(['クーポンの表が無いシート'])
    path = str(tmp_path / 'empty.xlsx')
    workbook.save(path)

    report = parse_report_xlsx(path)
    assert report.reservations == []
    assert any('見つかりませんでした' in w for w in report.warnings)


def test_見出しの無い格子は解析されない():
    report = SalonReport()
    assert not parse_grid([[None, 'なにもない'], [None, None]], report)
    assert report.reservations == []


def test_xlsx経路(tmp_path):
    path = write_report_xlsx(str(tmp_path / 'report.xlsx'))
    report = parse_report_xlsx(path)
    _assert_report_ok(report)
    assert report.warnings == []


def test_pdf直読み経路(tmp_path):
    pytest.importorskip('reportlab', reason='テスト用PDFの生成に必要')
    pytest.importorskip('pdfplumber', reason='PDF直読みに必要')
    path = write_report_pdf(str(tmp_path / 'report.pdf'))
    report = parse_report_pdf(path)
    _assert_report_ok(report)
    assert report.warnings == []


def test_pdfとxlsxで同じ結果になる(tmp_path):
    pytest.importorskip('reportlab', reason='テスト用PDFの生成に必要')
    pytest.importorskip('pdfplumber', reason='PDF直読みに必要')
    from_xlsx = parse_report_xlsx(write_report_xlsx(str(tmp_path / 'r.xlsx')))
    from_pdf = parse_report_pdf(write_report_pdf(str(tmp_path / 'r.pdf')))
    assert {r.name: r.total for r in from_xlsx.reservations} == {
        r.name: r.total for r in from_pdf.reservations
    }
