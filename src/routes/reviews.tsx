// ============================================
// reviews.tsx
// 口コミ管理ツール(2026-08-16追記)。
//   ①/reviews/trend: 口コミ評価推移(月次平均の折れ線グラフ)
//   ②/reviews/by-stylist: スタイリスト別評価(期間フィルタ付き)
// 詳細/返信ページは使用せず、サロンボード口コミ一覧(担当スタイリスト)と
// HPB公開口コミ一覧(評点)を投稿日+本文で突合したreviewsテーブルを表示する。
// ============================================

import { Hono, type Context } from 'hono'
import { requireAuth, requireReviewEnabled } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import { getMonthlyTrend, getAvailableReviewMonths, getStylistBreakdown } from '../lib/review-aggregation'
import { fetchHpbReviewList } from '../lib/ranking-scraper'
import type { Bindings, AppUser } from '../types'

const reviews = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()
type AppContext = Context<{ Bindings: Bindings; Variables: { user: AppUser } }>

reviews.use('/reviews/*', requireAuth)
reviews.use('/reviews/*', requireReviewEnabled)

function escapeJsonForScript(value: unknown): string {
  // </script>によるHTML解釈の分断を防ぐ(他のインラインJSON埋め込み箇所と同じ対策)
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

async function getBackfillState(c: AppContext, salonId: number) {
  return c.env.DB.prepare(
    `SELECT backfill_completed_at, last_sync_run_at FROM review_sync_state WHERE salon_id = ?`
  )
    .bind(salonId)
    .first<{ backfill_completed_at: string | null; last_sync_run_at: string | null }>()
}

function SyncStatusPanel({ backfillDone }: { backfillDone: boolean }) {
  return (
    <div id="review-sync-panel" class="bg-white rounded-xl border border-gray-100 p-6">
      <div class="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p class="font-semibold">
            <i class="fas fa-arrows-rotate mr-2 text-pink-500"></i>
            {backfillDone ? '口コミデータの同期' : '初回データ取り込み'}
          </p>
          <p class="text-sm text-gray-600 mt-1">
            {backfillDone
              ? 'サロンボードとHPBから最新の口コミを取得します(通常1〜2分程度で完了します)。'
              : 'サロンボードの口コミ一覧とHPBの公開口コミ一覧を突き合わせて、過去全件を取り込みます(通常1〜2分程度で完了します)。'}
          </p>
        </div>
        <button
          id="review-sync-start-btn"
          type="button"
          class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg whitespace-nowrap disabled:opacity-50"
        >
          {backfillDone ? '今すぐ同期' : '取り込みを開始'}
        </button>
      </div>
      <p id="review-sync-status-text" class="text-sm text-gray-500 mt-3"></p>
    </div>
  )
}

// ---------- ①口コミ評価推移 ----------

reviews.get('/reviews/trend', async (c) => {
  const user = c.get('user')
  const salonId = user.active_salon_id
  if (!salonId) return c.text('サロンが選択されていません', 400)

  const state = await getBackfillState(c, salonId)
  const backfillDone = !!state?.backfill_completed_at

  const trend = backfillDone ? await getMonthlyTrend(c.env, salonId) : []

  let hpbAverageScore: number | null = null
  if (backfillDone) {
    const salon = await c.env.DB.prepare('SELECT hpb_sln_id FROM salonboard_salons WHERE id = ?')
      .bind(salonId)
      .first<{ hpb_sln_id: string | null }>()
    if (salon?.hpb_sln_id) {
      // ページ1件だけ取得すれば「サロン平均」バッジが得られる(参考表示用、
      // 一覧全件の取得は不要)。取得に失敗しても致命的ではないので握りつぶす。
      hpbAverageScore = await fetchHpbReviewList(salon.hpb_sln_id, { maxPages: 1, proxyUrl: c.env.RANKING_PROXY_URL })
        .then((r) => r.salonAverageScore)
        .catch(() => null)
    }
  }

  return c.render(
    <PageLayout active="review-trend" salonName={user.salon_name} title="口コミ評価推移" reviewEnabled={true}>
      <SyncStatusPanel backfillDone={backfillDone} />

      {backfillDone && (
        <>
          <div class="bg-white rounded-xl border border-gray-100 p-6">
            <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
              <p class="font-semibold">
                <i class="fas fa-chart-line mr-2 text-pink-500"></i>月次評価推移(総合スコア平均)
              </p>
              {hpbAverageScore != null && (
                <p class="text-sm text-gray-600">
                  現在の掲載評点(HPB): <span class="font-bold text-pink-600">{hpbAverageScore.toFixed(2)}</span>
                </p>
              )}
            </div>
            {trend.length === 0 ? (
              <p class="text-sm text-gray-400 text-center py-10">まだ評点付きの口コミがありません</p>
            ) : (
              <div id="review-trend-chart"></div>
            )}
          </div>
          <p class="text-xs text-gray-400">
            ※月次推移は、サロンボード・HPB双方から取得・突合した口コミデータをもとに当ツールが独自に算出したものです。HPBの「現在の掲載評点」は算出基準(集計期間)が公開されていないため、参考値として別途表示しています。
          </p>
        </>
      )}

      <script
        id="review-trend-data"
        type="application/json"
        dangerouslySetInnerHTML={{ __html: escapeJsonForScript({ trend }) }}
      ></script>
      <script src="/static/reviews.js"></script>
    </PageLayout>,
    { title: '口コミ評価推移' }
  )
})

// ---------- ②スタイリスト別評価 ----------

reviews.get('/reviews/by-stylist', async (c) => {
  const user = c.get('user')
  const salonId = user.active_salon_id
  if (!salonId) return c.text('サロンが選択されていません', 400)

  const state = await getBackfillState(c, salonId)
  const backfillDone = !!state?.backfill_completed_at

  const period = c.req.query('period') || 'all'
  const availableMonths = backfillDone ? await getAvailableReviewMonths(c.env, salonId) : []
  const breakdown = backfillDone
    ? await getStylistBreakdown(c.env, salonId, period === 'all' ? 'all' : period)
    : { stylists: [], unmatchedStylistCount: 0 }

  return c.render(
    <PageLayout active="review-by-stylist" salonName={user.salon_name} title="スタイリスト別評価" reviewEnabled={true}>
      <SyncStatusPanel backfillDone={backfillDone} />

      {backfillDone && (
        <>
          <div class="bg-white rounded-xl border border-gray-100 p-6">
            <div class="flex items-center justify-between flex-wrap gap-2 mb-4">
              <p class="font-semibold">
                <i class="fas fa-star mr-2 text-pink-500"></i>スタイリスト別評価(総合スコア平均)
              </p>
              <select
                id="review-stylist-period-select"
                class="text-sm font-semibold text-gray-600 border border-gray-300 rounded-lg px-3 py-2"
                onchange="location.href='/reviews/by-stylist?period='+this.value"
              >
                <option value="all" selected={period === 'all'}>
                  すべての期間
                </option>
                {availableMonths.map((m) => (
                  <option value={m} selected={period === m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            {breakdown.stylists.length === 0 ? (
              <p class="text-sm text-gray-400 text-center py-10">この期間に評点付きの口コミがありません</p>
            ) : (
              <div id="review-stylist-chart"></div>
            )}
          </div>
          {breakdown.unmatchedStylistCount > 0 && (
            <p class="text-xs text-gray-400">
              ※担当スタイリスト名がスタイリスト登録と一致しなかった口コミが{breakdown.unmatchedStylistCount}
              件あり、上記の集計には含まれていません(退職者・表記ゆれ等の可能性があります)。
            </p>
          )}
        </>
      )}

      <script
        id="review-stylist-data"
        type="application/json"
        dangerouslySetInnerHTML={{ __html: escapeJsonForScript({ stylists: breakdown.stylists }) }}
      ></script>
      <script src="/static/reviews.js"></script>
    </PageLayout>,
    { title: 'スタイリスト別評価' }
  )
})

export default reviews
