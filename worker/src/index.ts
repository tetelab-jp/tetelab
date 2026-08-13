// ============================================
// index.ts ── Fargateタスクのエントリポイント
//
// ECS RunTaskのcontainerOverrides.environmentで渡された
// JOB_API_BASE / JOB_ID / JOB_TOKEN を読み、
//   1. GET  {JOB_API_BASE}/api/automation/jobs/{JOB_ID}  でジョブ内容を取得
//   2. SALON BOARDへログイン〜登録〜反映申請を実行
//   3. POST {JOB_API_BASE}/api/automation/jobs/{JOB_ID}/result で結果を送信
//   4. プロセスを終了する(ECS Fargateタスクはコンテナ終了とともに停止する)
// ジョブごとに新しいタスクを起動する使い捨て運用のため、
// このプロセスは常駐しない(HTTPサーバーは立てない)。
// ============================================

import {
  newAutomationPage,
  loginToSalonBoard,
  draftRegisterStyle,
  submitReflectApplication,
  launchBrowser,
  closeAnonymizedProxy,
  ReflectionBlockedError,
  type StylePostInput,
  type LaunchedBrowser
} from './salonboard-automation'
import type { Page } from 'puppeteer'

type JobPayload = {
  loginId: string
  password: string
  // 2026-08-12追記: プロキシは固定5IPのプールであるため、アプリ側で実績が
  // 良い順に並べた候補セッションIDのリストを渡す。先頭から順にログインを
  // 試み、失敗したら次の候補で再試行する(最大2件まで、既存の1回だけ
  // 再試行する挙動を踏襲)。ここに含まれない適当な乱数セッションIDへ
  // フォールバックすると、そのIPの実績を後で記録できなくなるため使わない。
  proxySessionCandidates?: string[] | null
  style: Omit<StylePostInput, 'imageBuffer'> & { imageBase64: string }
}

type JobStep = 'login' | 'navigate' | 'draft_register' | 'image_upload' | 'reflect' | 'done'

type LoginAttempt = { sessionId: string; success: boolean }

type JobResult = {
  success: boolean
  step: JobStep
  message: string
  blocked: boolean
  logs: string[]
  // ログインに成功した(=CAPTCHA等に遭遇しなかった)実際のプロキシセッションID。
  // アプリ側でこのセッションの実績(proxy_session_pool_stats)を更新するために使う。
  proxySessionId?: string | null
  // 試した候補セッションIDそれぞれのログイン成否。アプリ側で候補ごとの
  // 実績を個別に記録するために使う(最終的に成功した1件だけでなく、
  // 先に失敗した候補も記録できるようにするため)。
  loginAttempts?: LoginAttempt[]
}

async function main(): Promise<void> {
  const apiBase = requireEnv('JOB_API_BASE')
  const jobId = requireEnv('JOB_ID')
  const jobToken = requireEnv('JOB_TOKEN')

  const logs: string[] = []
  const log = (msg: string) => {
    console.log(msg)
    logs.push(msg)
  }

  let result: Omit<JobResult, 'logs'>
  try {
    const payload = await fetchJob(apiBase, jobId, jobToken)
    result = await runJob(payload, log)
  } catch (err: any) {
    result = {
      success: false,
      step: 'login',
      message: `ジョブ実行中に予期しないエラーが発生しました: ${String(err?.message || err)}`,
      blocked: false
    }
  }

  await postResult(apiBase, jobId, jobToken, { ...result, logs })
  process.exit(result.success ? 0 : 1)
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`環境変数 ${name} が設定されていません`)
    process.exit(1)
  }
  return v
}

async function fetchJob(apiBase: string, jobId: string, jobToken: string): Promise<JobPayload> {
  const res = await fetch(`${apiBase}/api/automation/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${jobToken}` }
  })
  if (!res.ok) throw new Error(`ジョブ取得に失敗しました(status=${res.status})`)
  return (await res.json()) as JobPayload
}

async function postResult(apiBase: string, jobId: string, jobToken: string, result: JobResult): Promise<void> {
  try {
    await fetch(`${apiBase}/api/automation/jobs/${jobId}/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    })
  } catch (err) {
    // コールバック自体が失敗した場合、アプリ側はジョブを「stale」として
    // 一定時間後にタイムアウト扱いにする(automation.tsx側のクリーンアップ処理)。
    console.error('結果の送信に失敗しました:', err)
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = Buffer.from(base64, 'base64')
  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type LoginAttemptResult = LaunchedBrowser & { page: Page | null; error: any; topPageUrl: string | null }

/**
 * 2026-08-13追記: proxy-chain方式では、セッションID(出口IP)ごとに専用の
 * ローカル取次プロキシをブラウザ起動時に紐付ける必要があるため、以前のように
 * 1つのブラウザを使い回してページだけ差し替える方式が使えなくなった。
 * 候補セッションIDごとに、ブラウザの起動からやり直す。
 */
async function attemptLogin(
  payload: JobPayload,
  log: (msg: string) => void,
  candidateId?: string
): Promise<LoginAttemptResult> {
  const launched = await launchBrowser(candidateId)
  try {
    const page = await newAutomationPage(launched.browser, log)
    try {
      await loginToSalonBoard(page, payload.loginId, payload.password, log)
      // 2026-08-13追記: ログイン直後のURL(トップページ)を控えておく。
      // 画像アップロード失敗時、再ログインではなくこのURLへ戻って同じ
      // セッションのままやり直すために使う(runJob参照)。
      return { ...launched, page, error: null, topPageUrl: page.url() }
    } catch (err: any) {
      return { ...launched, page, error: err, topPageUrl: null }
    }
  } catch (err: any) {
    // newAutomationPage自体が失敗した場合(まれ)
    return { ...launched, page: null, error: err, topPageUrl: null }
  }
}

async function closeAttempt(attempt: LoginAttemptResult): Promise<void> {
  await attempt.browser.close().catch(() => {})
  if (attempt.anonymizedProxyUrl) {
    await closeAnonymizedProxy(attempt.anonymizedProxyUrl, true).catch(() => {})
  }
}

const MAX_DRAFT_ATTEMPTS_PER_SESSION = 3

/**
 * 同じセッション(ブラウザ)のまま、下書き登録(画像アップロード含む)を
 * 最大MAX_DRAFT_ATTEMPTS_PER_SESSION回試す。失敗した場合は再ログインせず、
 * ログイン直後のトップページへ戻ってからやり直す(draftRegisterStyle()は
 * doRegisterクリックまでSALON BOARD側に何も保存しないため、この範囲での
 * やり直しに二重登録のリスクは無い)。全て失敗した場合は最後のエラーを返す。
 */
async function tryDraftWithRetries(
  page: Page,
  styleInput: StylePostInput,
  log: (msg: string) => void,
  topPageUrl: string | null
): Promise<any> {
  let draftError: any = null
  for (let draftAttempt = 1; draftAttempt <= MAX_DRAFT_ATTEMPTS_PER_SESSION; draftAttempt++) {
    try {
      await draftRegisterStyle(page, styleInput, log)
      return null
    } catch (err: any) {
      draftError = err
      if (draftAttempt < MAX_DRAFT_ATTEMPTS_PER_SESSION) {
        log(
          `スタイル下書き登録(画像アップロード含む)に失敗したため` +
            `(試行${draftAttempt}/${MAX_DRAFT_ATTEMPTS_PER_SESSION})、` +
            `ログインのやり直しはせず、ログイン後のトップページに戻って再試行します...`
        )
        if (topPageUrl) {
          await page.goto(topPageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
            log(`トップページへの遷移に失敗しました(そのまま再試行します): ${String(e?.message || e)}`)
          })
        }
      }
    }
  }
  return draftError
}

async function runJob(payload: JobPayload, log: (msg: string) => void): Promise<Omit<JobResult, 'logs'>> {
  // 2026-08-12追記: アプリ側が実績順に並べた候補セッションIDを先頭から
  // 順に試す。候補が無い場合(例: 同時実行回避時)は従来通りpreferredなしで
  // attemptLoginに任せる。
  //
  // 2026-08-13追記(方針転換): 画像アップロードの失敗(net::ERR_ABORTED)は
  // 別のプロキシセッション(出口IP)に切り替えても同じ症状で再発することが
  // 実機ログで確認され、特定の候補固有の問題ではないと分かった。そのため
  // 失敗1回ごとに別セッションで再ログインする挙動は廃止し、まずは同じ
  // セッションのままログイン後のトップページに戻って最大
  // MAX_DRAFT_ATTEMPTS_PER_SESSION回再試行する(tryDraftWithRetries)。
  //
  // 2026-08-13追記2: それでも全滅した場合は、実績(連続障害回数)による
  // 順位付けに関わらず、候補リストの次のセッションID(=必ず別IP)へ強制的に
  // 切り替えて再ログインする。実績ベースの並び替えだと同じセッションが
  // また選ばれてしまい得るため、ここでは強制的に「次」を使う。
  const candidates = (payload.proxySessionCandidates || []).slice(0, 5)
  const loginAttempts: LoginAttempt[] = []

  const { imageBase64, ...styleRest } = payload.style
  const styleInput: StylePostInput = {
    ...styleRest,
    imageBuffer: base64ToArrayBuffer(imageBase64)
  }

  let attempt = await attemptLogin(payload, log, candidates[0])
  if (candidates[0]) loginAttempts.push({ sessionId: candidates[0], success: !attempt.error })

  let draftError: any = attempt.error ? null : new Error('未試行')
  if (!attempt.error) draftError = await tryDraftWithRetries(attempt.page!, styleInput, log, attempt.topPageUrl)

  for (let i = 1; i < candidates.length && (attempt.error || draftError); i++) {
    // 2026-08-13追記(診断強化): 以前は「ログインに失敗したため切り替えます」
    // としか記録しておらず、CAPTCHAだったのか単なる通信エラーだったのか
    // 後から判別できなかった。attempt.errorの実際のメッセージ(診断情報込み)
    // をログに含めるようにする。
    const reason = attempt.error
      ? `ログイン(${String(attempt.error?.message || attempt.error).slice(0, 300)})`
      : `スタイル下書き登録(${MAX_DRAFT_ATTEMPTS_PER_SESSION}回試行済み)`
    log(
      `[プロキシ] セッションID(${candidates[i - 1]})での${reason}に失敗したため、` +
        `実績に関わらず次の候補セッションID(${candidates[i]})へ強制的に切り替えて再ログインします...`
    )
    await closeAttempt(attempt)
    // 2026-08-13追記: 短時間に複数の別IPから同じアカウントへ連続ログインする
    // こと自体がSALON BOARD/Akamai側に不審な挙動として警戒される可能性を
    // 考慮し、切り替え前に少し間隔を空ける。
    await sleep(4000)
    attempt = await attemptLogin(payload, log, candidates[i])
    loginAttempts.push({ sessionId: candidates[i], success: !attempt.error })
    draftError = attempt.error ? null : new Error('未試行')
    if (!attempt.error) draftError = await tryDraftWithRetries(attempt.page!, styleInput, log, attempt.topPageUrl)
  }

  try {
    const { page, proxySessionId, error: loginError } = attempt

    if (loginError) {
      return {
        success: false,
        step: 'login',
        message: String(loginError?.message || loginError),
        blocked: false,
        proxySessionId: null,
        loginAttempts
      }
    }

    // ここまで到達していればログイン成功(=このセッションIDはCAPTCHA等を
    // 回避できた実績あり)。以降の工程の成否に関わらず、次回以降のセッション
    // 選定に使えるようこのproxySessionIdを結果に含めて返す。
    if (draftError) {
      return {
        success: false,
        step: 'draft_register',
        message: String(draftError?.message || draftError),
        blocked: false,
        proxySessionId,
        loginAttempts
      }
    }

    try {
      await submitReflectApplication(page!, log)
    } catch (err: any) {
      if (err instanceof ReflectionBlockedError) {
        return { success: false, step: 'reflect', message: err.message, blocked: true, proxySessionId, loginAttempts }
      }
      return { success: false, step: 'reflect', message: String(err?.message || err), blocked: false, proxySessionId, loginAttempts }
    }

    return { success: true, step: 'done', message: '登録・反映申請が完了しました', blocked: false, proxySessionId, loginAttempts }
  } finally {
    await closeAttempt(attempt)
  }
}

main().catch((err) => {
  console.error('main()で捕捉されなかったエラー:', err)
  process.exit(1)
})
