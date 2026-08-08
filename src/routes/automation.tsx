import { Hono } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import { runStyleAutomationForUser, retryStylePost, currentJstTimeLabel } from '../lib/style-post-runner'
import type { Bindings, AppUser } from '../types'

const automation = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

// 毎朝この時刻(JST)から、登録済み(ready)スタイルの自動投稿を開始する固定時刻。
// docs/phase3-mvp-design.md参照。ユーザーが時刻を選ぶUIは廃止した。
const DAILY_AUTO_POST_TIME = '07:00'

// ---------- 手動実行・履歴画面 ----------

const EXECUTION_TYPE_LABEL: Record<string, string> = {
  register_style: '登録',
  request_reflection: '反映申請'
}

const LOG_STATUS_DOT: Record<string, string> = {
  success: 'bg-green-500',
  blocked: 'bg-amber-500',
  failure: 'bg-red-500'
}

automation.get('/style/test-run', requireAuth, async (c) => {
  const user = c.get('user')

  const { results: runs } = await c.env.DB.prepare(
    `SELECT id, scheduled_time, total_images, status, error_message, executed_at, created_at
     FROM style_post_runs WHERE user_id = ? ORDER BY id DESC LIMIT 10`
  )
    .bind(user.id)
    .all<{
      id: number
      scheduled_time: string
      total_images: number
      status: string
      error_message: string | null
      executed_at: string | null
      created_at: string
    }>()

  const { results: logs } = await c.env.DB.prepare(
    `SELECT l.id, l.status, l.message, l.execution_type, l.style_id, l.created_at, s.title AS style_title
     FROM execution_logs l
     LEFT JOIN styles s ON s.id = l.style_id
     WHERE l.user_id = ? ORDER BY l.id DESC LIMIT 30`
  )
    .bind(user.id)
    .all<{
      id: number
      status: string
      message: string
      execution_type: string | null
      style_id: number | null
      created_at: string
      style_title: string | null
    }>()

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
    <PageLayout active="style-test-run" salonName={user.salon_name} title="手動実行・実行履歴">
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
        <i class="fas fa-triangle-exclamation mr-2"></i>
        手動実行ボタンを押すと、現在自動投稿対象で入力完了済みのスタイルすべてに対して実際に
        サロンボードへの<b>登録＋反映申請（公開）</b>が実行されます。パスワードは画面・ログのどこにも表示されません。
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <button
          id="test-run-btn"
          class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm disabled:opacity-50"
        >
          <i class="fas fa-flask mr-2"></i>手動実行する
        </button>
        <p id="test-run-status" class="text-sm text-gray-500 mt-3"></p>
      </div>

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
        <p class="font-semibold mb-3"><i class="fas fa-clock-rotate-left mr-2 text-pink-500"></i>実行履歴</p>
        {!runs || runs.length === 0 ? (
          <p class="text-sm text-gray-400">まだ実行履歴がありません</p>
        ) : (
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-400 border-b border-gray-100">
                <th class="py-2">実行時刻区分</th>
                <th class="py-2">対象枚数</th>
                <th class="py-2">ステータス</th>
                <th class="py-2">エラー</th>
                <th class="py-2">実行日時</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr class="border-b border-gray-50">
                  <td class="py-2">{r.scheduled_time}</td>
                  <td class="py-2">{r.total_images}</td>
                  <td class="py-2">
                    <span
                      class={
                        'px-2 py-0.5 rounded text-xs font-semibold ' +
                        (r.status === 'done'
                          ? 'bg-green-50 text-green-600'
                          : r.status === 'failed'
                          ? 'bg-red-50 text-red-600'
                          : 'bg-gray-50 text-gray-500')
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td class="py-2 text-xs text-gray-400 max-w-xs truncate">{r.error_message || '-'}</td>
                  <td class="py-2 text-xs text-gray-400">{r.executed_at || r.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-3"><i class="fas fa-list-check mr-2 text-pink-500"></i>個別実行ログ（直近30件）</p>
        {!logs || logs.length === 0 ? (
          <p class="text-sm text-gray-400">まだログがありません</p>
        ) : (
          <ul class="text-sm space-y-2">
            {logs.map((l) => (
              <li class="flex items-start gap-2">
                <span class={'mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ' + (LOG_STATUS_DOT[l.status] || 'bg-gray-400')}></span>
                <div class="min-w-0">
                  <p class="text-gray-700">
                    {l.execution_type && (
                      <span class="text-xs font-semibold text-gray-400 mr-1">
                        [{EXECUTION_TYPE_LABEL[l.execution_type] || l.execution_type}]
                      </span>
                    )}
                    {l.style_id ? (
                      <a href={`/style/${l.style_id}/edit`} class="hover:text-pink-600 hover:underline">
                        {l.style_title || `スタイル${l.style_id}`}
                      </a>
                    ) : null}
                    {l.style_id ? ' — ' : ''}
                    {l.message}
                  </p>
                  <p class="text-xs text-gray-400">{l.created_at}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <script src="/static/test-run.js"></script>
    </PageLayout>,
    { title: '手動実行・実行履歴' }
  )
})

// ---------- 手動実行API（ログイン中ユーザー本人のみ） ----------

automation.post('/api/automation/test-run', requireAuth, async (c) => {
  const user = c.get('user')
  try {
    const summary = await runStyleAutomationForUser(c.env, user.id, 'manual-test')
    return c.json({
      success: summary.successCount > 0,
      successCount: summary.successCount,
      failureCount: summary.failureCount,
      blockedCount: summary.blockedCount,
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
    return c.json({ success: result.outcome === 'success', outcome: result.outcome })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err) }, 400)
  }
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

  // 実行時刻はユーザーが選ぶのではなく、毎朝7:00固定で
  // 登録済み(ready)スタイルを順次自動投稿する運用に変更(docs/phase3-mvp-design.md参照)。
  // 外部Cronは1分間隔程度でこのエンドポイントを叩く想定のため、ここで時刻を絞り込む。
  if (nowLabel !== DAILY_AUTO_POST_TIME) {
    return c.json({ time: nowLabel, matchedUsers: 0, outcomes: [] })
  }

  const { results: schedules } = await c.env.DB.prepare(
    `SELECT user_id FROM style_post_schedules WHERE enabled = 1`
  ).all<{ user_id: number }>()

  const targets = schedules || []

  const outcomes: any[] = []
  for (const t of targets) {
    try {
      const summary = await runStyleAutomationForUser(c.env, t.user_id, nowLabel)
      outcomes.push({ userId: t.user_id, ...summary })
    } catch (err: any) {
      outcomes.push({ userId: t.user_id, status: 'failed', error: String(err?.message || err) })
    }
  }

  return c.json({ time: nowLabel, matchedUsers: targets.length, outcomes })
})

export default automation
