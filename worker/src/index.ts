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

// 2026-08-13追記(方針転換3): 「同じセッションで複数回リトライ」→「駄目なら
// 次のIPへ強制切替」という2段階の仕組みは、タイムアウト増加の一因になって
// いた(ログイン失敗には早期失敗検知が無いため、ログイン絡みの失敗が続くと
// 1候補あたり最大30秒前後を律儀に待ってしまう上、候補数が最大5個あった)。
// ルールをシンプルにし、ログイン・投稿(下書き登録)のどちらで失敗しても
// 即座に次のIPへ切り替えて再ログインからやり直す方式に統一する。
// 1スタイルあたりの試行回数は最大MAX_ATTEMPTS_PER_STYLE回(=最大で
// この数のIPを試す)。投稿(下書き登録)が成功した場合は、そのIP/セッションの
// ままリトライループを抜け、反映申請まで継続する(切り替えない)。
//
// 2026-08-13追記(方針転換4・ユーザー指定ルール): 試行回数の上限を3→5に
// 引き上げる一方、「画像アップロード自体は成功したが、後続工程(フォーム
// 入力・登録確認等)で失敗した」場合に限り、IPを切り替えて最初からやり直す
// (=同じ画像をもう一度アップロードし直す)ことをせず、その時点でこの
// スタイルの投稿を打ち切る。理由: リトライのたびに画像(最大300KB)を
// 送り直すことになり、プロキシの通信量を無駄に消費するため
// (draftRegisterStyleがdraftError.afterUploadSuccess=trueを付けて
// この状態を通知する)。打ち切られたスタイルは翌日以降の定期実行・
// 手動実行で改めて対象になる。
const MAX_ATTEMPTS_PER_STYLE = 5

async function runJob(payload: JobPayload, log: (msg: string) => void): Promise<Omit<JobResult, 'logs'>> {
  const candidates = (payload.proxySessionCandidates || []).slice(0, MAX_ATTEMPTS_PER_STYLE)
  const attemptCount = Math.max(candidates.length, 1)
  const loginAttempts: LoginAttempt[] = []

  const { imageBase64, ...styleRest } = payload.style
  const styleInput: StylePostInput = {
    ...styleRest,
    imageBuffer: base64ToArrayBuffer(imageBase64)
  }

  let attempt = await attemptLogin(payload, log, candidates[0])
  if (candidates[0]) loginAttempts.push({ sessionId: candidates[0], success: !attempt.error })

  let draftError: any = null
  if (!attempt.error) {
    try {
      await draftRegisterStyle(attempt.page!, styleInput, log)
    } catch (err: any) {
      draftError = err
      if (err?.afterUploadSuccess) {
        log(
          '画像アップロードは成功しましたが、後続工程で失敗しました。' +
            '通信量の浪費を避けるためIP切り替えは行わず、このスタイルの投稿を打ち切ります。'
        )
      }
    }
  }

  for (let i = 1; i < attemptCount && (attempt.error || draftError) && !draftError?.afterUploadSuccess; i++) {
    // 2026-08-13追記(診断強化): 実際のエラーメッセージ(診断情報込み)を
    // ログに含め、CAPTCHAだったのか通信エラーだったのか後から判別できるようにする。
    const reason = attempt.error
      ? `ログイン(${String(attempt.error?.message || attempt.error).slice(0, 300)})`
      : `スタイル下書き登録(${String(draftError?.message || draftError).slice(0, 300)})`
    log(
      `[プロキシ] セッションID(${candidates[i - 1] ?? '不明'})での${reason}に失敗したため、` +
        `次の候補セッションID(${candidates[i] ?? '(ランダム)'})へ切り替えて再ログインします...(試行${i + 1}/${attemptCount})`
    )
    await closeAttempt(attempt)
    // 短時間に複数の別IPから同じアカウントへ連続ログインすること自体が
    // SALON BOARD/Akamai側に不審な挙動として警戒される可能性を考慮し、
    // 切り替え前に間隔を空ける。2026-08-13追記: 4秒では短すぎ、
    // 「数十秒おきに別IPから連続ログイン」という機械的なパターンに
    // 見えてしまう懸念があるため20秒に延長した(5回試行してもECSタスクの
    // 10分タイムアウトには十分収まる)。
    await sleep(20000)
    attempt = await attemptLogin(payload, log, candidates[i])
    if (candidates[i]) loginAttempts.push({ sessionId: candidates[i], success: !attempt.error })

    draftError = null
    if (!attempt.error) {
      try {
        await draftRegisterStyle(attempt.page!, styleInput, log)
      } catch (err: any) {
        draftError = err
        if (err?.afterUploadSuccess) {
          log(
            '画像アップロードは成功しましたが、後続工程で失敗しました。' +
              '通信量の浪費を避けるためIP切り替えは行わず、このスタイルの投稿を打ち切ります。'
          )
        }
      }
    }
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
