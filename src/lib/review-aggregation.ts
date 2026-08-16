// ============================================
// review-aggregation.ts
// reviewsテーブルからの集計クエリ群。
//   ①口コミ評価推移(月次平均) / ②スタイリスト別評価(期間フィルタ付き)
// 評点はHPB側からしか取れないため、matched_at IS NOT NULLの行のみを対象に
// 集計する(未突合の行はスコアが無い)。
// ============================================

import type { Bindings } from '../types'

export type MonthlyTrendPoint = {
  month: string // "YYYY-MM"
  avgOverall: number
  count: number
}

/** ①口コミ評価推移: 投稿月ごとのscore_overall平均を古い順に返す */
export async function getMonthlyTrend(env: Bindings, salonId: number): Promise<MonthlyTrendPoint[]> {
  const { results } = await env.DB.prepare(
    `SELECT
       to_char(posted_at, 'YYYY-MM') AS month,
       AVG(score_overall) AS avg_overall,
       COUNT(*) AS cnt
     FROM reviews
     WHERE salon_id = ? AND matched_at IS NOT NULL AND posted_at IS NOT NULL
     GROUP BY month
     ORDER BY month ASC`
  )
    .bind(salonId)
    .all<{ month: string; avg_overall: string | number; cnt: number }>()

  return (results || []).map((r) => ({
    month: r.month,
    avgOverall: Math.round(Number(r.avg_overall) * 100) / 100,
    count: r.cnt
  }))
}

/** ②スタイリスト別評価の期間選択肢用: 口コミが実在する年月の一覧(新しい順) */
export async function getAvailableReviewMonths(env: Bindings, salonId: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT to_char(posted_at, 'YYYY-MM') AS month
     FROM reviews
     WHERE salon_id = ? AND matched_at IS NOT NULL AND posted_at IS NOT NULL
     ORDER BY month DESC`
  )
    .bind(salonId)
    .all<{ month: string }>()
  return (results || []).map((r) => r.month)
}

export type StylistBreakdownRow = {
  stylistId: number
  stylistName: string
  avgOverall: number
  avgAtmosphere: number
  avgService: number
  avgTechnique: number
  avgMenuPrice: number
  count: number
}

export type StylistBreakdownResult = {
  stylists: StylistBreakdownRow[]
  /** 担当スタイリスト名がstylistsテーブルと一致せず、集計に含められなかった件数 */
  unmatchedStylistCount: number
}

/**
 * ②スタイリスト別評価。period='all'なら全期間、'YYYY-MM'ならその月のみ。
 * stylist_idがNULL(名前不一致で未マッチ)の行はunmatchedStylistCountに
 * カウントするのみで、スタイリスト別ランキングには含めない。
 */
export async function getStylistBreakdown(
  env: Bindings,
  salonId: number,
  period: 'all' | string
): Promise<StylistBreakdownResult> {
  const periodClause = period === 'all' ? '' : `AND to_char(posted_at, 'YYYY-MM') = ?`
  const bindArgs: (number | string)[] = period === 'all' ? [salonId] : [salonId, period]

  const { results } = await env.DB.prepare(
    `SELECT
       st.id AS stylist_id,
       st.name AS stylist_name,
       AVG(r.score_overall) AS avg_overall,
       AVG(r.score_atmosphere) AS avg_atmosphere,
       AVG(r.score_service) AS avg_service,
       AVG(r.score_technique) AS avg_technique,
       AVG(r.score_menu_price) AS avg_menu_price,
       COUNT(*) AS cnt
     FROM reviews r
     JOIN stylists st ON st.id = r.stylist_id
     WHERE r.salon_id = ? AND r.matched_at IS NOT NULL ${periodClause}
     GROUP BY st.id, st.name
     ORDER BY avg_overall DESC NULLS LAST, cnt DESC`
  )
    .bind(...bindArgs)
    .all<{
      stylist_id: number
      stylist_name: string
      avg_overall: string | number
      avg_atmosphere: string | number
      avg_service: string | number
      avg_technique: string | number
      avg_menu_price: string | number
      cnt: number
    }>()

  const round2 = (v: string | number | null) => (v == null ? 0 : Math.round(Number(v) * 100) / 100)

  const stylists: StylistBreakdownRow[] = (results || []).map((r) => ({
    stylistId: r.stylist_id,
    stylistName: r.stylist_name,
    avgOverall: round2(r.avg_overall),
    avgAtmosphere: round2(r.avg_atmosphere),
    avgService: round2(r.avg_service),
    avgTechnique: round2(r.avg_technique),
    avgMenuPrice: round2(r.avg_menu_price),
    count: r.cnt
  }))

  const unmatchedRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM reviews
     WHERE salon_id = ? AND matched_at IS NOT NULL AND stylist_id IS NULL ${periodClause}`
  )
    .bind(...bindArgs)
    .first<{ cnt: number }>()

  return { stylists, unmatchedStylistCount: unmatchedRow?.cnt ?? 0 }
}
