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
import { getTrendSnapshots, getAvailableReviewMonths, getStylistBreakdown } from '../lib/review-aggregation'
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

  const trend = backfillDone ? await getTrendSnapshots(c.env, salonId) : []
  const trendByNewest = [...trend].reverse()

  return c.render(
    <PageLayout active="review-trend" salonName={user.salon_name} title="口コミ評価推移" reviewEnabled={true}>
      <SyncStatusPanel backfillDone={backfillDone} />

      {backfillDone && (
        <>
          <div class="bg-white rounded-xl border border-gray-100 p-6">
            <p class="font-semibold mb-4">
              <i class="fas fa-chart-line mr-2 text-pink-500"></i>評価推移(総合スコア平均)
            </p>
            {trend.length === 0 ? (
              <p class="text-sm text-gray-400 text-center py-10">まだ計測結果がありません</p>
            ) : (
              <div id="review-trend-chart"></div>
            )}
          </div>
          <p class="text-xs text-gray-400">
            ※同期(計測)を実行した日ごとに、その時点の口コミ評価(サロンボード・HPB双方から取得・突合)を記録したものです。
          </p>

          {trendByNewest.length > 0 && (
            <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead class="bg-gray-50 text-gray-500 text-xs">
                    <tr>
                      <th class="px-4 py-3 text-left font-medium">計測日</th>
                      <th class="px-4 py-3 text-left font-medium">評価(総合スコア平均)</th>
                      <th class="px-4 py-3 text-left font-medium">件数</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-50">
                    {trendByNewest.map((p) => (
                      <tr>
                        <td class="px-4 py-2.5 font-mono text-xs text-gray-600">{p.date}</td>
                        <td class="px-4 py-2.5 font-semibold text-gray-800">{p.avgOverall.toFixed(2)}</td>
                        <td class="px-4 py-2.5 text-gray-500">{p.count}件</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
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
  const sort = c.req.query('sort') === 'count' ? 'count' : 'rating'
  const availableMonths = backfillDone ? await getAvailableReviewMonths(c.env, salonId) : []
  const breakdown = backfillDone
    ? await getStylistBreakdown(c.env, salonId, period === 'all' ? 'all' : period, sort)
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
              <div class="flex items-center gap-2 flex-wrap">
                <select
                  id="review-stylist-sort-select"
                  class="text-sm font-semibold text-gray-600 border border-gray-300 rounded-lg px-3 py-2"
                  onchange={`location.href='/reviews/by-stylist?period=${encodeURIComponent(period)}&sort='+this.value`}
                >
                  <option value="rating" selected={sort === 'rating'}>
                    評価順
                  </option>
                  <option value="count" selected={sort === 'count'}>
                    件数順
                  </option>
                </select>
                <select
                  id="review-stylist-period-select"
                  class="text-sm font-semibold text-gray-600 border border-gray-300 rounded-lg px-3 py-2"
                  onchange={`location.href='/reviews/by-stylist?sort=${sort}&period='+this.value`}
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
            </div>
            {breakdown.stylists.length === 0 ? (
              <p class="text-sm text-gray-400 text-center py-10">この期間に評点付きの口コミがありません</p>
            ) : (
              <div class="divide-y divide-gray-50">
                {breakdown.stylists.map((s, i) => (
                  <div class="py-4">
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex items-center gap-3 min-w-0">
                        <span class="flex-shrink-0 w-7 h-7 rounded-full bg-pink-50 text-pink-600 text-xs font-bold flex items-center justify-center">
                          {i + 1}
                        </span>
                        <p class="font-semibold text-gray-800 truncate" title={s.stylistName}>
                          {s.stylistName}
                        </p>
                      </div>
                      <div class="flex items-baseline gap-1.5 flex-shrink-0">
                        <i class="fas fa-star text-amber-400 text-sm"></i>
                        <span class="text-2xl font-bold text-gray-800">{s.avgOverall.toFixed(2)}</span>
                        <span class="text-xs font-semibold text-gray-400 bg-gray-50 rounded-full px-2 py-0.5 ml-1">
                          {s.count}件
                        </span>
                      </div>
                    </div>
                    <div class="mt-3 space-y-1">
                      {s.starCounts.map((sc) => (
                        <div class="flex items-center gap-2">
                          <span class="flex-shrink-0 w-6 text-right text-xs font-semibold text-gray-500">{sc.star}</span>
                          <i class="fas fa-star text-amber-400 text-[10px] flex-shrink-0"></i>
                          <div class="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              class="h-full bg-amber-400 rounded-full"
                              style={`width: ${s.count > 0 ? ((sc.count / s.count) * 100).toFixed(1) : 0}%`}
                            ></div>
                          </div>
                          <span class="flex-shrink-0 w-8 text-right text-xs text-gray-400">{sc.count}</span>
                        </div>
                      ))}
                    </div>
                    <div class="flex flex-wrap gap-x-3 gap-y-1 mt-3 text-xs text-gray-400">
                      <span>雰囲気 {s.avgAtmosphere.toFixed(2)}</span>
                      <span>接客 {s.avgService.toFixed(2)}</span>
                      <span>技術 {s.avgTechnique.toFixed(2)}</span>
                      <span>メニュー・料金 {s.avgMenuPrice.toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>
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

      <script src="/static/reviews.js"></script>
    </PageLayout>,
    { title: 'スタイリスト別評価' }
  )
})

export default reviews
