import { Hono } from 'hono'
import {
  requireAuth,
  requireStyleEnabled,
  requireBlogEnabled,
  requireReviewEnabled,
  requireImpersonated
} from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import {
  runStyleAutomationForUser,
  runNextStyleForUser,
  retryStylePost,
  currentJstTimeLabel,
  getStyleRowForJob,
  getStyleNo,
  sweepStaleJobs,
  updateConsecutiveFailureAndNotify,
  finalizeRunIfComplete
} from '../lib/style-post-runner'
import {
  runBlogAutomationForUser,
  runNextArticleForUser,
  retryBlogPost,
  getArticleRowForJob,
  sweepStaleBlogJobs,
  updateBlogConsecutiveFailureAndNotify,
  finalizeBlogRunIfComplete
} from '../lib/blog-post-runner'
import { enqueueReviewSyncJob, processReviewSyncResult, type ReviewSyncJobRow } from '../lib/review-sync-runner'
import type { SalonBoardReviewRow } from '../lib/review-match'
import { updateReviewReplyConsecutiveFailureAndNotify } from '../lib/review-reply-runner'
import { decryptSecret, timingSafeEqual } from '../lib/crypto'
import { formatJstDate } from '../lib/date-format'
import type { Bindings, AppUser } from '../types'

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

const automation = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

// 2026-08-12追記: 当時のBright Data契約が少数(5個)の専用固定IPのプールだった
// ため、「新しいセッションID=未知のIP」ではなく常にこの5つの中のどれかを
// 使うことになっていた。そのためプール内の各セッションIDごとに連続障害回数を
// 記録し(DB: proxy_session_pool_stats)、その時点で最も調子の良いものを
// 優先的に選ぶ仕組みにしていた。
//
// 2026-08-13追記(方針転換): プロキシ契約をDataImpulse(日本国内だけで
// 2,300IPの大きなレジデンシャルプール)へ変更した。実機ログで「1件目の
// 投稿は成功、直後の2件目は同じ症状(net::ERR_ABORTED)で失敗」という
// パターンが確認され、固定プール運用時代の「調子の良いIPを使い回す」
// 選び方そのものが、直前に使ったIPをSALON BOARD/Akamai側に警戒される
// 原因になっている可能性が浮上した。プールが十分大きいDataImpulseでは
// IPを使い回す利点がそもそも無いため、実績追跡(proxy_session_pool_stats)は
// 廃止し、ジョブ(投稿1回)ごとに毎回ランダムな新しいセッションIDを
// 生成するだけのシンプルな方式に変更する。
// 2026-08-13追記(方針転換4): ワーカー側の試行上限を3→5に引き上げた
// (worker/src/index.ts の MAX_ATTEMPTS_PER_STYLE 参照)。ただし画像
// アップロード成功後に後続工程で失敗した場合はIP切り替えを行わず
// 即座に打ち切るため、実際に5回すべて使い切るのはログイン失敗が
// 連続するケースなど一部に限られる。候補生成数も合わせて5にする。
// 2026-08-13追記2(ユーザー指定): 3〜4回目の試行で成功する実例が確認できた
// ため5→10に引き上げ。候補生成数も合わせる。
const PROXY_CANDIDATE_COUNT = 10

function randomSessionId(): string {
  return Math.random().toString(36).slice(2, 10)
}

// ---------- 手動実行・履歴画面 ----------

const EXECUTION_TYPE_LABEL: Record<string, string> = {
  register_style: '登録',
  request_reflection: '反映申請',
  post_blog_article: 'ブログ投稿'
}

const LOG_RESULT_LABEL: Record<string, string> = {
  success: '完了',
  blocked: 'ブロック',
  failure: '失敗'
}

const LOG_RESULT_COLOR: Record<string, string> = {
  success: 'bg-green-50 text-green-600',
  blocked: 'bg-amber-50 text-amber-600',
  failure: 'bg-red-50 text-red-600'
}

const LOG_RESULT_BORDER: Record<string, string> = {
  success: 'border-green-500',
  blocked: 'border-amber-500',
  failure: 'border-red-500'
}

type ExecutionLogRow = {
  id: number
  dateLabel: string
  category: string
  categoryClass: string
  content: any
  contentLabel: any
  contentName: any
  statusLabel: string
  statusClass: string
  borderClass: string
  errorText: string
  showToggle: boolean
}

// 2026-08-21追記(ユーザー指定): 「投稿ログ」列(エラーメッセージ等の詳細)は
// サロン間で見えてはいけない情報を含みうるため、なりすましログイン中のみ表示し、
// 通常のサロンログインでは列自体を非表示にする(ページ自体は通常表示する)。
function ExecutionLogTable({ rows, tableId, showPostLog }: { rows: ExecutionLogRow[]; tableId: string; showPostLog: boolean }) {
  if (rows.length === 0) {
    return <p class="text-sm text-gray-400">まだログがありません</p>
  }
  const dateColId = `log-col-date-${tableId}`
  const categoryColId = `log-col-category-${tableId}`
  return (
    <>
      {/* PC表示: テーブル */}
      <div class="hidden md:block overflow-x-auto">
        {/* 2026-08-13追記: 成功時も投稿ログに全工程の経過を載せるようにしたため、
            table-fixedで列幅を固定しないと投稿ログ列が際限なく横に伸びてしまい、
            line-clamp-2(2行省略)が実質効かなくなる(横に長い1〜2行に収まって
            しまい省略の意味がなくなる)不具合があった。列幅を明示して防ぐ。
            2026-08-15追記(ユーザー指定): 実行日時・カテゴリ列は内容によっては
            この初期幅では狭いことがあるため、列境界をドラッグして横に広げられる
            ようにする(colのidをtest-run.jsから操作する。スタイル/ブログの
            2テーブルが同時にDOMへ存在するため、id重複を避けてtableIdで分ける)。 */}
        <table class="w-full text-sm table-fixed">
          <colgroup>
            <col id={dateColId} style="width:9%" />
            <col id={categoryColId} style="width:6%" />
            <col style={showPostLog ? 'width:25%' : 'width:45%'} />
            <col style={showPostLog ? 'width:8%' : 'width:20%'} />
            {showPostLog && <col style="width:52%" />}
          </colgroup>
          <thead>
            <tr class="text-left text-gray-400 border-b border-gray-100">
              <th class="py-2 pl-3 relative">
                実行日時
                <span
                  class="log-col-resize-handle absolute top-0 bottom-0 right-0 w-2 -mr-1 cursor-col-resize hover:bg-pink-200 active:bg-pink-300"
                  data-target-col={dateColId}
                ></span>
              </th>
              <th class="py-2 text-center relative">
                カテゴリ
                <span
                  class="log-col-resize-handle absolute top-0 bottom-0 right-0 w-2 -mr-1 cursor-col-resize hover:bg-pink-200 active:bg-pink-300"
                  data-target-col={categoryColId}
                ></span>
              </th>
              <th class="py-2">内容</th>
              <th class="py-2 text-center">ステータス</th>
              {showPostLog && <th class="py-2">投稿ログ</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr class="border-b border-gray-50">
                <td class={'py-2 pl-3 border-l-4 text-xs text-gray-500 whitespace-nowrap ' + r.borderClass}>
                  {r.dateLabel}
                </td>
                <td class="py-2 text-center">
                  <span class={'text-xs px-2 py-0.5 rounded font-semibold ' + r.categoryClass}>{r.category}</span>
                </td>
                <td class="py-2 text-xs text-gray-700 truncate">{r.content}</td>
                <td class="py-2 text-center">
                  <span class={'text-xs px-2 py-0.5 rounded font-semibold ' + r.statusClass}>{r.statusLabel}</span>
                </td>
                {showPostLog && (
                  <td class="py-2 text-xs text-gray-400">
                    <p class={'break-words' + (r.showToggle ? ' line-clamp-2' : '')}>{r.errorText}</p>
                    {r.showToggle && (
                      <button
                        type="button"
                        class="text-xs font-semibold text-pink-500 hover:underline mt-0.5"
                        onclick="const p=this.previousElementSibling; p.classList.toggle('line-clamp-2'); this.textContent = p.classList.contains('line-clamp-2') ? '続きを見る' : '閉じる'"
                      >
                        続きを見る
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* モバイル表示: カード */}
      <div class="md:hidden space-y-3">
        {rows.map((r) => (
          <div class={'rounded-lg border-l-4 bg-gray-50 p-3 ' + r.borderClass}>
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-gray-500">{r.dateLabel}</span>
              <span class={'text-xs px-2 py-0.5 rounded font-semibold ' + r.statusClass}>{r.statusLabel}</span>
            </div>
            <div class="flex items-center gap-2 mt-1.5">
              <span class={'text-xs px-2 py-0.5 rounded font-semibold flex-shrink-0 ' + r.categoryClass}>
                {r.category}
              </span>
              {r.contentLabel}
            </div>
            <div class="text-sm text-gray-700 mt-0.5 truncate">{r.contentName}</div>
            {showPostLog && r.errorText !== '-' && (
              <div class="mt-1.5">
                <p class={'text-xs text-gray-400 break-words' + (r.showToggle ? ' line-clamp-2' : '')}>
                  {r.errorText}
                </p>
                {r.showToggle && (
                  <button
                    type="button"
                    class="text-xs font-semibold text-pink-500 hover:underline mt-0.5"
                    onclick="const p=this.previousElementSibling; p.classList.toggle('line-clamp-2'); this.textContent = p.classList.contains('line-clamp-2') ? '続きを見る' : '閉じる'"
                  >
                    続きを見る
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

// 2026-08-21追記(ユーザー指定): ページ自体は通常のサロンログインでも表示する。
// 投稿ログ(エラーメッセージ等の詳細)だけがサロン間で見えてはいけない情報を
// 含むため、そちらはisImpersonated判定でExecutionLogTable内側のみ隠す
// (以前requireImpersonatedでページごとブロックしていたのは指示の意図と
// 異なっていたため戻す)。
automation.get('/style/test-run', requireAuth, async (c) => {
  const user = c.get('user')
  const showPostLog = user.is_impersonated === 1

  const { results: logs } = await c.env.DB.prepare(
    `SELECT l.id, l.status, l.message, l.execution_type, l.style_id, l.style_no, l.post_id, l.blog_article_id, l.created_at,
            s.title AS style_title, p.title AS post_title, ba.title AS blog_article_title
     FROM execution_logs l
     LEFT JOIN styles s ON s.id = l.style_id
     LEFT JOIN posts p ON p.id = l.post_id
     LEFT JOIN blog_articles ba ON ba.id = l.blog_article_id
     WHERE l.user_id = ? AND l.salon_id = ? ORDER BY l.id DESC LIMIT 30`
  )
    .bind(user.id, user.active_salon_id)
    .all<{
      id: number
      status: string
      message: string
      execution_type: string | null
      style_id: number | null
      style_no: number | null
      post_id: number | null
      blog_article_id: number | null
      created_at: string
      style_title: string | null
      post_title: string | null
      blog_article_title: string | null
    }>()

  const logRows = (logs || []).map((l) => {
    const category = l.post_id || l.blog_article_id ? 'ブログ' : 'スタイル'
    const errorText = (l.message || '').slice(0, 10000)
    const contentLabel = l.execution_type && (
      <span class="text-xs font-semibold text-gray-400">
        [{EXECUTION_TYPE_LABEL[l.execution_type] || l.execution_type}]
      </span>
    )
    const contentName = l.style_id ? (
      <a href={`/style/${l.style_id}/edit`} class="hover:text-pink-600 hover:underline">
        No.{l.style_no ?? l.style_id} {l.style_title || '(無題)'}
      </a>
    ) : l.post_id ? (
      l.post_title || `投稿${l.post_id}`
    ) : l.blog_article_id ? (
      l.blog_article_title || `記事${l.blog_article_id}`
    ) : (
      '-'
    )
    return {
      id: l.id,
      dateLabel: formatJstDate(l.created_at),
      category,
      categoryClass: category === 'ブログ' ? 'bg-purple-50 text-purple-600' : 'bg-blue-50 text-blue-600',
      content: (
        <>
          {contentLabel && <span class="mr-1">{contentLabel}</span>}
          {contentName}
        </>
      ),
      contentLabel,
      contentName,
      statusLabel: LOG_RESULT_LABEL[l.status] || l.status,
      statusClass: LOG_RESULT_COLOR[l.status] || 'bg-gray-100 text-gray-500',
      borderClass: LOG_RESULT_BORDER[l.status] || 'border-gray-300',
      errorText: errorText || '-',
      showToggle: errorText.length > 150
    }
  })

  const styleLogRows = logRows.filter((r) => r.category === 'スタイル')
  const blogLogRows = logRows.filter((r) => r.category === 'ブログ')

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}

      reviewEnabled={user.review_enabled !== 0}

      isImpersonated={user.is_impersonated === 1}
      active="style-test-run"
      salonName={user.salon_name}
      title="実行履歴"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
    >
      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-3"><i class="fas fa-list-check mr-2 text-pink-500"></i>個別実行ログ（直近30件）</p>

        <div class="flex gap-1 mb-4 border-b border-gray-100">
          <button
            type="button"
            class="log-tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-pink-500 text-pink-600"
            data-tab="style"
          >
            スタイル（{styleLogRows.length}）
          </button>
          <button
            type="button"
            class="log-tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-gray-400"
            data-tab="blog"
          >
            ブログ（{blogLogRows.length}）
          </button>
        </div>

        <div data-tab-panel="style">
          <ExecutionLogTable rows={styleLogRows} tableId="style" showPostLog={showPostLog} />
        </div>
        <div data-tab-panel="blog" class="hidden">
          <ExecutionLogTable rows={blogLogRows} tableId="blog" showPostLog={showPostLog} />
        </div>
      </div>

      <script src="/static/test-run.js"></script>
    </PageLayout>,
    { title: '実行履歴' }
  )
})

// ---------- 手動実行API（ログイン中ユーザー本人のみ） ----------

// 2026-08-17追記(ユーザー指定): 手動実行は一般ユーザーには提供せず、
// 管理者サイトの「なりすましログイン」経由(検証用)のみに限定する。
automation.post('/api/automation/test-run', requireAuth, requireStyleEnabled, requireImpersonated, async (c) => {
  const user = c.get('user')
  try {
    const summary = await runStyleAutomationForUser(c.env, user.id, user.active_salon_id, 'manual-test')
    return c.json({
      success: summary.dispatchedCount > 0,
      dispatchedCount: summary.dispatchedCount,
      failedToDispatchCount: summary.failedToDispatchCount,
      totalImages: summary.totalImages,
      status: summary.status,
      error: summary.errorMessage
    })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err) }, 400)
  }
})

// ---------- 個別スタイルの再実行API(docs/phase3-mvp-design.md 5-6) ----------

automation.post('/api/style/:id/retry', requireAuth, requireStyleEnabled, async (c) => {
  const user = c.get('user')
  const styleId = Number(c.req.param('id'))
  try {
    const result = await retryStylePost(c.env, user.id, user.active_salon_id, styleId)
    return c.json({ success: result.outcome === 'dispatched', outcome: result.outcome })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err) }, 400)
  }
})

// ---------- AWS Fargateワーカー向けジョブAPI ----------
// Bearer認証はユーザーセッションではなく、style_post_jobs.job_token
// (ジョブ発行時に生成される使い捨てシークレット)で行う。

automation.get('/api/automation/jobs/:id', async (c) => {
  const jobId = Number(c.req.param('id'))
  const authHeader = c.req.header('Authorization') || ''

  const job = await c.env.DB.prepare(
    `SELECT id, style_id, user_id, salon_id, job_token, status FROM style_post_jobs WHERE id = ?`
  )
    .bind(jobId)
    .first<{ id: number; style_id: number; user_id: number; salon_id: number | null; job_token: string; status: string }>()

  if (!job || !timingSafeEqual(authHeader, `Bearer ${job.job_token}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({ error: 'job already completed' }, 409)
  }

  const cred = await c.env.DB.prepare(
    `SELECT salonboard_login_id_enc, salonboard_password_enc, last_successful_proxy_session_id, target_store_id
     FROM salon_credentials WHERE user_id = ?`
  )
    .bind(job.user_id)
    .first<{
      salonboard_login_id_enc: string
      salonboard_password_enc: string
      last_successful_proxy_session_id: string | null
      target_store_id: string | null
    }>()
  if (!cred || !c.env.ENCRYPTION_KEY) {
    return c.json({ error: 'credentials not available' }, 500)
  }

  // 複数サロンワークスペース対応: ジョブが属するワークスペース(job.salon_id)の
  // STORE_IDを使う(salon_credentials.target_store_idは1ユーザーにつき1件しか
  // 持てないため、2サロン目のジョブに対して使うと誤ったサロンに投稿してしまう)。
  // salon_idが無い(移行前の異常系)場合のみ、従来通りcred.target_store_idに
  // フォールバックする。
  let targetStoreId = cred.target_store_id || null
  if (job.salon_id) {
    const salon = await c.env.DB.prepare('SELECT salon_key FROM salonboard_salons WHERE id = ?')
      .bind(job.salon_id)
      .first<{ salon_key: string | null }>()
    if (salon?.salon_key) targetStoreId = salon.salon_key
  }

  const row = await getStyleRowForJob(c.env, job.style_id)
  if (!row || !row.front_r2_key) {
    return c.json({ error: 'style not available' }, 500)
  }

  const object = await c.env.STYLE_IMAGES.get(row.front_r2_key)
  if (!object) {
    return c.json({ error: 'image not found' }, 500)
  }
  const imageBuffer = await object.arrayBuffer()

  const loginId = await decryptSecret(cred.salonboard_login_id_enc, c.env.ENCRYPTION_KEY)
  const password = await decryptSecret(cred.salonboard_password_enc, c.env.ENCRYPTION_KEY)

  await c.env.DB.prepare(`UPDATE style_post_jobs SET status = 'running' WHERE id = ? AND status = 'pending'`)
    .bind(jobId)
    .run()

  // 2026-08-13追記3(ユーザー指定ルール): 投稿が成功したセッション(IP)は
  // 「次のスタイル投稿で失敗するまで」使い続ける。前回成功したセッションID
  // (salon_credentials.last_successful_proxy_session_id、結果コールバック側で
  // 更新・失敗時にクリアする)があれば候補の先頭に置き、それが失敗した場合の
  // 保険として残りは従来通りランダムな新しいセッションで埋める。
  const proxySessionCandidates = cred.last_successful_proxy_session_id
    ? [cred.last_successful_proxy_session_id, ...Array.from({ length: PROXY_CANDIDATE_COUNT - 1 }, () => randomSessionId())]
    : Array.from({ length: PROXY_CANDIDATE_COUNT }, () => randomSessionId())

  return c.json({
    loginId,
    password,
    proxySessionCandidates,
    targetStoreId,
    style: {
      styleImageId: row.id,
      imageBase64: arrayBufferToBase64(imageBuffer),
      imageFileName: row.front_file_name || `style-${row.id}.jpg`,
      styleName: (row.title || `スタイル${row.id}`).slice(0, 30),
      stylistSelectValue: row.stylist_select_value || '',
      stylistComment: row.comment || '',
      categoryCd: (row.category_value as 'SG01' | 'SG02') || 'SG01',
      hairLengthValue: row.length_value || '',
      menuContentsCdList: JSON.parse(row.menu_values_json || '[]'),
      menuDetailText: row.menu_detail_text || '',
      couponSelectValue: row.coupon_select_value || undefined,
      hashtags: JSON.parse(row.hashtags_json || '[]')
    }
  })
})

type JobResultBody = {
  success: boolean
  step: 'login' | 'navigate' | 'draft_register' | 'image_upload' | 'reflect' | 'done'
  message: string
  blocked: boolean
  logs: string[]
  proxySessionId?: string | null
  // 途中で失敗した候補セッションも含む、試行した候補ごとのログイン成否。
  loginAttempts?: { sessionId: string; success: boolean }[]
}

automation.post('/api/automation/jobs/:id/result', async (c) => {
  const jobId = Number(c.req.param('id'))
  const authHeader = c.req.header('Authorization') || ''

  const job = await c.env.DB.prepare(
    `SELECT id, style_id, user_id, salon_id, job_token, status, run_id, is_retry, is_auto_cycle FROM style_post_jobs WHERE id = ?`
  )
    .bind(jobId)
    .first<{
      id: number
      style_id: number
      user_id: number
      salon_id: number | null
      job_token: string
      status: string
      run_id: number | null
      is_retry: number
      is_auto_cycle: number
    }>()

  if (!job || !timingSafeEqual(authHeader, `Bearer ${job.job_token}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  // 既に結果を受信済み(二重コールバック・タイムアウト後の遅延コールバック等)は冪等に無視する
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({ ok: true, alreadyCompleted: true })
  }

  const body = await c.req.json<JobResultBody>().catch(() => null)
  if (!body) return c.json({ error: 'invalid body' }, 400)

  const { style_id: styleId, user_id: userId, salon_id: salonId } = job
  const diagnostics = body.logs && body.logs.length > 0 ? ` / 投稿ログ: ${body.logs.join(' | ')}` : ''
  const messageWithDiagnostics = (body.message + diagnostics).slice(0, 10000)
  // 2026-08-13追記(ユーザー指定): 成功時も、完了までの経過(ログイン〜各工程の
  // ログ)を「投稿ログ」として残す(従来は固定文言のみで経過が分からなかった)。
  const registerSuccessMessage = ('スタイル登録成功' + diagnostics).slice(0, 10000)
  const reflectSuccessMessage = ('反映申請成功' + diagnostics).slice(0, 10000)
  const styleNo = await getStyleNo(c.env, userId, salonId, styleId)

  // ログイン成否をsalon_credentials.connection_statusへ反映(ダッシュボードの連携ステータス表示用)
  if (body.step === 'login' && !body.success) {
    await c.env.DB.prepare(`UPDATE salon_credentials SET connection_status = 'failed', last_error = ? WHERE user_id = ?`)
      .bind(body.message.slice(0, 500), userId)
      .run()
      .catch(() => {})
  } else {
    await c.env.DB.prepare(`UPDATE salon_credentials SET connection_status = 'success', last_error = NULL WHERE user_id = ?`)
      .bind(userId)
      .run()
      .catch(() => {})
  }

  let jobStatus: string
  if (body.success) {
    await c.env.DB.prepare(
      `UPDATE styles SET salonboard_register_status = 'success', reflection_request_status = 'success',
         last_executed_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?`
    )
      .bind(styleId)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, salon_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, ?, 'register_style', 'success', ?)`
    )
      .bind(userId, salonId, styleId, styleNo, registerSuccessMessage)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, salon_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, ?, 'request_reflection', 'success', ?)`
    )
      .bind(userId, salonId, styleId, styleNo, reflectSuccessMessage)
      .run()
    jobStatus = 'success'
  } else if (body.step === 'reflect') {
    // 登録(下書き保存)自体は成功していたが、反映申請で失敗/ブロックされた
    const reflectStatus = body.blocked ? 'blocked' : 'failed'
    await c.env.DB.prepare(
      `UPDATE styles SET salonboard_register_status = 'success', reflection_request_status = ?,
         last_error = ?, last_executed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(reflectStatus, messageWithDiagnostics, styleId)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, salon_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, ?, 'register_style', 'success', ?)`
    )
      .bind(userId, salonId, styleId, styleNo, registerSuccessMessage)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, salon_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, ?, 'request_reflection', ?, ?)`
    )
      .bind(userId, salonId, styleId, styleNo, body.blocked ? 'blocked' : 'failure', `反映申請${body.blocked ? 'ブロック' : '失敗'}: ${messageWithDiagnostics}`)
      .run()
    jobStatus = reflectStatus
  } else {
    // login/navigate/draft_register/image_upload段階での失敗 = 登録自体が失敗。
    // reflection_request_statusも合わせて'failed'にしないと、前回の反映成功時の
    // 'success'が残ったままになり、登録スタイル一覧の表示が「公開」のままに
    // なってしまう(実機で確認済みの不具合)。
    await c.env.DB.prepare(
      `UPDATE styles SET salonboard_register_status = 'failed', reflection_request_status = 'failed', last_error = ?, last_executed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(messageWithDiagnostics, styleId)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, salon_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, ?, 'register_style', 'failure', ?)`
    )
      .bind(userId, salonId, styleId, styleNo, `スタイル登録失敗: ${messageWithDiagnostics}`)
      .run()
    jobStatus = 'failed'
  }

  // 2026-08-13追記3(ユーザー指定ルール): 投稿成功セッションを「次のスタイル
  // 投稿で失敗するまで」使い続けるための記録更新。成功時は実際に使われた
  // セッションID(body.proxySessionId、複数候補を試した場合は最終的に成功した
  // もの)を保存し、次のジョブの候補選定(GET /api/automation/jobs/:id)で
  // 先頭に使う。失敗時はクリアし、次のジョブが同じ失敗済みIPを引き継がない
  // ようにする。
  if (jobStatus === 'success' && body.proxySessionId) {
    await c.env.DB
      .prepare(
        `UPDATE salon_credentials SET last_successful_proxy_session_id = ?, last_successful_proxy_session_at = CURRENT_TIMESTAMP WHERE user_id = ?`
      )
      .bind(body.proxySessionId, userId)
      .run()
      .catch(() => {})
  } else if (jobStatus !== 'success') {
    await c.env.DB
      .prepare(`UPDATE salon_credentials SET last_successful_proxy_session_id = NULL WHERE user_id = ?`)
      .bind(userId)
      .run()
      .catch(() => {})
  }

  await updateConsecutiveFailureAndNotify(c.env, userId, job.salon_id, jobStatus === 'success')

  // 2026-08-14追記(ユーザー指定ルール): 60分おきの自動巡回で投稿に失敗した
  // スタイルは、次の自動投稿タイミングに1回だけ再トライする
  // (style-post-runner.tsのrunNextStyleForUser参照)。手動投稿(テスト実行・
  // 個別再実行ボタン)の失敗からは予約しない(is_auto_cycleで判定)。
  // このジョブ自体が既に「1回だけの再トライ」(is_retry=1)だった場合は、
  // たとえこれも失敗してもさらに再トライを予約しない(3回目はしない)。
  // 既に別の再トライが予約されている場合も上書きしない。
  if (jobStatus !== 'success' && job.is_auto_cycle && !job.is_retry) {
    await c.env.DB
      .prepare(
        `UPDATE style_post_schedules SET retry_pending_style_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND salon_id = ? AND retry_pending_style_id IS NULL`
      )
      .bind(styleId, userId, job.salon_id)
      .run()
      .catch(() => {})
  }

  await c.env.DB.prepare(
    `UPDATE style_post_jobs SET status = ?, result_step = ?, result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(jobStatus, body.step, messageWithDiagnostics, jobId)
    .run()

  // 2026-08-11追記(不具合修正): 実行履歴(style_post_runs)一覧のステータスが
  // 各ジョブの結果を集計せず常に'processing'のまま表示され続けていた。
  // このジョブが属するrunに紐づく全ジョブが完了(pending/running以外)に
  // なった時点で、run全体のステータスを確定させる(共通関数化、
  // sweepStaleJobs/resetStuckJobsForUser側からも同じ処理を呼ぶ)。
  if (job.run_id) {
    await finalizeRunIfComplete(c.env, job.run_id)
  }

  return c.json({ ok: true })
})

// ============================================
// ブログ記事の自動投稿(Phase 2)。上のスタイル投稿と同じ設計方針だが、
// ブログは「登録・反映する」ボタン1回で公開まで完了する1段階のフローの
// ため、reflect(反映申請)相当の別ステップは無い。
// ============================================

automation.post('/api/blog-automation/test-run', requireAuth, requireBlogEnabled, requireImpersonated, async (c) => {
  const user = c.get('user')
  try {
    const summary = await runBlogAutomationForUser(c.env, user.id, user.active_salon_id)
    return c.json({
      success: summary.dispatchedCount > 0,
      dispatchedCount: summary.dispatchedCount,
      failedToDispatchCount: summary.failedToDispatchCount,
      totalArticles: summary.totalArticles,
      status: summary.status,
      error: summary.errorMessage
    })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err) }, 400)
  }
})

automation.post('/api/blog-article/:id/retry', requireAuth, requireBlogEnabled, async (c) => {
  const user = c.get('user')
  const articleId = Number(c.req.param('id'))
  try {
    const result = await retryBlogPost(c.env, user.id, user.active_salon_id, articleId)
    return c.json({ success: result.outcome === 'dispatched', outcome: result.outcome })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err) }, 400)
  }
})

automation.get('/api/blog-automation/jobs/:id', async (c) => {
  const jobId = Number(c.req.param('id'))
  const authHeader = c.req.header('Authorization') || ''

  const job = await c.env.DB.prepare(
    `SELECT id, article_id, user_id, salon_id, run_id, job_token, status FROM blog_post_jobs WHERE id = ?`
  )
    .bind(jobId)
    .first<{
      id: number
      article_id: number
      user_id: number
      salon_id: number | null
      run_id: number | null
      job_token: string
      status: string
    }>()

  if (!job || !timingSafeEqual(authHeader, `Bearer ${job.job_token}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({ error: 'job already completed' }, 409)
  }

  const cred = await c.env.DB.prepare(
    `SELECT salonboard_login_id_enc, salonboard_password_enc, last_successful_proxy_session_id, target_store_id
     FROM salon_credentials WHERE user_id = ?`
  )
    .bind(job.user_id)
    .first<{
      salonboard_login_id_enc: string
      salonboard_password_enc: string
      last_successful_proxy_session_id: string | null
      target_store_id: string | null
    }>()
  if (!cred || !c.env.ENCRYPTION_KEY) {
    return c.json({ error: 'credentials not available' }, 500)
  }

  let targetStoreId = cred.target_store_id || null
  if (job.salon_id) {
    const salon = await c.env.DB.prepare('SELECT salon_key FROM salonboard_salons WHERE id = ?')
      .bind(job.salon_id)
      .first<{ salon_key: string | null }>()
    if (salon?.salon_key) targetStoreId = salon.salon_key
  }

  const row = await getArticleRowForJob(c.env, job.article_id)
  if (!row || !row.body) {
    return c.json({ error: 'article not available' }, 500)
  }

  // HPBブログカテゴリ(記事カテゴリ=生成テンプレート側の設定。記事自身の
  // カテゴリ選択とは別物)が未設定のまま投稿すると、SALON BOARD側のカテゴリ
  // 選択が必須項目バリデーションで弾かれ、確認画面(#reflect)へ進めずに失敗する
  // (2026-08-15、実機ログで確認済み)。ブラウザを起動する前にここで検知し、
  // 「記事カテゴリ」と「HPBブログカテゴリ」を混同しないよう、どの記事カテゴリの
  // どの設定が不足しているかを明示したメッセージで即座に失敗させる。
  if (!row.hpb_category_value) {
    const categoryLabel = row.category_name ? `記事カテゴリ「${row.category_name}」` : 'この記事の記事カテゴリ'
    const message = `${categoryLabel}にHPBブログカテゴリが設定されていません。生成テンプレート画面(記事カテゴリの設定)からHPBブログカテゴリを選択・保存してから再度お試しください`
    await c.env.DB.prepare(
      `UPDATE blog_post_jobs SET status = 'failed', result_step = 'form_fill', result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(message, jobId)
      .run()
    // 2026-08-15追記(ユーザー指定): 失敗しても承認状態は解除しない
    await c.env.DB.prepare(`UPDATE blog_articles SET last_error = ? WHERE id = ?`)
      .bind(message, job.article_id)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (blog_article_id, user_id, salon_id, execution_type, status, message)
       VALUES (?, ?, ?, 'post_blog_article', 'failure', ?)`
    )
      .bind(job.article_id, job.user_id, job.salon_id, message)
      .run()
    if (job.run_id) await finalizeBlogRunIfComplete(c.env, job.run_id)
    return c.json({ error: message }, 422)
  }

  let imageBase64: string | null = null
  if (row.image_r2_key) {
    const object = await c.env.STYLE_IMAGES.get(row.image_r2_key)
    if (object) imageBase64 = arrayBufferToBase64(await object.arrayBuffer())
  }

  const loginId = await decryptSecret(cred.salonboard_login_id_enc, c.env.ENCRYPTION_KEY)
  const password = await decryptSecret(cred.salonboard_password_enc, c.env.ENCRYPTION_KEY)

  await c.env.DB.prepare(`UPDATE blog_post_jobs SET status = 'running' WHERE id = ? AND status = 'pending'`)
    .bind(jobId)
    .run()

  const proxySessionCandidates = cred.last_successful_proxy_session_id
    ? [cred.last_successful_proxy_session_id, ...Array.from({ length: PROXY_CANDIDATE_COUNT - 1 }, () => randomSessionId())]
    : Array.from({ length: PROXY_CANDIDATE_COUNT }, () => randomSessionId())

  return c.json({
    loginId,
    password,
    proxySessionCandidates,
    targetStoreId,
    article: {
      title: (row.title || '').slice(0, 25),
      body: row.body || '',
      categoryValue: row.hpb_category_value || '',
      stylistSelectValue: row.stylist_select_value || '',
      couponSelectValue: row.coupon_select_value || undefined,
      imageBase64,
      imageFileName: row.image_file_name || (row.image_r2_key ? `blog-${row.id}.jpg` : null)
    }
  })
})

type BlogJobResultBody = {
  success: boolean
  step: 'login' | 'navigate' | 'form_fill' | 'image_upload' | 'confirm' | 'submit' | 'done'
  message: string
  logs: string[]
  proxySessionId?: string | null
  loginAttempts?: { sessionId: string; success: boolean }[]
}

automation.post('/api/blog-automation/jobs/:id/result', async (c) => {
  const jobId = Number(c.req.param('id'))
  const authHeader = c.req.header('Authorization') || ''

  const job = await c.env.DB.prepare(
    `SELECT id, article_id, user_id, salon_id, job_token, status, run_id FROM blog_post_jobs WHERE id = ?`
  )
    .bind(jobId)
    .first<{ id: number; article_id: number; user_id: number; salon_id: number | null; job_token: string; status: string; run_id: number | null }>()

  if (!job || !timingSafeEqual(authHeader, `Bearer ${job.job_token}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({ ok: true, alreadyCompleted: true })
  }

  const body = await c.req.json<BlogJobResultBody>().catch(() => null)
  if (!body) return c.json({ error: 'invalid body' }, 400)

  const { article_id: articleId, user_id: userId } = job
  const diagnostics = body.logs && body.logs.length > 0 ? ` / 投稿ログ: ${body.logs.join(' | ')}` : ''
  const messageWithDiagnostics = (body.message + diagnostics).slice(0, 10000)

  if (body.step === 'login' && !body.success) {
    await c.env.DB.prepare(`UPDATE salon_credentials SET connection_status = 'failed', last_error = ? WHERE user_id = ?`)
      .bind(body.message.slice(0, 500), userId)
      .run()
      .catch(() => {})
  } else {
    await c.env.DB.prepare(`UPDATE salon_credentials SET connection_status = 'success', last_error = NULL WHERE user_id = ?`)
      .bind(userId)
      .run()
      .catch(() => {})
  }

  let jobStatus: string
  if (body.success) {
    await c.env.DB.prepare(
      `UPDATE blog_articles SET last_posted_at = CURRENT_TIMESTAMP, post_count = post_count + 1, last_error = NULL WHERE id = ?`
    )
      .bind(articleId)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (blog_article_id, user_id, salon_id, execution_type, status, message)
       VALUES (?, ?, ?, 'post_blog_article', 'success', ?)`
    )
      .bind(articleId, userId, job.salon_id, messageWithDiagnostics)
      .run()
    jobStatus = 'success'
  } else {
    // 2026-08-15追記(ユーザー指定): 失敗しても承認状態は解除しない
    // (承認済みのままにしておき、次のローテーションで自動的に再試行される
    // ようにする。5件連続失敗した場合の自動一時停止/アラートは別途機能する)。
    await c.env.DB.prepare(`UPDATE blog_articles SET last_error = ? WHERE id = ?`)
      .bind(messageWithDiagnostics, articleId)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (blog_article_id, user_id, salon_id, execution_type, status, message)
       VALUES (?, ?, ?, 'post_blog_article', 'failure', ?)`
    )
      .bind(articleId, userId, job.salon_id, `ブログ投稿失敗: ${messageWithDiagnostics}`)
      .run()
    jobStatus = 'failed'
  }

  if (jobStatus === 'success' && body.proxySessionId) {
    await c.env.DB.prepare(
      `UPDATE salon_credentials SET last_successful_proxy_session_id = ?, last_successful_proxy_session_at = CURRENT_TIMESTAMP WHERE user_id = ?`
    )
      .bind(body.proxySessionId, userId)
      .run()
      .catch(() => {})
  } else if (jobStatus !== 'success') {
    await c.env.DB.prepare(`UPDATE salon_credentials SET last_successful_proxy_session_id = NULL WHERE user_id = ?`)
      .bind(userId)
      .run()
      .catch(() => {})
  }

  await updateBlogConsecutiveFailureAndNotify(c.env, userId, job.salon_id, jobStatus === 'success')

  await c.env.DB.prepare(
    `UPDATE blog_post_jobs SET status = ?, result_step = ?, result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(jobStatus, body.step, messageWithDiagnostics, jobId)
    .run()

  if (job.run_id) {
    await finalizeBlogRunIfComplete(c.env, job.run_id)
  }

  return c.json({ ok: true })
})

// ============================================
// 口コミ管理ツールの同期ジョブ(2026-08-16追記)。style/blogと同じ設計方針
// だが、ワーカーはサロンボード口コミ一覧の巡回のみを行い(Puppeteer/ログイン
// が必要な部分)、HPB公開口コミ一覧との突合はアプリ側(fetch()のみで完結)で
// 行う。詳細/返信ページ(reviewReply/)は一切使用しない。
// ============================================

automation.post('/api/reviews/sync/start', requireAuth, requireReviewEnabled, async (c) => {
  const user = c.get('user')
  if (!user.active_salon_id) return c.json({ success: false, error: 'サロンが選択されていません' }, 400)
  try {
    const result = await enqueueReviewSyncJob(c.env, user.id, user.active_salon_id)
    return c.json({ success: true, jobId: result.jobId, mode: result.mode })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err) }, 400)
  }
})

automation.get('/api/reviews/sync/status', requireAuth, requireReviewEnabled, async (c) => {
  const user = c.get('user')
  if (!user.active_salon_id) return c.json({ status: 'none' })
  const job = await c.env.DB.prepare(
    `SELECT id, status, mode, matched_count, unmatched_count, result_message
     FROM review_sync_jobs WHERE salon_id = ? ORDER BY id DESC LIMIT 1`
  )
    .bind(user.active_salon_id)
    .first<{
      id: number
      status: string
      mode: string
      matched_count: number
      unmatched_count: number
      result_message: string | null
    }>()
  if (!job) return c.json({ status: 'none' })
  return c.json({
    status: job.status,
    mode: job.mode,
    matchedCount: job.matched_count,
    unmatchedCount: job.unmatched_count,
    errorMessage: job.status === 'failed' || job.status === 'timeout' ? job.result_message : null
  })
})

automation.get('/api/review-automation/jobs/:id', async (c) => {
  const jobId = Number(c.req.param('id'))
  const authHeader = c.req.header('Authorization') || ''

  const job = await c.env.DB.prepare(
    `SELECT id, user_id, salon_id, job_token, status, mode FROM review_sync_jobs WHERE id = ?`
  )
    .bind(jobId)
    .first<{ id: number; user_id: number; salon_id: number; job_token: string; status: string; mode: string }>()

  if (!job || !timingSafeEqual(authHeader, `Bearer ${job.job_token}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({ error: 'job already completed' }, 409)
  }

  const cred = await c.env.DB.prepare(
    `SELECT salonboard_login_id_enc, salonboard_password_enc, last_successful_proxy_session_id, target_store_id
     FROM salon_credentials WHERE user_id = ?`
  )
    .bind(job.user_id)
    .first<{
      salonboard_login_id_enc: string
      salonboard_password_enc: string
      last_successful_proxy_session_id: string | null
      target_store_id: string | null
    }>()
  if (!cred || !c.env.ENCRYPTION_KEY) {
    return c.json({ error: 'credentials not available' }, 500)
  }

  let targetStoreId = cred.target_store_id || null
  const salon = await c.env.DB.prepare('SELECT salon_key FROM salonboard_salons WHERE id = ?')
    .bind(job.salon_id)
    .first<{ salon_key: string | null }>()
  if (salon?.salon_key) targetStoreId = salon.salon_key

  let stopAtManagementNo: string | null = null
  if (job.mode === 'incremental') {
    const state = await c.env.DB.prepare(
      `SELECT last_synced_review_key FROM review_sync_state WHERE salon_id = ?`
    )
      .bind(job.salon_id)
      .first<{ last_synced_review_key: string | null }>()
    stopAtManagementNo = state?.last_synced_review_key || null
  }

  const loginId = await decryptSecret(cred.salonboard_login_id_enc, c.env.ENCRYPTION_KEY)
  const password = await decryptSecret(cred.salonboard_password_enc, c.env.ENCRYPTION_KEY)

  await c.env.DB.prepare(`UPDATE review_sync_jobs SET status = 'running' WHERE id = ? AND status = 'pending'`)
    .bind(jobId)
    .run()

  const proxySessionCandidates = cred.last_successful_proxy_session_id
    ? [cred.last_successful_proxy_session_id, ...Array.from({ length: PROXY_CANDIDATE_COUNT - 1 }, () => randomSessionId())]
    : Array.from({ length: PROXY_CANDIDATE_COUNT }, () => randomSessionId())

  return c.json({
    loginId,
    password,
    proxySessionCandidates,
    targetStoreId,
    stopAtManagementNo
  })
})

type ReviewSyncJobResultBody = {
  success: boolean
  step: 'login' | 'navigate' | 'list_fetch' | 'done'
  message: string
  logs: string[]
  proxySessionId?: string | null
  loginAttempts?: { sessionId: string; success: boolean }[]
  rows: SalonBoardReviewRow[]
}

automation.post('/api/review-automation/jobs/:id/result', async (c) => {
  const jobId = Number(c.req.param('id'))
  const authHeader = c.req.header('Authorization') || ''

  const job = await c.env.DB.prepare(
    `SELECT id, user_id, salon_id, job_token, status, mode FROM review_sync_jobs WHERE id = ?`
  )
    .bind(jobId)
    .first<ReviewSyncJobRow & { job_token: string }>()

  if (!job || !timingSafeEqual(authHeader, `Bearer ${job.job_token}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({ ok: true, alreadyCompleted: true })
  }

  const body = await c.req.json<ReviewSyncJobResultBody>().catch(() => null)
  if (!body) return c.json({ error: 'invalid body' }, 400)

  if (body.step === 'login' && !body.success) {
    await c.env.DB.prepare(`UPDATE salon_credentials SET connection_status = 'failed', last_error = ? WHERE user_id = ?`)
      .bind(body.message.slice(0, 500), job.user_id)
      .run()
      .catch(() => {})
  } else {
    await c.env.DB.prepare(`UPDATE salon_credentials SET connection_status = 'success', last_error = NULL WHERE user_id = ?`)
      .bind(job.user_id)
      .run()
      .catch(() => {})
  }

  const diagnostics = body.logs && body.logs.length > 0 ? ` / 実行ログ: ${body.logs.join(' | ')}` : ''
  const messageWithDiagnostics = (body.message + diagnostics).slice(0, 10000)

  if (!body.success) {
    await c.env.DB.prepare(
      `UPDATE review_sync_jobs SET status = 'failed', result_step = ?, result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(body.step, messageWithDiagnostics, jobId)
      .run()
    return c.json({ ok: true })
  }

  try {
    const { matchedCount, unmatchedCount } = await processReviewSyncResult(c.env, job, body.rows || [])
    await c.env.DB.prepare(
      `UPDATE review_sync_jobs SET status = 'success', result_step = ?, result_message = ?, matched_count = ?, unmatched_count = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(body.step, messageWithDiagnostics, matchedCount, unmatchedCount, jobId)
      .run()
  } catch (err: any) {
    const message = `HPB口コミ一覧の取得・突合処理に失敗しました: ${String(err?.message || err)}`.slice(0, 10000)
    await c.env.DB.prepare(
      `UPDATE review_sync_jobs SET status = 'failed', result_step = 'list_fetch', result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(message, jobId)
      .run()
  }

  return c.json({ ok: true })
})

// 定期実行(毎朝09:00の口コミ同期→自動返信パイプライン・タイムアウトジョブの
// 掃除)は外部Cronトリガーを使わず、アプリ内setInterval(src/index.tsx、
// 既存のrunDeletionSweepと同じパターン)から直接
// sweepStaleReviewSyncJobs/sweepStaleReviewReplyJobs/runDailyReviewPipeline
// (src/lib/review-pipeline-runner.ts)を呼ぶ(EventBridgeへの新規スケジュール
// 追加を避けるため)。

// ---------- 口コミ自動返信(2026-08-17追記) ----------
// review_sync(口コミ一覧の取得・突合)とは別のジョブ種別。返信投稿自体は
// SALON BOARDの返信入力ページ(/CLP/bt/review/reviewReply/{管理番号})を
// 使う(実HTML確認済み。詳細はworker/src/salonboard-automation.ts参照)。

automation.get('/api/review-reply-automation/jobs/:id', async (c) => {
  const jobId = Number(c.req.param('id'))
  const authHeader = c.req.header('Authorization') || ''

  const job = await c.env.DB.prepare(
    `SELECT id, review_id, user_id, salon_id, job_token, reply_content, status FROM review_reply_jobs WHERE id = ?`
  )
    .bind(jobId)
    .first<{
      id: number
      review_id: number
      user_id: number
      salon_id: number | null
      job_token: string
      reply_content: string
      status: string
    }>()

  if (!job || !timingSafeEqual(authHeader, `Bearer ${job.job_token}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({ error: 'job already completed' }, 409)
  }

  const review = await c.env.DB.prepare(`SELECT salonboard_review_key FROM reviews WHERE id = ?`)
    .bind(job.review_id)
    .first<{ salonboard_review_key: string }>()
  if (!review) {
    await c.env.DB.prepare(
      `UPDATE review_reply_jobs SET status = 'failed', result_step = 'lookup', result_message = '対象の口コミが見つかりません', completed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(jobId)
      .run()
    return c.json({ error: 'review not found' }, 422)
  }

  const cred = await c.env.DB.prepare(
    `SELECT salonboard_login_id_enc, salonboard_password_enc, last_successful_proxy_session_id, target_store_id
     FROM salon_credentials WHERE user_id = ?`
  )
    .bind(job.user_id)
    .first<{
      salonboard_login_id_enc: string
      salonboard_password_enc: string
      last_successful_proxy_session_id: string | null
      target_store_id: string | null
    }>()
  if (!cred || !c.env.ENCRYPTION_KEY) {
    return c.json({ error: 'credentials not available' }, 500)
  }

  let targetStoreId = cred.target_store_id || null
  if (job.salon_id) {
    const salon = await c.env.DB.prepare('SELECT salon_key FROM salonboard_salons WHERE id = ?')
      .bind(job.salon_id)
      .first<{ salon_key: string | null }>()
    if (salon?.salon_key) targetStoreId = salon.salon_key
  }

  const loginId = await decryptSecret(cred.salonboard_login_id_enc, c.env.ENCRYPTION_KEY)
  const password = await decryptSecret(cred.salonboard_password_enc, c.env.ENCRYPTION_KEY)

  await c.env.DB.prepare(`UPDATE review_reply_jobs SET status = 'running' WHERE id = ? AND status = 'pending'`)
    .bind(jobId)
    .run()

  const proxySessionCandidates = cred.last_successful_proxy_session_id
    ? [cred.last_successful_proxy_session_id, ...Array.from({ length: PROXY_CANDIDATE_COUNT - 1 }, () => randomSessionId())]
    : Array.from({ length: PROXY_CANDIDATE_COUNT }, () => randomSessionId())

  return c.json({
    loginId,
    password,
    proxySessionCandidates,
    targetStoreId,
    managementNo: review.salonboard_review_key,
    replyContent: job.reply_content
  })
})

type ReviewReplyJobResultBody = {
  success: boolean
  step: 'login' | 'navigate' | 'input' | 'confirm' | 'done'
  message: string
  logs: string[]
  proxySessionId?: string | null
  loginAttempts?: { sessionId: string; success: boolean }[]
}

automation.post('/api/review-reply-automation/jobs/:id/result', async (c) => {
  const jobId = Number(c.req.param('id'))
  const authHeader = c.req.header('Authorization') || ''

  const job = await c.env.DB.prepare(
    `SELECT id, review_id, user_id, salon_id, job_token, reply_content, trigger, status FROM review_reply_jobs WHERE id = ?`
  )
    .bind(jobId)
    .first<{
      id: number
      review_id: number
      user_id: number
      salon_id: number | null
      job_token: string
      reply_content: string
      trigger: 'auto' | 'manual'
      status: string
    }>()

  if (!job || !timingSafeEqual(authHeader, `Bearer ${job.job_token}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({ ok: true, alreadyCompleted: true })
  }

  const body = await c.req.json<ReviewReplyJobResultBody>().catch(() => null)
  if (!body) return c.json({ error: 'invalid body' }, 400)

  if (body.step === 'login' && !body.success) {
    await c.env.DB.prepare(`UPDATE salon_credentials SET connection_status = 'failed', last_error = ? WHERE user_id = ?`)
      .bind(body.message.slice(0, 500), job.user_id)
      .run()
      .catch(() => {})
  } else {
    await c.env.DB.prepare(`UPDATE salon_credentials SET connection_status = 'success', last_error = NULL WHERE user_id = ?`)
      .bind(job.user_id)
      .run()
      .catch(() => {})
  }

  const diagnostics = body.logs && body.logs.length > 0 ? ` / 実行ログ: ${body.logs.join(' | ')}` : ''
  const messageWithDiagnostics = (body.message + diagnostics).slice(0, 10000)
  const jobStatus = body.success ? 'success' : 'failed'

  await c.env.DB.prepare(
    `UPDATE review_reply_jobs SET status = ?, result_step = ?, result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(jobStatus, body.step, messageWithDiagnostics, jobId)
    .run()

  if (body.success) {
    await c.env.DB.prepare(
      `UPDATE reviews SET replied_at = CURRENT_TIMESTAMP, reply_content = ?, reply_method = ? WHERE id = ?`
    )
      .bind(job.reply_content, job.trigger, job.review_id)
      .run()
  }

  // 2026-08-17追記(ユーザー指定): 手動返信(trigger='manual')は連続失敗
  // カウント・一時停止の対象外とする(自動返信スケジュールが自動的に停止する
  // のは自動返信自身が失敗し続けた場合のみで、手動操作の失敗で巻き添えに
  // しない)。
  if (job.trigger === 'auto') {
    await updateReviewReplyConsecutiveFailureAndNotify(c.env, job.user_id, job.salon_id, body.success)
  }

  return c.json({ ok: true })
})

automation.post('/api/cron/run-blog-posts', async (c) => {
  const authHeader = c.req.header('Authorization') || ''
  const expected = c.env.CRON_SECRET
  if (!expected || !timingSafeEqual(authHeader, `Bearer ${expected}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const nowLabel = currentJstTimeLabel()
  await sweepStaleBlogJobs(c.env).catch(() => {})

  const { results: schedules } = await c.env.DB.prepare(
    `SELECT s.user_id, s.salon_id FROM blog_post_schedules s
     JOIN users u ON u.id = s.user_id
     JOIN salonboard_salons sb ON sb.id = s.salon_id
     WHERE s.enabled = 1 AND u.is_active = 1 AND sb.blog_enabled = 1 AND sb.is_active_workspace = 1`
  ).all<{ user_id: number; salon_id: number }>()

  const targets = schedules || []
  const outcomes: any[] = []
  for (const t of targets) {
    try {
      const summary = await runNextArticleForUser(c.env, t.user_id, t.salon_id, nowLabel)
      outcomes.push(summary ? { userId: t.user_id, salonId: t.salon_id, ...summary } : { userId: t.user_id, skipped: true })
    } catch (err: any) {
      outcomes.push({ userId: t.user_id, status: 'failed', error: String(err?.message || err) })
    }
  }

  return c.json({ time: nowLabel, matchedUsers: targets.length, outcomes })
})

// ---------- 外部Cronトリガー用エンドポイント ----------
// Cloudflare Pagesはネイティブのscheduled()をサポートしないため、
// 別途用意した軽量Cloudflare Worker（Cron Trigger付き）や外部クロンサービスから
// 1分間隔程度でこのエンドポイントをBearerトークン付きで呼び出す想定。
// Authorization: Bearer <CRON_SECRET>

automation.post('/api/cron/run-style-posts', async (c) => {
  const authHeader = c.req.header('Authorization') || ''
  const expected = c.env.CRON_SECRET
  if (!expected || !timingSafeEqual(authHeader, `Bearer ${expected}`)) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const nowLabel = currentJstTimeLabel()

  // Fargateタスクが結果コールバックを返さないまま停止した場合の掃除
  // (タスク自体のクラッシュ、ネットワーク断等)。次のジョブ投入前に行う。
  await sweepStaleJobs(c.env).catch(() => {})

  // 「7:00〜24:00の間に均等に分散して投稿する」方式(ユーザー要望により、
  // 固定時刻での一括投稿から変更)。外部Cronは数分間隔でこのエンドポイントを
  // 叩く想定で、呼ばれるたびに各ユーザーごとに「今が投稿すべきタイミングか」
  // をrunNextStyleForUser()内で判定し、タイミングであれば1件だけ処理する。
  // 管理者サイトで契約OFF(is_active=0)またはスタイル機能OFF(salonboard_salons.style_enabled=0)に
  // されたサロンはcronの対象から除外する。
  // 複数サロンワークスペース対応: 1ユーザーが複数のサロンワークスペースを
  // 持つ場合、それぞれ独立して「今が投稿タイミングか」を判定・処理する
  // (1ユーザー1件ではなく1ワークスペース1件のループに変更)。salon_idが
  // 無い(移行直後で稀に起こりうる異常系)の行は対象外にする。
  const { results: schedules } = await c.env.DB.prepare(
    `SELECT s.user_id, s.salon_id FROM style_post_schedules s
     JOIN users u ON u.id = s.user_id
     JOIN salonboard_salons sb ON sb.id = s.salon_id
     WHERE s.enabled = 1 AND u.is_active = 1 AND sb.style_enabled = 1 AND sb.is_active_workspace = 1`
  ).all<{ user_id: number; salon_id: number }>()

  const targets = schedules || []

  const outcomes: any[] = []
  for (const t of targets) {
    try {
      const summary = await runNextStyleForUser(c.env, t.user_id, t.salon_id, nowLabel)
      if (summary) {
        outcomes.push({ userId: t.user_id, salonId: t.salon_id, ...summary })
      } else {
        outcomes.push({ userId: t.user_id, skipped: true })
      }
    } catch (err: any) {
      outcomes.push({ userId: t.user_id, status: 'failed', error: String(err?.message || err) })
    }
  }

  return c.json({ time: nowLabel, matchedUsers: targets.length, outcomes })
})

export default automation
