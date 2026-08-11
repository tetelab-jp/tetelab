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
  // 2026-08-11追記: 直近ログイン成功実績のあるプロキシセッションID(あれば)。
  // 同一サロンアカウントへのログイン元IPを毎回変えるより、実績のある
  // IPを使い回す方がボット対策上自然と考えられるため。
  preferredProxySessionId?: string | null
  style: Omit<StylePostInput, 'imageBuffer'> & { imageBase64: string }
}

type JobStep = 'login' | 'navigate' | 'draft_register' | 'image_upload' | 'reflect' | 'done'

type JobResult = {
  success: boolean
  step: JobStep
  message: string
  blocked: boolean
  logs: string[]
  // ログインに成功した(=CAPTCHA等に遭遇しなかった)実際のプロキシセッションID。
  // アプリ側でsalon_credentials.last_successful_proxy_session_idへ保存し、
  // 次回以降のジョブで優先的に使い回すために返す。
  proxySessionId?: string | null
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

async function runJob(payload: JobPayload, log: (msg: string) => void): Promise<Omit<JobResult, 'logs'>> {
  const browser = await launchBrowser()

  try {
    // 2026-08-11追記: まず前回成功実績のあるセッションID(あれば)でログインを
    // 試み、失敗した場合のみ新しいランダムなセッションID(セカンダリー)で
    // 1回だけ再試行する。実績のあるIPを毎回使い回すことで、同一アカウントへの
    // ログイン元IPが頻繁に変わる不自然さを避ける狙い。
    let { page, proxySessionId } = await newAutomationPage(browser, log, payload.preferredProxySessionId)

    let loginError: any = null
    try {
      await loginToSalonBoard(page, payload.loginId, payload.password, log)
    } catch (err: any) {
      loginError = err
    }

    if (loginError && payload.preferredProxySessionId) {
      log(
        `[プロキシ] 前回成功実績のセッションID(${proxySessionId})でのログインに失敗したため、` +
          `新しいセッションIDで再試行します...`
      )
      await page.close().catch(() => {})
      ;({ page, proxySessionId } = await newAutomationPage(browser, log))
      try {
        await loginToSalonBoard(page, payload.loginId, payload.password, log)
        loginError = null
      } catch (err: any) {
        loginError = err
      }
    }

    if (loginError) {
      return { success: false, step: 'login', message: String(loginError?.message || loginError), blocked: false, proxySessionId: null }
    }

    // ここまで到達していればログイン成功(=このセッションIDはCAPTCHA等を
    // 回避できた実績あり)。以降の工程の成否に関わらず、次回以降も優先的に
    // 使い回せるようこのproxySessionIdを結果に含めて返す。
    const { imageBase64, ...styleRest } = payload.style
    const styleInput: StylePostInput = {
      ...styleRest,
      imageBuffer: base64ToArrayBuffer(imageBase64)
    }

    try {
      await draftRegisterStyle(page, styleInput, log)
    } catch (err: any) {
      return {
        success: false,
        step: 'draft_register',
        message: String(err?.message || err),
        blocked: false,
        proxySessionId
      }
    }

    try {
      await submitReflectApplication(page, log)
    } catch (err: any) {
      if (err instanceof ReflectionBlockedError) {
        return { success: false, step: 'reflect', message: err.message, blocked: true, proxySessionId }
      }
      return { success: false, step: 'reflect', message: String(err?.message || err), blocked: false, proxySessionId }
    }

    return { success: true, step: 'done', message: '登録・反映申請が完了しました', blocked: false, proxySessionId }
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('main()で捕捉されなかったエラー:', err)
  process.exit(1)
})
