// ============================================
// review-pipeline-runner.ts
//
// 2026-08-19追記(ユーザー指定): 口コミ同期(review_sync)と口コミ自動返信
// (review_reply)を、それぞれ別々のsetIntervalで独立したタイミングに
// 起動するのをやめ、毎朝JST 09:00から「サロンごとに、まず口コミ同期を
// (今月分がまだなら)行い、完了を待ってから口コミ自動返信を行う」という
// 1本のパイプラインにまとめる。これにより①返信が常に当日の最新の同期
// データに基づく、②同じサロンで2種類のジョブが別々のタイミングで動いて
// automation-lock(hasAnyInFlightSalonAutomationJob)に阻まれる機会が減る、
// という2つの利点がある。
//
// 両ステップとも自己ゲート判定を持つ(runSyncStepForSalon: 月次判定、
// runReviewReplyBatchForUser: その日返信すべき対象が無くなれば即座に
// 何もしない)ため、この関数自体は09:00以降であれば1日に何度呼ばれても
// 安全(2回目以降は各サロンとも数クエリで終わるno-opになる)。
// ============================================

import type { Bindings } from '../types'
import { runSyncStepForSalon } from './review-sync-runner'
import { runReviewReplyBatchForUser } from './review-reply-runner'

const DAILY_PIPELINE_TIME_LABEL = '09:00'

type PipelineTarget = { user_id: number; salon_id: number; reply_enabled: number }

export async function runDailyReviewPipeline(env: Bindings, nowLabel: string): Promise<{ processedSalons: number }> {
  if (nowLabel < DAILY_PIPELINE_TIME_LABEL) return { processedSalons: 0 }

  const { results: targets } = await env.DB.prepare(
    `SELECT sb.user_id, sb.id AS salon_id, COALESCE(rrs.enabled, 0) AS reply_enabled
     FROM salonboard_salons sb
     JOIN users u ON u.id = sb.user_id
     LEFT JOIN review_reply_schedules rrs ON rrs.salon_id = sb.id
     WHERE sb.review_enabled = 1 AND sb.is_active_workspace = 1 AND u.is_active = 1`
  ).all<PipelineTarget>()

  let processedSalons = 0
  for (const t of targets || []) {
    try {
      await runSyncStepForSalon(env, t.user_id, t.salon_id)
      if (t.reply_enabled === 1) {
        await runReviewReplyBatchForUser(env, t.user_id, t.salon_id)
      }
      processedSalons += 1
    } catch (err) {
      console.error(`口コミ日次パイプラインに失敗しました(salon_id=${t.salon_id}):`, err)
    }
  }
  return { processedSalons }
}
