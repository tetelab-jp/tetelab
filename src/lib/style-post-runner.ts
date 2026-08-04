// ============================================
// style-post-runner.ts
// 「チェック済みスタイル画像を全件投稿する」1回分の実行ロジック。
// 手動テスト実行（automation.ts）と外部Cronトリガー（同route）の両方から呼ばれる。
// ============================================

import type { Bindings } from '../types'
import { decryptSecret } from './crypto'
import {
  launchBrowser,
  loginToSalonBoard,
  postStyleImageFull,
  type StylePostInput
} from './salonboard-automation'

export type RunSummary = {
  runId: number
  totalImages: number
  successCount: number
  failureCount: number
  status: 'done' | 'failed'
  errorMessage?: string
}

type TemplateRow = {
  stylist_select_value: string | null
  stylist_comment: string | null
  category_cd: string
  hair_length_value: string | null
  menu_contents_cd_list: string
  menu_detail_text: string | null
}

type StyleImageRow = {
  id: number
  r2_key: string
  file_name: string | null
  title: string | null
}

export async function runStyleAutomationForUser(
  env: Bindings,
  userId: number,
  scheduledTimeLabel: string
): Promise<RunSummary> {
  // ---- 事前チェック: 連携情報・テンプレート・対象画像 ----
  const cred = await env.DB.prepare(
    'SELECT salonboard_login_id_enc, salonboard_password_enc FROM salon_credentials WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ salonboard_login_id_enc: string; salonboard_password_enc: string }>()

  if (!cred) throw new Error('サロンボードのログイン情報が未登録です')
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEYが未設定です')

  const template = await env.DB.prepare(
    `SELECT stylist_select_value, stylist_comment, category_cd, hair_length_value, menu_contents_cd_list, menu_detail_text
     FROM style_post_templates WHERE user_id = ?`
  )
    .bind(userId)
    .first<TemplateRow>()

  if (!template || !template.stylist_comment || !template.menu_detail_text) {
    throw new Error('投稿テンプレート（/style/template）が未設定、または必須項目が未入力です')
  }

  const { results } = await env.DB.prepare(
    'SELECT id, r2_key, file_name, title FROM style_images WHERE user_id = ? AND is_selected = 1'
  )
    .bind(userId)
    .all<StyleImageRow>()

  const images = results || []
  if (images.length === 0) {
    throw new Error('投稿対象としてチェックされている画像がありません')
  }

  // ---- 実行履歴レコードを作成 ----
  const runInsert = await env.DB.prepare(
    `INSERT INTO style_post_runs (user_id, scheduled_time, total_images, status)
     VALUES (?, ?, ?, 'processing')`
  )
    .bind(userId, scheduledTimeLabel, images.length)
    .run()
  const runId = Number(runInsert.meta.last_row_id)

  let successCount = 0
  let failureCount = 0
  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null

  try {
    const loginId = await decryptSecret(cred.salonboard_login_id_enc, env.ENCRYPTION_KEY)
    const password = await decryptSecret(cred.salonboard_password_enc, env.ENCRYPTION_KEY)

    browser = await launchBrowser(env)
    const page = await browser.newPage()

    // ログはpasswordを絶対に含めない
    await loginToSalonBoard(page, loginId, password, () => {})

    for (const img of images) {
      try {
        const object = await env.STYLE_IMAGES.get(img.r2_key)
        if (!object) throw new Error(`R2から画像が見つかりません（key: ${img.r2_key}）`)
        const imageBuffer = await object.arrayBuffer()

        const input: StylePostInput = {
          styleImageId: img.id,
          imageBuffer,
          imageFileName: img.file_name || `style-${img.id}.jpg`,
          styleName: (img.title || img.file_name || `スタイル${img.id}`).slice(0, 60),
          stylistSelectValue: template.stylist_select_value || '',
          stylistComment: template.stylist_comment || '',
          categoryCd: (template.category_cd as 'SG01' | 'SG02') || 'SG01',
          hairLengthValue: template.hair_length_value || '',
          menuContentsCdList: JSON.parse(template.menu_contents_cd_list || '[]'),
          menuDetailText: template.menu_detail_text || ''
        }

        await postStyleImageFull(page, input, () => {})

        await env.DB.prepare(
          `UPDATE style_images SET post_count = post_count + 1, last_posted_at = CURRENT_TIMESTAMP WHERE id = ?`
        )
          .bind(img.id)
          .run()

        await env.DB.prepare(
          `INSERT INTO execution_logs (post_id, user_id, status, message) VALUES (NULL, ?, 'success', ?)`
        )
          .bind(userId, `スタイル投稿成功: 画像ID ${img.id}（${input.styleName}）`)
          .run()

        successCount++
      } catch (imgErr: any) {
        failureCount++
        await env.DB.prepare(
          `INSERT INTO execution_logs (post_id, user_id, status, message) VALUES (NULL, ?, 'failure', ?)`
        )
          .bind(userId, `スタイル投稿失敗: 画像ID ${img.id} - ${String(imgErr?.message || imgErr).slice(0, 500)}`)
          .run()
      }
    }

    const finalStatus: 'done' | 'failed' = failureCount === 0 ? 'done' : failureCount === images.length ? 'failed' : 'done'

    await env.DB.prepare(
      `UPDATE style_post_runs SET status = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(finalStatus, runId)
      .run()

    return { runId, totalImages: images.length, successCount, failureCount, status: finalStatus }
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 500)
    await env.DB.prepare(
      `UPDATE style_post_runs SET status = 'failed', error_message = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(message, runId)
      .run()
    await env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, status, message) VALUES (NULL, ?, 'failure', ?)`
    )
      .bind(userId, `実行全体が失敗: ${message}`)
      .run()

    return { runId, totalImages: images.length, successCount, failureCount, status: 'failed', errorMessage: message }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

/** 現在時刻をJST(UTC+9) "HH:MM" 形式で返す */
export function currentJstTimeLabel(): string {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mm = String(jst.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
