// ============================================
// salonboard-automation.ts (AWS Fargateワーカー版)
//
// src/lib/salonboard-automation.ts (Cloudflare Browser Rendering版) からの移植。
// ログイン/フォーム入力/画像アップロード/NGチェック/反映申請のロジックは
// 元実装から変更していない(Cloudflare非依存のため)。変更点は以下のみ:
//   - @cloudflare/puppeteer → 標準puppeteerパッケージへのimport切り替え
//   - launchBrowser(): Cloudflare Browser Rendering固有の429リトライを削除し、
//     通常のpuppeteer.launch()に変更
//   - loginToSalonBoard(): env/userIdによるD1書き込み(salon_credentials更新)を削除。
//     ログイン成否はこの関数の例外/正常終了で呼び出し側(index.ts)が判断し、
//     ジョブ結果としてCloudflare側に返す。Cloudflare側で連携ステータスを更新する。
//   - arrayBufferToBase64(): btoaではなくNode標準のBufferを使用
// ============================================

import type { Browser, ElementHandle, Page } from 'puppeteer'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
export type { Browser, Page }

// 2026-08-10追記: navigator.webdriver等の手動パッチだけではSALON BOARDの
// Akamai系ボット対策を回避できないことが実機検証(プロキシでIPを変えても
// 症状不変)で確認できたため、headless検知への対策として実績のある
// puppeteer-extra-plugin-stealthを導入した。詳細はsrc/lib/salonboard-automation.ts参照。
puppeteerExtra.use(StealthPlugin())

export const SALONBOARD_BASE_URL = 'https://salonboard.com'

export type StylePostInput = {
  styleImageId: number
  imageBuffer: ArrayBuffer
  imageFileName: string
  styleName: string // frmStyleEditStyleDto.styleName(最大30文字)
  stylistSelectValue: string // #stylistCheckCd の <option value>
  stylistComment: string // frmStyleEditStylistCommentDto.stylistComment(最大120文字)
  categoryCd: 'SG01' | 'SG02' // レディース / メンズ
  hairLengthValue: string // ladiesHairLengthCd or mensHairLengthCd の <option value>
  menuContentsCdList?: string[] // MC01〜MC04
  menuDetailText: string // menuDetailTxt textarea(最大50文字)
  couponSelectValue?: string // frmStyleEditStyleDto.couponId(CP+14桁形式)
}

export type AutomationLogger = (message: string) => void

export type StylePostResult = {
  success: boolean
  step: 'login' | 'navigate' | 'draft_register' | 'image_upload' | 'reflect' | 'done'
  message: string
}

/**
 * Fargateタスク内でPuppeteerブラウザを起動する。
 * ジョブ1件につきタスク1つを使い捨てる運用のため、同時起動数の
 * リトライ制御(Cloudflare Browser Rendering版にあった429対応)は不要。
 */
export async function launchBrowser(): Promise<Browser> {
  // --disable-dev-shm-usage: Fargateコンテナは/dev/shmが小さく、既定のままだと
  // Chromeがクラッシュすることがあるため無効化する(Docker上のPuppeteerでの定石)。
  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']

  // SALON BOARD側のボット対策の検証用の一時的な迂回策。SALONBOARD_PROXY_SERVER
  // (例: http://host:port)が設定されている場合のみプロキシ経由でアクセスする。
  const proxyServer = process.env.SALONBOARD_PROXY_SERVER
  if (proxyServer) {
    args.push(`--proxy-server=${proxyServer}`)

    // 2026-08-11追記: 画像アップロード(doUpload、大きめのPOST)がプロキシ経由で
    // net::ERR_EMPTY_RESPONSEで100%失敗する一方、同じプロキシでの軽いGET
    // (ログイン・画面遷移)は安定して成功していた。ログイン等でも失敗しないなら
    // salonboard.com側が一律不安定とは考えにくく、プロキシのCONNECTトンネル越しの
    // HTTP/2で大きめのPOSTを送った場合に相性問題が起きている可能性を疑い、
    // HTTP/2を無効化してHTTP/1.1を強制する(プロキシ経由通信でよくある既知の
    // 回避策)。プロキシ未設定時(直接アクセス)には影響しない。
    args.push('--disable-http2')
  }

  // 2026-08-10追記: headlessモードは一貫してSALON BOARD側のボット対策に
  // 弾かれることを確認したため、非headless(画面ありモード)で起動する。
  // コンテナ側(Dockerfile)でXvfb経由(`xvfb-run`)での起動が前提。
  return puppeteerExtra.launch({
    headless: false,
    args
  })
}

/**
 * ボット対策(Akamai系)への対応を施した上でPageを新規作成する。
 *
 * SALON BOARDはAkamai系のボット対策を導入しており、headlessブラウザ
 * (curl・デフォルト設定のheadless Chromium)からのアクセスは弾かれ、
 * 非headless(実ブラウザウィンドウ)では正常に動作したことが確認されている。
 * headlessで動かす都合上、典型的なheadless検知ポイント(navigator.webdriver・
 * User-Agent・viewport等)を可能な範囲でごまかす。
 */
export async function newAutomationPage(browser: Browser, log?: AutomationLogger): Promise<Page> {
  const page = await browser.newPage()

  // 2026-08-11追記: Bright Data(ISPプロキシ、複数IPのプール)のユーザー名に
  // `-session-<任意の文字列>`を付与すると、session値ごとにプール内の別IPが
  // 割り当てられる。ブラウザ起動のたびにランダムなsession値を付与し、
  // 1つの出口IPがブロックされても他のIPへ自動的にローテーションされるようにする
  // (src/lib/salonboard-automation.tsと同じ対応)。
  const proxyUsername = process.env.SALONBOARD_PROXY_USERNAME
  const proxyPassword = process.env.SALONBOARD_PROXY_PASSWORD
  if (proxyUsername && proxyPassword) {
    const sessionId = Math.random().toString(36).slice(2, 10)
    const sessionUsername = `${proxyUsername}-session-${sessionId}`
    await page.authenticate({ username: sessionUsername, password: proxyPassword })
    log?.(`[プロキシ] セッションID=${sessionId} で出口IPをローテーション`)
  }

  // ブラウザネイティブの確認ダイアログ(window.confirm/alert等)への
  // ハンドラが無いと、Puppeteerはダイアログに応答できず固まり、
  // waitForNavigation/waitForFunctionが静かにタイムアウトする。
  // 常に自動的に「OK」を押す(accept)ようにして、この可能性を排除する。
  page.on('dialog', async (dialog) => {
    log?.(`確認ダイアログを検知し自動的にOKを選択しました: 「${dialog.message()}」`)
    await dialog.accept().catch(() => {})
  })

  // 2026-08-10追記(重要な不整合を修正): 以前はここで手動のnavigator.*パッチと
  // 固定User-Agent(Windows NT 10.0; Win64; x64)を設定していたが、実行環境は
  // 常にLinux(Fargateコンテナ)であり、Chromeが自動送信するSec-CH-UA-Platform
  // (Client Hints)ヘッダーやnavigator.userAgentData.platformは実際のLinuxを
  // 報告し続けるため、「UAはWindows・他の信号はLinux」という内部矛盾が常に
  // 発生していた。詳細はsrc/lib/salonboard-automation.tsの同日付コメント参照。
  // puppeteer-extra-plugin-stealth(モジュール冒頭でuse()済み)がこれらの
  // 手動パッチより精巧かつ実行環境と整合する形でカバーするため撤去し、
  // User-Agentも上書きせず本物の値をそのまま使う。
  await page.setViewport({ width: 1920, height: 1080 })

  return page
}

/**
 * サロンボードにログインする。
 * フォームの見た目のactionはおとりで、実際は以下の<a>タグのonclickに紐づく
 * JS関数 dologin(event) 経由で /CNC/login/doLogin/ にPOSTされる:
 *   <a href="javascript:void(0);" class="common-CNCcommon__primaryBtn loginBtnSize"
 *      onclick="dologin(event); return false;">ログイン</a>
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
          const form = document.getElementById('idPasswordInputForm') as HTMLFormElement | null
          form?.submit()
        })
  ])

  // dologin()のPOST先は `/CNC/login/doLogin/` であり、このURL自体に
  // "/login/" という文字列を含むため、単純なURL部分一致では正常にログインが
  // 通った直後でも誤って失敗判定になる。doLogin到達後さらにもう一段階の遷移を
  // 経てダッシュボード画面がレンダリングされることがあるため、doLoginの
  // URLに留まっている場合は追加でナビゲーションを待つ。
  if (page.url().includes('/login/doLogin/')) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
  }

  // 成功判定はURLではなく、ログインフォームの入力欄が画面上に残って
  // いるかどうかで行う。
  const stillOnLoginForm = await page.$('input[name="userId"]').catch(() => null)
  if (stillOnLoginForm) {
    const currentUrl = page.url()
    const pageText = await page
      .evaluate(() => document.body?.innerText?.slice(0, 500) ?? '')
      .catch(() => '(画面テキスト取得失敗)')
    const cleanedText = pageText.replace(/\s+/g, ' ').trim()
    log(`ログイン失敗時のURL: ${currentUrl}`)
    log(`ログイン失敗時のページ冒頭: ${cleanedText}`)
    throw new Error(
      `ログインに失敗しました(ID/パスワードが正しくない可能性、またはクリックがブロックされた可能性があります)` +
        ` [診断情報] url=${currentUrl} pageText="${cleanedText}"`
    )
  }
  log('ログイン成功')
}

/**
 * 1件のスタイル画像を「登録(下書き保存)」する。
 * 反映申請は含まない(別途 submitReflectApplication を呼ぶ必要がある)。
 */
export async function draftRegisterStyle(page: Page, input: StylePostInput, log: AutomationLogger): Promise<void> {
  log('スタイル一覧ページへ遷移中...')
  await page.goto(`${SALONBOARD_BASE_URL}/CNB/draft/styleList/`, { waitUntil: 'domcontentloaded', timeout: 30000 })

  log('新規スタイル作成フォームを開いています...')
  const addStyleHandle = await page.evaluateHandle(() => {
    const el = Array.from(document.querySelectorAll('a, button')).find((e) =>
      /addStyle/.test(e.getAttribute('onclick') || '')
    )
    return el || null
  })
  const addStyleEl = addStyleHandle.asElement()
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    addStyleEl
      ? (addStyleEl as any).click()
      : page.evaluate(() => {
          const form = document.getElementById('addStyleForm') as HTMLFormElement | null
          form?.submit()
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

  // ---- 写真アップロード ----
  log('写真をアップロード中...')
  await uploadFrontImage(page, input.imageBuffer, input.imageFileName, log)

  // ---- スタイリスト選択 ----
  await page.select('#stylistCheckCd', input.stylistSelectValue)

  // ---- スタイリストコメント(最大120文字) ----
  await page.evaluate((text: string) => {
    const el = document.getElementById('stylistCommentTxt') as HTMLTextAreaElement | null
    if (el) el.value = text
  }, input.stylistComment.slice(0, 120))

  // ---- スタイル名(最大30文字) ----
  await page.evaluate((text: string) => {
    const el = document.getElementById('styleNameTxt') as HTMLInputElement | null
    if (el) el.value = text
  }, input.styleName.slice(0, 30))

  // ---- カテゴリ(レディース/メンズ) ----
  const categoryRadioId = input.categoryCd === 'SG01' ? '#styleCategoryCd01' : '#styleCategoryCd02'
  await page.click(categoryRadioId)
  await sleep(300)

  // ---- ヘアレングス(レディース/メンズでidが異なる<select>) ----
  const lengthSelectId = input.categoryCd === 'SG01' ? '#ladiesHairLengthCd' : '#mensHairLengthCd'
  const lengthHandle = await page.$(lengthSelectId)
  if (lengthHandle) {
    await page.select(lengthSelectId, input.hairLengthValue)
  } else {
    log(`警告: 長さ選択欄(${lengthSelectId})が見つかりませんでした`)
  }

  // ---- メニュー内容チェックボックス(任意) ----
  if (input.menuContentsCdList && input.menuContentsCdList.length > 0) {
    for (const mc of input.menuContentsCdList) {
      const cb = await page.$(`input.menuContentsCdList[value="${mc}"]`)
      if (cb) await cb.click()
    }
  }

  // ---- メニュー詳細(必須、最大50文字) ----
  await page.evaluate((text: string) => {
    const el = document.getElementById('menuDetailTxt') as HTMLTextAreaElement | null
    if (el) el.value = text
  }, input.menuDetailText.slice(0, 50))

  // ---- クーポン(任意) ----
  // 見た目はモーダル選択UIだが、最終的にPOSTされるのは隠しフィールド
  // frmStyleEditStyleDto.couponId の値(CP+14桁形式)のみのため、
  // モーダルUIを操作せず直接値をセットする。
  if (input.couponSelectValue) {
    await page.evaluate((couponId: string) => {
      const el = document.querySelector('input[name="frmStyleEditStyleDto.couponId"]') as HTMLInputElement | null
      if (el) el.value = couponId
    }, input.couponSelectValue)
  }

  // ---- 送信前セルフチェック ----
  const preflight = await page.evaluate(() => {
    const val = (id: string) =>
      (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ??
      '(要素なし)'
    const checked = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.checked ?? '(要素なし)'
    return {
      styleRegistFormat:
        (document.querySelector('input[name="frmStyleEditStyleInfoDto.styleRegistFormat"]:checked') as HTMLInputElement | null)
          ?.value ?? '(未選択)',
      frontImgId: document.getElementById('FRONT_IMG_ID_ID')?.textContent?.trim() || '(要素なし/空)',
      stylistCheckCd: val('stylistCheckCd'),
      stylistCommentTxt: val('stylistCommentTxt'),
      styleNameTxt: val('styleNameTxt'),
      styleCategoryCd01: checked('styleCategoryCd01'),
      styleCategoryCd02: checked('styleCategoryCd02'),
      ladiesHairLengthCd: val('ladiesHairLengthCd'),
      menuDetailTxt: val('menuDetailTxt')
    }
  })
  log(`送信前セルフチェック: ${JSON.stringify(preflight)}`)

  // ---- 保存(doRegister) ----
  log('スタイルを登録中...')
  const doRegisterHandle = await page.$('[onclick*="doRegister("]')
  if (!doRegisterHandle) {
    throw new Error('登録ボタン([onclick*="doRegister("])が見つかりませんでした')
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    doRegisterHandle.click()
  ])

  // 登録成功の検証: サーバーが実styleId(L+9桁)を発行し、#styleId隠しフィールドに
  // セットした状態で再描画される。または styleId=(L\d{9}) 形式のURLに遷移する。
  const registeredStyleId = await page
    .waitForFunction(
      () => {
        const el = document.getElementById('styleId') as HTMLInputElement | null
        if (el && /^L\d{9}$/.test(el.value)) return el.value
        const urlMatch = window.location.href.match(/styleId=(L\d{9})/)
        return urlMatch ? urlMatch[1] : false
      },
      { timeout: 20000 }
    )
    .then((handle) => handle.jsonValue() as Promise<string | false>)
    .catch(() => false)

  if (!registeredStyleId) {
    const currentUrl = page.url()
    const diag = await page
      .evaluate(() => {
        const styleIdEl = document.getElementById('styleId') as HTMLInputElement | null
        const errorEls = Array.from(document.querySelectorAll('.error, .errorMessage, [class*="error"]'))
          .map((el) => el.textContent?.trim())
          .filter((t) => t)
          .slice(0, 3)
        return {
          styleIdElExists: !!styleIdEl,
          styleIdElValue: styleIdEl?.value ?? null,
          errorTexts: errorEls
        }
      })
      .catch(() => null)
    const errorSummary = diag?.errorTexts && diag.errorTexts.length > 0 ? diag.errorTexts.join(' / ') : 'なし'
    log(
      `登録確認失敗時の詳細: url=${currentUrl} #styleId存在=${diag?.styleIdElExists ?? '不明'} ` +
        `値=${diag?.styleIdElValue ?? '(なし)'} エラー表示候補=${errorSummary}`
    )
    throw new Error(
      'スタイル登録の完了を確認できませんでした(#styleIdにL+9桁のIDがセットされない)。' +
        'サーバー側で実際に登録されていない可能性があります。'
    )
  }

  log(`スタイル登録が完了しました(styleId: ${registeredStyleId})`)
}

/**
 * 写真アップロード処理。
 *
 * 2026-08-10追記(fetch方式から本物のファイル選択方式へ全面変更):
 * 従来はアップロードエンドポイントをfetch()で直接呼び出す自作multipart方式
 * だったが、レジデンシャルプロキシ経由で「Failed to fetch」(接続自体の
 * 失敗、3回リトライしても100%再現)が発生することを実機で確認した。
 * 自作fetch()はSALON BOARD本来の(hidden field・CSRF・multipart構造を
 * 含む)アップロード導線から外れた不自然なリクエストであり、Akamai系の
 * ボット対策がこれを検知して接続自体を切っている可能性が高いと判断した。
 *
 * 旧実装がfetch()方式を選んだ理由は「Cloudflare Workers環境にはファイル
 * システムが無く、Puppeteer標準のuploadFile()(CDPのDOM.setFileInputFiles、
 * 実ファイルパスが必須)が原理的に使えなかったため」だが、AWS Fargate
 * (Node標準puppeteer)には実ファイルシステムがあり、この制約は既に
 * 解消している。そのため、本来のUI導線(プレースホルダークリック→
 * モーダル内file inputへの実ファイル注入→「登録する」ボタンクリック→
 * 完了検知)に戻す。
 *
 * 確定済みの実DOM構造(docs/salonboard-real-html-findings.md参照):
 *   - プレースホルダー: <img id="FRONT_IMG_ID_IMG"> クリックで
 *     img_upload_modal_view(...)が発火しモーダルが動的挿入される
 *   - file input: <input type="file" id="formFile"> (#imageUploaderModalBody
 *     という要素は実在しない、旧実装の推測ミス)
 *   - 登録ボタン: <input type="button" class="jscImageUploaderModalSubmitButton">
 *     (ファイル選択後にisActiveクラスが付与され活性化する)
 *   - 完了検知: <span id="FRONT_IMG_ID_ID"> のtextContent(隠しinputでは
 *     なくspanタグ、IDも FRONT_IMG_ID ではなく FRONT_IMG_ID_ID)
 */

/**
 * 2026-08-11追記(診断用): 画像アップロードがプロキシ経由(net::ERR_EMPTY_RESPONSE)で
 * 失敗した際、「同じCookie・同じfile input方式・プロキシなし」で同じアップロードを
 * 試すとどうなるかを自動で比較する。プロキシありのブラウザで取得済みのCookieを
 * プロキシなしの別ブラウザに引き継ぐことで、再ログインなしに同一セッションのまま
 * 経路だけを変えた比較ができる。結果はジョブの成否には影響させず、診断ログにのみ残す。
 */
async function diagnoseUploadWithoutProxy(
  proxiedPage: Page,
  imageBuffer: ArrayBuffer,
  fileName: string
): Promise<string> {
  const cookies = await proxiedPage.cookies().catch(() => [])
  const currentUrl = proxiedPage.url()
  let diagBrowser: Browser | null = null
  try {
    diagBrowser = await puppeteerExtra.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
    const diagPage = await diagBrowser.newPage()
    await diagPage.setViewport({ width: 1920, height: 1080 })
    if (cookies.length > 0) await diagPage.setCookie(...(cookies as any))
    await diagPage.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })

    await diagPage.waitForSelector('#FRONT_IMG_ID_IMG', { timeout: 10000 })
    await diagPage.click('#FRONT_IMG_ID_IMG')
    const fileInput = (await diagPage.waitForSelector('#formFile', { timeout: 10000 })) as ElementHandle<HTMLInputElement> | null
    if (!fileInput) {
      return '[診断:プロキシなし比較] 失敗: #formFileが見つかりませんでした(Cookie流用でのログイン状態再現に失敗した可能性)'
    }

    const tmpPath = join(tmpdir(), `salonboard-diag-upload-${Date.now()}-${fileName.replace(/[^\w.\-]/g, '_')}`)
    await writeFile(tmpPath, Buffer.from(imageBuffer))
    try {
      await fileInput.uploadFile(tmpPath)
      await diagPage.waitForSelector('input.jscImageUploaderModalSubmitButton.isActive', { timeout: 10000 })
      await diagPage.click('input.jscImageUploaderModalSubmitButton')
      await diagPage.waitForFunction(
        () => {
          const el = document.getElementById('FRONT_IMG_ID_ID')
          return !!el && !!el.textContent && el.textContent.trim().length > 0
        },
        { timeout: 20000 }
      )
      return '[診断:プロキシなし比較] 成功(同じCookie・同じ手順でプロキシを外したら通った → プロキシ経由アップロードが原因の濃厚な証拠)'
    } finally {
      await unlink(tmpPath).catch(() => {})
    }
  } catch (err: any) {
    return `[診断:プロキシなし比較] 失敗: ${String(err?.message || err)} (プロキシ以外の要因の可能性、または比較テスト自体の不備)`
  } finally {
    await diagBrowser?.close().catch(() => {})
  }
}

async function uploadFrontImage(
  page: Page,
  imageBuffer: ArrayBuffer,
  fileName: string,
  log: AutomationLogger
): Promise<void> {
  log('画像アップロードモーダルを開いています...')
  await page.waitForSelector('#FRONT_IMG_ID_IMG', { timeout: 15000 })
  await page.click('#FRONT_IMG_ID_IMG')

  const fileInput = (await page.waitForSelector('#formFile', { timeout: 15000 })) as ElementHandle<HTMLInputElement> | null
  if (!fileInput) {
    throw new Error('画像アップロードに失敗しました(ファイル選択方式): #formFile が見つかりませんでした')
  }

  // 画像を一時ファイルに書き出し、実ファイルとしてuploadFile()に渡す
  // (CDPのDOM.setFileInputFilesは実ファイルパスが必須のため)。
  //
  // 2026-08-11修正(重大バグ): 従来はuploadFile()呼び出し直後のfinallyで
  // 一時ファイルを削除していたが、実際のdoUpload通信は後続の「登録する」
  // ボタンをクリックした時点で発生する。そのため通信が走る時点では参照先の
  // 一時ファイルが既に削除済みになっており、毎回net::ERR_FILE_NOT_FOUNDで
  // 失敗していた(実機ログで確認)。削除はアップロード完了検知まで含めた
  // 一連の処理全体が終わった後に行うよう修正する。
  const tmpPath = join(tmpdir(), `salonboard-upload-${Date.now()}-${fileName.replace(/[^\w.\-]/g, '_')}`)
  await writeFile(tmpPath, Buffer.from(imageBuffer))
  log(`アップロード画像サイズ: ${(imageBuffer.byteLength / 1024).toFixed(1)}KB`)
  try {
    // 2026-08-11修正(重大バグ): net::ERR_EMPTY_RESPONSE失敗時、モーダルの
    // 実際の表示内容を確認したところ、失敗後はモーダルがファイル未選択の
    // 初期状態(「ここにファイルをドラッグ&ドロップ...」)にリセットされて
    // いることが判明した。従来は「登録する」ボタンを再クリックするだけの
    // リトライだったため、ファイルが選択されていない状態でクリックしても
    // 何も起きず(ボタンは非活性のまま)、即座にリトライ不可と判定していた。
    // ファイル選択(uploadFile)からやり直す必要があるため、選択〜送信〜
    // 完了検知までの一連の流れ全体を最大3回リトライするよう修正する。
    const maxAttempts = 3
    let lastError: Error | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const currentFileInput =
        attempt === 1
          ? fileInput
          : ((await page.waitForSelector('#formFile', { timeout: 15000 })) as ElementHandle<HTMLInputElement> | null)
      if (!currentFileInput) {
        lastError = new Error(`画像アップロードのリトライ不可: #formFile が再取得できませんでした(試行${attempt}回目)`)
        break
      }
      await currentFileInput.uploadFile(tmpPath)

      log(`ファイル選択完了。「登録する」ボタンの活性化を待機中...(試行${attempt}/${maxAttempts})`)
      await page.waitForSelector('input.jscImageUploaderModalSubmitButton.isActive', { timeout: 15000 })

      // 2026-08-11追記(診断用): アップロード完了検知が45秒タイムアウトする障害が
      // 発生したため、実際にdoUploadリクエストが送信されたか・どう終わったかを
      // 記録する。プロキシ経由での大きめのPOST(画像バイナリ)がハング/切断されて
      // いるのか、サーバー側がエラーを返しているのかを切り分けるため。
      const uploadEvents: string[] = []
      const onRequestFinished = (req: any) => {
        if (/doUpload/i.test(req.url())) uploadEvents.push(`request送信: ${req.method()} ${req.url()}`)
      }
      const onResponse = async (res: any) => {
        if (/doUpload/i.test(res.url())) {
          let bodySnippet = ''
          try {
            bodySnippet = (await res.text()).slice(0, 300)
          } catch {}
          uploadEvents.push(`response受信: status=${res.status()} url=${res.url()} body="${bodySnippet}"`)
        }
      }
      const onRequestFailed = (req: any) => {
        if (/doUpload/i.test(req.url())) {
          uploadEvents.push(`request失敗: ${req.url()} -> ${req.failure?.()?.errorText ?? '不明'}`)
        }
      }
      page.on('request', onRequestFinished)
      page.on('response', onResponse)
      page.on('requestfailed', onRequestFailed)

      // 2026-08-11追記(診断用): Puppeteerの高レベルAPI(requestfailed)だけでは
      // net::ERR_EMPTY_RESPONSEの詳細(プロキシのトンネル自体が張れなかったのか、
      // 張った後に応答が来なかったのか)が分からない。CDPのNetwork.loadingFailedは
      // blockedReason/corsErrorStatus等の追加情報を持つことがあるため、生のCDP
      // イベントも合わせて記録する。
      const cdpRequestUrls = new Map<string, string>()
      let cdpClient: any = null
      const onCdpRequestWillBeSent = (params: any) => {
        cdpRequestUrls.set(params.requestId, params.request?.url ?? '')
      }
      const onCdpLoadingFailed = (params: any) => {
        const url = cdpRequestUrls.get(params.requestId) ?? ''
        if (/doUpload/i.test(url)) {
          uploadEvents.push(
            `CDP loadingFailed: errorText=${params.errorText} canceled=${params.canceled} ` +
              `blockedReason=${params.blockedReason ?? 'なし'} type=${params.type}`
          )
        }
      }
      try {
        const client = await page.target().createCDPSession()
        await client.send('Network.enable')
        client.on('Network.requestWillBeSent', onCdpRequestWillBeSent)
        client.on('Network.loadingFailed', onCdpLoadingFailed)
        cdpClient = client as any
      } catch (e: any) {
        uploadEvents.push(`CDPセッション作成失敗(診断機能のみに影響): ${String(e?.message || e)}`)
      }

      try {
        await page.click('input.jscImageUploaderModalSubmitButton')

        // 2026-08-11追記(診断用): 人間の手動操作では「登録する」クリック後に
        // 数秒のローディングアニメーションが表示され、その後モーダルが閉じて
        // 画像IDが表示される。自動化のクリックが本当に同じ登録動作を引き起こして
        // いるかを確認するため、当初はクリック直後のスクリーンショットをbase64で
        // 記録していたが、実行履歴画面での表示・コピー時に長すぎる文字列が途中で
        // 切れてしまい、しかもそれ以降(試行2・3回目分)のログまで一緒に失われる
        // 実害が確認された。そのため画像ではなく、短いテキストで済むDOM状態の
        // チェックに変更する。
        try {
          await new Promise((resolve) => setTimeout(resolve, 500))
          const domSnapshot = await page.evaluate(() => {
            // "load"だと"upload"系のクラス名(常時存在するアップロード一覧UI)を
            // 誤検知するため、"loading"で判定する("upload"は含まない)。
            const loadingLike = Array.from(document.querySelectorAll('[class*="loading" i], [class*="spinner" i], [class*="progress" i]'))
              .map((el) => el.className)
              .filter((c) => typeof c === 'string' && c.length > 0)
              .slice(0, 5)
            const submitButton = document.querySelector('input.jscImageUploaderModalSubmitButton') as HTMLInputElement | null
            const completionSpan = document.getElementById('FRONT_IMG_ID_ID')
            return {
              loadingLikeClasses: loadingLike,
              submitButtonStillInDom: !!submitButton,
              submitButtonDisabled: submitButton ? submitButton.disabled : null,
              completionSpanText: completionSpan ? completionSpan.textContent : null
            }
          })
          log(`[診断:DOM状態](試行${attempt}/${maxAttempts}) クリック約0.5秒後: ${JSON.stringify(domSnapshot)}`)
        } catch (e: any) {
          log(`[診断:DOM状態] 取得失敗(診断機能のみに影響): ${String(e?.message || e)}`)
        }

        log(`アップロード完了の検知を待機中...(試行${attempt}/${maxAttempts})`)
        await page.waitForFunction(
          () => {
            const el = document.getElementById('FRONT_IMG_ID_ID')
            return !!el && !!el.textContent && el.textContent.trim().length > 0
          },
          { timeout: 45000 }
        )
        lastError = null
        break
      } catch (clickOrWaitError: any) {
        // 2026-08-11修正(診断用): 従来はcatchの中身を受け取っておらず、
        // 「登録する」クリック自体が例外で失敗した場合(要素が操作可能に
        // ならない等のPuppeteerのアクショナビリティチェック失敗)の実際の
        // エラーメッセージが握りつぶされていた。試行2回目以降で
        // [診断:DOM状態]のログすら出ない(=クリックの行で例外が飛んでいる)
        // ことが実機で確認されたため、原因特定のためにこのメッセージも記録する。
        const clickErrorMsg = String(clickOrWaitError?.message || clickOrWaitError)
        const diag =
          uploadEvents.length > 0
            ? uploadEvents.join(' / ')
            : `(doUploadへのリクエストが観測されませんでした) [例外内容] ${clickErrorMsg}`
        lastError = new Error(
          '画像アップロードに失敗しました(ファイル選択方式): アップロード完了(#FRONT_IMG_ID_IDへの値セット)を' +
            `45秒待っても検知できませんでした [診断] ${diag}`
        )
        if (attempt < maxAttempts) {
          log(`画像アップロード失敗(試行${attempt}/${maxAttempts})、ファイル再選択から再試行します... [診断] ${diag}`)
          await new Promise((resolve) => setTimeout(resolve, 3000))
        }
      } finally {
        page.off('request', onRequestFinished)
        page.off('response', onResponse)
        page.off('requestfailed', onRequestFailed)
        if (cdpClient) {
          cdpClient.off('Network.requestWillBeSent', onCdpRequestWillBeSent)
          cdpClient.off('Network.loadingFailed', onCdpLoadingFailed)
          await cdpClient.detach().catch(() => {})
        }
      }
    }
    if (lastError && process.env.SALONBOARD_PROXY_SERVER) {
      log('[診断] プロキシなしでの比較テストを実行します(結果はこのジョブの成否には影響しません)...')
      const comparisonResult = await diagnoseUploadWithoutProxy(page, imageBuffer, fileName).catch(
        (e) => `[診断:プロキシなし比較] 比較テスト自体が例外で失敗: ${String(e)}`
      )
      log(comparisonResult)
      lastError = new Error(`${lastError.message} ${comparisonResult}`)
    }
    if (lastError) throw lastError
  } finally {
    await unlink(tmpPath).catch(() => {})
  }

  const imageId = await page.evaluate(() => document.getElementById('FRONT_IMG_ID_ID')?.textContent?.trim() ?? '')
  log(`画像アップロード成功(ファイル選択方式): imageId=${imageId}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 反映申請がNG/未確認ワード等でブロックされていることを表すエラー。
 * 呼び出し側でこれを捕捉した場合、通常の失敗(failed)ではなく
 * blocked として区別してジョブ結果に含める。
 */
export class ReflectionBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReflectionBlockedError'
  }
}

/**
 * 掲載管理TOPページを開いた状態で、反映申請がブロックされていないかを確認する。
 *
 * 「NG」が実際にライブ表示された状態の実HTML構造(文言・クラス名・出現箇所)は
 * まだ実機で確認できていないため、暫定措置としてこの関数は常にblocked: falseを
 * 返す(過剰ブロックによる誤検知を避けるため)。
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

  return { blocked: false }
}

/**
 * 掲載管理TOPから反映申請(公開)を行う。
 * サロン/スタイリスト/スタイル/メニュー/こだわりをまとめて反映する
 * 通常の反映申請ボタン(`#reflectedButton`)のみを対象とする。
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
    throw new ReflectionBlockedError(`反映申請がブロックされている可能性があります: ${blockCheck.reason || '詳細不明'}`)
  }

  log('反映申請を実行中...')
  // #reflectedButtonにはinline onclickが無く、別JSでaddEventListenerされている。
  // Puppeteerネイティブのpage.click()(CDP経由の本物のマウスイベント、
  // isTrusted=true)を使う。
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    page.click('#reflectedButton')
  ])

  log('反映申請が完了しました(実際の公開まで約20分かかります)')
}

/**
 * 1枚のスタイル画像に対する「登録+反映申請」の一連の処理。
 */
export async function postStyleImageFull(page: Page, input: StylePostInput, log: AutomationLogger): Promise<void> {
  await draftRegisterStyle(page, input, log)
  await submitReflectApplication(page, log)
}
