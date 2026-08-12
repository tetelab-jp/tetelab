// ============================================
// salonboard-sync.ts
// SALON BOARDから「スタイリスト一覧」「クーポン一覧」を取得し、
// stylists/coupons テーブルへupsertする(docs/phase3-mvp-design.md 5-1)。
//
// セレクタは2026-08-08にユーザーから提供された実HTML
// (/CNB/draft/stylistList/, /CNB/draft/couponList/)の構造に基づく。
// ============================================

/// <reference lib="dom" />

import type { Bindings } from '../types'
import { SALONBOARD_BASE_URL, type AutomationLogger, type Page } from './salonboard-automation'

export type SyncedStylist = {
  stylistId: string // T001014365 形式
  name: string
}

export type SyncedCoupon = {
  couponId: string // CP00000010256490 形式
  name: string
}

/**
 * スタイリスト一覧ページから氏名/SALON BOARD内部IDを取得する。
 * 行は <tr name="stylist_info"> で、氏名は4番目の<td>(0-indexで3番目)。
 */
export async function fetchStylistsFromSalonBoard(page: Page): Promise<SyncedStylist[]> {
  await page.goto(`${SALONBOARD_BASE_URL}/CNB/draft/stylistList/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })
  await page.waitForSelector('tr[name="stylist_info"]', { timeout: 15000 }).catch(() => {})

  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr[name="stylist_info"]'))
    const results: { stylistId: string; name: string }[] = []
    for (const row of rows) {
      const idInput = row.querySelector('input[name$=".stylistId"]') as HTMLInputElement | null
      const tds = row.querySelectorAll('td')
      const name = tds[3]?.textContent?.trim()
      if (idInput?.value && name) {
        results.push({ stylistId: idInput.value, name })
      }
    }
    return results
  })
}

/**
 * クーポン一覧ページからクーポン名/SALON BOARD内部IDを取得する。
 * 行の直下に <input type="hidden" name="frmCouponListDto[N].couponId"> があり、
 * クーポン名は class="td_value_store pa5 wbba taL" のtdに入っている。
 */
export async function fetchCouponsFromSalonBoard(page: Page): Promise<SyncedCoupon[]> {
  await page.goto(`${SALONBOARD_BASE_URL}/CNB/draft/couponList/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })
  await page.waitForSelector('input[name$=".couponId"]', { timeout: 15000 }).catch(() => {})

  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('input[name$=".couponId"]'))
    const results: { couponId: string; name: string }[] = []
    for (const input of rows) {
      const el = input as HTMLInputElement
      const row = el.closest('tr')
      const nameCell = row?.querySelector('td.wbba.taL')
      const name = nameCell?.textContent?.trim()
      if (el.value && name) {
        results.push({ couponId: el.value, name })
      }
    }
    return results
  })
}

/**
 * 取得したスタイリスト一覧をDBへupsertする。
 * 既存行は salonboard_stylist_key で照合し、名前が変わっていれば更新。
 * 新規は insert。SALON BOARD側で削除されたスタイリストは削除しない
 * (過去のスタイル・スタイリスト紐付けを壊さないため。非表示にする運用は将来検討)。
 */
export async function upsertStylists(env: Bindings, userId: number, stylists: SyncedStylist[]): Promise<number> {
  let count = 0
  for (const s of stylists) {
    const existing = await env.DB.prepare(
      `SELECT id FROM stylists WHERE user_id = ? AND salonboard_stylist_key = ?`
    )
      .bind(userId, s.stylistId)
      .first<{ id: number }>()

    if (existing) {
      await env.DB.prepare(`UPDATE stylists SET name = ? WHERE id = ?`).bind(s.name, existing.id).run()
    } else {
      await env.DB.prepare(
        `INSERT INTO stylists (user_id, name, salonboard_stylist_key, is_active, sort_order)
         VALUES (?, ?, ?, 1, 0)`
      )
        .bind(userId, s.name, s.stylistId)
        .run()
    }
    count++
  }
  await env.DB.prepare(`UPDATE salon_credentials SET last_stylist_synced_at = CURRENT_TIMESTAMP WHERE user_id = ?`)
    .bind(userId)
    .run()
  return count
}

/**
 * 取得したクーポン一覧をDBへupsertする(upsertStylistsと同様の方針)。
 */
export async function upsertCoupons(env: Bindings, userId: number, coupons: SyncedCoupon[]): Promise<number> {
  let count = 0
  for (const c of coupons) {
    const existing = await env.DB.prepare(
      `SELECT id FROM coupons WHERE user_id = ? AND salonboard_coupon_key = ?`
    )
      .bind(userId, c.couponId)
      .first<{ id: number }>()

    if (existing) {
      await env.DB.prepare(`UPDATE coupons SET name = ? WHERE id = ?`).bind(c.name, existing.id).run()
    } else {
      await env.DB.prepare(
        `INSERT INTO coupons (user_id, name, salonboard_coupon_key, is_active, sort_order)
         VALUES (?, ?, ?, 1, 0)`
      )
        .bind(userId, c.name, c.couponId)
        .run()
    }
    count++
  }
  await env.DB.prepare(`UPDATE salon_credentials SET last_coupon_synced_at = CURRENT_TIMESTAMP WHERE user_id = ?`)
    .bind(userId)
    .run()
  return count
}

/**
 * スタイリスト同期の一連の処理(ログイン済みのpageを渡すこと)。
 */
export async function syncStylists(
  page: Page,
  env: Bindings,
  userId: number,
  log: AutomationLogger
): Promise<number> {
  log('スタイリスト一覧を取得中...')
  const stylists = await fetchStylistsFromSalonBoard(page)
  const count = await upsertStylists(env, userId, stylists)
  log(`スタイリスト ${count}件を同期しました`)
  return count
}

/**
 * クーポン同期の一連の処理(ログイン済みのpageを渡すこと)。
 */
export async function syncCoupons(page: Page, env: Bindings, userId: number, log: AutomationLogger): Promise<number> {
  log('クーポン一覧を取得中...')
  const coupons = await fetchCouponsFromSalonBoard(page)
  const count = await upsertCoupons(env, userId, coupons)
  log(`クーポン ${count}件を同期しました`)
  return count
}

// ============================================
// サロン情報(サロン名 / サロンID)の同期
// ログイン後のヘッダーから取得する:
//   - サロン名: <li class="shop_login_name">Voler -カラー専門店-</li>
//   - サロンID: <input type="hidden" name="STORE_ID" value="H000750928">
// STORE_ID(H000750928)はHPBの公開サロンページ /slnH000750928/ と対応するため、
// 'sln'+STORE_ID = slnH000750928 を hpb_sln_id として保存する
// (フリーワード対策のサロン名ドロップダウン/将来のID照合で利用)。
// ============================================

export type SyncedSalonInfo = {
  storeId: string // 例 'H000750928'
  salonName: string // 例 'Voler -カラー専門店-'
}

/**
 * ログイン済みpageの現在ページのヘッダーからサロン名とサロンIDを取得する。
 * どちらも見つからなければ null。
 */
export async function fetchSalonInfoFromSalonBoard(page: Page): Promise<SyncedSalonInfo | null> {
  return page.evaluate(() => {
    const nameEl = document.querySelector('li.shop_login_name')
    const salonName = (nameEl?.textContent || '').trim()
    const storeInput = document.querySelector('input[name="STORE_ID"]') as HTMLInputElement | null
    const storeId = (storeInput?.value || '').trim()
    if (!salonName && !storeId) return null
    return { storeId, salonName }
  })
}

/**
 * 取得したサロン情報を salonboard_salons へupsertする。
 * 照合は (user_id, salon_key=STORE_ID)。STORE_IDが取れない場合はサロン名で照合。
 */
export async function upsertSalonInfo(env: Bindings, userId: number, info: SyncedSalonInfo): Promise<void> {
  const salonName = info.salonName || '(サロン名未取得)'
  const storeId = info.storeId || null
  const hpbSlnId = storeId ? `sln${storeId}` : null

  let existing: { id: number } | null = null
  if (storeId) {
    existing = await env.DB.prepare(
      `SELECT id FROM salonboard_salons WHERE user_id = ? AND salon_key = ?`
    )
      .bind(userId, storeId)
      .first<{ id: number }>()
  } else {
    existing = await env.DB.prepare(
      `SELECT id FROM salonboard_salons WHERE user_id = ? AND salon_name = ?`
    )
      .bind(userId, salonName)
      .first<{ id: number }>()
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE salonboard_salons SET salon_name = ?, salon_key = ?, hpb_sln_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(salonName, storeId, hpbSlnId, existing.id)
      .run()
  } else {
    await env.DB.prepare(
      `INSERT INTO salonboard_salons (user_id, salon_key, salon_name, hpb_sln_id) VALUES (?, ?, ?, ?)`
    )
      .bind(userId, storeId, salonName, hpbSlnId)
      .run()
  }
}

/**
 * サロン情報同期の一連の処理(ログイン済みのpageを渡すこと)。
 */
export async function syncSalonInfo(
  page: Page,
  env: Bindings,
  userId: number,
  log: AutomationLogger
): Promise<SyncedSalonInfo | null> {
  log('サロン情報(名前/ID)を取得中...')
  const info = await fetchSalonInfoFromSalonBoard(page)
  if (info) {
    await upsertSalonInfo(env, userId, info)
    log(`サロン情報を同期しました: ${info.salonName} (${info.storeId})`)
  } else {
    log('サロン情報が取得できませんでした(ヘッダー未検出)')
  }
  return info
}
