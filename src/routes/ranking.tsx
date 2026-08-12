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

// 順位セル(今回順位 + 前回比較バッジ)
function RankCell({
  status,
  rank,
  hadBefore,
  prevRank
}: {
  status: string
  rank: number | null
  hadBefore: boolean
  prevRank: number | null
}) {
  if (status === 'error') return <span class="text-xs text-red-500">エラー</span>
  if (rank == null) {
    return (
      <span class="text-gray-400">
        圏外
        {hadBefore && prevRank != null && (
          <span class="ml-1 text-xs text-red-500">▼ 前回{prevRank}位</span>
        )}
      </span>
    )
  }
  let badge = <span class="ml-1 text-xs text-gray-400">初回</span>
  if (hadBefore) {
    if (prevRank == null) {
      badge = <span class="ml-1 text-xs text-green-600">▲ 前回圏外</span>
    } else {
      const diff = prevRank - rank
      badge =
        diff > 0 ? (
          <span class="ml-1 text-xs text-green-600">▲{diff}</span>
        ) : diff < 0 ? (
          <span class="ml-1 text-xs text-red-500">▼{-diff}</span>
        ) : (
          <span class="ml-1 text-xs text-gray-400">±0</span>
        )
    }
  }
  return (
    <span>
      <span class="font-semibold text-gray-900">{rank}位</span>
      {badge}
    </span>
  )
}

// ============================================
// 計測(テンプレートを選んで測定 + ログをコンテナ表示)
// ============================================
ranking.get('/seo', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')

  const { results: templates } = await c.env.DB.prepare(
    `SELECT id, name, salon_name, area_label FROM ranking_queries WHERE user_id = ? ORDER BY id DESC`
  )
    .bind(user.id)
    .all<{ id: number; name: string | null; salon_name: string; area_label: string | null }>()

  const { results: kwCounts } = await c.env.DB.prepare(
    `SELECT k.query_id, COUNT(*) AS n FROM ranking_query_keywords k
     JOIN ranking_queries q ON q.id = k.query_id
     WHERE q.user_id = ? GROUP BY k.query_id`
  )
    .bind(user.id)
    .all<{ query_id: number; n: number }>()
  const kwCountByQuery = new Map<number, number>(kwCounts.map((r) => [r.query_id, r.n]))

  const runningRun = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ranking_runs WHERE user_id = ? AND status = 'running'`
  )
    .bind(user.id)
    .first<{ n: number }>()
  const hasRunning = (runningRun?.n || 0) > 0

  // 直近の計測結果(前回比較のため昇順で走査してからコンテナ化)
  const { results: recent } = await c.env.DB.prepare(
    `SELECT run_id, salon_name, area_label, keyword, rank, result_count, status, measured_at
     FROM ranking_results WHERE user_id = ? ORDER BY id DESC LIMIT 500`
  )
    .bind(user.id)
    .all<{
      run_id: number
      salon_name: string
      area_label: string | null
      keyword: string
      rank: number | null
      result_count: number | null
      status: string
      measured_at: string
    }>()

  type Row = (typeof recent)[number] & { hadBefore: boolean; prevRank: number | null }
  const asc = [...recent].reverse()
  const seen = new Set<string>()
  const lastRank = new Map<string, number | null>()
  const withPrev: Row[] = asc.map((r) => {
    const key = `${r.salon_name}||${r.area_label}||${r.keyword}`
    const hadBefore = seen.has(key)
    const prevRank = lastRank.has(key) ? (lastRank.get(key) as number | null) : null
    seen.add(key)
    lastRank.set(key, r.rank)
    return { ...r, hadBefore, prevRank }
  })

  type Container = { salon: string; area: string; datetime: string; rows: Row[] }
  const containerMap = new Map<string, Container>()
  const order: string[] = []
  for (const r of [...withPrev].reverse()) {
    const ckey = `${r.run_id}||${r.salon_name}||${r.area_label}`
    let cont = containerMap.get(ckey)
    if (!cont) {
      cont = { salon: r.salon_name, area: r.area_label || '-', datetime: r.measured_at, rows: [] }
      containerMap.set(ckey, cont)
      order.push(ckey)
    }
    cont.rows.push(r)
  }
  const containers = order.slice(0, 30).map((k) => containerMap.get(k) as Container)

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
          <i class="fas fa-circle-check mr-2"></i>計測を開始しました。完了次第、下のログに反映されます。
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <div class="flex items-center justify-between mb-4">
          <p class="font-semibold text-gray-900">計測するキーワード設定を選択</p>
          <a href="/seo/keywords" class="text-xs text-pink-600 hover:underline">
            <i class="fas fa-plus mr-1"></i>対策キーワード設定を追加
          </a>
        </div>

        {templates.length === 0 ? (
          <p class="text-sm text-gray-400">
            登録済みの対策キーワード設定がありません。
            <a href="/seo/keywords" class="text-pink-600 hover:underline ml-1">
              対策キーワード設定
            </a>
            で登録してください。
          </p>
        ) : (
          <>
            <div class="space-y-2">
              {templates.map((t) => (
                <label class="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                  <input type="checkbox" class="tmpl-check w-4 h-4" value={t.id} />
                  <span class="min-w-0">
                    <span class="font-medium text-gray-800">{t.name || `${t.salon_name}（無名）`}</span>
                    <span class="text-xs text-gray-400 ml-2">
                      {t.salon_name} ／ {t.area_label || '-'} ／ キーワード{kwCountByQuery.get(t.id) || 0}件
                    </span>
                  </span>
                </label>
              ))}
            </div>

            <p id="measure-status" class="text-sm text-pink-600 mt-4"></p>

            <div class="flex items-center justify-end mt-4">
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

      {/* 計測ログ(1測定=1コンテナ) */}
      <div class="flex items-center justify-between">
        <p class="font-semibold">
          <i class="fas fa-clock-rotate-left mr-2 text-pink-500"></i>計測ログ
        </p>
        {hasRunning && (
          <span class="text-xs text-pink-600">
            <i class="fas fa-spinner fa-spin mr-1"></i>計測中（自動反映）
          </span>
        )}
      </div>

      {containers.length === 0 ? (
        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="text-sm text-gray-400">まだ計測ログがありません</p>
        </div>
      ) : (
        containers.map((cont) => (
          <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div class="bg-gray-50 border-b border-gray-100 px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span class="font-semibold text-gray-900">{cont.salon}</span>
              <span class="text-sm text-gray-500">{cont.area}</span>
              <span class="text-xs text-gray-400 ml-auto">{formatJstDateTime(cont.datetime)}</span>
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-left text-gray-400 border-b border-gray-100">
                    <th class="py-2 px-5">キーワード</th>
                    <th class="py-2 pr-5">順位（前回比）</th>
                    <th class="py-2 pr-5">該当数</th>
                  </tr>
                </thead>
                <tbody>
                  {cont.rows.map((r) => (
                    <tr class="border-b border-gray-50">
                      <td class="py-2 px-5 text-gray-700">{r.keyword}</td>
                      <td class="py-2 pr-5">
                        <RankCell
                          status={r.status}
                          rank={r.rank}
                          hadBefore={r.hadBefore}
                          prevRank={r.prevRank}
                        />
                      </td>
                      <td class="py-2 pr-5 text-gray-500">
                        {r.result_count != null ? `${r.result_count}件` : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      <script src="/static/ranking.js"></script>
    </PageLayout>
  )
})

// 計測実行(選択したテンプレートをバックグラウンドで測定 / JSON)
ranking.post('/seo/measure', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, error: 'リクエスト形式が不正です' }, 400)
  }

  const queryIds = Array.isArray(body.queryIds)
    ? (body.queryIds as unknown[]).map((v) => Number(v)).filter((n) => Number.isFinite(n))
    : []
  if (queryIds.length === 0) {
    return c.json({ success: false, error: '計測するキーワード設定を選択してください' }, 400)
  }

  // 所有チェック(自分のテンプレートに絞る)
  const { results: owned } = await c.env.DB.prepare(
    `SELECT id FROM ranking_queries WHERE user_id = ? AND id IN (${queryIds.map(() => '?').join(',')})`
  )
    .bind(user.id, ...queryIds)
    .all<{ id: number }>()
  const ownedIds = owned.map((r) => r.id)
  if (ownedIds.length === 0) {
    return c.json({ success: false, error: '対象が見つかりません' }, 400)
  }

  const run = await c.env.DB.prepare(
    `INSERT INTO ranking_runs (user_id, trigger, status) VALUES (?, 'manual', 'running')`
  )
    .bind(user.id)
    .run()
  void runTemplates(c.env, user.id, run.meta.last_row_id as number, ownedIds)

  return c.json({ success: true, count: ownedIds.length })
})

// ============================================
// 対策キーワード設定(登録フォーム + 登録済み一覧)
// ============================================
ranking.get('/seo/keywords', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const salon = await getPrimarySalonArea(c.env, user.id, user.salon_name)

  const { results: queries } = await c.env.DB.prepare(
    `SELECT id, name, salon_name, area_label FROM ranking_queries WHERE user_id = ? ORDER BY id DESC`
  )
    .bind(user.id)
    .all<{ id: number; name: string | null; salon_name: string; area_label: string | null }>()

  const registered = c.req.query('registered') === '1'

  return c.render(
    <PageLayout
      active="ranking-keywords"
      salonName={user.salon_name}
      title="対策キーワード設定"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
      seoEnabled={user.seo_enabled !== 0}
    >
      {registered && (
        <div class="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
          <i class="fas fa-circle-check mr-2"></i>対策キーワードを登録しました。「計測」画面で選んで測定できます。
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-5 text-gray-900">対策キーワード・情報入力</p>

        <form id="ranking-form" method="post" action="/seo/templates" class="space-y-5">
          <SalonAndAreaAutoField salon={salon} />

          <KeywordFields />

          <input type="hidden" id="template-name" name="name" value="" />

          <p class="text-xs text-gray-500">
            「登録」ボタンを押すと入力した対策キーワードが保存され、「計測」画面で選択して測定できます。
          </p>

          <p id="measure-status" class="text-sm text-pink-600"></p>

          <div class="flex items-center justify-end">
            <button
              type="button"
              id="register-open-btn"
              class="w-full md:w-auto bg-pink-500 hover:bg-pink-600 text-white font-bold px-10 py-3.5 rounded-lg text-base shadow-sm transition"
            >
              <i class="fas fa-circle-check mr-2"></i>この内容で登録する
            </button>
          </div>
        </form>
      </div>

      {/* 登録名入力モーダル */}
      <div id="register-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
          <p class="font-semibold text-gray-900 mb-1">対策キーワードの登録</p>
          <p class="text-xs text-gray-500 mb-4">この設定に名前を付けて保存します（管理用）。</p>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            登録名 <span class="text-pink-500">*</span>
          </label>
          <input
            type="text"
            id="modal-template-name"
            placeholder="例: 赤羽・髪質改善セット"
            class="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-pink-200"
          />
          <p id="modal-error" class="text-xs text-red-500 min-h-[1rem]"></p>
          <div class="flex items-center justify-end gap-3 mt-3">
            <button type="button" id="register-cancel-btn" class="text-sm text-gray-500 hover:text-gray-700 px-4 py-2">
              キャンセル
            </button>
            <button
              type="button"
              id="register-confirm-btn"
              class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2 rounded-lg text-sm"
            >
              保存する
            </button>
          </div>
        </div>
      </div>

      {/* 登録済み一覧 */}
      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-4">
          <i class="fas fa-list-check mr-2 text-pink-500"></i>登録済みの対策キーワード（{queries.length}件）
        </p>
        {queries.length === 0 ? (
          <p class="text-sm text-gray-400 text-center py-6">まだ登録がありません。上のフォームから登録してください。</p>
        ) : (
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-400 border-b border-gray-100">
                <th class="py-2">登録名</th>
                <th class="py-2">設定エリア</th>
                <th class="py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {queries.map((q) => (
                <tr class="border-b border-gray-50">
                  <td class="py-2">
                    <a href={`/seo/templates/${q.id}/edit`} class="text-pink-600 hover:underline">
                      {q.name || `${q.salon_name}（無名）`}
                    </a>
                  </td>
                  <td class="py-2 text-gray-600">{q.area_label || '-'}</td>
                  <td class="py-2 text-right">
                    <a href={`/seo/templates/${q.id}/edit`} class="text-xs text-gray-400 hover:text-pink-600">
                      編集
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <script src="/static/ranking.js"></script>
    </PageLayout>
  )
})

// 対策キーワードの作成(「登録」モーダル)
ranking.post('/seo/templates', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const body = (await c.req.parseBody()) as Record<string, unknown>

  const name = String(body.name || '').trim()
  // サロン名・対策エリアは画面上で編集不可(自動入力)のため、送信値を信用せず
  // サーバー側で改めて算出する(SalonAndAreaAutoFieldの表示値と同じロジック)。
  const salon = await getPrimarySalonArea(c.env, user.id, user.salon_name)
  const keywords = parseKeywords(body)

  if (!salon?.salonName || !salon.serviceAreaCd || !salon.middleAreaCd || keywords.length === 0) {
    return c.redirect('/seo/keywords?error=1')
  }
  const areaLabel = buildAreaLabel(salon.middleAreaName, salon.smallAreaName)

  const q = await c.env.DB.prepare(
    `INSERT INTO ranking_queries
      (user_id, name, salon_name, service_area_cd, middle_area_cd, small_area_cd, area_label)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(user.id, name || null, salon.salonName, salon.serviceAreaCd, salon.middleAreaCd, salon.smallAreaCd, areaLabel)
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

  return c.redirect('/seo/keywords?registered=1')
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
