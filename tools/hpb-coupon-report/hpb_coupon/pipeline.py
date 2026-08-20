"""レポート読み取り → クーポン取得 → 照合 の一連の流れ。

GUI(app.py)もCLI(cli.py)もここを呼ぶだけにして、画面まわりと処理を分けている。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime

from .matching import hungarian, match_coupons, similarity
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
    listing_status: str = ''    # '継続' | '新規掲載' | '改名'
    first_listed_month: str = ''
    previous_name: str = ''     # 改名前の名前
    previous_month: str = ''    # その名前で載っていた最後の月号
    rename_score: float | None = None

    @property
    def has_reservation(self) -> bool:
        return self.method != 'unmatched'


@dataclass
class OrphanReservation:
    """予約実績はあるが、現在の掲載クーポンに見当たらないもの。"""

    name: str
    monthly: dict[str, int] = field(default_factory=dict)
    total: int = 0
    last_listed_month: str = ''   # 掲載履歴の中で最後に載っていた月号
    rename_candidate: str = ''    # 改名先と思われる現在の掲載クーポン
    rename_score: float | None = None


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


def suggest_output_path(report_path: str, now: datetime | None = None) -> str:
    """レポートのファイル名から、出力先の既定値を組み立てる。

    レポートと同じフォルダに「<レポート名>_クーポン照合_<日時>.xlsx」を置く。
    日時を入れるのは、同じレポートを繰り返し処理したときに前回の出力を
    黙って上書きしないため。
    """
    stem = os.path.splitext(os.path.basename(report_path))[0]
    stamp = (now or datetime.now()).strftime('%Y%m%d_%H%M')
    folder = os.path.dirname(os.path.abspath(report_path))
    return os.path.join(folder, f'{stem}_クーポン照合_{stamp}.xlsx')


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


# 改名とみなす一致率の下限。予約データの照合(0.55)より高くしてある。
# 実データの02月号→03月号の一斉リニューアル(22件入れ替え)で測ったところ、
# 本物の改名は0.767以上(誤植修正0.971、「ブリーチ+カラー」→「ブリーチオンカラー」0.947、
# 割引表記の削除0.800 など)、0.708以下は中身の違う別クーポンだった。
RENAME_THRESHOLD = 0.75


def _detect_renames(
    history: list[tuple[str, dict[str, str]]], threshold: float
) -> dict[tuple[int, str], tuple[str, float]]:
    """隣り合う月号の間で「消えた名前」と「現れた名前」を1対1に対応づける。

    戻り値は (月号のindex, 新しいキー) → (古いキー, 一致率)。

    ここでもハンガリー法を使う。「現れた名前ごとに最も似た消えた名前を選ぶ」
    貪欲法だと、1つの古い名前が複数の新クーポンの旧名として使い回されてしまう
    (実データでは「【平日限定】カット+艶カラー」が3件に割り当てられた)。
    """
    links: dict[tuple[int, str], tuple[str, float]] = {}
    for i in range(len(history) - 1):
        old_names, new_names = history[i][1], history[i + 1][1]
        gone = [k for k in old_names if k not in new_names]
        appeared = [k for k in new_names if k not in old_names]
        if not gone or not appeared:
            continue
        scores = [[similarity(g, n) for n in appeared] for g in gone]
        assignment = hungarian([[-s for s in row] for row in scores])
        for g_idx, a_idx in enumerate(assignment):
            if a_idx < 0:
                continue
            score = scores[g_idx][a_idx]
            if score >= threshold:
                links[(i + 1, appeared[a_idx])] = (gone[g_idx], score)
    return links


def _annotate_listing_history(
    result: ReconcileResult, rename_threshold: float = RENAME_THRESHOLD
) -> None:
    """レポートの月号別の掲載一覧を使って、各行に掲載履歴の情報を足す。

    「■貴店クーポン情報(Net)」は月号ごとの列を持っていて(実物では6ヶ月分)、
    各列がその月の掲載クーポン一覧になっている。ここから
      ・いつから載っているクーポンか
      ・途中で名前が変わっていないか
      ・予約はあるのに今は載っていないクーポンが、いつまで載っていたか
    が分かる。

    予約数そのものの照合には使わない。レポートの予約数表は「クーポン名1列＋
    月号3列」という作りで月号ごとの名前を持たず、HPB側が既にクーポンの同一性を
    解決したうえで1つの名前に3ヶ月分をまとめているため、現在の掲載名と
    突き合わせれば足りる(実データで各月とも不一致0件を確認済み)。
    """
    report = result.report
    if report is None or not report.listed_history:
        return

    history = [  # 古い月号から順に、正規化キー → 表示名
        (label, {normalize_coupon_name(name): name for _, name in coupons})
        for label, coupons in report.listed_history
    ]
    links = _detect_renames(history, rename_threshold)
    last_index = len(history) - 1

    for row in result.rows:
        key = normalize_coupon_name(row.listed_name)
        if not any(key in names for _, names in history):
            continue  # スクレイピングで取れたがレポートには無い(60件制限など)

        index = last_index
        while index >= 0 and key not in history[index][1]:
            index -= 1  # 掲載を止めた直後などで最新月号に無い場合
        if index < 0:
            continue

        # 改名の連鎖を遡って、最初に載った月号までたどる
        while True:
            while index > 0 and key in history[index - 1][1]:
                index -= 1
            link = links.get((index, key))
            if link is None:
                break
            old_key, score = link
            if not row.previous_name:  # 直前の1回ぶんだけ記録する
                row.previous_name = history[index - 1][1][old_key]
                row.previous_month = history[index - 1][0]
                row.rename_score = round(score, 4)
            key = old_key
            index -= 1

        row.first_listed_month = history[index][0]
        if row.previous_name:
            row.listing_status = '改名'
        elif index == 0:
            row.listing_status = '継続'
        else:
            row.listing_status = '新規掲載'

    for orphan in result.orphans:
        key = normalize_coupon_name(orphan.name)
        for label, names in reversed(history):
            if key in names:
                orphan.last_listed_month = label
                break
        candidates = [
            (similarity(key, normalize_coupon_name(row.listed_name)), row.listed_name)
            for row in result.rows
        ]
        best = max(candidates, default=(0.0, ''))
        if best[0] >= rename_threshold:
            orphan.rename_candidate = best[1]
            orphan.rename_score = round(best[0], 4)


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

    _annotate_listing_history(result)

    result.rows.sort(key=lambda r: (-r.total, r.order))
    result.orphans.sort(key=lambda o: -o.total)
    return result
