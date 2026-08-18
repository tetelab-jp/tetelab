// ============================================
// automation-lock.ts
//
// 2026-08-18追記: style/blog/review_sync/review_replyの4種類の自動化ジョブは
// それぞれ自分のジョブテーブル内でしか「進行中(pending/running)」を確認して
// いなかったため、同じサロンに対して別ジョブ種別が同時に投入されうる状態に
// なっていた(例: 120分おきのスタイル自動巡回と、10分おきの口コミ自動返信
// 巡回が同じタイミングで同じサロンへジョブを投入する)。
//
// SALON BOARDは1アカウント1セッション前提の外部サイトであり、別々の
// Fargateタスク(別IP)から同時にログインするとサーバー側でセッションが
// 競合し、一方(または両方)が想定外の状態のまま応答不能になることがある。
// このケースはPuppeteer側の個別timeout(15〜30秒)では検知できず、最終的に
// style-post-runner.ts等の15分スタール監視でしか回収できないため、
// 「ジョブがタイムアウトしました(Fargateタスクからの応答なし)」の頻度が
// 増える一因になっていたと考えられる。
//
// 対策として、実際にジョブ行をINSERTしFargateタスクを起動する直前の
// 最終チェックポイントで、同じsalon_idの他ジョブ種別の進行中ジョブも
// まとめて確認する。
// ============================================

import type { Bindings } from '../types'

export async function hasAnyInFlightSalonAutomationJob(env: Bindings, salonId: number | null): Promise<boolean> {
  if (salonId == null) return false
  const row = await env.DB.prepare(
    `SELECT 1 as x FROM (
       SELECT 1 FROM style_post_jobs WHERE salon_id = ? AND status IN ('pending', 'running')
       UNION ALL
       SELECT 1 FROM blog_post_jobs WHERE salon_id = ? AND status IN ('pending', 'running')
       UNION ALL
       SELECT 1 FROM review_sync_jobs WHERE salon_id = ? AND status IN ('pending', 'running')
       UNION ALL
       SELECT 1 FROM review_reply_jobs WHERE salon_id = ? AND status IN ('pending', 'running')
     ) t LIMIT 1`
  )
    .bind(salonId, salonId, salonId, salonId)
    .first<{ x: number }>()
  return !!row
}
