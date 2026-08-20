"""クーポン名の正規化。

このツールの精度の大半はここで決まる。実データ(2026年07月号 sunny.西中島店)で
検証したところ、掲載側と予約側の食い違いは「クーポンの中身の違い」ではなく、
ほぼすべてがPDF/Acrobat変換に由来する表記ゆれだった。具体的には:

  - 円記号: 掲載側は '￥'(全角)、レポート側は '\\'(バックスラッシュ)で出てくる
  - 全角/半角: 数字・英字・括弧が混在する
  - 接頭タグ: レポート側だけ '[指定]' '[平日]' が付く(掲載順の都合で付与される)
  - 空白: 全角スペースや連続スペースが入る位置が一定しない

これらを吸収した結果、予約データ37件すべてが掲載側と完全一致した(一致率1.000)。
つまりレーベンシュタイン距離による曖昧一致は「クーポン名を実際に書き換えた月」の
フォールバックであって、通常運用の主役ではない。
"""

from __future__ import annotations

import re
import unicodedata

# レポート側にだけ付く先頭タグ。'[指定]' '[平日]' のほか、将来増えても拾えるよう
# 「短い角括弧が先頭に1個以上連続する」形で表現している。長い括弧はクーポン名の
# 一部(例: '[ブリーチ/髪質改善/西中島]')なので、8文字までに制限して誤除去を防ぐ。
_LEADING_TAG = re.compile(r'^\s*(?:\[[^\]]{1,8}\])+')

# NFKCで統一しきれない文字を手当てする。'\\' はPDF内で円記号として使われている。
_CHAR_MAP = {
    '\\': '¥',
    '＼': '¥',
    '￥': '¥',
    '’': "'",
    '‘': "'",
    '“': '"',
    '”': '"',
    '−': '-',
    'ー': 'ー',
    '⇒': '→',
    '～': '~',
}

_WHITESPACE = re.compile(r'[\s　]+')


def normalize_coupon_name(name: object) -> str:
    """クーポン名を照合用のキーに変換する。

    表示用の名前は壊さず、比較のときだけこの関数を通す。
    """
    if name is None:
        return ''
    text = str(name)
    if not text.strip():
        return ''

    # NFKCで全角英数字・全角括弧・全角記号を半角に寄せる。
    # この時点で '［' → '[' 、'０' → '0' 、'￥' → '¥' になる。
    text = unicodedata.normalize('NFKC', text)

    for src, dst in _CHAR_MAP.items():
        text = text.replace(src, dst)

    # 接頭タグの除去はNFKCの後に行う(全角括弧が半角に揃ってから消す)。
    text = _LEADING_TAG.sub('', text)

    text = _WHITESPACE.sub('', text)
    return text.casefold()


def split_customer_type(name: object) -> tuple[str, str]:
    """レポートの '新規/クーポン名' 形式から客区分とクーポン名を分離する。

    「■貴店クーポン情報(Net)」セクションは '新規/...' '全員/...' の形で入っている。
    区切りが無ければ客区分は空文字で返す。
    """
    if name is None:
        return '', ''
    text = str(name).strip()
    for prefix in ('新規', '全員', '再来', '2回目以降'):
        if text.startswith(prefix + '/'):
            return prefix, text[len(prefix) + 1:].strip()
    return '', text
