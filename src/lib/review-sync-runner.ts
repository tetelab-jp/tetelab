// ============================================
// review-sync-runner.ts
// 口コミ管理ツールの同期ジョブ制御。
//   1. enqueueReviewSyncJob: ワーカー(Fargate)にサロンボード口コミ一覧の
//      巡回ジョブを投入する(style/blog-post-runner.tsと同じ設計方針)。
//   2. processReviewSyncResult: ワーカーが返したサロンボード側の行を受け取り、
//      HPB公開口コミ一覧をfetch()で取得(ログイン不要・ここはワーカーを
//      使わずアプリ側で直接行う)→投稿日+本文で突合→reviewsテーブルへ反映する。
//   3. sweepStaleReviewSyncJobs / runMonthlyReviewSyncSweep: cronから呼ぶ。
// ============================================

import type { Bindings } from '../types'
import { runReviewSyncTask, stopStylePostTask } from './aws-ecs'
import { fetchHpbReviewList } from './ranking-scraper'
import { matchReviews, parseSbPostedAtTimestamp, parseSbDateOnly, type SalonBoardReviewRow } from './review-match'
import { matchStylistName } from './review-stylist-match'

function randomJobToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function hasInFlightReviewSyncJob(env: Bindings, salonId: number): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 as x FROM review_sync_jobs WHERE salon_id = ? AND status IN ('pending', 'running') LIMIT 1`
  )
    .bind(salonId)
    .first<{ x: number }>()
  return !!row
}

export type EnqueueReviewSyncResult = { jobId: number; mode: 'full_backfill' | 'incremental' }

/**
 * 口コミ同期ジョブを1件投入する。初回(review_sync_state未作成、または
 * backfill_completed_atが未設定)は'full_backfill'、それ以外は
 * 'incremental'として、前回同期済みの管理番号(stopAtManagementNo)を
 * ワーカーへ渡す(一覧は新しい投稿順のため、そこに到達したら打ち切る)。
 */
export async function enqueueReviewSyncJob(env: Bindings, userId: number, salonId: number): Promise<EnqueueReviewSyncResult> {
  if (!env.APP_BASE_URL) throw new Error('APP_BASE_URLが未設定です')
  if (!env.AWS_REGION) throw new Error('AWS_REGIONが未設定です')
  if (!env.ECS_CLUSTER || !env.ECS_TASK_DEFINITION || !env.ECS_CONTAINER_NAME) {
    throw new Error('ECSクラスタ/タスク定義/コンテナ名が未設定です')
  }
  if (!env.ECS_SUBNET_IDS || !env.ECS_SECURITY_GROUP_IDS) {
    throw new Error('ECSのサブネット/セキュリティグループが未設定です')
  }

  const cred = await env.DB.prepare('SELECT user_id FROM salon_credentials WHERE user_id = ?')
    .bind(userId)
    .first<{ user_id: number }>()
  if (!cred) throw new Error('サロンボードのログイン情報が未登録です')
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEYが未設定です')

  if (await hasInFlightReviewSyncJob(env, salonId)) {
    throw new Error('既に口コミ同期ジョブが実行中です')
  }

  const state = await env.DB.prepare(
    `SELECT backfill_completed_at FROM review_sync_state WHERE salon_id = ?`
  )
    .bind(salonId)
    .first<{ backfill_completed_at: string | null }>()
  const mode: 'full_backfill' | 'incremental' = state?.backfill_completed_at ? 'incremental' : 'full_backfill'

  const jobToken = randomJobToken()
  const jobInsert = await env.DB.prepare(
    `INSERT INTO review_sync_jobs (user_id, salon_id, job_token, mode, status) VALUES (?, ?, ?, ?, 'pending')`
  )
    .bind(userId, salonId, jobToken, mode)
    .run()
  const jobId = Number(jobInsert.meta.last_row_id)

  try {
    const { taskArn } = await runReviewSyncTask({
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
    await env.DB.prepare(`UPDATE review_sync_jobs SET status = 'running', ecs_task_arn = ? WHERE id = ?`)
      .bind(taskArn, jobId)
      .run()
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 500)
    await env.DB.prepare(
      `UPDATE review_sync_jobs SET status = 'failed', result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(message, jobId)
      .run()
    throw err
  }

  return { jobId, mode }
}

export type ReviewSyncJobRow = {
  id: number
  user_id: number
  salon_id: number
  mode: 'full_backfill' | 'incremental'
  status: string
}

/**
 * ワーカーから届いたサロンボード口コミ一覧を受けて、HPB公開口コミ一覧を
 * fetch()で取得(ログイン不要・Puppeteer不要なのでここはアプリ側で直接行う)し、
 * 投稿日+本文で突合してreviewsテーブルへ反映する。
 * ワーカー側が失敗した場合(sbRowsが空でsuccess=false)はこの関数を呼ばず、
 * 呼び出し側(automation.tsx)でジョブをfailed扱いにする。
 */
export async function processReviewSyncResult(
  env: Bindings,
  job: ReviewSyncJobRow,
  sbRows: SalonBoardReviewRow[]
): Promise<{ matchedCount: number; unmatchedCount: number }> {
  const salon = await env.DB.prepare('SELECT hpb_sln_id FROM salonboard_salons WHERE id = ?')
    .bind(job.salon_id)
    .first<{ hpb_sln_id: string | null }>()
  if (!salon?.hpb_sln_id) {
    throw new Error('HPB公開ページのサロンID(hpb_sln_id)が未設定です。サロン情報の同期を先に行ってください')
  }

  const { items: hpbItems } = await fetchHpbReviewList(salon.hpb_sln_id, { proxyUrl: env.RANKING_PROXY_URL })
  const matchResults = matchReviews(sbRows, hpbItems)

  const { results: stylists } = await env.DB.prepare('SELECT id, name FROM stylists WHERE salon_id = ?')
    .bind(job.salon_id)
    .all<{ id: number; name: string }>()

  let matchedCount = 0
  let unmatchedCount = 0

  for (const r of matchResults) {
    const stylist = matchStylistName(r.stylistNameRaw, stylists || [])
    const postedAt = parseSbPostedAtTimestamp(r.postedAt)
    const visitedAt = parseSbDateOnly(r.visitedAt)
    const hpb = r.hpb

    if (r.matched) matchedCount += 1
    else unmatchedCount += 1

    await env.DB.prepare(
      `INSERT INTO reviews (
         user_id, salon_id, salonboard_review_key, posted_at, visited_at,
         reservation_name, stylist_name_raw, stylist_id, reply_status,
         hpb_nickname, gender, age_group, attribute, menu_used, coupon_used,
         content, salon_reply_content,
         score_atmosphere, score_service, score_technique, score_menu_price, score_overall,
         matched_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (salon_id, salonboard_review_key) DO UPDATE SET
         posted_at = EXCLUDED.posted_at,
         visited_at = EXCLUDED.visited_at,
         reservation_name = EXCLUDED.reservation_name,
         stylist_name_raw = EXCLUDED.stylist_name_raw,
         stylist_id = EXCLUDED.stylist_id,
         reply_status = EXCLUDED.reply_status,
         hpb_nickname = EXCLUDED.hpb_nickname,
         gender = EXCLUDED.gender,
         age_group = EXCLUDED.age_group,
         attribute = EXCLUDED.attribute,
         menu_used = EXCLUDED.menu_used,
         coupon_used = EXCLUDED.coupon_used,
         content = EXCLUDED.content,
         salon_reply_content = EXCLUDED.salon_reply_content,
         score_atmosphere = EXCLUDED.score_atmosphere,
         score_service = EXCLUDED.score_service,
         score_technique = EXCLUDED.score_technique,
         score_menu_price = EXCLUDED.score_menu_price,
         score_overall = EXCLUDED.score_overall,
         matched_at = EXCLUDED.matched_at,
         updated_at = CURRENT_TIMESTAMP`
    )
      .bind(
        job.user_id,
        job.salon_id,
        r.managementNo,
        postedAt,
        visitedAt,
        r.reservationName || null,
        r.stylistNameRaw || null,
        stylist?.id ?? null,
        r.replyStatus || null,
        hpb?.nickname || null,
        hpb ? hpb.attribute.match(/男性|女性/)?.[0] ?? null : null,
        hpb ? hpb.attribute.match(/\d+代/)?.[0] ?? null : null,
        hpb?.attribute || null,
        hpb?.menuUsed || null,
        hpb?.couponUsed || null,
        hpb?.content || null,
        hpb?.salonReplyContent || null,
        hpb?.scoreAtmosphere ?? null,
        hpb?.scoreService ?? null,
        hpb?.scoreTechnique ?? null,
        hpb?.scoreMenuPrice ?? null,
        hpb?.scoreOverall ?? null,
        r.matched ? new Date().toISOString() : null
      )
      .run()
  }

  const newestManagementNo = sbRows[0]?.managementNo ?? null
  await env.DB.prepare(
    `INSERT INTO review_sync_state (user_id, salon_id, backfill_completed_at, last_synced_review_key, last_sync_run_at)
     VALUES (?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (salon_id) DO UPDATE SET
       backfill_completed_at = COALESCE(review_sync_state.backfill_completed_at, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END),
       last_synced_review_key = COALESCE(EXCLUDED.last_synced_review_key, review_sync_state.last_synced_review_key),
       last_sync_run_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(job.user_id, job.salon_id, job.mode === 'full_backfill', newestManagementNo, job.mode === 'full_backfill')
    .run()

  return { matchedCount, unmatchedCount }
}

type StaleReviewSyncJobRow = { id: number; ecs_task_arn: string | null }

async function clearStaleReviewSyncJob(env: Bindings, j: StaleReviewSyncJobRow): Promise<void> {
  if (j.ecs_task_arn && env.ECS_CLUSTER && env.AWS_REGION) {
    await stopStylePostTask({
      awsRegion: env.AWS_REGION,
      cluster: env.ECS_CLUSTER,
      taskArn: j.ecs_task_arn,
      reason: 'ジョブがタイムアウトしたため停止'
    }).catch((err) => {
      console.error(`口コミ同期ジョブ${j.id}のFargateタスク(${j.ecs_task_arn})停止に失敗しました:`, err)
    })
  }
  await env.DB.prepare(
    `UPDATE review_sync_jobs SET status = 'timeout', result_message = 'タイムアウト(結果コールバックがありませんでした)', completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(j.id)
    .run()
}

/** 10分以上結果コールバックが届かないジョブをタイムアウト扱いにする(cronから毎回呼ぶ)。
 *  想定所要時間(1〜2分)に対して十分な余裕を持たせている。 */
export async function sweepStaleReviewSyncJobs(env: Bindings): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, ecs_task_arn FROM review_sync_jobs
     WHERE status IN ('pending', 'running') AND created_at < (now() - interval '10 minutes')`
  ).all<StaleReviewSyncJobRow>()
  const staleJobs = results || []
  for (const j of staleJobs) await clearStaleReviewSyncJob(env, j)
  return staleJobs.length
}

/**
 * 月1回、既に初回バックフィルが完了している(review_enabled=1かつ
 * backfill_completed_at設定済みの)サロンについて差分同期ジョブを投入する。
 * 初回バックフィルはユーザー自身が/reviews画面から手動で開始する(スコープ外)。
 */
export async function runMonthlyReviewSyncSweep(env: Bindings): Promise<number> {
  const nowJstMonth = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' })
    .format(new Date())
    .slice(0, 7) // "YYYY-MM"

  const { results: targets } = await env.DB.prepare(
    `SELECT s.user_id, s.salon_id FROM review_sync_state s
     JOIN users u ON u.id = s.user_id
     JOIN salonboard_salons sb ON sb.id = s.salon_id
     WHERE s.backfill_completed_at IS NOT NULL
       AND u.is_active = 1 AND u.review_enabled = 1 AND sb.is_active_workspace = 1
       AND (s.last_incremental_sync_month IS NULL OR s.last_incremental_sync_month <> ?)`
  )
    .bind(nowJstMonth)
    .all<{ user_id: number; salon_id: number }>()

  let dispatchedCount = 0
  for (const t of targets || []) {
    try {
      await enqueueReviewSyncJob(env, t.user_id, t.salon_id)
      await env.DB.prepare(
        `UPDATE review_sync_state SET last_incremental_sync_month = ?, updated_at = CURRENT_TIMESTAMP WHERE salon_id = ?`
      )
        .bind(nowJstMonth, t.salon_id)
        .run()
      dispatchedCount += 1
    } catch (err) {
      console.error(`口コミ月次同期の投入に失敗しました(salon_id=${t.salon_id}):`, err)
    }
  }
  return dispatchedCount
}
