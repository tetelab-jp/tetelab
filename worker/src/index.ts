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
  style: Omit<StylePostInput, 'imageBuffer'> & { imageBase64: string }
}

type JobStep = 'login' | 'navigate' | 'draft_register' | 'image_upload' | 'reflect' | 'done'

type JobResult = {
  success: boolean
  step: JobStep
  message: string
  blocked: boolean
  logs: string[]
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
    const page = await newAutomationPage(browser, log)

    try {
      await loginToSalonBoard(page, payload.loginId, payload.password, log)
    } catch (err: any) {
      return { success: false, step: 'login', message: String(err?.message || err), blocked: false }
    }

    const { imageBase64, ...styleRest } = payload.style
    const styleInput: StylePostInput = {
      ...styleRest,
      imageBuffer: base64ToArrayBuffer(imageBase64)
    }

    try {
      await draftRegisterStyle(page, styleInput, log)
    } catch (err: any) {
      return { success: false, step: 'draft_register', message: String(err?.message || err), blocked: false }
    }

    try {
      await submitReflectApplication(page, log)
    } catch (err: any) {
      if (err instanceof ReflectionBlockedError) {
        return { success: false, step: 'reflect', message: err.message, blocked: true }
      }
      return { success: false, step: 'reflect', message: String(err?.message || err), blocked: false }
    }

    return { success: true, step: 'done', message: '登録・反映申請が完了しました', blocked: false }
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error('main()で捕捉されなかったエラー:', err)
  process.exit(1)
})
