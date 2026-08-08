// ============================================
// salonboard-import.ts
// SALON BOARDに既に登録済みのスタイルを、TETE AOUT側の
// styles/style_imagesテーブルへ取り込む(docs/phase3-mvp-design.md 5-2)。
//
// ⚠️ 未確定事項（実HTML未確認。実運用前に必ずDevToolsで確認・調整すること）:
//   1. fetchExistingStyles(): スタイル一覧ページの行DOM構造は未確認。
//      HANDOFF.md 4-4で確認済みのstyleId形式(L+9桁)を手がかりに、
//      ページ内のhidden input/リンク等からベストエフォートで抽出する
//      実装になっている。実際の一覧HTMLを確認後、確実なセレクタに
//      置き換えること。
//   2. fetchStyleDetail(): 既存スタイル編集画面を開くにはHANDOFF.md 4-4記載の
//      editStyle(event, styleId)をpage.evaluate内で呼ぶ想定。実際に
//      正しいイベント引数無しで動作するか未確認。
//   3. フォーム項目自体（スタイル名・コメント等）のセレクタは
//      draftRegisterStyle()で書き込みに使っているものと同一の
//      #styleEditForm内フィールドを読み取る想定(こちらは実HTML確認済み)。
// ============================================

/// <reference lib="dom" />

import type { Bindings } from '../types'
// @ts-ignore - ローカル型解決の都合上、実行時はWorkers環境でのみ動作する
import type { Page } from '@cloudflare/puppeteer'
import { SALONBOARD_BASE_URL, type AutomationLogger } from './salonboard-automation'

export type ExistingStyleSummary = {
  styleId: string // L+9桁形式
  title: string | null
}

export type ExistingStyleDetail = {
  styleId: string
  title: string
  comment: string
  categoryValue: 'SG01' | 'SG02'
  lengthValue: string
  menuValues: string[]
  menuDetailText: string
  hashtags: string[]
  modelAttributes: Record<string, string>
  stylistSelectValue: string
  imageUrl: string | null
}

/**
 * スタイル一覧ページを巡回し、既存スタイルのID・タイトルを取得する。
 * HANDOFF.md 4-4「約150件/2ページ構成」「doSelectNext」を踏まえ、
 * ページネーションに対応する（ただし「次へ」ボタンの実際のセレクタは未確認）。
 */
export async function fetchExistingStyles(page: Page, log: AutomationLogger): Promise<ExistingStyleSummary[]> {
  await page.goto(`${SALONBOARD_BASE_URL}/CNB/draft/styleList/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })

  const results: ExistingStyleSummary[] = []
  const seenIds = new Set<string>()
  const MAX_PAGES = 10 // 安全のための上限。実際は2ページ程度の想定(HANDOFF.md参照)

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    log(`スタイル一覧を取得中...(${pageIndex + 1}ページ目)`)

    const pageResults = await page.evaluate(() => {
      // styleId形式(L+9桁)をhidden input・リンクのhref/onclick等から探すベストエフォート実装。
      const idPattern = /L\d{9}/
      const found: { styleId: string; title: string | null }[] = []
      const seen = new Set<string>()

      const candidates = Array.from(
        document.querySelectorAll('input[type="hidden"], a[href], a[onclick], [onclick]')
      )
      for (const el of candidates) {
        const attrs = [
          (el as HTMLInputElement).value,
          el.getAttribute('href'),
          el.getAttribute('onclick'),
          el.id
        ]
        for (const attr of attrs) {
          if (!attr) continue
          const match = attr.match(idPattern)
          if (match && !seen.has(match[0])) {
            seen.add(match[0])
            // 同じ行内のテキストからタイトルらしきものを推測する(不確実)
            const row = el.closest('tr') || el.closest('li') || el.closest('div')
            const title = row?.textContent?.trim().slice(0, 60) || null
            found.push({ styleId: match[0], title })
          }
        }
      }
      return found
    })

    let addedInThisPage = 0
    for (const r of pageResults) {
      if (!seenIds.has(r.styleId)) {
        seenIds.add(r.styleId)
        results.push(r)
        addedInThisPage++
      }
    }

    if (addedInThisPage === 0) break

    // 「次のページ」への遷移。実際のトリガー関数はHANDOFF.md 4-4の
    // doSelectNext等と思われるが未確認のため、存在すれば呼び、
    // 存在しなければページネーション無しとみなして終了する。
    const hasNext = await page.evaluate(() => {
      // @ts-ignore
      if (typeof (window as any).doSelectNext === 'function') {
        // @ts-ignore
        ;(window as any).doSelectNext()
        return true
      }
      return false
    })
    if (!hasNext) break

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
  }

  log(`スタイル一覧を${results.length}件取得しました`)
  return results
}

/**
 * 1件の既存スタイルの詳細を取得する。draftRegisterStyle()が書き込みに使う
 * #styleEditForm内の各フィールドを、同じセレクタで読み取る(実HTML確認済み分)。
 */
export async function fetchStyleDetail(page: Page, styleId: string, log: AutomationLogger): Promise<ExistingStyleDetail> {
  log(`スタイル詳細を取得中...(${styleId})`)

  await page.goto(`${SALONBOARD_BASE_URL}/CNB/draft/styleList/`, { waitUntil: 'domcontentloaded', timeout: 30000 })

  // 既存スタイル編集画面を開く。HANDOFF.md 4-4のeditStyle(event, styleId)を想定。
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    page.evaluate((id: string) => {
      // @ts-ignore
      if (typeof (window as any).editStyle === 'function') {
        // @ts-ignore - 実際のイベント引数無しで動作するかは未確認
        ;(window as any).editStyle({ preventDefault: () => {} }, id)
      }
    }, styleId)
  ])

  await page.waitForSelector('#styleEditForm', { timeout: 15000 })

  const detail = await page.evaluate(() => {
    const val = (selector: string) => (document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null)?.value || ''
    const checkedRadioValue = (name: string) =>
      (document.querySelector(`input[name="${name}"]:checked`) as HTMLInputElement | null)?.value || ''

    const category = (document.getElementById('styleCategoryCd02') as HTMLInputElement | null)?.checked ? 'SG02' : 'SG01'
    const lengthSelector = category === 'SG01' ? '.ladiesHairLengthCd' : '.mensHairLengthCd'

    const menuValues = Array.from(document.querySelectorAll('input.menuContentsCdList:checked')).map(
      (el) => (el as HTMLInputElement).value
    )

    const img = document.getElementById('FRONT_IMG_ID_IMG') as HTMLImageElement | null

    return {
      title: val('#styleNameTxt'),
      comment: val('#stylistCommentTxt'),
      categoryValue: category,
      lengthValue: val(lengthSelector),
      menuValues,
      menuDetailText: val('#menuDetailTxt'),
      stylistSelectValue: val('#stylistCheckCd'),
      imageUrl: img && !img.className.includes('img_new_no_photo') ? img.src : null
    }
  })

  return {
    styleId,
    title: detail.title,
    comment: detail.comment,
    categoryValue: detail.categoryValue as 'SG01' | 'SG02',
    lengthValue: detail.lengthValue,
    menuValues: detail.menuValues,
    menuDetailText: detail.menuDetailText,
    hashtags: [], // ⚠️ ハッシュタグ欄のセレクタ未確認のため空配列固定
    modelAttributes: {}, // ⚠️ モデル属性欄のセレクタ未確認のため空オブジェクト固定
    stylistSelectValue: detail.stylistSelectValue,
    imageUrl: detail.imageUrl
  }
}

/**
 * 選択された既存スタイルをTETE AOUT側のstyles/style_imagesへ取り込む。
 * 画像はブラウザのセッション(Cookie)を使ってpage.evaluate内でfetchし、
 * base64化してWorker側へ渡してからR2へ保存する。
 */
export async function importSelectedStyles(
  page: Page,
  env: Bindings,
  userId: number,
  styleIds: string[],
  log: AutomationLogger
): Promise<{ importedCount: number; errors: string[] }> {
  let importedCount = 0
  const errors: string[] = []

  for (const styleId of styleIds) {
    try {
      const detail = await fetchStyleDetail(page, styleId, log)

      // 既に取り込み済みならスキップ(source_salonboard_style_keyで照合)
      const existing = await env.DB.prepare(
        'SELECT id FROM styles WHERE user_id = ? AND source_salonboard_style_key = ?'
      )
        .bind(userId, styleId)
        .first<{ id: number }>()
      if (existing) {
        log(`${styleId} は取り込み済みのためスキップします`)
        continue
      }

      let stylistDbId: number | null = null
      if (detail.stylistSelectValue) {
        const stylistRow = await env.DB.prepare(
          'SELECT id FROM stylists WHERE user_id = ? AND salonboard_stylist_key = ?'
        )
          .bind(userId, detail.stylistSelectValue)
          .first<{ id: number }>()
        stylistDbId = stylistRow?.id ?? null
      }

      const insert = await env.DB.prepare(
        `INSERT INTO styles (
           user_id, stylist_id, source_type, source_salonboard_style_key, title, comment,
           category_value, length_value, menu_values_json, menu_detail_text, hashtags_json,
           model_attributes_json, auto_post_enabled_flag, internal_save_status,
           salonboard_register_status, reflection_request_status
         ) VALUES (?, ?, 'imported_from_salon_board', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ready', 'success', 'success')`
      )
        .bind(
          userId,
          stylistDbId,
          styleId,
          detail.title.slice(0, 60),
          detail.comment.slice(0, 240),
          detail.categoryValue,
          detail.lengthValue,
          JSON.stringify(detail.menuValues),
          detail.menuDetailText.slice(0, 100),
          JSON.stringify(detail.hashtags),
          JSON.stringify(detail.modelAttributes)
        )
        .run()

      const newStyleId = Number(insert.meta.last_row_id)

      if (detail.imageUrl) {
        try {
          const base64 = await page.evaluate(async (url: string) => {
            const res = await fetch(url, { credentials: 'include' })
            const buf = await res.arrayBuffer()
            const bytes = new Uint8Array(buf)
            let binary = ''
            for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
            return btoa(binary)
          }, detail.imageUrl)

          const binary = atob(base64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

          const key = `style/${userId}/imported-${styleId}-${Date.now()}.jpg`
          await env.STYLE_IMAGES.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } })

          await env.DB.prepare(
            `INSERT INTO style_images (style_id, image_role, r2_key, file_name, sort_order) VALUES (?, 'FRONT', ?, ?, 0)`
          )
            .bind(newStyleId, key, `${styleId}.jpg`)
            .run()
        } catch (imgErr: any) {
          log(`警告: ${styleId} の画像取得に失敗しました: ${String(imgErr?.message || imgErr)}`)
        }
      }

      importedCount++
      log(`${styleId} を取り込みました`)
    } catch (err: any) {
      const message = String(err?.message || err)
      errors.push(`${styleId}: ${message}`)
      log(`エラー: ${styleId} の取り込みに失敗しました: ${message}`)
    }
  }

  return { importedCount, errors }
}
