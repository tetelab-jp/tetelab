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
 * ボット対策(Akamai系)への対応を施した上でPageを新規作成する。
 *
 * ローカル調査（docs/salonboard-real-html-findings.md調査時のログ）で、
 * SALON BOARDはAkamai系のボット対策を導入しており、headlessブラウザ
 * (curl・デフォルト設定のheadless Chromium)からのアクセスは弾かれ、
 * 非headless(実ブラウザウィンドウ)では正常に動作したことが確認されている。
 * Cloudflare Browser Renderingは常にheadlessで動作するため、代わりに
 * 典型的なheadless検知ポイント(navigator.webdriver・User-Agent・
 * viewport等)を可能な範囲でごまかす。これでも弾かれる場合は、
 * さらに高度なフィンガープリンティング対策の追加検討が必要。
 */
export async function newAutomationPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage()

  // 代表的なheadless検知ポイントを可能な範囲で偽装する
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    // headless Chromeはnavigator.pluginsが空配列になりがちなので、それらしい値を入れる
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] })
    Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'] })
    // headless Chromeにはwindow.chromeオブジェクトが存在しないことが多い
    if (!(window as any).chrome) {
      ;(window as any).chrome = { runtime: {} }
    }
  })

  // デフォルトのheadless Chrome User-Agentではなく、通常のデスクトップChromeを名乗る
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  )

  // headless実行では省略されがちな一般的なデスクトップ解像度のviewportを明示的に設定
  await page.setViewport({ width: 1920, height: 1080 })

  return page
}

/**
 * salon_credentials.connection_status / last_error を実際のログイン試行結果で
 * 更新する。ダッシュボードの「サロンボード連携」表示が、ID/パスワードを
 * 保存しただけで実際には未検証の状態を「連携済み」と誤表示していた問題への
 * 対応(HANDOFF.md参照)。loginToSalonBoard()のログイン試行のたびに呼ばれる。
 */
async function recordConnectionStatus(
  env: Bindings,
  userId: number,
  status: 'success' | 'failed',
  errorMessage: string | null
): Promise<void> {
  await env.DB.prepare(
    `UPDATE salon_credentials SET connection_status = ?, last_error = ? WHERE user_id = ?`
  )
    .bind(status, errorMessage, userId)
    .run()
    .catch(() => {})
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
 *
 * env/userIdを渡すと、ログイン試行の成否をsalon_credentials.connection_status
 * に記録する(ダッシュボードの連携ステータス表示に使われる)。
 */
export async function loginToSalonBoard(
  page: Page,
  loginId: string,
  password: string,
  log: AutomationLogger,
  env?: Bindings,
  userId?: number
): Promise<void> {
  log('ログインページへ遷移中...')
  await page.goto(`${SALONBOARD_BASE_URL}/login/`, { waitUntil: 'domcontentloaded', timeout: 30000 })

  await page.waitForSelector('input[name="userId"]', { timeout: 15000 })
  await page.type('input[name="userId"]', loginId, { delay: 20 })
  await page.type('input[name="password"]', password, { delay: 20 })

  log('ログイン実行中...')
  // page.evaluate内でelement.click()するとevent.isTrusted=falseの合成イベントに
  // なり、ボット対策JSがこれを見て正規の処理をスキップしている可能性があるため、
  // Puppeteerネイティブのpage.click()(CDP経由の本物のマウスイベント、
  // isTrusted=true)を使う。
  const loginBtnHandle = await page.$('a.loginBtnSize, a[onclick*="dologin"]')
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    loginBtnHandle
      ? page.click('a.loginBtnSize, a[onclick*="dologin"]')
      : page.evaluate(() => {
          // フォールバック: ボタン要素が見つからない場合はフォームを直接submit
          const form = document.getElementById('idPasswordInputForm') as HTMLFormElement | null
          form?.submit()
        })
  ])

  // dologin()のPOST先は `/CNC/login/doLogin/` であり、このURL自体に
  // "/login/" という文字列を含む(findings.md 1章)。そのため単純な
  // URL部分一致では、正常にログインが通った直後でも誤って失敗判定に
  // なってしまう。また、doLogin到達後さらにもう一段階の遷移を経て
  // ダッシュボード画面がレンダリングされることがあるため、doLoginの
  // URLに留まっている場合は追加でナビゲーションを待つ。
  if (page.url().includes('/login/doLogin/')) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
  }

  // 成功判定はURLではなく、ログインフォームの入力欄が画面上に残って
  // いるかどうかで行う(サーバー側フォワード等でURLが/login/系のまま
  // 変わらないケースにも対応するため)。
  const stillOnLoginForm = await page.$('input[name="userId"]').catch(() => null)
  if (stillOnLoginForm) {
    // 原因切り分け用に、失敗時点の画面テキストを診断情報としてログとエラー両方に残す。
    // (実際のバリデーションエラー文言／Akamai等のボット対策ブロック画面／
    //  単に元のログイン画面が再描画されただけ、を判別するため)
    const currentUrl = page.url()
    const pageText = await page
      .evaluate(() => document.body?.innerText?.slice(0, 500) ?? '')
      .catch(() => '(画面テキスト取得失敗)')
    const cleanedText = pageText.replace(/\s+/g, ' ').trim()
    log(`ログイン失敗時のURL: ${currentUrl}`)
    log(`ログイン失敗時のページ冒頭: ${cleanedText}`)
    const errorMessage =
      `ログインに失敗しました（ID/パスワードが正しくない可能性、またはクリックがブロックされた可能性があります）` +
      ` [診断情報] url=${currentUrl} pageText="${cleanedText}"`
    if (env && userId) await recordConnectionStatus(env, userId, 'failed', errorMessage)
    throw new Error(errorMessage)
  }
  log('ログイン成功')
  if (env && userId) await recordConnectionStatus(env, userId, 'success', null)
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
 * ⚠️ 2026-08-09追記(訂正): 以前は「要確認」リンクの残数を主なブロック理由として
 * 扱っていたが、これは誤りだった。実機調査の結果、スタイル一覧の**全16件すべて**
 * (通常運用中のアカウント)に「要確認」リンクが恒常的に表示されており、
 * 「要確認」は通常運用でもごく普通に出る表示であって、反映申請をブロックする
 * ものではないことが判明した。**反映申請を実際にブロックするのは「NG」表示の
 * 場合のみ**（画面上部の固定注意書き「※ 掲載チェックに「NG」がある場合、または
 * 「未確認の掲載情報」がある場合、「反映申請」ボタンは押せません。」より）。
 *
 * ただし「NG」が実際にライブ表示された状態の実HTML構造(文言・クラス名・出現箇所)は
 * まだ実機で確認できていない。判明するまでの暫定措置として、この関数は
 * 「要確認」の存在を一切ブロック判定に使わず、参考情報としてログに出すのみとし、
 * 常に blocked: false を返す(過剰ブロックによる誤検知を避けるため)。
 * `#reflectedButton` の `--disabled` クラスについても、それが実際のNGによる
 * ものか「反映すべき変更が無いだけ」かを区別できないため、現時点ではブロック
 * 判定には使わない(参考ログとしてのみ出力)。
 *
 * TODO: 実機でNG表示のDOM構造を確認でき次第、そのNG検知を主判定条件として
 * 実装し直すこと。
 */
export async function checkReflectBlockers(page: Page): Promise<{ blocked: boolean; reason?: string }> {
  const result = await page.evaluate(() => {
    const btn = document.getElementById('reflectedButton')
    const disabled = btn ? btn.className.includes('--disabled') : null
    const needsCheckCount = Array.from(document.querySelectorAll('a')).filter(
      (a) => a.textContent?.trim() === '要確認'
    ).length
    return { buttonFound: !!btn, disabled, needsCheckCount }
  })

  if (result.needsCheckCount > 0) {
    console.log(
      `[参考] 「要確認」項目が${result.needsCheckCount}件表示されています` +
        `(通常運用でもよく見られる表示のため、ブロック要因としては扱いません)`
    )
  }
  if (result.buttonFound) {
    console.log(`[参考] #reflectedButtonのdisabled状態: ${result.disabled}`)
  }

  // 暫定実装: NG検知ロジックが未実装のため、常にblocked: falseとする。
  // 実際にサロンボード側でブロックされている場合は、この後のクリック処理や
  // サロンボード自体の挙動(クリックしても反映されない等)に委ねる。
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

  log('ブロック要因(NG表示等)を確認中...')
  const blockCheck = await checkReflectBlockers(page)
  if (blockCheck.blocked) {
    throw new ReflectionBlockedError(
      `反映申請がブロックされている可能性があります: ${blockCheck.reason || '詳細不明'}`
    )
  }

  log('反映申請を実行中...')
  // #reflectedButtonにはinline onclickが無く、別JSでaddEventListenerされている。
  // page.evaluate内のelement.click()はisTrusted=falseの合成イベントになり
  // ボット対策等で無視される可能性があるため、Puppeteerネイティブのpage.click()
  // (CDP経由の本物のマウスイベント、isTrusted=true)を使う。
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    page.click('#reflectedButton')
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
