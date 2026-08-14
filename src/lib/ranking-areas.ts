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
 * ユーザーの主要サロン(現在アクティブなワークスペース、無ければusers.salon_nameへ
 * フォールバック)のサロン名・対策エリアを返す。
 */
export async function getPrimarySalonArea(
  env: Bindings,
  userId: number,
  salonId: number | null,
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

  // 複数サロンワークスペース対応: 現在アクティブなサロン(salonId)をそのまま
  // 参照する。未設定(移行前の異常系)の場合のみ、従来通り先頭行にフォールバックする。
  let row: SalonAreaRow | null = null
  if (salonId) {
    row = await env.DB.prepare(`SELECT ${AREA_COLUMNS} FROM salonboard_salons WHERE id = ?`)
      .bind(salonId)
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
