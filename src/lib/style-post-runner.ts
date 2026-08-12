// ============================================
// style-post-runner.ts
// 「auto_post_enabled_flag=1 かつ ready状態のスタイルを対象に投稿する」
// ロジック。手動実行（automation.tsx）と外部Cronトリガー（同route）の
// 両方から呼ばれる。
//
// 2026-08-10変更: Cloudflare Browser Renderingにファイルシステムが無く
// 標準的なファイルアップロードAPIが使えない制約のため、実際のPuppeteer
// 実行はAWS ECS/Fargateのワーカー(worker/)に切り出した。この関数群の
// 役割は「対象スタイルを判定し、AWS側にジョブを1件投入する」ところまでで、
// 実際の成否(登録/反映申請の結果)は、Fargateタスクからの非同期コールバック
// (POST /api/automation/jobs/:id/result、automation.tsx側)で
// styles / execution_logs に反映される。そのため本ファイル内では
// 「ジョブを何件投入できたか」までしか分からず、最終結果は含まれない。
// ============================================

import type { Bindings } from '../types'
import { runStylePostTask } from './aws-ecs'

// SalonMotion側の運用上の1日あたり自動投稿上限（SALON BOARD自体の上限ではない）
const DAILY_POST_LIMIT = 100

export type RunSummary = {
  runId: number
  totalImages: number
  dispatchedCount: number
  failedToDispatchCount: number
  status: 'dispatched' | 'failed'
  errorMessage?: string
}

export type ReadyStyleRow = {
  id: number
  title: string | null
  comment: string | null
  category_value: string | null
  length_value: string | null
  menu_values_json: string
  menu_detail_text: string | null
  stylist_select_value: string | null
  coupon_select_value: string | null
  front_r2_key: string | null
  front_file_name: string | null
}

export const READY_STYLE_SELECT = `
  SELECT
    s.id, s.title, s.comment, s.category_value, s.length_value,
    s.menu_values_json, s.menu_detail_text,
    st.salonboard_stylist_key AS stylist_select_value,
    cp.salonboard_coupon_key AS coupon_select_value,
    si.r2_key AS front_r2_key, si.file_name AS front_file_name
  FROM styles s
  LEFT JOIN stylists st ON st.id = s.stylist_id
  LEFT JOIN coupons cp ON cp.id = s.coupon_id
  LEFT JOIN style_images si ON si.style_id = s.id AND si.image_role = 'FRONT'
`

/** ジョブ取得API(GET /api/automation/jobs/:id)がスタイルの中身を組み立てる際に使う */
export async function getStyleRowForJob(env: Bindings, styleId: number): Promise<ReadyStyleRow | null> {
  return env.DB.prepare(`${READY_STYLE_SELECT} WHERE s.id = ?`).bind(styleId).first<ReadyStyleRow>()
}

function randomJobToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 1件のスタイルについて、AWS ECS/Fargateへ投稿ジョブを1件投入する。
 * style_post_jobsへレコードを作成し、ECS RunTaskでタスクを起動する。
 * 実際のログイン・登録・反映申請はFargateタスク側で行われ、結果は
 * 後で /api/automation/jobs/:id/result へのコールバックとして届く。
 */
async function dispatchStylePostJob(env: Bindings, userId: number, styleId: number, runId?: number): Promise<void> {
  if (!env.APP_BASE_URL) throw new Error('APP_BASE_URLが未設定です')
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.AWS_REGION) {
    throw new Error('AWSの認証情報(AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION)が未設定です')
  }
  if (!env.ECS_CLUSTER || !env.ECS_TASK_DEFINITION || !env.ECS_CONTAINER_NAME) {
    throw new Error('ECSクラスタ/タスク定義/コンテナ名が未設定です')
  }
  if (!env.ECS_SUBNET_IDS || !env.ECS_SECURITY_GROUP_IDS) {
    throw new Error('ECSのサブネット/セキュリティグループが未設定です')
  }

  const jobToken = randomJobToken()
  const jobInsert = await env.DB.prepare(
    `INSERT INTO style_post_jobs (style_id, user_id, job_token, status, run_id) VALUES (?, ?, ?, 'pending', ?)`
  )
    .bind(styleId, userId, jobToken, runId ?? null)
    .run()
  const jobId = Number(jobInsert.meta.last_row_id)

  try {
    const { taskArn } = await runStylePostTask({
      awsAccessKeyId: env.AWS_ACCESS_KEY_ID,
      awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      awsRegion: env.AWS_REGION,
      cluster: env.ECS_CLUSTER,
      taskDefinition: env.ECS_TASK_DEFINITION,
      containerName: env.ECS_CONTAINER_NAME,
      subnetIds: env.ECS_SUBNET_IDS.split(',').map((s) => s.trim()).filter(Boolean),
      securityGroupIds: env.ECS_SECURITY_GROUP_IDS.split(',').map((s) => s.trim()).filter(Boolean),
      jobApiBase: env.APP_BASE_URL,
      jobId,
      jobToken
    })
    await env.DB.prepare(`UPDATE style_post_jobs SET status = 'running', ecs_task_arn = ? WHERE id = ?`)
      .bind(taskArn, jobId)
      .run()
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 500)
    await env.DB.prepare(
      `UPDATE style_post_jobs SET status = 'failed', result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(message, jobId)
      .run()
    await env.DB.prepare(`UPDATE styles SET salonboard_register_status = 'failed', last_error = ? WHERE id = ?`)
      .bind(`ジョブ起動に失敗しました: ${message}`, styleId)
      .run()
    await env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
       VALUES (NULL, ?, ?, 'register_style', 'failure', ?)`
    )
      .bind(userId, styleId, `ジョブ起動失敗: ${message}`)
      .run()
    throw err
  }
}

async function requireCredentialsConfigured(env: Bindings, userId: number): Promise<void> {
  const cred = await env.DB.prepare('SELECT user_id FROM salon_credentials WHERE user_id = ?')
    .bind(userId)
    .first<{ user_id: number }>()
  if (!cred) throw new Error('サロンボードのログイン情報が未登録です')
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEYが未設定です')
}

export async function runStyleAutomationForUser(
  env: Bindings,
  userId: number,
  scheduledTimeLabel: string
): Promise<RunSummary> {
  await requireCredentialsConfigured(env, userId)

  const { results } = await env.DB.prepare(
    `SELECT s.id FROM styles s
     WHERE s.user_id = ? AND s.auto_post_enabled_flag = 1 AND s.internal_save_status = 'ready'
       AND s.reflection_request_status IN ('not_started', 'failed', 'blocked')
     ORDER BY s.sort_order ASC, s.id ASC
     LIMIT ${DAILY_POST_LIMIT}`
  )
    .bind(userId)
    .all<{ id: number }>()

  const targets = results || []
  if (targets.length === 0) {
    throw new Error('投稿対象（自動投稿ON・入力完了済み）のスタイルがありません')
  }

  const runInsert = await env.DB.prepare(
    `INSERT INTO style_post_runs (user_id, scheduled_time, total_images, status)
     VALUES (?, ?, ?, 'processing')`
  )
    .bind(userId, scheduledTimeLabel, targets.length)
    .run()
  const runId = Number(runInsert.meta.last_row_id)

  let dispatchedCount = 0
  let failedToDispatchCount = 0
  for (const t of targets) {
    try {
      await dispatchStylePostJob(env, userId, t.id, runId)
      dispatchedCount++
    } catch {
      failedToDispatchCount++
    }
  }

  // 各ジョブの最終結果(成功/失敗/ブロック)はFargateからの非同期コールバックで
  // 個別に反映される。ここでは「何件投入できたか」までしか分からないため、
  // style_post_runs.status は 'processing' のまま残す(集計の確定は行わない)。
  const runStatus = dispatchedCount > 0 ? 'processing' : 'failed'
  await env.DB.prepare(`UPDATE style_post_runs SET status = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(runStatus, runId)
    .run()

  return {
    runId,
    totalImages: targets.length,
    dispatchedCount,
    failedToDispatchCount,
    status: dispatchedCount > 0 ? 'dispatched' : 'failed'
  }
}

// 「7:00〜24:00の間に均等に分散して投稿する」ための時間窓(JST・分)。
const DAILY_WINDOW_START_MINUTES = 7 * 60 // 07:00
const DAILY_WINDOW_END_MINUTES = 24 * 60 // 24:00(=翌0:00)

function jstMinutesOfDay(nowLabel: string): number {
  const [hh, mm] = nowLabel.split(':').map(Number)
  return hh * 60 + mm
}

/**
 * 「7:00〜24:00の間に均等に分散して投稿する」ための判定。
 * 残り時間と残り対象件数から理想の投稿間隔を毎回動的に算出し、
 * 本日最後に投稿(ジョブ投入)した時刻からその間隔以上経過していれば
 * 次の1件を投入してよいと判定する。
 */
async function shouldPostNextStyle(env: Bindings, userId: number, nowLabel: string): Promise<boolean> {
  const nowMinutes = jstMinutesOfDay(nowLabel)
  if (nowMinutes < DAILY_WINDOW_START_MINUTES || nowMinutes >= DAILY_WINDOW_END_MINUTES) return false

  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM (
       SELECT s.id FROM styles s
       WHERE s.user_id = ? AND s.auto_post_enabled_flag = 1 AND s.internal_save_status = 'ready'
         AND s.reflection_request_status IN ('not_started', 'failed', 'blocked')
       ORDER BY s.sort_order ASC, s.id ASC
       LIMIT ${DAILY_POST_LIMIT}
     )`
  )
    .bind(userId)
    .first<{ cnt: number }>()

  const remainingCount = countRow?.cnt ?? 0
  if (remainingCount === 0) return false

  const remainingMinutes = DAILY_WINDOW_END_MINUTES - nowMinutes
  if (remainingMinutes <= 0) return false

  const idealIntervalMinutes = remainingMinutes / remainingCount

  // last_executed_at はUTCのnaive timestampとして保存されているため、
  // 一度UTCのtimestamptzへ変換してからAsia/Tokyoのnaive timestampへ
  // 変換し、日付部分だけを比較する(SQLiteの date(col, '+9 hours') と同義)。
  const lastRow = await env.DB.prepare(
    `SELECT MAX(last_executed_at) as last_at FROM styles
     WHERE user_id = ? AND last_executed_at IS NOT NULL
       AND (last_executed_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Tokyo')::date
         = (now() AT TIME ZONE 'Asia/Tokyo')::date`
  )
    .bind(userId)
    .first<{ last_at: string | null }>()

  if (!lastRow?.last_at) return true

  const lastAtMs = new Date(lastRow.last_at.replace(' ', 'T') + 'Z').getTime()
  const minutesSinceLastPost = (Date.now() - lastAtMs) / 60000

  return minutesSinceLastPost >= idealIntervalMinutes
}

/**
 * 「7:00〜24:00の間に均等に分散して投稿する」方式で、1回の呼び出しにつき
 * 最大1件のスタイルのみジョブ投入する。外部Cronから1分間隔で呼ばれる想定。
 */
export async function runNextStyleForUser(
  env: Bindings,
  userId: number,
  scheduledTimeLabel: string
): Promise<RunSummary | null> {
  const shouldPost = await shouldPostNextStyle(env, userId, scheduledTimeLabel)
  if (!shouldPost) return null

  await requireCredentialsConfigured(env, userId)

  const row = await env.DB.prepare(
    `SELECT s.id FROM styles s
     WHERE s.user_id = ? AND s.auto_post_enabled_flag = 1 AND s.internal_save_status = 'ready'
       AND s.reflection_request_status IN ('not_started', 'failed', 'blocked')
     ORDER BY s.sort_order ASC, s.id ASC
     LIMIT 1`
  )
    .bind(userId)
    .first<{ id: number }>()

  if (!row) return null

  const runInsert = await env.DB.prepare(
    `INSERT INTO style_post_runs (user_id, scheduled_time, total_images, status)
     VALUES (?, ?, 1, 'processing')`
  )
    .bind(userId, scheduledTimeLabel)
    .run()
  const runId = Number(runInsert.meta.last_row_id)

  try {
    await dispatchStylePostJob(env, userId, row.id, runId)
    return { runId, totalImages: 1, dispatchedCount: 1, failedToDispatchCount: 0, status: 'dispatched' }
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 500)
    await env.DB.prepare(
      `UPDATE style_post_runs SET status = 'failed', error_message = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(message, runId)
      .run()
    return {
      runId,
      totalImages: 1,
      dispatchedCount: 0,
      failedToDispatchCount: 1,
      status: 'failed',
      errorMessage: message
    }
  }
}

export type RetryResult = { outcome: 'dispatched' | 'failed' }

/**
 * 失敗/ブロックされた1件のスタイルのみを再実行する(ジョブ投入)。
 * internal_save_status='ready'であることのみ要求する。
 */
export async function retryStylePost(env: Bindings, userId: number, styleId: number): Promise<RetryResult> {
  await requireCredentialsConfigured(env, userId)

  const row = await env.DB.prepare(
    `SELECT id FROM styles WHERE id = ? AND user_id = ? AND internal_save_status = 'ready'`
  )
    .bind(styleId, userId)
    .first<{ id: number }>()

  if (!row) throw new Error('対象のスタイルが見つからないか、入力が未完了(ready状態でない)です')

  try {
    await dispatchStylePostJob(env, userId, styleId)
    return { outcome: 'dispatched' }
  } catch {
    return { outcome: 'failed' }
  }
}

/**
 * 一定時間(10分)以上結果コールバックが届かないジョブをタイムアウト扱いにする。
 * cron-trigger-workerの1分間隔の呼び出しの中で、次のジョブ投入前に実行する。
 */
export async function sweepStaleJobs(env: Bindings): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, style_id, user_id FROM style_post_jobs
     WHERE status IN ('pending', 'running') AND created_at < (now() - interval '10 minutes')`
  ).all<{ id: number; style_id: number; user_id: number }>()

  const staleJobs = results || []
  for (const j of staleJobs) {
    await env.DB.prepare(
      `UPDATE style_post_jobs SET status = 'timeout',
         result_message = 'タイムアウト(10分以内に結果コールバックがありませんでした)',
         completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
      .bind(j.id)
      .run()
    await env.DB.prepare(
      `UPDATE styles SET salonboard_register_status = 'failed',
         last_error = 'Fargateジョブがタイムアウトしました(10分以内に応答がありませんでした)'
       WHERE id = ?`
    )
      .bind(j.style_id)
      .run()
    await env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
       VALUES (NULL, ?, ?, 'register_style', 'failure', 'ジョブがタイムアウトしました(Fargateタスクからの応答なし)')`
    )
      .bind(j.user_id, j.style_id)
      .run()
  }
  return staleJobs.length
}

/** 現在時刻をJST(UTC+9) "HH:MM" 形式で返す */
export function currentJstTimeLabel(): string {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mm = String(jst.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
