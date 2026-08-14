// ============================================
// ranking-areas.ts
// フリーワード対策の「サロン名・対策エリア(中/小)」読み出しヘルパー。
// これらはSalonMotion上で手動選択するのではなく、サロンボード連携情報
// (salonboard_salons)に保存された自動検出値をそのまま使う。
// サロン名/サロンID(hpb_sln_id)はsalonboard-sync.tsのsyncSalonInfo()が、
// 中/小エリアは同じくsyncSalonArea()(HPBの公開サロンページを読み取る)が
// 都度更新する。ここでは読み出すだけ。
// ============================================

import type { Bindings } from '../types'

export type PrimarySalonArea = {
  salonName: string
  hpbSlnId: string | null
  serviceAreaCd: string | null
  middleAreaCd: string | null
  middleAreaName: string | null
  smallAreaCd: string | null
  smallAreaName: string | null
  areaSyncedAt: string | null
}

/**
 * ユーザーの主要サロン(salonboard_salonsの先頭行、無ければusers.salon_nameへ
 * フォールバック)のサロン名・対策エリアを返す。
 */
export async function getPrimarySalonArea(
  env: Bindings,
  userId: number,
  fallbackName: string | null
): Promise<PrimarySalonArea | null> {
  type SalonAreaRow = {
    salon_name: string
    hpb_sln_id: string | null
    service_area_cd: string | null
    middle_area_cd: string | null
    middle_area_name: string | null
    small_area_cd: string | null
    small_area_name: string | null
    area_synced_at: string | null
  }
  const AREA_COLUMNS = `salon_name, hpb_sln_id, service_area_cd, middle_area_cd, middle_area_name,
            small_area_cd, small_area_name, area_synced_at`

  // 複数サロンアカウント対応: salon_credentials.target_store_idで選択済みの
  // サロンがあれば優先する(salon_key=STORE_IDで照合)。未選択(単一サロン
  // アカウント等、従来通りの大多数のケース)の場合は、これまで通り
  // 先頭行にフォールバックする。
  const cred = await env.DB.prepare('SELECT target_store_id FROM salon_credentials WHERE user_id = ?')
    .bind(userId)
    .first<{ target_store_id: string | null }>()

  let row: SalonAreaRow | null = null
  if (cred?.target_store_id) {
    row = await env.DB.prepare(`SELECT ${AREA_COLUMNS} FROM salonboard_salons WHERE user_id = ? AND salon_key = ?`)
      .bind(userId, cred.target_store_id)
      .first<SalonAreaRow>()
  }
  if (!row) {
    row = await env.DB.prepare(`SELECT ${AREA_COLUMNS} FROM salonboard_salons WHERE user_id = ? ORDER BY id LIMIT 1`)
      .bind(userId)
      .first<SalonAreaRow>()
  }

  if (row) {
    return {
      salonName: row.salon_name,
      hpbSlnId: row.hpb_sln_id,
      serviceAreaCd: row.service_area_cd,
      middleAreaCd: row.middle_area_cd,
      middleAreaName: row.middle_area_name,
      smallAreaCd: row.small_area_cd,
      smallAreaName: row.small_area_name,
      areaSyncedAt: row.area_synced_at
    }
  }
  if (fallbackName) {
    return {
      salonName: fallbackName,
      hpbSlnId: null,
      serviceAreaCd: null,
      middleAreaCd: null,
      middleAreaName: null,
      smallAreaCd: null,
      smallAreaName: null,
      areaSyncedAt: null
    }
  }
  return null
}

/** 表示用エリアラベル「昭和町・大正・住吉・住之江 > 昭和町・西田辺・帝塚山・あびこ」を組み立てる */
export function buildAreaLabel(middleName?: string | null, smallName?: string | null): string {
  return [middleName || undefined, smallName || undefined].filter(Boolean).join(' > ')
}
