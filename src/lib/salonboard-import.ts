// ============================================
// salonboard-import.ts
// SALON BOARDに既に登録済みのスタイルを、TETE AOUT側の
// styles/style_imagesテーブルへ取り込む(docs/phase3-mvp-design.md 5-2)。
//
// docs/salonboard-real-html-findings.md（2026-08-09、Playwrightで実アカウントを
// 調査した確定結果）で以下が確定済み:
//   - スタイル一覧は「1スタイル=4つの<tr>」構造。styleIdは
//     hidden input `frmStyleListStyleInfoDtoList[N].styleId`(value=L+9桁)が
//     最も安定して取得できる。
//   - 詳細行のクリックリンクは `<a onclick="editStyle(event, 'L244286488'); return false;">`
//     という実要素として存在する。window.editStyle()を偽のevent引数付きで
//     直接呼ぶより、この実要素をclick()する方が安全（実際のイベントオブジェクトが
//     渡るため）。
//   - editStyle実行後もURLは変化せず、同一ページ内でDOMがまるごと編集フォームに
//     差し替わる（フルページ相当の再レンダリング）。
//   - ページネーション用グローバル関数(doSelectFirst/doSelectPrevious/
//     doSelectLink/doSelectNext/doSelectLast等)の実在は確認済みだが、
//     複数ページが存在するアカウントでの実際のonclick文字列は未検証。
//
// ⚠️ まだ未確定の事項:
//   - ハッシュタグ・モデル属性欄の実セレクタ（未調査、空配列/空オブジェクト固定）
// ============================================

/// <reference lib="dom" />

import type { Bindings } from '../types'
// @ts-ignore - ローカル型解決の都合上、実行時はWorkers環境でのみ動作する
import type { Page } from '@cloudflare/puppeteer'
import { SALONBOARD_BASE_URL, type AutomationLogger } from './salonboard-automation'

export type ExistingStyleSummary = {
  styleId: string // L+9桁形式
  title: string | null
  sortNo: string | null // salonboard上の表示順(「No.」列, frmStyleListStyleInfoDtoList[N].sortNo)
  imageUrl: string | null // 一覧のサムネイル画像(img[name="stylePhoto"])。imgbp.salonboard.com上の公開CDN URL
  stylistName: string | null // 一覧2行目に表示されるスタイリスト名(プレーンテキスト、IDではない)
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
  couponSelectValue: string | null
  imageUrl: string | null
}

/**
 * スタイル一覧ページを巡回し、既存スタイルのID・タイトルを取得する。
 * HANDOFF.md 4-4「約150件/2ページ構成」「doSelectNext」を踏まえ、
 * ページネーションに対応する。
 *
 * ⚠️ 2026-08-09時点、「次へ」リンクの実HTML/onclick文字列そのものは
 * salonboard.com側の一時的なアクセス制限により実機未確認（類推による実装）。
 * login/editStyleの実測結果（docs/salonboard-real-html-findings.md）から、
 * このサイトのリンクは軒並み `<a onclick="fn(event, ...); return false;">`
 * という実要素で、window.fn()を直接（偽のevent無しで）呼ぶと
 * 「Cannot read properties of undefined (reading 'target')」のように
 * event参照でエラーになることが確認されているため、doSelectNextも
 * 同様に実要素を探してネイティブクリックする方式に統一した。
 * 実要素が見つからない場合／クリックに失敗した場合は、推測が外れている
 * 可能性を考慮してエラーにはせず「次のページなし」として扱い、
 * それまでに取得できた分だけで処理を継続する(安全策)。
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
      // docs/salonboard-real-html-findings.md 2章で確定済み:
      // styleIdを最も安定して取得できるのは
      // hidden input `frmStyleListStyleInfoDtoList[N].styleId` のvalue。
      // 1スタイル=4つの<tr>構成(先頭行がrowspan=4)で、以下も同じ先頭行/次行から
      // 直接取得できることを実機確認済み:
      //   - No.(表示順): 先頭行内の input[name*="sortNo"] の value
      //   - サムネイル画像: 先頭行内の img[name="stylePhoto"] の src
      //   - タイトル: 先頭行内の td[colspan="3"] のテキスト
      //   - スタイリスト名: 次行(2行目)の2番目の<td>のテキスト(プレーンテキスト、ID不明)
      const idPattern = /L\d{9}/
      const found: {
        styleId: string
        title: string | null
        sortNo: string | null
        imageUrl: string | null
        stylistName: string | null
      }[] = []
      const seen = new Set<string>()

      const idInputs = Array.from(
        document.querySelectorAll('input[type="hidden"][name*="styleId"]')
      ) as HTMLInputElement[]

      for (const input of idInputs) {
        const match = input.value.match(idPattern)
        if (!match || seen.has(match[0])) continue
        seen.add(match[0])

        const row = input.closest('tr')
        const sortNo = (row?.querySelector('input[name*="sortNo"]') as HTMLInputElement | null)?.value || null
        const imageUrl = (row?.querySelector('img[name="stylePhoto"]') as HTMLImageElement | null)?.src || null
        const titleCell = row?.querySelector('td[colspan="3"]')
        let title = titleCell?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60) || null

        let stylistName: string | null = null
        const nextRow = row?.nextElementSibling
        if (nextRow && nextRow.tagName === 'TR') {
          const cells = nextRow.querySelectorAll('td')
          stylistName = cells[1]?.textContent?.replace(/\s+/g, ' ').trim() || null
        }

        // フォールバック: td[colspan="3"]が見つからない場合、先頭行全体のテキストから推測
        if (!title && row) {
          title = row.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60) || null
        }

        found.push({ styleId: match[0], title, sortNo, imageUrl, stylistName })
      }

      // フォールバック: hidden inputで見つからなかった場合、リンクのonclick等からも探す
      if (found.length === 0) {
        const candidates = Array.from(document.querySelectorAll('a[onclick], [onclick]'))
        for (const el of candidates) {
          const attr = el.getAttribute('onclick')
          if (!attr) continue
          const match = attr.match(idPattern)
          if (match && !seen.has(match[0])) {
            seen.add(match[0])
            const row = el.closest('tr') || el.closest('li') || el.closest('div')
            const title = row?.textContent?.trim().slice(0, 60) || null
            found.push({ styleId: match[0], title, sortNo: null, imageUrl: null, stylistName: null })
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

    // 「次のページ」への遷移。
    // window.doSelectNext()を直接呼ぶと本番で実際に
    // 「Cannot read properties of undefined (reading 'target')」エラーになることを確認済み
    // （event引数を要求する実装のため）。login/editStyleと同様、実要素を
    // ネイティブクリック(page.click)する方式に変更。
    // 実要素が見つからない／クリックに失敗した場合は、エラーにせず
    // 「次のページなし」として扱い、ここまでの取得結果で処理を終了する。
    let hasNext = false
    const nextLinkSelector = 'a[onclick*="doSelectNext"], span[onclick*="doSelectNext"]'
    try {
      const nextLinkHandle = await page.$(nextLinkSelector)
      if (nextLinkHandle) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
          page.click(nextLinkSelector)
        ])
        hasNext = true
      }
    } catch (err: any) {
      log(
        `次のページへの遷移に失敗したため、ここまでの取得結果(${results.length}件)で処理を終了します: ${String(err?.message || err)}`
      )
      hasNext = false
    }

    if (!hasNext) break
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

  // 既存スタイル編集画面を開く。docs/salonboard-real-html-findings.md 2章で確定済み:
  // 詳細行のリンクは <a onclick="editStyle(event, 'L244286488'); return false;">。
  // window.editStyle()を偽のevent引数で直接呼ぶ、あるいはpage.evaluate内で
  // element.click()すると isTrusted=false の合成イベントになり、ボット対策等に
  // 無視される可能性があるため、Puppeteerネイティブのpage.click()
  // (CDP経由の本物のマウスイベント、isTrusted=true)を使う。
  // クリック後もURLは変化せず（同一ページ内でDOMがまるごと差し替わる）ため、
  // 遷移そのものは発生せずwaitForNavigationは使わない。
  const editLinkSelector = `a[onclick*="editStyle(event, '${styleId}')"]`
  const editLinkHandle = await page.$(editLinkSelector)
  if (!editLinkHandle) {
    throw new Error(`スタイル編集画面へのリンクが見つかりませんでした（styleId: ${styleId}）`)
  }
  await page.click(editLinkSelector)

  await page.waitForSelector('#styleEditForm', { timeout: 15000 })

  const detail = await page.evaluate(() => {
    const val = (selector: string) => (document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null)?.value || ''

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
      // docs/phase3-mvp-design.md 9章で確定済み: クーポンは隠しフィールド
      // frmStyleEditStyleDto.couponId にCP+14桁形式で入る
      couponSelectValue: val('input[name="frmStyleEditStyleDto.couponId"]'),
      // クーポンが非掲載/削除済みの場合、frmStyleEditStyleDto.noPresentDeleteFlg
      // (jsc_SB_modal_coupon_noPresentDeleteFlgクラス)が'1'になる。この状態の
      // クーポンIDをそのまま取り込むと、以後の反映申請が「要確認」でブロックされ
      // 続ける原因になるため、取り込み時点で検出できるようにする。
      couponNoPresentDeleteFlg: val('input[name="frmStyleEditStyleDto.noPresentDeleteFlg"]'),
      imageUrl: img && !img.className.includes('img_new_no_photo') ? img.src : null
    }
  })

  const couponIsOrphaned = detail.couponNoPresentDeleteFlg === '1'
  if (couponIsOrphaned && detail.couponSelectValue) {
    log(
      `警告: ${styleId} のクーポン(${detail.couponSelectValue})は非掲載/削除済みのため、取り込み対象から除外しました`
    )
  }

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
    couponSelectValue: couponIsOrphaned ? null : detail.couponSelectValue || null,
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

      let couponDbId: number | null = null
      if (detail.couponSelectValue) {
        const couponRow = await env.DB.prepare(
          'SELECT id FROM coupons WHERE user_id = ? AND salonboard_coupon_key = ?'
        )
          .bind(userId, detail.couponSelectValue)
          .first<{ id: number }>()
        couponDbId = couponRow?.id ?? null
      }

      const insert = await env.DB.prepare(
        `INSERT INTO styles (
           user_id, stylist_id, coupon_id, source_type, source_salonboard_style_key, title, comment,
           category_value, length_value, menu_values_json, menu_detail_text, hashtags_json,
           model_attributes_json, auto_post_enabled_flag, internal_save_status,
           salonboard_register_status, reflection_request_status
         ) VALUES (?, ?, ?, 'imported_from_salon_board', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ready', 'success', 'success')`
      )
        .bind(
          userId,
          stylistDbId,
          couponDbId,
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
