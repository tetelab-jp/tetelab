import { Hono } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import { formatJstDateTime } from '../lib/date-format'
import { measureRank } from '../lib/ranking-scraper'
import {
  SERVICE_AREAS,
  serviceAreaName,
  getMiddleAreas,
  getSmallAreas,
  getSalonOptions,
  buildAreaLabel
} from '../lib/ranking-areas'
import type { Bindings, AppUser } from '../types'

const ranking = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

const KEYWORD_SLOTS = 10
const MEASURE_MAX_PAGES = 50

type MeasureParams = {
  salon: string
  serviceAreaCd: string
  middleAreaCd: string | null
  smallAreaCd: string | null
  areaLabel: string
  keywords: string[]
}

// --------------------------------------------
// バックグラウンド計測: run配下の各キーワードを順に計測して結果を保存する。
// レスポンスを待たせないため、measureエンドポイントからは await せずに起動する。
// --------------------------------------------
async function processMeasureRun(
  env: Bindings,
  userId: number,
  runId: number,
  queryId: number | null,
  params: MeasureParams
): Promise<void> {
  try {
    for (const keyword of params.keywords) {
      const result = await measureRank(
        {
          serviceAreaCd: params.serviceAreaCd,
          middleAreaCd: params.middleAreaCd || undefined,
          smallAreaCd: params.smallAreaCd || undefined
        },
        params.salon,
        keyword,
        { proxyUrl: env.RANKING_PROXY_URL, maxPages: MEASURE_MAX_PAGES }
      )
      await env.DB.prepare(
        `INSERT INTO ranking_results
          (user_id, run_id, query_id, salon_name, area_label, service_area_cd, middle_area_cd, small_area_cd,
           keyword, rank, result_count, pages_scanned, matched_sln_id, status, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          userId,
          runId,
          queryId,
          params.salon,
          params.areaLabel,
          params.serviceAreaCd,
          params.middleAreaCd,
          params.smallAreaCd,
          keyword,
          result.rank,
          result.resultCount,
          result.pagesScanned,
          result.matchedSlnId,
          result.status,
          result.errorMessage || null
        )
        .run()
    }
    await env.DB.prepare(
      `UPDATE ranking_runs SET status = 'done', finished_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(runId)
      .run()
  } catch (e) {
    await env.DB.prepare(
      `UPDATE ranking_runs SET status = 'error', finished_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(runId)
      .run()
    console.error('processMeasureRun failed:', e)
  }
}

function parseKeywords(body: Record<string, unknown>): string[] {
  const out: string[] = []
  for (let i = 0; i < KEYWORD_SLOTS; i++) {
    const v = body[`keyword_${i}`]
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
  }
  return out
}

// ============================================
// 計測画面
// ============================================
ranking.get('/ranking', requireAuth, async (c) => {
  const user = c.get('user')
  const salons = await getSalonOptions(c.env, user.id, user.salon_name)

  const { results: rows } = await c.env.DB.prepare(
    `SELECT measured_at, area_label, keyword, rank, result_count, status
     FROM ranking_results WHERE user_id = ? ORDER BY id DESC LIMIT 100`
  )
    .bind(user.id)
    .all<{
      measured_at: string
      area_label: string | null
      keyword: string
      rank: number | null
      result_count: number | null
      status: string
    }>()

  const runningRun = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ranking_runs WHERE user_id = ? AND status = 'running'`
  )
    .bind(user.id)
    .first<{ n: number }>()
  const hasRunning = (runningRun?.n || 0) > 0

  const registered = c.req.query('registered') === '1'

  return c.render(
    <PageLayout active="ranking-measure" salonName={user.salon_name} title="検索順位計測">
      {registered && (
        <div class="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
          <i class="fas fa-circle-check mr-2"></i>計測情報を登録しました。「計測情報登録設定」で確認・編集できます。
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-5 text-gray-900">計測・情報入力</p>

        <form id="ranking-form" method="post" action="/ranking/register" class="space-y-5">
          {/* サロン名 */}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              サロン名 <span class="text-pink-500">*</span>
            </label>
            <select
              name="salon"
              required
              class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-pink-200"
            >
              <option value="">選択してください</option>
              {salons.map((s) => (
                <option value={s}>{s}</option>
              ))}
            </select>
            {salons.length === 0 && (
              <p class="text-xs text-amber-600 mt-1">
                サロン名が未登録です。「サロンボード連携設定」でサロン名を登録すると選択できます。
              </p>
            )}
          </div>

          {/* エリア(大/中/小) */}
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">
                大エリア <span class="text-pink-500">*</span>
              </label>
              <select
                id="service-area"
                name="service_area_cd"
                required
                class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-pink-200"
              >
                <option value="">選択してください</option>
                {SERVICE_AREAS.map((a) => (
                  <option value={a.cd}>{a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">中エリア</label>
              <select
                id="middle-area"
                name="middle_area_cd"
                class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-pink-200"
              >
                <option value="">選択してください</option>
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">小エリア</label>
              <select
                id="small-area"
                name="small_area_cd"
                class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-pink-200"
              >
                <option value="">選択してください（任意）</option>
              </select>
            </div>
          </div>
          <input type="hidden" id="area-label" name="area_label" value="" />

          {/* キーワード(最大10) */}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">キーワード</label>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Array.from({ length: KEYWORD_SLOTS }).map((_, i) => (
                <input
                  type="text"
                  name={`keyword_${i}`}
                  id={`keyword_${i}`}
                  placeholder={`キーワード${i + 1}`}
                  class="border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-pink-200"
                />
              ))}
            </div>
          </div>

          <p class="text-xs text-gray-500">
            「登録」ボタンを押すと入力した計測情報が「計測情報登録設定」に保存され、「定期測定設定」で設定した頻度で定期的に自動計測できます。
          </p>

          <p id="measure-status" class="text-sm text-pink-600"></p>

          <div class="flex items-center justify-end gap-3">
            <button
              type="submit"
              class="bg-green-500 hover:bg-green-600 text-white font-semibold px-8 py-2.5 rounded-lg text-sm"
            >
              登録
            </button>
            <button
              type="button"
              id="measure-btn"
              class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-8 py-2.5 rounded-lg text-sm disabled:opacity-50"
            >
              計測
            </button>
          </div>
        </form>
      </div>

      {/* 計測結果履歴 */}
      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <div class="flex items-center justify-between mb-3">
          <p class="font-semibold">
            <i class="fas fa-clock-rotate-left mr-2 text-pink-500"></i>計測結果履歴
          </p>
          {hasRunning && (
            <span class="text-xs text-pink-600">
              <i class="fas fa-spinner fa-spin mr-1"></i>計測中の実行があります（自動反映）
            </span>
          )}
        </div>
        {!rows || rows.length === 0 ? (
          <p class="text-sm text-gray-400">まだ計測結果がありません</p>
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-400 border-b border-gray-100">
                  <th class="py-2 pr-3">計測日時</th>
                  <th class="py-2 pr-3">エリア</th>
                  <th class="py-2 pr-3">キーワード</th>
                  <th class="py-2 pr-3">順位</th>
                  <th class="py-2 pr-3">該当数</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr class="border-b border-gray-50">
                    <td class="py-2 pr-3 text-xs text-gray-400 whitespace-nowrap">
                      {formatJstDateTime(r.measured_at)}
                    </td>
                    <td class="py-2 pr-3 text-gray-600">{r.area_label || '-'}</td>
                    <td class="py-2 pr-3 text-gray-700">{r.keyword}</td>
                    <td class="py-2 pr-3">
                      {r.status === 'error' ? (
                        <span class="text-xs text-red-500">エラー</span>
                      ) : r.rank == null ? (
                        <span class="text-xs text-gray-400">圏外</span>
                      ) : (
                        <span class="font-semibold text-gray-900">{r.rank}位</span>
                      )}
                    </td>
                    <td class="py-2 pr-3 text-gray-500">{r.result_count != null ? `${r.result_count}件` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <script src="/static/ranking.js"></script>
    </PageLayout>
  )
})

// ============================================
// 計測実行(バックグラウンド起動 / JSON)
// ============================================
ranking.post('/ranking/measure', requireAuth, async (c) => {
  const user = c.get('user')
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, error: 'リクエスト形式が不正です' }, 400)
  }

  const salon = String(body.salon || '').trim()
  const serviceAreaCd = String(body.service_area_cd || '').trim()
  const middleAreaCd = String(body.middle_area_cd || '').trim() || null
  const smallAreaCd = String(body.small_area_cd || '').trim() || null
  const areaLabel = String(body.area_label || '').trim()
  const keywords = Array.isArray(body.keywords)
    ? (body.keywords as unknown[]).map((k) => String(k).trim()).filter(Boolean).slice(0, KEYWORD_SLOTS)
    : []

  if (!salon || !serviceAreaCd) return c.json({ success: false, error: 'サロン名と大エリアは必須です' }, 400)
  if (keywords.length === 0) return c.json({ success: false, error: 'キーワードを1つ以上入力してください' }, 400)

  const run = await c.env.DB.prepare(
    `INSERT INTO ranking_runs (user_id, trigger, status) VALUES (?, 'manual', 'running')`
  )
    .bind(user.id)
    .run()
  const runId = run.meta.last_row_id as number

  const params: MeasureParams = {
    salon,
    serviceAreaCd,
    middleAreaCd,
    smallAreaCd,
    areaLabel: areaLabel || serviceAreaName(serviceAreaCd),
    keywords
  }
  // レスポンスを待たせずバックグラウンドで計測(常駐Nodeサーバーなので継続する)
  void processMeasureRun(c.env, user.id, runId, null, params)

  return c.json({ success: true, runId, count: keywords.length })
})

// ============================================
// 計測情報の登録(「登録」ボタン)
// ============================================
ranking.post('/ranking/register', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.parseBody()) as Record<string, unknown>

  const salon = String(body.salon || '').trim()
  const serviceAreaCd = String(body.service_area_cd || '').trim()
  const middleAreaCd = String(body.middle_area_cd || '').trim() || null
  const smallAreaCd = String(body.small_area_cd || '').trim() || null
  const areaLabel = String(body.area_label || '').trim() || serviceAreaName(serviceAreaCd)
  const keywords = parseKeywords(body)

  if (!salon || !serviceAreaCd || keywords.length === 0) {
    return c.redirect('/ranking?error=1')
  }

  const q = await c.env.DB.prepare(
    `INSERT INTO ranking_queries
      (user_id, salon_name, service_area_cd, middle_area_cd, small_area_cd, area_label)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(user.id, salon, serviceAreaCd, middleAreaCd, smallAreaCd, areaLabel)
    .run()
  const queryId = q.meta.last_row_id as number

  let order = 0
  for (const kw of keywords) {
    await c.env.DB.prepare(
      `INSERT INTO ranking_query_keywords (query_id, keyword, sort_order) VALUES (?, ?, ?)`
    )
      .bind(queryId, kw, order++)
      .run()
  }

  return c.redirect('/ranking?registered=1')
})

// ============================================
// 計測情報登録設定(一覧・削除)
// ============================================
ranking.get('/ranking/registry', requireAuth, async (c) => {
  const user = c.get('user')
  const { results: queries } = await c.env.DB.prepare(
    `SELECT id, salon_name, area_label, is_active, created_at
     FROM ranking_queries WHERE user_id = ? ORDER BY id DESC`
  )
    .bind(user.id)
    .all<{
      id: number
      salon_name: string
      area_label: string | null
      is_active: number
      created_at: string
    }>()

  const { results: kws } = await c.env.DB.prepare(
    `SELECT k.query_id, k.keyword FROM ranking_query_keywords k
     JOIN ranking_queries q ON q.id = k.query_id
     WHERE q.user_id = ? ORDER BY k.sort_order, k.id`
  )
    .bind(user.id)
    .all<{ query_id: number; keyword: string }>()
  const kwByQuery = new Map<number, string[]>()
  for (const k of kws) {
    if (!kwByQuery.has(k.query_id)) kwByQuery.set(k.query_id, [])
    kwByQuery.get(k.query_id)!.push(k.keyword)
  }

  return c.render(
    <PageLayout active="ranking-registry" salonName={user.salon_name} title="計測情報登録設定">
      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-4">登録済みの計測情報</p>
        {!queries || queries.length === 0 ? (
          <p class="text-sm text-gray-400">
            登録済みの計測情報はありません。「計測」画面で条件を入力し「登録」ボタンを押すと保存されます。
          </p>
        ) : (
          <ul class="divide-y divide-gray-100">
            {queries.map((q) => (
              <li class="py-4 flex items-start justify-between gap-4">
                <div class="min-w-0">
                  <p class="font-medium text-gray-900">{q.salon_name}</p>
                  <p class="text-xs text-gray-500 mt-0.5">{q.area_label || '-'}</p>
                  <div class="flex flex-wrap gap-1.5 mt-2">
                    {(kwByQuery.get(q.id) || []).map((kw) => (
                      <span class="text-xs bg-gray-50 text-gray-600 rounded px-2 py-0.5">{kw}</span>
                    ))}
                  </div>
                </div>
                <form method="post" action={`/ranking/registry/${q.id}/delete`} class="flex-shrink-0">
                  <button
                    type="submit"
                    class="text-xs font-semibold text-gray-400 hover:text-red-500 border border-gray-300 rounded px-3 py-1.5"
                  >
                    <i class="fas fa-trash mr-1"></i>削除
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </PageLayout>
  )
})

ranking.post('/ranking/registry/:id/delete', requireAuth, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (Number.isFinite(id)) {
    await c.env.DB.prepare(`DELETE FROM ranking_queries WHERE id = ? AND user_id = ?`)
      .bind(id, user.id)
      .run()
  }
  return c.redirect('/ranking/registry')
})

// ============================================
// 定期測定設定
// ============================================
ranking.get('/ranking/schedule', requireAuth, async (c) => {
  const user = c.get('user')
  const sched = await c.env.DB.prepare(
    `SELECT enabled, frequency, run_time FROM ranking_schedules WHERE user_id = ?`
  )
    .bind(user.id)
    .first<{ enabled: number; frequency: string; run_time: string | null }>()

  const saved = c.req.query('saved') === '1'
  const enabled = sched?.enabled === 1
  const frequency = sched?.frequency || 'daily'
  const runTime = sched?.run_time || '09:00'

  return c.render(
    <PageLayout active="ranking-schedule" salonName={user.salon_name} title="定期測定設定">
      {saved && (
        <div class="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
          <i class="fas fa-circle-check mr-2"></i>定期測定設定を保存しました。
        </div>
      )}
      <div class="bg-white rounded-xl border border-gray-100 p-6 max-w-lg">
        <p class="font-semibold mb-4">定期測定設定</p>
        <p class="text-sm text-gray-500 mb-5">
          「計測情報登録設定」に登録した条件を、設定した頻度で自動計測します。
        </p>
        <form method="post" action="/ranking/schedule" class="space-y-5">
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" value="1" checked={enabled} class="w-4 h-4" />
            定期測定を有効にする
          </label>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">頻度</label>
            <select
              name="frequency"
              class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm bg-white"
            >
              <option value="daily" selected={frequency === 'daily'}>
                毎日
              </option>
              <option value="weekly" selected={frequency === 'weekly'}>
                毎週
              </option>
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">実行時刻(JST)</label>
            <input
              type="time"
              name="run_time"
              value={runTime}
              class="border border-gray-300 rounded-lg px-3 py-2.5 text-sm"
            />
          </div>
          <div class="flex justify-end">
            <button
              type="submit"
              class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-8 py-2.5 rounded-lg text-sm"
            >
              保存
            </button>
          </div>
        </form>
      </div>
    </PageLayout>
  )
})

ranking.post('/ranking/schedule', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.parseBody()) as Record<string, unknown>
  const enabled = body.enabled ? 1 : 0
  const frequency = String(body.frequency || 'daily')
  const runTime = String(body.run_time || '09:00')

  const existing = await c.env.DB.prepare(`SELECT id FROM ranking_schedules WHERE user_id = ?`)
    .bind(user.id)
    .first<{ id: number }>()
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE ranking_schedules SET enabled = ?, frequency = ?, run_time = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
    )
      .bind(enabled, frequency, runTime, user.id)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO ranking_schedules (user_id, enabled, frequency, run_time) VALUES (?, ?, ?, ?)`
    )
      .bind(user.id, enabled, frequency, runTime)
      .run()
  }
  return c.redirect('/ranking/schedule?saved=1')
})

// ============================================
// エリアのカスケード用JSON API(中/小エリアをオンデマンド取得)
// ============================================
ranking.get('/ranking/api/areas', requireAuth, async (c) => {
  const level = c.req.query('level')
  const service = String(c.req.query('service') || '').trim()
  const middle = String(c.req.query('middle') || '').trim()
  if (!service) return c.json({ options: [] })
  try {
    if (level === 'middle') {
      const options = await getMiddleAreas(c.env, service)
      return c.json({ options })
    }
    if (level === 'small' && middle) {
      const options = await getSmallAreas(c.env, service, middle)
      return c.json({ options })
    }
  } catch (e) {
    return c.json({ options: [], error: e instanceof Error ? e.message : String(e) }, 200)
  }
  return c.json({ options: [] })
})

export default ranking

// buildAreaLabel はクライアント側(ranking.js)で表示ラベルを組み立てるため
// サーバー側では直接使わないが、将来のcron計測での利用に備えてimportを保持する。
void buildAreaLabel
