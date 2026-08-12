import { Hono } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import {
  runStyleAutomationForUser,
  runNextStyleForUser,
  retryStylePost,
  currentJstTimeLabel,
  getStyleRowForJob,
  sweepStaleJobs
} from '../lib/style-post-runner'
import { decryptSecret } from '../lib/crypto'
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

automation.get('/style/test-run', requireAuth, async (c) => {
  const user = c.get('user')

  const { results: logs } = await c.env.DB.prepare(
    `SELECT l.id, l.status, l.message, l.execution_type, l.style_id, l.post_id, l.created_at,
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
      post_id: number | null
      created_at: string
      style_title: string | null
      post_title: string | null
    }>()

  const logRows = (logs || []).map((l) => {
    const category = l.post_id ? 'ブログ' : 'スタイル'
    const errorText = l.status === 'success' ? '' : (l.message || '').slice(0, 2000)
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
              No.{l.style_id} {l.style_title || '(無題)'}
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

  // 失敗/ブロックされたスタイル: 個別「再実行」ボタンの対象一覧(docs/phase3-mvp-design.md 5-6)
  const { results: retryTargets } = await c.env.DB.prepare(
    `SELECT id, title, salonboard_register_status, reflection_request_status, last_error
     FROM styles
     WHERE user_id = ? AND (salonboard_register_status = 'failed' OR reflection_request_status IN ('failed', 'blocked'))
     ORDER BY updated_at DESC LIMIT 20`
  )
    .bind(user.id)
    .all<{
      id: number
      title: string | null
      salonboard_register_status: string
      reflection_request_status: string
      last_error: string | null
    }>()

  return c.render(
    <PageLayout active="style-test-run" salonName={user.salon_name} title="実行履歴">
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
                      {t.title || `スタイル${t.id}`}
                    </a>
                    <p class="text-xs text-gray-400 truncate">
                      <span class={'px-1.5 py-0.5 rounded font-semibold mr-1 ' + (isBlocked ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-600')}>
                        {isBlocked ? 'ブロック' : '失敗'}
                      </span>
                      {t.last_error || ''}
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
        {logRows.length === 0 ? (
          <p class="text-sm text-gray-400">まだログがありません</p>
        ) : (
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
                  {logRows.map((r) => (
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
              {logRows.map((r) => (
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
        )}
      </div>

      <script src="/static/test-run.js"></script>
    </PageLayout>,
    { title: '実行履歴' }
  )
})

// ---------- 手動実行API（ログイン中ユーザー本人のみ） ----------

automation.post('/api/automation/test-run', requireAuth, async (c) => {
  const user = c.get('user')
  try {
    const summary = await runStyleAutomationForUser(c.env, user.id, 'manual-test')
    return c.json({
      success: summary.dispatchedCount > 0,
      dispatchedCount: summary.dispatchedCount,
      failedToDispatchCount: summary.failedToDispatchCount,
      status: summary.status
    })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err) }, 400)
  }
})

// ---------- 個別スタイルの再実行API(docs/phase3-mvp-design.md 5-6) ----------

automation.post('/api/style/:id/retry', requireAuth, async (c) => {
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

// SALON BOARD側にはハッシュタグ専用の入力欄が存在しないため、
// スタイリストコメント(#stylistCommentTxt、最大120文字)の末尾に
// 「 #タグ1 #タグ2」の形で連結して送信する。
function buildStylistCommentWithHashtags(comment: string, hashtagsJson: string): string {
  const hashtags: string[] = JSON.parse(hashtagsJson || '[]')
  const tagsText = hashtags.map((t) => `#${t}`).join(' ')
  const combined = tagsText ? [comment, tagsText].filter(Boolean).join(' ') : comment
  return combined.slice(0, 120)
}

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
    `SELECT salonboard_login_id_enc, salonboard_password_enc, last_successful_proxy_session_id
       FROM salon_credentials WHERE user_id = ?`
  )
    .bind(job.user_id)
    .first<{
      salonboard_login_id_enc: string
      salonboard_password_enc: string
      last_successful_proxy_session_id: string | null
    }>()
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

  return c.json({
    loginId,
    password,
    preferredProxySessionId: cred.last_successful_proxy_session_id || undefined,
    style: {
      styleImageId: row.id,
      imageBase64: arrayBufferToBase64(imageBuffer),
      imageFileName: row.front_file_name || `style-${row.id}.jpg`,
      styleName: (row.title || `スタイル${row.id}`).slice(0, 30),
      stylistSelectValue: row.stylist_select_value || '',
      stylistComment: buildStylistCommentWithHashtags(row.comment || '', row.hashtags_json),
      categoryCd: (row.category_value as 'SG01' | 'SG02') || 'SG01',
      hairLengthValue: row.length_value || '',
      menuContentsCdList: JSON.parse(row.menu_values_json || '[]'),
      menuDetailText: row.menu_detail_text || '',
      couponSelectValue: row.coupon_select_value || undefined
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
  const messageWithDiagnostics = (body.message + diagnostics).slice(0, 2000)

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

  // 2026-08-11追記: ログインに成功した(CAPTCHA等を回避できた)プロキシセッション
  // IDを記録し、次回以降のジョブで優先的に使い回す(出口IPを固定する)ために
  // 使う。ワーカー側はログイン成功時のみこの値を返す(salonboard-automation.ts
  // のnewAutomationPage/index.tsのrunJob参照)。
  if (body.proxySessionId) {
    await c.env.DB.prepare(
      `UPDATE salon_credentials SET last_successful_proxy_session_id = ?, last_successful_proxy_session_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`
    )
      .bind(body.proxySessionId, userId)
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
      `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
       VALUES (NULL, ?, ?, 'register_style', 'success', 'スタイル登録成功')`
    )
      .bind(userId, styleId)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
       VALUES (NULL, ?, ?, 'request_reflection', 'success', '反映申請成功')`
    )
      .bind(userId, styleId)
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
      `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
       VALUES (NULL, ?, ?, 'register_style', 'success', 'スタイル登録成功')`
    )
      .bind(userId, styleId)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
       VALUES (NULL, ?, ?, 'request_reflection', ?, ?)`
    )
      .bind(userId, styleId, body.blocked ? 'blocked' : 'failure', `反映申請${body.blocked ? 'ブロック' : '失敗'}: ${messageWithDiagnostics}`)
      .run()
    jobStatus = reflectStatus
  } else {
    // login/navigate/draft_register/image_upload段階での失敗 = 登録自体が失敗
    await c.env.DB.prepare(
      `UPDATE styles SET salonboard_register_status = 'failed', last_error = ?, last_executed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(messageWithDiagnostics, styleId)
      .run()
    await c.env.DB.prepare(
      `INSERT INTO execution_logs (post_id, user_id, style_id, execution_type, status, message)
       VALUES (NULL, ?, ?, 'register_style', 'failure', ?)`
    )
      .bind(userId, styleId, `スタイル登録失敗: ${messageWithDiagnostics}`)
      .run()
    jobStatus = 'failed'
  }

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
  const { results: schedules } = await c.env.DB.prepare(
    `SELECT user_id FROM style_post_schedules WHERE enabled = 1`
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
