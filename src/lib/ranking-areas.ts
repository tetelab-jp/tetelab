// ============================================
// ranking-areas.ts
// エリアマスター(ranking_areas)の読み出しヘルパー。
// 大エリアはHPBの地域コード(serviceAreaCd)の固定リスト。
// 中/小エリアはDBに未取得なら、その場でHPBをクロールしてキャッシュする
// (最初にそのエリアを開いたユーザーの操作で1度だけ収集される)。
// ============================================

import type { Bindings } from '../types'
import { crawlMiddleAreas, crawlSmallAreas } from './ranking-scraper'

export type ServiceArea = { cd: string; name: string }

// 確認済みの大エリア。デザインHTMLの全リストを受領し次第ここを拡張する。
// value = serviceAreaCd(検索URLの serviceAreaCd / パスの svc{XX} 接尾辞)。
export const SERVICE_AREAS: ServiceArea[] = [
  { cd: 'SA', name: '関東' },
  { cd: 'SB', name: '関西' },
  { cd: 'SC', name: '東海' }
]

export function serviceAreaName(cd: string): string {
  return SERVICE_AREAS.find((s) => s.cd === cd)?.name || cd
}

export type AreaOption = { code: string; name: string }

/** 中エリア一覧(DB優先、空ならクロールして保存) */
export async function getMiddleAreas(env: Bindings, serviceAreaCd: string): Promise<AreaOption[]> {
  const { results } = await env.DB.prepare(
    `SELECT middle_area_cd AS code, name FROM ranking_areas
     WHERE level = 2 AND service_area_cd = ? ORDER BY sort_order, id`
  )
    .bind(serviceAreaCd)
    .all<AreaOption>()
  if (results.length > 0) return results

  const crawled = await crawlMiddleAreas(serviceAreaCd, { proxyUrl: env.RANKING_PROXY_URL })
  let i = 0
  for (const a of crawled) {
    await env.DB.prepare(
      `INSERT INTO ranking_areas (level, service_area_cd, middle_area_cd, name, url, sort_order)
       VALUES (2, ?, ?, ?, ?, ?)`
    )
      .bind(serviceAreaCd, a.code, a.name, a.url, i++)
      .run()
  }
  return crawled.map((a) => ({ code: a.code, name: a.name }))
}

/** 小エリア一覧(DB優先、空ならクロールして保存)。取得できなければ空配列(=任意) */
export async function getSmallAreas(
  env: Bindings,
  serviceAreaCd: string,
  middleAreaCd: string
): Promise<AreaOption[]> {
  const { results } = await env.DB.prepare(
    `SELECT small_area_cd AS code, name FROM ranking_areas
     WHERE level = 3 AND service_area_cd = ? AND middle_area_cd = ? ORDER BY sort_order, id`
  )
    .bind(serviceAreaCd, middleAreaCd)
    .all<AreaOption>()
  if (results.length > 0) return results

  const crawled = await crawlSmallAreas(serviceAreaCd, middleAreaCd, { proxyUrl: env.RANKING_PROXY_URL })
  let i = 0
  for (const a of crawled) {
    await env.DB.prepare(
      `INSERT INTO ranking_areas (level, service_area_cd, middle_area_cd, small_area_cd, name, url, sort_order)
       VALUES (3, ?, ?, ?, ?, ?, ?)`
    )
      .bind(serviceAreaCd, middleAreaCd, a.code, a.name, a.url, i++)
      .run()
  }
  return crawled.map((a) => ({ code: a.code, name: a.name }))
}

/**
 * 「計測」画面のサロン名ドロップダウンの選択肢。
 * サロンボード同期テーブル(salonboard_salons)を優先し、無ければ users.salon_name。
 */
export async function getSalonOptions(env: Bindings, userId: number, fallbackName: string | null): Promise<string[]> {
  const names: string[] = []
  const seen = new Set<string>()
  const { results } = await env.DB.prepare(
    `SELECT salon_name FROM salonboard_salons WHERE user_id = ? ORDER BY id`
  )
    .bind(userId)
    .all<{ salon_name: string }>()
  for (const r of results) {
    if (r.salon_name && !seen.has(r.salon_name)) {
      seen.add(r.salon_name)
      names.push(r.salon_name)
    }
  }
  if (fallbackName && !seen.has(fallbackName)) names.push(fallbackName)
  return names
}

/** 表示用エリアラベル「関東 > 赤羽・板橋」 を組み立てる */
export function buildAreaLabel(serviceAreaName: string, middleName?: string | null, smallName?: string | null): string {
  return [serviceAreaName, middleName || undefined, smallName || undefined].filter(Boolean).join(' > ')
}
