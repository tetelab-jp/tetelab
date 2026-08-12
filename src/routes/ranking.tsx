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
  getAreaCounts,
  crawlAllAreas,
  type AreaOption
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

// --------------------------------------------
// 定期測定: あるユーザーの登録テンプレート全件を1回のrunでまとめて計測する。
// --------------------------------------------
async function runScheduledForUser(env: Bindings, userId: number): Promise<void> {
  const run = await env.DB.prepare(
    `INSERT INTO ranking_runs (user_id, trigger, status) VALUES (?, 'scheduled', 'running')`
  )
    .bind(userId)
    .run()
  const runId = run.meta.last_row_id as number
  try {
    const { results: queries } = await env.DB.prepare(
      `SELECT id, salon_name, service_area_cd, middle_area_cd, small_area_cd, area_label
       FROM ranking_queries WHERE user_id = ? AND is_active = 1 ORDER BY id`
    )
      .bind(userId)
      .all<{
        id: number
        salon_name: string
        service_area_cd: string
        middle_area_cd: string | null
        small_area_cd: string | null
        area_label: string | null
      }>()

    for (const q of queries) {
      const { results: kws } = await env.DB.prepare(
        `SELECT keyword FROM ranking_query_keywords WHERE query_id = ? ORDER BY sort_order, id`
      )
        .bind(q.id)
        .all<{ keyword: string }>()

      for (const { keyword } of kws) {
        const result = await measureRank(
          {
            serviceAreaCd: q.service_area_cd,
            middleAreaCd: q.middle_area_cd || undefined,
            smallAreaCd: q.small_area_cd || undefined
          },
          q.salon_name,
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
            q.id,
            q.salon_name,
            q.area_label,
            q.service_area_cd,
            q.middle_area_cd,
            q.small_area_cd,
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
    console.error('runScheduledForUser failed:', e)
  }
}

/** UTCの "YYYY-MM-DD HH:MM:SS" 文字列を JST の Date に変換 */
function toJstDate(utcTs: string): Date {
  const isoLike = utcTs.includes('T') ? utcTs : utcTs.replace(' ', 'T')
  const d = new Date(isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`)
  return new Date(d.getTime() + 9 * 60 * 60 * 1000)
}

/** JSTの Date を "YYYY-MM-DD" に */
function jstYmd(jst: Date): string {
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(
    jst.getUTCDate()
  ).padStart(2, '0')}`
}

function parseKeywords(body: Record<string, unknown>): string[] {
  const out: string[] = []
  for (let i = 0; i < KEYWORD_SLOTS; i++) {
    const v = body[`keyword_${i}`]
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
  }
  return out
}

// 計測情報入力フォームのエリア/キーワード部品(計測画面・編集画面で共用)
function AreaAndKeywordFields({
  serviceAreaCd,
  middleOptions,
  middleAreaCd,
  smallOptions,
  smallAreaCd,
  keywords
}: {
  serviceAreaCd?: string
  middleOptions?: AreaOption[]
  middleAreaCd?: string | null
  smallOptions?: AreaOption[]
  smallAreaCd?: string | null
  keywords?: string[]
}) {
  const kw = keywords || []
  return (
    <>
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
              <option value={a.cd} selected={serviceAreaCd === a.cd}>
                {a.name}
              </option>
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
            {(middleOptions || []).map((o) => (
              <option value={o.code} selected={middleAreaCd === o.code}>
                {o.name}
              </option>
            ))}
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
            {(smallOptions || []).map((o) => (
              <option value={o.code} selected={smallAreaCd === o.code}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <input type="hidden" id="area-label" name="area_label" value="" />

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-2">キーワード</label>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Array.from({ length: KEYWORD_SLOTS }).map((_, i) => (
            <input
              type="text"
              name={`keyword_${i}`}
              id={`keyword_${i}`}
              value={kw[i] || ''}
              placeholder={`キーワード${i + 1}`}
              class="border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-pink-200"
            />
          ))}
        </div>
      </div>
    </>
  )
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
          <i class="fas fa-circle-check mr-2"></i>計測テンプレートを登録しました。「計測テンプレート設定」で確認・編集できます。
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-5 text-gray-900">計測・情報入力</p>

        <form id="ranking-form" method="post" action="/ranking/templates" class="space-y-5">
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

          <AreaAndKeywordFields />

          {/* 登録名(モーダルで入力してここへ入る) */}
          <input type="hidden" id="template-name" name="name" value="" />

          <p class="text-xs text-gray-500">
            「登録」ボタンを押すと入力した計測情報が「計測テンプレート設定」に保存され、「定期測定設定」で設定した頻度で定期的に自動計測できます。
          </p>

          <p id="measure-status" class="text-sm text-pink-600"></p>

          <div class="flex items-center justify-end gap-3">
            <button
              type="button"
              id="register-open-btn"
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

      {/* 登録名入力モーダル */}
      <div
        id="register-modal"
        class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      >
        <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
          <p class="font-semibold text-gray-900 mb-1">計測テンプレートの登録</p>
          <p class="text-xs text-gray-500 mb-4">この計測条件に名前を付けて保存します（管理用）。</p>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            テンプレート名 <span class="text-pink-500">*</span>
          </label>
          <input
            type="text"
            id="modal-template-name"
            placeholder="例: 赤羽・髪質改善セット"
            class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-pink-200"
          />
          <p id="modal-error" class="text-xs text-red-500 min-h-[1rem]"></p>
          <div class="flex items-center justify-end gap-3 mt-3">
            <button
              type="button"
              id="register-cancel-btn"
              class="text-sm text-gray-500 hover:text-gray-700 px-4 py-2"
            >
              キャンセル
            </button>
            <button
              type="button"
              id="register-confirm-btn"
              class="bg-green-500 hover:bg-green-600 text-white font-semibold px-6 py-2 rounded-lg text-sm"
            >
              保存する
            </button>
          </div>
        </div>
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
                    <td class="py-2 pr-3 text-gray-500">
                      {r.result_count != null ? `${r.result_count}件` : '-'}
                    </td>
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
  void processMeasureRun(c.env, user.id, runId, null, params)

  return c.json({ success: true, runId, count: keywords.length })
})

// ============================================
// 計測テンプレートの作成(計測画面の「登録」モーダル)
// ============================================
ranking.post('/ranking/templates', requireAuth, async (c) => {
  const user = c.get('user')
  const body = (await c.req.parseBody()) as Record<string, unknown>

  const name = String(body.name || '').trim()
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
      (user_id, name, salon_name, service_area_cd, middle_area_cd, small_area_cd, area_label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(user.id, name || null, salon, serviceAreaCd, middleAreaCd, smallAreaCd, areaLabel)
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
// 計測テンプレート設定(一覧)
// ============================================
ranking.get('/ranking/templates', requireAuth, async (c) => {
  const user = c.get('user')
  const { results: queries } = await c.env.DB.prepare(
    `SELECT id, name, salon_name, area_label, created_at
     FROM ranking_queries WHERE user_id = ? ORDER BY id DESC`
  )
    .bind(user.id)
    .all<{
      id: number
      name: string | null
      salon_name: string
      area_label: string | null
      created_at: string
    }>()

  return c.render(
    <PageLayout active="ranking-templates" salonName={user.salon_name} title="計測テンプレート設定">
      <div class="flex items-center justify-between">
        <p class="font-semibold">
          <i class="fas fa-list-check mr-2 text-pink-500"></i>計測テンプレート一覧（{queries.length}件）
        </p>
        <a
          href="/ranking"
          class="bg-pink-500 hover:bg-pink-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
        >
          <i class="fas fa-plus mr-1"></i>計測画面で新規登録
        </a>
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        {queries.length === 0 ? (
          <p class="text-sm text-gray-400 text-center py-6">
            まだ計測テンプレートが登録されていません。「計測」画面で条件を入力し「登録」ボタンから保存できます。
          </p>
        ) : (
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-400 border-b border-gray-100">
                <th class="py-2">テンプレート名</th>
                <th class="py-2">設定エリア</th>
                <th class="py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {queries.map((q) => (
                <tr class="border-b border-gray-50">
                  <td class="py-2">
                    <a href={`/ranking/templates/${q.id}/edit`} class="text-pink-600 hover:underline">
                      {q.name || `${q.salon_name}（無名）`}
                    </a>
                  </td>
                  <td class="py-2 text-gray-600">{q.area_label || '-'}</td>
                  <td class="py-2 text-right">
                    <a
                      href={`/ranking/templates/${q.id}/edit`}
                      class="text-xs text-gray-400 hover:text-pink-600"
                    >
                      編集
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </PageLayout>
  )
})

// ============================================
// 計測テンプレート編集
// ============================================
ranking.get('/ranking/templates/:id/edit', requireAuth, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const q = await c.env.DB.prepare(
    `SELECT id, name, salon_name, service_area_cd, middle_area_cd, small_area_cd, area_label
     FROM ranking_queries WHERE id = ? AND user_id = ?`
  )
    .bind(id, user.id)
    .first<{
      id: number
      name: string | null
      salon_name: string
      service_area_cd: string
      middle_area_cd: string | null
      small_area_cd: string | null
      area_label: string | null
    }>()
  if (!q) return c.redirect('/ranking/templates')

  const { results: kwRows } = await c.env.DB.prepare(
    `SELECT keyword FROM ranking_query_keywords WHERE query_id = ? ORDER BY sort_order, id`
  )
    .bind(id)
    .all<{ keyword: string }>()
  const keywords = kwRows.map((r) => r.keyword)

  const salons = await getSalonOptions(c.env, user.id, user.salon_name)
  if (!salons.includes(q.salon_name)) salons.unshift(q.salon_name)

  // エリア選択肢(保存済みを選択状態に。取得失敗時は保存済みコードだけをフォールバック表示)
  const labelParts = (q.area_label || '').split('>').map((s) => s.trim())
  let middleOptions: AreaOption[] = []
  let smallOptions: AreaOption[] = []
  try {
    middleOptions = await getMiddleAreas(c.env, q.service_area_cd)
  } catch {
    if (q.middle_area_cd) middleOptions = [{ code: q.middle_area_cd, name: labelParts[1] || q.middle_area_cd }]
  }
  try {
    if (q.middle_area_cd) smallOptions = await getSmallAreas(c.env, q.service_area_cd, q.middle_area_cd)
  } catch {
    if (q.small_area_cd) smallOptions = [{ code: q.small_area_cd, name: labelParts[2] || q.small_area_cd }]
  }

  return c.render(
    <PageLayout active="ranking-templates" salonName={user.salon_name} title="計測テンプレート編集">
      <div class="bg-white rounded-xl border border-gray-100 p-6 max-w-3xl">
        <p class="font-semibold mb-5 text-gray-900">計測テンプレート編集</p>
        <form id="ranking-form" method="post" action={`/ranking/templates/${q.id}`} class="space-y-5">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              テンプレート名 <span class="text-pink-500">*</span>
            </label>
            <input
              type="text"
              name="name"
              required
              value={q.name || ''}
              class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-pink-200"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              サロン名 <span class="text-pink-500">*</span>
            </label>
            <select
              name="salon"
              required
              class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-pink-200"
            >
              {salons.map((s) => (
                <option value={s} selected={s === q.salon_name}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <AreaAndKeywordFields
            serviceAreaCd={q.service_area_cd}
            middleOptions={middleOptions}
            middleAreaCd={q.middle_area_cd}
            smallOptions={smallOptions}
            smallAreaCd={q.small_area_cd}
            keywords={keywords}
          />

          <div class="flex items-center justify-between pt-2">
            <button
              type="submit"
              formaction={`/ranking/templates/${q.id}/delete`}
              class="text-sm text-gray-400 hover:text-red-500"
            >
              <i class="fas fa-trash mr-1"></i>削除
            </button>
            <button
              type="submit"
              class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-8 py-2.5 rounded-lg text-sm"
            >
              保存
            </button>
          </div>
        </form>
      </div>
      <script src="/static/ranking.js"></script>
    </PageLayout>
  )
})

ranking.post('/ranking/templates/:id', requireAuth, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = (await c.req.parseBody()) as Record<string, unknown>

  const owned = await c.env.DB.prepare(`SELECT id FROM ranking_queries WHERE id = ? AND user_id = ?`)
    .bind(id, user.id)
    .first<{ id: number }>()
  if (!owned) return c.redirect('/ranking/templates')

  const name = String(body.name || '').trim()
  const salon = String(body.salon || '').trim()
  const serviceAreaCd = String(body.service_area_cd || '').trim()
  const middleAreaCd = String(body.middle_area_cd || '').trim() || null
  const smallAreaCd = String(body.small_area_cd || '').trim() || null
  const areaLabel = String(body.area_label || '').trim() || serviceAreaName(serviceAreaCd)
  const keywords = parseKeywords(body)

  await c.env.DB.prepare(
    `UPDATE ranking_queries
       SET name = ?, salon_name = ?, service_area_cd = ?, middle_area_cd = ?, small_area_cd = ?,
           area_label = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(name || null, salon, serviceAreaCd, middleAreaCd, smallAreaCd, areaLabel, id, user.id)
    .run()

  await c.env.DB.prepare(`DELETE FROM ranking_query_keywords WHERE query_id = ?`).bind(id).run()
  let order = 0
  for (const kw of keywords) {
    await c.env.DB.prepare(
      `INSERT INTO ranking_query_keywords (query_id, keyword, sort_order) VALUES (?, ?, ?)`
    )
      .bind(id, kw, order++)
      .run()
  }

  return c.redirect('/ranking/templates')
})

ranking.post('/ranking/templates/:id/delete', requireAuth, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (Number.isFinite(id)) {
    await c.env.DB.prepare(`DELETE FROM ranking_queries WHERE id = ? AND user_id = ?`)
      .bind(id, user.id)
      .run()
  }
  return c.redirect('/ranking/templates')
})

// ============================================
// 定期測定設定
// ============================================
ranking.get('/ranking/schedule', requireAuth, async (c) => {
  const user = c.get('user')
  const sched = await c.env.DB.prepare(
    `SELECT enabled, frequency, run_time, last_run_at FROM ranking_schedules WHERE user_id = ?`
  )
    .bind(user.id)
    .first<{ enabled: number; frequency: string; run_time: string | null; last_run_at: string | null }>()

  const saved = c.req.query('saved') === '1'
  const enabled = sched?.enabled === 1
  const frequency = sched?.frequency || 'daily'
  const runTime = sched?.run_time || '09:00'
  const lastRunAt = sched?.last_run_at || null
  const areaCounts = await getAreaCounts(c.env)

  return c.render(
    <PageLayout active="ranking-schedule" salonName={user.salon_name} title="定期測定設定">
      {saved && (
        <div class="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
          <i class="fas fa-circle-check mr-2"></i>定期測定設定を保存しました。
        </div>
      )}
      <div class="bg-white rounded-xl border border-gray-100 p-6 max-w-lg">
        <p class="font-semibold mb-4">定期測定設定</p>
        <p class="text-sm text-gray-500 mb-2">
          「計測テンプレート設定」に登録した条件を、設定した頻度で自動計測します。
        </p>
        <p class="text-xs text-gray-400 mb-5">
          前回の定期実行：{lastRunAt ? formatJstDateTime(lastRunAt) : 'なし'}
        </p>
        <form method="post" action="/ranking/schedule" class="space-y-5">
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" value="1" checked={enabled} class="w-4 h-4" />
            定期測定を有効にする
          </label>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">頻度</label>
            <select name="frequency" class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm bg-white">
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

      {/* エリアマスター(全国エリアの一括取得) */}
      <div class="bg-white rounded-xl border border-gray-100 p-6 max-w-lg">
        <p class="font-semibold mb-2">エリアマスター</p>
        <p class="text-sm text-gray-500 mb-3">
          「計測」画面のエリア選択肢に使う全国エリア（中/小）を一括取得します。
          数分かかります。取得後にページを再読み込みすると件数が更新されます。
        </p>
        <p class="text-sm text-gray-700 mb-3">
          現在：中エリア <b>{areaCounts.middle}</b> 件 ／ 小エリア <b>{areaCounts.small}</b> 件
        </p>
        <button
          type="button"
          id="area-refresh-btn"
          class="border border-gray-300 hover:border-pink-400 text-gray-700 font-semibold px-5 py-2 rounded-lg text-sm disabled:opacity-50"
        >
          <i class="fas fa-cloud-arrow-down mr-1"></i>全国エリアを一括取得
        </button>
        <p id="area-refresh-status" class="text-sm text-gray-500 mt-3"></p>
      </div>

      <script src="/static/ranking.js"></script>
    </PageLayout>
  )
})

// 全国エリアの一括クロール(バックグラウンド起動)
ranking.post('/ranking/areas/refresh', requireAuth, async (c) => {
  void crawlAllAreas(c.env, { force: true }).catch((e) => console.error('crawlAllAreas failed:', e))
  return c.json({ success: true })
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
// 定期測定の実行(外部Cronから CRON_SECRET で叩く。セッション不要)
// 外部Cronは数分間隔でこのエンドポイントを叩く想定。呼ばれるたびに
// 「enabledな設定のうち、今日(または今週)まだ実行しておらず、run_timeを
// 過ぎているユーザー」を実行する。実測はバックグラウンドで進める。
// ============================================
ranking.post('/api/cron/run-ranking', async (c) => {
  const authHeader = c.req.header('Authorization') || ''
  const expected = c.env.CRON_SECRET
  if (!expected || authHeader !== `Bearer ${expected}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const nowUtc = new Date()
  const jstNow = new Date(nowUtc.getTime() + 9 * 60 * 60 * 1000)
  const jstHHMM = `${String(jstNow.getUTCHours()).padStart(2, '0')}:${String(
    jstNow.getUTCMinutes()
  ).padStart(2, '0')}`
  const jstToday = jstYmd(jstNow)

  const { results: schedules } = await c.env.DB.prepare(
    `SELECT user_id, frequency, run_time, last_run_at FROM ranking_schedules WHERE enabled = 1`
  ).all<{ user_id: number; frequency: string; run_time: string | null; last_run_at: string | null }>()

  const triggered: number[] = []
  for (const s of schedules) {
    const runTime = s.run_time || '09:00'
    if (jstHHMM < runTime) continue // まだ実行時刻前

    if (s.last_run_at) {
      const lastJst = toJstDate(s.last_run_at)
      if (s.frequency === 'weekly') {
        const days = (nowUtc.getTime() - lastJst.getTime() + 9 * 3600 * 1000) / (24 * 3600 * 1000)
        if (days < 7) continue // 今週分は実行済み
      } else if (jstYmd(lastJst) === jstToday) {
        continue // 今日分は実行済み
      }
    }

    // 二重起動防止のため、実測前に last_run_at を更新してから起動する
    await c.env.DB.prepare(
      `UPDATE ranking_schedules SET last_run_at = CURRENT_TIMESTAMP WHERE user_id = ?`
    )
      .bind(s.user_id)
      .run()
    void runScheduledForUser(c.env, s.user_id).catch((e) => console.error('runScheduledForUser failed:', e))
    triggered.push(s.user_id)
  }

  return c.json({ time: jstHHMM, date: jstToday, enabled: schedules.length, triggered })
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
