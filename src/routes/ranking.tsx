import { Hono } from 'hono'
import { requireAuth, requireSeoEnabled } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import { formatJstDateTime } from '../lib/date-format'
import { measureRank } from '../lib/ranking-scraper'
import { getPrimarySalonArea, buildAreaLabel, type PrimarySalonArea } from '../lib/ranking-areas'
import type { Bindings, AppUser } from '../types'

const ranking = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

const KEYWORD_SLOTS_MAX = 20
const MEASURE_MAX_PAGES = 50

// --------------------------------------------
// 指定テンプレート(未指定なら有効な全テンプレート)を1つのrunでまとめて計測する。
// レスポンスを待たせないため呼び出し側は await せずに起動する。手動計測・定期計測で共用。
// --------------------------------------------
async function runTemplates(
  env: Bindings,
  userId: number,
  runId: number,
  queryIds?: number[]
): Promise<void> {
  try {
    let sql =
      `SELECT id, salon_name, service_area_cd, middle_area_cd, small_area_cd, area_label
       FROM ranking_queries WHERE user_id = ? AND is_active = 1`
    const binds: unknown[] = [userId]
    if (queryIds && queryIds.length > 0) {
      sql += ` AND id IN (${queryIds.map(() => '?').join(',')})`
      binds.push(...queryIds)
    }
    sql += ` ORDER BY id`
    const { results: queries } = await env.DB.prepare(sql)
      .bind(...binds)
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

      const measureOptions = { proxyUrl: env.RANKING_PROXY_URL, maxPages: MEASURE_MAX_PAGES }
      const insertResult = async (
        keyword: string,
        scope: 'middle' | 'small',
        smallAreaCd: string | null,
        result: Awaited<ReturnType<typeof measureRank>>
      ) => {
        await env.DB.prepare(
          `INSERT INTO ranking_results
            (user_id, run_id, query_id, salon_name, area_label, service_area_cd, middle_area_cd, small_area_cd,
             area_scope, keyword, rank, result_count, pages_scanned, matched_sln_id, status, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            userId,
            runId,
            q.id,
            q.salon_name,
            q.area_label,
            q.service_area_cd,
            q.middle_area_cd,
            smallAreaCd,
            scope,
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

      for (const { keyword } of kws) {
        // 中エリア(小エリアで絞り込まない)での順位
        const middleResult = await measureRank(
          { serviceAreaCd: q.service_area_cd, middleAreaCd: q.middle_area_cd || undefined },
          q.salon_name,
          keyword,
          measureOptions
        )
        await insertResult(keyword, 'middle', null, middleResult)

        // 小エリア(検出できていれば)での順位
        if (q.small_area_cd) {
          const smallResult = await measureRank(
            {
              serviceAreaCd: q.service_area_cd,
              middleAreaCd: q.middle_area_cd || undefined,
              smallAreaCd: q.small_area_cd
            },
            q.salon_name,
            keyword,
            measureOptions
          )
          await insertResult(keyword, 'small', q.small_area_cd, smallResult)
        }
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
    console.error('runTemplates failed:', e)
  }
}

/** 定期測定: あるユーザーの有効な全テンプレートを1runでまとめて計測 */
async function runScheduledForUser(env: Bindings, userId: number): Promise<void> {
  const run = await env.DB.prepare(
    `INSERT INTO ranking_runs (user_id, trigger, status) VALUES (?, 'scheduled', 'running')`
  )
    .bind(userId)
    .run()
  await runTemplates(env, userId, run.meta.last_row_id as number)
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
  for (let i = 0; i < KEYWORD_SLOTS_MAX; i++) {
    const v = body[`keyword_${i}`]
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
  }
  return out.slice(0, KEYWORD_SLOTS_MAX)
}

// サロン名・対策エリア(中/小)は選択式ではなく、サロンボード連携の同期情報から
// 自動入力する(詳細はgetPrimarySalonArea()参照)。フォームには送信用フィールドを
// 持たせず、サーバー側で改めて算出した値を使う(POSTハンドラ参照)。
// data-has-salon/data-has-areaはクライアント側の送信前チェック(ranking.js)用マーカー。
function SalonAndAreaAutoField({ salon }: { salon: PrimarySalonArea | null }) {
  const hasSalon = !!salon?.salonName
  const hasMiddle = !!salon?.middleAreaCd
  const hasSmall = !!salon?.smallAreaCd
  return (
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div id="salon-auto-field" data-has-salon={hasSalon ? '1' : '0'}>
        <label class="block text-sm font-medium text-gray-700 mb-1">サロン名</label>
        {hasSalon ? (
          <p class="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm bg-gray-50 text-gray-700">
            {salon!.salonName}
          </p>
        ) : (
          <p class="text-xs text-amber-600">
            サロン名が未取得です。「サロンボード連携設定」でサロンボードと同期すると自動反映されます。
          </p>
        )}
      </div>
      <div id="area-auto-field" data-has-area={hasMiddle ? '1' : '0'}>
        <label class="block text-sm font-medium text-gray-700 mb-1">中エリア</label>
        {hasMiddle ? (
          <p class="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm bg-gray-50 text-gray-700">
            {salon!.middleAreaName}
          </p>
        ) : (
          <p class="text-xs text-amber-600">
            対策エリアが未取得です。「サロンボード連携設定」でサロンボードと同期すると、HPBのサロンページから自動反映されます。
          </p>
        )}
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">小エリア</label>
        {hasSmall ? (
          <p class="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm bg-gray-50 text-gray-700">
            {salon!.smallAreaName}
          </p>
        ) : (
          <p class="text-xs text-gray-400">-</p>
        )}
      </div>
    </div>
  )
}

// キーワード入力欄(設定画面・編集画面で共用)。
// 入力欄は1個のみで、Enterキーまたは「追加」ボタンでチップとして追加していく
// (public/static/ranking.js側で管理)。送信用のhidden inputはチップの増減に
// 合わせてJS側で keyword_0, keyword_1... と振り直して再生成する。
function KeywordFields({ keywords }: { keywords?: string[] }) {
  const kw = (keywords || []).slice(0, KEYWORD_SLOTS_MAX)
  return (
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-2">
        登録済みの対策キーワード（<span id="keyword-count">{kw.length}</span>件/最大{KEYWORD_SLOTS_MAX}件まで）
      </label>
      <div class="flex gap-2 mb-3">
        <input
          type="text"
          id="keyword-input"
          placeholder="追加するキーワードを入力"
          class="flex-1 border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-pink-200"
        />
        <button
          type="button"
          id="keyword-add-btn"
          class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-5 py-2.5 rounded-lg text-sm flex-shrink-0"
        >
          追加
        </button>
      </div>
      <div id="keyword-chips" class="flex flex-wrap gap-2"></div>
      <div id="keyword-hidden-container">
        {kw.map((k, i) => (
          <input type="hidden" name={`keyword_${i}`} value={k} class="keyword-hidden-input" />
        ))}
      </div>
    </div>
  )
}

type Cell = { rank: number | null; status: string } | undefined

// 順位測定表の1マス(今回順位 + 1つ右の列=前回との比較)
function RankPivotCell({ current, prev }: { current: Cell; prev: Cell }) {
  if (!current) return <span class="text-gray-300">-</span>
  if (current.status === 'error') return <span class="text-xs text-red-500">エラー</span>
  if (current.rank == null) {
    return (
      <span class="text-gray-400 text-sm">
        圏外
        {prev && prev.rank != null && <span class="block text-xs text-red-500">▼ 前回{prev.rank}位</span>}
      </span>
    )
  }
  let badge = <span class="block text-xs text-gray-400">-</span>
  if (prev) {
    if (prev.rank == null) {
      badge = <span class="block text-xs text-green-600">▲ 前回圏外</span>
    } else {
      const diff = prev.rank - current.rank
      badge =
        diff > 0 ? (
          <span class="block text-xs text-green-600">▲{diff}</span>
        ) : diff < 0 ? (
          <span class="block text-xs text-red-500">▼{-diff}</span>
        ) : (
          <span class="block text-xs text-gray-400">±0</span>
        )
    }
  }
  return (
    <span>
      <span class="font-semibold text-gray-900">{current.rank}</span>
      {badge}
    </span>
  )
}

const MEASURE_RUN_COLUMNS = 12

// ============================================
// 計測(表形式: 対策KW×計測日。左が最新、右にいくほど古い。中/小エリアを列で並記)
// ============================================
ranking.get('/seo', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')

  const primaryQuery = await c.env.DB.prepare(
    `SELECT id, salon_name, area_label FROM ranking_queries WHERE user_id = ? ORDER BY id LIMIT 1`
  )
    .bind(user.id)
    .first<{ id: number; salon_name: string; area_label: string | null }>()

  let keywordsList: string[] = []
  if (primaryQuery) {
    const { results } = await c.env.DB.prepare(
      `SELECT keyword FROM ranking_query_keywords WHERE query_id = ? ORDER BY sort_order, id`
    )
      .bind(primaryQuery.id)
      .all<{ keyword: string }>()
    keywordsList = results.map((r) => r.keyword)
  }

  const runningRun = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ranking_runs WHERE user_id = ? AND status = 'running'`
  )
    .bind(user.id)
    .first<{ n: number }>()
  const hasRunning = (runningRun?.n || 0) > 0

  // 計測日の列(直近から最大MEASURE_RUN_COLUMNS件、左が最新)
  let runs: { id: number; measuredAt: string }[] = []
  const cellMap = new Map<string, Cell>()
  if (primaryQuery) {
    const { results: runRows } = await c.env.DB.prepare(
      `SELECT run_id, MIN(measured_at) AS measured_at FROM ranking_results
       WHERE user_id = ? AND query_id = ? GROUP BY run_id ORDER BY run_id DESC LIMIT ?`
    )
      .bind(user.id, primaryQuery.id, MEASURE_RUN_COLUMNS)
      .all<{ run_id: number; measured_at: string }>()
    runs = runRows.map((r) => ({ id: r.run_id, measuredAt: r.measured_at }))

    if (runs.length > 0) {
      const runIds = runs.map((r) => r.id)
      const { results: cellRows } = await c.env.DB.prepare(
        `SELECT run_id, keyword, area_scope, rank, status FROM ranking_results
         WHERE user_id = ? AND query_id = ? AND run_id IN (${runIds.map(() => '?').join(',')})`
      )
        .bind(user.id, primaryQuery.id, ...runIds)
        .all<{ run_id: number; keyword: string; area_scope: string; rank: number | null; status: string }>()
      for (const r of cellRows) {
        cellMap.set(`${r.run_id}||${r.keyword}||${r.area_scope}`, { rank: r.rank, status: r.status })
      }
    }
  }

  const measured = c.req.query('measured') === '1'

  return c.render(
    <PageLayout
      active="ranking-measure"
      salonName={user.salon_name}
      title="順位測定"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
      seoEnabled={user.seo_enabled !== 0}
    >
      {measured && (
        <div class="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
          <i class="fas fa-circle-check mr-2"></i>計測を開始しました。完了次第、下の表に反映されます。
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <div class="flex items-center justify-between mb-2">
          <p class="font-semibold text-gray-900">
            {primaryQuery ? `${primaryQuery.salon_name} ／ ${primaryQuery.area_label || '-'}` : '対策キーワード設定が未登録です'}
          </p>
          <a href="/seo/keywords" class="text-xs text-pink-600 hover:underline">
            <i class="fas fa-pen mr-1"></i>対策キーワードを編集
          </a>
        </div>

        {keywordsList.length === 0 ? (
          <p class="text-sm text-gray-400">
            登録済みのキーワードがありません。
            <a href="/seo/keywords" class="text-pink-600 hover:underline ml-1">
              対策キーワード設定
            </a>
            で追加してください。
          </p>
        ) : (
          <>
            <p class="text-xs text-gray-400 mb-3">
              登録済みキーワード{keywordsList.length}件を、中エリア・小エリアの両方で計測します。
            </p>
            <p id="measure-status" class="text-sm text-pink-600 mb-2"></p>
            <div class="flex items-center justify-end">
              <button
                type="button"
                id="measure-run-btn"
                class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-8 py-2.5 rounded-lg text-sm disabled:opacity-50"
              >
                <i class="fas fa-magnifying-glass-chart mr-1"></i>測定
              </button>
            </div>
          </>
        )}
      </div>

      {/* 計測結果(対策KW×計測日の表。左が最新) */}
      <div class="flex items-center justify-between">
        <p class="font-semibold">
          <i class="fas fa-table mr-2 text-pink-500"></i>KW順位
        </p>
        {hasRunning && (
          <span class="text-xs text-pink-600">
            <i class="fas fa-spinner fa-spin mr-1"></i>計測中（自動反映）
          </span>
        )}
      </div>

      {runs.length === 0 || keywordsList.length === 0 ? (
        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="text-sm text-gray-400">まだ計測結果がありません</p>
        </div>
      ) : (
        <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm text-center border-collapse">
              <thead>
                <tr class="bg-gray-50 border-b border-gray-100">
                  <th class="py-2 px-4 text-left text-gray-500 sticky left-0 bg-gray-50">対策KW</th>
                  {runs.map((run) => (
                    <th class="py-2 px-2 text-gray-500 font-medium border-l border-gray-100" colspan={2}>
                      {formatJstDateTime(run.measuredAt).slice(0, 10)}
                    </th>
                  ))}
                </tr>
                <tr class="bg-gray-50 border-b border-gray-100">
                  <th class="py-1 px-4"></th>
                  {runs.map(() => (
                    <>
                      <th class="py-1 px-2 text-xs text-gray-400 font-normal border-l border-gray-100">中エリア</th>
                      <th class="py-1 px-2 text-xs text-gray-400 font-normal">小エリア</th>
                    </>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keywordsList.map((kw) => (
                  <tr class="border-b border-gray-50">
                    <td class="py-2 px-4 text-left text-gray-700 font-medium sticky left-0 bg-white">{kw}</td>
                    {runs.map((run, i) => {
                      const nextRun = runs[i + 1]
                      const middleCurrent = cellMap.get(`${run.id}||${kw}||middle`)
                      const smallCurrent = cellMap.get(`${run.id}||${kw}||small`)
                      const middlePrev = nextRun ? cellMap.get(`${nextRun.id}||${kw}||middle`) : undefined
                      const smallPrev = nextRun ? cellMap.get(`${nextRun.id}||${kw}||small`) : undefined
                      return (
                        <>
                          <td class="py-2 px-2 border-l border-gray-100">
                            <RankPivotCell current={middleCurrent} prev={middlePrev} />
                          </td>
                          <td class="py-2 px-2">
                            <RankPivotCell current={smallCurrent} prev={smallPrev} />
                          </td>
                        </>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <script src="/static/ranking.js"></script>
    </PageLayout>
  )
})

// 計測実行(登録済みの対策キーワード設定をバックグラウンドで測定 / JSON)
ranking.post('/seo/measure', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')

  const primaryQuery = await c.env.DB.prepare(`SELECT id FROM ranking_queries WHERE user_id = ? ORDER BY id LIMIT 1`)
    .bind(user.id)
    .first<{ id: number }>()
  if (!primaryQuery) {
    return c.json({ success: false, error: '対策キーワード設定がありません' }, 400)
  }

  const kwCount = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ranking_query_keywords WHERE query_id = ?`)
    .bind(primaryQuery.id)
    .first<{ n: number }>()
  if ((kwCount?.n || 0) === 0) {
    return c.json({ success: false, error: 'キーワードが登録されていません' }, 400)
  }

  const run = await c.env.DB.prepare(
    `INSERT INTO ranking_runs (user_id, trigger, status) VALUES (?, 'manual', 'running')`
  )
    .bind(user.id)
    .run()
  void runTemplates(c.env, user.id, run.meta.last_row_id as number, [primaryQuery.id])

  return c.json({ success: true })
})

/**
 * ユーザーの「対策キーワード設定」は、サロン名・エリアが自動検出の1本だけになった
 * ため、名前を付けての複数登録はやめ、既存の最初の1件(無ければ自動作成)へ
 * キーワードを直接追加/削除する方式にした。
 */
async function getOrCreatePrimaryQueryId(env: Bindings, userId: number, salon: PrimarySalonArea): Promise<number> {
  const existing = await env.DB.prepare(`SELECT id FROM ranking_queries WHERE user_id = ? ORDER BY id LIMIT 1`)
    .bind(userId)
    .first<{ id: number }>()
  if (existing) return existing.id

  const areaLabel = buildAreaLabel(salon.middleAreaName, salon.smallAreaName)
  const q = await env.DB.prepare(
    `INSERT INTO ranking_queries (user_id, name, salon_name, service_area_cd, middle_area_cd, small_area_cd, area_label)
     VALUES (?, NULL, ?, ?, ?, ?, ?)`
  )
    .bind(userId, salon.salonName, salon.serviceAreaCd, salon.middleAreaCd, salon.smallAreaCd, areaLabel)
    .run()
  return q.meta.last_row_id as number
}

// ============================================
// 対策キーワード設定(1個ずつ追加 → その場で登録済み一覧に反映)
// ============================================
ranking.get('/seo/keywords', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const salon = await getPrimarySalonArea(c.env, user.id, user.salon_name)

  const existingQuery = await c.env.DB.prepare(`SELECT id FROM ranking_queries WHERE user_id = ? ORDER BY id LIMIT 1`)
    .bind(user.id)
    .first<{ id: number }>()
  let keywords: { id: number; keyword: string }[] = []
  if (existingQuery) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, keyword FROM ranking_query_keywords WHERE query_id = ? ORDER BY sort_order, id`
    )
      .bind(existingQuery.id)
      .all<{ id: number; keyword: string }>()
    keywords = results
  }

  return c.render(
    <PageLayout
      active="ranking-keywords"
      salonName={user.salon_name}
      title="対策キーワード設定"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
      seoEnabled={user.seo_enabled !== 0}
    >
      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-5 text-gray-900">対策キーワード・情報入力</p>
        <SalonAndAreaAutoField salon={salon} />
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-4 text-gray-900">
          <i class="fas fa-list-check mr-2 text-pink-500"></i>対策キーワードを追加する
        </p>
        <div class="flex gap-2">
          <input
            type="text"
            id="keyword-input"
            placeholder="追加するキーワードを入力"
            class="flex-1 border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-pink-200"
          />
          <button
            type="button"
            id="keyword-add-btn"
            class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm flex-shrink-0"
          >
            追加
          </button>
        </div>
        <p id="keyword-add-status" class="text-xs text-red-500 mt-2 min-h-[1rem]"></p>
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-4">
          <i class="fas fa-list-check mr-2 text-pink-500"></i>
          登録済みの対策キーワード（<span id="keyword-count">{keywords.length}</span>件/最大{KEYWORD_SLOTS_MAX}件まで）
        </p>
        <div id="keyword-chips" class="flex flex-wrap gap-2">
          {keywords.length === 0 && (
            <p id="keyword-empty" class="text-sm text-gray-400">
              まだ登録がありません。上の入力欄からキーワードを追加してください。
            </p>
          )}
          {keywords.map((k) => (
            <span
              class="keyword-chip inline-flex items-center gap-1.5 bg-pink-50 text-pink-700 border border-pink-200 rounded-full pl-3 pr-2 py-1 text-sm"
              data-id={k.id}
            >
              <span>{k.keyword}</span>
              <button type="button" class="keyword-remove-btn text-pink-400 hover:text-pink-600 leading-none" data-id={k.id}>
                ×
              </button>
            </span>
          ))}
        </div>
      </div>

      <script src="/static/ranking.js"></script>
    </PageLayout>
  )
})

// キーワードを1件追加(既存の対策キーワード設定が無ければ自動作成)
ranking.post('/api/seo/keywords', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
  const keyword = String(body.keyword || '').trim()
  if (!keyword) return c.json({ success: false, error: 'キーワードを入力してください' }, 400)

  const salon = await getPrimarySalonArea(c.env, user.id, user.salon_name)
  if (!salon?.salonName || !salon.serviceAreaCd || !salon.middleAreaCd) {
    return c.json({ success: false, error: 'サロン名または対策エリアが未取得です。サロンボードと同期してください' }, 400)
  }

  const queryId = await getOrCreatePrimaryQueryId(c.env, user.id, salon)
  const { results: existing } = await c.env.DB.prepare(
    `SELECT id, keyword FROM ranking_query_keywords WHERE query_id = ? ORDER BY sort_order, id`
  )
    .bind(queryId)
    .all<{ id: number; keyword: string }>()

  if (existing.some((e) => e.keyword === keyword)) {
    return c.json({ success: true, keywords: existing })
  }
  if (existing.length >= KEYWORD_SLOTS_MAX) {
    return c.json({ success: false, error: `キーワードは最大${KEYWORD_SLOTS_MAX}件までです` }, 400)
  }

  const ins = await c.env.DB.prepare(
    `INSERT INTO ranking_query_keywords (query_id, keyword, sort_order) VALUES (?, ?, ?)`
  )
    .bind(queryId, keyword, existing.length)
    .run()

  return c.json({ success: true, keywords: [...existing, { id: ins.meta.last_row_id as number, keyword }] })
})

// キーワードを1件削除
ranking.post('/api/seo/keywords/:id/delete', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (Number.isFinite(id)) {
    await c.env.DB.prepare(
      `DELETE FROM ranking_query_keywords
       WHERE id = ? AND query_id IN (SELECT id FROM ranking_queries WHERE user_id = ?)`
    )
      .bind(id, user.id)
      .run()
  }
  return c.json({ success: true })
})

// ============================================
// 対策キーワード編集
// ============================================
ranking.get('/seo/templates/:id/edit', requireAuth, requireSeoEnabled, async (c) => {
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
  if (!q) return c.redirect('/seo/keywords')

  const { results: kwRows } = await c.env.DB.prepare(
    `SELECT keyword FROM ranking_query_keywords WHERE query_id = ? ORDER BY sort_order, id`
  )
    .bind(id)
    .all<{ keyword: string }>()
  const keywords = kwRows.map((r) => r.keyword)

  const salon = await getPrimarySalonArea(c.env, user.id, user.salon_name)

  return c.render(
    <PageLayout
      active="ranking-keywords"
      salonName={user.salon_name}
      title="対策キーワード編集"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
      seoEnabled={user.seo_enabled !== 0}
    >
      <div class="bg-white rounded-xl border border-gray-100 p-6 max-w-3xl">
        <p class="font-semibold mb-5 text-gray-900">対策キーワード編集</p>
        <form id="ranking-form" method="post" action={`/seo/templates/${q.id}`} class="space-y-5">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              登録名 <span class="text-pink-500">*</span>
            </label>
            <input
              type="text"
              name="name"
              required
              value={q.name || ''}
              class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-pink-200"
            />
          </div>

          <SalonAndAreaAutoField salon={salon} />

          <KeywordFields keywords={keywords} />

          <div class="flex items-center justify-between pt-2">
            <button
              type="submit"
              formaction={`/seo/templates/${q.id}/delete`}
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

ranking.post('/seo/templates/:id', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = (await c.req.parseBody()) as Record<string, unknown>

  const owned = await c.env.DB.prepare(`SELECT id FROM ranking_queries WHERE id = ? AND user_id = ?`)
    .bind(id, user.id)
    .first<{ id: number }>()
  if (!owned) return c.redirect('/seo/keywords')

  const name = String(body.name || '').trim()
  // 作成時と同様、サロン名・対策エリアは画面上で編集不可(自動入力)のため送信値を信用しない。
  const salon = await getPrimarySalonArea(c.env, user.id, user.salon_name)
  const keywords = parseKeywords(body)

  if (!salon?.salonName || !salon.serviceAreaCd || !salon.middleAreaCd || keywords.length === 0) {
    return c.redirect(`/seo/templates/${id}/edit?error=1`)
  }
  const areaLabel = buildAreaLabel(salon.middleAreaName, salon.smallAreaName)

  await c.env.DB.prepare(
    `UPDATE ranking_queries
       SET name = ?, salon_name = ?, service_area_cd = ?, middle_area_cd = ?, small_area_cd = ?,
           area_label = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(name || null, salon.salonName, salon.serviceAreaCd, salon.middleAreaCd, salon.smallAreaCd, areaLabel, id, user.id)
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

  return c.redirect('/seo/keywords')
})

ranking.post('/seo/templates/:id/delete', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (Number.isFinite(id)) {
    await c.env.DB.prepare(`DELETE FROM ranking_queries WHERE id = ? AND user_id = ?`)
      .bind(id, user.id)
      .run()
  }
  return c.redirect('/seo/keywords')
})

// ============================================
// 定期測定設定
// ============================================
ranking.get('/seo/schedule', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const sched = await c.env.DB.prepare(
    `SELECT enabled, frequency, run_time, last_run_at FROM ranking_schedules WHERE user_id = ?`
  )
    .bind(user.id)
    .first<{ enabled: number; frequency: string; run_time: string | null; last_run_at: string | null }>()

  const saved = c.req.query('saved') === '1'
  const enabled = sched?.enabled === 1
  const lastRunAt = sched?.last_run_at || null

  return c.render(
    <PageLayout
      active="ranking-schedule"
      salonName={user.salon_name}
      title="定期測定設定"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
      seoEnabled={user.seo_enabled !== 0}
    >
      {saved && (
        <div class="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
          <i class="fas fa-circle-check mr-2"></i>定期測定設定を保存しました。
        </div>
      )}
      <div class="bg-white rounded-xl border border-gray-100 p-6 max-w-lg">
        <p class="font-semibold mb-4">定期測定設定</p>
        <p class="text-sm text-gray-500 mb-2">
          「対策キーワード設定」に登録した条件を、毎週月曜日の夜20時に自動計測します。
        </p>
        <p class="text-xs text-gray-400 mb-5">
          前回の定期実行：{lastRunAt ? formatJstDateTime(lastRunAt) : 'なし'}
        </p>
        <form method="post" action="/seo/schedule">
          <label class="flex items-center gap-3 cursor-pointer w-fit">
            <span class="relative inline-flex items-center flex-shrink-0">
              <input
                type="checkbox"
                name="enabled"
                value="1"
                checked={enabled}
                onchange="this.form.submit()"
                class="sr-only peer"
              />
              <span class="w-14 h-8 bg-gray-200 rounded-full peer-checked:bg-pink-500 transition-colors"></span>
              <span class="absolute left-1 top-1 w-6 h-6 bg-white rounded-full shadow transition-transform peer-checked:translate-x-6"></span>
            </span>
            <span class="text-sm font-medium text-gray-700">定期測定を有効にする（毎週月曜 20:00）</span>
          </label>
        </form>
      </div>
    </PageLayout>
  )
})

ranking.post('/seo/schedule', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const body = (await c.req.parseBody()) as Record<string, unknown>
  const enabled = body.enabled ? 1 : 0
  const frequency = 'weekly'
  const runTime = '20:00'

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
  return c.redirect('/seo/schedule?saved=1')
})

// ============================================
// 定期測定の実行(外部Cronから CRON_SECRET で叩く。セッション不要)
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

  // 定期測定は毎週月曜日固定(getUTCDay: 0=日,1=月,...)。
  if (jstNow.getUTCDay() !== 1) {
    return c.json({ time: jstHHMM, date: jstToday, enabled: 0, triggered: [], skipped: 'not-monday' })
  }

  // 管理者サイトで契約OFF(is_active=0)またはSEO機能OFF(seo_enabled=0)にされた
  // サロンはcronの対象から除外する(automation.tsxの/api/cron/run-style-posts参照)。
  const { results: schedules } = await c.env.DB.prepare(
    `SELECT s.user_id, s.frequency, s.run_time, s.last_run_at
     FROM ranking_schedules s
     JOIN users u ON u.id = s.user_id
     WHERE s.enabled = 1 AND u.is_active = 1 AND u.seo_enabled = 1`
  ).all<{ user_id: number; frequency: string; run_time: string | null; last_run_at: string | null }>()

  const triggered: number[] = []
  for (const s of schedules) {
    const runTime = s.run_time || '09:00'
    if (jstHHMM < runTime) continue

    if (s.last_run_at) {
      const lastJst = toJstDate(s.last_run_at)
      if (s.frequency === 'weekly') {
        const days = (nowUtc.getTime() - lastJst.getTime() + 9 * 3600 * 1000) / (24 * 3600 * 1000)
        if (days < 7) continue
      } else if (jstYmd(lastJst) === jstToday) {
        continue
      }
    }

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

export default ranking
