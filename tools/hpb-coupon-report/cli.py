"""HPBクーポン予約数 照合ツール(コマンドライン)。

GUIを開かずに同じ処理を実行する。定期実行やバッチ処理に使う。

    python cli.py --report サロンレポート.pdf
    python cli.py --report レポート.xlsx --url https://beauty.hotpepper.jp/slnH000548746/
    python cli.py --report レポート.pdf --html coupon1.html coupon2.html --out 結果.xlsx
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from hpb_coupon.excel_out import write_workbook  # noqa: E402
from hpb_coupon.pipeline import reconcile  # noqa: E402


def default_output(report_path: str) -> str:
    stem = os.path.splitext(os.path.basename(report_path))[0]
    stamp = datetime.now().strftime('%Y%m%d_%H%M')
    return os.path.join(
        os.path.dirname(os.path.abspath(report_path)), f'{stem}_クーポン照合_{stamp}.xlsx'
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='サロンレポートの「クーポン別ネット予約数」と掲載クーポンを照合してxlsxに出力します。'
    )
    parser.add_argument('--report', required=True, help='サロンレポート(.pdf / .xlsx)')
    parser.add_argument(
        '--url',
        default='',
        help='HPBのサロンURL。指定するとクーポン一覧をスクレイピングします(価格・掲載順が付きます)',
    )
    parser.add_argument(
        '--html',
        nargs='*',
        default=None,
        help='保存済みのクーポンページHTML。--url の代わりに使えます',
    )
    parser.add_argument('--out', default='', help='出力先xlsx(省略時はレポートと同じ場所)')
    parser.add_argument(
        '--threshold',
        type=float,
        default=0.55,
        help='あいまい一致の下限。これ未満の組み合わせは対応なしにします(既定: 0.55)',
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not os.path.exists(args.report):
        print(f'レポートが見つかりません: {args.report}', file=sys.stderr)
        return 1

    result = reconcile(
        report_path=args.report,
        salon_url=args.url,
        coupon_html_paths=args.html,
        threshold=args.threshold,
        progress=lambda message: print(f'  {message}'),
    )
    output = write_workbook(result, args.out or default_output(args.report))

    print()
    print(f'掲載クーポンの取得元: {result.coupon_source}')
    print(f'集計対象の月号      : {" / ".join(result.issue_labels) or "(不明)"}')
    print(f'掲載クーポン        : {len(result.rows)}件')
    print(f'  完全一致          : {result.exact_count}件')
    print(f'  あいまい一致      : {result.fuzzy_count}件')
    print(f'  予約ゼロ          : {len(result.zero_reservation_rows)}件')
    print(f'未照合の予約データ  : {len(result.orphans)}件')
    for warning in result.warnings:
        print(f'[警告] {warning}')
    print(f'保存しました: {output}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
