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
  postBlogArticle,
  fetchReviewList,
  postReviewReply,
  launchBrowser,
  closeAnonymizedProxy,
  handleGroupTopIfPresent,
  ReflectionBlockedError,
  type StylePostInput,
  type BlogPostInput,
  type ReviewListRow,
  type PostReviewReplyInput,
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
  // 複数サロンアカウント対応: ログイン後の「サロン一覧」中間ページで
  // クリックすべき対象サロンのSTORE_ID。未選択(単一サロンアカウント等)ならnull。
  targetStoreId?: string | null
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

// 2026-08-15追記: ECS RunTaskのcontainerOverrides.environmentでJOB_TYPEを
// 渡し、style/blogどちらのジョブかをここで振り分ける(src/lib/aws-ecs.tsの
// runStylePostTask/runBlogPostTask参照)。既存のstyleジョブはJOB_TYPEを
// 付けずに投入されることが無いよう、appデプロイ側で必ず付与しているが、
// 念のため未設定時はstyleとして扱う(後方互換)。
async function main(): Promise<void> {
  const apiBase = requireEnv('JOB_API_BASE')
  const jobId = requireEnv('JOB_ID')
  const jobToken = requireEnv('JOB_TOKEN')
  const jobType =
    process.env.JOB_TYPE === 'blog'
      ? 'blog'
      : process.env.JOB_TYPE === 'review_sync'
        ? 'review_sync'
        : process.env.JOB_TYPE === 'review_reply'
          ? 'review_reply'
          : 'style'

  const logs: string[] = []
  const log = (msg: string) => {
    console.log(msg)
    logs.push(msg)
  }

  if (jobType === 'blog') {
    let blogResult: Omit<BlogJobResult, 'logs'>
    try {
      const payload = await fetchBlogJob(apiBase, jobId, jobToken)
      blogResult = await runBlogJob(payload, log)
    } catch (err: any) {
      blogResult = {
        success: false,
        step: 'login',
        message: `ジョブ実行中に予期しないエラーが発生しました: ${String(err?.message || err)}`
      }
    }
    await postBlogResult(apiBase, jobId, jobToken, { ...blogResult, logs })
    process.exit(blogResult.success ? 0 : 1)
  }

  if (jobType === 'review_sync') {
    let reviewResult: Omit<ReviewSyncJobResult, 'logs'>
    try {
      const payload = await fetchReviewSyncJob(apiBase, jobId, jobToken)
      reviewResult = await runReviewSyncJob(payload, log)
    } catch (err: any) {
      reviewResult = {
        success: false,
        step: 'login',
        message: `ジョブ実行中に予期しないエラーが発生しました: ${String(err?.message || err)}`,
        rows: []
      }
    }
    await postReviewSyncResult(apiBase, jobId, jobToken, { ...reviewResult, logs })
    process.exit(reviewResult.success ? 0 : 1)
  }

  if (jobType === 'review_reply') {
    let replyResult: Omit<ReviewReplyJobResult, 'logs'>
    try {
      const payload = await fetchReviewReplyJob(apiBase, jobId, jobToken)
      replyResult = await runReviewReplyJob(payload, log)
    } catch (err: any) {
      replyResult = {
        success: false,
        step: 'login',
        message: `ジョブ実行中に予期しないエラーが発生しました: ${String(err?.message || err)}`
      }
    }
    await postReviewReplyResult(apiBase, jobId, jobToken, { ...replyResult, logs })
    process.exit(replyResult.success ? 0 : 1)
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

// ---------- ブログ投稿ジョブ(2026-08-15追記) ----------

type BlogJobPayload = {
  loginId: string
  password: string
  proxySessionCandidates?: string[] | null
  targetStoreId?: string | null
  article: Omit<BlogPostInput, 'imageBuffer'> & { imageBase64: string | null }
}

type BlogJobStep = 'login' | 'navigate' | 'form_fill' | 'image_upload' | 'confirm' | 'submit' | 'done'

type BlogJobResult = {
  success: boolean
  step: BlogJobStep
  message: string
  logs: string[]
  proxySessionId?: string | null
  loginAttempts?: LoginAttempt[]
}

async function fetchBlogJob(apiBase: string, jobId: string, jobToken: string): Promise<BlogJobPayload> {
  const res = await fetch(`${apiBase}/api/blog-automation/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${jobToken}` }
  })
  if (!res.ok) throw new Error(`ジョブ取得に失敗しました(status=${res.status})`)
  return (await res.json()) as BlogJobPayload
}

async function postBlogResult(apiBase: string, jobId: string, jobToken: string, result: BlogJobResult): Promise<void> {
  try {
    await fetch(`${apiBase}/api/blog-automation/jobs/${jobId}/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    })
  } catch (err) {
    console.error('結果の送信に失敗しました:', err)
  }
}

/**
 * ブログ投稿は「登録」→「反映申請」の2段階が無い1回きりの操作のため、
 * style側のtryDraftWithRetries(同一セッション内での複数回リトライ)は
 * 設けず、ログインセッション単位でのプロキシ候補切り替えのみ行う
 * (attemptLogin/closeAttemptはstyle側と共通のものをそのまま使う)。
 */
async function runBlogJob(payload: BlogJobPayload, log: (msg: string) => void): Promise<Omit<BlogJobResult, 'logs'>> {
  const candidates = (payload.proxySessionCandidates || []).slice(0, 5)
  const loginAttempts: LoginAttempt[] = []

  const { imageBase64, ...articleRest } = payload.article
  const articleInput: BlogPostInput = {
    ...articleRest,
    imageBuffer: imageBase64 ? base64ToArrayBuffer(imageBase64) : null
  }

  const styleLikePayload = { loginId: payload.loginId, password: payload.password, targetStoreId: payload.targetStoreId }

  let attempt = await attemptLogin(styleLikePayload, log, candidates[0])
  if (candidates[0]) loginAttempts.push({ sessionId: candidates[0], success: !attempt.error })

  let postError: any = attempt.error ? null : new Error('未試行')
  if (!attempt.error) {
    try {
      await postBlogArticle(attempt.page!, articleInput, log)
      postError = null
    } catch (err: any) {
      postError = err
    }
  }

  for (let i = 1; i < candidates.length && (attempt.error || postError); i++) {
    const reason = attempt.error ? 'ログイン' : 'ブログ投稿'
    log(`[プロキシ] セッションID(${candidates[i - 1]})での${reason}に失敗したため、次の候補セッションID(${candidates[i]})へ切り替えて再ログインします...`)
    await closeAttempt(attempt)
    attempt = await attemptLogin(styleLikePayload, log, candidates[i])
    loginAttempts.push({ sessionId: candidates[i], success: !attempt.error })
    postError = attempt.error ? null : new Error('未試行')
    if (!attempt.error) {
      try {
        await postBlogArticle(attempt.page!, articleInput, log)
        postError = null
      } catch (err: any) {
        postError = err
      }
    }
  }

  try {
    const { proxySessionId, error: loginError } = attempt
    if (loginError) {
      return { success: false, step: 'login', message: String(loginError?.message || loginError), proxySessionId: null, loginAttempts }
    }
    if (postError) {
      return { success: false, step: 'submit', message: String(postError?.message || postError), proxySessionId, loginAttempts }
    }
    return { success: true, step: 'done', message: 'ブログ登録が完了しました', proxySessionId, loginAttempts }
  } finally {
    await closeAttempt(attempt)
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = Buffer.from(base64, 'base64')
  return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer
}

// ---------- 口コミ管理ツール 同期ジョブ(2026-08-16追記) ----------
// サロンボード口コミ一覧の巡回のみを行う(Puppeteer/ログインが必要な部分)。
// HPB公開口コミ一覧との突合はアプリ側(fetch()のみで完結、ログイン不要)で
// 行うため、ワーカーはHPBには一切アクセスしない。

type ReviewSyncJobPayload = {
  loginId: string
  password: string
  proxySessionCandidates?: string[] | null
  targetStoreId?: string | null
  /** この管理番号に到達したら打ち切る(月次差分同期用)。全件バックフィルはnull */
  stopAtManagementNo?: string | null
}

type ReviewSyncJobStep = 'login' | 'navigate' | 'list_fetch' | 'done'

type ReviewSyncJobResult = {
  success: boolean
  step: ReviewSyncJobStep
  message: string
  logs: string[]
  proxySessionId?: string | null
  loginAttempts?: LoginAttempt[]
  rows: ReviewListRow[]
}

async function fetchReviewSyncJob(apiBase: string, jobId: string, jobToken: string): Promise<ReviewSyncJobPayload> {
  const res = await fetch(`${apiBase}/api/review-automation/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${jobToken}` }
  })
  if (!res.ok) throw new Error(`ジョブ取得に失敗しました(status=${res.status})`)
  return (await res.json()) as ReviewSyncJobPayload
}

async function postReviewSyncResult(
  apiBase: string,
  jobId: string,
  jobToken: string,
  result: ReviewSyncJobResult
): Promise<void> {
  try {
    await fetch(`${apiBase}/api/review-automation/jobs/${jobId}/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    })
  } catch (err) {
    console.error('結果の送信に失敗しました:', err)
  }
}

/**
 * 口コミ一覧の巡回は読み取り専用(何かを送信・登録するわけではない)ため、
 * blog側のような「同一セッション内での複数回リトライ」は不要。ログイン
 * セッション単位でのプロキシ候補切り替えのみ行う。
 */
async function runReviewSyncJob(
  payload: ReviewSyncJobPayload,
  log: (msg: string) => void
): Promise<Omit<ReviewSyncJobResult, 'logs'>> {
  const candidates = (payload.proxySessionCandidates || []).slice(0, 5)
  const loginAttempts: LoginAttempt[] = []

  const styleLikePayload = { loginId: payload.loginId, password: payload.password, targetStoreId: payload.targetStoreId }

  let attempt = await attemptLogin(styleLikePayload, log, candidates[0])
  if (candidates[0]) loginAttempts.push({ sessionId: candidates[0], success: !attempt.error })

  let rows: ReviewListRow[] = []
  let fetchError: any = attempt.error ? null : new Error('未試行')
  if (!attempt.error) {
    try {
      rows = await fetchReviewList(attempt.page!, log, { stopAtManagementNo: payload.stopAtManagementNo })
      fetchError = null
    } catch (err: any) {
      fetchError = err
    }
  }

  for (let i = 1; i < candidates.length && (attempt.error || fetchError); i++) {
    const reason = attempt.error ? 'ログイン' : '口コミ一覧の取得'
    log(`[プロキシ] セッションID(${candidates[i - 1]})での${reason}に失敗したため、次の候補セッションID(${candidates[i]})へ切り替えて再ログインします...`)
    await closeAttempt(attempt)
    attempt = await attemptLogin(styleLikePayload, log, candidates[i])
    loginAttempts.push({ sessionId: candidates[i], success: !attempt.error })
    fetchError = attempt.error ? null : new Error('未試行')
    if (!attempt.error) {
      try {
        rows = await fetchReviewList(attempt.page!, log, { stopAtManagementNo: payload.stopAtManagementNo })
        fetchError = null
      } catch (err: any) {
        fetchError = err
      }
    }
  }

  try {
    const { proxySessionId, error: loginError } = attempt
    if (loginError) {
      return { success: false, step: 'login', message: String(loginError?.message || loginError), proxySessionId: null, loginAttempts, rows: [] }
    }
    if (fetchError) {
      return { success: false, step: 'list_fetch', message: String(fetchError?.message || fetchError), proxySessionId, loginAttempts, rows: [] }
    }
    return { success: true, step: 'done', message: `口コミ一覧を${rows.length}件取得しました`, proxySessionId, loginAttempts, rows }
  } finally {
    await closeAttempt(attempt)
  }
}

// ---------- 口コミ自動返信(2026-08-17追記) ----------

type ReviewReplyJobPayload = {
  loginId: string
  password: string
  proxySessionCandidates?: string[] | null
  targetStoreId?: string | null
  managementNo: string
  replyContent: string
}

type ReviewReplyJobStep = 'login' | 'navigate' | 'input' | 'confirm' | 'done'

type ReviewReplyJobResult = {
  success: boolean
  step: ReviewReplyJobStep
  message: string
  logs: string[]
  proxySessionId?: string | null
  loginAttempts?: LoginAttempt[]
}

async function fetchReviewReplyJob(apiBase: string, jobId: string, jobToken: string): Promise<ReviewReplyJobPayload> {
  const res = await fetch(`${apiBase}/api/review-reply-automation/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${jobToken}` }
  })
  if (!res.ok) throw new Error(`ジョブ取得に失敗しました(status=${res.status})`)
  return (await res.json()) as ReviewReplyJobPayload
}

async function postReviewReplyResult(
  apiBase: string,
  jobId: string,
  jobToken: string,
  result: ReviewReplyJobResult
): Promise<void> {
  try {
    await fetch(`${apiBase}/api/review-reply-automation/jobs/${jobId}/result`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(result)
    })
  } catch (err) {
    console.error('結果の送信に失敗しました:', err)
  }
}

/**
 * ブログ投稿(runBlogJob)と同じ、1回きりの操作向けの構成
 * (ログインセッション単位でのプロキシ候補切り替えのみ)。
 */
async function runReviewReplyJob(
  payload: ReviewReplyJobPayload,
  log: (msg: string) => void
): Promise<Omit<ReviewReplyJobResult, 'logs'>> {
  const candidates = (payload.proxySessionCandidates || []).slice(0, 5)
  const loginAttempts: LoginAttempt[] = []

  const replyInput: PostReviewReplyInput = { managementNo: payload.managementNo, replyContent: payload.replyContent }
  const styleLikePayload = { loginId: payload.loginId, password: payload.password, targetStoreId: payload.targetStoreId }

  let attempt = await attemptLogin(styleLikePayload, log, candidates[0])
  if (candidates[0]) loginAttempts.push({ sessionId: candidates[0], success: !attempt.error })

  let postError: any = attempt.error ? null : new Error('未試行')
  if (!attempt.error) {
    try {
      await postReviewReply(attempt.page!, replyInput, log)
      postError = null
    } catch (err: any) {
      postError = err
    }
  }

  for (let i = 1; i < candidates.length && (attempt.error || postError); i++) {
    const reason = attempt.error ? 'ログイン' : '口コミ返信投稿'
    log(`[プロキシ] セッションID(${candidates[i - 1]})での${reason}に失敗したため、次の候補セッションID(${candidates[i]})へ切り替えて再ログインします...`)
    await closeAttempt(attempt)
    attempt = await attemptLogin(styleLikePayload, log, candidates[i])
    loginAttempts.push({ sessionId: candidates[i], success: !attempt.error })
    postError = attempt.error ? null : new Error('未試行')
    if (!attempt.error) {
      try {
        await postReviewReply(attempt.page!, replyInput, log)
        postError = null
      } catch (err: any) {
        postError = err
      }
    }
  }

  try {
    const { proxySessionId, error: loginError } = attempt
    if (loginError) {
      return { success: false, step: 'login', message: String(loginError?.message || loginError), proxySessionId: null, loginAttempts }
    }
    if (postError) {
      return { success: false, step: 'input', message: String(postError?.message || postError), proxySessionId, loginAttempts }
    }
    return { success: true, step: 'done', message: '口コミへの返信投稿が完了しました', proxySessionId, loginAttempts }
  } finally {
    await closeAttempt(attempt)
  }
}

type LoginAttemptResult = LaunchedBrowser & { page: Page | null; error: any; topPageUrl: string | null }

/**
 * 2026-08-13追記: proxy-chain方式では、セッションID(出口IP)ごとに専用の
 * ローカル取次プロキシをブラウザ起動時に紐付ける必要があるため、以前のように
 * 1つのブラウザを使い回してページだけ差し替える方式が使えなくなった。
 * 候補セッションIDごとに、ブラウザの起動からやり直す。
 */
type LoginCredentials = { loginId: string; password: string; targetStoreId?: string | null }

async function attemptLogin(
  payload: LoginCredentials,
  log: (msg: string) => void,
  candidateId?: string
): Promise<LoginAttemptResult> {
  const launched = await launchBrowser(candidateId)
  try {
    const page = await newAutomationPage(launched.browser, log)
    try {
      await loginToSalonBoard(page, payload.loginId, payload.password, log)
      // 複数サロンアカウント対応: ログイン直後に「サロン一覧」中間ページが
      // 出た場合、対象サロンを確定させる。ワーカーはユーザーに質問できない
      // ため、確定できない場合(未選択で2件以上、または選択済みSTORE_IDが
      // 見つからない)は明確なエラーとして失敗させる。
      const groupTopResult = await handleGroupTopIfPresent(page, payload.targetStoreId, log)
      if (groupTopResult.status === 'needs_selection' || groupTopResult.status === 'target_not_found') {
        throw new Error(
          'サロン選択が必要です。設定画面でサロンを選び直してください' +
            `(検出されたサロン: ${groupTopResult.salons.map((s) => `${s.type}:${s.storeId}(${s.name})`).join(', ') || 'なし'})`
        )
      }
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
    const reason = attempt.error ? 'ログイン' : `スタイル下書き登録(${MAX_DRAFT_ATTEMPTS_PER_SESSION}回試行済み)`
    log(
      `[プロキシ] セッションID(${candidates[i - 1]})での${reason}に失敗したため、` +
        `実績に関わらず次の候補セッションID(${candidates[i]})へ強制的に切り替えて再ログインします...`
    )
    await closeAttempt(attempt)
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
