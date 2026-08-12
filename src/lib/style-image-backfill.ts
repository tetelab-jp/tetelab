// ============================================
// style-image-backfill.ts
// 画像圧縮(image-process.ts)導入前にアップロード済みだった、未圧縮のまま
// R2/S3に残っているスタイル画像を一度だけ再圧縮する。
// style_images.compressed_at が NULL の行を対象にし、処理後にタイムスタンプを
// 立てることで「対象が無くなれば以降は何もしない」冪等な起動時バックフィルにする
// (src/index.tsxの起動時マイグレーションと同じ考え方)。
// ============================================

import type { Bindings } from '../types'
import { processStyleImage } from './image-process'

export async function backfillCompressStyleImages(env: Bindings): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id, r2_key FROM style_images WHERE compressed_at IS NULL ORDER BY id`
  ).all<{ id: number; r2_key: string }>()

  if (results.length === 0) return
  console.log(`[backfillCompressStyleImages] 未圧縮のスタイル画像 ${results.length}件を処理します`)

  let okCount = 0
  let errCount = 0
  for (const row of results) {
    try {
      const obj = await env.STYLE_IMAGES.get(row.r2_key)
      if (!obj) {
        // 実体が既に無い(削除済み等)行は対象から外すだけ
        await env.DB.prepare(`UPDATE style_images SET compressed_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(row.id)
          .run()
        continue
      }
      const bytes = await obj.arrayBuffer()
      const { buffer, contentType } = await processStyleImage(bytes)
      await env.STYLE_IMAGES.put(row.r2_key, buffer, { httpMetadata: { contentType } })
      await env.DB.prepare(`UPDATE style_images SET compressed_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(row.id)
        .run()
      okCount++
    } catch (err) {
      errCount++
      console.error(`[backfillCompressStyleImages] id=${row.id} r2_key=${row.r2_key} 失敗:`, err)
    }
  }
  console.log(`[backfillCompressStyleImages] 完了: 成功${okCount}件 / 失敗${errCount}件`)
}
