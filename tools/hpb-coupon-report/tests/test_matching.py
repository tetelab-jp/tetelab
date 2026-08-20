"""照合ロジックの検証。"""

from hpb_coupon.matching import hungarian, match_coupons, similarity


def test_ハンガリー法は総コスト最小の割り当てを選ぶ():
    # 貪欲に行0の最小(列0)を取ると合計が悪くなる配置
    cost = [[1.0, 2.0], [1.0, 9.0]]
    assert hungarian(cost) == [1, 0]


def test_ハンガリー法は行が多くても列が多くても解ける():
    assert sorted(x for x in hungarian([[1.0, 5.0, 9.0]]) if x >= 0) == [0]
    result = hungarian([[1.0], [5.0], [9.0]])
    assert sorted(x for x in result if x >= 0) == [0]
    assert result.count(-1) == 2


def test_表記ゆれは完全一致として扱われる():
    listed = ['カット+縮毛矯正￥21000［西中島］']
    reserved = ['カット+縮毛矯正\\21000［西中島］']
    result = match_coupons(listed, reserved)
    assert result.exact_count == 1
    assert result.pairs[0].score == 1.0


def test_改名したクーポンはあいまい一致で拾う():
    listed = ['【夏限定】似合わせカットカラー￥13500→￥8500［西中島］']
    reserved = ['【春限定】似合わせカットカラー\\13500→\\8500［西中島］']
    result = match_coupons(listed, reserved)
    assert result.fuzzy_count == 1
    assert 0.8 < result.pairs[0].score < 1.0


def test_無関係なものは閾値で切り捨てる():
    result = match_coupons(['カット￥5500'], ['ヘッドスパ60分\\12000［髪質改善/西中島/淀川］'])
    assert result.pairs == []
    assert result.unmatched_listed == [0]
    assert result.unmatched_reserved == [0]


def test_同じ掲載クーポンが二重に割り当てられない():
    listed = ['メンズカット\\5500', 'メンズカット\\5500→\\4500']
    reserved = ['メンズカット\\5500', 'メンズカット\\5500→\\4500']
    result = match_coupons(listed, reserved)
    assert len(result.pairs) == 2
    assert len({p.listed_index for p in result.pairs}) == 2
    assert len({p.reserved_index for p in result.pairs}) == 2
    # 完全一致が優先されるので、似た名前同士が入れ替わらない
    for pair in result.pairs:
        assert listed[pair.listed_index] == reserved[pair.reserved_index]


def test_掲載が多く予約が少なくても落ちない():
    result = match_coupons(['A￥1000', 'B￥2000', 'C￥3000'], ['B\\2000'])
    assert result.exact_count == 1
    assert len(result.unmatched_listed) == 2


def test_一致率は0から1に収まる():
    assert similarity('カット', 'カット') == 1.0
    assert similarity('カット', None) == 0.0
    assert 0.0 <= similarity('カット￥5500', 'カラー\\8000') <= 1.0
