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
import { runStylePostTask, stopStylePostTask } from './aws-ecs'

// SalonMotion側の運用上の1日あたり自動投稿上限（SALON BOARD自体の上限ではない）
const DAILY_POST_LIMIT = 100

// 手動実行で複数スタイルを同時に投入すると、同一サロンボードアカウントへ
// 複数のFargateタスク(=複数の出口IP)が同時にログインする状態になり、
// (1)プロキシ側が同一セッションへの同時並行アクセスを捌けずアップロードが
// 失敗する、(2)IPを分けたとしても「同一アカウントへの複数IPからの同時
// ログイン」自体が不自然でボット検知のリスクになる、という2つの問題が
// あることが実運用で判明した。そのため2件目以降は、前のジョブが完了する
// (またはこの上限時間が経過する)まで待ってから順に投入する。
const JOB_WAIT_POLL_INTERVAL_MS = 8000
const JOB_WAIT_MAX_MS = 13 * 60 * 1000 // sweepStaleJobsの15分タイムアウトより少し短く設定

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
  hashtags_json: string
  stylist_select_value: string | null
  coupon_select_value: string | null
  front_r2_key: string | null
  front_file_name: string | null
}

export const READY_STYLE_SELECT = `
  SELECT
    s.id, s.title, s.comment, s.category_value, s.length_value,
    s.menu_values_json, s.menu_detail_text, s.hashtags_json,
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

/**
 * 登録スタイル一覧(StyleListSection)の表示順(No.)を、実行ログ記録時点の
 * スナップショットとして取得する。並び順(sort_order)は後から変更されうるため、
 * execution_logs.style_noへ都度保存し、後で並びが変わっても実行時点のNo.を
 * 表示できるようにする。
 */
export async function getStyleNo(env: Bindings, userId: number, styleId: number): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT no FROM (
       SELECT id, ROW_NUMBER() OVER (ORDER BY sort_order ASC, id DESC) AS no
       FROM styles WHERE user_id = ?
     ) ranked WHERE id = ?`
  )
    .bind(userId, styleId)
    .first<{ no: number }>()
  return row?.no ?? null
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
async function dispatchStylePostJob(env: Bindings, userId: number, styleId: number, runId?: number): Promise<number> {
  if (!env.APP_BASE_URL) throw new Error('APP_BASE_URLが未設定です')
  if (!env.AWS_REGION) {
    throw new Error('AWS_REGIONが未設定です')
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
    return jobId
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
    const styleNo = await getStyleNo(env, userId, styleId)
    await env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, 'register_style', 'failure', ?)`
    )
      .bind(userId, styleId, styleNo, `ジョブ起動失敗: ${message}`)
      .run()
    throw err
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 2026-08-13追記(重大バグ修正): このスタイルに対して既に進行中
 * (pending/running)のジョブが無いかを確認する。last_executed_atは
 * ジョブ完了時にしか更新されないため、これが無いと「投入してから
 * 結果コールバックが届くまでの数分間」に同じスタイルへ何度も
 * cron/手動実行から重複してジョブを投入してしまい、実質的な
 * 二重投稿(SALON BOARDへの重複登録)を招く恐れがあった。
 */
async function hasInFlightJob(env: Bindings, styleId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 as x FROM style_post_jobs WHERE style_id = ? AND status IN ('pending', 'running') LIMIT 1`
  )
    .bind(styleId)
    .first<{ x: number }>()
  return !!row
}

/** 指定ジョブが完了(pending/running以外の状態)になるまで待つ。複数スタイルの手動実行を1件ずつ順に処理するために使う。 */
async function waitForJobTerminal(env: Bindings, jobId: number): Promise<void> {
  const deadline = Date.now() + JOB_WAIT_MAX_MS
  while (Date.now() < deadline) {
    const row = await env.DB.prepare(`SELECT status FROM style_post_jobs WHERE id = ?`).bind(jobId).first<{ status: string }>()
    if (!row || (row.status !== 'pending' && row.status !== 'running')) return
    await sleep(JOB_WAIT_POLL_INTERVAL_MS)
  }
}

/**
 * 2件目以降のスタイルを、前のジョブが完了してから順に投入する。
 * HTTPレスポンスをすぐ返せるよう、呼び出し側ではawaitせずバックグラウンドで進める。
 */
async function dispatchRemainingStylesSequentially(
  env: Bindings,
  userId: number,
  runId: number,
  remaining: { id: number }[],
  previousJobId: number | null
): Promise<void> {
  let prevJobId = previousJobId
  for (const t of remaining) {
    if (prevJobId !== null) {
      await waitForJobTerminal(env, prevJobId)
    }
    try {
      prevJobId = await dispatchStylePostJob(env, userId, t.id, runId)
    } catch {
      prevJobId = null
    }
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
       AND NOT EXISTS (
         SELECT 1 FROM style_post_jobs j WHERE j.style_id = s.id AND j.status IN ('pending', 'running')
       )
     ORDER BY s.sort_order ASC, s.id ASC
     LIMIT ${DAILY_POST_LIMIT}`
  )
    .bind(userId)
    .all<{ id: number }>()

  const targets = results || []
  if (targets.length === 0) {
    throw new Error('投稿対象（自動投稿ON・入力完了済み・進行中ジョブなし）のスタイルがありません')
  }

  const runInsert = await env.DB.prepare(
    `INSERT INTO style_post_runs (user_id, scheduled_time, total_images, status)
     VALUES (?, ?, ?, 'processing')`
  )
    .bind(userId, scheduledTimeLabel, targets.length)
    .run()
  const runId = Number(runInsert.meta.last_row_id)

  // 複数スタイルを同時に投入すると同一アカウントへ複数IPが同時ログインする
  // 状態になり不自然でボット検知のリスクとなるため、1件目のみここで
  // 投入し、2件目以降は前のジョブが完了してから順に投入する。
  // ALBのアイドルタイムアウト(60秒)内にHTTPレスポンスを返す必要があるため、
  // 2件目以降の投入はawaitせずバックグラウンドで進める。
  let firstDispatchFailed = false
  let firstDispatchErrorMessage: string | undefined
  let firstJobId: number | null = null
  try {
    firstJobId = await dispatchStylePostJob(env, userId, targets[0].id, runId)
  } catch (err: any) {
    firstDispatchFailed = true
    // 2026-08-14追記(重大バグ修正): ここでエラーを握りつぶしていたため、
    // 手動投稿(テスト実行)が失敗した際、画面には常に「不明なエラー」としか
    // 表示されず、ECS RunTask失敗等の実際の原因が分からなかった。
    firstDispatchErrorMessage = String(err?.message || err).slice(0, 500)
  }

  if (targets.length > 1) {
    void dispatchRemainingStylesSequentially(env, userId, runId, targets.slice(1), firstJobId)
  }

  // 2件目以降(および1件目のFargate側の最終結果)はバックグラウンドで進行・
  // コールバックで反映されるため、ここでは 'processing' のまま残す
  // (集計の確定は行わない)。
  const runStatus = firstDispatchFailed && targets.length === 1 ? 'failed' : 'processing'
  await env.DB.prepare(`UPDATE style_post_runs SET status = ?, error_message = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(runStatus, firstDispatchFailed ? firstDispatchErrorMessage : null, runId)
    .run()

  return {
    runId,
    totalImages: targets.length,
    dispatchedCount: firstDispatchFailed ? 0 : 1,
    failedToDispatchCount: firstDispatchFailed ? 1 : 0,
    status: firstDispatchFailed && targets.length === 1 ? 'failed' : 'dispatched',
    errorMessage: firstDispatchFailed ? firstDispatchErrorMessage : undefined
  }
}

// ============================================
// 自動投稿ルール(2026-08-13、ユーザー指定で全面刷新):
// ・深夜2:00〜7:00は投稿しない
// ・自動投稿をOFF→ONにした瞬間、動作確認のため登録順(sort_order)の
//   先頭3件を間隔を空けず連続投稿する(「初回バースト」)。ON→OFF→ONで
//   再度ONにした場合も先頭3件から再度バーストする(style.tsxの
//   POST /style/scheduleでburst_remaining=3にリセットする)。
// ・初回バーストが終わったら、60分おきに1件、登録順に巡回して投稿する
//   (最後まで行ったら先頭に戻って繰り返す。日付をまたいでも継続。
//   最大100件を登録していても1日で一巡せず数日かけて回る想定)
// ・5件連続で投稿が失敗した場合、5時間は投稿を停止する
//   (users.consecutive_failure_countが5に達した瞬間、
//   style_post_schedules.paused_untilをセットする。automation.tsx参照)
// ============================================

export const INITIAL_BURST_COUNT = 3
const BLACKOUT_START_MINUTES = 2 * 60 // 02:00
const BLACKOUT_END_MINUTES = 7 * 60 // 07:00
const POST_INTERVAL_MINUTES = 60

function jstMinutesOfDay(nowLabel: string): number {
  const [hh, mm] = nowLabel.split(':').map(Number)
  return hh * 60 + mm
}

type ScheduleState = {
  burst_remaining: number
  next_cursor_style_id: number | null
  paused_until: string | null
  retry_pending_style_id: number | null
  retry_pending_wait_slots: number
}

/**
 * 深夜2:00〜7:00は投稿しない。5件連続失敗による一時停止中も投稿しない。
 * 初回バースト中(burst_remaining > 0)は間隔を空けず常に投稿してよい。
 * それ以外(通常運転)は前回のジョブ投入から60分以上経過していること。
 */
async function shouldPostNow(env: Bindings, userId: number, nowLabel: string, schedule: ScheduleState): Promise<boolean> {
  const nowMinutes = jstMinutesOfDay(nowLabel)
  if (nowMinutes >= BLACKOUT_START_MINUTES && nowMinutes < BLACKOUT_END_MINUTES) return false

  if (schedule.paused_until) {
    const pausedUntilMs = new Date(schedule.paused_until.replace(' ', 'T') + 'Z').getTime()
    if (pausedUntilMs > Date.now()) return false
  }

  if (schedule.burst_remaining > 0) return true

  const lastRow = await env.DB.prepare(`SELECT MAX(created_at) as last_at FROM style_post_jobs WHERE user_id = ?`)
    .bind(userId)
    .first<{ last_at: string | null }>()

  if (!lastRow?.last_at) return true
  const lastAtMs = new Date(lastRow.last_at.replace(' ', 'T') + 'Z').getTime()
  const minutesSinceLast = (Date.now() - lastAtMs) / 60000
  return minutesSinceLast >= POST_INTERVAL_MINUTES
}

/**
 * 次に投稿すべき1件を選ぶ。
 * 初回バースト中は登録順(sort_order)の先頭から、消化済み件数ぶんOFFSETした
 * 位置の1件(=先頭3件を順に1件ずつ)を選ぶ。
 * 通常運転時はnext_cursor_style_idより登録順で後ろの最初の1件を選び、
 * 無ければ(カーソル未設定、または最後まで巡回し終えた場合)先頭に戻る。
 */
const ELIGIBLE_STYLE_WHERE = `s.user_id = ? AND s.auto_post_enabled_flag = 1 AND s.internal_save_status = 'ready'
     AND NOT EXISTS (SELECT 1 FROM style_post_jobs j WHERE j.style_id = s.id AND j.status IN ('pending', 'running'))`

/**
 * 2026-08-14追記(ユーザー指定ルール): 失敗したスタイルを1回だけ再トライする
 * 対象として、まだ有効(自動投稿ON・入力完了・進行中ジョブなし)かを確認する。
 * OFFにされた・削除された等で無効になっていれば再トライ枠を無駄にせず
 * 通常の巡回選定にフォールバックする。
 */
async function isStyleEligible(env: Bindings, userId: number, styleId: number): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT s.id FROM styles s WHERE ${ELIGIBLE_STYLE_WHERE} AND s.id = ?`)
    .bind(userId, styleId)
    .first<{ id: number }>()
  return !!row
}

async function selectNextStyleId(env: Bindings, userId: number, schedule: ScheduleState): Promise<number | null> {
  const baseWhere = ELIGIBLE_STYLE_WHERE

  if (schedule.burst_remaining > 0) {
    const offset = INITIAL_BURST_COUNT - schedule.burst_remaining
    const row = await env.DB.prepare(
      `SELECT s.id FROM styles s WHERE ${baseWhere} ORDER BY s.sort_order ASC, s.id ASC LIMIT 1 OFFSET ${offset}`
    )
      .bind(userId)
      .first<{ id: number }>()
    if (row) return row.id
    // 対象スタイルがバースト件数(3件)に満たない場合は先頭に戻ってでも1件選ぶ
    const fallback = await env.DB.prepare(
      `SELECT s.id FROM styles s WHERE ${baseWhere} ORDER BY s.sort_order ASC, s.id ASC LIMIT 1`
    )
      .bind(userId)
      .first<{ id: number }>()
    return fallback?.id ?? null
  }

  if (schedule.next_cursor_style_id) {
    const nextRow = await env.DB.prepare(
      `SELECT s.id FROM styles s
       WHERE ${baseWhere}
         AND (s.sort_order, s.id) > (SELECT sort_order, id FROM styles WHERE id = ?)
       ORDER BY s.sort_order ASC, s.id ASC
       LIMIT 1`
    )
      .bind(userId, schedule.next_cursor_style_id)
      .first<{ id: number }>()
    if (nextRow) return nextRow.id
  }

  const firstRow = await env.DB.prepare(
    `SELECT s.id FROM styles s WHERE ${baseWhere} ORDER BY s.sort_order ASC, s.id ASC LIMIT 1`
  )
    .bind(userId)
    .first<{ id: number }>()
  return firstRow?.id ?? null
}

/**
 * 深夜2:00〜7:00を除く時間帯に、60分おきに1件を登録順で巡回投稿する方式
 * (OFF→ON直後は先頭3件を連続投稿する初回バースト)。
 * 外部Cronから1分間隔で呼ばれる想定。
 */
export async function runNextStyleForUser(
  env: Bindings,
  userId: number,
  scheduledTimeLabel: string
): Promise<RunSummary | null> {
  const schedule = await env.DB.prepare(
    `SELECT burst_remaining, next_cursor_style_id, paused_until, retry_pending_style_id, retry_pending_wait_slots
     FROM style_post_schedules WHERE user_id = ?`
  )
    .bind(userId)
    .first<ScheduleState>()

  if (!schedule) return null
  if (!(await shouldPostNow(env, userId, scheduledTimeLabel, schedule))) return null

  await requireCredentialsConfigured(env, userId)

  // 2026-08-14追記(ユーザー指定ルール): エラーが出たスタイルは、次のスタイルの
  // 次のタイミングで1回だけ自動的に再トライする(通常のバースト/巡回選定より
  // 優先する)。3回目の再トライは行わない(1回消費したら通常運転に戻す)。
  // 例: No.1が失敗→No.2を通常通り投稿→No.1を再トライ→(結果に関わらず)以降は
  // 通常の巡回に戻る。
  const isBursting = schedule.burst_remaining > 0
  let isRetrySlot = false
  let styleId: number | null = null

  if (!isBursting && schedule.retry_pending_style_id && schedule.retry_pending_wait_slots <= 0) {
    if (await isStyleEligible(env, userId, schedule.retry_pending_style_id)) {
      isRetrySlot = true
      styleId = schedule.retry_pending_style_id
    } else {
      // 対象が既に無効(OFF・削除等)になっている場合は再トライ枠を放棄し、
      // このスロットは通常の巡回選定にフォールバックする。
      await env.DB.prepare(
        `UPDATE style_post_schedules SET retry_pending_style_id = NULL, retry_pending_wait_slots = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
      )
        .bind(userId)
        .run()
      schedule.retry_pending_style_id = null
    }
  }

  if (!styleId) {
    styleId = await selectNextStyleId(env, userId, schedule)
  }
  if (!styleId) return null

  const runInsert = await env.DB.prepare(
    `INSERT INTO style_post_runs (user_id, scheduled_time, total_images, status)
     VALUES (?, ?, 1, 'processing')`
  )
    .bind(userId, scheduledTimeLabel)
    .run()
  const runId = Number(runInsert.meta.last_row_id)

  try {
    await dispatchStylePostJob(env, userId, styleId, runId)

    if (isRetrySlot) {
      // 再トライ枠は使い切ったので消費し、通常の巡回カーソル/バーストには
      // 影響させない(再トライは巡回順序から外れた割り込みのため)。
      await env.DB.prepare(
        `UPDATE style_post_schedules SET retry_pending_style_id = NULL, retry_pending_wait_slots = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
      )
        .bind(userId)
        .run()
    } else if (schedule.burst_remaining > 0) {
      await env.DB.prepare(
        `UPDATE style_post_schedules SET burst_remaining = burst_remaining - 1, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
      )
        .bind(userId)
        .run()
    } else {
      await env.DB.prepare(
        `UPDATE style_post_schedules SET next_cursor_style_id = ?,
           retry_pending_wait_slots = GREATEST(retry_pending_wait_slots - 1, 0), updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ?`
      )
        .bind(styleId, userId)
        .run()
    }

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
  if (await hasInFlightJob(env, styleId)) {
    throw new Error('このスタイルは既に処理中のジョブがあります。完了を待ってから再実行してください')
  }

  try {
    await dispatchStylePostJob(env, userId, styleId)
    return { outcome: 'dispatched' }
  } catch {
    return { outcome: 'failed' }
  }
}

type StaleJobRow = { id: number; style_id: number; user_id: number; ecs_task_arn: string | null }

/**
 * 1件の停滞ジョブ(pending/running状態のまま結果コールバックが来ない)を
 * タイムアウト扱いに片付ける。実Fargateタスクの明示停止・ジョブ/スタイルの
 * ステータス更新・実行ログ記録までをまとめて行う(sweepStaleJobs/
 * resetStuckJobsForUserの共通処理)。
 */
async function clearStaleJob(env: Bindings, j: StaleJobRow): Promise<void> {
  // 2026-08-13追記(重大バグ修正): DB上でタイムアウト扱いにするだけでは
  // 実際のFargateタスクは動き続け、後から(アプリ側が既に諦めた後で)
  // 登録・反映申請が完了することがあった。この状態でユーザーが「再実行」
  // すると、既に成功済みの投稿へもう一度別タスクが登録処理を行ってしまう
  // (実質的な二重投稿)。タイムアウト判定と同時に実タスクへ明示的な停止を
  // 要求する(失敗してもタイムアウト処理自体は継続する)。
  if (j.ecs_task_arn && env.ECS_CLUSTER && env.AWS_REGION) {
    await stopStylePostTask({
      awsRegion: env.AWS_REGION,
      cluster: env.ECS_CLUSTER,
      taskArn: j.ecs_task_arn,
      reason: 'ジョブがタイムアウトしたため停止'
    }).catch((err) => {
      console.error(`ジョブ${j.id}のFargateタスク(${j.ecs_task_arn})停止に失敗しました:`, err)
    })
  }
  await env.DB.prepare(
    `UPDATE style_post_jobs SET status = 'timeout',
       result_message = 'タイムアウト(結果コールバックがありませんでした)',
       completed_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  )
    .bind(j.id)
    .run()
  await env.DB.prepare(
    `UPDATE styles SET salonboard_register_status = 'failed', reflection_request_status = 'failed',
       last_error = 'Fargateジョブがタイムアウトしました(応答がありませんでした)'
     WHERE id = ?`
  )
    .bind(j.style_id)
    .run()
  const styleNo = await getStyleNo(env, j.user_id, j.style_id)
  await env.DB.prepare(
    `INSERT INTO execution_logs (post_id, user_id, style_id, style_no, execution_type, status, message)
     VALUES (NULL, ?, ?, ?, 'register_style', 'failure', 'ジョブがタイムアウトしました(Fargateタスクからの応答なし)')`
  )
    .bind(j.user_id, j.style_id, styleNo)
    .run()
}

/**
 * 一定時間(15分)以上結果コールバックが届かないジョブをタイムアウト扱いにする。
 * cron-trigger-workerの1分間隔の呼び出しの中で、次のジョブ投入前に実行する。
 * 2026-08-13追記: IP切替リトライを最大10回に増やしたため、1回あたり最悪
 * 約45秒(アップロードタイムアウト)+試行間20秒の待機で、10回だと理論上
 * 約11分かかりうる。旧来の10分では途中で打ち切られる恐れがあるため15分に延長。
 */
export async function sweepStaleJobs(env: Bindings): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, style_id, user_id, ecs_task_arn FROM style_post_jobs
     WHERE status IN ('pending', 'running') AND created_at < (now() - interval '15 minutes')`
  ).all<StaleJobRow>()

  const staleJobs = results || []
  for (const j of staleJobs) {
    await clearStaleJob(env, j)
  }
  return staleJobs.length
}

/**
 * 2026-08-14追記(ユーザー指定): 「進行中ジョブがある」と判定されて
 * 自動投稿対象・手動実行対象から除外され続けるスタイルを、ユーザー自身の
 * 判断で今すぐ復旧できるようにする。sweepStaleJobsの15分より短い2分を
 * 閾値にする(2分未満のジョブは誤ってまだ本当に進行中の可能性が高いため
 * 対象外とし、実行中の投稿を誤って中断しないようにする)。このユーザーの
 * ジョブのみを対象にする。
 */
export async function resetStuckJobsForUser(env: Bindings, userId: number): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, style_id, user_id, ecs_task_arn FROM style_post_jobs
     WHERE user_id = ? AND status IN ('pending', 'running') AND created_at < (now() - interval '2 minutes')`
  )
    .bind(userId)
    .all<StaleJobRow>()

  const staleJobs = results || []
  for (const j of staleJobs) {
    await clearStaleJob(env, j)
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
