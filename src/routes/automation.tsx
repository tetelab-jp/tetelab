import { Hono } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import { runStyleAutomationForUser, currentJstTimeLabel } from '../lib/style-post-runner'
import type { Bindings, AppUser } from '../types'

const automation = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

// ---------- テスト実行・履歴画面 ----------

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
    `SELECT id, status, message, created_at FROM execution_logs WHERE user_id = ? ORDER BY id DESC LIMIT 20`
  )
    .bind(user.id)
    .all<{ id: number; status: string; message: string; created_at: string }>()

  return c.render(
    <PageLayout active="style-test-run" salonName={user.salon_name} title="テスト実行・実行履歴">
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
        <i class="fas fa-triangle-exclamation mr-2"></i>
        テスト実行ボタンを押すと、現在チェックされている画像すべてに対して実際にサロンボードへの
        <b>登録＋反映申請（公開）</b>が実行されます。パスワードは画面・ログのどこにも表示されません。
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <button
          id="test-run-btn"
          class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm disabled:opacity-50"
        >
          <i class="fas fa-flask mr-2"></i>テスト実行する
        </button>
        <p id="test-run-status" class="text-sm text-gray-500 mt-3"></p>
      </div>

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
        <p class="font-semibold mb-3"><i class="fas fa-list-check mr-2 text-pink-500"></i>個別実行ログ（直近20件）</p>
        {!logs || logs.length === 0 ? (
          <p class="text-sm text-gray-400">まだログがありません</p>
        ) : (
          <ul class="text-sm space-y-2">
            {logs.map((l) => (
              <li class="flex items-start gap-2">
                <span
                  class={
                    'mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ' + (l.status === 'success' ? 'bg-green-500' : 'bg-red-500')
                  }
                ></span>
                <div>
                  <p class="text-gray-700">{l.message}</p>
                  <p class="text-xs text-gray-400">{l.created_at}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <script src="/static/test-run.js"></script>
    </PageLayout>,
    { title: 'テスト実行・実行履歴' }
  )
})

// ---------- テスト実行API（ログイン中ユーザー本人のみ） ----------

automation.post('/api/automation/test-run', requireAuth, async (c) => {
  const user = c.get('user')
  try {
    const summary = await runStyleAutomationForUser(c.env, user.id, 'manual-test')
    return c.json({
      success: summary.status !== 'failed' || summary.successCount > 0,
      successCount: summary.successCount,
      failureCount: summary.failureCount,
      status: summary.status
    })
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

  const { results: schedules } = await c.env.DB.prepare(
    `SELECT user_id, run_times FROM style_post_schedules WHERE enabled = 1`
  ).all<{ user_id: number; run_times: string }>()

  const targets = (schedules || []).filter((s) => {
    try {
      const times: string[] = JSON.parse(s.run_times)
      return times.includes(nowLabel)
    } catch {
      return false
    }
  })

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
