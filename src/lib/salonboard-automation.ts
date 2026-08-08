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
 * フォームの見た目のactionはおとりで、実際は以下の<a>タグのonclickに紐づく
 * JS関数 dologin(event) 経由で /CNC/login/doLogin/ にPOSTされる:
 *   <a href="javascript:void(0);" class="common-CNCcommon__primaryBtn loginBtnSize"
 *      onclick="dologin(event); return false;">ログイン</a>
 * (docs/salonboard-real-html-findings.md 1章で実機確認済み)
 *
 * dologin()はevent引数を取るため、window.dologin()をJS関数として直接
 * 引数無しで呼び出すと内部でevent参照時にエラーになる可能性がある。
 * そのため実際の<a>要素をelement.click()して本物のクリックイベントを
 * 発火させる方式にしている。
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
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    page.evaluate(() => {
      const loginBtn = document.querySelector('a.loginBtnSize, a[onclick*="dologin"]') as HTMLElement | null
      if (loginBtn) {
        loginBtn.click()
      } else {
        // フォールバック: ボタン要素が見つからない場合はフォームを直接submit
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
  // ⚠️ 「新規作成」ボタンの実onclick HTML(要素セレクタ)は未確認。
  // login/editStyleの実測結果から、このサイトのボタンは軒並みevent引数を
  // 取る規約と推測されるため、window.addStyle()を直接呼ぶ際も念のため
  // 簡易的なEventオブジェクトを渡す(element.click()できるセレクタが
  // 判明次第、login/editStyleと同様の方式に置き換えること)。
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    page.evaluate(() => {
      // @ts-ignore
      if (typeof (window as any).addStyle === 'function') {
        const fakeEvent = { preventDefault: () => {}, stopPropagation: () => {}, target: null, currentTarget: null }
        // @ts-ignore
        ;(window as any).addStyle(fakeEvent)
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

/**
 * 掲載管理TOPページを開いた状態で、反映申請がブロックされていないかを確認する
 * （docs/phase3-mvp-design.md 5-5 手順2）。
 *
 * docs/salonboard-real-html-findings.md（2026-08-09、Playwrightで実アカウントを
 * 調査した確定結果）に基づく実装:
 * - 反映申請ボタンは `<button type="button" id="reflectedButton" class="...
 *   common-CNBcommon__primaryBtn--disabled ...">`。**inline onclick属性は無い**
 *   （別JSファイルでid起点にaddEventListenerされている）。
 * - 画面上部の固定注意書きに「NG」「未確認」という文言が**常に**含まれているため、
 *   ページ本文のテキストをキーワード検索する方式（旧実装）は必ずこの注意書きに
 *   ヒットして誤検知(false positive)する。**この方式は使わない。**
 * - 実際にブロックされている時にライブで表示されるのは「要確認」という赤字リンク
 *   （サロン/スタイリスト/スタイル掲載情報の各項目に対して表示され、クリックで
 *   `showErrorPopup(storeId, styleId)` が呼ばれる）。「要確認」が残っている状態で
 *   `#reflectedButton` に `--disabled` 修飾クラスが付与されることを実機で確認済み。
 * - そのため、`#reflectedButton` の disabled状態を主判定条件とし、「要確認」リンクの
 *   有無を理由(reason)の補足情報として使う。
 *
 * ⚠️ 残る不確実性: `--disabled`は「要確認が残っている」以外に「新たに反映すべき
 * 変更が無い」場合にも付与される可能性がある（特集/クーポン用ボタンで観測）。
 * ただしこの関数は「直前にdraftRegisterStyle()でスタイルを新規登録した直後」
 * にのみ呼ばれる想定のため、その時点で#reflectedButtonが無効化されていれば
 * 「変更なし」ではなく実際のブロック要因である可能性が高いと判断する。
 */
export async function checkReflectBlockers(page: Page): Promise<{ blocked: boolean; reason?: string }> {
  const result = await page.evaluate(() => {
    const btn = document.getElementById('reflectedButton')
    if (!btn) return { buttonFound: false, disabled: false, needsCheckCount: 0 }

    const disabled = btn.className.includes('--disabled')
    const needsCheckLinks = Array.from(document.querySelectorAll('a')).filter(
      (a) => a.textContent?.trim() === '要確認'
    )
    return { buttonFound: true, disabled, needsCheckCount: needsCheckLinks.length }
  })

  if (!result.buttonFound) {
    // ボタン自体が見つからない = ページ構造が想定と異なる可能性が高いが、
    // ここでブロック扱いにはせず、後続のクリック処理側でエラーにする。
    return { blocked: false }
  }

  if (result.disabled) {
    const reason =
      result.needsCheckCount > 0
        ? `「要確認」項目が${result.needsCheckCount}件残っています`
        : '反映申請ボタンが無効化されています(要確認以外の要因の可能性あり)'
    return { blocked: true, reason }
  }

  return { blocked: false }
}

/**
 * 掲載管理TOPから反映申請（公開）を行う。
 * サロン/スタイリスト/スタイル/メニュー/こだわりをまとめて反映する
 * 通常の反映申請ボタン（`#reflectedButton`）のみを対象とする。
 * 特集・クーポンの反映申請ボタン（`#reflectedButtonSpecial`/`#reflectedButtonCpn`）は対象外。
 *
 * 実行前にcheckReflectBlockers()でブロック要因を確認し、
 * 検知した場合はReflectionBlockedErrorをthrowして反映申請自体は行わない。
 */
export async function submitReflectApplication(page: Page, log: AutomationLogger): Promise<void> {
  log('掲載管理TOPへ遷移中...')
  await page.goto(`${SALONBOARD_BASE_URL}/CNB/reflect/reflectTop/`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  })

  await page.waitForSelector('#reflectedButton', { timeout: 15000 }).catch(() => {
    log('警告: 反映申請ボタン(#reflectedButton)の検出に失敗しました。ページ構造の再確認が必要です。')
  })

  log('ブロック要因(要確認項目の残り等)を確認中...')
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
      // #reflectedButtonにはinline onclickが無く、別JSでaddEventListenerされている
      // ため、element.click()で本物のクリックイベントを発火させる
      // (window上の関数を直接呼ぶ方式ではハンドラに届かない)。
      const btn = document.getElementById('reflectedButton') as HTMLButtonElement | null
      btn?.click()
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
