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
// @ts-ignore - ローカル型解決の都合上、実行時はWorkers環境でのみ動作する
import type { Page } from '@cloudflare/puppeteer'
import { SALONBOARD_BASE_URL, type AutomationLogger } from './salonboard-automation'

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
