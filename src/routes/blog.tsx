import { Hono, type Context } from 'hono'
import { requireAuth, requireBlogEnabled } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import { processBlogArticleImage } from '../lib/image-process'
import {
  generateCategoryDraft,
  generateArticleContent,
  generateImageDescription,
  type SalonProfileForGeneration
} from '../lib/ai-generate'
import { resetStuckBlogJobsForUser } from '../lib/blog-post-runner'
import { buildFooterText, buildAutoFooterText, getFooterTextForSalon, getFooterTextAndSeparatorForSalon, stripTrailingFooterBlock } from '../lib/blog-footer'
import { formatJstDateCompact, formatJstDateTimeCompact, compactDate } from '../lib/date-format'
import { fetchSalonProfileFromHpb, fetchHpbBlogArticles } from '../lib/ranking-scraper'
import { formatCustomerRatioText } from '../lib/ranking-parse'
import type { Bindings, AppUser } from '../types'

const blog = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()
type AppContext = Context<{ Bindings: Bindings; Variables: { user: AppUser } }>

// 2026-08-12追記(重大バグ修正): '*'で登録すると、index.tsxで全サブアプリが
// 同じベースパス('/')にapp.route()マウントされている都合上、このサブアプリに
// 存在しないパス(例: /admin/*)に対してもこのミドルウェアが先に反応し、
// 未ログイン/機能OFF等の理由でリダイレクトを返してしまい、後続でマウントされる
// 他のサブアプリ(admin等)へのリクエストを乗っ取ってしまう(実機で確認済みの
// 不具合)。自分が実際に持つルートのパスパターンだけを明示することで防ぐ。
blog.use('/blog/*', requireAuth)
blog.use('/api/blog/*', requireAuth)
blog.use('/blog/*', requireBlogEnabled)
blog.use('/api/blog/*', requireBlogEnabled)

// ============================================
// 2026-08-14追記: ブログ自動投稿機能の大幅リニューアル(Phase 1)。
// /blog/master・/blog/posts(AIで1本ずつ本文生成→手動貼り付け)を廃止し、
// /blog/salon(サロン基本情報)・/blog/template(カテゴリ別テンプレート+
// 画像アップロード+AI一括生成)・/blog/articles(承認・並べ替え・一覧)の
// 3ページ構成に置き換える。自動投稿(SALON BOARDへの実際の投稿)は
// Phase 2で実装するため、このPhase 1では「記事を作って承認する」ところまで。
// ============================================

// SALON BOARDのブログ投稿フォーム(カテゴリ選択select#blogCategoryCd)に
// 実際に存在する11件のカテゴリ(固定enum)。表示順もSALON BOARD側と一致させる。
const HPB_BLOG_CATEGORY_OPTIONS = [
  'こだわりの仕事道具',
  'おすすめスタイル',
  'サロンのNEWS',
  'おすすめメニュー',
  '仕事の出来事',
  'プライベート',
  'マイペット',
  'お気に入りアイテム',
  '趣味・マイブーム',
  'ビューティー',
  'その他'
] as const

type SalonProfileRow = {
  concept: string | null
  target_customer: string | null
  writing_tone: string | null
  ng_words: string | null
  address: string | null
  nearest_station: string | null
  walk_minutes: string | null
  business_hours: string | null
  closing_days: string | null
  strengths: string | null
  price_range: string | null
  reference_text: string | null
  first_person: string | null
  sentence_ending: string | null
  footer_separator: string | null
  footer_keywords_json: string | null
  footer_override_text: string | null
  salonboard_synced_at: string | null
  hpb_catch: string | null
  hpb_copy: string | null
  hpb_message: string | null
  hpb_avg_price_first: string | null
  hpb_avg_price_repeat: string | null
  hpb_customer_ratio: string | null
}

async function getSalonProfile(c: AppContext, user: AppUser): Promise<SalonProfileRow | null> {
  return c.env.DB.prepare(
    `SELECT concept, target_customer, writing_tone, ng_words, address, nearest_station, walk_minutes,
            business_hours, closing_days, strengths, price_range, reference_text, first_person,
            sentence_ending, footer_separator, footer_keywords_json, footer_override_text, salonboard_synced_at,
            hpb_catch, hpb_copy, hpb_message, hpb_avg_price_first, hpb_avg_price_repeat, hpb_customer_ratio
     FROM salon_profiles WHERE user_id = ? AND salon_id = ?`
  )
    .bind(user.id, user.active_salon_id)
    .first<SalonProfileRow>()
}

async function getBlogReferenceArticleCount(c: AppContext, user: AppUser): Promise<number> {
  const row = await c.env.DB.prepare('SELECT COUNT(*) AS cnt FROM blog_reference_articles WHERE user_id = ? AND salon_id = ?')
    .bind(user.id, user.active_salon_id)
    .first<{ cnt: number }>()
  return row?.cnt ?? 0
}

type BlogReferenceArticleRow = {
  id: number
  title: string | null
  excerpt: string
  posted_date: string | null
  category_name: string | null
  stylist_name: string | null
}

// 2026-08-21追記(ユーザー指定): 「サロンボードからブログ読み込み」で取得した
// 過去記事一覧(blog_reference_articles、既にAI生成の参考材料として保存済み)を、
// 既存スタイル取り込みと同じ「一覧から選んで投稿記事一覧へ追加する」画面としても
// 使えるようにする。取得済みデータをそのまま読み出すだけで、個別記事ページへの
// 追加アクセス(全文取得)は行わない(一覧の抜粋のみを取り込み用の本文にする)。
async function getBlogReferenceArticles(c: AppContext, user: AppUser): Promise<BlogReferenceArticleRow[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, excerpt, posted_date, category_name, stylist_name
     FROM blog_reference_articles WHERE user_id = ? AND salon_id = ? ORDER BY sort_order ASC`
  )
    .bind(user.id, user.active_salon_id)
    .all<BlogReferenceArticleRow>()
  return results || []
}

type SalonAreaLookupRow = { salon_name: string | null; middle_area_name: string | null; small_area_name: string | null }

// 複数サロンワークスペース対応: 現在アクティブなサロン(user.active_salon_id)を
// そのまま参照する。未設定(移行前の異常系)の場合のみ、従来通り先頭行に
// フォールバックする。
async function getSalonForProfile(c: AppContext, user: AppUser): Promise<SalonAreaLookupRow | null> {
  const AREA_COLUMNS = 'salon_name, middle_area_name, small_area_name'
  if (user.active_salon_id) {
    const row = await c.env.DB.prepare(`SELECT ${AREA_COLUMNS} FROM salonboard_salons WHERE id = ?`)
      .bind(user.active_salon_id)
      .first<SalonAreaLookupRow>()
    if (row) return row
  }
  return c.env.DB.prepare(`SELECT ${AREA_COLUMNS} FROM salonboard_salons WHERE user_id = ? ORDER BY id LIMIT 1`)
    .bind(user.id)
    .first<SalonAreaLookupRow>()
}

async function getSalonProfileForGeneration(c: AppContext, user: AppUser): Promise<SalonProfileForGeneration> {
  const [profile, salon, referenceArticles] = await Promise.all([
    getSalonProfile(c, user),
    getSalonForProfile(c, user),
    c.env.DB.prepare(
      'SELECT title, excerpt FROM blog_reference_articles WHERE user_id = ? AND salon_id = ? ORDER BY sort_order ASC LIMIT 10'
    )
      .bind(user.id, user.active_salon_id)
      .all<{ title: string | null; excerpt: string }>()
  ])
  if (!profile) return null
  const areaLabel = [salon?.middle_area_name, salon?.small_area_name].filter(Boolean).join(' > ') || null
  return {
    salon_name: salon?.salon_name || null,
    area_label: areaLabel,
    concept: profile.concept,
    target_customer: profile.target_customer,
    strengths: profile.strengths,
    price_range: profile.price_range,
    writing_tone: profile.writing_tone,
    first_person: profile.first_person,
    sentence_ending: profile.sentence_ending,
    ng_words: profile.ng_words,
    reference_text: profile.reference_text,
    hpb_catch: profile.hpb_catch,
    hpb_copy: profile.hpb_copy,
    hpb_message: profile.hpb_message,
    hpb_avg_price_first: profile.hpb_avg_price_first,
    hpb_avg_price_repeat: profile.hpb_avg_price_repeat,
    hpb_customer_ratio: profile.hpb_customer_ratio,
    reference_articles: referenceArticles.results || []
  }
}

// ---------- 1. ブログスタイル設定 ----------

blog.get('/blog/salon', async (c) => {
  const user = c.get('user')
  const [profile, referenceArticles] = await Promise.all([getSalonProfile(c, user), getBlogReferenceArticles(c, user)])
  const referenceArticleCount = referenceArticles.length
  const imported = c.req.query('imported')

  return c.render(
    <PageLayout seoEnabled={user.seo_enabled !== 0} reviewEnabled={user.review_enabled !== 0} isImpersonated={user.is_impersonated === 1} active="blog-salon" salonName={user.salon_name} title="HPBからブログを取り込む" styleEnabled={user.style_enabled !== 0}>
      {imported && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>{imported}件の記事を登録ブログへ追加しました
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6 flex items-center gap-4 flex-wrap">
        <div class="flex-1 min-w-[240px]">
          <p class="font-semibold text-sm">サロンボードから読み込む</p>
          <p class="text-xs text-gray-400 mt-1">
            スタイリスト・クーポン・サロン名のほか、HPB公開ページのキャッチ・コピー・メッセージ・平均予約金額・来店者の性別/年代比率と過去のブログ記事(最大100件、参考記事{referenceArticleCount}件)を取得し、AI記事生成の参考材料にします
          </p>
        </div>
        <div class="flex flex-col items-center gap-1">
          <button id="blog-salon-sync-btn" class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">
            サロンボードからブログ読み込み
          </button>
          <p id="blog-salon-last-at" class="text-xs text-gray-400">
            最終取得: {profile?.salonboard_synced_at ? formatJstDateTimeCompact(profile.salonboard_synced_at) : '未取得'}
          </p>
        </div>
        <p id="blog-salon-sync-status" class="text-sm text-gray-500 w-full"></p>
      </div>

      {referenceArticles.length > 0 && (
        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
            <p class="font-semibold">
              <i class="fas fa-list-check mr-2 text-pink-500"></i>
              取り込んだ過去の記事（{referenceArticles.length}件）
            </p>
            <div class="flex gap-2">
              <button type="button" id="blog-ref-select-all-btn" class="text-xs text-pink-600 hover:underline">全選択</button>
              <button type="button" id="blog-ref-deselect-all-btn" class="text-xs text-pink-600 hover:underline">全解除</button>
            </div>
          </div>
          <p class="text-xs text-gray-400 mb-3">
            選択した記事を登録ブログへ追加します。本文は一覧の抜粋がそのまま入るため、必要に応じて追加後に編集してください。カテゴリ・投稿者はHPB公開ページの表示から一致するものを自動設定します(一致しない場合は未設定のままなので、追加後に編集画面で設定してください)。タイトルをタップすると内容を確認できます。
          </p>
          <form method="post" action="/blog/salon/import-references">
            <button type="submit" class="mb-3 bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg">
              登録ブログへ追加
            </button>
            <ul class="divide-y divide-gray-100 border border-gray-100 rounded-lg">
              {referenceArticles.map((a) => (
                <li class="flex items-start gap-3 p-3">
                  <input type="checkbox" name="reference_id" value={a.id} class="blog-ref-checkbox mt-1 w-4 h-4 accent-pink-500 flex-shrink-0" />
                  <button
                    type="button"
                    class="blog-ref-view-btn min-w-0 flex-1 text-left"
                    data-title={a.title || '（無題）'}
                    data-date={a.posted_date ? compactDate(a.posted_date) : ''}
                    data-content={a.excerpt}
                  >
                    <p class="text-sm font-medium text-gray-700 truncate">{a.title || '（無題）'}</p>
                    <p class="text-xs text-gray-400 mt-0.5">
                      {a.posted_date ? `${compactDate(a.posted_date)} ・ ` : ''}
                      {a.excerpt.slice(0, 60)}
                    </p>
                    {(a.category_name || a.stylist_name) && (
                      <p class="text-xs text-gray-400 mt-0.5">
                        {a.category_name && <span class="inline-block bg-gray-100 text-gray-500 rounded px-1.5 py-0.5 mr-1">{a.category_name}</span>}
                        {a.stylist_name && <span class="inline-block bg-gray-100 text-gray-500 rounded px-1.5 py-0.5">{a.stylist_name}</span>}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <button type="submit" class="mt-3 bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg">
              登録ブログへ追加
            </button>
          </form>
        </div>
      )}

      <div id="blog-ref-view-modal" class="hidden fixed inset-0 z-50 items-center justify-center bg-black/50 p-4">
        <div class="bg-white rounded-xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto space-y-3">
          <div class="flex items-start justify-between gap-2">
            <p id="blog-ref-view-title" class="font-semibold"></p>
            <button type="button" id="blog-ref-view-close-btn" class="text-gray-400 hover:text-gray-600 flex-shrink-0">
              <i class="fas fa-xmark text-lg"></i>
            </button>
          </div>
          <p id="blog-ref-view-date" class="text-xs text-gray-400"></p>
          <p id="blog-ref-view-content" class="text-sm text-gray-700 whitespace-pre-line"></p>
        </div>
      </div>

      <p class="text-xs text-gray-400">
        住所・営業時間などの基本情報とフッター設定は
        <a href="/blog/template" class="text-pink-600 hover:underline">生成テンプレート</a>
        画面に移動しました。
      </p>

      <script src="/static/blog-salon.js"></script>
    </PageLayout>,
    { title: 'HPBからブログを取り込む' }
  )
})

// 2026-08-21追記(ユーザー指定): 「取り込んだ過去の記事」から選択した分を
// 投稿記事一覧(blog_articles)へ追加する(既存スタイル取り込みの「登録スタイルへ
// 追加」と同じ位置づけ)。本文は一覧の抜粋をそのまま使う(全文は取得していない
// ため)。自動投稿は既に公開済みの記事の再投稿を防ぐためOFFで追加する。
blog.post('/blog/salon/import-references', async (c) => {
  const user = c.get('user')
  // 2026-08-21追記(ユーザー指摘によるバグ修正): { all: true }を付けずに
  // parseBody()を呼ぶと、同名(reference_id)のチェックボックスが複数
  // チェックされていても最後の1件の値で上書きされてしまい(Honoの既定動作)、
  // 複数選択して「登録ブログへ追加」を押しても1件しか追加されなかった。
  const body = await c.req.parseBody({ all: true })
  const idsRaw = body.reference_id
  const ids = (Array.isArray(idsRaw) ? idsRaw : idsRaw ? [idsRaw] : [])
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0)

  if (ids.length === 0) return c.redirect('/blog/salon')

  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, title, excerpt, posted_date, category_name, stylist_name, stylist_salonboard_key
     FROM blog_reference_articles
     WHERE id IN (${ids.map(() => '?').join(',')}) AND user_id = ? AND salon_id = ?`
  )
    .bind(...ids, user.id, user.active_salon_id)
    .all<{
      id: number
      title: string | null
      excerpt: string
      posted_date: string | null
      category_name: string | null
      stylist_name: string | null
      stylist_salonboard_key: string | null
    }>()

  const nextOrderRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM blog_articles WHERE user_id = ? AND salon_id = ?'
  )
    .bind(user.id, user.active_salon_id)
    .first<{ n: number }>()
  let sortOrder = nextOrderRow?.n ?? 0

  // 2026-08-21追記(ユーザー指摘によるバグ修正): このルートは新規作成/AI生成と
  // 違い、確認・編集画面を挟まずクリックした時点で直接一覧へ追加する仕様
  // (既存スタイル取り込みと同じ位置づけ)。GET /blog/articlesがstatus='approved'
  // のみ表示するようになったため、ここもapprovedで作成しないと追加した記事が
  // 一覧に一切表示されなくなってしまう。
  // 2026-08-21追記(ユーザー提供の実HTMLで確認): HPB公開ブログ一覧にはカテゴリ・
  // 投稿者(スタイリスト)も掲載されている。カテゴリはHPB_BLOG_CATEGORY_OPTIONSの
  // ラベル文字列と一致する想定なのでresolveArticleCategoryIdでcategory_idへ
  // (存在しなければ生成テンプレートと同じ仕組みで自動作成)、投稿者は
  // stylists.salonboard_stylist_key(Tコード)との完全一致でstylist_idへ変換する
  // (曖昧一致はしない。一致しなければ未設定のまま、編集画面で手動設定できる)。
  for (const row of rows || []) {
    const lastPostedAt = row.posted_date ? `${row.posted_date} 00:00:00` : null
    const categoryId = row.category_name ? await resolveArticleCategoryId(c, user, row.category_name) : null
    const stylistRow = row.stylist_salonboard_key
      ? await c.env.DB.prepare(
          'SELECT id FROM stylists WHERE user_id = ? AND salon_id = ? AND salonboard_stylist_key = ?'
        )
          .bind(user.id, user.active_salon_id, row.stylist_salonboard_key)
          .first<{ id: number }>()
      : null

    await c.env.DB.prepare(
      `INSERT INTO blog_articles (
         user_id, salon_id, category_id, stylist_id, title, body, month_tags_json,
         footer_enabled_flag, auto_post_enabled_flag, status, approved_at, sort_order, last_posted_at, post_count
       ) VALUES (?, ?, ?, ?, ?, ?, '[]', 1, 0, 'approved', CURRENT_TIMESTAMP, ?, ?, ?)`
    )
      .bind(
        user.id, user.active_salon_id, categoryId, stylistRow?.id ?? null, row.title, row.excerpt,
        sortOrder, lastPostedAt, lastPostedAt ? 1 : 0
      )
      .run()
    sortOrder += 1
  }

  return c.redirect(`/blog/salon?imported=${rows?.length ?? 0}`)
})

// サロンボード同期(既存の/api/settings/sync-stylists-coupons、dashboard.tsx参照)を
// 呼び出した後にこの画面から叩く、最終取得日時の記録エンドポイント。
// スタイリスト・クーポン取得の実処理(ブラウザ起動・ログイン・スクレイピング)自体は
// 既存エンドポイントを再利用し、二重実装を避ける(public/static/blog-salon.js参照)。
// 2026-08-17追記(ユーザー指定): このタイミングでHPB公開ページ(ログイン不要・
// fetchのみ)からキャッチ・コピー・「からの一言」メッセージと、過去のブログ記事
// (最大100件、一覧の抜粋のみ)を取得し、AI記事生成の参考材料として保存する。
blog.post('/blog/salon/mark-synced', async (c) => {
  const user = c.get('user')
  const existing = await c.env.DB.prepare('SELECT id FROM salon_profiles WHERE user_id = ? AND salon_id = ?')
    .bind(user.id, user.active_salon_id)
    .first()
  const salon = await c.env.DB.prepare('SELECT hpb_sln_id FROM salonboard_salons WHERE id = ?')
    .bind(user.active_salon_id)
    .first<{ hpb_sln_id: string | null }>()

  let hpbCatch: string | null = null
  let hpbCopy: string | null = null
  let hpbMessage: string | null = null
  let hpbAvgPriceFirst: string | null = null
  let hpbAvgPriceRepeat: string | null = null
  let hpbCustomerRatio: string | null = null
  let articleCount = 0
  let hpbError: string | null = null

  if (!salon?.hpb_sln_id) {
    hpbError = 'HPB公開ページのサロンIDが未検出のため、キャッチ・コピー・メッセージ・ブログ記事の取得はスキップされました'
  } else {
    try {
      const [profileInfo, blogResult] = await Promise.all([
        fetchSalonProfileFromHpb(salon.hpb_sln_id, { proxyUrl: c.env.RANKING_PROXY_URL }),
        fetchHpbBlogArticles(salon.hpb_sln_id, { proxyUrl: c.env.RANKING_PROXY_URL })
      ])
      hpbCatch = profileInfo.catchCopy
      hpbCopy = profileInfo.description
      hpbMessage = profileInfo.message
      hpbAvgPriceFirst = profileInfo.avgPriceFirstVisit
      hpbAvgPriceRepeat = profileInfo.avgPriceRepeat
      hpbCustomerRatio = formatCustomerRatioText(profileInfo.genderRatio, profileInfo.ageRatio)

      // 毎回全置き換え(差分更新ではなく、HPB側の最新一覧をそのまま反映する)
      await c.env.DB.prepare('DELETE FROM blog_reference_articles WHERE user_id = ? AND salon_id = ?')
        .bind(user.id, user.active_salon_id)
        .run()
      let sortOrder = 0
      for (const item of blogResult.items) {
        await c.env.DB.prepare(
          `INSERT INTO blog_reference_articles (
             user_id, salon_id, title, excerpt, source_url, posted_date,
             category_name, stylist_name, stylist_salonboard_key, sort_order
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            user.id, user.active_salon_id, item.title, item.excerpt, item.sourceUrl, item.postedDate,
            item.categoryName, item.stylistName, item.stylistSalonboardKey, sortOrder
          )
          .run()
        sortOrder += 1
      }
      articleCount = blogResult.items.length
    } catch (err: any) {
      hpbError = `HPBからの参考情報取得に失敗しました: ${err?.message || String(err)}`
    }
  }

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE salon_profiles SET salonboard_synced_at = CURRENT_TIMESTAMP,
         hpb_catch = COALESCE(?, hpb_catch), hpb_copy = COALESCE(?, hpb_copy), hpb_message = COALESCE(?, hpb_message),
         hpb_avg_price_first = COALESCE(?, hpb_avg_price_first), hpb_avg_price_repeat = COALESCE(?, hpb_avg_price_repeat),
         hpb_customer_ratio = COALESCE(?, hpb_customer_ratio)
       WHERE user_id = ? AND salon_id = ?`
    )
      .bind(hpbCatch, hpbCopy, hpbMessage, hpbAvgPriceFirst, hpbAvgPriceRepeat, hpbCustomerRatio, user.id, user.active_salon_id)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO salon_profiles (user_id, salon_id, salonboard_synced_at, hpb_catch, hpb_copy, hpb_message,
         hpb_avg_price_first, hpb_avg_price_repeat, hpb_customer_ratio)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)`
    )
      .bind(user.id, user.active_salon_id, hpbCatch, hpbCopy, hpbMessage, hpbAvgPriceFirst, hpbAvgPriceRepeat, hpbCustomerRatio)
      .run()
  }

  return c.json({ success: true, articleCount, hpbError })
})

// ---------- 2. 生成テンプレート ----------

type CategoryRow = {
  id: number
  name: string
  is_active: number
  sort_order: number
  hpb_category_value: string | null
  default_stylist_id: number | null
  key_message: string | null
  title_prompt: string | null
  body_prompt: string | null
  season_months_json: string | null
  use_reference_articles: number
}

// 記事カテゴリの季節パラメータ用の二月セット。生成AIへの季節柄の指示と、
// このカテゴリで生成する記事のmonth_tags_json(投稿カレンダーの月一致判定)の
// 両方に使う。各ペアのvalueは"1,2"のようにカンマ区切りで送られてくる。
const SEASON_MONTH_PAIRS: [number, number][] = [
  [1, 2],
  [3, 4],
  [5, 6],
  [7, 8],
  [9, 10],
  [11, 12]
]

function parseSeasonMonths(json: string | null): number[] {
  try {
    const arr = JSON.parse(json || '[]')
    return Array.isArray(arr) ? arr.filter((n) => Number.isInteger(n) && n >= 1 && n <= 12) : []
  } catch {
    return []
  }
}

blog.get('/blog/template', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')

  const { results: categories } = await c.env.DB.prepare(
    `SELECT id, name, is_active, sort_order, hpb_category_value, default_stylist_id, key_message, title_prompt, body_prompt, season_months_json, use_reference_articles
     FROM blog_categories WHERE user_id = ? AND salon_id = ? ORDER BY sort_order ASC, id ASC`
  )
    .bind(user.id, user.active_salon_id)
    .all<CategoryRow>()

  const catList = categories || []
  // 2026-08-21追記(ユーザー指定): 「新規追加」と「既存編集」の境界が
  // わかりにくかったため、常に選択状態を表示する一体型UIをやめ、
  // クエリパラメータで3状態(ランディング/新規追加フォーム/編集フォーム)を
  // 切り替えるページ遷移方式に変更する。
  const isNewMode = c.req.query('new') === '1'
  const categoryParam = c.req.query('category')
  const selectedId = categoryParam ? Number(categoryParam) : 0
  const selected = selectedId ? catList.find((cat) => cat.id === selectedId) || null : null

  const { results: stylists } = await c.env.DB.prepare(
    'SELECT id, name FROM stylists WHERE user_id = ? AND salon_id = ? AND is_active = 1 ORDER BY sort_order ASC'
  )
    .bind(user.id, user.active_salon_id)
    .all<{ id: number; name: string }>()

  const [profile, salon, referenceArticleCount] = await Promise.all([
    getSalonProfile(c, user),
    getSalonForProfile(c, user),
    getBlogReferenceArticleCount(c, user)
  ])
  const footerText = buildFooterText(salon?.salon_name || null, profile)
  const footerLines = footerText ? footerText.split('\n').length : 0
  const hasReferenceMaterial = Boolean(profile?.salonboard_synced_at) && referenceArticleCount > 0

  return c.render(
    <PageLayout seoEnabled={user.seo_enabled !== 0} reviewEnabled={user.review_enabled !== 0} isImpersonated={user.is_impersonated === 1} active="blog-template" salonName={user.salon_name} title="生成テンプレート" styleEnabled={user.style_enabled !== 0}>
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>保存しました
        </div>
      )}

      {isNewMode ? (
        <div class="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
          <a href="/blog/template" class="text-xs text-pink-600 hover:underline">
            <i class="fas fa-arrow-left mr-1"></i>テンプレート一覧に戻る
          </a>
          <p class="font-semibold">
            <i class="fas fa-plus mr-2 text-pink-500"></i>新しい記事テンプレートを追加
          </p>
          {catList.length >= 10 ? (
            <p class="text-sm text-gray-400">記事カテゴリは最大10件までです。既存のテンプレートを整理してから追加してください。</p>
          ) : (
            <form method="post" action="/blog/template/categories/add" class="flex flex-col sm:flex-row gap-2">
              <input type="text" name="name" required placeholder="新しい記事カテゴリ名" class="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              <button type="submit" class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-5 py-2 rounded-lg flex-shrink-0">カテゴリを追加する</button>
            </form>
          )}
        </div>
      ) : selected ? (
        <div class="space-y-6 min-w-0">
          <a href="/blog/template" class="text-xs text-pink-600 hover:underline">
            <i class="fas fa-arrow-left mr-1"></i>テンプレート一覧に戻る
          </a>
          <div class="bg-white rounded-xl border border-gray-100 p-6">
            <div class="flex items-center justify-between mb-3">
              <p class="font-semibold">
                <i class="fas fa-tag mr-2 text-pink-500"></i>この記事カテゴリについて
              </p>
              <form method="post" action={`/blog/template/categories/${selected.id}/delete`} onsubmit="return confirm('このカテゴリを削除します(記事のカテゴリ設定は解除されます)。よろしいですか？')">
                <button type="submit" class="text-xs text-gray-400 hover:text-red-500">
                  <i class="fas fa-trash mr-1"></i>削除
                </button>
              </form>
            </div>
            <form method="post" action={`/blog/template/categories/${selected.id}`} class="space-y-4">
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">名前</label>
                  <input type="text" name="name" value={selected.name} required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">HPBブログカテゴリ</label>
                  <select name="hpb_category_value" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                    <option value="">選択しない</option>
                    {HPB_BLOG_CATEGORY_OPTIONS.map((opt) => (
                      <option value={opt} selected={selected.hpb_category_value === opt}>{opt}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">デフォルト投稿者</label>
                  <select name="default_stylist_id" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                    <option value="">選択しない</option>
                    {(stylists || []).map((st) => (
                      <option value={st.id} selected={selected.default_stylist_id === st.id}>{st.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                {hasReferenceMaterial ? (
                  <p class="text-xs text-green-600 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                    <i class="fas fa-circle-check mr-1"></i>
                    サロンボードから読み込んだ過去のブログ記事・キャッチ・コピー・メッセージを参考に生成します
                  </p>
                ) : (
                  <p class="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <i class="fas fa-triangle-exclamation mr-1"></i>
                    生成するためには先に
                    <a href="/blog/salon" class="underline font-semibold">「サロンボードから読み込む」</a>
                    を実行してください
                  </p>
                )}
                <label class="flex items-center gap-2 text-sm mt-2">
                  <input
                    type="checkbox"
                    name="use_reference_articles"
                    checked={selected.use_reference_articles !== 0}
                    class="accent-pink-500"
                  />
                  過去のブログの文章を参考にする
                  <span class="text-xs text-gray-400">(OFFの場合はこのテンプレートの情報のみで生成します)</span>
                </label>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  配信する月を限定する<span class="text-xs text-gray-400 ml-2">選んだ月ごろの内容として生成され、その記事の投稿予定月にもなります</span>
                </label>
                <div class="flex flex-wrap gap-3">
                  {(() => {
                    const selectedMonths = parseSeasonMonths(selected.season_months_json)
                    return SEASON_MONTH_PAIRS.map(([m1, m2]) => (
                      <label class="flex items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          name="season_pairs"
                          value={`${m1},${m2}`}
                          checked={selectedMonths.includes(m1) && selectedMonths.includes(m2)}
                          class="accent-pink-500"
                        />
                        {m1}・{m2}月
                      </label>
                    ))
                  })()}
                </div>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">
                  伝えたいこと(本文の生成指示)<span class="text-xs text-gray-400 ml-2">記事の中身になります</span>
                </label>
                <textarea id="key-message-input" name="key_message" rows={3} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">{selected.key_message || ''}</textarea>
                <button type="button" id="generate-draft-btn" data-category-id={selected.id} class="mt-2 text-xs text-pink-600 hover:underline">
                  <i class="fas fa-wand-magic-sparkles mr-1"></i>AIで下書き生成
                </button>
              </div>
              <button type="submit" class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-5 py-2 rounded-lg">保存する</button>
            </form>
          </div>
          <p class="text-xs text-gray-400">
            このテンプレートを使って記事を作るには
            <a href="/blog/generate" class="text-pink-600 hover:underline">AI記事生成</a>
            画面を開いてください。
          </p>
        </div>
      ) : (
        <div class="space-y-6">
          <div class="bg-white rounded-xl border border-gray-100 p-6">
            <p class="font-semibold mb-3">
              <i class="fas fa-plus mr-2 text-pink-500"></i>新しい記事テンプレートを追加
            </p>
            <a
              href="/blog/template?new=1"
              class="inline-block bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
            >
              新しい記事テンプレートを追加する
            </a>
          </div>

          <div class="bg-white rounded-xl border border-gray-100 p-6">
            <div class="flex items-center justify-between mb-3">
              <p class="font-semibold">
                <i class="fas fa-pen mr-2 text-pink-500"></i>既存の記事テンプレートを編集
              </p>
              <span class="text-xs text-gray-400">{catList.length}/10</span>
            </div>
            {catList.length === 0 ? (
              <p class="text-sm text-gray-400">まだテンプレートがありません。上のボタンから作成してください。</p>
            ) : (
              <div class="space-y-3">
                <select id="template-edit-select" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                  <option value="" selected disabled>既存テンプレートを選ぶ</option>
                  {catList.map((cat) => (
                    <option value={cat.id}>
                      {cat.name}
                      {!cat.hpb_category_value ? '(HPB未設定)' : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  id="template-edit-open-btn"
                  disabled
                  class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  既存テンプレートを選ぶ
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <form method="post" action="/blog/template/salon-info" class="space-y-6">
        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="font-semibold mb-1">
            <i class="fas fa-shoe-prints mr-2 text-pink-500"></i>フッター設定<span class="text-xs text-gray-400 ml-2">記事ごとにON/OFFを切り替えられます(記事編集画面)</span>
          </p>
          <p class="text-xs text-gray-500 mb-3">ブログの文章の最後にサロン情報とSEOのキーワードを追加します。</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">区切り記号</label>
              <input type="text" name="footer_separator" value={profile?.footer_separator || '＊'} maxlength={1} class="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">SEO対策ワード（半角スラッシュ区切り）</label>
              <input
                type="text"
                name="footer_keywords"
                value={(JSON.parse(profile?.footer_keywords_json || '[]') as string[]).join('/')}
                placeholder="例）〇〇駅/縮毛矯正/髪質改善"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div class="flex items-center justify-between mb-1">
            <p class="text-xs font-medium text-gray-500">プレビュー（直接編集できます）</p>
            <button
              type="button"
              id="footer-reset-btn"
              class="text-xs text-pink-600 hover:underline"
            >
              自動生成に戻す
            </button>
          </div>
          <textarea
            id="footer-preview-textarea"
            name="footer_override_text"
            rows={6}
            data-auto-text={buildAutoFooterText(salon?.salon_name || null, profile)}
            data-salon-name={salon?.salon_name || ''}
            class="w-full bg-gray-50 border border-gray-100 rounded-lg p-3 text-xs text-gray-600 font-mono"
          >{footerText}</textarea>
          <p class="text-xs text-gray-400 mt-2">
            <span id="footer-preview-count">{footerText.length}文字 / 改行{footerLines}行</span>
            <span id="footer-preview-warning" class={`text-amber-600 font-semibold ml-2 ${footerText.length > 350 ? '' : 'hidden'}`}>
              ※350文字を超えています(本文の生成余地が減ります)
            </span>
          </p>
        </div>

        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="font-semibold mb-3">
            <i class="fas fa-shop mr-2 text-pink-500"></i>基本情報<span class="text-xs text-gray-400 ml-2">フッターに差し込まれます</span>
          </p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="md:col-span-2">
              <label class="block text-sm font-medium text-gray-700 mb-1">住所</label>
              <input type="text" name="address" value={profile?.address || ''} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">最寄駅</label>
              <input type="text" name="nearest_station" value={profile?.nearest_station || ''} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">徒歩</label>
              <input type="text" name="walk_minutes" value={profile?.walk_minutes || ''} placeholder="例）3分" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">営業時間</label>
              <input type="text" name="business_hours" value={profile?.business_hours || ''} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">定休日</label>
              <input type="text" name="closing_days" value={profile?.closing_days || ''} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
          </div>
        </div>

        <button type="submit" class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm">
          保存する
        </button>
      </form>

      <script src="/static/blog-template.js"></script>
    </PageLayout>,
    { title: '生成テンプレート' }
  )
})

blog.post('/blog/template/salon-info', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const fields = {
    address: String(body.address || '').trim(),
    nearest_station: String(body.nearest_station || '').trim(),
    walk_minutes: String(body.walk_minutes || '').trim(),
    business_hours: String(body.business_hours || '').trim(),
    closing_days: String(body.closing_days || '').trim(),
    footer_separator: String(body.footer_separator || '＊').trim().slice(0, 1) || '＊',
    footer_keywords_json: JSON.stringify(
      String(body.footer_keywords || '')
        .split('/')
        .map((k) => k.trim())
        .filter(Boolean)
    ),
    // 2026-08-17追記(ユーザー指定): フッタープレビューを直接編集できるように
    // した上書き列。blog-template.js側で「自動生成の内容から変更されていない
    // 場合は空文字を送る」ようにしているため、空文字ならNULLとして保存し、
    // 以後も自動生成に追従させる。
    footer_override_text: String(body.footer_override_text || '').trim() || null
  }

  // /blog/salonのPOSTハンドラと同じ理由で、この画面が担当する列(基本情報・
  // フッター)だけを更新する(ON CONFLICT DO UPDATEで相手の列には触れない)。
  await c.env.DB.prepare(
    `INSERT INTO salon_profiles (user_id, salon_id, address, nearest_station, walk_minutes, business_hours, closing_days, footer_separator, footer_keywords_json, footer_override_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (salon_id) DO UPDATE SET
       address = EXCLUDED.address, nearest_station = EXCLUDED.nearest_station, walk_minutes = EXCLUDED.walk_minutes,
       business_hours = EXCLUDED.business_hours, closing_days = EXCLUDED.closing_days,
       footer_separator = EXCLUDED.footer_separator, footer_keywords_json = EXCLUDED.footer_keywords_json,
       footer_override_text = EXCLUDED.footer_override_text,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      user.id, user.active_salon_id, fields.address, fields.nearest_station, fields.walk_minutes,
      fields.business_hours, fields.closing_days, fields.footer_separator, fields.footer_keywords_json,
      fields.footer_override_text
    )
    .run()

  return c.redirect('/blog/template?saved=1')
})

blog.post('/blog/template/categories/add', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  if (!name) return c.redirect('/blog/template')

  const countRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM blog_categories WHERE user_id = ? AND salon_id = ?')
    .bind(user.id, user.active_salon_id)
    .first<{ cnt: number }>()
  if ((countRow?.cnt || 0) >= 10) {
    return c.redirect('/blog/template')
  }
  const nextOrder = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM blog_categories WHERE user_id = ? AND salon_id = ?'
  )
    .bind(user.id, user.active_salon_id)
    .first<{ n: number }>()
  const insert = await c.env.DB.prepare(
    'INSERT INTO blog_categories (user_id, salon_id, name, sort_order) VALUES (?, ?, ?, ?)'
  )
    .bind(user.id, user.active_salon_id, name, nextOrder?.n ?? 0)
    .run()
  return c.redirect(`/blog/template?category=${insert.meta.last_row_id}`)
})

blog.post('/blog/template/categories/:id/delete', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const { results: images } = await c.env.DB.prepare(
    'SELECT image_r2_key FROM blog_articles WHERE user_id = ? AND salon_id = ? AND category_id = ? AND image_r2_key IS NOT NULL'
  )
    .bind(user.id, user.active_salon_id, id)
    .all<{ image_r2_key: string }>()
  for (const img of images || []) {
    await c.env.STYLE_IMAGES.delete(img.image_r2_key).catch(() => {})
  }
  await c.env.DB.prepare('DELETE FROM blog_categories WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .run()
  return c.redirect('/blog/template')
})

blog.post('/blog/template/categories/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()

  const seasonPairsRaw = body.season_pairs
  const seasonPairs = Array.isArray(seasonPairsRaw) ? seasonPairsRaw : seasonPairsRaw ? [seasonPairsRaw] : []
  const seasonMonths = Array.from(
    new Set(
      seasonPairs.flatMap((pair) =>
        String(pair)
          .split(',')
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12)
      )
    )
  ).sort((a, b) => a - b)

  // 2026-08-17追記(至急・アカウント跨ぎのデータ混入対策): 他サロンの
  // スタイリストIDを直接POSTされた場合にそのまま保存しないよう検証する。
  let defaultStylistId = body.default_stylist_id ? Number(body.default_stylist_id) : null
  if (defaultStylistId) {
    const owned = await c.env.DB.prepare('SELECT id FROM stylists WHERE id = ? AND user_id = ? AND salon_id = ?')
      .bind(defaultStylistId, user.id, user.active_salon_id)
      .first()
    if (!owned) defaultStylistId = null
  }

  const useReferenceArticles = body.use_reference_articles === 'on' || body.use_reference_articles === 'true'

  await c.env.DB.prepare(
    `UPDATE blog_categories SET name=?, hpb_category_value=?, default_stylist_id=?, key_message=?, body_prompt=?, season_months_json=?, use_reference_articles=?
     WHERE id=? AND user_id=? AND salon_id=?`
  )
    .bind(
      String(body.name || '').trim(),
      String(body.hpb_category_value || '').trim() || null,
      defaultStylistId,
      String(body.key_message || '').trim() || null,
      String(body.body_prompt || '').trim() || null,
      JSON.stringify(seasonMonths),
      useReferenceArticles ? 1 : 0,
      id,
      user.id,
      user.active_salon_id
    )
    .run()
  return c.redirect(`/blog/template?category=${id}`)
})

blog.post('/api/blog/categories/:id/generate-draft', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const category = await c.env.DB.prepare('SELECT name, season_months_json FROM blog_categories WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .first<{ name: string; season_months_json: string | null }>()
  if (!category) return c.json({ error: 'カテゴリが見つかりません' }, 404)

  try {
    const profile = await getSalonProfileForGeneration(c, user)
    const draft = await generateCategoryDraft(c.env, category.name, profile, parseSeasonMonths(category.season_months_json))
    return c.json({ success: true, draft })
  } catch (err: any) {
    return c.json({ error: err.message || 'AI生成に失敗しました' }, 500)
  }
})

blog.get('/blog/article/:id/image', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const owned = await c.env.DB.prepare('SELECT image_r2_key FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .first<{ image_r2_key: string | null }>()
  if (!owned?.image_r2_key) return c.notFound()

  const object = await c.env.STYLE_IMAGES.get(owned.image_r2_key)
  if (!object) return c.notFound()

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'private, max-age=86400'
    }
  })
})

// 2026-08-21追記(ユーザー指定): 本文の文字数上限はフッター込みで950文字
// (SALON BOARD側の実際の上限1000文字より少し余裕を持たせた値)。この関数は
// AI生成が使う「本文だけの」上限なので、950からフッター分の文字数を引く。
async function computeBodyMaxChars(c: AppContext, user: AppUser): Promise<number> {
  const [profile, salon] = await Promise.all([getSalonProfile(c, user), getSalonForProfile(c, user)])
  const footerText = buildFooterText(salon?.salon_name || null, profile)
  return Math.max(300, 950 - footerText.length)
}

async function generateOneArticle(
  c: AppContext,
  user: AppUser,
  category: CategoryRow,
  article: { id: number; image_description: string | null }
): Promise<void> {
  const profile = await getSalonProfileForGeneration(c, user)
  const bodyMaxChars = await computeBodyMaxChars(c, user)

  const stylistRow = category.default_stylist_id
    ? await c.env.DB.prepare('SELECT name FROM stylists WHERE id = ? AND user_id = ? AND salon_id = ?')
        .bind(category.default_stylist_id, user.id, user.active_salon_id)
        .first<{ name: string }>()
    : null

  const seasonMonths = parseSeasonMonths(category.season_months_json)

  const result = await generateArticleContent(c.env, {
    categoryName: category.name,
    keyMessage: category.key_message,
    bodyPrompt: category.body_prompt,
    imageDescription: article.image_description,
    stylistName: stylistRow?.name || null,
    couponName: null,
    bodyMaxChars,
    profile,
    seasonMonths,
    useReferenceArticles: category.use_reference_articles !== 0
  })

  // カテゴリに季節パラメータが設定されていれば、生成した記事の月タグへ
  // そのまま反映する(その月に合わせて投稿されるようにするため)。
  // 2026-08-21追記(ユーザー指摘によるバグ修正): 以前はここで無条件に
  // status='unapproved'に戻していたため、既に登録ブログ一覧に表示済み
  // (status='approved')の記事で「本文をAIで再生成」を押すと、一覧クエリが
  // status='approved'のみを表示するようになったことで記事が一覧から
  // 消えてしまう不具合になる。statusには触れず、現在の承認状態を維持する。
  await c.env.DB.prepare(
    `UPDATE blog_articles SET title=?, body=?, stylist_id=?, month_tags_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND salon_id=?`
  )
    .bind(result.title, result.body, category.default_stylist_id || null, JSON.stringify(seasonMonths), article.id, user.id, user.active_salon_id)
    .run()
}

// ---------- 3. 投稿記事一覧 ----------

// ---------- 記事編集フォーム(新規作成・編集・AI生成後の確認で共通利用) ----------

type ArticleFormDetail = {
  id: number
  title: string | null
  body: string | null
  image_r2_key: string | null
  category_id: number | null
  stylist_id: number | null
  coupon_id: number | null
  month_tags_json: string
  footer_enabled_flag: number
  auto_post_enabled_flag: number
  status: string
}

async function loadArticleFormMasters(c: AppContext, user: AppUser) {
  const [categories, stylists, coupons] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, name, hpb_category_value FROM blog_categories WHERE user_id = ? AND salon_id = ? ORDER BY sort_order ASC, id ASC'
    )
      .bind(user.id, user.active_salon_id)
      .all<{ id: number; name: string; hpb_category_value: string | null }>(),
    c.env.DB.prepare('SELECT id, name FROM stylists WHERE user_id = ? AND salon_id = ? AND is_active = 1 ORDER BY sort_order ASC')
      .bind(user.id, user.active_salon_id)
      .all<{ id: number; name: string }>(),
    c.env.DB.prepare('SELECT id, name FROM coupons WHERE user_id = ? AND salon_id = ? AND is_active = 1 ORDER BY sort_order ASC')
      .bind(user.id, user.active_salon_id)
      .all<{ id: number; name: string }>()
  ])
  return { categories: categories.results || [], stylists: stylists.results || [], coupons: coupons.results || [] }
}

function ArticleForm({
  mode,
  detail,
  categories,
  stylists,
  coupons,
  footerText,
  generatedNotice
}: {
  mode: 'new' | 'edit'
  detail: ArticleFormDetail | null
  categories: { id: number; name: string; hpb_category_value: string | null }[]
  stylists: { id: number; name: string }[]
  coupons: { id: number; name: string }[]
  footerText: string
  generatedNotice?: boolean
}) {
  const monthTags: number[] = detail ? JSON.parse(detail.month_tags_json || '[]') : []
  const submitLabel = mode === 'new' || generatedNotice ? '投稿一覧に追加' : '保存する'
  const initialBody = detail ? detail.body || '' : footerText ? `\n\n${footerText}` : ''
  const selectedCategoryHpbValue = detail?.category_id
    ? categories.find((cat) => cat.id === detail.category_id)?.hpb_category_value || ''
    : ''

  return (
    <div class="space-y-6">
      {generatedNotice && (
        <div class="bg-pink-50 border border-pink-200 text-pink-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-wand-magic-sparkles mr-2"></i>AIが記事を生成しました。内容を確認・編集して「{submitLabel}」を押してください。
        </div>
      )}

      <form
        method="post"
        action={mode === 'new' ? '/blog/articles/new' : `/blog/articles/${detail?.id}/edit`}
        enctype="multipart/form-data"
        class="space-y-6"
      >
        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="font-semibold mb-3">
            <i class="fas fa-image mr-2 text-pink-500"></i>画像
          </p>
          {detail?.image_r2_key && (
            <img src={`/blog/article/${detail.id}/image`} class="w-32 h-32 object-cover rounded-lg bg-gray-50 mb-3" />
          )}
          <label
            for="article-image-input"
            id="article-image-dropzone"
            class="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-300 rounded-xl px-4 py-10 text-center cursor-pointer hover:border-pink-400 hover:bg-pink-50 transition-colors"
          >
            <i class="fas fa-cloud-arrow-up text-3xl text-gray-300"></i>
            <span id="article-image-dropzone-label" class="text-sm font-semibold text-gray-600">タップして画像を選択</span>
            <span class="text-xs text-gray-400">{detail?.image_r2_key ? '変更する場合のみ選択してください' : 'この画像を記事に使用します'}</span>
          </label>
          <input type="file" id="article-image-input" name="image" accept="image/*" class="hidden" />
          {detail?.id && (
            <button
              type="button"
              id="article-regen-description-btn"
              data-article-id={detail.id}
              class="mt-3 text-xs text-pink-600 hover:underline disabled:opacity-50"
            >
              <i class="fas fa-wand-magic-sparkles mr-1"></i>画像の説明をAIで再生成
            </button>
          )}
        </div>

        <div class="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
          <div>
            <label id="article-title-label" class="block text-sm font-medium text-gray-700 mb-1">タイトル</label>
            <input
              type="text"
              name="title"
              id="article-title-input"
              value={detail?.title || ''}
              maxlength={25}
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <div class="flex items-center justify-between mb-1">
              <label id="article-body-label" class="block text-sm font-medium text-gray-700">本文</label>
              <span id="article-body-charcount" class="text-xs text-gray-400"></span>
            </div>
            <textarea name="body" id="article-body-textarea" rows={10} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {initialBody}
            </textarea>
            {detail?.id && (
              <button
                type="button"
                id="article-regen-body-btn"
                data-article-id={detail.id}
                class="mt-1 text-xs text-pink-600 hover:underline disabled:opacity-50"
              >
                <i class="fas fa-wand-magic-sparkles mr-1"></i>本文をAIで再生成
              </button>
            )}
          </div>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label id="article-category-label" class="block text-sm font-medium text-gray-700 mb-1">カテゴリ（HPBブログカテゴリ）</label>
              <select name="hpb_category_value" id="article-category-select" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">選択しない</option>
                {HPB_BLOG_CATEGORY_OPTIONS.map((opt) => (
                  <option value={opt} selected={selectedCategoryHpbValue === opt}>{opt}</option>
                ))}
              </select>
            </div>
            <div>
              <label id="article-stylist-label" class="block text-sm font-medium text-gray-700 mb-1">投稿者</label>
              <select name="stylist_id" id="article-stylist-select" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">選択しない</option>
                {stylists.map((st) => (
                  <option value={st.id} selected={detail?.stylist_id === st.id}>{st.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">クーポン</label>
              <select name="coupon_id" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">選択しない</option>
                {coupons.map((cp) => (
                  <option value={cp.id} selected={detail?.coupon_id === cp.id}>{cp.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              月タグ<span class="text-xs text-gray-400 ml-2">選んだ月だけ投稿対象になります(未選択なら毎月対象)</span>
            </label>
            <div class="flex flex-wrap gap-2">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <label class="flex items-center gap-1 text-sm border border-gray-200 rounded px-2 py-1">
                  <input
                    type="checkbox"
                    name="month_tags"
                    value={m}
                    checked={monthTags.includes(m)}
                    class="accent-pink-500"
                  />
                  {m}月
                </label>
              ))}
            </div>
          </div>
          <div class="flex items-center gap-6 pt-3 border-t border-gray-100">
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                id="footer-enabled-checkbox"
                name="footer_enabled"
                checked={detail ? detail.footer_enabled_flag === 1 : true}
                data-footer-text={footerText}
                class="accent-pink-500"
              />
              フッターを追加する
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="auto_post_enabled"
                checked={detail ? detail.auto_post_enabled_flag === 1 : true}
                class="accent-pink-500"
              />
              自動投稿の対象にする
            </label>
          </div>
        </div>

        <div>
          <p id="article-required-error" class="hidden text-sm text-red-600 mb-2">必須項目が設定されていません</p>
          <p id="article-charlimit-error" class="hidden text-sm text-red-600 mb-2">文字数制限(950文字)を超えています。</p>
          <div class="flex items-center gap-3">
            <button
              type="submit"
              id="article-submit-btn"
              class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitLabel}
            </button>
            <a href="/blog/articles" class="text-sm text-gray-500 hover:underline">
              一覧に戻る
            </a>
          </div>
        </div>
      </form>
    </div>
  )
}

function parseArticleForm(body: Record<string, any>) {
  const monthTagsRaw = body.month_tags
  const monthTagsList = Array.isArray(monthTagsRaw) ? monthTagsRaw : monthTagsRaw ? [monthTagsRaw] : []
  const monthTags = monthTagsList.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12)

  return {
    title: String(body.title || '').trim().slice(0, 25),
    body: String(body.body || '').trim(),
    stylistId: body.stylist_id ? Number(body.stylist_id) : null,
    couponId: body.coupon_id ? Number(body.coupon_id) : null,
    monthTags,
    footerEnabled: body.footer_enabled === 'on' || body.footer_enabled === 'true',
    autoPostEnabled: body.auto_post_enabled === 'on' || body.auto_post_enabled === 'true'
  }
}

// 2026-08-17追記(ユーザー指定): 投稿記事一覧の新規作成/編集フォームのカテゴリを、
// ユーザーが自由に名付けられるblog_categoriesではなく、生成テンプレート
// (/blog/template)の「HPBブログカテゴリ」と同じ固定ドロップダウン
// (HPB_BLOG_CATEGORY_OPTIONS)に統一する。DB上はこれまで通りblog_articles.
// category_id(blog_categoriesへのFK)で保持する設計を崩さないため、選択された
// 固定値と同じhpb_category_valueを持つblog_categories行を探し、無ければ
// (name=hpb_category_valueとして)自動作成してそのidを使う。
// 2026-08-21追記(ユーザー指定): 「必須項目(HPBブログカテゴリ)が未設定の
// 記事は自動投稿を須くOFFにする」という方針を、この画面の個別チェックに
// 頼らず全ての書き込み経路(新規作成/編集保存/AI記事生成)で保証するための
// 共通ヘルパー。category_idが指すカテゴリに実効HPBブログカテゴリが
// 無ければ、ユーザーが自動投稿チェックをONにしていても強制的にOFFで保存する。
async function categoryHasHpbValue(c: AppContext, user: AppUser, categoryId: number | null): Promise<boolean> {
  if (!categoryId) return false
  const row = await c.env.DB.prepare(
    'SELECT hpb_category_value FROM blog_categories WHERE id = ? AND user_id = ? AND salon_id = ?'
  )
    .bind(categoryId, user.id, user.active_salon_id)
    .first<{ hpb_category_value: string | null }>()
  return !!row?.hpb_category_value
}

async function resolveArticleCategoryId(c: AppContext, user: AppUser, hpbCategoryValue: string): Promise<number | null> {
  if (!hpbCategoryValue) return null

  const existing = await c.env.DB.prepare(
    'SELECT id FROM blog_categories WHERE user_id = ? AND salon_id = ? AND hpb_category_value = ?'
  )
    .bind(user.id, user.active_salon_id, hpbCategoryValue)
    .first<{ id: number }>()
  if (existing) return existing.id

  // /blog/templateと同じ上限(10件)に達している場合は新規作成できない
  // (テンプレート側で手動管理しているカテゴリ枠を自動生成で圧迫しないため)。
  const countRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM blog_categories WHERE user_id = ? AND salon_id = ?')
    .bind(user.id, user.active_salon_id)
    .first<{ cnt: number }>()
  if ((countRow?.cnt ?? 0) >= 10) return null

  const nextOrderRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM blog_categories WHERE user_id = ? AND salon_id = ?'
  )
    .bind(user.id, user.active_salon_id)
    .first<{ n: number }>()

  const insert = await c.env.DB.prepare(
    'INSERT INTO blog_categories (user_id, salon_id, name, hpb_category_value, sort_order) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(user.id, user.active_salon_id, hpbCategoryValue, hpbCategoryValue, nextOrderRow?.n ?? 0)
    .run()
  return Number(insert.meta.last_row_id)
}

// 2026-08-17追記(至急・アカウント跨ぎのデータ混入対策): stylist_id/coupon_idは
// フォームから送られてくる数値IDをそのまま保存していたため、他アカウント
// (他サロン)のIDを直接POSTされた場合にそのまま保存されてしまう
// (一覧表示や記事生成時にJOIN/SELECTで他サロンの名前が引けてしまう)。
// 保存前に必ずこのサロン自身が所有するIDかを検証し、所有していなければnullにする。
// (category_idはresolveArticleCategoryIdがuser_id/salon_idスコープ内で
// find-or-createするため、既に所有済みでこのチェックは不要)
async function sanitizeOwnedArticleRefs(
  c: AppContext,
  user: AppUser,
  parsed: { stylistId: number | null; couponId: number | null }
): Promise<void> {
  if (parsed.stylistId) {
    const owned = await c.env.DB.prepare('SELECT id FROM stylists WHERE id = ? AND user_id = ? AND salon_id = ?')
      .bind(parsed.stylistId, user.id, user.active_salon_id)
      .first()
    if (!owned) parsed.stylistId = null
  }
  if (parsed.couponId) {
    const owned = await c.env.DB.prepare('SELECT id FROM coupons WHERE id = ? AND user_id = ? AND salon_id = ?')
      .bind(parsed.couponId, user.id, user.active_salon_id)
      .first()
    if (!owned) parsed.couponId = null
  }
}

async function saveArticleImageIfProvided(c: AppContext, user: AppUser, articleId: number, body: Record<string, any>) {
  const file = body.image as File | undefined
  if (!file || !(file instanceof File) || file.size === 0) return

  const arrayBuffer = await file.arrayBuffer()
  const { buffer, contentType } = await processBlogArticleImage(arrayBuffer)
  const key = `blog/${user.id}/${Date.now()}-${crypto.randomUUID()}.jpg`
  const fileName = `${(file.name || 'blog').replace(/\.[^./\\]+$/, '')}.jpg`

  const existing = await c.env.DB.prepare('SELECT image_r2_key FROM blog_articles WHERE id = ?')
    .bind(articleId)
    .first<{ image_r2_key: string | null }>()
  if (existing?.image_r2_key) await c.env.STYLE_IMAGES.delete(existing.image_r2_key).catch(() => {})

  await c.env.STYLE_IMAGES.put(key, buffer, { httpMetadata: { contentType } })
  // 新しい画像に差し替えたら、古い画像用のAI説明文は意味を持たなくなるためクリアする
  await c.env.DB.prepare('UPDATE blog_articles SET image_r2_key = ?, image_file_name = ?, image_description = NULL WHERE id = ?')
    .bind(key, fileName, articleId)
    .run()
}

blog.get('/blog/articles/new', async (c) => {
  const user = c.get('user')
  const [{ categories, stylists, coupons }, footerText] = await Promise.all([
    loadArticleFormMasters(c, user),
    getFooterTextForSalon(c.env, user.id, user.active_salon_id)
  ])
  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}
      reviewEnabled={user.review_enabled !== 0}
      isImpersonated={user.is_impersonated === 1}
      active="blog-articles"
      salonName={user.salon_name}
      title="記事の新規作成"
      styleEnabled={user.style_enabled !== 0}
    >
      <ArticleForm mode="new" detail={null} categories={categories} stylists={stylists} coupons={coupons} footerText={footerText} />
      <script src="/static/blog-article-form.js"></script>
    </PageLayout>,
    { title: '記事の新規作成' }
  )
})

blog.post('/blog/articles/new', async (c) => {
  const user = c.get('user')
  // 2026-08-21追記(ユーザー指摘によるバグ修正の横展開): 月タグ(month_tags)は
  // 同名チェックボックスが複数あり、{ all: true }を付けないと複数選択時に
  // 最後の1件しか渡らない(Honoの既定動作)。/blog/salon/import-referencesと
  // 同じ原因のため、同じ修正をこの記事フォームにも適用する。
  const body = await c.req.parseBody({ all: true })
  const parsed = parseArticleForm(body)
  await sanitizeOwnedArticleRefs(c, user, parsed)
  const categoryId = await resolveArticleCategoryId(c, user, String(body.hpb_category_value || '').trim())
  const autoPostEnabled = parsed.autoPostEnabled && (await categoryHasHpbValue(c, user, categoryId))
  if (parsed.footerEnabled) {
    const { text: footerText, separator } = await getFooterTextAndSeparatorForSalon(c.env, user.id, user.active_salon_id)
    parsed.body = stripTrailingFooterBlock(parsed.body, footerText, separator)
  }

  const nextOrderRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM blog_articles WHERE user_id = ? AND salon_id = ?'
  )
    .bind(user.id, user.active_salon_id)
    .first<{ n: number }>()

  const insert = await c.env.DB.prepare(
    `INSERT INTO blog_articles (
       user_id, salon_id, category_id, stylist_id, coupon_id, title, body, month_tags_json,
       footer_enabled_flag, auto_post_enabled_flag, status, sort_order
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unapproved', ?)`
  )
    .bind(
      user.id, user.active_salon_id, categoryId, parsed.stylistId, parsed.couponId,
      parsed.title, parsed.body, JSON.stringify(parsed.monthTags),
      parsed.footerEnabled ? 1 : 0, autoPostEnabled ? 1 : 0, nextOrderRow?.n ?? 0
    )
    .run()

  const articleId = Number(insert.meta.last_row_id)
  await saveArticleImageIfProvided(c, user, articleId, body)

  // 2026-08-20追記(ユーザー指定バグ修正): 一覧ページへ直接戻していたため、
  // 新規作成時にアップロードした画像がその場では一切表示されなかった
  // (画像プレビューはArticleFormのdetail?.image_r2_keyに依存するため、
  // 作成直後の記事を編集画面で開き直さないと確認できない)。AI記事生成後の
  // 遷移(/blog/generate)と同じく、作成した記事の編集画面へ遷移する。
  return c.redirect(`/blog/articles/${articleId}/edit`)
})

blog.get('/blog/articles/:id/edit', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const detail = await c.env.DB.prepare(
    `SELECT id, title, body, image_r2_key, category_id, stylist_id, coupon_id, month_tags_json, footer_enabled_flag, auto_post_enabled_flag, status
     FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ?`
  )
    .bind(id, user.id, user.active_salon_id)
    .first<ArticleFormDetail>()
  if (!detail) return c.notFound()

  const [{ categories, stylists, coupons }, footerText] = await Promise.all([
    loadArticleFormMasters(c, user),
    getFooterTextForSalon(c.env, user.id, user.active_salon_id)
  ])

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}
      reviewEnabled={user.review_enabled !== 0}
      isImpersonated={user.is_impersonated === 1}
      active="blog-articles"
      salonName={user.salon_name}
      title="記事の編集"
      styleEnabled={user.style_enabled !== 0}
    >
      <ArticleForm
        mode="edit"
        detail={detail}
        categories={categories}
        stylists={stylists}
        coupons={coupons}
        footerText={footerText}
        generatedNotice={c.req.query('generated') === '1'}
      />
      <script src="/static/blog-article-form.js"></script>
    </PageLayout>,
    { title: '記事の編集' }
  )
})

blog.post('/blog/articles/:id/edit', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const existing = await c.env.DB.prepare('SELECT id, category_id FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .first<{ id: number; category_id: number | null }>()
  if (!existing) return c.notFound()

  // 2026-08-21追記(ユーザー指摘によるバグ修正の横展開): { all: true }を
  // 付けないと月タグ(month_tags)を複数チェックしても最後の1件しか渡らない。
  const body = await c.req.parseBody({ all: true })
  const parsed = parseArticleForm(body)
  await sanitizeOwnedArticleRefs(c, user, parsed)
  // 2026-08-21追記(ユーザー指摘によるバグ修正): 「カテゴリ（HPBブログカテゴリ）」欄は
  // 記事の現在のカテゴリがHPB_BLOG_CATEGORY_OPTIONSの固定値と一致しない場合(生成
  // テンプレート側でHPBブログカテゴリが未設定のカテゴリに属している記事等)、初期表示が
  // 「選択しない」になる。この状態でユーザーがこの欄に触れずタイトル・本文だけ直して
  // 保存すると、以前はresolveArticleCategoryId('')がnullを返し、記事のcategory_idが
  // 無条件にNULLへ上書きされてカテゴリ紐付けが失われていた(投稿は元々失敗する状態
  // だったが、さらに元のカテゴリとの関連も失われてしまう)。未選択のままなら既存の
  // category_idを維持し、実際に別の値を選んだ場合だけ付け替えるようにする。
  const hpbCategoryValueInput = String(body.hpb_category_value || '').trim()
  const categoryId = hpbCategoryValueInput ? await resolveArticleCategoryId(c, user, hpbCategoryValueInput) : existing.category_id
  // 2026-08-21追記(ユーザー指定): 必須項目(HPBブログカテゴリ)が未設定の
  // カテゴリに属したまま「自動投稿の対象にする」にチェックを入れて保存しても、
  // 実効HPBブログカテゴリが無ければ強制的にOFFで保存する(須くOFFの方針)。
  const autoPostEnabled = parsed.autoPostEnabled && (await categoryHasHpbValue(c, user, categoryId))

  // 2026-08-21追記(重大バグ修正): このハンドラだけ/blog/articles/newと違い
  // フッターの末尾除去を呼んでいなかった。フッター追加チェックボックスON時に
  // ブラウザ側JS(blog-article-form.js)が本文欄末尾へフッターを差し込むため、
  // それをそのまま保存するとDBのbodyにフッターが焼き込まれ、投稿時
  // (getArticleRowForJob)にもう1つ付いて二重になり、全角1000文字制限を
  // 超えて投稿に失敗していた(実機ログで確認)。
  if (parsed.footerEnabled) {
    const { text: footerText, separator } = await getFooterTextAndSeparatorForSalon(c.env, user.id, user.active_salon_id)
    parsed.body = stripTrailingFooterBlock(parsed.body, footerText, separator)
  }

  // 2026-08-21追記(ユーザー指摘によるバグ修正): 新規作成/AI生成直後の記事は
  // status='unapproved'でDBに存在するが、まだ登録ブログ一覧には出さない
  // (GET /blog/articlesがstatus='approved'のみ表示する)。この保存(「投稿一覧に
  // 追加」/「保存する」)で初めてapprovedへ確定し、一覧に反映される。
  await c.env.DB.prepare(
    `UPDATE blog_articles SET
       category_id=?, stylist_id=?, coupon_id=?, title=?, body=?, month_tags_json=?,
       footer_enabled_flag=?, auto_post_enabled_flag=?, status='approved',
       approved_at=COALESCE(approved_at, CURRENT_TIMESTAMP), updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND user_id=? AND salon_id=?`
  )
    .bind(
      categoryId, parsed.stylistId, parsed.couponId, parsed.title, parsed.body,
      JSON.stringify(parsed.monthTags), parsed.footerEnabled ? 1 : 0, autoPostEnabled ? 1 : 0,
      id, user.id, user.active_salon_id
    )
    .run()

  await saveArticleImageIfProvided(c, user, id, body)

  return c.redirect('/blog/articles?saved=1')
})

// ---------- 4. AI記事生成 ----------
// 流れ: テンプレート(記事カテゴリ)を選択→画像をアップロード→AIが1本生成→
// 記事編集フォーム(新規作成/編集と共通)へ遷移して内容を確認・編集→保存すると
// 投稿記事一覧に反映される。生成した時点でblog_articles行(status='unapproved')
// を作成するため、途中で編集画面を離れても生成結果は失われない。

blog.get('/blog/generate', async (c) => {
  const user = c.get('user')
  const { results: categories } = await c.env.DB.prepare(
    'SELECT id, name, hpb_category_value FROM blog_categories WHERE user_id = ? AND salon_id = ? ORDER BY sort_order ASC, id ASC'
  )
    .bind(user.id, user.active_salon_id)
    .all<{ id: number; name: string; hpb_category_value: string | null }>()

  const catList = categories || []
  const error = c.req.query('error')

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}
      reviewEnabled={user.review_enabled !== 0}
      isImpersonated={user.is_impersonated === 1}
      active="blog-generate"
      salonName={user.salon_name}
      title="AI記事生成"
      styleEnabled={user.style_enabled !== 0}
    >
      {error && (
        <div class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-triangle-exclamation mr-2"></i>{decodeURIComponent(error)}
        </div>
      )}

      {catList.length === 0 ? (
        <div class="bg-white rounded-xl border border-gray-100 p-6 text-sm text-gray-400">
          まだ記事カテゴリがありません。先に
          <a href="/blog/template" class="text-pink-600 hover:underline">生成テンプレート</a>
          で記事カテゴリを作成してください。
        </div>
      ) : (
        <form method="post" action="/blog/generate" enctype="multipart/form-data" class="space-y-4">
          <div class="bg-white rounded-xl border border-gray-100 p-6">
            <div class="flex items-center gap-3 mb-3">
              <span class="w-7 h-7 rounded-full bg-pink-500 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">1</span>
              <p class="font-semibold">テンプレート(記事カテゴリ)を選ぶ</p>
            </div>
            <select name="category_id" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="" selected disabled>テンプレートを選ぶ</option>
              {catList.map((cat) => (
                <option value={cat.id}>
                  {cat.name}
                  {!cat.hpb_category_value ? '(HPB未設定)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div class="bg-white rounded-xl border border-gray-100 p-6">
            <div class="flex items-center gap-3 mb-3">
              <span class="w-7 h-7 rounded-full bg-pink-500 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">2</span>
              <p class="font-semibold">画像をアップロードする</p>
            </div>
            <label
              for="blog-generate-image-input"
              id="blog-generate-dropzone"
              class="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-300 rounded-xl px-4 py-10 text-center cursor-pointer hover:border-pink-400 hover:bg-pink-50 transition-colors"
            >
              <i id="blog-generate-dropzone-icon" class="fas fa-cloud-arrow-up text-3xl text-gray-300"></i>
              <img id="blog-generate-preview" class="hidden max-h-48 rounded-lg object-contain" />
              <span id="blog-generate-dropzone-label" class="text-sm font-semibold text-gray-600">タップして画像を選択</span>
              <span class="text-xs text-gray-400">この画像の内容をAIが読み取り、記事の材料にします</span>
            </label>
            <input type="file" id="blog-generate-image-input" name="image" accept="image/*" required class="hidden" />
          </div>
          <div class="bg-white rounded-xl border border-gray-100 p-6">
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" name="footer_enabled" checked class="accent-pink-500" />
              フッターを追加する
            </label>
          </div>
          <button
            id="blog-generate-btn"
            type="submit"
            class="w-full sm:w-auto bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg"
          >
            <i class="fas fa-wand-magic-sparkles mr-1"></i>記事を生成する
          </button>
          <p id="blog-generate-status" class="text-sm text-gray-500"></p>
        </form>
      )}

      <script src="/static/blog-generate.js"></script>
    </PageLayout>,
    { title: 'AI記事生成' }
  )
})

blog.post('/blog/generate', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const footerEnabled = body.footer_enabled === 'on' || body.footer_enabled === 'true'

  const categoryId = Number(body.category_id)
  const category = await c.env.DB.prepare(
    'SELECT id, name, key_message, title_prompt, body_prompt, default_stylist_id, season_months_json, use_reference_articles, hpb_category_value FROM blog_categories WHERE id = ? AND user_id = ? AND salon_id = ?'
  )
    .bind(categoryId, user.id, user.active_salon_id)
    .first<CategoryRow>()
  if (!category) return c.redirect(`/blog/generate?error=${encodeURIComponent('記事カテゴリを選択してください')}`)

  const file = body.image as File | undefined
  if (!file || !(file instanceof File) || file.size === 0) {
    return c.redirect(`/blog/generate?error=${encodeURIComponent('画像を選択してください')}`)
  }

  const nextOrderRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM blog_articles WHERE user_id = ? AND salon_id = ?'
  )
    .bind(user.id, user.active_salon_id)
    .first<{ n: number }>()

  const arrayBuffer = await file.arrayBuffer()
  const { buffer, contentType } = await processBlogArticleImage(arrayBuffer)
  const key = `blog/${user.id}/${Date.now()}-${crypto.randomUUID()}.jpg`
  const fileName = `${(file.name || 'blog').replace(/\.[^./\\]+$/, '')}.jpg`
  await c.env.STYLE_IMAGES.put(key, buffer, { httpMetadata: { contentType } })

  try {
    const imageDescription = await generateImageDescription(c.env, Buffer.from(buffer))

    const profile = await getSalonProfileForGeneration(c, user)
    const bodyMaxChars = await computeBodyMaxChars(c, user)
    const stylistRow = category.default_stylist_id
      ? await c.env.DB.prepare('SELECT name FROM stylists WHERE id = ? AND user_id = ? AND salon_id = ?')
          .bind(category.default_stylist_id, user.id, user.active_salon_id)
          .first<{ name: string }>()
      : null
    const seasonMonths = parseSeasonMonths(category.season_months_json)

    const result = await generateArticleContent(c.env, {
      categoryName: category.name,
      keyMessage: category.key_message,
      bodyPrompt: category.body_prompt,
      imageDescription,
      stylistName: stylistRow?.name || null,
      couponName: null,
      bodyMaxChars,
      profile,
      seasonMonths,
      useReferenceArticles: category.use_reference_articles !== 0
    })

    // 2026-08-21追記(ユーザー指定): auto_post_enabled_flagは常に1固定で
    // INSERTしていたため、選択したカテゴリにHPBブログカテゴリが未設定の
    // 場合でも自動投稿ONの記事が生成され、投稿するたびに必ず失敗していた。
    // 必須項目(HPBブログカテゴリ)が未設定の記事は自動投稿を須くOFFにする
    // という方針に合わせ、カテゴリの実効HPBブログカテゴリが無ければ
    // 0で作成する。
    const insert = await c.env.DB.prepare(
      `INSERT INTO blog_articles (
         user_id, salon_id, category_id, stylist_id, image_r2_key, image_file_name, image_description,
         title, body, month_tags_json, footer_enabled_flag, auto_post_enabled_flag, status, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unapproved', ?)`
    )
      .bind(
        user.id, user.active_salon_id, categoryId, category.default_stylist_id || null, key, fileName, imageDescription,
        result.title, result.body, JSON.stringify(seasonMonths), footerEnabled ? 1 : 0,
        category.hpb_category_value ? 1 : 0, nextOrderRow?.n ?? 0
      )
      .run()

    return c.redirect(`/blog/articles/${insert.meta.last_row_id}/edit?generated=1`)
  } catch (err: any) {
    await c.env.STYLE_IMAGES.delete(key).catch(() => {})
    return c.redirect(`/blog/generate?error=${encodeURIComponent(String(err?.message || err) || 'AI生成に失敗しました')}`)
  }
})

// 登録スタイル一覧(style.tsx)のAutoPostStatusBadgesと同じ見た目で、
// 自動投稿ON/OFFと直近の投稿結果(公開/エラー)をタグ表示する。
// 2026-08-21追記(ユーザー指定): HPBブログカテゴリが未設定の記事は投稿する
// たびに必ず同じ理由で失敗するため、汎用的な「エラー」ではなく専用の警告を
// 表示する(原因と対処がひと目でわかるように)。
function BlogAutoPostStatusBadges({ a }: { a: ArticleListRow }) {
  const isOn = a.auto_post_enabled_flag === 1
  const hpbCategoryMissing = !a.hpb_category_value
  return (
    <>
      <span
        class={
          'text-xs px-2 py-0.5 rounded font-semibold ' + (isOn ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-400')
        }
      >
        自動投稿{isOn ? 'ON' : 'OFF'}
      </span>
      {hpbCategoryMissing ? (
        <span class="text-xs px-2 py-0.5 rounded font-semibold bg-amber-50 text-amber-600">
          「HPBブログカテゴリ」が未設定です
        </span>
      ) : (
        <>
          {a.last_posted_at && !a.last_error && (
            <span class="text-xs px-2 py-0.5 rounded font-semibold bg-green-50 text-green-600">公開</span>
          )}
          {a.last_error && <span class="text-xs px-2 py-0.5 rounded font-semibold bg-red-50 text-red-600">エラー</span>}
        </>
      )}
    </>
  )
}

type ArticleListRow = {
  id: number
  no: number
  title: string | null
  image_r2_key: string | null
  category_id: number | null
  stylist_name: string | null
  coupon_name: string | null
  month_tags_json: string
  last_posted_at: string | null
  post_count: number
  auto_post_enabled_flag: number
  last_error: string | null
  hpb_category_value: string | null
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

function jstNow(): Date {
  return new Date(Date.now() + JST_OFFSET_MS)
}

// 2026-08-21追記(ユーザー指摘によるバグ修正): 新規作成/AI生成は途中で編集
// 画面を離れても内容を失わないよう生成時点でDBへINSERTする(status='unapproved')
// 設計だが、この一覧クエリがstatusを見ていなかったため、ユーザーが「投稿一覧に
// 追加」を押す前(=まだ内容を確認・編集している最中)の記事までここに表示されて
// しまっていた。status='approved'(POST /blog/articles/:id/editの保存時に確定)
// のものだけを表示する。
blog.get('/blog/articles', async (c) => {
  const user = c.get('user')

  const { results: categoryOptions } = await c.env.DB.prepare(
    'SELECT id, name FROM blog_categories WHERE user_id = ? AND salon_id = ? ORDER BY sort_order ASC, id ASC'
  )
    .bind(user.id, user.active_salon_id)
    .all<{ id: number; name: string }>()

  const { results: rows } = await c.env.DB.prepare(
    `SELECT
       ROW_NUMBER() OVER (ORDER BY a.sort_order ASC, a.id ASC) AS no,
       a.id, a.title, a.image_r2_key, a.month_tags_json, a.last_posted_at, a.post_count,
       a.auto_post_enabled_flag, a.category_id, a.last_error,
       st.name AS stylist_name, cp.name AS coupon_name, bc.hpb_category_value
     FROM blog_articles a
     LEFT JOIN stylists st ON st.id = a.stylist_id AND st.user_id = a.user_id AND st.salon_id = a.salon_id
     LEFT JOIN coupons cp ON cp.id = a.coupon_id AND cp.user_id = a.user_id AND cp.salon_id = a.salon_id
     LEFT JOIN blog_categories bc ON bc.id = a.category_id AND bc.user_id = a.user_id AND bc.salon_id = a.salon_id
     WHERE a.user_id = ? AND a.salon_id = ? AND a.status = 'approved'
     ORDER BY a.sort_order ASC, a.id ASC`
  )
    .bind(user.id, user.active_salon_id)
    .all<ArticleListRow>()

  const articles = rows || []

  // 2026-08-21追記(ユーザー指定): HPBブログカテゴリが未設定のまま自動投稿ONに
  // なっている記事は、設定を直すまで投稿するたびに必ず同じ理由で失敗し続ける
  // (プロキシ不調等の一過性の失敗とは異なる)。この一覧を開いた時点で検知し、
  // 実際に投稿(Fargateタスク起動)されてしまう前に自動投稿をOFFへ倒す
  // (automation.tsx側の投稿失敗時の自動OFFは、この一覧を開く前に投稿タイミングが
  // 来てしまった場合の保険として引き続き残す)。
  const needsAutoPostOff = articles.filter((a) => a.auto_post_enabled_flag === 1 && !a.hpb_category_value)
  if (needsAutoPostOff.length > 0) {
    await c.env.DB.prepare(
      `UPDATE blog_articles SET auto_post_enabled_flag = 0, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND salon_id = ? AND id IN (${needsAutoPostOff.map(() => '?').join(',')})`
    )
      .bind(user.id, user.active_salon_id, ...needsAutoPostOff.map((a) => a.id))
      .run()
    for (const a of needsAutoPostOff) a.auto_post_enabled_flag = 0
  }

  const now = jstNow()

  // 投稿順(生成順=sort_order)を1日1本で巡回した場合の簡易シミュレーション
  // (Phase 2で実際の自動投稿を実装するまでは、あくまで見込み表示)。
  // 自動投稿ONの記事だけを対象に生成順で巡回し、各日について
  // その月に合う(月タグが空、またはその日の月を含む)記事をカーソル位置から
  // 探して割り当てる。合う記事が無い日はスキップとして表示する。
  const postable = articles.filter((a) => a.auto_post_enabled_flag === 1)
  const calendarDays: { dateLabel: string; article: ArticleListRow | null; skipReason: string | null }[] = []
  const previewDays = 14
  let cursor = 0
  for (let i = 0; i < previewDays; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const dateLabel = `${String(d.getFullYear()).slice(-2)}/${d.getMonth() + 1}/${d.getDate()}`
    const month = d.getMonth() + 1

    if (postable.length === 0) {
      calendarDays.push({ dateLabel, article: null, skipReason: '自動投稿ONの記事がありません' })
      continue
    }

    let matchIndex = -1
    for (let k = 0; k < postable.length; k++) {
      const idx = (cursor + k) % postable.length
      const monthTags: number[] = JSON.parse(postable[idx].month_tags_json || '[]')
      if (monthTags.length === 0 || monthTags.includes(month)) {
        matchIndex = idx
        break
      }
    }

    if (matchIndex === -1) {
      calendarDays.push({ dateLabel, article: null, skipReason: `${month}月に合う記事がありません` })
    } else {
      calendarDays.push({ dateLabel, article: postable[matchIndex], skipReason: null })
      cursor = matchIndex + 1
    }
  }

  // 投稿済タブ: 過去に投稿したことがある記事(last_posted_at設定済み)を、
  // 最新の投稿日時順(新しい順)に並べる。
  const postedArticles = [...articles]
    .filter((a) => a.last_posted_at)
    .sort((a, b) => (a.last_posted_at! < b.last_posted_at! ? 1 : a.last_posted_at! > b.last_posted_at! ? -1 : 0))

  return c.render(
    <PageLayout seoEnabled={user.seo_enabled !== 0} reviewEnabled={user.review_enabled !== 0} isImpersonated={user.is_impersonated === 1} active="blog-articles" salonName={user.salon_name} title="登録ブログ" styleEnabled={user.style_enabled !== 0}>
      <div class="flex gap-2 border-b border-gray-100">
        <button type="button" class="blog-tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-pink-500 text-pink-600" data-tab="list">一覧</button>
        <button type="button" class="blog-tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-gray-400" data-tab="calendar">投稿予定</button>
        <button type="button" class="blog-tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-gray-400" data-tab="posted">投稿済</button>
      </div>

      <div data-tab-panel="list">
        <div class="mb-3 space-y-2">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <a
              href="/blog/articles/new"
              class="order-1 sm:order-2 bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-4 py-2 rounded-lg whitespace-nowrap text-center flex-shrink-0"
            >
              <i class="fas fa-plus mr-1"></i>新規作成
            </a>
            <div class="order-2 sm:order-1 flex items-center gap-2 overflow-x-auto min-w-0">
              <select id="blog-filter-select" class="h-10 flex-shrink-0 text-sm font-semibold text-gray-600 border border-gray-300 rounded-lg px-3">
                <option value="all">すべて</option>
                <option value="on">ONのみ</option>
                <option value="off">OFFのみ</option>
              </select>
              <select id="blog-category-filter" class="h-10 flex-shrink-0 text-xs border border-gray-200 rounded-lg px-2">
                <option value="">すべての記事カテゴリ</option>
                {(categoryOptions || []).map((cat) => (
                  <option value={cat.id}>{cat.name}</option>
                ))}
              </select>
              <select id="blog-sort-select" class="h-10 flex-shrink-0 text-xs border border-gray-200 rounded-lg px-2">
                <option value="generated">生成順に表示</option>
                <option value="season">季節柄でソート</option>
              </select>
            </div>
          </div>
        </div>

        <div class="bg-white rounded-xl border border-gray-100 p-6">
          {articles.length > 0 && (
            <div class="hidden md:flex items-center gap-4 pb-2 border-b border-gray-100 text-xs font-semibold text-gray-400">
              <span class="w-10 flex-shrink-0 text-center">No</span>
              <span class="w-5 flex-shrink-0 text-center" title="自動投稿の対象">自動</span>
              <span class="w-20 flex-shrink-0">画像</span>
              <span class="flex-1 min-w-0">記事タイトル</span>
              <span class="flex-shrink-0">操作</span>
            </div>
          )}
          {articles.length === 0 ? (
            <p class="text-sm text-gray-400 text-center py-10">
              まだ記事がありません。「新規作成」または「AI記事生成」から追加してください。
            </p>
          ) : (
            <div id="blog-article-list" class="divide-y divide-gray-100">
              {articles.map((a) => (
                <div
                  class="flex items-center gap-2 md:gap-4 py-1.5 md:py-3"
                  data-article-id={a.id}
                  data-auto-post={a.auto_post_enabled_flag === 1 ? '1' : '0'}
                  data-category-id={a.category_id ?? ''}
                  data-month-tags={a.month_tags_json || '[]'}
                  data-hpb-category-missing={a.hpb_category_value ? '0' : '1'}
                >
                  <div class="flex flex-col items-center gap-1 flex-shrink-0 md:flex-row md:gap-4">
                    <input
                      type="number"
                      min="1"
                      value={a.no}
                      class="blog-order-input w-6 h-6 flex-shrink-0 text-center text-xs text-gray-600 border border-gray-300 rounded [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      data-article-id={a.id}
                    />
                    <input
                      type="checkbox"
                      class="blog-auto-post-toggle w-6 h-6 accent-pink-500 cursor-pointer flex-shrink-0"
                      data-article-id={a.id}
                      checked={a.auto_post_enabled_flag === 1}
                      title="自動投稿の対象"
                    />
                  </div>
                  {a.image_r2_key ? (
                    <img src={`/blog/article/${a.id}/image`} class="w-10 h-14 md:w-16 md:h-16 object-cover rounded-lg bg-gray-50 border border-gray-200 flex-shrink-0" />
                  ) : (
                    <div class="w-10 h-14 md:w-16 md:h-16 bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-center text-gray-300 flex-shrink-0">
                      <i class="fas fa-image text-xl"></i>
                    </div>
                  )}
                  <div class="flex-1 min-w-0">
                    <a
                      href={`/blog/articles/${a.id}/edit`}
                      class="block text-xs line-clamp-2 md:line-clamp-none md:truncate md:text-base font-medium text-gray-700 hover:text-pink-600"
                    >
                      {a.title || '（未生成）'}
                    </a>
                    <p class="text-xs text-gray-400 flex gap-2 flex-wrap mt-0.5">
                      <span>{a.stylist_name || '-'}</span>
                      {a.last_posted_at && <span>最終投稿 {formatJstDateCompact(a.last_posted_at)}(投稿{a.post_count}回)</span>}
                    </p>
                    <div class="flex flex-wrap gap-1 mt-1">
                      <BlogAutoPostStatusBadges a={a} />
                    </div>
                  </div>
                  <div class="flex flex-col md:flex-row items-stretch md:items-center gap-1 md:gap-2 flex-shrink-0">
                    <a
                      href={`/blog/articles/${a.id}/edit`}
                      class="text-xs font-semibold text-gray-500 hover:text-pink-600 border border-gray-300 rounded w-8 h-8 md:w-auto md:h-auto flex items-center justify-center md:px-3 md:py-1.5"
                    >
                      <i class="fas fa-pen md:mr-1"></i>
                      <span class="hidden md:inline">編集</span>
                    </a>
                    <button
                      type="button"
                      class="blog-delete-btn text-xs font-semibold text-red-500 hover:bg-red-50 border border-red-200 rounded w-8 h-8 md:w-auto md:h-auto flex items-center justify-center md:px-3 md:py-1.5"
                      data-article-id={a.id}
                      title="削除"
                    >
                      <i class="fas fa-xmark md:mr-1"></i>
                      <span class="hidden md:inline">削除</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div data-tab-panel="calendar" class="hidden">
        <div class="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
          {calendarDays.map((d) => (
            <div class={'flex items-center gap-3 px-4 py-3 text-sm ' + (d.skipReason ? 'bg-amber-50' : '')}>
              <span class="w-16 text-xs text-gray-400 font-mono">{d.dateLabel}</span>
              <span class="flex-1 min-w-0 truncate">
                {d.skipReason ? (
                  <span class="text-amber-700">投稿されません</span>
                ) : d.article ? (
                  <a href={`/blog/articles/${d.article.id}/edit`} class="text-pink-600 underline decoration-pink-300 underline-offset-2 hover:text-pink-700 hover:decoration-pink-600">
                    {d.article.title || '（未生成）'}
                  </a>
                ) : (
                  '-'
                )}
              </span>
              {d.skipReason ? (
                <span class="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">{d.skipReason}</span>
              ) : (
                <span class="text-xs px-2 py-0.5 rounded bg-green-50 text-green-600">投稿予定</span>
              )}
            </div>
          ))}
        </div>
        <p class="text-xs text-gray-400 mt-2">
          ※Phase 1では実際の自動投稿はまだ行われません。自動投稿ONの記事を投稿順に1日1本ずつ投稿した場合の見込みを表示しています。
        </p>
      </div>

      <div data-tab-panel="posted" class="hidden">
        <div class="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
          {postedArticles.length === 0 ? (
            <p class="text-sm text-gray-400 text-center py-10">まだ投稿済みの記事がありません</p>
          ) : (
            postedArticles.map((a) => (
              <div class="flex items-center gap-3 px-4 py-3 text-sm">
                <span class="w-24 flex-shrink-0 text-xs text-gray-400 font-mono">{formatJstDateCompact(a.last_posted_at!)}</span>
                <a href={`/blog/articles/${a.id}/edit`} class="flex-1 min-w-0 truncate text-pink-600 hover:text-pink-700">
                  {a.title || '（未生成）'}
                </a>
                <span class="text-xs text-gray-400 flex-shrink-0">投稿{a.post_count}回</span>
              </div>
            ))
          )}
        </div>
      </div>

      <script src="/static/blog-articles.js"></script>
    </PageLayout>,
    { title: '登録ブログ' }
  )
})

// ブログ自動投稿(SALON BOARDへの実投稿)のワークスペース単位ON/OFF。
// 行が無い(初めてこのページを開いた)場合はOFF扱いで、明示的にONにする
// までは自動投稿されない(ユーザー指定: 初回は必ずOFF)。
blog.post('/blog/articles/schedule', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const enabled = body.enabled === 'on' || body.enabled === 'true'

  await c.env.DB.prepare(
    `INSERT INTO blog_post_schedules (user_id, salon_id, enabled)
     VALUES (?, ?, ?)
     ON CONFLICT (salon_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(user.id, user.active_salon_id, enabled ? 1 : 0)
    .run()

  return c.redirect('/settings/auto-update')
})

blog.post('/api/blog/articles/reset-stuck-jobs', async (c) => {
  const user = c.get('user')
  const count = await resetStuckBlogJobsForUser(c.env, user.id, user.active_salon_id)
  return c.json({ success: true, count })
})

blog.post('/api/blog/articles/toggle-auto-post', async (c) => {
  const user = c.get('user')
  const { articleId, enabled } = await c.req.json<{ articleId: number; enabled: boolean }>()

  // 2026-08-21追記(ユーザー指定): HPBブログカテゴリ未設定の記事は投稿する
  // たびに必ず失敗するため、ONへの切り替え自体を拒否する(クライアント側
  // (blog-articles.js)にも同じ判定があるが、こちらはその保険)。
  if (enabled) {
    const row = await c.env.DB.prepare(
      `SELECT bc.hpb_category_value
       FROM blog_articles a
       LEFT JOIN blog_categories bc ON bc.id = a.category_id AND bc.user_id = a.user_id AND bc.salon_id = a.salon_id
       WHERE a.id = ? AND a.user_id = ? AND a.salon_id = ?`
    )
      .bind(articleId, user.id, user.active_salon_id)
      .first<{ hpb_category_value: string | null }>()
    if (!row?.hpb_category_value) {
      return c.json({ success: false, error: '「HPBブログカテゴリ」が未設定です。設定されていないと投稿ができません。' }, 400)
    }
  }

  await c.env.DB.prepare(
    'UPDATE blog_articles SET auto_post_enabled_flag = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND salon_id = ?'
  )
    .bind(enabled ? 1 : 0, articleId, user.id, user.active_salon_id)
    .run()

  return c.json({ success: true })
})

blog.post('/blog/articles/:id/delete', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const article = await c.env.DB.prepare('SELECT image_r2_key FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .first<{ image_r2_key: string | null }>()
  if (!article) return c.json({ success: false, error: '記事が見つかりません' }, 404)

  if (article.image_r2_key) await c.env.STYLE_IMAGES.delete(article.image_r2_key).catch(() => {})
  await c.env.DB.prepare('DELETE FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .run()
  return c.json({ success: true })
})

// No.欄の手入力・ドラッグ並べ替え用(style.tsxの/api/style/reorderと同じ方式)。
// 対象記事を指定位置(1始まり)へ移動し、残りをsort_orderへ連番で書き戻す。
blog.post('/api/blog/articles/reorder', async (c) => {
  const user = c.get('user')
  const { articleId, newPosition } = await c.req.json<{ articleId: number; newPosition: number }>()

  const { results } = await c.env.DB.prepare(
    'SELECT id FROM blog_articles WHERE user_id = ? AND salon_id = ? ORDER BY sort_order ASC, id ASC'
  )
    .bind(user.id, user.active_salon_id)
    .all<{ id: number }>()

  const ids = (results || []).map((r) => r.id)
  const currentIndex = ids.indexOf(articleId)
  if (currentIndex === -1) {
    return c.json({ success: false, error: '対象の記事が見つかりません' }, 404)
  }

  ids.splice(currentIndex, 1)
  const targetIndex = Math.min(Math.max(Math.trunc(newPosition) - 1, 0), ids.length)
  ids.splice(targetIndex, 0, articleId)

  for (let i = 0; i < ids.length; i++) {
    await c.env.DB.prepare(
      'UPDATE blog_articles SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND salon_id = ?'
    )
      .bind(i, ids[i], user.id, user.active_salon_id)
      .run()
  }

  return c.json({ success: true })
})

blog.post('/api/blog/articles/:id/regenerate-description', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const article = await c.env.DB.prepare('SELECT image_r2_key FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .first<{ image_r2_key: string | null }>()
  if (!article?.image_r2_key) return c.json({ error: '画像が見つかりません' }, 404)

  try {
    const obj = await c.env.STYLE_IMAGES.get(article.image_r2_key)
    if (!obj) return c.json({ error: '画像が見つかりません' }, 404)
    const buf = Buffer.from(await obj.arrayBuffer())
    const description = await generateImageDescription(c.env, buf)
    await c.env.DB.prepare('UPDATE blog_articles SET image_description = ? WHERE id = ? AND user_id = ? AND salon_id = ?')
      .bind(description, id, user.id, user.active_salon_id)
      .run()
    return c.json({ success: true, description })
  } catch (err: any) {
    return c.json({ error: err.message || 'AI生成に失敗しました' }, 500)
  }
})

blog.post('/api/blog/articles/:id/regenerate-body', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const article = await c.env.DB.prepare(
    'SELECT category_id, image_description FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ?'
  )
    .bind(id, user.id, user.active_salon_id)
    .first<{ category_id: number | null; image_description: string | null }>()
  if (!article) return c.json({ error: '記事が見つかりません' }, 404)
  if (!article.category_id) return c.json({ error: 'カテゴリが設定されていません' }, 400)

  const category = await c.env.DB.prepare(
    'SELECT id, name, key_message, title_prompt, body_prompt, default_stylist_id, season_months_json, use_reference_articles FROM blog_categories WHERE id = ? AND user_id = ? AND salon_id = ?'
  )
    .bind(article.category_id, user.id, user.active_salon_id)
    .first<CategoryRow>()
  if (!category) return c.json({ error: 'カテゴリが見つかりません' }, 404)

  try {
    await generateOneArticle(c, user, category, { id, image_description: article.image_description })
    const updated = await c.env.DB.prepare('SELECT title, body FROM blog_articles WHERE id = ?').bind(id).first<{ title: string; body: string }>()
    return c.json({ success: true, ...updated })
  } catch (err: any) {
    return c.json({ error: err.message || 'AI生成に失敗しました' }, 500)
  }
})

export default blog
