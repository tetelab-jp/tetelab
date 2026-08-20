"""テスト用のサロンレポートを組み立てる。

実物のレポートには店舗名・売上・予約数といった取引先の情報が入るため、
リポジトリには置かない。代わりに、実物と同じ配置(見出し・列の並び)を持つ
最小限のレポートをテスト実行時に生成して、パーサに食わせる。

配置は2026年07月号 sunny.西中島店の実データに合わせてある:
    '■クーポン別ネット予約数' の見出しの下に 'メッセージ' 'クーポン名' と
    月号列が並び、その下にクーポン名と月ごとの予約数が続く。
"""

from __future__ import annotations

from openpyxl import Workbook

# (客区分, クーポン名(掲載側の表記), 予約数[3ヶ月])
SAMPLE_COUPONS = [
    ('新規', '【平日限定】似合わせカットカラー￥13500→￥8500［髪質改善/カラー/西中島］', [7, 2, 6]),
    ('全員', 'カット+縮毛矯正￥21000［髪質改善/縮毛矯正/西中島/淀川］', [1, 1, 2]),
    ('全員', "似合わせカット￥5500→￥4500［髪質改善/men's/ボブ/西中島/淀川］", [0, 1, 2]),
    ('新規', '顔周りカット+透明感カラー￥9200→￥6900［前髪カット/カラー/西中島/淀川］', [2, 2, 1]),
    ('全員', 'ヘッドスパ15分￥5000［髪質改善/インナーカラー/西中島］', [0, 0, 0]),
]

# レポート側(PDF)の表記。'￥' が '\' になり、一部に '[指定]' '[平日]' が付く。
REPORTED_NAMES = {
    '【平日限定】似合わせカットカラー￥13500→￥8500［髪質改善/カラー/西中島］':
        '[平日]【平日限定】似合わせカットカラー\\13500→\\8500［髪質改善/カラー/西中島］',
    'カット+縮毛矯正￥21000［髪質改善/縮毛矯正/西中島/淀川］':
        'カット+縮毛矯正\\21000［髪質改善/縮毛矯正/西中島/淀川］',
    "似合わせカット￥5500→￥4500［髪質改善/men's/ボブ/西中島/淀川］":
        "[指定]似合わせカット\\5500→\\4500［髪質改善/men's/ボブ/西中島/淀川］",
    '顔周りカット+透明感カラー￥9200→￥6900［前髪カット/カラー/西中島/淀川］':
        '顔周りカット+透明感カラー\\9200→￥6900［前髪カット/カラー/西中島/淀川］',
}

ISSUE_LABELS = ['05月号', '06月号', '07月号']
SALON_NAME = 'テストサロン西中島店【テスト】'
ISSUE = '2607月号'
UPDATED_AT = '2026-08-07'

# 予約実績がある(=レポートのランキングに載る)クーポン。予約0件のものは載らない。
RESERVED_COUPONS = [c for c in SAMPLE_COUPONS if sum(c[2]) > 0]


def build_grid() -> list[list[object]]:
    """実物と同じ配置のセル格子を作る(行番号は詰めてある)。"""
    width = 54
    rows: list[list[object]] = [[None] * width for _ in range(40)]

    def put(r: int, c: int, value: object) -> None:
        rows[r][c] = value

    # --- メタ情報 ---
    put(0, 0, '貴店名')
    put(0, 2, SALON_NAME)
    put(0, 19, 'ご掲載月号')
    put(0, 21, ISSUE)
    put(0, 49, 'データ最終更新日')
    put(1, 49, UPDATED_AT)

    # --- ■貴店クーポン情報(Net): 右端が最新月号 ---
    put(4, 0, '■貴店クーポン情報（Net）')
    put(5, 0, '06月号')
    put(5, 27, '07月号')
    for i, (customer_type, name, _) in enumerate(SAMPLE_COUPONS):
        put(6 + i, 0, f'{customer_type}/{REPORTED_NAMES.get(name, name)}')
        put(6 + i, 27, f'{customer_type}/{REPORTED_NAMES.get(name, name)}')

    # --- ■クーポン別ネット予約数: 同じ行の '■' が横方向の区切り ---
    marker_row = 20
    put(marker_row, 0, '■スタイリスト別ネット予約数/予約設定状況')
    put(marker_row, 14, '■メニュー別ネット予約数')
    put(marker_row, 27, '■クーポン別ネット予約数')

    header_row = marker_row + 2
    put(header_row, 14, 'メニュー名')
    put(header_row, 21, '07月号')
    put(header_row, 27, 'メッセージ')
    put(header_row, 29, 'クーポン名')
    for i, label in enumerate(ISSUE_LABELS):
        put(header_row, 36 + i, label)

    for i, (_, name, counts) in enumerate(RESERVED_COUPONS):
        r = header_row + 1 + i
        put(r, 29, REPORTED_NAMES.get(name, name))
        for j, count in enumerate(counts):
            if count:
                put(r, 36 + j, count)

    put(header_row + 1 + len(RESERVED_COUPONS) + 1, 36, '※予約集計方法についての注記')
    return rows


def write_report_xlsx(path: str) -> str:
    """Acrobat変換相当のxlsxを書き出す。"""
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = 'Table 1'
    for row in build_grid():
        worksheet.append(row)
    workbook.save(path)
    return path


def write_report_pdf(path: str) -> str:
    """同じ内容のPDFを書き出す(PDF直読み経路の検証用)。

    実物のレポートは横長1ページに54列ぶんを詰め込んだ密なレイアウトで、
    長いクーポン名は自分に割り当てられた列幅に収まるよう小さな文字で
    描かれている。PDF直読みはX座標のまとまりを列と見なすので、
    ここでも「隣の列にはみ出さない」ように文字サイズを詰めて描画する。

    reportlab が無い環境では ImportError をそのまま投げる(呼び出し側でskip)。
    """
    from reportlab.lib.pagesizes import A3, landscape
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas

    font_name = 'HeiseiKakuGo-W5'
    pdfmetrics.registerFont(UnicodeCIDFont(font_name))
    width, height = landscape(A3)
    pdf = canvas.Canvas(path, pagesize=(width, height))

    grid = build_grid()
    left, top = 20.0, height - 20.0
    col_width = (width - 40.0) / 54.0
    row_height = 14.0
    max_font, min_font = 6.0, 2.5

    for r, row in enumerate(grid):
        occupied = [c for c, value in enumerate(row) if value is not None]
        for i, c in enumerate(occupied):
            text = str(row[c])
            next_col = occupied[i + 1] if i + 1 < len(occupied) else 54
            # 全角は概ね「文字サイズ = 文字幅」なので、列幅に収まるサイズを選ぶ
            available = (next_col - c) * col_width
            size = max(min_font, min(max_font, available / max(1, len(text))))
            pdf.setFont(font_name, size)
            pdf.drawString(left + c * col_width, top - r * row_height, text)

    pdf.showPage()
    pdf.save()
    return path


def build_coupon_html() -> str:
    """HPBのクーポン一覧ページ相当のHTML(セレクタは実物に合わせている)。"""
    blocks = []
    for i, (customer_type, name, _) in enumerate(SAMPLE_COUPONS, 1):
        blocks.append(
            f'''
            <div class="usingPointToggle">
              <p class="couponLabelCT01">{customer_type}</p>
              <p class="couponMenuIcons">こだわり{i}</p>
              <p class="couponMenuName">{name}</p>
              <p class="couponMenuPrice">￥{8000 + i * 100:,}</p>
              <p class="couponDescription">説明{i}</p>
              <dl class="couponConditionsList">
                <dt>提示</dt><dd>ネット予約時</dd>
                <dt>期限</dt><dd>2026年9月30日</dd>
                <dt>備考</dt><dd>他券併用不可{i}</dd>
              </dl>
              <a class="btn1H50" href="/reserve/{i}/">このクーポンで予約</a>
            </div>
            '''
        )
    return '<html><body>' + ''.join(blocks) + '</body></html>'
