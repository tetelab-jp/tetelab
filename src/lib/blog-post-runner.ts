// ============================================
// blog-post-runner.ts
// 「auto_post_enabled_flag=1 かつ approved状態のブログ記事を対象に、
//  月タグに合う日にSALON BOARDへ投稿する」ロジック。手動実行と外部Cron
//  トリガーの両方から呼ばれる。style-post-runner.tsと同じ設計方針だが、
//  ブログ投稿は「登録・反映する」ボタン1回で公開まで完了する1段階の
//  フローのため、reflect(反映申請)相当の別ステップは無い。またSALON
//  BOARD側の予約投稿機能は使わず、いつ投稿するかは常にこちら側の
//  スケジューラ(cron)が判定する(即時投稿ジョブを都度投入する)。
// ============================================

import type { Bindings } from '../types'
import { runBlogPostTask, stopStylePostTask } from './aws-ecs'
import { publishAlert } from './sns-alert'
import { getFooterTextForSalon } from './blog-footer'

const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 5

export async function updateBlogConsecutiveFailureAndNotify(env: Bindings, userId: number, salonId: number | null, success: boolean): Promise<void> {
  const before = await env.DB.prepare(
    `WITH old AS (
       SELECT consecutive_blog_failure_count AS prev_count, email, salon_name
       FROM users WHERE id = ? FOR UPDATE
     )
     UPDATE users u
     SET consecutive_blog_failure_count = CASE WHEN ? THEN 0 ELSE old.prev_count + 1 END
     FROM old
     WHERE u.id = ?
     RETURNING old.prev_count AS prev_count, u.consecutive_blog_failure_count AS next_count, old.email AS email, old.salon_name AS salon_name`
  )
    .bind(userId, success, userId)
    .first<{ prev_count: number; next_count: number; email: string; salon_name: string | null }>()
  if (!before) return

  const prevCount = before.prev_count
  const nextCount = before.next_count
  const wasFailing = prevCount >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD
  const isFailing = nextCount >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD

  if (!wasFailing && isFailing) {
    await env.DB.prepare(
      `UPDATE blog_post_schedules SET paused_until = now() + interval '5 hours', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_id = ?`
    )
      .bind(userId, salonId)
      .run()
      .catch(() => {})
  }

  if (wasFailing === isFailing) return

  const salonLabel = before.salon_name || before.email
  const subject = isFailing
    ? `[SalonMotion] ${salonLabel} のブログ自動投稿が${CONSECUTIVE_FAILURE_ALERT_THRESHOLD}回連続で失敗しています`
    : `[SalonMotion] ${salonLabel} のブログ自動投稿が復旧しました`
  const message = isFailing
    ? `サロン「${salonLabel}」(${before.email})のブログ自動投稿が${CONSECUTIVE_FAILURE_ALERT_THRESHOLD}回連続で失敗しました。管理者サイト(/admin/status)で状況を確認してください。`
    : `サロン「${salonLabel}」(${before.email})のブログ自動投稿が成功し、連続失敗の状態から復旧しました。`

  await publishAlert(env, subject, message).catch((err) => {
    console.error('アラート通知の送信に失敗しました:', err)
  })
}

export async function finalizeBlogRunIfComplete(env: Bindings, runId: number): Promise<void> {
  const { results: pendingJobs } = await env.DB.prepare(
    `SELECT id FROM blog_post_jobs WHERE run_id = ? AND status IN ('pending', 'running')`
  )
    .bind(runId)
    .all<{ id: number }>()
  if (pendingJobs && pendingJobs.length > 0) return

  const { results: finishedJobs } = await env.DB.prepare(`SELECT status FROM blog_post_jobs WHERE run_id = ?`)
    .bind(runId)
    .all<{ status: string }>()
  const statuses = (finishedJobs || []).map((j) => j.status)
  if (statuses.length === 0) return
  const runStatus = statuses.every((s) => s === 'success') ? 'done' : statuses.every((s) => s !== 'success') ? 'failed' : 'partial_failure'

  await env.DB.prepare(`UPDATE blog_post_runs SET status = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(runStatus, runId)
    .run()
}

export type BlogRunSummary = {
  runId: number
  totalArticles: number
  dispatchedCount: number
  failedToDispatchCount: number
  status: 'dispatched' | 'failed'
  errorMessage?: string
}

export type ReadyArticleRow = {
  id: number
  title: string | null
  body: string | null
  image_r2_key: string | null
  image_file_name: string | null
  hpb_category_value: string | null
  category_name: string | null
  stylist_select_value: string | null
}

type ReadyArticleRowInternal = ReadyArticleRow & {
  user_id: number
  salon_id: number | null
  footer_enabled_flag: number
}

const READY_ARTICLE_SELECT = `
  SELECT
    a.id, a.user_id, a.salon_id, a.title, a.body, a.footer_enabled_flag, a.image_r2_key, a.image_file_name,
    bc.hpb_category_value, bc.name AS category_name,
    st.salonboard_stylist_key AS stylist_select_value
  FROM blog_articles a
  LEFT JOIN blog_categories bc ON bc.id = a.category_id
  LEFT JOIN stylists st ON st.id = a.stylist_id
`

/**
 * ジョブ取得API(GET /api/blog-automation/jobs/:id)が記事の中身を組み立てる際に使う。
 * 2026-08-16追記: 記事のfooter_enabled_flagが1の場合、実際にSALON BOARDへ
 * 投稿する本文の末尾にフッター(サロン基本情報+検索されたい言葉)を付ける。
 * 従来はフッターが文字数上限の計算(computeBodyMaxChars)にのみ使われ、実際の
 * 投稿本文には反映されていなかった(UIプレビュー専用だった)ため、ここで
 * 初めて実際の投稿内容に反映させる。
 */
export async function getArticleRowForJob(env: Bindings, articleId: number): Promise<ReadyArticleRow | null> {
  const row = await env.DB.prepare(`${READY_ARTICLE_SELECT} WHERE a.id = ?`).bind(articleId).first<ReadyArticleRowInternal>()
  if (!row) return null
  if (row.footer_enabled_flag === 1 && row.body) {
    const footerText = await getFooterTextForSalon(env, row.user_id, row.salon_id)
    if (footerText) row.body = `${row.body}\n\n${footerText}`
  }
  return row
}

function randomJobToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function dispatchBlogPostJob(
  env: Bindings,
  userId: number,
  salonId: number | null,
  articleId: number,
  runId?: number
): Promise<number> {
  if (!env.APP_BASE_URL) throw new Error('APP_BASE_URLが未設定です')
  if (!env.AWS_REGION) throw new Error('AWS_REGIONが未設定です')
  if (!env.ECS_CLUSTER || !env.ECS_TASK_DEFINITION || !env.ECS_CONTAINER_NAME) {
    throw new Error('ECSクラスタ/タスク定義/コンテナ名が未設定です')
  }
  if (!env.ECS_SUBNET_IDS || !env.ECS_SECURITY_GROUP_IDS) {
    throw new Error('ECSのサブネット/セキュリティグループが未設定です')
  }

  const jobToken = randomJobToken()
  const jobInsert = await env.DB.prepare(
    `INSERT INTO blog_post_jobs (article_id, user_id, salon_id, job_token, status, run_id) VALUES (?, ?, ?, ?, 'pending', ?)`
  )
    .bind(articleId, userId, salonId, jobToken, runId ?? null)
    .run()
  const jobId = Number(jobInsert.meta.last_row_id)

  try {
    const { taskArn } = await runBlogPostTask({
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
    await env.DB.prepare(`UPDATE blog_post_jobs SET status = 'running', ecs_task_arn = ? WHERE id = ?`)
      .bind(taskArn, jobId)
      .run()
    return jobId
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 500)
    await env.DB.prepare(
      `UPDATE blog_post_jobs SET status = 'failed', result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(message, jobId)
      .run()
    // 2026-08-15追記(ユーザー指定): 失敗しても承認状態は解除しない
    // (承認済みのままにしておき、次のローテーションで自動的に再試行される
    // ようにする。5件連続失敗した場合の自動一時停止/アラートは別途機能する)。
    await env.DB.prepare(`UPDATE blog_articles SET last_error = ? WHERE id = ?`)
      .bind(`ジョブ起動に失敗しました: ${message}`, articleId)
      .run()
    await env.DB.prepare(
      `INSERT INTO execution_logs (blog_article_id, user_id, salon_id, execution_type, status, message)
       VALUES (?, ?, ?, 'post_blog_article', 'failure', ?)`
    )
      .bind(articleId, userId, salonId, `ジョブ起動失敗: ${message}`)
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

async function hasInFlightJob(env: Bindings, articleId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 as x FROM blog_post_jobs WHERE article_id = ? AND status IN ('pending', 'running') LIMIT 1`
  )
    .bind(articleId)
    .first<{ x: number }>()
  return !!row
}

function currentJstMonth(): number {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).getUTCMonth() + 1
}

/**
 * 承認済み・自動投稿ON・進行中ジョブなし・月タグが今月に合う(または未設定)、
 * という共通の投稿対象条件。バインド順は (userId, salonId, currentMonth)。
 */
const ELIGIBLE_ARTICLE_WHERE = `
  a.user_id = ? AND a.salon_id = ? AND a.status = 'approved' AND a.auto_post_enabled_flag = 1
  AND NOT EXISTS (SELECT 1 FROM blog_post_jobs j WHERE j.article_id = a.id AND j.status IN ('pending', 'running'))
  AND (
    a.month_tags_json = '[]'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(a.month_tags_json::jsonb) AS m(v) WHERE m.v::int = ?)
  )
`

/** 指定した記事がまだ投稿対象として有効(承認済み・自動投稿ON・進行中ジョブなし等)かを確認する。 */
async function isArticleEligible(env: Bindings, userId: number, salonId: number | null, articleId: number): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT a.id FROM blog_articles a WHERE ${ELIGIBLE_ARTICLE_WHERE} AND a.id = ?`)
    .bind(userId, salonId, currentJstMonth(), articleId)
    .first<{ id: number }>()
  return !!row
}

/**
 * cronの巡回カーソル(next_cursor_article_id)より後ろの最初の1件を選び、
 * 無ければ(カーソル未設定、または最後まで巡回し終えた場合)先頭に戻る。
 */
async function selectNextArticleId(env: Bindings, userId: number, salonId: number | null, cursor: number | null): Promise<number | null> {
  const currentMonth = currentJstMonth()

  if (cursor) {
    const nextRow = await env.DB.prepare(
      `SELECT a.id FROM blog_articles a
       WHERE ${ELIGIBLE_ARTICLE_WHERE}
         AND (a.sort_order, a.id) > (SELECT sort_order, id FROM blog_articles WHERE id = ?)
       ORDER BY a.sort_order ASC, a.id ASC
       LIMIT 1`
    )
      .bind(userId, salonId, currentMonth, cursor)
      .first<{ id: number }>()
    if (nextRow) return nextRow.id
  }

  const firstRow = await env.DB.prepare(
    `SELECT a.id FROM blog_articles a WHERE ${ELIGIBLE_ARTICLE_WHERE} ORDER BY a.sort_order ASC, a.id ASC LIMIT 1`
  )
    .bind(userId, salonId, currentMonth)
    .first<{ id: number }>()
  return firstRow?.id ?? null
}

const MANUAL_DISPATCH_LIMIT = 100
const JOB_WAIT_POLL_INTERVAL_MS = 8000
const JOB_WAIT_MAX_MS = 13 * 60 * 1000 // sweepStaleBlogJobsの15分タイムアウトより少し短く設定

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForJobTerminal(env: Bindings, jobId: number): Promise<void> {
  const deadline = Date.now() + JOB_WAIT_MAX_MS
  while (Date.now() < deadline) {
    const row = await env.DB.prepare(`SELECT status FROM blog_post_jobs WHERE id = ?`).bind(jobId).first<{ status: string }>()
    if (!row || (row.status !== 'pending' && row.status !== 'running')) return
    await sleep(JOB_WAIT_POLL_INTERVAL_MS)
  }
}

/**
 * 2件目以降の記事を、前のジョブが完了してから順に投入する(HTTPレスポンスは
 * 待たずバックグラウンドで進行)。同一アカウントへ複数IPが同時ログインする
 * 不自然さを避けるため、スタイル投稿(style-post-runner.ts)と同じ方式で
 * 1件ずつ順番に投稿する。投入直前に毎回isArticleEligibleで再確認し、
 * 既に無効(OFFにされた・他ジョブが進行中等)ならスキップする。
 */
async function dispatchRemainingArticlesSequentially(
  env: Bindings,
  userId: number,
  salonId: number | null,
  runId: number,
  remaining: { id: number }[],
  previousJobId: number | null
): Promise<void> {
  let prevJobId = previousJobId
  for (const t of remaining) {
    if (prevJobId !== null) {
      await waitForJobTerminal(env, prevJobId)
    }
    if (!(await isArticleEligible(env, userId, salonId, t.id))) {
      prevJobId = null
      continue
    }
    try {
      prevJobId = await dispatchBlogPostJob(env, userId, salonId, t.id, runId)
    } catch {
      prevJobId = null
    }
  }
}

/** 「今すぐまとめて投稿する」ボタンから、承認済み・自動投稿ONの対象記事を全てまとめて投稿する。 */
export async function runBlogAutomationForUser(env: Bindings, userId: number, salonId: number | null): Promise<BlogRunSummary> {
  await requireCredentialsConfigured(env, userId)

  const alreadyInFlight = await env.DB.prepare(
    `SELECT 1 as x FROM blog_post_jobs WHERE user_id = ? AND salon_id = ? AND status IN ('pending', 'running') LIMIT 1`
  )
    .bind(userId, salonId)
    .first<{ x: number }>()
  if (alreadyInFlight) {
    throw new Error('既に投稿処理が進行中です。完了してからもう一度お試しください')
  }

  const { results } = await env.DB.prepare(
    `SELECT a.id FROM blog_articles a WHERE ${ELIGIBLE_ARTICLE_WHERE} ORDER BY a.sort_order ASC, a.id ASC LIMIT ${MANUAL_DISPATCH_LIMIT}`
  )
    .bind(userId, salonId, currentJstMonth())
    .all<{ id: number }>()

  const targets = results || []
  if (targets.length === 0) {
    throw new Error('投稿対象(承認済み・自動投稿ON・今月の季節柄に合う)のブログ記事がありません')
  }

  const runInsert = await env.DB.prepare(
    `INSERT INTO blog_post_runs (user_id, salon_id, scheduled_time, total_articles, status) VALUES (?, ?, ?, ?, 'processing')`
  )
    .bind(userId, salonId, currentJstTimeLabel(), targets.length)
    .run()
  const runId = Number(runInsert.meta.last_row_id)

  // 1件目のみここで投入し、2件目以降は前のジョブが完了してから順に投入する。
  // ALBのアイドルタイムアウト(60秒)内にHTTPレスポンスを返す必要があるため、
  // 2件目以降の投入はawaitせずバックグラウンドで進める(style-post-runner.tsと同じ方式)。
  let firstDispatchFailed = false
  let firstDispatchErrorMessage: string | undefined
  let firstJobId: number | null = null
  try {
    firstJobId = await dispatchBlogPostJob(env, userId, salonId, targets[0].id, runId)
  } catch (err: any) {
    firstDispatchFailed = true
    firstDispatchErrorMessage = String(err?.message || err).slice(0, 500)
  }

  if (targets.length > 1) {
    void dispatchRemainingArticlesSequentially(env, userId, salonId, runId, targets.slice(1), firstJobId)
  }

  const runStatus = firstDispatchFailed && targets.length === 1 ? 'failed' : 'processing'
  await env.DB.prepare(`UPDATE blog_post_runs SET status = ?, error_message = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(runStatus, firstDispatchFailed ? firstDispatchErrorMessage : null, runId)
    .run()

  return {
    runId,
    totalArticles: targets.length,
    dispatchedCount: firstDispatchFailed ? 0 : 1,
    failedToDispatchCount: firstDispatchFailed ? 1 : 0,
    status: firstDispatchFailed && targets.length === 1 ? 'failed' : 'dispatched',
    errorMessage: firstDispatchFailed ? firstDispatchErrorMessage : undefined
  }
}

const BLACKOUT_START_MINUTES = 2 * 60 // 02:00
const BLACKOUT_END_MINUTES = 7 * 60 // 07:00
// スタイル投稿(60分おきに巡回)と異なり、ブログ記事は「1日1本」を想定した
// 生成テンプレート(写真1枚=記事1本)のため、cronからの巡回間隔は20時間とする
// (多少前後してもおおよそ1日1回のペースになる)。
const POST_INTERVAL_MINUTES = 20 * 60

function jstMinutesOfDay(nowLabel: string): number {
  const [hh, mm] = nowLabel.split(':').map(Number)
  return hh * 60 + mm
}

type BlogScheduleState = {
  next_cursor_article_id: number | null
  paused_until: string | null
}

async function shouldPostNow(env: Bindings, userId: number, salonId: number | null, nowLabel: string, schedule: BlogScheduleState): Promise<boolean> {
  const nowMinutes = jstMinutesOfDay(nowLabel)
  if (nowMinutes >= BLACKOUT_START_MINUTES && nowMinutes < BLACKOUT_END_MINUTES) return false

  if (schedule.paused_until) {
    const pausedUntilMs = new Date(schedule.paused_until.replace(' ', 'T') + 'Z').getTime()
    if (pausedUntilMs > Date.now()) return false
  }

  const inFlight = await env.DB.prepare(
    `SELECT 1 as x FROM blog_post_jobs WHERE user_id = ? AND salon_id = ? AND status IN ('pending', 'running') LIMIT 1`
  )
    .bind(userId, salonId)
    .first<{ x: number }>()
  if (inFlight) return false

  const lastRow = await env.DB.prepare(`SELECT MAX(created_at) as last_at FROM blog_post_jobs WHERE user_id = ? AND salon_id = ?`)
    .bind(userId, salonId)
    .first<{ last_at: string | null }>()
  if (!lastRow?.last_at) return true
  const lastAtMs = new Date(lastRow.last_at.replace(' ', 'T') + 'Z').getTime()
  const minutesSinceLast = (Date.now() - lastAtMs) / 60000
  return minutesSinceLast >= POST_INTERVAL_MINUTES
}

/**
 * 深夜2:00〜7:00を除く時間帯に、約1日1本のペースで記事を巡回投稿する。
 * 外部Cronから1分間隔で呼ばれる想定(style-post-runner.tsのrunNextStyleForUserと同じ形)。
 */
export async function runNextArticleForUser(env: Bindings, userId: number, salonId: number | null, scheduledTimeLabel: string): Promise<BlogRunSummary | null> {
  const schedule = await env.DB.prepare(
    `SELECT next_cursor_article_id, paused_until FROM blog_post_schedules WHERE user_id = ? AND salon_id = ?`
  )
    .bind(userId, salonId)
    .first<BlogScheduleState>()
  if (!schedule) return null
  if (!(await shouldPostNow(env, userId, salonId, scheduledTimeLabel, schedule))) return null

  await requireCredentialsConfigured(env, userId)

  const articleId = await selectNextArticleId(env, userId, salonId, schedule.next_cursor_article_id)
  if (!articleId) return null

  const runInsert = await env.DB.prepare(
    `INSERT INTO blog_post_runs (user_id, salon_id, scheduled_time, total_articles, status) VALUES (?, ?, ?, 1, 'processing')`
  )
    .bind(userId, salonId, scheduledTimeLabel)
    .run()
  const runId = Number(runInsert.meta.last_row_id)

  try {
    await dispatchBlogPostJob(env, userId, salonId, articleId, runId)
    await env.DB.prepare(`UPDATE blog_post_schedules SET next_cursor_article_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_id = ?`)
      .bind(articleId, userId, salonId)
      .run()
    return { runId, totalArticles: 1, dispatchedCount: 1, failedToDispatchCount: 0, status: 'dispatched' }
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 500)
    await env.DB.prepare(`UPDATE blog_post_schedules SET next_cursor_article_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_id = ?`)
      .bind(articleId, userId, salonId)
      .run()
    await updateBlogConsecutiveFailureAndNotify(env, userId, salonId, false)
    await env.DB.prepare(`UPDATE blog_post_runs SET status = 'failed', error_message = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(message, runId)
      .run()
    return { runId, totalArticles: 1, dispatchedCount: 0, failedToDispatchCount: 1, status: 'failed', errorMessage: message }
  }
}

export type BlogRetryResult = { outcome: 'dispatched' | 'failed' }

/** 失敗した1件のブログ記事のみを再実行する(承認済みへ戻した上で使う想定)。 */
export async function retryBlogPost(env: Bindings, userId: number, salonId: number | null, articleId: number): Promise<BlogRetryResult> {
  await requireCredentialsConfigured(env, userId)

  const row = await env.DB.prepare(`SELECT id FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ? AND status = 'approved'`)
    .bind(articleId, userId, salonId)
    .first<{ id: number }>()
  if (!row) throw new Error('対象の記事が見つからないか、承認済み状態ではありません')
  if (await hasInFlightJob(env, articleId)) {
    throw new Error('この記事は既に処理中のジョブがあります。完了を待ってから再実行してください')
  }

  try {
    await dispatchBlogPostJob(env, userId, salonId, articleId)
    return { outcome: 'dispatched' }
  } catch {
    return { outcome: 'failed' }
  }
}

type StaleBlogJobRow = { id: number; article_id: number; user_id: number; salon_id: number | null; ecs_task_arn: string | null; run_id: number | null }

async function clearStaleBlogJob(env: Bindings, j: StaleBlogJobRow): Promise<void> {
  if (j.ecs_task_arn && env.ECS_CLUSTER && env.AWS_REGION) {
    await stopStylePostTask({
      awsRegion: env.AWS_REGION,
      cluster: env.ECS_CLUSTER,
      taskArn: j.ecs_task_arn,
      reason: 'ジョブがタイムアウトしたため停止'
    }).catch((err) => {
      console.error(`ブログジョブ${j.id}のFargateタスク(${j.ecs_task_arn})停止に失敗しました:`, err)
    })
  }
  await env.DB.prepare(
    `UPDATE blog_post_jobs SET status = 'timeout', result_message = 'タイムアウト(結果コールバックがありませんでした)', completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(j.id)
    .run()
  await env.DB.prepare(`UPDATE blog_articles SET last_error = 'Fargateジョブがタイムアウトしました(応答がありませんでした)' WHERE id = ?`)
    .bind(j.article_id)
    .run()
  await env.DB.prepare(
    `INSERT INTO execution_logs (blog_article_id, user_id, salon_id, execution_type, status, message)
     VALUES (?, ?, ?, 'post_blog_article', 'failure', 'ジョブがタイムアウトしました(Fargateタスクからの応答なし)')`
  )
    .bind(j.article_id, j.user_id, j.salon_id)
    .run()
  await updateBlogConsecutiveFailureAndNotify(env, j.user_id, j.salon_id, false)
  if (j.run_id) await finalizeBlogRunIfComplete(env, j.run_id)
}

/** 15分以上結果コールバックが届かないジョブをタイムアウト扱いにする(cronから毎回呼ぶ)。 */
export async function sweepStaleBlogJobs(env: Bindings): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, article_id, user_id, salon_id, ecs_task_arn, run_id FROM blog_post_jobs
     WHERE status IN ('pending', 'running') AND created_at < (now() - interval '15 minutes')`
  ).all<StaleBlogJobRow>()
  const staleJobs = results || []
  for (const j of staleJobs) await clearStaleBlogJob(env, j)
  return staleJobs.length
}

export async function resetStuckBlogJobsForUser(env: Bindings, userId: number, salonId: number | null): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, article_id, user_id, salon_id, ecs_task_arn, run_id FROM blog_post_jobs
     WHERE user_id = ? AND salon_id = ? AND status IN ('pending', 'running') AND created_at < (now() - interval '15 minutes')`
  )
    .bind(userId, salonId)
    .all<StaleBlogJobRow>()
  const staleJobs = results || []
  for (const j of staleJobs) await clearStaleBlogJob(env, j)
  return staleJobs.length
}

export function currentJstTimeLabel(): string {
  const now = new Date()
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mm = String(jst.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
