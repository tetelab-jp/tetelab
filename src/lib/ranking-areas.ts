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

/** 表示用エリアラベル「関東 > 赤羽・板橋」 を組み立てる */
export function buildAreaLabel(serviceAreaName: string, middleName?: string | null, smallName?: string | null): string {
  return [serviceAreaName, middleName || undefined, smallName || undefined].filter(Boolean).join(' > ')
}

// --------------------------------------------
// 全国エリアの一括クロール(網羅)。
// getMiddleAreas / getSmallAreas は「未取得なら取得して保存」するので、
// 全大エリア→全中エリア→各中エリアの小エリア、と一巡すれば全国が揃う。
// 実行は本番(HPBに到達できる環境)で。数分かかる。
// --------------------------------------------

let crawlingAll = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** ranking_areas の中/小エリア件数 */
export async function getAreaCounts(env: Bindings): Promise<{ middle: number; small: number }> {
  const m = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ranking_areas WHERE level = 2`).first<{ n: number }>()
  const s = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ranking_areas WHERE level = 3`).first<{ n: number }>()
  return { middle: m?.n || 0, small: s?.n || 0 }
}

/** 一括クロールが実行中か */
export function isCrawlingAll(): boolean {
  return crawlingAll
}

/**
 * 全国の大/中/小エリアをまとめて取得・保存する。
 * force=true のときは既存の ranking_areas を消してから取り直す。
 * 二重起動は無視する(実行中は即return)。
 */
export async function crawlAllAreas(
  env: Bindings,
  opts: { force?: boolean } = {}
): Promise<{ middle: number; small: number }> {
  if (crawlingAll) return getAreaCounts(env)
  crawlingAll = true
  try {
    if (opts.force) {
      await env.DB.prepare(`DELETE FROM ranking_areas`).run()
    }
    for (const region of SERVICE_AREAS) {
      const middles = await getMiddleAreas(env, region.cd) // 未取得なら取得して保存
      for (const m of middles) {
        try {
          await getSmallAreas(env, region.cd, m.code)
        } catch (e) {
          console.error(`crawlAllAreas small failed ${region.cd}/${m.code}:`, e)
        }
        await sleep(800) // サイトに優しい間隔
      }
      await sleep(800)
    }
    return getAreaCounts(env)
  } finally {
    crawlingAll = false
  }
}
