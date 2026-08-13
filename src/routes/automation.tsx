import { Hono } from 'hono'
import { requireAuth, requireStyleEnabled } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import {
  runStyleAutomationForUser,
  runNextStyleForUser,
  retryStylePost,
  currentJstTimeLabel,
  getStyleRowForJob,
  getStyleNo,
  sweepStaleJobs
} from '../lib/style-post-runner'
import { decryptSecret } from '../lib/crypto'
import { formatJstDate } from '../lib/date-format'
import { publishAlert } from '../lib/sns-alert'
import type { Bindings, AppUser } from '../types'

// 管理者サイト(/admin/status)の連続失敗検知しきい値。users.consecutive_failure_countが
// この値をまたいだ(超えた/下回った)瞬間だけ通知する(実行の度に毎回送ると
// スパムになるため、状態遷移のときのみ)。
const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 5

async function updateConsecutiveFailureAndNotify(env: Bindings, userId: number, success: boolean): Promise<void> {
  const before = await env.DB.prepare('SELECT consecutive_failure_count, email, salon_name FROM users WHERE id = ?')
    .bind(userId)
    .first<{ consecutive_failure_count: number; email: string; salon_name: string | null }>()
  if (!before) return

  const prevCount = before.consecutive_failure_count
  const nextCount = success ? 0 : prevCount + 1
  await env.DB.prepare('UPDATE users SET consecutive_failure_count = ? WHERE id = ?').bind(nextCount, userId).run()

  const wasFailing = prevCount >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD
  const isFailing = nextCount >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD
  if (wasFailing === isFailing) return // 状態遷移が無ければ通知しない

  const salonLabel = before.salon_name || before.email
  const subject = isFailing
    ? `[SalonMotion] ${salonLabel} のスタイル自動投稿が${CONSECUTIVE_FAILURE_ALERT_THRESHOLD}回連続で失敗しています`
    : `[SalonMotion] ${salonLabel} のスタイル自動投稿が復旧しました`
  const message = isFailing
    ? `サロン「${salonLabel}」(${before.email})のスタイル自動投稿が${CONSECUTIVE_FAILURE_ALERT_THRESHOLD}回連続で失敗しました。管理者サイト(/admin/status)で状況を確認してください。`
    : `サロン「${salonLabel}」(${before.email})のスタイル自動投稿が成功し、連続失敗の状態から復旧しました。`

  await publishAlert(env, subject, message).catch((err) => {
    console.error('アラート通知の送信に失敗しました:', err)
  })
}

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
const PROXY_CANDIDATE_COUNT = 5

function randomSessionId(): string {
  return Math.random().toString(36).slice(2, 10)
}

// ---------- 手動実行・履歴画面 ----------

const EXECUTION_TYPE_LABEL: Record<string, string> = {
  register_style: '登録',
  request_reflection: '反映申請'
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
  statusLabel: string
  statusClass: string
  borderClass: string
  errorText: string
  showToggle: boolean
}

function ExecutionLogTable({ rows }: { rows: ExecutionLogRow[] }) {
  if (rows.length === 0) {
    return <p class="text-sm text-gray-400">まだログがありません</p>
  }
  return (
    <>
      {/* PC表示: テーブル */}
      <div class="hidden md:block overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-gray-400 border-b border-gray-100">
              <th class="py-2 pl-3">実行日時</th>
              <th class="py-2">カテゴリ</th>
              <th class="py-2">内容</th>
              <th class="py-2">ステータス</th>
              <th class="py-2">エラー</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr class="border-b border-gray-50">
                <td class={'py-2 pl-3 border-l-4 text-xs text-gray-500 whitespace-nowrap ' + r.borderClass}>
                  {r.dateLabel}
                </td>
                <td class="py-2">
                  <span class={'text-xs px-2 py-0.5 rounded font-semibold ' + r.categoryClass}>{r.category}</span>
                </td>
                <td class="py-2 text-xs text-gray-700 max-w-xs truncate">{r.content}</td>
                <td class="py-2">
                  <span class={'text-xs px-2 py-0.5 rounded font-semibold ' + r.statusClass}>{r.statusLabel}</span>
                </td>
                <td class="py-2 text-xs text-gray-400 max-w-xs">
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
              <span class="text-sm text-gray-700 min-w-0 truncate">{r.content}</span>
            </div>
            {r.errorText !== '-' && (
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

automation.get('/style/test-run', requireAuth, async (c) => {
  const user = c.get('user')

  const { results: logs } = await c.env.DB.prepare(
    `SELECT l.id, l.status, l.message, l.execution_type, l.style_id, l.style_no, l.post_id, l.created_at,
            s.title AS style_title, p.title AS post_title
     FROM execution_logs l
     LEFT JOIN styles s ON s.id = l.style_id
     LEFT JOIN posts p ON p.id = l.post_id
     WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 30`
  )
    .bind(user.id)
    .all<{
      id: number
      status: string
      message: string
      execution_type: string | null
      style_id: number | null
      style_no: number | null
      post_id: number | null
      created_at: string
      style_title: string | null
      post_title: string | null
    }>()

  const logRows = (logs || []).map((l) => {
    const category = l.post_id ? 'ブログ' : 'スタイル'
    const errorText = l.status === 'success' ? '' : (l.message || '').slice(0, 3000)
    return {
      id: l.id,
      dateLabel: formatJstDate(l.created_at),
      category,
      categoryClass: category === 'ブログ' ? 'bg-purple-50 text-purple-600' : 'bg-blue-50 text-blue-600',
      content: (
        <>
          {l.execution_type && (
            <span class="text-xs font-semibold text-gray-400 mr-1">
              [{EXECUTION_TYPE_LABEL[l.execution_type] || l.execution_type}]
            </span>
          )}
          {l.style_id ? (
            <a href={`/style/${l.style_id}/edit`} class="hover:text-pink-600 hover:underline">
              No.{l.style_no ?? l.style_id} {l.style_title || '(無題)'}
            </a>
          ) : l.post_id ? (
            l.post_title || `投稿${l.post_id}`
          ) : (
            '-'
          )}
        </>
      ),
      statusLabel: LOG_RESULT_LABEL[l.status] || l.status,
      statusClass: LOG_RESULT_COLOR[l.status] || 'bg-gray-100 text-gray-500',
      borderClass: LOG_RESULT_BORDER[l.status] || 'border-gray-300',
      errorText: errorText || '-',
      showToggle: errorText.length > 150
    }
  })

  const styleLogRows = logRows.filter((r) => r.category === 'スタイル')
  const blogLogRows = logRows.filter((r) => r.category === 'ブログ')

  // 失敗/ブロックされたスタイル: 個別「再実行」ボタンの対象一覧(docs/phase3-mvp-design.md 5-6)
  // No.は登録スタイル一覧(StyleListSection)と同じ並び順(sort_order)での通し番号。
  // 対象を絞り込む前の全件に対して番号を振ってから絞り込む必要があるためサブクエリにしている。
  const { results: retryTargets } = await c.env.DB.prepare(
    `SELECT id, title, salonboard_register_status, reflection_request_status, last_executed_at, style_no
     FROM (
       SELECT id, title, salonboard_register_status, reflection_request_status, last_executed_at, updated_at,
         ROW_NUMBER() OVER (ORDER BY sort_order ASC, id DESC) AS style_no
       FROM styles WHERE user_id = ?
     ) ranked
     WHERE salonboard_register_status = 'failed' OR reflection_request_status IN ('failed', 'blocked')
     ORDER BY updated_at DESC LIMIT 20`
  )
    .bind(user.id)
    .all<{
      id: number
      title: string | null
      salonboard_register_status: string
      reflection_request_status: string
      last_executed_at: string | null
      style_no: number
    }>()

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}
      active="style-test-run"
      salonName={user.salon_name}
      title="実行履歴"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
    >
      {retryTargets && retryTargets.length > 0 && (
        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="font-semibold mb-3">
            <i class="fas fa-rotate-right mr-2 text-pink-500"></i>失敗・ブロック中のスタイル（再実行できます）
          </p>
          <ul class="text-sm divide-y divide-gray-50">
            {retryTargets.map((t) => {
              const isBlocked = t.reflection_request_status === 'blocked'
              return (
                <li class="flex items-center justify-between gap-3 py-2">
                  <div class="min-w-0">
                    <a href={`/style/${t.id}/edit`} class="font-medium text-gray-700 hover:text-pink-600 truncate block">
                      No.{t.style_no} {t.title || `スタイル${t.id}`}
                    </a>
                    <p class="text-xs text-gray-400 truncate">
                      <span class={'px-1.5 py-0.5 rounded font-semibold mr-1 ' + (isBlocked ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-600')}>
                        {isBlocked ? 'ブロック' : '失敗'}
                      </span>
                      {formatJstDate(t.last_executed_at)}
                    </p>
                  </div>
                  <button
                    type="button"
                    class="retry-btn flex-shrink-0 text-xs font-semibold text-gray-500 hover:text-pink-600 border border-gray-300 rounded px-3 py-1.5"
                    data-style-id={t.id}
                  >
                    <i class="fas fa-rotate-right mr-1"></i>再実行
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

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
          <ExecutionLogTable rows={styleLogRows} />
        </div>
        <div data-tab-panel="blog" class="hidden">
          <ExecutionLogTable rows={blogLogRows} />
        </div>
      </div>

      <script src="/static/test-run.js"></script>
    </PageLayout>,
    { title: '実行履歴' }
  )
})

// ---------- 手動実行API（ログイン中ユーザー本人のみ） ----------

automation.post('/api/automation/test-run', requireAuth, requireStyleEnabled, async (c) => {
  const user = c.get('user')
  try {
    const summary = await runStyleAutomationForUser(c.env, user.id, 'manual-test')
    return c.json({
      success: summary.dispatchedCount > 0,
      dispatchedCount: summary.dispatchedCount,
      failedToDispatchCount: summary.failedToDispatchCount,
      totalImages: summary.totalImages,
      status: summary.status
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
    const result = await retryStylePost(c.env, user.id, styleId)
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
    `SELECT id, style_id, user_id, job_token, status FROM style_post_jobs WHERE id = ?`
  )
    .bind(jobId)
    .first<{ id: number; style_id: number; user_id: number; job_token: string; status: string }>()

  if (!job || authHeader !== `Bearer ${job.job_token}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({ error: 'job already completed' }, 409)
  }

  const cred = await c.env.DB.prepare(
    `SELECT salonboard_login_id_enc, salonboard_password_enc FROM salon_credentials WHERE user_id = ?`
  )
    .bind(job.user_id)
    .first<{ salonboard_login_id_enc: string; salonboard_password_enc: string }>()
  if (!cred || !c.env.ENCRYPTION_KEY) {
    return c.json({ error: 'credentials not available' }, 500)
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

  // ジョブ(投稿1回)ごとに毎回ランダムな新しいセッションIDを生成する。
  // 固定プール運用時代と違い実績追跡は行わない(理由は上のコメント参照)。
  // 複数ジョブが同時実行されても、それぞれ別のランダムIDになるため
  // セッションの取り合いは起きない。
  const proxySessionCandidates = Array.from({ length: PROXY_CANDIDATE_COUNT }, () => randomSessionId())

  return c.json({
    loginId,
    password,
    proxySessionCandidates,
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
    `SELECT id, style_id, user_id, job_token, status, run_id FROM style_post_jobs WHERE id = ?`
  )
    .bind(jobId)
    .first<{ id: number; style_id: number; user_id: number; job_token: string; status: string; run_id: number | null }>()

  if (!job || authHeader !== `Bearer ${job.job_token}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  // 既に結果を受信済み(二重コールバック・タイムアウト後の遅延コールバック等)は冪等に無視する
  if (job.status !== 'pending' && job.status !== 'running') {
    return c.json({ ok: true, alreadyCompleted: true })
  }

  const body = await c.req.json<JobResultBody>().catch(() => null)
  if (!body) return c.json({ error: 'invalid body' }, 400)

  const { style_id: styleId, user_id: userId } = job
  const diagnostics = body.logs && body.logs.length > 0 ? ` / 診断ログ: ${body.logs.join(' | ')}` : ''
  const messageWithDiagnostics = (body.message + diagnostics).slice(0, 3000)
  const styleNo = await getStyleNo(c.env, userId, styleId)

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
      `INSERT INTO execution_logs (post_id, user_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, 'register_style', 'success', 'スタイル登録成功')`
    )
      .bind(userId, styleId, styleNo)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, 'request_reflection', 'success', '反映申請成功')`
    )
      .bind(userId, styleId, styleNo)
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
      `INSERT INTO execution_logs (post_id, user_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, 'register_style', 'success', 'スタイル登録成功')`
    )
      .bind(userId, styleId, styleNo)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, 'request_reflection', ?, ?)`
    )
      .bind(userId, styleId, styleNo, body.blocked ? 'blocked' : 'failure', `反映申請${body.blocked ? 'ブロック' : '失敗'}: ${messageWithDiagnostics}`)
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
      `INSERT INTO execution_logs (post_id, user_id, style_id, style_no, execution_type, status, message)
       VALUES (NULL, ?, ?, ?, 'register_style', 'failure', ?)`
    )
      .bind(userId, styleId, styleNo, `スタイル登録失敗: ${messageWithDiagnostics}`)
      .run()
    jobStatus = 'failed'
  }

  await updateConsecutiveFailureAndNotify(c.env, userId, jobStatus === 'success')

  await c.env.DB.prepare(
    `UPDATE style_post_jobs SET status = ?, result_step = ?, result_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(jobStatus, body.step, messageWithDiagnostics, jobId)
    .run()

  // 2026-08-11追記(不具合修正): 実行履歴(style_post_runs)一覧のステータスが
  // 各ジョブの結果を集計せず常に'processing'のまま表示され続けていた。
  // このジョブが属するrunに紐づく全ジョブが完了(pending/running以外)に
  // なった時点で、run全体のステータスを確定させる。
  if (job.run_id) {
    const { results: pendingJobs } = await c.env.DB.prepare(
      `SELECT id FROM style_post_jobs WHERE run_id = ? AND status IN ('pending', 'running')`
    )
      .bind(job.run_id)
      .all<{ id: number }>()

    if (!pendingJobs || pendingJobs.length === 0) {
      const { results: finishedJobs } = await c.env.DB.prepare(
        `SELECT status FROM style_post_jobs WHERE run_id = ?`
      )
        .bind(job.run_id)
        .all<{ status: string }>()

      const statuses = (finishedJobs || []).map((j) => j.status)
      const runStatus = statuses.every((s) => s === 'success')
        ? 'done'
        : statuses.every((s) => s !== 'success')
        ? 'failed'
        : 'partial_failure'

      await c.env.DB.prepare(`UPDATE style_post_runs SET status = ?, executed_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(runStatus, job.run_id)
        .run()
    }
  }

  return c.json({ ok: true })
})

// ---------- 外部Cronトリガー用エンドポイント ----------
// Cloudflare Pagesはネイティブのscheduled()をサポートしないため、
// 別途用意した軽量Cloudflare Worker（Cron Trigger付き）や外部クロンサービスから
// 1分間隔程度でこのエンドポイントをBearerトークン付きで呼び出す想定。
// Authorization: Bearer <CRON_SECRET>

automation.post('/api/cron/run-style-posts', async (c) => {
  const authHeader = c.req.header('Authorization') || ''
  const expected = c.env.CRON_SECRET
  if (!expected || authHeader !== `Bearer ${expected}`) {
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
  // 管理者サイトで契約OFF(is_active=0)またはスタイル機能OFF(style_enabled=0)に
  // されたサロンはcronの対象から除外する。
  const { results: schedules } = await c.env.DB.prepare(
    `SELECT s.user_id FROM style_post_schedules s
     JOIN users u ON u.id = s.user_id
     WHERE s.enabled = 1 AND u.is_active = 1 AND u.style_enabled = 1`
  ).all<{ user_id: number }>()

  const targets = schedules || []

  const outcomes: any[] = []
  for (const t of targets) {
    try {
      const summary = await runNextStyleForUser(c.env, t.user_id, nowLabel)
      if (summary) {
        outcomes.push({ userId: t.user_id, ...summary })
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
