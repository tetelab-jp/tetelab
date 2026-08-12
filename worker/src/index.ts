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
  ReflectionBlockedError,
  type StylePostInput
} from './salonboard-automation'

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

async function attemptLogin(
  browser: import('puppeteer').Browser,
  payload: JobPayload,
  log: (msg: string) => void,
  candidateId?: string
): Promise<{ page: Awaited<ReturnType<typeof newAutomationPage>>['page']; proxySessionId: string | null; error: any }> {
  const { page, proxySessionId } = await newAutomationPage(browser, log, candidateId)
  try {
    await loginToSalonBoard(page, payload.loginId, payload.password, log)
    return { page, proxySessionId, error: null }
  } catch (err: any) {
    return { page, proxySessionId, error: err }
  }
}

async function runJob(payload: JobPayload, log: (msg: string) => void): Promise<Omit<JobResult, 'logs'>> {
  const browser = await launchBrowser()

  try {
    // 2026-08-12追記: アプリ側が実績順に並べた候補セッションIDを先頭から
    // 順に試す(最大2件まで)。候補が無い場合(例: 同時実行回避時)は
    // 従来通りpreferredなしでnewAutomationPageに任せる。
    const candidates = (payload.proxySessionCandidates || []).slice(0, 2)
    const loginAttempts: LoginAttempt[] = []

    let attempt = await attemptLogin(browser, payload, log, candidates[0])
    if (candidates[0]) loginAttempts.push({ sessionId: candidates[0], success: !attempt.error })

    for (let i = 1; i < candidates.length && attempt.error; i++) {
      log(
        `[プロキシ] セッションID(${candidates[i - 1]})でのログインに失敗したため、` +
          `次の候補セッションID(${candidates[i]})で再試行します...`
      )
      await attempt.page.close().catch(() => {})
      attempt = await attemptLogin(browser, payload, log, candidates[i])
      loginAttempts.push({ sessionId: candidates[i], success: !attempt.error })
    }

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
    const { imageBase64, ...styleRest } = payload.style
    const styleInput: StylePostInput = {
      ...styleRest,
      imageBuffer: base64ToArrayBuffer(imageBase64)
    }

    try {
      await draftRegisterStyle(page!, styleInput, log)
    } catch (err: any) {
      return {
        success: false,
        step: 'draft_register',
        message: String(err?.message || err),
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
    await browser.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('main()で捕捉されなかったエラー:', err)
  process.exit(1)
})
