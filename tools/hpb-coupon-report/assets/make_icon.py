"""アプリのアイコンを生成する。

配布物にバイナリを置きっぱなしにせず、いつでも作り直せるようにスクリプトにしてある。
色は出力xlsxのヘッダ(#1F3864)に合わせた。

    python assets/make_icon.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

BACKGROUND = (31, 56, 100, 255)  # #1F3864
FOREGROUND = (255, 255, 255, 255)
SIZES = [16, 24, 32, 48, 64, 128, 256]
HERE = os.path.dirname(os.path.abspath(__file__))


def draw_icon(size: int) -> Image.Image:
    """角丸の背景に、クーポンの切り込みとチェックを描く。"""
    scale = 4  # いったん大きく描いて縮小し、輪郭を滑らかにする
    canvas = size * scale
    image = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    margin = canvas * 0.06
    radius = canvas * 0.22
    draw.rounded_rectangle(
        [margin, margin, canvas - margin, canvas - margin], radius=radius, fill=BACKGROUND
    )

    # クーポン券の切り込み(左右のえぐり)
    notch = canvas * 0.10
    center_y = canvas * 0.42
    for cx in (margin, canvas - margin):
        draw.ellipse(
            [cx - notch, center_y - notch, cx + notch, center_y + notch],
            fill=(0, 0, 0, 0),
        )

    # チェックマーク
    width = max(1, int(canvas * 0.10))
    draw.line(
        [
            (canvas * 0.30, canvas * 0.60),
            (canvas * 0.45, canvas * 0.75),
            (canvas * 0.73, canvas * 0.33),
        ],
        fill=FOREGROUND,
        width=width,
        joint='curve',
    )

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    largest = draw_icon(SIZES[-1])

    largest.save(os.path.join(HERE, 'icon.png'))
    # ICOは1つの画像から複数サイズを書き出せる(Pillowが縮小してくれる)。
    # 小さいほうを元にすると拡大できず16pxしか入らないので、必ず最大サイズを渡す。
    largest.save(os.path.join(HERE, 'icon.ico'), format='ICO', sizes=[(s, s) for s in SIZES])
    # macOSの.icnsはPillowが256px以上を要求する
    largest.save(os.path.join(HERE, 'icon.icns'), format='ICNS')
    print(f'生成しました: {HERE}/icon.png, icon.ico, icon.icns')


if __name__ == '__main__':
    main()
