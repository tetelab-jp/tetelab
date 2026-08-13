// ============================================
// image-process.ts
// スタイル画像の保存前処理。プロキシ経由のアップロードが大きいPOSTボディ
// (数百KB〜数MB)で失敗しやすい問題への対策として、保存前に規定サイズへ
// 縮小・圧縮する(詳細な経緯・診断はユーザー提供の調査資料を参照)。
//
// ルール:
//   - 最大 縦800px × 横600px、トリミングなし
//   - 縦4:横3の比率に満たない場合は画像を拡大せず、元画像の端を引き伸ばして
//     ぼかした背景で余白を埋める(レターボックス)
//   - 元画像が600×800pxより小さい場合は拡大しない(比率補正のみ)
//   - JPEG/300KB以下(圧縮する場合は250KB未満まで下げすぎない)
//   - RGB(アルファ・CMYK等は白背景でフラット化)
// ============================================

import sharp from 'sharp'

const MAX_WIDTH = 600
const MAX_HEIGHT = 800
const TARGET_RATIO = MAX_WIDTH / MAX_HEIGHT // 横:縦 = 3:4
const MAX_BYTES = 300 * 1024
const QUALITY_START = 90
const QUALITY_FLOOR = 30
const QUALITY_STEP = 3
const BACKGROUND_BLUR_SIGMA = 20

export type ProcessedImage = { buffer: Buffer; contentType: 'image/jpeg' }

function toBuffer(input: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
}

/**
 * スタイル画像を規定ルールに従って正規化する。
 * - 縦4:横3の枠(最大600×800px、拡大なし)にトリミングせず収める
 * - 枠に対して余った部分は、同じ画像を引き伸ばし&ぼかした背景で埋める
 * - RGBのJPEGとして、300KB以下(圧縮時は250KB未満まで下げない)になるまで
 *   品質を段階的に下げて書き出す
 */
export async function processStyleImage(input: Buffer | Uint8Array | ArrayBuffer): Promise<ProcessedImage> {
  const inputBuffer = toBuffer(input)

  const probe = sharp(inputBuffer, { failOn: 'none' }).rotate()
  const meta = await probe.metadata()
  const origW = meta.width || MAX_WIDTH
  const origH = meta.height || MAX_HEIGHT

  // 元画像を(拡大せず)収める最大サイズ
  const scaleToFit = Math.min(MAX_WIDTH / origW, MAX_HEIGHT / origH, 1)
  const fittedW = Math.max(1, Math.round(origW * scaleToFit))
  const fittedH = Math.max(1, Math.round(origH * scaleToFit))

  // fittedサイズを内包する縦4:横3の外接枠(拡大は最小限、超過分のみ)
  const fittedRatio = fittedW / fittedH
  let targetW: number
  let targetH: number
  if (fittedRatio > TARGET_RATIO) {
    // 横長寄り → 幅はそのまま、高さを4:3に合わせて広げる
    targetW = fittedW
    targetH = Math.round(fittedW / TARGET_RATIO)
  } else {
    // 縦長寄り(またはぴったり) → 高さはそのまま、幅を4:3に合わせて広げる
    targetH = fittedH
    targetW = Math.round(fittedH * TARGET_RATIO)
  }
  targetW = Math.min(targetW, MAX_WIDTH)
  targetH = Math.min(targetH, MAX_HEIGHT)

  // 前景: 元画像をトリミングせずfittedサイズへ(RGB化)
  const foreground = await sharp(inputBuffer, { failOn: 'none' })
    .rotate()
    .resize(fittedW, fittedH, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .toColorspace('srgb')
    .toBuffer()

  // 背景: 同じ画像をtargetサイズいっぱいに引き伸ばしてぼかし、余白を埋める
  const background = await sharp(inputBuffer, { failOn: 'none' })
    .rotate()
    .resize(targetW, targetH, { fit: 'cover' })
    .blur(BACKGROUND_BLUR_SIGMA)
    .flatten({ background: '#ffffff' })
    .toColorspace('srgb')
    .toBuffer()

  const left = Math.max(0, Math.round((targetW - fittedW) / 2))
  const top = Math.max(0, Math.round((targetH - fittedH) / 2))

  const composed =
    left === 0 && top === 0 && fittedW === targetW && fittedH === targetH
      ? sharp(foreground) // 既にぴったり4:3(背景を合成する必要なし)
      : sharp(background).composite([{ input: foreground, left, top }])

  // JPEGへ書き出し。既に300KB以下ならそれ以上圧縮しない。
  // 超えている場合のみ品質を段階的に下げ、300KB以下になった時点で確定する
  // (250KBという下限は「必要以上に圧縮しすぎない」ための歯止めであり、
  // 既に小さい画像を無理に太らせる意味ではない)。
  let quality = QUALITY_START
  // 2026-08-13追記: mozjpeg:trueは(このsharpビルドでは)progressive:falseを
  // 明示しても常にプログレッシブJPEGを出力してしまう(mozjpegプリセットが
  // 優先される)ことを実機確認した。投稿先(SALON BOARD)が古いシステムである
  // 可能性を考慮し、圧縮効率よりベースライン(非プログレッシブ)出力を優先して
  // mozjpegは使わない。300x800px程度の画像サイズであれば圧縮効率の差は
  // 実用上ほぼ問題にならない。
  let buffer = await composed.clone().jpeg({ quality, mozjpeg: false, progressive: false }).toBuffer()
  while (buffer.length > MAX_BYTES && quality > QUALITY_FLOOR) {
    quality -= QUALITY_STEP
    buffer = await composed.clone().jpeg({ quality, mozjpeg: false, progressive: false }).toBuffer()
  }

  return { buffer, contentType: 'image/jpeg' }
}

// 2026-08-14追記(ブログ自動投稿機能): ブログ記事用画像は、スタイル写真と違い
// SALON BOARDの縦4:3枠に収める必要が無いため、レターボックス処理は行わず、
// 元のアスペクト比のまま最大サイズ以内に縮小するだけのシンプルな処理にする。
// 圧縮(JPEG/300KB以下、品質を段階的に下げる)ロジックはprocessStyleImageと共通。
const BLOG_MAX_DIMENSION = 1000

/**
 * ブログ記事画像を正規化する。
 * - 最大1000px(縦横どちらか長い方)、拡大なし、トリミング・レターボックスなし
 * - RGBのJPEGとして、300KB以下(圧縮時は250KB未満まで下げない)になるまで
 *   品質を段階的に下げて書き出す(processStyleImageと同じルール)
 */
export async function processBlogArticleImage(input: Buffer | Uint8Array | ArrayBuffer): Promise<ProcessedImage> {
  const inputBuffer = toBuffer(input)

  const composed = sharp(inputBuffer, { failOn: 'none' })
    .rotate()
    .resize(BLOG_MAX_DIMENSION, BLOG_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .toColorspace('srgb')

  let quality = QUALITY_START
  let buffer = await composed.clone().jpeg({ quality, mozjpeg: false, progressive: false }).toBuffer()
  while (buffer.length > MAX_BYTES && quality > QUALITY_FLOOR) {
    quality -= QUALITY_STEP
    buffer = await composed.clone().jpeg({ quality, mozjpeg: false, progressive: false }).toBuffer()
  }

  return { buffer, contentType: 'image/jpeg' }
}
