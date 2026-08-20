"""HPB公開ページから現在の掲載クーポン一覧を取得する。

セレクタは既存の Scrape_coupon_TOP_menu_rsv_ver2.1.py と同じものを使う:

    div.usingPointToggle           クーポン1件のまとまり
    .couponLabelCT01/02/03         客区分(新規/全員 など)
    .couponMenuName                クーポン名
    .couponMenuPrice               価格
    .couponMenuIcons               アイコン(こだわり)
    .couponDescription             説明
    .couponConditionsList dd       利用条件

既存スクリプトは Selenium(headless Chrome)を使っているが、クーポン一覧ページは
サーバ側で描画された静的HTMLなので、requests だけで同じDOMが取れる。
ChromeDriverのバージョン追従から解放されるぶん、端末完結のツールとしては
こちらのほうが壊れにくい。JSが必要なのは予約ページの施術時間だけで、
クーポン予約数の照合には使わないため取得しない。

ネットワークを使わずに済むよう、保存したHTMLから読む経路も用意してある
(社内ネットワークでHPBが弾かれる場合や、セレクタが変わったときの逃げ道)。
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from bs4 import BeautifulSoup

USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
)
DEFAULT_DELAY_SEC = 1.5   # ページ送りの間隔(サイトに優しく・弾かれ軽減)
DEFAULT_MAX_PAGES = 10    # 1ページ20件想定。200件を超えるサロンは想定しない
REQUEST_TIMEOUT_SEC = 30

_COUPON_CONTAINER = 'div.usingPointToggle'
_LABEL_CLASSES = ('couponLabelCT01', 'couponLabelCT02', 'couponLabelCT03')
_SLN_ID = re.compile(r'/(sln[A-Za-z0-9]+)/?')
_PRICE_DIGITS = re.compile(r'(\d[\d,]*)')


@dataclass
class ListedCoupon:
    """HPBに現在掲載されているクーポン1件。"""

    order: int          # 掲載順(ページ上から数えた通し番号)
    customer_type: str  # 客区分(新規/全員 など)
    name: str
    price_text: str = ''
    price: int | None = None
    icons: str = ''
    description: str = ''
    conditions: str = ''


@dataclass
class ScrapeResult:
    salon_url: str = ''
    coupons: list[ListedCoupon] = field(default_factory=list)
    pages_fetched: int = 0
    warnings: list[str] = field(default_factory=list)


def normalize_salon_url(value: str) -> str:
    """サロンURLまたはサロンIDを、末尾スラッシュ付きのトップURLに整える。"""
    text = (value or '').strip()
    if not text:
        raise ValueError('サロンURLが空です。')
    if not text.startswith('http'):
        # 'slnH000548746' や 'H000548746' のようなID直接指定にも対応する
        sln = text if text.lower().startswith('sln') else f'sln{text}'
        return f'https://beauty.hotpepper.jp/{sln}/'
    match = _SLN_ID.search(text)
    if match:
        return f'https://beauty.hotpepper.jp/{match.group(1)}/'
    return text.rstrip('/') + '/'


def coupon_page_urls(salon_url: str, max_pages: int = DEFAULT_MAX_PAGES) -> list[str]:
    base = salon_url.rstrip('/') + '/coupon/'
    return [base] + [f'{base}PN{i}.html' for i in range(2, max_pages + 1)]


def _text(node) -> str:
    return node.get_text(strip=True) if node else ''


def _parse_price(text: str) -> int | None:
    match = _PRICE_DIGITS.search(text or '')
    if not match:
        return None
    try:
        return int(match.group(1).replace(',', ''))
    except ValueError:
        return None


def parse_coupon_html(html: str, start_order: int = 1) -> list[ListedCoupon]:
    """クーポン一覧ページのHTMLからクーポンを抽出する。"""
    soup = BeautifulSoup(html, 'html.parser')
    coupons: list[ListedCoupon] = []
    for i, container in enumerate(soup.select(_COUPON_CONTAINER)):
        label = next(
            (
                container.select_one(f'.{cls}')
                for cls in _LABEL_CLASSES
                if container.select_one(f'.{cls}')
            ),
            None,
        )
        name = _text(container.select_one('.couponMenuName'))
        if not name:
            continue
        price_text = _text(container.select_one('.couponMenuPrice'))
        conditions = container.select('.couponConditionsList dd')
        coupons.append(
            ListedCoupon(
                order=start_order + i,
                customer_type=_text(label),
                name=name,
                price_text=price_text,
                price=_parse_price(price_text),
                icons=_text(container.select_one('.couponMenuIcons')),
                description=_text(container.select_one('.couponDescription')),
                conditions=_text(conditions[2]) if len(conditions) >= 3 else '',
            )
        )
    return coupons


def scrape_coupons(
    salon_url: str,
    max_pages: int = DEFAULT_MAX_PAGES,
    delay_sec: float = DEFAULT_DELAY_SEC,
    progress=None,
) -> ScrapeResult:
    """HPBのクーポン一覧を1ページ目からたどって全件取得する。"""
    import requests

    top = normalize_salon_url(salon_url)
    result = ScrapeResult(salon_url=top)
    session = requests.Session()
    session.headers.update({'User-Agent': USER_AGENT, 'Accept-Language': 'ja,en;q=0.8'})

    seen_names: set[str] = set()
    for page_no, url in enumerate(coupon_page_urls(top, max_pages), 1):
        if progress:
            progress(f'クーポンページ取得中 ({page_no}ページ目): {url}')
        if page_no > 1 and delay_sec > 0:
            time.sleep(delay_sec)
        try:
            response = session.get(url, timeout=REQUEST_TIMEOUT_SEC)
        except Exception as exc:  # ネットワーク断・タイムアウト等
            result.warnings.append(f'{url} の取得に失敗しました: {exc}')
            break
        if response.status_code == 404:
            break  # ページ送りの終端
        if response.status_code != 200:
            result.warnings.append(f'{url} が HTTP {response.status_code} を返しました。')
            break

        response.encoding = response.apparent_encoding or 'utf-8'
        page_coupons = parse_coupon_html(response.text, start_order=len(result.coupons) + 1)
        result.pages_fetched = page_no
        if not page_coupons:
            break
        # 存在しないページ番号でも1ページ目が返る作りのサイトがあるため、
        # 先頭クーポンが既出なら終端とみなす
        if page_coupons[0].name in seen_names:
            break
        for coupon in page_coupons:
            if coupon.name in seen_names:
                continue
            seen_names.add(coupon.name)
            coupon.order = len(result.coupons) + 1
            result.coupons.append(coupon)

    if not result.coupons:
        result.warnings.append(
            'クーポンを1件も取得できませんでした。URLが正しいか、'
            'HPB側のHTML構造(div.usingPointToggle)が変わっていないか確認してください。'
        )
    return result


def load_coupons_from_html_files(paths: list[str]) -> ScrapeResult:
    """保存済みのHTMLファイルからクーポンを読む(ネットワークを使わない経路)。"""
    result = ScrapeResult(salon_url='(ローカルHTML)')
    seen_names: set[str] = set()
    for path in paths:
        with open(path, encoding='utf-8', errors='replace') as handle:
            html = handle.read()
        for coupon in parse_coupon_html(html, start_order=len(result.coupons) + 1):
            if coupon.name in seen_names:
                continue
            seen_names.add(coupon.name)
            coupon.order = len(result.coupons) + 1
            result.coupons.append(coupon)
        result.pages_fetched += 1
    if not result.coupons:
        result.warnings.append('指定したHTMLからクーポンを抽出できませんでした。')
    return result
