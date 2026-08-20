"""正規化の検証。

ここで挙げているケースは、すべて2026年07月号の実データで実際に起きていた
表記ゆれ。掲載側(HPB)とレポート側(PDF)で同じクーポンがこう食い違う。
"""

from hpb_coupon.normalize import normalize_coupon_name, split_customer_type


def test_円記号のゆれを吸収する():
    listed = 'カット+縮毛矯正￥21000［髪質改善/縮毛矯正/西中島/淀川］'
    reported = 'カット+縮毛矯正\\21000［髪質改善/縮毛矯正/西中島/淀川］'
    assert normalize_coupon_name(listed) == normalize_coupon_name(reported)


def test_レポート側の接頭タグを除去する():
    listed = '【平日限定】メンテナンスカット+カラー￥10450→￥7800［カラー/西中島］'
    reported = '[平日]【平日限定】メンテナンスカット+カラー\\10450→\\7800［カラー/西中島］'
    assert normalize_coupon_name(listed) == normalize_coupon_name(reported)


def test_全角半角と余分な空白を吸収する():
    listed = '【髪質改善×色持ち】カット+アメイジアカラー￥16500→￥11000  ［髪質改善］'
    reported = '【髪質改善×色持ち】カット+アメイジアカラー\\16500→\\11000［髪質改善］'
    assert normalize_coupon_name(listed) == normalize_coupon_name(reported)


def test_長い角括弧はクーポン名の一部なので消さない():
    key = normalize_coupon_name('カット+ブリーチ+カラー+Aujua4step￥25400[ブリーチ/髪質改善/西中島］')
    assert 'ブリーチ/髪質改善/西中島' in key


def test_別のクーポンは同じキーにならない():
    a = "[指定]【Men's限定】メンズカット\\5500［men's/メンズカット/西中島］"
    b = "[指定]【Men's限定】メンズカット\\5500→\\4500［men's/メンズカット/西中島］"
    assert normalize_coupon_name(a) != normalize_coupon_name(b)


def test_空やNoneは空文字になる():
    assert normalize_coupon_name(None) == ''
    assert normalize_coupon_name('   ') == ''


def test_客区分の分離():
    assert split_customer_type('新規/似合わせカット\\5500') == ('新規', '似合わせカット\\5500')
    assert split_customer_type('全員/カット') == ('全員', 'カット')
    assert split_customer_type('区切りなしのクーポン') == ('', '区切りなしのクーポン')
