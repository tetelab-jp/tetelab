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

// 大エリア(HPBの地域一覧)。並び順はHPBのエリア選択と同じ。
// value = serviceAreaCd(検索URLの serviceAreaCd / パスの svc{XX} 接尾辞)。
export const SERVICE_AREAS: ServiceArea[] = [
  { cd: 'SA', name: '関東' },
  { cd: 'SB', name: '関西' },
  { cd: 'SC', name: '東海' },
  { cd: 'SD', name: '北海道' },
  { cd: 'SE', name: '東北' },
  { cd: 'SH', name: '北信越' },
  { cd: 'SF', name: '中国' },
  { cd: 'SI', name: '四国' },
  { cd: 'SG', name: '九州・沖縄' }
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

/**
 * 対策キーワード設定画面のサロン名は選択式ではなく自動入力にするため、
 * サロンボード同期の情報(直近1件)を優先し、無ければusers.salon_nameを使う。
 */
export async function getPrimarySalonName(
  env: Bindings,
  userId: number,
  fallbackName: string | null
): Promise<string | null> {
  const options = await getSalonOptions(env, userId, fallbackName)
  return options[0] || null
}

/** 表示用エリアラベル「関東 > 赤羽・板橋」 を組み立てる */
export function buildAreaLabel(serviceAreaName: string, middleName?: string | null, smallName?: string | null): string {
  return [serviceAreaName, middleName || undefined, smallName || undefined].filter(Boolean).join(' > ')
}

/**
 * 対策キーワード設定画面では大エリアの手動選択を廃止したため、全国9地域分の中エリアを
 * まとめて取得し、地域を跨いだ1つのフラットな選択肢として返す(各中エリアがどの
 * serviceAreaCdに属するかは戻り値のserviceAreaCdで保持し、小エリアのカスケード取得や
 * 登録時のservice_area_cd自動判定に使う)。未取得の地域はgetMiddleAreas側で都度
 * クロールされる(この画面を最初に開いた誰かの操作で1度だけ収集される)。
 */
export async function getAllMiddleAreas(env: Bindings): Promise<(AreaOption & { serviceAreaCd: string })[]> {
  const all: (AreaOption & { serviceAreaCd: string })[] = []
  for (const region of SERVICE_AREAS) {
    const middles = await getMiddleAreas(env, region.cd)
    for (const m of middles) {
      all.push({ ...m, serviceAreaCd: region.cd })
    }
  }
  return all
}
