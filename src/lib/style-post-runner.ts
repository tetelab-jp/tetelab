// ============================================
// style-post-runner.ts
// 「auto_post_enabled_flag=1 かつ ready状態のスタイルを全件投稿する」
// 1回分の実行ロジック。手動テスト実行（automation.tsx）と
// 外部Cronトリガー（同route）の両方から呼ばれる。
//
// docs/phase3-mvp-design.md 5-5「投稿実行フロー」に対応。
// 「登録」「反映申請」を別ステップとして扱い、それぞれの結果を
// styles.salonboard_register_status / reflection_request_status に記録する。
// ============================================

import type { Bindings } from '../types'
import { decryptSecret } from './crypto'
import {
  launchBrowser,
  loginToSalonBoard,
  draftRegisterStyle,
  submitReflectApplication,
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

type ReadyStyleRow = {
  id: number
  title: string | null
  comment: string | null
  category_value: string | null
  length_value: string | null
  menu_values_json: string
  menu_detail_text: string | null
  stylist_select_value: string | null
  front_r2_key: string | null
  front_file_name: string | null
}

export async function runStyleAutomationForUser(
  env: Bindings,
  userId: number,
  scheduledTimeLabel: string
): Promise<RunSummary> {
  // ---- 事前チェック: 連携情報・対象スタイル ----
  const cred = await env.DB.prepare(
    'SELECT salonboard_login_id_enc, salonboard_password_enc FROM salon_credentials WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ salonboard_login_id_enc: string; salonboard_password_enc: string }>()

  if (!cred) throw new Error('サロンボードのログイン情報が未登録です')
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEYが未設定です')

  const { results } = await env.DB.prepare(
    `SELECT
       s.id, s.title, s.comment, s.category_value, s.length_value,
       s.menu_values_json, s.menu_detail_text,
       st.salonboard_stylist_key AS stylist_select_value,
       si.r2_key AS front_r2_key, si.file_name AS front_file_name
     FROM styles s
     LEFT JOIN stylists st ON st.id = s.stylist_id
     LEFT JOIN style_images si ON si.style_id = s.id AND si.image_role = 'FRONT'
     WHERE s.user_id = ? AND s.auto_post_enabled_flag = 1 AND s.internal_save_status = 'ready'`
  )
    .bind(userId)
    .all<ReadyStyleRow>()

  const targets = results || []
  if (targets.length === 0) {
    throw new Error('投稿対象（自動投稿ON・入力完了済み）のスタイルがありません')
  }

  // ---- 実行履歴レコードを作成 ----
  const runInsert = await env.DB.prepare(
    `INSERT INTO style_post_runs (user_id, scheduled_time, total_images, status)
     VALUES (?, ?, ?, 'processing')`
  )
    .bind(userId, scheduledTimeLabel, targets.length)
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

    for (const row of targets) {
      try {
        if (!row.front_r2_key) throw new Error('FRONT画像が未登録です')

        const object = await env.STYLE_IMAGES.get(row.front_r2_key)
        if (!object) throw new Error(`R2から画像が見つかりません（key: ${row.front_r2_key}）`)
        const imageBuffer = await object.arrayBuffer()

        const input: StylePostInput = {
          styleImageId: row.id,
          imageBuffer,
          imageFileName: row.front_file_name || `style-${row.id}.jpg`,
          styleName: (row.title || `スタイル${row.id}`).slice(0, 60),
          stylistSelectValue: row.stylist_select_value || '',
          stylistComment: row.comment || '',
          categoryCd: (row.category_value as 'SG01' | 'SG02') || 'SG01',
          hairLengthValue: row.length_value || '',
          menuContentsCdList: JSON.parse(row.menu_values_json || '[]'),
          menuDetailText: row.menu_detail_text || ''
        }

        // ---- 登録(下書き保存) ----
        try {
          await draftRegisterStyle(page, input, () => {})
          await env.DB.prepare(
            `UPDATE styles SET salonboard_register_status = 'success', reflection_request_status = 'pending', last_error = NULL WHERE id = ?`
          )
            .bind(row.id)
            .run()
          await env.DB.prepare(
            `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
             VALUES (NULL, ?, ?, 'register_style', 'success', ?)`
          )
            .bind(userId, row.id, `スタイル登録成功: ${input.styleName}`)
            .run()
        } catch (registerErr: any) {
          const message = String(registerErr?.message || registerErr).slice(0, 500)
          await env.DB.prepare(
            `UPDATE styles SET salonboard_register_status = 'failed', last_error = ?, last_executed_at = CURRENT_TIMESTAMP WHERE id = ?`
          )
            .bind(message, row.id)
            .run()
          await env.DB.prepare(
            `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
             VALUES (NULL, ?, ?, 'register_style', 'failure', ?)`
          )
            .bind(userId, row.id, `スタイル登録失敗: ${message}`)
            .run()
          failureCount++
          continue
        }

        // ---- 反映申請(公開) ----
        try {
          await submitReflectApplication(page, () => {})
          await env.DB.prepare(
            `UPDATE styles SET reflection_request_status = 'success', last_executed_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?`
          )
            .bind(row.id)
            .run()
          await env.DB.prepare(
            `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
             VALUES (NULL, ?, ?, 'request_reflection', 'success', ?)`
          )
            .bind(userId, row.id, `反映申請成功: ${input.styleName}`)
            .run()
          successCount++
        } catch (reflectErr: any) {
          const message = String(reflectErr?.message || reflectErr).slice(0, 500)
          await env.DB.prepare(
            `UPDATE styles SET reflection_request_status = 'failed', last_error = ?, last_executed_at = CURRENT_TIMESTAMP WHERE id = ?`
          )
            .bind(message, row.id)
            .run()
          await env.DB.prepare(
            `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
             VALUES (NULL, ?, ?, 'request_reflection', 'failure', ?)`
          )
            .bind(userId, row.id, `反映申請失敗: ${message}`)
            .run()
          failureCount++
        }
      } catch (imgErr: any) {
        failureCount++
        const message = String(imgErr?.message || imgErr).slice(0, 500)
        await env.DB.prepare(
          `UPDATE styles SET salonboard_register_status = 'failed', last_error = ? WHERE id = ?`
        )
          .bind(message, row.id)
          .run()
        await env.DB.prepare(
          `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
           VALUES (NULL, ?, ?, 'register_style', 'failure', ?)`
        )
          .bind(userId, row.id, `スタイル投稿失敗: ${message}`)
          .run()
      }
    }

    const finalStatus: 'done' | 'failed' =
      failureCount === 0 ? 'done' : failureCount === targets.length ? 'failed' : 'done'

    await env.DB.prepare(`UPDATE style_post_runs SET status = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(finalStatus, runId)
      .run()

    return { runId, totalImages: targets.length, successCount, failureCount, status: finalStatus }
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

    return { runId, totalImages: targets.length, successCount, failureCount, status: 'failed', errorMessage: message }
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
