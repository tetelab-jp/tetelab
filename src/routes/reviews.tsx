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
import { compactDate, formatJstDateTimeCompact } from '../lib/date-format'
import { generateReviewReply } from '../lib/ai-generate'
import { dispatchManualReviewReply, loadSalonProfileForGeneration, loadRecentReviewReplies } from '../lib/review-reply-runner'
import type { Bindings, AppUser } from '../types'

const reviews = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()
type AppContext = Context<{ Bindings: Bindings; Variables: { user: AppUser } }>

reviews.use('/reviews/*', requireAuth)
reviews.use('/api/reviews/*', requireAuth)
reviews.use('/reviews/*', requireReviewEnabled)
reviews.use('/api/reviews/*', requireReviewEnabled)

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

function SyncStatusPanel({ backfillDone, lastSyncRunAt }: { backfillDone: boolean; lastSyncRunAt: string | null }) {
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
        <div class="flex flex-col items-center gap-1">
          <button
            id="review-sync-start-btn"
            type="button"
            class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg whitespace-nowrap disabled:opacity-50"
          >
            {backfillDone ? 'サロンボードから口コミを同期' : '取り込みを開始'}
          </button>
          {backfillDone && (
            <p class="text-xs text-gray-400 whitespace-nowrap">
              最終同期: {lastSyncRunAt ? formatJstDateTimeCompact(lastSyncRunAt) : '未実施'}
            </p>
          )}
        </div>
      </div>
      <p id="review-sync-status-text" class="text-sm text-gray-500 mt-3"></p>
    </div>
  )
}

// 2026-08-21追記(ユーザー指定): ①口コミ評価推移・②スタイリスト別評価の
// 2ページからは手動同期ボタンを削除し、口コミデータの同期は毎週月曜21時
// (JST)の自動処理のみで反映する(review-sync-runner.tsのrunSyncStepForSalon
// 参照)。手動同期ボタンは③口コミ返信ページ(SyncStatusPanel)にのみ残す。
function ReviewAutoSyncInfo({ backfillDone, lastSyncRunAt }: { backfillDone: boolean; lastSyncRunAt: string | null }) {
  return (
    <div class="bg-white rounded-xl border border-gray-100 p-6">
      <p class="font-semibold">
        <i class="fas fa-arrows-rotate mr-2 text-pink-500"></i>口コミデータの同期
      </p>
      {backfillDone ? (
        <>
          <p class="text-sm text-gray-600 mt-1">毎週月曜21時に、サロンボードとHPBの最新の口コミを自動で取得・反映します。</p>
          <p class="text-xs text-gray-400 mt-1">最終同期: {lastSyncRunAt ? formatJstDateTimeCompact(lastSyncRunAt) : '未実施'}</p>
        </>
      ) : (
        <p class="text-sm text-gray-600 mt-1">
          まだ初回データ取り込みが完了していません。
          <a href="/reviews/list" class="text-pink-600 hover:underline">未返信口コミ</a>
          画面から取り込みを開始してください。
        </p>
      )}
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
    <PageLayout active="review-trend" salonName={user.salon_name} title="口コミ評価推移" reviewEnabled={true} isImpersonated={user.is_impersonated === 1}>
      <ReviewAutoSyncInfo backfillDone={backfillDone} lastSyncRunAt={state?.last_sync_run_at ?? null} />

      {backfillDone && (
        <>
          {trendByNewest.length >= 2 && (
            <div class="bg-white rounded-xl border border-gray-100 p-6">
              <p class="text-xs text-gray-400 mb-1">現在の口コミ評価({compactDate(trendByNewest[0].date)}時点)</p>
              <div class="flex items-baseline gap-2 flex-wrap">
                <i class="fas fa-star text-amber-400 text-2xl"></i>
                <span class="text-5xl font-bold text-gray-800">{trendByNewest[0].avgOverall.toFixed(2)}</span>
                <span class="text-sm text-gray-400 ml-1">({trendByNewest[0].count}件)</span>
              </div>
            </div>
          )}

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
                      <th class="px-4 py-3 text-left font-medium whitespace-nowrap">計測日</th>
                      <th class="px-4 py-3 text-left font-medium whitespace-nowrap">評価(総合スコア平均)</th>
                      <th class="px-4 py-3 text-left font-medium whitespace-nowrap">件数</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-50">
                    {trendByNewest.map((p) => (
                      <tr>
                        <td class="px-4 py-2.5 font-mono text-xs text-gray-600 whitespace-nowrap">{compactDate(p.date)}</td>
                        <td class="px-4 py-2.5 font-semibold text-gray-800 whitespace-nowrap">{p.avgOverall.toFixed(2)}</td>
                        <td class="px-4 py-2.5 text-gray-500 whitespace-nowrap">{p.count}件</td>
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
  const dir = c.req.query('dir') === 'asc' ? 'asc' : 'desc'
  const availableMonths = backfillDone ? await getAvailableReviewMonths(c.env, salonId) : []
  const breakdown = backfillDone
    ? await getStylistBreakdown(c.env, salonId, period === 'all' ? 'all' : period, sort, dir)
    : { stylists: [], unmatchedStylistCount: 0 }

  return c.render(
    <PageLayout active="review-by-stylist" salonName={user.salon_name} title="スタイリスト別評価" reviewEnabled={true} isImpersonated={user.is_impersonated === 1}>
      <ReviewAutoSyncInfo backfillDone={backfillDone} lastSyncRunAt={state?.last_sync_run_at ?? null} />

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
                  onchange={`location.href='/reviews/by-stylist?period=${encodeURIComponent(period)}&dir=${dir}&sort='+this.value`}
                >
                  <option value="rating" selected={sort === 'rating'}>
                    評価順
                  </option>
                  <option value="count" selected={sort === 'count'}>
                    件数順
                  </option>
                </select>
                <select
                  id="review-stylist-dir-select"
                  class="text-sm font-semibold text-gray-600 border border-gray-300 rounded-lg px-3 py-2"
                  onchange={`location.href='/reviews/by-stylist?period=${encodeURIComponent(period)}&sort=${sort}&dir='+this.value`}
                >
                  <option value="desc" selected={dir === 'desc'}>
                    高い順
                  </option>
                  <option value="asc" selected={dir === 'asc'}>
                    低い順
                  </option>
                </select>
                <select
                  id="review-stylist-period-select"
                  class="text-sm font-semibold text-gray-600 border border-gray-300 rounded-lg px-3 py-2"
                  onchange={`location.href='/reviews/by-stylist?sort=${sort}&dir=${dir}&period='+this.value`}
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

// ---------- ③口コミ一覧・返信(2026-08-17追記) ----------

type ReviewListRowForUi = {
  id: number
  posted_at: string | null
  score_overall: number | null
  content: string | null
  hpb_nickname: string | null
  stylist_name_raw: string | null
  matched_at: string | null
  replied_at: string | null
  reply_content: string | null
  reply_method: string | null
  ai_reply_draft: string | null
}

const REVIEW_LIST_PAGE_SIZE = 50

reviews.get('/reviews/list', async (c) => {
  const user = c.get('user')
  const salonId = user.active_salon_id
  if (!salonId) return c.text('サロンが選択されていません', 400)

  const state = await getBackfillState(c, salonId)
  const backfillDone = !!state?.backfill_completed_at

  const replySchedule = await c.env.DB.prepare(
    `SELECT use_past_replies FROM review_reply_schedules WHERE user_id = ? AND salon_id = ?`
  )
    .bind(user.id, salonId)
    .first<{ use_past_replies: number }>()
  const usePastReplies = (replySchedule?.use_past_replies ?? 1) !== 0

  // 2026-08-20追記(ユーザー指定): この一覧は「返信する」ための画面のため、
  // 既に返信済みの口コミは表示対象から外し、未返信の口コミのみを表示する。
  const { results: rows } = backfillDone
    ? await c.env.DB.prepare(
        `SELECT id, posted_at, score_overall, content, hpb_nickname, stylist_name_raw, matched_at,
                replied_at, reply_content, reply_method, ai_reply_draft
         FROM reviews WHERE salon_id = ? AND replied_at IS NULL
         ORDER BY posted_at DESC NULLS LAST, id DESC
         LIMIT ${REVIEW_LIST_PAGE_SIZE}`
      )
        .bind(salonId)
        .all<ReviewListRowForUi>()
    : { results: [] as ReviewListRowForUi[] }

  return c.render(
    <PageLayout active="review-list" salonName={user.salon_name} title="未返信口コミ" reviewEnabled={true} isImpersonated={user.is_impersonated === 1}>
      <SyncStatusPanel backfillDone={backfillDone} lastSyncRunAt={state?.last_sync_run_at ?? null} />

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <form method="post" action="/reviews/reply/use-past-replies">
          <label class="flex items-center gap-3 cursor-pointer w-fit">
            <span class="relative inline-flex items-center flex-shrink-0">
              <input type="checkbox" name="use_past_replies" checked={usePastReplies} onchange="this.form.submit()" class="sr-only peer" />
              <span class="w-14 h-8 bg-gray-200 rounded-full peer-checked:bg-pink-500 transition-colors"></span>
              <span class="absolute left-1 top-1 w-6 h-6 bg-white rounded-full shadow transition-transform peer-checked:translate-x-6"></span>
            </span>
            <span class="text-sm font-medium text-gray-700">
              過去の返信の文章を参考にする
              <span class="block text-xs text-gray-400 font-normal">OFFの場合は過去の返信文を参照せずにAI返信文を生成します</span>
            </span>
          </label>
        </form>
      </div>

      {backfillDone && (
        <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div class="px-6 py-4 border-b border-gray-100">
            <p class="font-semibold">
              <i class="fas fa-comments mr-2 text-pink-500"></i>未返信の口コミ(最大{REVIEW_LIST_PAGE_SIZE}件)
            </p>
            <p class="text-xs text-gray-400 mt-1">
              星4以上・HPB掲載済みの口コミは自動返信の対象です(自動返信を有効にしている場合)。それ以外はAI下書き→内容を確認・修正のうえ手動で返信投稿してください。返信済みの口コミはこの一覧から外れます。
            </p>
          </div>
          {rows.length === 0 ? (
            <p class="text-sm text-gray-400 text-center py-10">未返信の口コミはありません</p>
          ) : (
            <div class="divide-y divide-gray-50" id="review-list-container">
              {rows.map((r) => (
                <div class="p-6" data-review-id={r.id} data-review-content={r.content || ''}>
                  <div class="flex items-start justify-between gap-3 flex-wrap">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        {r.score_overall != null ? (
                          <span class="text-amber-500 text-sm font-bold whitespace-nowrap">
                            <i class="fas fa-star mr-1"></i>
                            {r.score_overall}
                          </span>
                        ) : (
                          <span class="text-xs text-gray-400 whitespace-nowrap">評点未取得(HPB未掲載)</span>
                        )}
                        {r.hpb_nickname && <span class="text-sm text-gray-500">{r.hpb_nickname}</span>}
                        {r.stylist_name_raw && (
                          <span class="text-xs text-gray-400 bg-gray-50 rounded-full px-2 py-0.5">
                            担当: {r.stylist_name_raw}
                          </span>
                        )}
                        <span class="text-xs font-semibold text-gray-500 bg-gray-100 rounded-full px-2 py-0.5">未返信</span>
                      </div>
                      <p class="text-xs text-gray-400 mt-1">{r.posted_at || ''}</p>
                    </div>
                  </div>
                  <p class="text-sm text-gray-700 mt-3 whitespace-pre-wrap">{r.content || '(本文なし)'}</p>

                  <div class="mt-3">
                    <button
                      type="button"
                      class="review-reply-open-btn bg-white border border-pink-300 text-pink-600 hover:bg-pink-50 text-sm font-semibold px-4 py-2 rounded-lg"
                      data-review-id={r.id}
                    >
                      <i class="fas fa-reply mr-1"></i>口コミを返信する
                    </button>
                    <div class="review-reply-form hidden mt-3 bg-gray-50 rounded-lg p-4 space-y-3" data-review-id={r.id}>
                      <div class="flex items-center justify-between gap-2 flex-wrap">
                        <p class="text-xs font-semibold text-gray-400">返信文(AI下書き→修正のうえ投稿してください)</p>
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            class="review-reply-generate-btn bg-white border border-pink-300 text-pink-600 hover:bg-pink-50 text-xs font-semibold px-3 py-1.5 rounded-lg whitespace-nowrap"
                            data-review-id={r.id}
                          >
                            <i class="fas fa-wand-magic-sparkles mr-1"></i>AI下書きを生成
                          </button>
                          <button
                            type="button"
                            class="review-reply-close-btn bg-white border border-gray-300 text-gray-500 hover:bg-gray-100 text-xs font-semibold px-3 py-1.5 rounded-lg whitespace-nowrap"
                            data-review-id={r.id}
                          >
                            <i class="fas fa-xmark mr-1"></i>閉じる
                          </button>
                        </div>
                      </div>
                      <div>
                        <p class="text-xs font-semibold text-gray-400 mb-1">
                          返信者<span class="font-normal">(HOT PEPPER Beauty上には表示されません。空欄でも投稿できます)</span>
                        </p>
                        <input
                          type="text"
                          class="review-reply-from-input w-full border border-gray-200 rounded-lg p-2 text-sm"
                          maxlength={20}
                          placeholder="例: オーナー"
                          value={r.stylist_name_raw || ''}
                          data-review-id={r.id}
                        />
                      </div>
                      <textarea
                        class="review-reply-textarea w-full border border-gray-200 rounded-lg p-3 text-sm"
                        rows={4}
                        maxlength={500}
                        placeholder="「AI下書きを生成」を押すか、直接入力してください(全角500文字以内)"
                        data-review-id={r.id}
                      >
                        {r.ai_reply_draft || ''}
                      </textarea>
                      <div class="flex items-center justify-between gap-2">
                        <p class="review-reply-status text-xs text-gray-400" data-review-id={r.id}></p>
                        <button
                          type="button"
                          class="review-reply-send-btn bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-4 py-2 rounded-lg whitespace-nowrap disabled:opacity-50"
                          data-review-id={r.id}
                        >
                          この内容で返信する
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <script src="/static/reviews.js"></script>
    </PageLayout>,
    { title: '未返信口コミ' }
  )
})

// ---------- ④返信済み口コミ ----------
// 2026-08-22追記(ユーザー指定): デザインは③口コミ返信と同じベースを使う。
// 未返信一覧と違い、送信済みの返信文を最初から(開かなくても)表示し、
// 「編集する」ボタンで返信文を編集して再投稿できるようにする。SALON BOARD側の
// 投稿フロー自体は未返信の口コミへの返信と同じ(dispatchManualReviewReplyを
// そのまま再利用、返信済みによるブロックは撤廃済み)。
reviews.get('/reviews/replied', async (c) => {
  const user = c.get('user')
  const salonId = user.active_salon_id
  if (!salonId) return c.text('サロンが選択されていません', 400)

  const state = await getBackfillState(c, salonId)
  const backfillDone = !!state?.backfill_completed_at

  const { results: rows } = backfillDone
    ? await c.env.DB.prepare(
        `SELECT id, posted_at, score_overall, content, hpb_nickname, stylist_name_raw, matched_at,
                replied_at, reply_content, reply_method, ai_reply_draft
         FROM reviews WHERE salon_id = ? AND replied_at IS NOT NULL
         ORDER BY replied_at DESC
         LIMIT ${REVIEW_LIST_PAGE_SIZE}`
      )
        .bind(salonId)
        .all<ReviewListRowForUi>()
    : { results: [] as ReviewListRowForUi[] }

  return c.render(
    <PageLayout active="review-replied" salonName={user.salon_name} title="返信済み口コミ" reviewEnabled={true} isImpersonated={user.is_impersonated === 1}>
      <ReviewAutoSyncInfo backfillDone={backfillDone} lastSyncRunAt={state?.last_sync_run_at ?? null} />

      {backfillDone && (
        <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div class="px-6 py-4 border-b border-gray-100">
            <p class="font-semibold">
              <i class="fas fa-comment-dots mr-2 text-pink-500"></i>返信済みの口コミ(最新{REVIEW_LIST_PAGE_SIZE}件)
            </p>
            <p class="text-xs text-gray-400 mt-1">返信内容を修正して再投稿したい場合は「編集する」から行えます。</p>
          </div>
          {rows.length === 0 ? (
            <p class="text-sm text-gray-400 text-center py-10">返信済みの口コミはありません</p>
          ) : (
            <div class="divide-y divide-gray-50" id="review-list-container">
              {rows.map((r) => (
                <div class="p-6" data-review-id={r.id} data-review-content={r.content || ''}>
                  <div class="flex items-start justify-between gap-3 flex-wrap">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        {r.score_overall != null ? (
                          <span class="text-amber-500 text-sm font-bold whitespace-nowrap">
                            <i class="fas fa-star mr-1"></i>
                            {r.score_overall}
                          </span>
                        ) : (
                          <span class="text-xs text-gray-400 whitespace-nowrap">評点未取得(HPB未掲載)</span>
                        )}
                        {r.hpb_nickname && <span class="text-sm text-gray-500">{r.hpb_nickname}</span>}
                        {r.stylist_name_raw && (
                          <span class="text-xs text-gray-400 bg-gray-50 rounded-full px-2 py-0.5">
                            担当: {r.stylist_name_raw}
                          </span>
                        )}
                        <span class="text-xs font-semibold text-pink-600 bg-pink-50 rounded-full px-2 py-0.5">返信済み</span>
                      </div>
                      <p class="text-xs text-gray-400 mt-1">{r.posted_at || ''}</p>
                    </div>
                  </div>
                  <p class="text-sm text-gray-700 mt-3 whitespace-pre-wrap">{r.content || '(本文なし)'}</p>

                  <div class="mt-3 bg-gray-50 rounded-lg p-4">
                    <p class="text-xs font-semibold text-gray-400 mb-1">
                      サロンからの返信{r.replied_at ? `(${r.replied_at})` : ''}
                    </p>
                    <p class="text-sm text-gray-700 whitespace-pre-wrap">{r.reply_content || '(本文なし)'}</p>
                  </div>

                  <div class="mt-3">
                    <button
                      type="button"
                      class="review-reply-open-btn bg-white border border-pink-300 text-pink-600 hover:bg-pink-50 text-sm font-semibold px-4 py-2 rounded-lg"
                      data-review-id={r.id}
                    >
                      <i class="fas fa-pen mr-1"></i>編集する
                    </button>
                    <div class="review-reply-form hidden mt-3 bg-gray-50 rounded-lg p-4 space-y-3" data-review-id={r.id}>
                      <div class="flex items-center justify-between gap-2 flex-wrap">
                        <p class="text-xs font-semibold text-gray-400">返信文を編集して再投稿できます</p>
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            class="review-reply-generate-btn bg-white border border-pink-300 text-pink-600 hover:bg-pink-50 text-xs font-semibold px-3 py-1.5 rounded-lg whitespace-nowrap"
                            data-review-id={r.id}
                          >
                            <i class="fas fa-wand-magic-sparkles mr-1"></i>AI下書きを生成
                          </button>
                          <button
                            type="button"
                            class="review-reply-close-btn bg-white border border-gray-300 text-gray-500 hover:bg-gray-100 text-xs font-semibold px-3 py-1.5 rounded-lg whitespace-nowrap"
                            data-review-id={r.id}
                          >
                            <i class="fas fa-xmark mr-1"></i>閉じる
                          </button>
                        </div>
                      </div>
                      <div>
                        <p class="text-xs font-semibold text-gray-400 mb-1">
                          返信者<span class="font-normal">(HOT PEPPER Beauty上には表示されません。空欄でも投稿できます)</span>
                        </p>
                        <input
                          type="text"
                          class="review-reply-from-input w-full border border-gray-200 rounded-lg p-2 text-sm"
                          maxlength={20}
                          placeholder="例: オーナー"
                          value={r.stylist_name_raw || ''}
                          data-review-id={r.id}
                        />
                      </div>
                      <textarea
                        class="review-reply-textarea w-full border border-gray-200 rounded-lg p-3 text-sm"
                        rows={4}
                        maxlength={500}
                        placeholder="返信文を修正してください(全角500文字以内)"
                        data-review-id={r.id}
                      >
                        {r.reply_content || ''}
                      </textarea>
                      <div class="flex items-center justify-between gap-2">
                        <p class="review-reply-status text-xs text-gray-400" data-review-id={r.id}></p>
                        <button
                          type="button"
                          class="review-reply-send-btn bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-4 py-2 rounded-lg whitespace-nowrap disabled:opacity-50"
                          data-review-id={r.id}
                        >
                          この内容で再投稿する
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <script src="/static/reviews.js"></script>
    </PageLayout>,
    { title: '返信済み口コミ' }
  )
})

reviews.post('/reviews/reply/schedule', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const enabled = body.enabled === 'on' || body.enabled === 'true'

  await c.env.DB.prepare(
    `INSERT INTO review_reply_schedules (user_id, salon_id, enabled)
     VALUES (?, ?, ?)
     ON CONFLICT (salon_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(user.id, user.active_salon_id, enabled ? 1 : 0)
    .run()

  return c.redirect('/settings/auto-update')
})

// 2026-08-21追記(ユーザー指定): 「過去の返信の文章を参考にする」ON/OFF
// (口コミ返信ページのSyncStatusPanelの下に配置)。自動返信・手動下書き生成の
// 両方に反映される(review-reply-runner.ts/generateReviewReply参照)。
reviews.post('/reviews/reply/use-past-replies', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const usePastReplies = body.use_past_replies === 'on' || body.use_past_replies === 'true'

  await c.env.DB.prepare(
    `INSERT INTO review_reply_schedules (user_id, salon_id, use_past_replies)
     VALUES (?, ?, ?)
     ON CONFLICT (salon_id) DO UPDATE SET use_past_replies = EXCLUDED.use_past_replies, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(user.id, user.active_salon_id, usePastReplies ? 1 : 0)
    .run()

  return c.redirect('/reviews/list')
})

reviews.post('/api/reviews/:id/generate-reply', async (c) => {
  const user = c.get('user')
  const reviewId = Number(c.req.param('id'))
  const review = await c.env.DB.prepare(
    `SELECT score_overall, content, stylist_name_raw, hpb_nickname, menu_used
     FROM reviews WHERE id = ? AND user_id = ? AND salon_id = ?`
  )
    .bind(reviewId, user.id, user.active_salon_id)
    .first<{
      score_overall: number | null
      content: string | null
      stylist_name_raw: string | null
      hpb_nickname: string | null
      menu_used: string | null
    }>()
  if (!review) return c.json({ success: false, error: '対象の口コミが見つかりません' }, 404)

  try {
    const schedule = await c.env.DB.prepare(
      `SELECT use_past_replies FROM review_reply_schedules WHERE user_id = ? AND salon_id = ?`
    )
      .bind(user.id, user.active_salon_id)
      .first<{ use_past_replies: number }>()
    const usePastReplies = (schedule?.use_past_replies ?? 1) !== 0

    const [profile, pastReplies] = await Promise.all([
      loadSalonProfileForGeneration(c.env, user.id, user.active_salon_id),
      usePastReplies ? loadRecentReviewReplies(c.env, user.active_salon_id) : Promise.resolve([])
    ])
    const reply = await generateReviewReply(
      c.env,
      {
        scoreOverall: review.score_overall,
        content: review.content,
        stylistNameRaw: review.stylist_name_raw,
        hpbNickname: review.hpb_nickname,
        menuUsed: review.menu_used
      },
      profile,
      pastReplies
    )
    await c.env.DB.prepare(`UPDATE reviews SET ai_reply_draft = ? WHERE id = ?`).bind(reply, reviewId).run()
    return c.json({ success: true, reply })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err).slice(0, 500) }, 400)
  }
})

reviews.post('/api/reviews/:id/send-reply', async (c) => {
  const user = c.get('user')
  const reviewId = Number(c.req.param('id'))
  const { replyContent, replyFrom } = await c.req
    .json<{ replyContent: string; replyFrom?: string }>()
    .catch(() => ({ replyContent: '', replyFrom: '' }))
  if (!replyContent || !replyContent.trim()) {
    return c.json({ success: false, error: '返信文を入力してください' }, 400)
  }

  try {
    await dispatchManualReviewReply(c.env, user.id, user.active_salon_id, reviewId, replyContent, replyFrom || null)
    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err).slice(0, 500) }, 400)
  }
})

export default reviews
