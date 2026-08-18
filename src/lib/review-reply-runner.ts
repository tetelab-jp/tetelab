// ============================================
// review-reply-runner.ts
// 口コミ自動返信機能のジョブ制御。blog-post-runner.ts/review-sync-runner.tsと
// 同じ設計方針(1件=1ジョブ、AWS ECS Fargateワーカーが実際にPuppeteerで
// 返信投稿→結果コールバック)。
//
// 自動返信の対象は、HPB公開ページに掲載済み(matched_at IS NOT NULL)かつ
// 星4以上(score_overall >= 4)の未返信口コミのみ(ユーザー指定)。星3以下は
// このrunnerの対象外とし、手動返信フロー(dispatchManualReviewReply)で
// 個別に扱う。
//
// review_sync同様、EventBridgeへの新規スケジュール追加(要terraform apply)を
// 避けるため、外部Cronではなくアプリ内setInterval(src/index.tsx)から
// 定期的に呼ばれる想定。
// ============================================

import type { Bindings } from '../types'
import { runReviewReplyTask, stopStylePostTask } from './aws-ecs'
import { generateReviewReply, type ReviewForReplyGeneration, type SalonProfileForGeneration } from './ai-generate'
import { publishAlert } from './sns-alert'
import { hasAnyInFlightSalonAutomationJob } from './automation-lock'

const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 2

function randomJobToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * ジョブ取得API(GET /api/review-reply-automation/jobs/:id)・AI返信文生成の
 * 両方から使う、リクエストコンテキスト非依存のサロンプロフィール読み込み
 * (blog.tsxのgetSalonProfileForGenerationと同じ内容だが、userId/salonIdを
 * 直接受け取る形にしている)。
 */
export async function loadSalonProfileForGeneration(
  env: Bindings,
  userId: number,
  salonId: number | null
): Promise<SalonProfileForGeneration> {
  const profile = await env.DB.prepare(
    `SELECT concept, target_customer, writing_tone, ng_words, strengths, price_range, reference_text,
            first_person, sentence_ending, hpb_catch, hpb_copy, hpb_message,
            hpb_avg_price_first, hpb_avg_price_repeat, hpb_customer_ratio
     FROM salon_profiles WHERE user_id = ? AND salon_id = ?`
  )
    .bind(userId, salonId)
    .first<{
      concept: string | null
      target_customer: string | null
      writing_tone: string | null
      ng_words: string | null
      strengths: string | null
      price_range: string | null
      reference_text: string | null
      first_person: string | null
      sentence_ending: string | null
      hpb_catch: string | null
      hpb_copy: string | null
      hpb_message: string | null
      hpb_avg_price_first: string | null
      hpb_avg_price_repeat: string | null
      hpb_customer_ratio: string | null
    }>()

  const salon = salonId
    ? await env.DB.prepare('SELECT salon_name, middle_area_name, small_area_name FROM salonboard_salons WHERE id = ?')
        .bind(salonId)
        .first<{ salon_name: string | null; middle_area_name: string | null; small_area_name: string | null }>()
    : null

  if (!profile) return null
  const areaLabel = [salon?.middle_area_name, salon?.small_area_name].filter(Boolean).join(' > ') || null
  return {
    salon_name: salon?.salon_name || null,
    area_label: areaLabel,
    concept: profile.concept,
    target_customer: profile.target_customer,
    strengths: profile.strengths,
    price_range: profile.price_range,
    writing_tone: profile.writing_tone,
    first_person: profile.first_person,
    sentence_ending: profile.sentence_ending,
    ng_words: profile.ng_words,
    reference_text: profile.reference_text,
    hpb_catch: profile.hpb_catch,
    hpb_copy: profile.hpb_copy,
    hpb_message: profile.hpb_message,
    hpb_avg_price_first: profile.hpb_avg_price_first,
    hpb_avg_price_repeat: profile.hpb_avg_price_repeat,
    hpb_customer_ratio: profile.hpb_customer_ratio,
    reference_articles: []
  }
}

const PAST_REPLIES_LOOKBACK_LIMIT = 5

/**
 * AI返信文生成の文体参考材料として、このサロンが過去に実際に投稿した
 * 返信文(直近の成功分)を取得する(2026-08-18追記・ユーザー指定)。
 */
export async function loadRecentReviewReplies(env: Bindings, salonId: number | null): Promise<string[]> {
  if (!salonId) return []
  const { results } = await env.DB.prepare(
    `SELECT reply_content FROM reviews
     WHERE salon_id = ? AND reply_content IS NOT NULL AND replied_at IS NOT NULL
     ORDER BY replied_at DESC LIMIT ${PAST_REPLIES_LOOKBACK_LIMIT}`
  )
    .bind(salonId)
    .all<{ reply_content: string }>()
  return (results || []).map((r) => r.reply_content)
}

export async function updateReviewReplyConsecutiveFailureAndNotify(
  env: Bindings,
  userId: number,
  salonId: number | null,
  success: boolean
): Promise<void> {
  const before = await env.DB.prepare(
    `WITH old AS (
       SELECT consecutive_review_reply_failure_count AS prev_count, email, salon_name
       FROM users WHERE id = ? FOR UPDATE
     )
     UPDATE users u
     SET consecutive_review_reply_failure_count = CASE WHEN ? THEN 0 ELSE old.prev_count + 1 END
     FROM old
     WHERE u.id = ?
     RETURNING old.prev_count AS prev_count, u.consecutive_review_reply_failure_count AS next_count, old.email AS email, old.salon_name AS salon_name`
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
      `UPDATE review_reply_schedules SET paused_until = now() + interval '5 hours', updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_id = ?`
    )
      .bind(userId, salonId)
      .run()
      .catch(() => {})
  }

  if (wasFailing === isFailing) return

  const salonLabel = before.salon_name || before.email
  const subject = isFailing
    ? `[SalonMotion] ${salonLabel} の口コミ自動返信が${CONSECUTIVE_FAILURE_ALERT_THRESHOLD}回連続で失敗しています`
    : `[SalonMotion] ${salonLabel} の口コミ自動返信が復旧しました`
  const message = isFailing
    ? `サロン「${salonLabel}」(${before.email})の口コミ自動返信が${CONSECUTIVE_FAILURE_ALERT_THRESHOLD}回連続で失敗しました。管理者サイト(/admin/status)で状況を確認してください。`
    : `サロン「${salonLabel}」(${before.email})の口コミ自動返信が成功し、連続失敗の状態から復旧しました。`

  await publishAlert(env, subject, message).catch((err) => {
    console.error('アラート通知の送信に失敗しました:', err)
  })
}

async function hasInFlightReplyJob(env: Bindings, salonId: number | null): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 as x FROM review_reply_jobs WHERE salon_id = ? AND status IN ('pending', 'running') LIMIT 1`
  )
    .bind(salonId)
    .first<{ x: number }>()
  return !!row
}

async function requireCredentialsConfigured(env: Bindings, userId: number): Promise<void> {
  const cred = await env.DB.prepare('SELECT user_id FROM salon_credentials WHERE user_id = ?')
    .bind(userId)
    .first<{ user_id: number }>()
  if (!cred) throw new Error('サロンボードのログイン情報が未登録です')
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEYが未設定です')
}

async function dispatchReviewReplyJob(
  env: Bindings,
  userId: number,
  salonId: number | null,
  reviewId: number,
  replyContent: string,
  trigger: 'auto' | 'manual'
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
    throw new Error('このサロンは他の自動化ジョブ(スタイル投稿/ブログ投稿/口コミ同期)が進行中のため、投入を見送りました')
  }

  const jobToken = randomJobToken()
  const jobInsert = await env.DB.prepare(
    `INSERT INTO review_reply_jobs (review_id, user_id, salon_id, job_token, trigger, reply_content, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(reviewId, userId, salonId, jobToken, trigger, replyContent)
    .run()
  const jobId = Number(jobInsert.meta.last_row_id)

  try {
    const { taskArn } = await runReviewReplyTask({
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
    await env.DB.prepare(`UPDATE review_reply_jobs SET status = 'running', ecs_task_arn = ? WHERE id = ?`)
      .bind(taskArn, jobId)
      .run()
    return jobId
  } catch (err: any) {
    const message = String(err?.message || err).slice(0, 500)
    await env.DB.prepare(
      `UPDATE review_reply_jobs SET status = 'failed', result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(message, jobId)
      .run()
    throw err
  }
}

type ScheduleState = { enabled: number; paused_until: string | null }

async function shouldReplyNow(env: Bindings, userId: number, salonId: number | null, schedule: ScheduleState): Promise<boolean> {
  if (schedule.enabled !== 1) return false
  if (schedule.paused_until) {
    const pausedUntilMs = new Date(schedule.paused_until.replace(' ', 'T') + 'Z').getTime()
    if (pausedUntilMs > Date.now()) return false
  }
  return !(await hasInFlightReplyJob(env, salonId))
}

type EligibleReviewRow = {
  id: number
  score_overall: number | null
  content: string | null
  stylist_name_raw: string | null
  hpb_nickname: string | null
  menu_used: string | null
}

/**
 * 星4以上・HPB掲載済み(matched_at IS NOT NULL)・未返信の口コミのうち、
 * 最も古い(投稿が古い)ものを1件選ぶ(古いものから順に消化する)。
 */
async function selectNextEligibleReview(env: Bindings, userId: number, salonId: number | null): Promise<EligibleReviewRow | null> {
  return env.DB.prepare(
    `SELECT r.id, r.score_overall, r.content, r.stylist_name_raw, r.hpb_nickname, r.menu_used
     FROM reviews r
     WHERE r.user_id = ? AND r.salon_id = ? AND r.matched_at IS NOT NULL AND r.score_overall >= 4 AND r.replied_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM review_reply_jobs j WHERE j.review_id = r.id AND j.status IN ('pending', 'running'))
     ORDER BY r.posted_at ASC NULLS LAST, r.id ASC
     LIMIT 1`
  )
    .bind(userId, salonId)
    .first<EligibleReviewRow>()
}

export type ReviewReplyDispatchResult = { dispatched: boolean; jobId?: number; reviewId?: number }

/**
 * 1サロン分、次に返信すべき口コミを1件だけ処理する(cronから毎回呼ばれる想定。
 * 一度に大量送信してSALON BOARD側に不自然な負荷をかけないよう、必ず1件ずつ)。
 */
export async function runNextReviewReplyForUser(env: Bindings, userId: number, salonId: number | null): Promise<ReviewReplyDispatchResult> {
  const schedule = await env.DB.prepare(`SELECT enabled, paused_until FROM review_reply_schedules WHERE user_id = ? AND salon_id = ?`)
    .bind(userId, salonId)
    .first<ScheduleState>()
  if (!schedule) return { dispatched: false }
  if (!(await shouldReplyNow(env, userId, salonId, schedule))) return { dispatched: false }

  await requireCredentialsConfigured(env, userId)

  const review = await selectNextEligibleReview(env, userId, salonId)
  if (!review) return { dispatched: false }

  const profile = await loadSalonProfileForGeneration(env, userId, salonId)
  const pastReplies = await loadRecentReviewReplies(env, salonId)
  const reviewInput: ReviewForReplyGeneration = {
    scoreOverall: review.score_overall,
    content: review.content,
    stylistNameRaw: review.stylist_name_raw,
    hpbNickname: review.hpb_nickname,
    menuUsed: review.menu_used
  }

  try {
    const replyContent = await generateReviewReply(env, reviewInput, profile, pastReplies)
    if (!replyContent) throw new Error('AI返信文の生成結果が空でした')
    const jobId = await dispatchReviewReplyJob(env, userId, salonId, review.id, replyContent, 'auto')
    return { dispatched: true, jobId, reviewId: review.id }
  } catch (err: any) {
    await updateReviewReplyConsecutiveFailureAndNotify(env, userId, salonId, false)
    console.error(`口コミ自動返信の投入に失敗しました(review_id=${review.id}):`, err)
    return { dispatched: false }
  }
}

/**
 * 手動返信フロー用: 星の制限なく、任意の口コミへ指定した返信文を投稿する
 * ジョブを1件投入する(既に下書き→ユーザーが確認・修正済みの文面を渡す)。
 */
export async function dispatchManualReviewReply(
  env: Bindings,
  userId: number,
  salonId: number | null,
  reviewId: number,
  replyContent: string
): Promise<number> {
  await requireCredentialsConfigured(env, userId)
  if (await hasInFlightReplyJob(env, salonId)) {
    throw new Error('このサロンは既に返信処理が進行中です。完了してからもう一度お試しください')
  }
  const review = await env.DB.prepare(`SELECT id, replied_at FROM reviews WHERE id = ? AND user_id = ? AND salon_id = ?`)
    .bind(reviewId, userId, salonId)
    .first<{ id: number; replied_at: string | null }>()
  if (!review) throw new Error('対象の口コミが見つかりません')
  if (review.replied_at) throw new Error('この口コミは既に返信済みです')

  const trimmed = replyContent.trim()
  if (!trimmed) throw new Error('返信文が空です')

  return dispatchReviewReplyJob(env, userId, salonId, reviewId, trimmed, 'manual')
}

/**
 * review_reply_schedules.enabled=1かつsalonboard_salons.review_enabled=1の
 * 全サロンについて、1サロンあたり1件ずつ返信ジョブを投入する
 * (アプリ内setIntervalから定期的に呼ばれる想定)。
 */
export async function runReviewReplySweep(env: Bindings): Promise<number> {
  const { results: targets } = await env.DB.prepare(
    `SELECT s.user_id, s.salon_id FROM review_reply_schedules s
     JOIN users u ON u.id = s.user_id
     JOIN salonboard_salons sb ON sb.id = s.salon_id
     WHERE s.enabled = 1 AND u.is_active = 1 AND sb.review_enabled = 1 AND sb.is_active_workspace = 1`
  ).all<{ user_id: number; salon_id: number }>()

  let dispatchedCount = 0
  for (const t of targets || []) {
    try {
      const result = await runNextReviewReplyForUser(env, t.user_id, t.salon_id)
      if (result.dispatched) dispatchedCount += 1
    } catch (err) {
      console.error(`口コミ自動返信の巡回に失敗しました(salon_id=${t.salon_id}):`, err)
    }
  }
  return dispatchedCount
}

type StaleReviewReplyJobRow = { id: number; review_id: number; user_id: number; salon_id: number | null; ecs_task_arn: string | null }

async function clearStaleReviewReplyJob(env: Bindings, j: StaleReviewReplyJobRow): Promise<void> {
  if (j.ecs_task_arn && env.ECS_CLUSTER && env.AWS_REGION) {
    await stopStylePostTask({
      awsRegion: env.AWS_REGION,
      cluster: env.ECS_CLUSTER,
      taskArn: j.ecs_task_arn,
      reason: 'ジョブがタイムアウトしたため停止'
    }).catch((err) => {
      console.error(`口コミ返信ジョブ${j.id}のFargateタスク(${j.ecs_task_arn})停止に失敗しました:`, err)
    })
  }
  await env.DB.prepare(
    `UPDATE review_reply_jobs SET status = 'timeout', result_message = 'タイムアウト(結果コールバックがありませんでした)', completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(j.id)
    .run()
  await updateReviewReplyConsecutiveFailureAndNotify(env, j.user_id, j.salon_id, false)
}

/** 15分以上結果コールバックが届かないジョブをタイムアウト扱いにする(cronから毎回呼ぶ)。 */
export async function sweepStaleReviewReplyJobs(env: Bindings): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, review_id, user_id, salon_id, ecs_task_arn FROM review_reply_jobs
     WHERE status IN ('pending', 'running') AND created_at < (now() - interval '15 minutes')`
  ).all<StaleReviewReplyJobRow>()
  const staleJobs = results || []
  for (const j of staleJobs) await clearStaleReviewReplyJob(env, j)
  return staleJobs.length
}
