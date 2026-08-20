"""レポート読み取り → クーポン取得 → 照合 の一連の流れ。

GUI(app.py)もCLI(cli.py)もここを呼ぶだけにして、画面まわりと処理を分けている。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from .matching import match_coupons
from .normalize import normalize_coupon_name
from .report_grid import ReservationRow, SalonReport
from .report_pdf import parse_report_pdf
from .report_xlsx import parse_report_xlsx
from .scrape import ListedCoupon, ScrapeResult, load_coupons_from_html_files, scrape_coupons


@dataclass
class ReconcileRow:
    """出力1行。掲載クーポン1件と、それに対応づいた予約データ。"""

    order: int
    customer_type: str
    listed_name: str
    price: int | None
    price_text: str
    reserved_name: str = ''
    monthly: dict[str, int] = field(default_factory=dict)
    total: int = 0
    score: float | None = None
    method: str = 'unmatched'  # 'exact' | 'fuzzy' | 'unmatched'

    @property
    def has_reservation(self) -> bool:
        return self.method != 'unmatched'


@dataclass
class OrphanReservation:
    """予約実績はあるが、現在の掲載クーポンに見当たらないもの。"""

    name: str
    monthly: dict[str, int] = field(default_factory=dict)
    total: int = 0


@dataclass
class ReconcileResult:
    rows: list[ReconcileRow] = field(default_factory=list)
    orphans: list[OrphanReservation] = field(default_factory=list)
    issue_labels: list[str] = field(default_factory=list)
    report: SalonReport | None = None
    scrape: ScrapeResult | None = None
    coupon_source: str = ''
    executed_at: str = ''
    warnings: list[str] = field(default_factory=list)

    @property
    def exact_count(self) -> int:
        return sum(1 for r in self.rows if r.method == 'exact')

    @property
    def fuzzy_count(self) -> int:
        return sum(1 for r in self.rows if r.method == 'fuzzy')

    @property
    def zero_reservation_rows(self) -> list[ReconcileRow]:
        """掲載中だが予約実績が無いクーポン。差し替え・書き換えの検討対象。"""
        return [r for r in self.rows if r.total == 0]

    @property
    def needs_review_rows(self) -> list[ReconcileRow]:
        """完全一致しなかった対応。人が見て正しいか確かめる価値がある行。"""
        return [r for r in self.rows if r.method == 'fuzzy']


def load_report(path: str) -> SalonReport:
    """拡張子からPDF/xlsxを判定してレポートを読む。"""
    lowered = path.lower()
    if lowered.endswith('.pdf'):
        return parse_report_pdf(path)
    if lowered.endswith(('.xlsx', '.xlsm')):
        return parse_report_xlsx(path)
    raise ValueError(f'対応していないファイル形式です: {path}')


def coupons_from_report(report: SalonReport) -> list[ListedCoupon]:
    """スクレイピングを使わず、レポート内の掲載クーポン一覧を代用する。

    「■貴店クーポン情報(Net)」の最新月号列。価格と掲載順は取れない。
    登録数順の上位60件までという制限があるので、60件に達している場合は
    取りこぼしの可能性を警告する(呼び出し側で判定)。
    """
    return [
        ListedCoupon(order=i, customer_type=customer_type, name=name)
        for i, (customer_type, name) in enumerate(report.listed_in_report, 1)
    ]


def reconcile(
    report_path: str,
    salon_url: str = '',
    coupon_html_paths: list[str] | None = None,
    threshold: float = 0.55,
    progress=None,
) -> ReconcileResult:
    """レポートと掲載クーポンを突き合わせる。

    掲載クーポンの取得元は次の優先順位で決まる。
      1. salon_url が指定されていればHPBをスクレイピング(価格・掲載順が取れる)
      2. coupon_html_paths が指定されていれば保存済みHTMLから読む
      3. どちらも無ければレポート内の「■貴店クーポン情報(Net)」を使う
    """
    def notify(message: str) -> None:
        if progress:
            progress(message)

    result = ReconcileResult(executed_at=datetime.now().strftime('%Y-%m-%d %H:%M:%S'))

    notify(f'レポートを読み込んでいます: {report_path}')
    report = load_report(report_path)
    result.report = report
    result.issue_labels = list(report.issue_labels)
    result.warnings.extend(report.warnings)

    if salon_url:
        result.scrape = scrape_coupons(salon_url, progress=progress)
        listed = result.scrape.coupons
        result.coupon_source = f'HPBスクレイピング ({result.scrape.salon_url})'
        result.warnings.extend(result.scrape.warnings)
        if not listed:
            notify('スクレイピングで取得できなかったため、レポート内の掲載一覧を使います。')
            listed = coupons_from_report(report)
            result.coupon_source = 'レポート内「■貴店クーポン情報(Net)」(スクレイピング失敗のため)'
    elif coupon_html_paths:
        result.scrape = load_coupons_from_html_files(coupon_html_paths)
        listed = result.scrape.coupons
        result.coupon_source = f'保存済みHTML {len(coupon_html_paths)}件'
        result.warnings.extend(result.scrape.warnings)
    else:
        listed = coupons_from_report(report)
        result.coupon_source = 'レポート内「■貴店クーポン情報(Net)」'
        if len(listed) >= 60:
            result.warnings.append(
                'レポート内の掲載クーポン一覧が60件に達しています。この欄は登録数順の'
                '上位60件までしか載らないため、掲載クーポンを取りこぼしている可能性が'
                'あります。サロンURLを指定してスクレイピングすると全件取得できます。'
            )

    if not listed:
        result.warnings.append('掲載クーポンを1件も取得できませんでした。')
        return result

    notify(f'照合中: 掲載 {len(listed)}件 / 予約データ {len(report.reservations)}件')
    matched = match_coupons(
        [c.name for c in listed],
        [r.name for r in report.reservations],
        threshold=threshold,
    )

    by_listed: dict[int, tuple[ReservationRow, float, str]] = {}
    for pair in matched.pairs:
        if pair.listed_index is None or pair.reserved_index is None:
            continue
        by_listed[pair.listed_index] = (
            report.reservations[pair.reserved_index],
            pair.score,
            pair.method,
        )

    for index, coupon in enumerate(listed):
        row = ReconcileRow(
            order=coupon.order,
            customer_type=coupon.customer_type,
            listed_name=coupon.name,
            price=coupon.price,
            price_text=coupon.price_text,
        )
        found = by_listed.get(index)
        if found:
            reservation, score, method = found
            row.reserved_name = reservation.name
            row.monthly = dict(reservation.monthly)
            row.total = reservation.total
            row.score = score
            row.method = method
        else:
            row.monthly = {label: 0 for label in result.issue_labels}
        result.rows.append(row)

    for r_idx in matched.unmatched_reserved:
        reservation = report.reservations[r_idx]
        result.orphans.append(
            OrphanReservation(
                name=reservation.name,
                monthly=dict(reservation.monthly),
                total=reservation.total,
            )
        )

    # 掲載一覧をスクレイピングで取った場合、レポート内の一覧と照らして
    # 取りこぼしが無いか確かめる(どちらかが古い/欠けていると差が出る)
    if result.scrape and report.listed_in_report:
        scraped_keys = {normalize_coupon_name(c.name) for c in listed}
        report_keys = {normalize_coupon_name(n) for _, n in report.listed_in_report}
        missing = report_keys - scraped_keys
        if missing:
            result.warnings.append(
                f'レポートに載っているのにスクレイピングで取れなかったクーポンが'
                f'{len(missing)}件あります。掲載を止めた直後か、ページ送りが'
                f'途中で終わった可能性があります。'
            )

    result.rows.sort(key=lambda r: (-r.total, r.order))
    result.orphans.sort(key=lambda o: -o.total)
    return result
