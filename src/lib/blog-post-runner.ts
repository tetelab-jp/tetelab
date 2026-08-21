// ============================================
// blog-post-runner.ts
// 「auto_post_enabled_flag=1のブログ記事を対象に、
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
import { getFooterTextAndSeparatorForSalon, stripTrailingFooterBlock } from './blog-footer'
import { hasAnyInFlightSalonAutomationJob } from './automation-lock'

const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 2

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
  coupon_select_value: string | null
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
    st.salonboard_stylist_key AS stylist_select_value,
    cp.salonboard_coupon_key AS coupon_select_value
  FROM blog_articles a
  LEFT JOIN blog_categories bc ON bc.id = a.category_id AND bc.user_id = a.user_id AND bc.salon_id = a.salon_id
  LEFT JOIN stylists st ON st.id = a.stylist_id AND st.user_id = a.user_id AND st.salon_id = a.salon_id
  LEFT JOIN coupons cp ON cp.id = a.coupon_id AND cp.user_id = a.user_id AND cp.salon_id = a.salon_id
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
    const { text: footerText, separator } = await getFooterTextAndSeparatorForSalon(env, row.user_id, row.salon_id)
    if (footerText) {
      // 2026-08-21追記(重大バグ修正): row.bodyに既にフッターが焼き込まれている
      // ケース(下記/blog/articles/:id/editのバグ、または過去の不具合で保存された
      // データ)があると、ここで無条件に付け足すとフッターが二重になり、
      // 全角1000文字制限を超えてSALON BOARD側の確認画面へ進めず投稿失敗する
      // (実機ログで確認済み)。付ける前に末尾の既存フッターを取り除いておく
      // ことで、何重に焼き込まれていても常に1つだけになるようにする。
      // フッター内容(基本情報・SEO対策ワード)が本文保存後に変更され、
      // 完全一致でのstripが効かなくなるケースにも対応できるよう、区切り行
      // (footer_separatorを16回繰り返した行)を境界マーカーとしても検出する
      // stripTrailingFooterBlockを使う(ユーザー指定)。
      const cleanBody = stripTrailingFooterBlock(row.body, footerText, separator)
      row.body = `${cleanBody}\n\n${footerText}`
    }
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
  if (await hasAnyInFlightSalonAutomationJob(env, salonId)) {
    throw new Error('このサロンは他の自動化ジョブ(スタイル投稿/口コミ同期/口コミ返信)が進行中のため、投入を見送りました')
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
 * 2026-08-21追記(ユーザー指定): HPBブログカテゴリ未設定の記事は投稿する
 * たびに必ず失敗するため(blog.tsxの一覧表示時にauto_post_enabled_flagを
 * 自動でOFFにする保護を入れているが)、万一ONのまま選ばれてしまう競合を
 * 避ける保険として、選定条件自体にも実効HPBブログカテゴリの有無を含める。
 * 2026-08-21追記(ユーザー指摘によるバグ修正): status='approved'(登録ブログ
 * 一覧に表示される=ユーザーが「投稿一覧に追加」/「保存する」を押して確定
 * させた)条件も明示的に含める。まだユーザーが内容を確認・保存していない
 * 生成直後のunapproved状態の記事が、cron/自動投稿の巡回対象に混入しない
 * ようにするため。
 * 2026-08-21追記(ユーザー指定): 自動投稿の必須条件を画像・投稿者にも拡張。
 * image_r2_key/stylist_idは記事行に直接持つ列なので書き込み時の検証で
 * 通常は保証されるが、投稿者(stylists)はON DELETE SET NULLのため、参照先の
 * スタイリストが削除されると記事側を直接更新しないままstylist_idだけが
 * 静かにNULLになりうる(HPBブログカテゴリがblog_categories側の変更で
 * 無効化されうるのと同じ理由)。選定条件自体にも含めて保険とする。
 * タイトル・本文の文字数は書き込み経路(articleAutoPostRequirementsMet)側で
 * 常に保証され、上記のような外部要因での事後変化もないため、SQL側では見ない。
 */
const ELIGIBLE_ARTICLE_WHERE = `
  a.user_id = ? AND a.salon_id = ? AND a.status = 'approved' AND a.auto_post_enabled_flag = 1
  AND a.image_r2_key IS NOT NULL AND a.stylist_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM blog_categories bc WHERE bc.id = a.category_id AND bc.hpb_category_value IS NOT NULL)
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

// 2026-08-17追記(ユーザー指定): ブログの投稿日時は毎日AM8:00固定とする
// (ranking.tsxの「定期測定は毎週月曜日固定」と同じ、cronは1分間隔で叩かれる
// (infra/eventbridge.tf、rate(1 minute))が、実際の投稿はこちら側で
// 「JST 08:00を過ぎていて、かつ今日(JST)まだ投稿していなければ1回だけ」に
// ゲートする方式)。
const DAILY_POST_TIME_LABEL = '08:00'

function jstYmdFromUtcTimestamp(utcTimestamp: string): string {
  const jst = new Date(new Date(utcTimestamp.replace(' ', 'T') + 'Z').getTime() + 9 * 60 * 60 * 1000)
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`
}

function jstYmdNow(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`
}

type BlogScheduleState = {
  next_cursor_article_id: number | null
  paused_until: string | null
}

async function shouldPostNow(env: Bindings, userId: number, salonId: number | null, nowLabel: string, schedule: BlogScheduleState): Promise<boolean> {
  if (nowLabel < DAILY_POST_TIME_LABEL) return false

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

  // 今日(JST)すでに投稿(ジョブ投入)済みなら、1日1回のペースを守るためスキップする。
  const lastRow = await env.DB.prepare(`SELECT MAX(created_at) as last_at FROM blog_post_jobs WHERE user_id = ? AND salon_id = ?`)
    .bind(userId, salonId)
    .first<{ last_at: string | null }>()
  if (!lastRow?.last_at) return true
  return jstYmdFromUtcTimestamp(lastRow.last_at) !== jstYmdNow()
}

/**
 * 毎日JST 08:00に、1日1本のペースで記事を巡回投稿する。
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

/** 失敗した1件のブログ記事のみを再実行する。 */
export async function retryBlogPost(env: Bindings, userId: number, salonId: number | null, articleId: number): Promise<BlogRetryResult> {
  await requireCredentialsConfigured(env, userId)

  const row = await env.DB.prepare(`SELECT id FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ?`)
    .bind(articleId, userId, salonId)
    .first<{ id: number }>()
  if (!row) throw new Error('対象の記事が見つかりません')
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
