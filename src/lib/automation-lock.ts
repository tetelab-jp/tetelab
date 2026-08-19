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
//
// 2026-08-19追記(重大バグ修正): 上記チェックにcreated_atの経過時間制限を
// 付けていなかったため、いずれかのジョブ種別で停滞ジョブ(Fargateタスクが
// 応答しないまま残ったpending/running行)が発生すると、それが自分自身の
// スタール監視で片付けられるまでの間ずっと、同じサロンの他ジョブ種別
// (styleの60〜120分おき自動巡回等)まで投入をブロックし続けてしまう欠陥が
// あった。特にreview_sync_jobsのスタール監視はsrc/index.tsxで1時間おきに
// しか回っていない(review_replyは10分おき、style/blogは外部Cronから
// 概ね1分おき)ため、review_sync側で1件停滞するだけで最悪1時間近く
// style投稿が止まりうる状態だった(sunny.西中島店で発生した「朝9時台に
// なってもスタイル投稿が実行されない」の実例で発覚)。各ジョブテーブル
// 自身のスタール監視がいずれも15分以内に停滞ジョブを片付ける設計である
// ことに合わせ、ここでも15分より古いpending/running行は「実質的に死んで
// おり、まもなく各自のスタール監視でtimeout化される」ものとして無視し、
// ブロックの最大継続時間を15分に抑える。
// ============================================

import type { Bindings } from '../types'

const IN_FLIGHT_MAX_AGE_INTERVAL = "interval '15 minutes'"

export async function hasAnyInFlightSalonAutomationJob(env: Bindings, salonId: number | null): Promise<boolean> {
  if (salonId == null) return false
  const row = await env.DB.prepare(
    `SELECT 1 as x FROM (
       SELECT 1 FROM style_post_jobs WHERE salon_id = ? AND status IN ('pending', 'running') AND created_at > (now() - ${IN_FLIGHT_MAX_AGE_INTERVAL})
       UNION ALL
       SELECT 1 FROM blog_post_jobs WHERE salon_id = ? AND status IN ('pending', 'running') AND created_at > (now() - ${IN_FLIGHT_MAX_AGE_INTERVAL})
       UNION ALL
       SELECT 1 FROM review_sync_jobs WHERE salon_id = ? AND status IN ('pending', 'running') AND created_at > (now() - ${IN_FLIGHT_MAX_AGE_INTERVAL})
       UNION ALL
       SELECT 1 FROM review_reply_jobs WHERE salon_id = ? AND status IN ('pending', 'running') AND created_at > (now() - ${IN_FLIGHT_MAX_AGE_INTERVAL})
     ) t LIMIT 1`
  )
    .bind(salonId, salonId, salonId, salonId)
    .first<{ x: number }>()
  return !!row
}
