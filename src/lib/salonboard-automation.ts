// ============================================
// salonboard-automation.ts
// Cloudflare Browser Rendering (@cloudflare/puppeteer) を使った
// サロンボードへの自動ログイン・スタイル投稿・反映申請
//
// 確定済み事項（HANDOFF.md 4章・docs/phase3-mvp-design.md 9章、実HTML解析済み）:
//   - フォームID/name属性、doRegister()/editStyle()/addStyle()等のJS関数
//   - 写真アップロードのトリガー(img_upload_modal_view)と完了コールバック
//     (setUploadImage → #FRONT_IMG_ID にセット)の関数シグネチャ
//   - クーポンは隠しフィールド frmStyleEditStyleDto.couponId に直接値をセットすればよい
//   - モデル属性(髪量/髪質等)は自動化では触らずデフォルト('99')のままでよい
//   - SALONBOARD_BASE_URL='https://salonboard.com'（実運用で到達確認済み）
//
// ⚠️ まだ未確認の事項（実運用前に必ずDevToolsで確認すること）:
//   1. 画像アップロードモーダル内部のDOM（実際の<input type=file>のセレクタ・
//      アップロードAJAXのリクエスト形式）: モーダルがJSで動的挿入されるため、
//      静的HTMLからは分からず、実際にクリックして開いた状態を確認する必要がある。
//      本実装ではUI操作（プレースホルダークリック→モーダル内file inputへ注入）で
//      代替している。Phase 3-Hの最優先事項。
//   2. 掲載管理TOPでの「NG」「未確認」の実際の表示形式（DOM構造・文言）。
//      checkReflectBlockers()参照。
// ============================================

// page.evaluate() のコールバックはブラウザ(Chromium)側で実行されるため、
// Workers側の型定義とは別にDOM型を参照する必要がある。
/// <reference lib="dom" />

import type { Bindings } from '../types'

// puppeteer本体はCloudflare Workers専用パッケージ。型のみ利用。
// @ts-ignore - ローカル型解決の都合上、実行時はWorkers環境でのみ動作する
import puppeteer, { type Browser, type Page } from '@cloudflare/puppeteer'
export type { Browser, Page }

export const SALONBOARD_BASE_URL = 'https://salonboard.com' // ⚠️ 要確認

export type StylePostInput = {
  styleImageId: number
  imageBuffer: ArrayBuffer
  imageFileName: string
  styleName: string // frmStyleEditStyleDto.styleName（最大60文字）
  stylistSelectValue: string // #stylistCheckCd の <option value>
  stylistComment: string // frmStyleEditStylistCommentDto.stylistComment（最大240文字）
  categoryCd: 'SG01' | 'SG02' // レディース / メンズ
  hairLengthValue: string // ladiesHairLengthCd or mensHairLengthCd の <option value>
  menuContentsCdList?: string[] // MC01〜MC04
  menuDetailText: string // .menuContents textarea（最大100文字）
  couponSelectValue?: string // frmStyleEditStyleDto.couponId（CP+14桁形式）。docs/phase3-mvp-design.md 9章参照
  // ⚠️ モデル属性(髪量/髪質/顔型/太さ/クセ/年代)は意図的に含めていない。
  // HANDOFF.md 4-5「自動化では触らずデフォルト('99'=未設定)のままでよい」との確定方針のため。
  // アプリのUI上でモデル情報を入力できるが、現時点ではTETE AOUT内部の記録用メタデータであり、
  // SALON BOARDへは送信されない。
}

export type AutomationLogger = (message: string) => void

export type StylePostResult = {
  success: boolean
  step: 'login' | 'navigate' | 'draft_register' | 'image_upload' | 'reflect' | 'done'
  message: string
}

/**
 * Cloudflare Browser Renderingでブラウザインスタンスを起動する。
 * 呼び出し側で必ず finally 節等で browser.close() すること
 * （Browser Renderingは同時起動数・使用時間に上限があるため）。
 */
export async function launchBrowser(env: Bindings): Promise<Browser> {
  return puppeteer.launch(env.BROWSER)
}

/**
 * サロンボードにログインする。
 * フォームの見た目のactionはおとりで、実際は<a>のonclickに紐づくJS関数
 * dologin() 経由で /CNC/login/doLogin/ にPOSTされる（HANDOFF.md 3-1参照）。
 */
export async function loginToSalonBoard(
  page: Page,
  loginId: string,
  password: string,
  log: AutomationLogger
): Promise<void> {
  log('ログインページへ遷移中...')
  await page.goto(`${SALONBOARD_BASE_URL}/login/`, { waitUntil: 'domcontentloaded', timeout: 30000 })

  await page.waitForSelector('input[name="userId"]', { timeout: 15000 })
  await page.type('input[name="userId"]', loginId, { delay: 20 })
  await page.type('input[name="password"]', password, { delay: 20 })

  log('ログイン実行中...')
  // 通常のsubmitは無効化されているため、実際に使われているJS関数を直接呼ぶ。
  // (見た目のUI操作を再現するより、実際に発火する関数を叩く方が安定するため)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    page.evaluate(() => {
      // @ts-ignore - サロンボードのページ内で定義されているグローバル関数
      if (typeof (window as any).dologin === 'function') {
        ;(window as any).dologin()
      } else {
        // フォールバック: JS関数が見つからない場合はフォームを直接submit
        const form = document.getElementById('idPasswordInputForm') as HTMLFormElement | null
        form?.submit()
      }
    })
  ])

  // ログイン成功確認: ログインページのまま（エラー）でないかをURLで簡易判定
  const currentUrl = page.url()
  if (currentUrl.includes('/login/') || currentUrl.includes('idPasswordInput')) {
    throw new Error('ログインに失敗しました（ID/パスワードが正しくない可能性があります）')
  }
  log('ログイン成功')
}

/**
 * 1件のスタイル画像を「登録（下書き保存）」する。
 * 反映申請は含まない（別途 submitReflectApplication を呼ぶ必要がある）。
 */
export async function draftRegisterStyle(page: Page, input: StylePostInput, log: AutomationLogger): Promise<void> {
  log('スタイル一覧ページへ遷移中...')
  await page.goto(`${SALONBOARD_BASE_URL}/CNB/draft/styleList/`, { waitUntil: 'domcontentloaded', timeout: 30000 })

  log('新規スタイル作成フォームを開いています...')
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    page.evaluate(() => {
      // @ts-ignore
      if (typeof (window as any).addStyle === 'function') {
        ;(window as any).addStyle()
      } else {
        const form = document.getElementById('addStyleForm') as HTMLFormElement | null
        form?.submit()
      }
    })
  ])

  await page.waitForSelector('#styleEditForm', { timeout: 15000 })

  // ---- 画像形式ラジオ: "0" = 画像固定 ----
  await page.evaluate(() => {
    const radio = document.querySelector(
      'input[name="frmStyleEditStyleInfoDto.styleRegistFormat"][value="0"]'
    ) as HTMLInputElement | null
    if (radio) radio.checked = true
  })

  // ---- 写真アップロード（最重要・不確定要素あり） ----
  log('写真をアップロード中...（未検証の処理です）')
  await uploadFrontImage(page, input.imageBuffer, input.imageFileName, log)

  // ---- スタイリスト選択 ----
  await page.select('#stylistCheckCd', input.stylistSelectValue)

  // ---- スタイリストコメント ----
  await page.evaluate((text: string) => {
    const el = document.getElementById('stylistCommentTxt') as HTMLTextAreaElement | null
    if (el) el.value = text
  }, input.stylistComment.slice(0, 240))

  // ---- スタイル名 ----
  await page.evaluate((text: string) => {
    const el = document.getElementById('styleNameTxt') as HTMLInputElement | null
    if (el) el.value = text
  }, input.styleName.slice(0, 60))

  // ---- カテゴリ（レディース/メンズ） ----
  const categoryRadioId = input.categoryCd === 'SG01' ? '#styleCategoryCd01' : '#styleCategoryCd02'
  await page.click(categoryRadioId)
  // カテゴリ選択によりJSでレングスselectの表示が切り替わるため少し待つ
  // (新しいバージョンのpuppeteerではpage.waitForTimeoutが廃止されているため自前で待機)
  await sleep(300)

  // ---- ヘアレングス（レディース/メンズでselectorが異なる） ----
  const lengthSelector = input.categoryCd === 'SG01' ? '.ladiesHairLengthCd' : '.mensHairLengthCd'
  const lengthHandle = await page.$(lengthSelector)
  if (lengthHandle) {
    await page.select(lengthSelector, input.hairLengthValue)
  }

  // ---- メニュー内容チェックボックス（任意） ----
  if (input.menuContentsCdList && input.menuContentsCdList.length > 0) {
    for (const mc of input.menuContentsCdList) {
      const cb = await page.$(`input.menuContentsCdList[value="${mc}"]`)
      if (cb) await cb.click()
    }
  }

  // ---- メニュー詳細（必須） ----
  await page.evaluate((text: string) => {
    const el = document.getElementById('menuDetailTxt') as HTMLTextAreaElement | null
    if (el) el.value = text
  }, input.menuDetailText.slice(0, 100))

  // ---- クーポン（任意） ----
  // docs/phase3-mvp-design.md 9章で確定: 見た目はモーダル選択UIだが、
  // 最終的にPOSTされるのは隠しフィールド frmStyleEditStyleDto.couponId の値
  // (CP+14桁形式)のみのため、モーダルUIを操作せず直接値をセットする。
  if (input.couponSelectValue) {
    await page.evaluate((couponId: string) => {
      const el = document.querySelector(
        'input[name="frmStyleEditStyleDto.couponId"]'
      ) as HTMLInputElement | null
      if (el) el.value = couponId
    }, input.couponSelectValue)
  }

  // ---- 保存（doRegister） ----
  log('スタイルを登録中...')
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    page.evaluate(() => {
      const btn = document.querySelector('[onclick*="doRegister("]') as HTMLElement | null
      btn?.click()
    })
  ])

  log('スタイル登録が完了しました')
}

/**
 * 写真アップロード処理。
 *
 * docs/phase3-mvp-design.md 9章で確定済みの情報:
 * - `.img_new_no_photo`（`#FRONT_IMG_ID_IMG`が該当）クリックで
 *   `img_upload_modal_view('FRONT_IMG_ID', 'ABNKD3600_FRONT', dataKey, false, 'styleEditForm')`
 *   が発火し、`#imageUploaderModalBody`にモーダル内容がJSで動的挿入される
 * - アップロード完了コールバック`setUploadImage(...)`が隠しフィールド`#FRONT_IMG_ID`に
 *   画像ID(B+9桁形式)をセットする → これを完了検知の主条件として使う
 *
 * ⚠️ 未確認のまま残っている点: モーダル内部の実際の`<input type=file>`のセレクタ・
 * アップロードAJAXのリクエスト形式は、モーダルがJSで動的挿入されるため静的HTMLからは
 * 分からず、実際にクリックして開いた状態のDOMを確認する必要がある(未着手)。
 */
async function uploadFrontImage(
  page: Page,
  imageBuffer: ArrayBuffer,
  fileName: string,
  log: AutomationLogger
): Promise<void> {
  // 一時ファイルとして書き出す必要はなく、CDPのDOM.setFileInputFiles相当を
  // Puppeteerのuploadfile()経由で行うため、Bufferを直接使えるヘルパーを利用。
  // @cloudflare/puppeteer は elementHandle.uploadFile(filePath) がローカルパス前提のため、
  // Workers環境ではファイルシステムが無く使えない可能性が高い。
  // その場合はページ内でBase64からFileオブジェクトを生成し、
  // DataTransferでinputに注入する方式にフォールバックする。

  await page.click('#FRONT_IMG_ID_IMG')
  await page.waitForSelector('#imageUploaderModalBody', { timeout: 10000 }).catch(() => {
    log('警告: 画像アップロードモーダルの検出に失敗しました。セレクタの再確認が必要です。')
  })

  const fileInputSelector = '#imageUploaderModalBody input[type="file"]'
  const fileInput = await page.$(fileInputSelector)

  if (!fileInput) {
    throw new Error(
      '画像アップロード用のinput[type=file]が見つかりませんでした。モーダルDOM構造の再調査が必要です。'
    )
  }

  // Base64化してブラウザ内でFileオブジェクトを生成し、input.filesにセットする
  const base64 = arrayBufferToBase64(imageBuffer)
  await page.evaluate(
    async (selector: string, base64Data: string, name: string) => {
      const input = document.querySelector(selector) as HTMLInputElement
      const byteChars = atob(base64Data)
      const byteNumbers = new Array(byteChars.length)
      for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i)
      const byteArray = new Uint8Array(byteNumbers)
      const file = new File([byteArray], name, { type: 'image/jpeg' })
      const dt = new DataTransfer()
      dt.items.add(file)
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    },
    fileInputSelector,
    base64,
    fileName
  )

  // アップロード完了・setUploadImage()コールバック発火を待つ。
  // 主条件: 隠しフィールド#FRONT_IMG_IDに画像ID(B+9桁)がセットされること
  //（docs/phase3-mvp-design.md 9章で確定済みの完了コールバック仕様に基づく）。
  // 副条件（フォールバック）: プレースホルダー画像のクラスが変化すること。
  const uploadConfirmed = await page
    .waitForFunction(
      () => {
        const hiddenField = document.getElementById('FRONT_IMG_ID') as HTMLInputElement | null
        if (hiddenField && hiddenField.value.trim() !== '') return true
        const img = document.getElementById('FRONT_IMG_ID_IMG') as HTMLImageElement | null
        return !!(img && !img.className.includes('img_new_no_photo'))
      },
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false)

  if (!uploadConfirmed) {
    log('警告: 画像アップロード完了の検知がタイムアウトしました。処理は続行しますが要確認です。')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * 反映申請がNG/未確認ワード等でブロックされていることを表すエラー。
 * style-post-runner.ts側でこれを捕捉した場合、通常の失敗(failed)ではなく
 * reflection_request_status='blocked' として区別して記録する。
 */
export class ReflectionBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReflectionBlockedError'
  }
}

// 掲載管理TOPページ上でブロック要因を示すキーワード。
// HANDOFF.md 4-3で確定済み: 「要確認」ステータスは通常運用でよくあるもので
// 反映申請をブロックしない。ブロックされるのは「NG」判定または「未確認」が
// 残っている場合のみ。→ 「未確認」は「要確認」の部分文字列ではないため、
// 以下の正規表現は「要確認」には誤反応しない(意図的)。
// ⚠️ ただし「NG」「未確認」が実際どのDOM要素・文言で表示されるかまでは
// 未確認のため、ページ全体のテキストからのキーワード検索という
// ベストエフォート実装のまま。確認でき次第、セレクタベースの確実な
// 判定に置き換えること。
const REFLECT_BLOCKER_PATTERNS: RegExp[] = [
  /NGワード/,
  /NG判定/,
  /「NG」/,
  /未確認/,
  /確認できません/,
  /掲載できません/,
  /差し戻/
]

/**
 * 掲載管理TOPページを開いた状態で、NG/未確認等のブロック要因が
 * 表示されていないかを確認する（docs/phase3-mvp-design.md 5-5 手順2）。
 * ⚠️ 実HTML未確認のため、ページ全体のテキストからキーワードを探す
 * ベストエフォート実装。誤検知/検知漏れの可能性がある。
 */
export async function checkReflectBlockers(page: Page): Promise<{ blocked: boolean; reason?: string }> {
  const bodyText = await page.evaluate(() => document.body.innerText || '')
  for (const pattern of REFLECT_BLOCKER_PATTERNS) {
    const match = bodyText.match(pattern)
    if (match) {
      const idx = match.index ?? 0
      const snippet = bodyText.slice(Math.max(0, idx - 20), idx + 40).replace(/\s+/g, ' ').trim()
      return { blocked: true, reason: snippet || match[0] }
    }
  }
  return { blocked: false }
}

/**
 * 掲載管理TOPから反映申請（公開）を行う。
 * サロン/スタイリスト/スタイル/メニュー/こだわりをまとめて反映する
 * 通常の反映申請ボタン（reflected()）のみを対象とする。
 * 特集・クーポンの反映申請（reflectedSpecial/reflectedCpn）は対象外。
 *
 * 実行前にcheckReflectBlockers()でNG/未確認要因を確認し、
 * 検知した場合はReflectionBlockedErrorをthrowして反映申請自体は行わない。
 */
export async function submitReflectApplication(page: Page, log: AutomationLogger): Promise<void> {
  log('掲載管理TOPへ遷移中...')
  await page.goto(`${SALONBOARD_BASE_URL}/CNB/reflect/reflectTop/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })

  // domcontentloadedはDOM解析完了時点で発火するため、反映申請ボタンが
  // JS側で描画されるまで少し待つ(実際の描画完了検知条件は未確認のため暫定)。
  await page
    .waitForSelector('[onclick*="reflected("]', { timeout: 15000 })
    .catch(() => {
      log('警告: 反映申請ボタンの検出がタイムアウトしました。処理は続行しますが要確認です。')
    })

  log('NG/未確認ワード等のブロック要因を確認中...')
  const blockCheck = await checkReflectBlockers(page)
  if (blockCheck.blocked) {
    throw new ReflectionBlockedError(
      `反映申請がブロックされている可能性があります: ${blockCheck.reason || '詳細不明'}`
    )
  }

  log('反映申請を実行中...')
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    page.evaluate(() => {
      // "reflected(" で始まる関数呼び出しのみにマッチさせ、
      // reflectedSpecial(/reflectedCpn( を誤って拾わないようにする
      const el = document.querySelector('[onclick*="reflected("]') as HTMLElement | null
      el?.click()
    })
  ])

  log('反映申請が完了しました（実際の公開まで約20分かかります）')
}

/**
 * 1枚のスタイル画像に対する「登録＋反映申請」の一連の処理。
 * 呼び出し側（route/scheduler）でexecution_logs等への記録を行う。
 */
export async function postStyleImageFull(
  page: Page,
  input: StylePostInput,
  log: AutomationLogger
): Promise<void> {
  await draftRegisterStyle(page, input, log)
  await submitReflectApplication(page, log)
}
