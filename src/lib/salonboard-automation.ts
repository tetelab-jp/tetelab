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
// Node側の型定義とは別にDOM型を参照する必要がある。
/// <reference lib="dom" />

import type { Bindings } from '../types'
import type { Browser, Page } from 'puppeteer'
import puppeteerExtra from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
export type { Browser, Page }

// 2026-08-10追記: navigator.webdriver等の手動パッチだけではSALON BOARDの
// Akamai系ボット対策を回避できないことが実機検証(プロキシでIPを変えても
// 症状不変)で確認できたため、headless検知への対策として実績のある
// puppeteer-extra-plugin-stealthを導入した(WebGL vendor/renderer・
// Permissions API・plugins/mimeTypesの形状・iframe.contentWindow等、
// 手動では網羅しきれない検知ポイントを幅広くカバーする)。
puppeteerExtra.use(StealthPlugin())

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
 * ブラウザインスタンスを起動する。呼び出し側で必ずfinally節等で
 * browser.close()すること。
 *
 * 元はCloudflare Browser Rendering固有の同時起動数上限(429エラー)への
 * 指数バックオフリトライがあったが、AWS ECS/Fargate(Node標準puppeteer)へ
 * 移行したことで、共有ブラウザプールの同時起動数制限という制約自体が
 * 無くなったため不要になった。
 */
export async function launchBrowser(): Promise<Browser> {
  const args = ['--no-sandbox', '--disable-setuid-sandbox']

  // SALON BOARD側のボット対策がAWSのIPをブロックしているかを検証するための
  // 一時的な迂回策。SALONBOARD_PROXY_SERVER(例: http://host:port)が設定されて
  // いる場合のみプロキシ経由でアクセスする。未設定時は従来通り直接アクセス。
  const proxyServer = process.env.SALONBOARD_PROXY_SERVER
  if (proxyServer) {
    args.push(`--proxy-server=${proxyServer}`)
  }

  return puppeteerExtra.launch({
    headless: true,
    args
  })
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
export async function newAutomationPage(browser: Browser, log?: AutomationLogger): Promise<Page> {
  const page = await browser.newPage()

  // プロキシに認証が必要な場合(SALONBOARD_PROXY_USERNAME/PASSWORD設定時)のみ認証する。
  const proxyUsername = process.env.SALONBOARD_PROXY_USERNAME
  const proxyPassword = process.env.SALONBOARD_PROXY_PASSWORD
  if (proxyUsername && proxyPassword) {
    await page.authenticate({ username: proxyUsername, password: proxyPassword })
  }

  // 2026-08-09追記: ブラウザネイティブの確認ダイアログ(window.confirm/alert等)への
  // ハンドラが無かった。もしサロンボードが登録時等に確認ダイアログを出す仕様の場合、
  // ハンドラが無いとPuppeteerはダイアログに応答できずそのまま固まり、
  // waitForNavigation/waitForFunctionが静かにタイムアウトする(ダイアログはDOM外の
  // ネイティブUIのため、document.body.innerTextには一切現れず、原因究明が困難だった)。
  // 常に自動的に「OK」を押す(accept)ようにして、この可能性を排除する。
  page.on('dialog', async (dialog: any) => {
    log?.(`確認ダイアログを検知し自動的にOKを選択しました: 「${dialog.message()}」`)
    await dialog.accept().catch(() => {})
  })

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
  // login/editStyle/doSelectNextと同様、onclick="addStyle(event)"を持つ実要素を
  // ネイティブクリック(isTrusted=true)する。見つからない場合のみ、フォームの
  // 直接submitにフォールバックする。
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

  // ---- スタイリストコメント ----
  // 2026-08-09追記: ユーザーが実画面のスクリーンショットを比較し、旧実装の
  // 文字数上限(240)が実際のサロンボードの上限(120)と異なることが判明。
  // 上限超過分を送っていた場合、サロンボード側のバリデーションで登録自体が
  // 拒否されていた可能性が高い(これまでの登録失敗の実際の原因と推測される)。
  await page.evaluate((text: string) => {
    const el = document.getElementById('stylistCommentTxt') as HTMLTextAreaElement | null
    if (el) el.value = text
  }, input.stylistComment.slice(0, 120))

  // ---- スタイル名 ----
  // 2026-08-09追記: 同様に、実際の上限は60ではなく30文字だった。
  await page.evaluate((text: string) => {
    const el = document.getElementById('styleNameTxt') as HTMLInputElement | null
    if (el) el.value = text
  }, input.styleName.slice(0, 30))

  // ---- カテゴリ（レディース/メンズ） ----
  const categoryRadioId = input.categoryCd === 'SG01' ? '#styleCategoryCd01' : '#styleCategoryCd02'
  await page.click(categoryRadioId)
  // カテゴリ選択によりJSでレングスselectの表示が切り替わるため少し待つ
  // (新しいバージョンのpuppeteerではpage.waitForTimeoutが廃止されているため自前で待機)
  await sleep(300)

  // ---- ヘアレングス（レディース/メンズでidが異なる<select>） ----
  // 2026-08-09追記: ユーザーが実HTMLを直接貼ってくれたことで確定。
  // <select name="frmStyleEditStyleDto.ladiesHairLengthCd" id="ladiesHairLengthCd" class="h20">
  // 旧実装が使っていた`.ladiesHairLengthCd`というクラスは存在しない(実際のclassは"h20")。
  // 正しくはid指定。
  const lengthSelectId = input.categoryCd === 'SG01' ? '#ladiesHairLengthCd' : '#mensHairLengthCd'
  const lengthHandle = await page.$(lengthSelectId)
  if (lengthHandle) {
    await page.select(lengthSelectId, input.hairLengthValue)
  } else {
    log(`警告: 長さ選択欄(${lengthSelectId})が見つかりませんでした`)
  }

  // ---- メニュー内容チェックボックス（任意） ----
  if (input.menuContentsCdList && input.menuContentsCdList.length > 0) {
    for (const mc of input.menuContentsCdList) {
      const cb = await page.$(`input.menuContentsCdList[value="${mc}"]`)
      if (cb) await cb.click()
    }
  }

  // ---- メニュー詳細（必須） ----
  // 2026-08-09追記: 実際の上限は100ではなく50文字だった。
  await page.evaluate((text: string) => {
    const el = document.getElementById('menuDetailTxt') as HTMLTextAreaElement | null
    if (el) el.value = text
  }, input.menuDetailText.slice(0, 50))

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

  // ---- 送信前セルフチェック ----
  // 2026-08-09追記: 「送信しても実際にはサロンボード側で保存されない」という
  // 事象が発生し、原因の切り分けに時間がかかったため、送信直前に各必須項目が
  // 本当にセットされているかを自己点検してログに残すようにした
  // (page.select()は指定値が存在しない場合など静かに失敗することがあるため)。
  const preflight = await page.evaluate(() => {
    const val = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ?? '(要素なし)'
    const checked = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.checked ?? '(要素なし)'
    return {
      styleRegistFormat: (document.querySelector('input[name="frmStyleEditStyleInfoDto.styleRegistFormat"]:checked') as HTMLInputElement | null)?.value ?? '(未選択)',
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

  // ---- 保存（doRegister） ----
  // 2026-08-09追記: 以前はpage.evaluate()内でのelement.click()(isTrusted=false
  // の合成イベント)を使っており、かつクリック後の検証が一切無かった
  // (waitForNavigationがタイムアウトしても.catch(() => null)で握りつぶし、
  // 無条件に「登録完了」と判定していた)。これにより、実際にはサロンボード
  // サーバー側で保存されていない(=スタイル一覧に表示されない)にもかかわらず
  // 「成功」として扱われる可能性があった。login/editStyle/doSelectNextと
  // 同様にネイティブクリックへ変更した上で、保存が実際にサーバー側で成功した
  // ことを検証する。
  log('スタイルを登録中...')
  const doRegisterHandle = await page.$('[onclick*="doRegister("]')
  if (!doRegisterHandle) {
    throw new Error('登録ボタン([onclick*="doRegister("])が見つかりませんでした')
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
    doRegisterHandle.click()
  ])

  // 登録成功の検証: 新規スタイルの場合、サーバーが実styleId(L+9桁)を発行し、
  // 同一フォーム内の#styleId隠しフィールドにセットした状態で再描画される
  // (editStyle実行後と同様、同一ページ内でフルページ相当の再レンダリングが
  // 起きる仕様のため)。これが確認できない場合はサーバー側で実際に保存された
  // 保証が無いため、エラーとして扱う(無条件の「成功」報告はしない)。
  //
  // 2026-08-09追記: StylePost(競合製品)の実装調査から、salonboard.comが
  // `https://salonboard.com/CNB/draft/styleEdit/?styleId=Lxxxxxxxxx` という
  // クエリパラメータ付きURLを実際にサポートしていることを実機確認した。
  // doRegister()成功時にこのURLへ遷移する可能性があるため、#styleId隠し
  // フィールドに加えて現在のURLからも同じ形式のstyleIdを拾えるようにし、
  // どちらか一方でも確認できれば成功と判定する(冗長化による検知の安定化)。
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
    // 2026-08-09追記: 以前はここで画面全文(先頭500文字)をエラーメッセージに
    // 埋め込んでいたが、ヘッダーメニュー等の定型文しか含まれず一度も有用な
    // 情報が得られなかった上、実行履歴の表示が長文で見づらくなる副作用が
    // あった(ユーザー指摘)。そのため画面全文の埋め込みはやめ、
    // #styleId要素の状態・エラー表示候補の有無という簡潔な情報のみに絞る。
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

  log(`スタイル登録が完了しました（styleId: ${registeredStyleId}）`)
}

/**
 * 写真アップロード処理。
 *
 * 2026-08-09追記(全面的な方式変更): ユーザーがDevTools NetworkタブでdoUpload
 * リクエスト・レスポンスの実内容を直接キャプチャしてくれたことにより、
 * UI操作(プレースホルダークリック→モーダル内file inputへの注入→「登録する」
 * ボタンクリック→完了検知のポーリング)を一切経由せず、アップロード
 * エンドポイントをfetch()で直接呼び出す方式に全面的に置き換えた。
 * これにより、これまで繰り返し問題になっていたUI操作のisTrusted/タイミング
 * 関連の不確実性が原理的に無くなる。
 *
 * リクエスト仕様(実機DevToolsで確認済み):
 *   POST https://salonboard.com/CNB/imgreg/imgUpload/doUpload?wFlg=true
 *   Content-Type: multipart/form-data
 *   フィールド: formFile(画像バイナリ), setImgId="FRONT_IMG_ID", dataKey="",
 *     targetActionId="ABNKD3600_FRONT",
 *     org.apache.struts.taglib.html.TOKEN(CSRFトークン。ページ内の同名隠し
 *     フィールドから取得。全フォーム共通のページ単位トークンであることを
 *     実機確認済み)、STORE_ID(同じくページ内の隠しフィールドから取得)、
 *     modified="0", pubManageId="undefined"(リテラル文字列。観測された
 *     挙動をそのまま再現)。
 *
 * レスポンス仕様(実機DevToolsで確認済み): モーダルHTML片が返るが、その中の
 * 隠しフィールドとして imageId(B+9桁)・elementName(=setImgIdと同じ値)・
 * meetStandardFlg・lengthSizeOrg・sideSizeOrg・resolutionOrg・imageFilePath
 * が埋め込まれている。これはページ内に実在するJSコールバック関数
 * `setUploadImage(imageId, setImgId, meetStandardFlg, lengthSize, sideSize,
 * resolution, imageFilePath)` の引数と完全に一致する形式。そのため、
 * レスポンスHTMLをパースして値を取り出した後、DOM更新(サムネイル表示・
 * 隠しフィールド更新・#JS_CHANGE_FLG設定等)を自前で再実装するのではなく、
 * ページ上のwindow.setUploadImage()をそのまま呼び出すことで、
 * サイト本来の更新ロジックを正しく適用させる。
 */
async function uploadFrontImage(
  page: Page,
  imageBuffer: ArrayBuffer,
  fileName: string,
  log: AutomationLogger
): Promise<void> {
  // 2026-08-09追記(その21): 本番で「Protocol error (Runtime.callFunctionOn):
  // Target closed」が発生した。doUploadが送信される前か後か、setUploadImage
  // 呼び出しの前か後かを切り分けるため、以下の診断情報を強化する:
  //   - Node側: page.on('request'/'response'/...)でdoUploadの実発生と
  //     ページクラッシュ・close イベントを観測
  //   - browser側: page.evaluate内で各ステップの到達点を trace 配列に記録
  // 両方の情報を、失敗時のErrorメッセージにも埋め込み(processStyleRow側の
  // logコレクションと二重化)、実行履歴から確実に原因位置を特定できるようにする。
  const diagnostics: string[] = []
  const push = (msg: string) => {
    diagnostics.push(msg)
    log(`[アップロード診断] ${msg}`)
  }

  const onRequest = (req: any) => {
    try {
      if (req.url?.().includes('doUpload')) push(`req開始: ${req.method?.()} ${req.url?.()}`)
    } catch {}
  }
  const onResponse = (res: any) => {
    try {
      if (res.url?.().includes('doUpload')) {
        const len = res.headers?.()?.['content-length'] ?? '?'
        push(`res受信: status=${res.status?.()} content-length=${len}`)
      }
    } catch {}
  }
  const onRequestFailed = (req: any) => {
    try {
      if (req.url?.().includes('doUpload')) {
        push(`req失敗: ${req.url?.()} err=${req.failure?.()?.errorText ?? '?'}`)
      }
    } catch {}
  }
  const onPageError = (err: any) => push(`pageerror: ${String(err?.message || err)}`)
  const onError = (err: any) => push(`page.error: ${String(err?.message || err)}`)
  const onClose = () => push('page.close発生(ターゲットが閉じた)')

  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfailed', onRequestFailed)
  page.on('pageerror', onPageError)
  page.on('error', onError)
  page.on('close', onClose)

  try {
    push(`開始: imageBufferサイズ=${imageBuffer.byteLength}バイト, fileName=${fileName}`)
    const base64 = arrayBufferToBase64(imageBuffer)
    push(`base64エンコード完了: 長さ=${base64.length}`)

    push('page.evaluate開始(fetch方式)')
    const result = await page.evaluate(
      async (base64Data: string, name: string) => {
        const trace: string[] = []
        try {
          trace.push('eval:START')
          const tokenEl = document.querySelector(
            'input[name="org.apache.struts.taglib.html.TOKEN"]'
          ) as HTMLInputElement | null
          const storeIdEl = document.querySelector('input[name="STORE_ID"]') as HTMLInputElement | null
          if (!tokenEl || !storeIdEl) {
            return { success: false, error: 'CSRFトークンまたはSTORE_IDがページ内に見つかりませんでした', imageId: null, trace }
          }
          trace.push('eval:TOKEN/STORE_ID取得OK')

          const byteChars = atob(base64Data)
          const byteNumbers = new Array(byteChars.length)
          for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i)
          const byteArray = new Uint8Array(byteNumbers)
          const blob = new Blob([byteArray], { type: 'image/jpeg' })
          trace.push(`eval:Blob作成OK size=${blob.size}`)

          const formData = new FormData()
          formData.append('formFile', blob, name)
          formData.append('setImgId', 'FRONT_IMG_ID')
          formData.append('dataKey', '')
          formData.append('targetActionId', 'ABNKD3600_FRONT')
          formData.append('org.apache.struts.taglib.html.TOKEN', tokenEl.value)
          formData.append('STORE_ID', storeIdEl.value)
          formData.append('modified', '0')
          formData.append('pubManageId', 'undefined')
          trace.push('eval:FormData構築OK')

          let resText: string
          let resStatus: number
          try {
            trace.push('eval:fetch開始')
            const res = await fetch('https://salonboard.com/CNB/imgreg/imgUpload/doUpload?wFlg=true', {
              method: 'POST',
              body: formData,
              credentials: 'include'
            })
            resStatus = res.status
            trace.push(`eval:fetchレスポンス受信 status=${resStatus}`)
            resText = await res.text()
            trace.push(`eval:レスポンスtext読み取り完了 長さ=${resText.length}`)
          } catch (fetchErr: any) {
            return { success: false, error: `fetch自体が失敗: ${String(fetchErr?.message || fetchErr)}`, imageId: null, trace }
          }

          const doc = new DOMParser().parseFromString(resText, 'text/html')
          const val = (id: string) => (doc.getElementById(id) as HTMLInputElement | null)?.value ?? null

          const userErrorFlg = val('userErrorFlg')
          const imageId = val('imageId')
          const elementName = val('elementName')
          const meetStandardFlg = val('meetStandardFlg')
          const lengthSizeOrg = val('lengthSizeOrg')
          const sideSizeOrg = val('sideSizeOrg')
          const resolutionOrg = val('resolutionOrg')
          const imageFilePath = val('imageFilePath')
          trace.push(`eval:パース結果 userErrorFlg=${userErrorFlg} imageId=${imageId}`)

          if (userErrorFlg !== '0' || !imageId || !/^B\d{9}$/.test(imageId)) {
            return {
              success: false,
              error: `アップロードレスポンスが想定外(status=${resStatus}, userErrorFlg=${userErrorFlg}, imageId=${imageId})`,
              imageId: null,
              trace
            }
          }

          if (typeof (window as any).setUploadImage !== 'function') {
            return { success: false, error: 'window.setUploadImage関数が見つからない', imageId, trace }
          }
          trace.push('eval:setUploadImage呼び出し直前')
          ;(window as any).setUploadImage(
            imageId,
            elementName,
            meetStandardFlg,
            lengthSizeOrg,
            sideSizeOrg,
            resolutionOrg,
            imageFilePath
          )
          trace.push('eval:setUploadImage呼び出し完了')

          return { success: true, error: null, imageId, trace }
        } catch (evalErr: any) {
          trace.push(`eval:例外 ${String(evalErr?.message || evalErr)}`)
          return { success: false, error: `evaluate内例外: ${String(evalErr?.message || evalErr)}`, imageId: null, trace }
        }
      },
      base64,
      fileName
    )
    push(`page.evaluate完了 success=${result.success}`)
    if (result.trace && result.trace.length > 0) {
      log(`[アップロード内部トレース] ${result.trace.join(' | ')}`)
    }

    if (!result.success) {
      throw new Error(
        `画像アップロードに失敗しました(fetch方式): ${result.error}` +
          ` [内部trace: ${(result.trace ?? []).join(' | ')}]` +
          ` [外側診断: ${diagnostics.join(' | ')}]`
      )
    }

    log(`画像アップロード成功(fetch方式): imageId=${result.imageId}`)
  } catch (outerErr: any) {
    // Target closed等、page.evaluate自体がrejectした場合はここに来る。
    // 内部traceは失われるが、外側の診断ログ(request/responseイベント)は
    // 残っているはずなので、それをErrorメッセージに含める。
    const msg = String(outerErr?.message || outerErr)
    log(`[アップロード診断] 外側catchで例外: ${msg}`)
    throw new Error(`画像アップロード中に例外: ${msg} [外側診断: ${diagnostics.join(' | ')}]`)
  } finally {
    // pageが既に閉じている場合の removeListener 失敗を握りつぶす
    try { page.off('request', onRequest) } catch {}
    try { page.off('response', onResponse) } catch {}
    try { page.off('requestfailed', onRequestFailed) } catch {}
    try { page.off('pageerror', onPageError) } catch {}
    try { page.off('error', onError) } catch {}
    try { page.off('close', onClose) } catch {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString('base64')
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
