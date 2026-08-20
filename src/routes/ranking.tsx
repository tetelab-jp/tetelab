import { Hono } from 'hono'
import { requireAuth, requireSeoEnabled } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import { formatJstDateTime } from '../lib/date-format'
import { measureRank } from '../lib/ranking-scraper'
import { getPrimarySalonArea, buildAreaLabel, type PrimarySalonArea } from '../lib/ranking-areas'
import { timingSafeEqual } from '../lib/crypto'
import type { Bindings, AppUser } from '../types'

const ranking = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

const KEYWORD_SLOTS_MAX = 20
// 2026-08-13変更: 圏外(見つからない)キーワードは以前50ページ(1000位相当)まで
// 全部読みに行っていたが、プロキシが従量課金(月内GB上限あり)のDataImpulseに
// なったため通信量を抑える必要が生じた。100位(5ページ、1ページ20件)より下は
// 実運用上ほぼ意味が無い順位のため、走査を5ページ=100位までに打ち切る。
const MEASURE_MAX_PAGES = 5

// --------------------------------------------
// 指定テンプレート(未指定なら有効な全テンプレート)を1つのrunでまとめて計測する。
// レスポンスを待たせないため呼び出し側は await せずに起動する。手動計測・定期計測で共用。
// --------------------------------------------
async function runTemplates(
  env: Bindings,
  userId: number,
  salonId: number | null,
  runId: number,
  queryIds?: number[]
): Promise<void> {
  try {
    let sql =
      `SELECT id, salon_name, service_area_cd, middle_area_cd, small_area_cd, area_label
       FROM ranking_queries WHERE user_id = ? AND salon_id = ? AND is_active = 1`
    const binds: unknown[] = [userId, salonId]
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
            (user_id, salon_id, run_id, query_id, salon_name, area_label, service_area_cd, middle_area_cd, small_area_cd,
             area_scope, keyword, rank, result_count, pages_scanned, matched_sln_id, status, error_message)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            userId,
            salonId,
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
async function runScheduledForUser(env: Bindings, userId: number, salonId: number | null): Promise<void> {
  const run = await env.DB.prepare(
    `INSERT INTO ranking_runs (user_id, salon_id, trigger, status) VALUES (?, ?, 'scheduled', 'running')`
  )
    .bind(userId, salonId)
    .run()
  await runTemplates(env, userId, salonId, run.meta.last_row_id as number)
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
        <label class="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-1">
          <i class="fas fa-store text-pink-400"></i>サロン名
        </label>
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
        <label class="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-1">
          <i class="fas fa-map text-pink-400"></i>中エリア
        </label>
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
        <label class="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-1">
          <i class="fas fa-location-dot text-pink-400"></i>小エリア
        </label>
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

/** area_label(「中エリア > 小エリア」形式の結合文字列)を、中/小がひと目で
 *  わかるようラベル付きバッジで表示する。buildAreaLabel()の結合形式に対応。 */
function splitAreaLabel(label: string | null): { middle: string | null; small: string | null } {
  if (!label) return { middle: null, small: null }
  const parts = label.split(' > ')
  return { middle: parts[0] || null, small: parts[1] || null }
}

function AreaLabelBadges({ label }: { label: string | null }) {
  const { middle, small } = splitAreaLabel(label)
  if (!middle && !small) return <p class="text-sm text-gray-500">-</p>
  return (
    <div class="flex flex-col gap-1 mt-0.5">
      {middle && (
        <span class="inline-flex items-center gap-1.5 text-sm sm:text-base text-gray-600 min-w-0">
          <span class="flex-shrink-0 px-1.5 py-0.5 rounded bg-pink-50 text-pink-600 font-semibold text-[10px] sm:text-xs leading-none">
            中エリア
          </span>
          <span class="truncate">{middle}</span>
        </span>
      )}
      {small && (
        <span class="inline-flex items-center gap-1.5 text-sm sm:text-base text-gray-600 min-w-0">
          <span class="flex-shrink-0 px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-semibold text-[10px] sm:text-xs leading-none">
            小エリア
          </span>
          <span class="truncate">{small}</span>
        </span>
      )}
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

type Cell = { rank: number | null; status: string; resultCount: number | null } | undefined
type CellSize = 'sm' | 'lg'

type DeltaInfo = { text: string; colorCls: string } | null

// 2026-08-13変更: 背景付きバッジ(ピンクグラデーション+白文字)は数字が
// 見づらいという指摘があったため、背景無し・ピンク文字のみのシンプルな
// 表示に変更した。マイナス(下降)の場合も赤ではなく黒色にする
// (上昇=緑、変化なし=グレーは維持)。
function computeDelta(currentRank: number, prev: Cell): DeltaInfo {
  if (!prev) return null
  if (prev.rank == null) return { text: '▲前回100位圏外', colorCls: 'text-green-600' }
  const diff = prev.rank - currentRank
  if (diff > 0) return { text: `▲${diff}`, colorCls: 'text-green-600' }
  if (diff < 0) return { text: `▼${-diff}`, colorCls: 'text-black' }
  return { text: '±0', colorCls: 'text-gray-600' }
}

// 順位の数字だけを表示する部品。
// 2026-08-15追記(ユーザー指定): 順位の文字サイズを大きくした際、行の高さが
// 対策キーワード列(text-sm/text-xs)の行の高さより高くなってしまっていた。
// 文字サイズはそのままに、line-heightだけを対策キーワード列と同じ値
// (text-sm=leading-5、text-xs=leading-4)に固定し、行の高さは変えずに
// 文字だけ大きく見せる。
function RankBadge({ rank, size }: { rank: number; size: CellSize }) {
  const badgeCls =
    size === 'lg'
      ? 'block text-center min-w-[2.75rem] text-pink-600 font-bold text-xl leading-5'
      : 'block text-center min-w-[2.25rem] text-pink-600 font-bold text-lg leading-4'
  return <span class={badgeCls}>{rank}</span>
}

// 前回比を表示する部品。データが無い場合も同じ高さの行を確保する(非表示)
// ことで、上に置く非表示スペーサーと高さを揃えられるようにしている。
function DeltaSlot({ delta, size }: { delta: DeltaInfo; size: CellSize }) {
  const deltaCls = size === 'lg' ? 'text-xs' : 'text-[10px]'
  return (
    <span class={`block ${deltaCls} font-semibold whitespace-nowrap ${delta ? delta.colorCls : 'invisible'}`}>
      {delta ? delta.text : '±0'}
    </span>
  )
}

// 過去列の1マス(順位＋前回比)。
// 2026-08-15追記(ユーザー指定): 対策キーワード列・過去列・最新列の順位
// (ピンクの文字)の高さをすべて上下中央で揃える必要がある。前回比を順位の
// 下に別行で表示すると、順位の行が対策キーワード列の中心よりも上寄りに
// なってしまうため、順位の上にも前回比と同じ高さの非表示スペーサーを
// 置いてブロックを上下対称にし、順位自体が行の高さの中心に来るようにする。
function RankPivotCell({ current, prev, size = 'sm' }: { current: Cell; prev: Cell; size?: CellSize }) {
  const baseTextCls = size === 'lg' ? 'text-sm' : 'text-xs'
  const deltaCls = size === 'lg' ? 'text-xs' : 'text-[10px]'

  if (!current) return <span class={`text-gray-300 ${baseTextCls}`}>-</span>
  if (current.status === 'error') return <span class={`${baseTextCls} text-red-500 whitespace-nowrap`}>エラー</span>

  if (current.rank == null) {
    return (
      <span class="inline-flex flex-col items-center">
        <span class={`text-gray-700 ${baseTextCls} font-medium whitespace-nowrap`}>100位圏外</span>
        {prev && prev.rank != null && (
          <span class={`block ${deltaCls} leading-tight text-black mt-0.5 whitespace-nowrap`}>▼前回{prev.rank}位</span>
        )}
      </span>
    )
  }

  const delta = computeDelta(current.rank, prev)
  return (
    <span class="inline-flex flex-col items-center gap-0.5">
      <span class="invisible" aria-hidden="true">
        <DeltaSlot delta={delta} size={size} />
      </span>
      <RankBadge rank={current.rank} size={size} />
      <DeltaSlot delta={delta} size={size} />
    </span>
  )
}

// 該当店舗数だけを表示する部品(最新列でRankBadgeと組み合わせて使う)
function StoreCountCell({ cell, size = 'sm' }: { cell: Cell; size?: CellSize }) {
  const cls = size === 'lg' ? 'text-xs' : 'text-[10px]'
  if (!cell || cell.resultCount == null) return <span class={`text-gray-300 ${cls}`}>-</span>
  return <span class={`${cls} text-gray-700 whitespace-nowrap`}>{cell.resultCount}店舗中</span>
}

// 最新列の1マス(店舗数＋順位＋前回比、中エリア/小エリアそれぞれ1列)。
// 2026-08-15追記(ユーザー指定): 「店舗数を順位の上に、前回比を順位の下に」
// 配置する。店舗数と前回比はどちらも同じ文字サイズ(text-xs/text-[10px])
// なので、この並びだけで自然に上下対称なブロックになり、順位が行の高さの
// 中心・対策キーワード列や過去列の順位と同じ高さに揃う(過去列のような
// 非表示スペーサーは不要)。
function LatestAreaCell({ current, prev, size }: { current: Cell; prev: Cell; size: CellSize }) {
  const baseTextCls = size === 'lg' ? 'text-sm' : 'text-xs'
  const deltaCls = size === 'lg' ? 'text-xs' : 'text-[10px]'

  if (!current) return <span class={`text-gray-300 ${baseTextCls}`}>-</span>
  if (current.status === 'error') return <span class={`${baseTextCls} text-red-500 whitespace-nowrap`}>エラー</span>

  if (current.rank == null) {
    return (
      <span class="inline-flex flex-col items-center gap-0.5">
        <StoreCountCell cell={current} size={size} />
        <span class={`text-gray-700 ${baseTextCls} font-medium whitespace-nowrap`}>100位圏外</span>
        {prev && prev.rank != null && (
          <span class={`block ${deltaCls} leading-tight text-black whitespace-nowrap`}>▼前回{prev.rank}位</span>
        )}
      </span>
    )
  }

  const delta = computeDelta(current.rank, prev)
  return (
    <span class="inline-flex flex-col items-center gap-0.5">
      <StoreCountCell cell={current} size={size} />
      <RankBadge rank={current.rank} size={size} />
      <DeltaSlot delta={delta} size={size} />
    </span>
  )
}

/** 計測日を「2026/8/12」のような短い表記にする(年も含める) */
function shortDate(sqliteTimestamp: string): string {
  const ymd = formatJstDateTime(sqliteTimestamp).slice(0, 10)
  const [y, m, d] = ymd.split('-')
  return `${y}/${Number(m)}/${Number(d)}`
}

const MEASURE_RUN_COLUMNS = 12

// 順位測定表のサイズ設定。スマホ(sm未満)は固定表示なし・コンパクトに
// 横スクロールで全列見せる。sm以上(タブレット・PC)はキーワード列と
// 最新計測列を固定表示にしつつ、文字・マス目を大きくして見やすくする。
type TableVariant = {
  size: CellSize
  keywordPx: number
  latestGroupPx: number
  oldColPx: number
  keywordColClass: string
  latestCol1Class: string
  latestCol2Class: string
  headText: string
  subHeadText: string
  bodyText: string
}

const MOBILE_TABLE_VARIANT: TableVariant = {
  size: 'sm',
  keywordPx: 116,
  latestGroupPx: 88,
  oldColPx: 56,
  keywordColClass: '',
  latestCol1Class: '',
  latestCol2Class: '',
  headText: 'text-xs',
  subHeadText: 'text-[10px]',
  bodyText: 'text-xs'
}

const DESKTOP_TABLE_VARIANT: TableVariant = {
  size: 'lg',
  keywordPx: 168,
  latestGroupPx: 132,
  oldColPx: 88,
  keywordColClass: 'sticky left-0 z-10',
  latestCol1Class: 'sticky left-[168px] z-10',
  latestCol2Class: 'sticky left-[300px] z-10',
  headText: 'text-sm',
  subHeadText: 'text-xs',
  bodyText: 'text-sm'
}

// 対策KW×計測日の順位表を1つ描画する。中/小エリアは常に2列(最新列は
// そのマスの中に順位バッジと店舗数を両方まとめて表示、それより古い列は
// 順位のみ)なので、runごとの列数は常に2で統一している。
function renderRankTable(
  runs: { id: number; measuredAt: string }[],
  keywordsList: string[],
  cellMap: Map<string, Cell>,
  v: TableVariant
) {
  const tableWidthPx =
    runs.length === 0
      ? 0
      : v.keywordPx + v.latestGroupPx * 2 + Math.max(runs.length - 1, 0) * v.oldColPx * 2

  return (
    <table class="table-fixed text-center border-collapse" style={`width:${tableWidthPx}px`}>
      <colgroup>
        <col style={`width:${v.keywordPx}px`} />
        {runs.map((_, i) => (
          <>
            <col style={`width:${i === 0 ? v.latestGroupPx : v.oldColPx}px`} />
            <col style={`width:${i === 0 ? v.latestGroupPx : v.oldColPx}px`} />
          </>
        ))}
      </colgroup>
      <thead>
        <tr class="bg-pink-50/60 border-b border-pink-100">
          <th
            rowspan={2}
            class={`py-3 px-3 text-left align-middle font-semibold text-gray-900 bg-pink-50 whitespace-nowrap ${v.headText} ${v.keywordColClass}`}
          >
            対策キーワード
          </th>
          {runs.map((run, i) => (
            <th
              class={
                `py-3 px-1 font-semibold text-gray-900 border-l border-pink-100 whitespace-nowrap ${v.headText}` +
                (i === 0 ? ` bg-pink-50 ${v.latestCol1Class}` : '')
              }
              colspan={2}
            >
              {shortDate(run.measuredAt)}
              {i === 0 && <span class="ml-1 text-pink-500">●最新</span>}
            </th>
          ))}
        </tr>
        <tr class="bg-pink-50/60 border-b-2 border-pink-100">
          {runs.map((_, i) => (
            <>
              <th
                class={
                  `py-1.5 px-1 font-medium text-gray-700 border-l border-pink-100 whitespace-nowrap ${v.subHeadText}` +
                  (i === 0 ? ` bg-pink-50 ${v.latestCol1Class}` : '')
                }
              >
                中エリア
              </th>
              <th
                class={
                  `py-1.5 px-1 font-medium text-gray-700 whitespace-nowrap ${v.subHeadText}` +
                  (i === 0 ? ` bg-pink-50 border-r-2 border-pink-200 ${v.latestCol2Class}` : '')
                }
              >
                小エリア
              </th>
            </>
          ))}
        </tr>
      </thead>
      <tbody>
        {keywordsList.map((kw, rowIdx) => (
          <tr class={'border-b border-gray-50' + (rowIdx % 2 === 1 ? ' bg-gray-50/40' : '')}>
            <td
              class={
                `py-3 px-3 text-left font-semibold text-gray-900 truncate ${v.bodyText} ${v.keywordColClass}` +
                (rowIdx % 2 === 1 ? ' bg-gray-50' : ' bg-white')
              }
              title={kw}
            >
              {kw}
            </td>
            {runs.map((run, i) => {
              const nextRun = runs[i + 1]
              const middleCurrent = cellMap.get(`${run.id}||${kw}||middle`)
              const smallCurrent = cellMap.get(`${run.id}||${kw}||small`)
              const middlePrev = nextRun ? cellMap.get(`${nextRun.id}||${kw}||middle`) : undefined
              const smallPrev = nextRun ? cellMap.get(`${nextRun.id}||${kw}||small`) : undefined
              const isLatest = i === 0
              const rowBg = rowIdx % 2 === 1 ? ' bg-gray-50' : ' bg-white'
              if (!isLatest) {
                return (
                  <>
                    <td class="py-3 px-1 border-l border-gray-100">
                      <RankPivotCell current={middleCurrent} prev={middlePrev} size={v.size} />
                    </td>
                    <td class="py-3 px-1">
                      <RankPivotCell current={smallCurrent} prev={smallPrev} size={v.size} />
                    </td>
                  </>
                )
              }
              return (
                <>
                  <td class={`py-3 px-1 border-l border-gray-100 ${v.latestCol1Class}${rowBg}`}>
                    <LatestAreaCell current={middleCurrent} prev={middlePrev} size={v.size} />
                  </td>
                  <td class={`py-3 px-1 border-r-2 border-gray-200 ${v.latestCol2Class}${rowBg}`}>
                    <LatestAreaCell current={smallCurrent} prev={smallPrev} size={v.size} />
                  </td>
                </>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ============================================
// 計測(表形式: 対策KW×計測日。左が最新、右にいくほど古い。中/小エリアを列で並記)
// ============================================
ranking.get('/seo', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')

  const primaryQuery = await c.env.DB.prepare(
    `SELECT id, salon_name, area_label FROM ranking_queries WHERE user_id = ? AND salon_id = ? ORDER BY id LIMIT 1`
  )
    .bind(user.id, user.active_salon_id)
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
    `SELECT COUNT(*) AS n FROM ranking_runs WHERE user_id = ? AND salon_id = ? AND status = 'running'`
  )
    .bind(user.id, user.active_salon_id)
    .first<{ n: number }>()
  const hasRunning = (runningRun?.n || 0) > 0

  // 計測日の列(直近から最大MEASURE_RUN_COLUMNS件、左が最新)
  let runs: { id: number; measuredAt: string }[] = []
  const cellMap = new Map<string, Cell>()
  if (primaryQuery) {
    // 同日(JST)に複数回計測している場合は最新の1件だけを列として残す。
    // run_idはDESC(新しい順)で取得しているため、同じ日付が最初に出てきた
    // ものが最新であり、それ以降の同日分はスキップすればよい。
    // 表示列数(MEASURE_RUN_COLUMNS)分のユニークな日付を確保するため、
    // 生の行は余裕を持って多めに取得する。
    const { results: runRows } = await c.env.DB.prepare(
      `SELECT run_id, MIN(measured_at) AS measured_at FROM ranking_results
       WHERE user_id = ? AND query_id = ? GROUP BY run_id ORDER BY run_id DESC LIMIT ?`
    )
      .bind(user.id, primaryQuery.id, MEASURE_RUN_COLUMNS * 10)
      .all<{ run_id: number; measured_at: string }>()

    const seenDays = new Set<string>()
    for (const r of runRows) {
      const day = jstYmd(toJstDate(r.measured_at))
      if (seenDays.has(day)) continue
      seenDays.add(day)
      runs.push({ id: r.run_id, measuredAt: r.measured_at })
      if (runs.length >= MEASURE_RUN_COLUMNS) break
    }

    if (runs.length > 0) {
      const runIds = runs.map((r) => r.id)
      const { results: cellRows } = await c.env.DB.prepare(
        `SELECT run_id, keyword, area_scope, rank, result_count, status FROM ranking_results
         WHERE user_id = ? AND query_id = ? AND run_id IN (${runIds.map(() => '?').join(',')})`
      )
        .bind(user.id, primaryQuery.id, ...runIds)
        .all<{
          run_id: number
          keyword: string
          area_scope: string
          rank: number | null
          result_count: number | null
          status: string
        }>()
      for (const r of cellRows) {
        cellMap.set(`${r.run_id}||${r.keyword}||${r.area_scope}`, {
          rank: r.rank,
          status: r.status,
          resultCount: r.result_count
        })
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

      reviewEnabled={user.review_enabled !== 0}

      isImpersonated={user.is_impersonated === 1}
    >
      {measured && (
        <div class="bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-700">
          <i class="fas fa-circle-check mr-2"></i>計測を開始しました。完了次第、下の表に反映されます。
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div class="flex items-center gap-3 min-w-0">
            <div class="w-10 h-10 rounded-full bg-pink-50 flex items-center justify-center flex-shrink-0">
              <i class="fas fa-store text-pink-500"></i>
            </div>
            <div class="min-w-0">
              {primaryQuery ? (
                <>
                  <p class="font-bold text-gray-900 text-lg truncate">{primaryQuery.salon_name}</p>
                  <AreaLabelBadges label={primaryQuery.area_label} />
                </>
              ) : (
                <p class="font-semibold text-gray-900">対策キーワード設定が未登録です</p>
              )}
            </div>
          </div>
          {keywordsList.length > 0 && (
            <button
              type="button"
              id="measure-run-btn"
              class="w-full sm:w-auto flex-shrink-0 bg-pink-500 hover:bg-pink-600 text-white font-bold px-10 py-3.5 rounded-lg text-base shadow-sm transition disabled:opacity-50"
            >
              <i class="fas fa-magnifying-glass-chart mr-2"></i>測定
            </button>
          )}
        </div>

        {keywordsList.length === 0 ? (
          <p class="text-sm text-gray-400 mt-4">
            登録済みのキーワードがありません。
            <a href="/seo/keywords" class="text-pink-600 hover:underline ml-1">
              対策キーワード設定
            </a>
            で追加してください。
          </p>
        ) : (
          <p id="measure-status" class="text-sm text-pink-600 mt-3"></p>
        )}
      </div>

      {/* 計測結果(対策KW×計測日の表。左が最新、右へ横スクロールで過去分) */}
      <div class="flex items-center justify-between">
        <p class="font-semibold">
          <i class="fas fa-table mr-2 text-pink-500"></i>キーワードの順位
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
          {/* スマホ(sm未満): 固定表示なし・コンパクトな文字で横スクロール全体を見せる。
              sm以上(タブレット・PC): キーワード列+最新計測列を固定表示にしつつ、
              文字・マス目を大きくする。幅の異なる2つの<table>を両方描画し、
              CSSのsm:表示切替だけで出し分ける(1つのtableで幅をブレークポイントごとに
              変える方法は、table-layout:fixedの列幅指定を動的なTailwindクラスとして
              静的解析させられず崩れるため採用しない)。 */}
          <div class="overflow-x-auto sm:hidden">
            {renderRankTable(runs, keywordsList, cellMap, MOBILE_TABLE_VARIANT)}
          </div>
          <div class="overflow-x-auto hidden sm:block">
            {renderRankTable(runs, keywordsList, cellMap, DESKTOP_TABLE_VARIANT)}
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

  const primaryQuery = await c.env.DB.prepare(
    `SELECT id FROM ranking_queries WHERE user_id = ? AND salon_id = ? ORDER BY id LIMIT 1`
  )
    .bind(user.id, user.active_salon_id)
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

  // 2026-08-13追記(重大バグ修正): 連打・複数タブからの同時POSTに対する
  // 重複防止が無く、同じユーザーの計測runが並行して複数実行され得た
  // (結果の重複・HPBへの過剰アクセスにつながる)。既に実行中のrunが
  // あれば新規開始を拒否する。
  const runningRun = await c.env.DB.prepare(
    `SELECT id FROM ranking_runs WHERE user_id = ? AND salon_id = ? AND status = 'running' LIMIT 1`
  )
    .bind(user.id, user.active_salon_id)
    .first<{ id: number }>()
  if (runningRun) {
    return c.json({ success: false, error: '既に計測が実行中です。完了までお待ちください' }, 409)
  }

  // 手動測定は1日最大2回まで(ユーザー指定)。過去2日分のmanual実行を取得し、
  // JST日付で本日分を数える。
  const DAILY_MANUAL_MEASURE_LIMIT = 2
  const { results: recentManualRuns } = await c.env.DB.prepare(
    `SELECT started_at FROM ranking_runs
     WHERE user_id = ? AND salon_id = ? AND trigger = 'manual' AND started_at >= now() - interval '2 days'`
  )
    .bind(user.id, user.active_salon_id)
    .all<{ started_at: string }>()
  const todayYmd = jstYmd(new Date(Date.now() + 9 * 60 * 60 * 1000))
  const todayManualCount = (recentManualRuns || []).filter((r) => jstYmd(toJstDate(r.started_at)) === todayYmd).length
  if (todayManualCount >= DAILY_MANUAL_MEASURE_LIMIT) {
    return c.json({ success: false, error: `手動測定は1日最大${DAILY_MANUAL_MEASURE_LIMIT}回までです。翌日またお試しください` }, 429)
  }

  const run = await c.env.DB.prepare(
    `INSERT INTO ranking_runs (user_id, salon_id, trigger, status) VALUES (?, ?, 'manual', 'running')`
  )
    .bind(user.id, user.active_salon_id)
    .run()
  void runTemplates(c.env, user.id, user.active_salon_id, run.meta.last_row_id as number, [primaryQuery.id])

  return c.json({ success: true })
})

/**
 * ユーザーの「対策キーワード設定」は、サロン名・エリアが自動検出の1本だけになった
 * ため、名前を付けての複数登録はやめ、既存の最初の1件(無ければ自動作成)へ
 * キーワードを直接追加/削除する方式にした。
 */
async function getOrCreatePrimaryQueryId(
  env: Bindings,
  userId: number,
  salonId: number | null,
  salon: PrimarySalonArea
): Promise<number> {
  const existing = await env.DB.prepare(
    `SELECT id FROM ranking_queries WHERE user_id = ? AND salon_id = ? ORDER BY id LIMIT 1`
  )
    .bind(userId, salonId)
    .first<{ id: number }>()
  if (existing) return existing.id

  const areaLabel = buildAreaLabel(salon.middleAreaName, salon.smallAreaName)
  const q = await env.DB.prepare(
    `INSERT INTO ranking_queries (user_id, salon_id, name, salon_name, service_area_cd, middle_area_cd, small_area_cd, area_label)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
  )
    .bind(userId, salonId, salon.salonName, salon.serviceAreaCd, salon.middleAreaCd, salon.smallAreaCd, areaLabel)
    .run()
  return q.meta.last_row_id as number
}

// ============================================
// 対策キーワード設定(1個ずつ追加 → その場で登録済み一覧に反映)
// ============================================
ranking.get('/seo/keywords', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const salon = await getPrimarySalonArea(c.env, user.id, user.active_salon_id, user.salon_name)

  const existingQuery = await c.env.DB.prepare(
    `SELECT id FROM ranking_queries WHERE user_id = ? AND salon_id = ? ORDER BY id LIMIT 1`
  )
    .bind(user.id, user.active_salon_id)
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

      reviewEnabled={user.review_enabled !== 0}

      isImpersonated={user.is_impersonated === 1}
    >
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
          登録済みの対策キーワード<br class="sm:hidden" />
          （<span id="keyword-count">{keywords.length}</span>件/最大{KEYWORD_SLOTS_MAX}件まで）
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

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-5 text-gray-900">サロン情報・対象エリア</p>
        <SalonAndAreaAutoField salon={salon} />
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

  const salon = await getPrimarySalonArea(c.env, user.id, user.active_salon_id, user.salon_name)
  if (!salon?.salonName || !salon.serviceAreaCd || !salon.middleAreaCd) {
    return c.json({ success: false, error: 'サロン名または対策エリアが未取得です。サロンボードと同期してください' }, 400)
  }

  const queryId = await getOrCreatePrimaryQueryId(c.env, user.id, user.active_salon_id, salon)
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
       WHERE id = ? AND query_id IN (SELECT id FROM ranking_queries WHERE user_id = ? AND salon_id = ?)`
    )
      .bind(id, user.id, user.active_salon_id)
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
     FROM ranking_queries WHERE id = ? AND user_id = ? AND salon_id = ?`
  )
    .bind(id, user.id, user.active_salon_id)
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

  const salon = await getPrimarySalonArea(c.env, user.id, user.active_salon_id, user.salon_name)

  return c.render(
    <PageLayout
      active="ranking-keywords"
      salonName={user.salon_name}
      title="対策キーワード編集"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
      seoEnabled={user.seo_enabled !== 0}

      reviewEnabled={user.review_enabled !== 0}

      isImpersonated={user.is_impersonated === 1}
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

  const owned = await c.env.DB.prepare(`SELECT id FROM ranking_queries WHERE id = ? AND user_id = ? AND salon_id = ?`)
    .bind(id, user.id, user.active_salon_id)
    .first<{ id: number }>()
  if (!owned) return c.redirect('/seo/keywords')

  const name = String(body.name || '').trim()
  // 作成時と同様、サロン名・対策エリアは画面上で編集不可(自動入力)のため送信値を信用しない。
  const salon = await getPrimarySalonArea(c.env, user.id, user.active_salon_id, user.salon_name)
  const keywords = parseKeywords(body)

  if (!salon?.salonName || !salon.serviceAreaCd || !salon.middleAreaCd || keywords.length === 0) {
    return c.redirect(`/seo/templates/${id}/edit?error=1`)
  }
  const areaLabel = buildAreaLabel(salon.middleAreaName, salon.smallAreaName)

  await c.env.DB.prepare(
    `UPDATE ranking_queries
       SET name = ?, salon_name = ?, service_area_cd = ?, middle_area_cd = ?, small_area_cd = ?,
           area_label = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND salon_id = ?`
  )
    .bind(
      name || null,
      salon.salonName,
      salon.serviceAreaCd,
      salon.middleAreaCd,
      salon.smallAreaCd,
      areaLabel,
      id,
      user.id,
      user.active_salon_id
    )
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
    await c.env.DB.prepare(`DELETE FROM ranking_queries WHERE id = ? AND user_id = ? AND salon_id = ?`)
      .bind(id, user.id, user.active_salon_id)
      .run()
  }
  return c.redirect('/seo/keywords')
})

// ============================================
// 定期測定設定
// ============================================
ranking.get('/seo/schedule', (c) => c.redirect('/settings/auto-update'))

ranking.post('/seo/schedule', requireAuth, requireSeoEnabled, async (c) => {
  const user = c.get('user')
  const body = (await c.req.parseBody()) as Record<string, unknown>
  const enabled = body.enabled ? 1 : 0
  const frequency = 'weekly'
  const runTime = '20:00'

  const existing = await c.env.DB.prepare(`SELECT id FROM ranking_schedules WHERE user_id = ? AND salon_id = ?`)
    .bind(user.id, user.active_salon_id)
    .first<{ id: number }>()
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE ranking_schedules SET enabled = ?, frequency = ?, run_time = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_id = ?`
    )
      .bind(enabled, frequency, runTime, user.id, user.active_salon_id)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO ranking_schedules (user_id, salon_id, enabled, frequency, run_time) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(user.id, user.active_salon_id, enabled, frequency, runTime)
      .run()
  }
  return c.redirect('/settings/auto-update?saved=1')
})

// ============================================
// 定期測定の実行(外部Cronから CRON_SECRET で叩く。セッション不要)
// ============================================
ranking.post('/api/cron/run-ranking', async (c) => {
  const authHeader = c.req.header('Authorization') || ''
  const expected = c.env.CRON_SECRET
  if (!expected || !timingSafeEqual(authHeader, `Bearer ${expected}`)) {
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

  // 管理者サイトで契約OFF(is_active=0)またはSEO機能OFF(salonboard_salons.seo_enabled=0)
  // にされたサロンはcronの対象から除外する(automation.tsxの/api/cron/run-style-posts参照)。
  const { results: schedules } = await c.env.DB.prepare(
    `SELECT s.user_id, s.salon_id, s.frequency, s.run_time, s.last_run_at
     FROM ranking_schedules s
     JOIN users u ON u.id = s.user_id
     JOIN salonboard_salons sb ON sb.id = s.salon_id
     WHERE s.enabled = 1 AND u.is_active = 1 AND sb.seo_enabled = 1 AND sb.is_active_workspace = 1`
  ).all<{
    user_id: number
    salon_id: number
    frequency: string
    run_time: string | null
    last_run_at: string | null
  }>()

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
      `UPDATE ranking_schedules SET last_run_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_id = ?`
    )
      .bind(s.user_id, s.salon_id)
      .run()
    void runScheduledForUser(c.env, s.user_id, s.salon_id).catch((e) =>
      console.error('runScheduledForUser failed:', e)
    )
    triggered.push(s.user_id)
  }

  return c.json({ time: jstHHMM, date: jstToday, enabled: schedules.length, triggered })
})

export default ranking
