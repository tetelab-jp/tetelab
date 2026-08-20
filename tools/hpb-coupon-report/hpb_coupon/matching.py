"""掲載クーポンと予約データの照合。

2段構えで照合する。

  1. 正規化キーの完全一致
     normalize_coupon_name() を通したキーが一致するものを先に確定させる。
     実データではここで全件が決まった。曖昧一致に回すと、似た名前のクーポン
     (例: 'メンズカット\\5500' と 'メンズカット\\5500→\\4500')が入れ替わる
     事故が起きうるため、確実な一致を先に抜くことには意味がある。

  2. 残りをレーベンシュタイン距離+ハンガリー法で1対1割り当て
     「予約行ごとに最も似た掲載行を選ぶ」貪欲法だと、同じ掲載クーポンに複数の
     予約行がぶら下がったり、全体としては明らかに悪い組み合わせが選ばれたりする。
     ハンガリー法は一致率の総和が最大になる組み合わせを選ぶので、1対1が保証され、
     クーポン名を書き換えた月でも対応関係が崩れにくい。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .normalize import normalize_coupon_name

try:  # rapidfuzz があれば桁違いに速い。無ければ純Python実装にフォールバック。
    from rapidfuzz.distance import Levenshtein as _RF_LEV

    def _similarity(a: str, b: str) -> float:
        return float(_RF_LEV.normalized_similarity(a, b))

    HAS_RAPIDFUZZ = True
except ImportError:  # pragma: no cover - 環境依存の分岐
    HAS_RAPIDFUZZ = False

    def _levenshtein(a: str, b: str) -> int:
        if a == b:
            return 0
        if not a:
            return len(b)
        if not b:
            return len(a)
        previous = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            current = [i]
            for j, cb in enumerate(b, 1):
                current.append(
                    min(
                        previous[j] + 1,
                        current[j - 1] + 1,
                        previous[j - 1] + (ca != cb),
                    )
                )
            previous = current
        return previous[-1]

    def _similarity(a: str, b: str) -> float:
        longest = max(len(a), len(b))
        if longest == 0:
            return 0.0
        return 1.0 - _levenshtein(a, b) / longest


def similarity(a: object, b: object) -> float:
    """正規化した2つのクーポン名の一致率(0.0〜1.0)。"""
    na = normalize_coupon_name(a)
    nb = normalize_coupon_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    return _similarity(na, nb)


def hungarian(cost: list[list[float]]) -> list[int]:
    """コスト最小の1対1割り当てを返す(O(n^3) のハンガリー法)。

    戻り値 result[i] は行iに割り当てられた列の番号。割り当てが無い行は -1。
    行数が列数より多い場合は転置して解き、結果を戻す。
    """
    if not cost or not cost[0]:
        return [-1] * len(cost)

    rows, cols = len(cost), len(cost[0])
    transposed = rows > cols
    if transposed:
        cost = [[cost[i][j] for i in range(rows)] for j in range(cols)]
        rows, cols = cols, rows

    inf = float('inf')
    u = [0.0] * (rows + 1)
    v = [0.0] * (cols + 1)
    parent = [0] * (cols + 1)  # parent[j] = 列jに割り当てられた行(1始まり、0は未割当)
    way = [0] * (cols + 1)

    for i in range(1, rows + 1):
        parent[0] = i
        j0 = 0
        minv = [inf] * (cols + 1)
        used = [False] * (cols + 1)
        while True:
            used[j0] = True
            i0 = parent[j0]
            delta = inf
            j1 = 0
            for j in range(1, cols + 1):
                if used[j]:
                    continue
                cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(cols + 1):
                if used[j]:
                    u[parent[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if parent[j0] == 0:
                break
        while j0:
            j1 = way[j0]
            parent[j0] = parent[j1]
            j0 = j1

    result = [-1] * rows
    for j in range(1, cols + 1):
        if parent[j] > 0:
            result[parent[j] - 1] = j - 1

    if transposed:
        flipped = [-1] * cols
        for i, j in enumerate(result):
            if j >= 0:
                flipped[j] = i
        return flipped
    return result


@dataclass
class MatchPair:
    """掲載クーポン1件と予約データ1件の対応。"""

    listed_index: int | None
    reserved_index: int | None
    score: float
    method: str  # 'exact' | 'fuzzy' | 'unmatched'


@dataclass
class MatchResult:
    pairs: list[MatchPair] = field(default_factory=list)
    unmatched_listed: list[int] = field(default_factory=list)
    unmatched_reserved: list[int] = field(default_factory=list)

    @property
    def exact_count(self) -> int:
        return sum(1 for p in self.pairs if p.method == 'exact')

    @property
    def fuzzy_count(self) -> int:
        return sum(1 for p in self.pairs if p.method == 'fuzzy')


def match_coupons(
    listed_names: list[object],
    reserved_names: list[object],
    threshold: float = 0.55,
) -> MatchResult:
    """掲載クーポン名と予約クーポン名を1対1で対応づける。

    threshold 未満の組み合わせは「対応なし」として切り捨てる。掲載を丸ごと入れ替えた
    月に、無関係なクーポン同士が無理やり結び付くのを防ぐための下限。
    """
    listed_keys = [normalize_coupon_name(n) for n in listed_names]
    reserved_keys = [normalize_coupon_name(n) for n in reserved_names]

    result = MatchResult()
    listed_open = set(range(len(listed_names)))
    reserved_open = set(range(len(reserved_names)))

    # --- 1段目: 正規化キーの完全一致 ---
    by_key: dict[str, list[int]] = {}
    for idx, key in enumerate(listed_keys):
        if key:
            by_key.setdefault(key, []).append(idx)

    for r_idx in sorted(reserved_open):
        key = reserved_keys[r_idx]
        if not key:
            continue
        candidates = by_key.get(key)
        while candidates:
            l_idx = candidates.pop(0)
            if l_idx in listed_open:
                listed_open.discard(l_idx)
                reserved_open.discard(r_idx)
                result.pairs.append(MatchPair(l_idx, r_idx, 1.0, 'exact'))
                break

    # --- 2段目: 残りをハンガリー法で割り当て ---
    rest_listed = sorted(listed_open)
    rest_reserved = sorted(reserved_open)
    if rest_listed and rest_reserved:
        scores = [
            [_similarity(listed_keys[l], reserved_keys[r]) for r in rest_reserved]
            for l in rest_listed
        ]
        # ハンガリー法はコスト最小化なので、一致率を符号反転してコストにする。
        assignment = hungarian([[-s for s in row] for row in scores])
        for row, col in enumerate(assignment):
            if col < 0:
                continue
            score = scores[row][col]
            if score < threshold:
                continue
            l_idx = rest_listed[row]
            r_idx = rest_reserved[col]
            listed_open.discard(l_idx)
            reserved_open.discard(r_idx)
            result.pairs.append(MatchPair(l_idx, r_idx, score, 'fuzzy'))

    result.unmatched_listed = sorted(listed_open)
    result.unmatched_reserved = sorted(reserved_open)
    result.pairs.sort(key=lambda p: (p.listed_index if p.listed_index is not None else 10**9))
    return result
