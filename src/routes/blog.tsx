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
import { buildFooterText } from '../lib/blog-footer'
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
  salonboard_synced_at: string | null
}

async function getSalonProfile(c: AppContext, user: AppUser): Promise<SalonProfileRow | null> {
  return c.env.DB.prepare(
    `SELECT concept, target_customer, writing_tone, ng_words, address, nearest_station, walk_minutes,
            business_hours, closing_days, strengths, price_range, reference_text, first_person,
            sentence_ending, footer_separator, footer_keywords_json, salonboard_synced_at
     FROM salon_profiles WHERE user_id = ? AND salon_id = ?`
  )
    .bind(user.id, user.active_salon_id)
    .first<SalonProfileRow>()
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
  const [profile, salon] = await Promise.all([getSalonProfile(c, user), getSalonForProfile(c, user)])
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
    reference_text: profile.reference_text
  }
}

// ---------- 1. サロン基本情報 ----------

blog.get('/blog/salon', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')
  const profile = await getSalonProfile(c, user)

  return c.render(
    <PageLayout seoEnabled={user.seo_enabled !== 0} reviewEnabled={user.review_enabled !== 0} active="blog-salon" salonName={user.salon_name} title="サロン基本情報" styleEnabled={user.style_enabled !== 0}>
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>保存しました
        </div>
      )}

      <form method="post" action="/blog/salon" class="space-y-6">
        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="font-semibold mb-3">
            <i class="fas fa-heart mr-2 text-pink-500"></i>サロンの人格<span class="text-xs text-gray-400 ml-2">AI生成の材料になります</span>
          </p>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">コンセプト</label>
              <textarea name="concept" rows={2} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">{profile?.concept || ''}</textarea>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">得意なこと・強み</label>
              <textarea name="strengths" rows={2} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">{profile?.strengths || ''}</textarea>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">来てくれる人（読み手）</label>
                <textarea name="target_customer" rows={2} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">{profile?.target_customer || ''}</textarea>
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">価格帯</label>
                <input type="text" name="price_range" value={profile?.price_range || ''} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
            </div>
          </div>
        </div>

        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="font-semibold mb-3">
            <i class="fas fa-pen mr-2 text-pink-500"></i>書き方
          </p>
          <div class="mb-4">
            <label class="block text-sm font-medium text-gray-700 mb-1">
              参考文章<span class="text-xs text-gray-400 ml-2">生成テンプレートで「参考文章を参照」を選んだ場合に使われます</span>
            </label>
            <textarea name="reference_text" rows={4} placeholder="お手本にしたい過去のブログ記事などを貼り付けてください" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">{profile?.reference_text || ''}</textarea>
          </div>
          <p class="text-sm font-medium text-gray-700 mb-2">文体パラメータ</p>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">一人称</label>
              <input type="text" name="first_person" value={profile?.first_person || ''} placeholder="例）私たち" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">語尾</label>
              <input type="text" name="sentence_ending" value={profile?.sentence_ending || ''} placeholder="例）です・ます" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">文体・トーン</label>
              <input type="text" name="writing_tone" value={profile?.writing_tone || ''} placeholder="例）カジュアル・親しみやすい" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
          </div>
          <div class="mt-4">
            <label class="block text-sm font-medium text-gray-700 mb-1">NGワード・避けたい表現（任意）</label>
            <input type="text" name="ng_words" value={profile?.ng_words || ''} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
        </div>

        <button type="submit" class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm">
          保存する
        </button>
      </form>
      <p class="text-xs text-gray-400">
        住所・営業時間などの基本情報とフッター設定は
        <a href="/blog/template" class="text-pink-600 hover:underline">生成テンプレート</a>
        画面に移動しました。
      </p>

    </PageLayout>,
    { title: 'サロン基本情報' }
  )
})

blog.post('/blog/salon', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const fields = {
    concept: String(body.concept || '').trim(),
    strengths: String(body.strengths || '').trim(),
    target_customer: String(body.target_customer || '').trim(),
    price_range: String(body.price_range || '').trim(),
    reference_text: String(body.reference_text || '').trim(),
    first_person: String(body.first_person || '').trim(),
    sentence_ending: String(body.sentence_ending || '').trim(),
    writing_tone: String(body.writing_tone || '').trim(),
    ng_words: String(body.ng_words || '').trim()
  }

  // 2026-08-16追記(ブログ機能再設計): このページは「サロンの人格」「書き方」の
  // 列だけを更新する。「基本情報」「フッター」は/blog/templateページ側の
  // POSTハンドラが担当し、同じsalon_profiles行の別の列を更新するため、
  // ON CONFLICT DO UPDATEで自分が担当する列だけを書き換え、相手の列には触れない。
  await c.env.DB.prepare(
    `INSERT INTO salon_profiles (user_id, salon_id, concept, strengths, target_customer, price_range, reference_text, first_person, sentence_ending, writing_tone, ng_words)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (salon_id) DO UPDATE SET
       concept = EXCLUDED.concept, strengths = EXCLUDED.strengths, target_customer = EXCLUDED.target_customer,
       price_range = EXCLUDED.price_range, reference_text = EXCLUDED.reference_text, first_person = EXCLUDED.first_person,
       sentence_ending = EXCLUDED.sentence_ending, writing_tone = EXCLUDED.writing_tone, ng_words = EXCLUDED.ng_words,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      user.id, user.active_salon_id, fields.concept, fields.strengths, fields.target_customer,
      fields.price_range, fields.reference_text, fields.first_person, fields.sentence_ending,
      fields.writing_tone, fields.ng_words
    )
    .run()

  return c.redirect('/blog/salon?saved=1')
})

// サロンボード同期(既存の/api/settings/sync-stylists-coupons、dashboard.tsx参照)を
// 呼び出した後にこの画面から叩く、最終取得日時の記録のみを行う軽量エンドポイント。
// 同期の実処理(ブラウザ起動・ログイン・スクレイピング)自体は既存エンドポイントを再利用し、
// 二重実装を避ける(public/static/blog-salon.js参照)。
blog.post('/blog/salon/mark-synced', async (c) => {
  const user = c.get('user')
  const existing = await c.env.DB.prepare('SELECT id FROM salon_profiles WHERE user_id = ? AND salon_id = ?')
    .bind(user.id, user.active_salon_id)
    .first()
  if (existing) {
    await c.env.DB.prepare(
      'UPDATE salon_profiles SET salonboard_synced_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_id = ?'
    )
      .bind(user.id, user.active_salon_id)
      .run()
  } else {
    await c.env.DB.prepare(
      'INSERT INTO salon_profiles (user_id, salon_id, salonboard_synced_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
    )
      .bind(user.id, user.active_salon_id)
      .run()
  }
  return c.json({ success: true })
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
  style_mode: string | null
  season_months_json: string | null
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

const STYLE_MODE_LABEL: Record<string, string> = {
  scraped: '過去のブログ記事を参照（未実装のため、当面はパラメータのみで生成されます）',
  reference: '参考文章を参照（サロン基本情報の「参考文章」）',
  params: '文体パラメータのみを使用（一人称・語尾・文体・トーン）'
}

const ARTICLE_STATUS_LABEL: Record<string, string> = {
  pending_generation: '未生成',
  generating: '生成中',
  unapproved: '未承認',
  approved: '承認済み',
  posting_failed: '投稿失敗'
}

blog.get('/blog/template', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')

  const { results: categories } = await c.env.DB.prepare(
    `SELECT id, name, is_active, sort_order, hpb_category_value, default_stylist_id, key_message, title_prompt, body_prompt, style_mode, season_months_json
     FROM blog_categories WHERE user_id = ? AND salon_id = ? ORDER BY sort_order ASC, id ASC`
  )
    .bind(user.id, user.active_salon_id)
    .all<CategoryRow>()

  const catList = categories || []
  const selectedId = Number(c.req.query('category')) || catList[0]?.id || 0
  const selected = catList.find((cat) => cat.id === selectedId) || null

  const { results: stylists } = await c.env.DB.prepare(
    'SELECT id, name FROM stylists WHERE user_id = ? AND salon_id = ? AND is_active = 1 ORDER BY sort_order ASC'
  )
    .bind(user.id, user.active_salon_id)
    .all<{ id: number; name: string }>()

  const [profile, salon] = await Promise.all([getSalonProfile(c, user), getSalonForProfile(c, user)])
  const footerText = buildFooterText(salon?.salon_name || null, profile)
  const footerLines = footerText ? footerText.split('\n').length : 0

  return c.render(
    <PageLayout seoEnabled={user.seo_enabled !== 0} reviewEnabled={user.review_enabled !== 0} active="blog-template" salonName={user.salon_name} title="生成テンプレート" styleEnabled={user.style_enabled !== 0}>
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>保存しました
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6 flex items-center gap-4 flex-wrap">
        <div class="flex-1 min-w-[240px]">
          <p class="font-semibold text-sm">サロンボードから読み込む</p>
          <p class="text-xs text-gray-400 mt-1">スタイリスト・クーポン・サロン名を取得します(住所等は現時点では手動入力です)</p>
          <p class="text-xs text-gray-400 mt-1">
            最終取得: {profile?.salonboard_synced_at || '未取得'}
          </p>
        </div>
        <button id="blog-salon-sync-btn" class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">
          読み込む
        </button>
        <p id="blog-salon-sync-status" class="text-sm text-gray-500 w-full"></p>
      </div>

      <form method="post" action="/blog/template/salon-info" class="space-y-6">
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

        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="font-semibold mb-3">
            <i class="fas fa-shoe-prints mr-2 text-pink-500"></i>フッター<span class="text-xs text-gray-400 ml-2">記事ごとにON/OFFを切り替えられます(記事編集画面)</span>
          </p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">区切り記号</label>
              <input type="text" name="footer_separator" value={profile?.footer_separator || '＊'} maxlength={1} class="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">検索されたい言葉（カンマ区切り）</label>
              <input
                type="text"
                name="footer_keywords"
                value={(JSON.parse(profile?.footer_keywords_json || '[]') as string[]).join(', ')}
                placeholder="例）〇〇駅, 縮毛矯正, 髪質改善"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>
          <p class="text-xs font-medium text-gray-500 mb-1">プレビュー</p>
          <pre class="bg-gray-50 border border-gray-100 rounded-lg p-3 text-xs text-gray-600 whitespace-pre-wrap">{footerText || '（サロン名・住所等を入力すると表示されます）'}</pre>
          <p class="text-xs text-gray-400 mt-2">
            {footerText.length}文字 / 改行{footerLines}行
            {footerText.length > 350 && <span class="text-amber-600 font-semibold ml-2">※350文字を超えています(本文の生成余地が減ります)</span>}
          </p>
        </div>

        <button type="submit" class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm">
          保存する
        </button>
      </form>

      <div class="flex gap-6 flex-col lg:flex-row">
        <div class="bg-white rounded-xl border border-gray-100 lg:w-64 flex-none">
          <div class="p-4 border-b border-gray-100 flex items-center justify-between">
            <p class="font-semibold text-sm">記事カテゴリ</p>
            <span class="text-xs text-gray-400">{catList.length}/10</span>
          </div>
          <div class="divide-y divide-gray-50">
            {catList.length === 0 && <p class="text-sm text-gray-400 p-4">まだありません</p>}
            {catList.map((cat) => (
              <a
                href={`/blog/template?category=${cat.id}`}
                class={`flex items-center justify-between gap-2 px-4 py-3 text-sm ${cat.id === selectedId ? 'bg-pink-50 text-pink-700 font-semibold' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                <span class="truncate">{cat.name}</span>
                {!cat.hpb_category_value && (
                  <span
                    class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 flex-none"
                    title="HPBブログカテゴリが未設定のため、このカテゴリの記事はSALON BOARDへ自動投稿できません"
                  >
                    HPB未設定
                  </span>
                )}
              </a>
            ))}
          </div>
          {catList.length < 10 && (
            <form method="post" action="/blog/template/categories/add" class="p-3 border-t border-gray-100 flex gap-2">
              <input type="text" name="name" required placeholder="新しい記事カテゴリ名" class="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
              <button type="submit" class="bg-gray-800 hover:bg-gray-900 text-white text-xs font-semibold px-3 py-1.5 rounded-lg">追加</button>
            </form>
          )}
        </div>

        {!selected ? (
          <div class="flex-1 bg-white rounded-xl border border-gray-100 p-6 text-sm text-gray-400">
            左の入力欄から記事カテゴリを追加してください。
          </div>
        ) : (
          <div class="flex-1 space-y-6 min-w-0">
            <div class="bg-white rounded-xl border border-gray-100 p-6">
              <div class="flex items-center justify-between mb-3">
                <p class="font-semibold">
                  <i class="fas fa-tag mr-2 text-pink-500"></i>この記事カテゴリについて
                </p>
                <form method="post" action={`/blog/template/categories/${selected.id}/delete`} onsubmit="return confirm('このカテゴリと未承認の記事を削除します。よろしいですか？')">
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
                  <label class="block text-sm font-medium text-gray-700 mb-1">文章スタイル</label>
                  <select name="style_mode" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                    {(['params', 'reference', 'scraped'] as const).map((mode) => (
                      <option value={mode} selected={(selected.style_mode || 'params') === mode}>
                        {STYLE_MODE_LABEL[mode]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">
                    季節柄<span class="text-xs text-gray-400 ml-2">選んだ月ごろの内容として生成され、その記事の投稿予定月にもなります</span>
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
                    伝えたいこと<span class="text-xs text-gray-400 ml-2">記事の中身になります</span>
                  </label>
                  <textarea id="key-message-input" name="key_message" rows={3} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">{selected.key_message || ''}</textarea>
                  <button type="button" id="generate-draft-btn" data-category-id={selected.id} class="mt-2 text-xs text-pink-600 hover:underline">
                    <i class="fas fa-wand-magic-sparkles mr-1"></i>AIで下書き生成
                  </button>
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-1">本文の生成指示</label>
                  <textarea name="body_prompt" rows={5} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-xs font-mono">{selected.body_prompt || ''}</textarea>
                  <div class="flex gap-1 flex-wrap mt-2">
                    {['{サロン名}', '{エリア}', '{カテゴリ}', '{伝えたいこと}', '{画像の説明}', '{客層}', '{文体}', '{スタイリスト}', '{クーポン名}', '{本文上限}'].map((v) => (
                      <span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500 font-mono">{v}</span>
                    ))}
                  </div>
                  <p class="text-xs text-gray-400 mt-1">未入力の場合は標準の指示文を使用します</p>
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
        )}
      </div>

      <script src="/static/blog-salon.js"></script>
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
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
    )
  }

  // /blog/salonのPOSTハンドラと同じ理由で、この画面が担当する列(基本情報・
  // フッター)だけを更新する(ON CONFLICT DO UPDATEで相手の列には触れない)。
  await c.env.DB.prepare(
    `INSERT INTO salon_profiles (user_id, salon_id, address, nearest_station, walk_minutes, business_hours, closing_days, footer_separator, footer_keywords_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (salon_id) DO UPDATE SET
       address = EXCLUDED.address, nearest_station = EXCLUDED.nearest_station, walk_minutes = EXCLUDED.walk_minutes,
       business_hours = EXCLUDED.business_hours, closing_days = EXCLUDED.closing_days,
       footer_separator = EXCLUDED.footer_separator, footer_keywords_json = EXCLUDED.footer_keywords_json,
       updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      user.id, user.active_salon_id, fields.address, fields.nearest_station, fields.walk_minutes,
      fields.business_hours, fields.closing_days, fields.footer_separator, fields.footer_keywords_json
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

  const styleMode = ['params', 'reference', 'scraped'].includes(String(body.style_mode)) ? String(body.style_mode) : 'params'

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

  await c.env.DB.prepare(
    `UPDATE blog_categories SET name=?, hpb_category_value=?, default_stylist_id=?, key_message=?, body_prompt=?, style_mode=?, season_months_json=?
     WHERE id=? AND user_id=? AND salon_id=?`
  )
    .bind(
      String(body.name || '').trim(),
      String(body.hpb_category_value || '').trim() || null,
      body.default_stylist_id ? Number(body.default_stylist_id) : null,
      String(body.key_message || '').trim() || null,
      String(body.body_prompt || '').trim() || null,
      styleMode,
      JSON.stringify(seasonMonths),
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

async function computeBodyMaxChars(c: AppContext, user: AppUser): Promise<number> {
  const [profile, salon] = await Promise.all([getSalonProfile(c, user), getSalonForProfile(c, user)])
  const footerText = buildFooterText(salon?.salon_name || null, profile)
  return Math.max(300, 1000 - footerText.length)
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
    ? await c.env.DB.prepare('SELECT name FROM stylists WHERE id = ?').bind(category.default_stylist_id).first<{ name: string }>()
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
    styleMode: (category.style_mode as any) || 'params',
    seasonMonths
  })

  // カテゴリに季節パラメータが設定されていれば、生成した記事の月タグへ
  // そのまま反映する(その月に合わせて投稿されるようにするため)。
  await c.env.DB.prepare(
    `UPDATE blog_articles SET title=?, body=?, stylist_id=?, month_tags_json=?, status='unapproved', updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=? AND salon_id=?`
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
  generatedNotice
}: {
  mode: 'new' | 'edit'
  detail: ArticleFormDetail | null
  categories: { id: number; name: string; hpb_category_value: string | null }[]
  stylists: { id: number; name: string }[]
  coupons: { id: number; name: string }[]
  generatedNotice?: boolean
}) {
  const monthTags: number[] = detail ? JSON.parse(detail.month_tags_json || '[]') : []
  const isApproved = detail?.status === 'approved'
  const submitLabel = mode === 'new' || generatedNotice ? '投稿一覧に追加' : '保存する'

  return (
    <div class="space-y-6">
      {generatedNotice && (
        <div class="bg-pink-50 border border-pink-200 text-pink-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-wand-magic-sparkles mr-2"></i>AIが記事を生成しました。内容を確認・編集して「{submitLabel}」を押してください。
        </div>
      )}
      {isApproved && (
        <div class="bg-amber-50 border border-amber-200 text-amber-700 text-sm rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap">
          <span>承認済みの記事です。編集するには先に承認を解除してください。</span>
          <button type="button" id="article-unapprove-btn" data-article-id={detail?.id} class="text-sm font-semibold underline">
            承認を解除
          </button>
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
          <div class="flex items-center gap-3 flex-wrap">
            <input type="file" name="image" accept="image/*" disabled={isApproved} class="text-sm" />
            {detail?.id && (
              <button
                type="button"
                id="article-regen-description-btn"
                data-article-id={detail.id}
                disabled={isApproved}
                class="text-xs text-pink-600 hover:underline disabled:opacity-50"
              >
                <i class="fas fa-wand-magic-sparkles mr-1"></i>画像の説明をAIで再生成
              </button>
            )}
          </div>
        </div>

        <div class="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">タイトル</label>
            <input
              type="text"
              name="title"
              value={detail?.title || ''}
              maxlength={25}
              disabled={isApproved}
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">本文</label>
            <textarea name="body" rows={10} disabled={isApproved} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {detail?.body || ''}
            </textarea>
            {detail?.id && (
              <button
                type="button"
                id="article-regen-body-btn"
                data-article-id={detail.id}
                disabled={isApproved}
                class="mt-1 text-xs text-pink-600 hover:underline disabled:opacity-50"
              >
                <i class="fas fa-wand-magic-sparkles mr-1"></i>本文をAIで再生成
              </button>
            )}
          </div>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">カテゴリ</label>
              <select name="category_id" disabled={isApproved} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">選択しない</option>
                {categories.map((cat) => (
                  <option value={cat.id} selected={detail?.category_id === cat.id}>
                    {cat.name}
                    {!cat.hpb_category_value ? '(HPB未設定)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">投稿者</label>
              <select name="stylist_id" disabled={isApproved} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">選択しない</option>
                {stylists.map((st) => (
                  <option value={st.id} selected={detail?.stylist_id === st.id}>{st.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">クーポン</label>
              <select name="coupon_id" disabled={isApproved} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
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
                    disabled={isApproved}
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
                name="footer_enabled"
                checked={detail ? detail.footer_enabled_flag === 1 : true}
                disabled={isApproved}
                class="accent-pink-500"
              />
              フッターを追加する
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="auto_post_enabled"
                checked={detail ? detail.auto_post_enabled_flag === 1 : true}
                disabled={isApproved}
                class="accent-pink-500"
              />
              自動投稿の対象にする
            </label>
          </div>
        </div>

        <div class="flex items-center gap-3">
          <button
            type="submit"
            disabled={isApproved}
            class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm disabled:opacity-50"
          >
            {submitLabel}
          </button>
          <a href="/blog/articles" class="text-sm text-gray-500 hover:underline">
            一覧に戻る
          </a>
          {detail && !isApproved && (
            <button
              type="button"
              id="article-approve-btn"
              data-article-id={detail.id}
              class="ml-auto text-sm px-5 py-2 rounded-lg bg-gray-800 hover:bg-gray-900 text-white font-semibold"
            >
              承認する
            </button>
          )}
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
    categoryId: body.category_id ? Number(body.category_id) : null,
    stylistId: body.stylist_id ? Number(body.stylist_id) : null,
    couponId: body.coupon_id ? Number(body.coupon_id) : null,
    monthTags,
    footerEnabled: body.footer_enabled === 'on' || body.footer_enabled === 'true',
    autoPostEnabled: body.auto_post_enabled === 'on' || body.auto_post_enabled === 'true'
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
  const { categories, stylists, coupons } = await loadArticleFormMasters(c, user)
  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}
      reviewEnabled={user.review_enabled !== 0}
      active="blog-articles"
      salonName={user.salon_name}
      title="記事の新規作成"
      styleEnabled={user.style_enabled !== 0}
    >
      <ArticleForm mode="new" detail={null} categories={categories} stylists={stylists} coupons={coupons} />
    </PageLayout>,
    { title: '記事の新規作成' }
  )
})

blog.post('/blog/articles/new', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const parsed = parseArticleForm(body)

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
      user.id, user.active_salon_id, parsed.categoryId, parsed.stylistId, parsed.couponId,
      parsed.title, parsed.body, JSON.stringify(parsed.monthTags),
      parsed.footerEnabled ? 1 : 0, parsed.autoPostEnabled ? 1 : 0, nextOrderRow?.n ?? 0
    )
    .run()

  const articleId = Number(insert.meta.last_row_id)
  await saveArticleImageIfProvided(c, user, articleId, body)

  return c.redirect('/blog/articles?saved=1')
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

  const { categories, stylists, coupons } = await loadArticleFormMasters(c, user)

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}
      reviewEnabled={user.review_enabled !== 0}
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

  const existing = await c.env.DB.prepare('SELECT status FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .first<{ status: string }>()
  if (!existing) return c.notFound()
  if (existing.status === 'approved') {
    return c.redirect(`/blog/articles/${id}/edit`)
  }

  const body = await c.req.parseBody()
  const parsed = parseArticleForm(body)

  await c.env.DB.prepare(
    `UPDATE blog_articles SET
       category_id=?, stylist_id=?, coupon_id=?, title=?, body=?, month_tags_json=?,
       footer_enabled_flag=?, auto_post_enabled_flag=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND user_id=? AND salon_id=?`
  )
    .bind(
      parsed.categoryId, parsed.stylistId, parsed.couponId, parsed.title, parsed.body,
      JSON.stringify(parsed.monthTags), parsed.footerEnabled ? 1 : 0, parsed.autoPostEnabled ? 1 : 0,
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
        <form method="post" action="/blog/generate" enctype="multipart/form-data" class="bg-white rounded-xl border border-gray-100 p-6 space-y-5">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">テンプレート(記事カテゴリ)</label>
            <select name="category_id" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {catList.map((cat) => (
                <option value={cat.id}>
                  {cat.name}
                  {!cat.hpb_category_value ? '(HPB未設定)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">画像</label>
            <input type="file" name="image" accept="image/*" required class="text-sm" />
            <p class="text-xs text-gray-400 mt-1">この画像の内容をAIが読み取り、記事の材料にします</p>
          </div>
          <button id="blog-generate-btn" type="submit" class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg">
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

  const categoryId = Number(body.category_id)
  const category = await c.env.DB.prepare(
    'SELECT id, name, key_message, title_prompt, body_prompt, default_stylist_id, style_mode, season_months_json FROM blog_categories WHERE id = ? AND user_id = ? AND salon_id = ?'
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
      ? await c.env.DB.prepare('SELECT name FROM stylists WHERE id = ?').bind(category.default_stylist_id).first<{ name: string }>()
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
      styleMode: (category.style_mode as any) || 'params',
      seasonMonths
    })

    const insert = await c.env.DB.prepare(
      `INSERT INTO blog_articles (
         user_id, salon_id, category_id, stylist_id, image_r2_key, image_file_name, image_description,
         title, body, month_tags_json, footer_enabled_flag, auto_post_enabled_flag, status, sort_order
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'unapproved', ?)`
    )
      .bind(
        user.id, user.active_salon_id, categoryId, category.default_stylist_id || null, key, fileName, imageDescription,
        result.title, result.body, JSON.stringify(seasonMonths), nextOrderRow?.n ?? 0
      )
      .run()

    return c.redirect(`/blog/articles/${insert.meta.last_row_id}/edit?generated=1`)
  } catch (err: any) {
    await c.env.STYLE_IMAGES.delete(key).catch(() => {})
    return c.redirect(`/blog/generate?error=${encodeURIComponent(String(err?.message || err) || 'AI生成に失敗しました')}`)
  }
})

type ArticleListRow = {
  id: number
  no: number
  title: string | null
  image_r2_key: string | null
  category_id: number | null
  category_name: string | null
  stylist_name: string | null
  coupon_name: string | null
  status: string
  month_tags_json: string
  last_posted_at: string | null
  post_count: number
  auto_post_enabled_flag: number
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

function jstNow(): Date {
  return new Date(Date.now() + JST_OFFSET_MS)
}

blog.get('/blog/articles', async (c) => {
  const user = c.get('user')

  const { results: couponOptions } = await c.env.DB.prepare(
    'SELECT id, name FROM coupons WHERE user_id = ? AND salon_id = ? AND is_active = 1 ORDER BY sort_order ASC'
  )
    .bind(user.id, user.active_salon_id)
    .all<{ id: number; name: string }>()

  const { results: categoryOptions } = await c.env.DB.prepare(
    'SELECT id, name FROM blog_categories WHERE user_id = ? AND salon_id = ? ORDER BY sort_order ASC, id ASC'
  )
    .bind(user.id, user.active_salon_id)
    .all<{ id: number; name: string }>()

  const { results: rows } = await c.env.DB.prepare(
    `SELECT
       ROW_NUMBER() OVER (ORDER BY a.sort_order ASC, a.id ASC) AS no,
       a.id, a.title, a.image_r2_key, a.status, a.month_tags_json, a.last_posted_at, a.post_count,
       a.auto_post_enabled_flag, a.category_id,
       bc.name AS category_name, st.name AS stylist_name, cp.name AS coupon_name
     FROM blog_articles a
     LEFT JOIN blog_categories bc ON bc.id = a.category_id
     LEFT JOIN stylists st ON st.id = a.stylist_id
     LEFT JOIN coupons cp ON cp.id = a.coupon_id
     WHERE a.user_id = ? AND a.salon_id = ?
     ORDER BY a.sort_order ASC, a.id ASC`
  )
    .bind(user.id, user.active_salon_id)
    .all<ArticleListRow>()

  const articles = rows || []
  const total = articles.length
  const approved = articles.filter((a) => a.status === 'approved').length
  const unapproved = articles.filter((a) => a.status === 'unapproved').length

  const schedule = await c.env.DB.prepare(
    `SELECT enabled, paused_until FROM blog_post_schedules WHERE user_id = ? AND salon_id = ?`
  )
    .bind(user.id, user.active_salon_id)
    .first<{ enabled: number; paused_until: string | null }>()
  const scheduleEnabled = schedule?.enabled === 1
  const pausedUntilMs = schedule?.paused_until ? new Date(schedule.paused_until.replace(' ', 'T') + 'Z').getTime() : null
  const isPaused = !!pausedUntilMs && pausedUntilMs > Date.now()
  const inFlightBlogJob = await c.env.DB.prepare(
    `SELECT 1 as x FROM blog_post_jobs WHERE user_id = ? AND salon_id = ? AND status IN ('pending', 'running') LIMIT 1`
  )
    .bind(user.id, user.active_salon_id)
    .first<{ x: number }>()

  const now = jstNow()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const remainingDaysInMonth = daysInMonth - now.getDate() + 1

  // 投稿順(生成順=sort_order)を1日1本で巡回した場合の簡易シミュレーション
  // (Phase 2で実際の自動投稿を実装するまでは、あくまで見込み表示)。
  // 承認済み・自動投稿ONの記事だけを対象に生成順で巡回し、各日について
  // その月に合う(月タグが空、またはその日の月を含む)記事をカーソル位置から
  // 探して割り当てる。合う記事が無い日はスキップとして表示する。
  const postable = articles.filter((a) => a.status === 'approved' && a.auto_post_enabled_flag === 1)
  const calendarDays: { dateLabel: string; article: ArticleListRow | null; skipReason: string | null }[] = []
  const previewDays = 14
  let cursor = 0
  for (let i = 0; i < previewDays; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const dateLabel = `${d.getMonth() + 1}/${d.getDate()}`
    const month = d.getMonth() + 1

    if (postable.length === 0) {
      calendarDays.push({ dateLabel, article: null, skipReason: '承認済み・自動投稿ONの記事がありません' })
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

  return c.render(
    <PageLayout seoEnabled={user.seo_enabled !== 0} reviewEnabled={user.review_enabled !== 0} active="blog-articles" salonName={user.salon_name} title="投稿記事一覧" styleEnabled={user.style_enabled !== 0}>
      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <div class="flex gap-8 flex-wrap">
          <div>
            <span class="block text-xs text-gray-400">記事総数</span>
            <b class="text-2xl">{total}</b>
          </div>
          <div>
            <span class="block text-xs text-gray-400">承認済み</span>
            <b class="text-2xl text-green-600">{approved}</b>
          </div>
          <div>
            <span class="block text-xs text-gray-400">未承認</span>
            <b class="text-2xl text-pink-600">{unapproved}</b>
          </div>
          <div>
            <span class="block text-xs text-gray-400">今月投稿できる日数</span>
            <b class="text-2xl text-amber-600">
              {remainingDaysInMonth}
              <small class="text-sm text-gray-400">/{daysInMonth}</small>
            </b>
          </div>
        </div>
        {total > 0 && (
          <div class="mt-4 flex gap-0.5 h-3 rounded overflow-hidden">
            {articles.map((a) => (
              <span
                class={
                  'flex-1 ' +
                  (a.status === 'approved'
                    ? 'bg-green-400'
                    : a.status === 'unapproved'
                    ? 'bg-pink-400'
                    : a.status === 'generating'
                    ? 'bg-amber-300'
                    : a.status === 'posting_failed'
                    ? 'bg-red-500'
                    : 'bg-gray-200')
                }
                title={`No.${a.no} ${a.title || ''} (${ARTICLE_STATUS_LABEL[a.status] || a.status})`}
              ></span>
            ))}
          </div>
        )}
        <p class="text-xs text-gray-400 mt-2">承認済み・投稿待ち / 未承認 / 生成中 / 投稿失敗 / 未生成</p>
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <div class="flex items-center justify-between flex-wrap gap-3">
          <div>
            <p class="font-semibold"><i class="fas fa-robot mr-2 text-pink-500"></i>SALON BOARDへの自動投稿</p>
            <p class="text-xs text-gray-400 mt-1">
              承認済み・自動投稿ONの記事の中から、月タグに合うものを1日1本の目安で自動投稿します(深夜2:00〜7:00は投稿しません)。
            </p>
          </div>
          <form method="post" action="/blog/articles/schedule" class="flex items-center gap-2">
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" name="enabled" checked={scheduleEnabled} onchange="this.form.submit()" class="sr-only peer" />
              <span class="w-11 h-6 bg-gray-200 rounded-full peer-checked:bg-pink-500 transition-colors"></span>
              <span class="absolute left-1 top-1 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-5"></span>
            </label>
            <span class={'text-sm font-semibold ' + (scheduleEnabled ? 'text-pink-600' : 'text-gray-400')}>
              {scheduleEnabled ? '自動投稿 ON' : '自動投稿 OFF'}
            </span>
          </form>
        </div>
        {isPaused && (
          <p class="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-3">
            連続で投稿に失敗したため、一時的に自動投稿を停止しています(しばらくすると自動的に再開します)。
          </p>
        )}
        <div class="flex items-center gap-3 mt-4">
          <button type="button" id="blog-test-run-btn" class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-4 py-2 rounded-lg" disabled={!!inFlightBlogJob}>
            今すぐまとめて投稿する
          </button>
          {inFlightBlogJob && <span class="text-xs text-gray-400">投稿処理が進行中です...</span>}
          <p id="blog-test-run-status" class="text-sm text-gray-500"></p>
        </div>
      </div>

      <div class="flex gap-2 border-b border-gray-100">
        <button type="button" class="blog-tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-pink-500 text-pink-600" data-tab="list">一覧</button>
        <button type="button" class="blog-tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-gray-400" data-tab="calendar">投稿カレンダー</button>
      </div>

      <div data-tab-panel="list">
        <div class="mb-3 space-y-2">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2 flex-wrap">
              <select id="blog-filter-select" class="text-sm font-semibold text-gray-600 border border-gray-300 rounded-lg px-3 py-2">
                <option value="all">すべて</option>
                <option value="on">ONのみ</option>
                <option value="off">OFFのみ</option>
              </select>
              <select id="blog-category-filter" class="text-xs border border-gray-200 rounded-lg px-2 py-1.5">
                <option value="">すべての記事カテゴリ</option>
                {(categoryOptions || []).map((cat) => (
                  <option value={cat.id}>{cat.name}</option>
                ))}
              </select>
              <select id="blog-sort-select" class="text-xs border border-gray-200 rounded-lg px-2 py-1.5">
                <option value="generated">生成順に表示</option>
                <option value="season">季節柄でソート</option>
              </select>
            </div>
            <a
              href="/blog/articles/new"
              class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-4 py-2 rounded-lg whitespace-nowrap flex-shrink-0"
            >
              <i class="fas fa-plus mr-1"></i>新規作成
            </a>
          </div>
        </div>

        <div id="blog-bulk-bar" class="hidden bg-gray-800 text-white rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap mb-4">
          <span><b id="blog-selected-count">0</b>件を選択中</span>
          <button type="button" id="blog-bulk-approve-btn" class="bg-white/10 hover:bg-white/20 text-xs font-semibold px-3 py-1.5 rounded-lg">まとめて承認する</button>
          <select id="blog-bulk-coupon-select" class="bg-white/10 text-xs px-2 py-1.5 rounded-lg w-full sm:w-auto min-w-0">
            <option value="">クーポンを設定...</option>
            {(couponOptions || []).map((cp) => (
              <option value={cp.id}>{cp.name}</option>
            ))}
          </select>
          <button type="button" id="blog-bulk-coupon-btn" class="bg-white/10 hover:bg-white/20 text-xs font-semibold px-3 py-1.5 rounded-lg">設定</button>
        </div>

        <div class="bg-white rounded-xl border border-gray-100 p-6">
          {articles.length > 0 && (
            <div class="hidden md:flex items-center gap-4 pb-2 border-b border-gray-100 text-xs font-semibold text-gray-400">
              <span class="w-5 flex-shrink-0"></span>
              <span class="w-10 flex-shrink-0 text-center">No</span>
              <span class="w-5 flex-shrink-0 text-center" title="承認チェック">承認</span>
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
                >
                  <span class="blog-drag-handle touch-none cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 flex-shrink-0 px-1" data-article-id={a.id}>
                    <i class="fas fa-grip-lines"></i>
                  </span>
                  <input
                    type="number"
                    min="1"
                    value={a.no}
                    class="blog-order-input w-10 flex-shrink-0 text-center text-xs text-gray-600 border border-gray-300 rounded px-1 py-0.5 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    data-article-id={a.id}
                  />
                  <input type="checkbox" class="blog-article-checkbox w-4 h-4 accent-pink-500 cursor-pointer flex-shrink-0" data-article-id={a.id} title="承認チェック" />
                  <input
                    type="checkbox"
                    class="blog-auto-post-toggle w-4 h-4 accent-pink-500 cursor-pointer flex-shrink-0"
                    data-article-id={a.id}
                    checked={a.auto_post_enabled_flag === 1}
                    title="自動投稿の対象"
                  />
                  {a.image_r2_key ? (
                    <img src={`/blog/article/${a.id}/image`} class="w-10 h-14 md:w-16 md:h-16 object-cover rounded-lg bg-gray-50 border border-gray-200 flex-shrink-0" />
                  ) : (
                    <div class="w-10 h-14 md:w-16 md:h-16 bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-center text-gray-300 flex-shrink-0">
                      <i class="fas fa-image text-xl"></i>
                    </div>
                  )}
                  <div class="flex-1 min-w-0">
                    <a href={`/blog/articles/${a.id}/edit`} class="block truncate font-medium text-gray-700 hover:text-pink-600">
                      {a.title || '（未生成）'}
                    </a>
                    <p class="text-xs text-gray-400 flex gap-2 flex-wrap mt-0.5">
                      <span>{a.category_name || '-'}</span>
                      <span>{a.stylist_name || '-'}</span>
                      <span>{a.coupon_name || '-'}</span>
                      <span
                        class={
                          'px-1.5 py-0.5 rounded ' +
                          (a.status === 'approved'
                            ? 'bg-green-50 text-green-600'
                            : a.status === 'unapproved'
                            ? 'bg-pink-50 text-pink-600'
                            : a.status === 'posting_failed'
                            ? 'bg-red-50 text-red-600'
                            : 'bg-gray-100 text-gray-500')
                        }
                      >
                        {ARTICLE_STATUS_LABEL[a.status] || a.status}
                      </span>
                      {a.last_posted_at && <span>最終投稿 {a.last_posted_at}(投稿{a.post_count}回)</span>}
                    </p>
                  </div>
                  <div class="flex items-center gap-1 md:gap-2 flex-shrink-0">
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
              <span class="flex-1 min-w-0 truncate">{d.skipReason ? <span class="text-amber-700">投稿されません</span> : d.article?.title || '-'}</span>
              {d.skipReason ? (
                <span class="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">{d.skipReason}</span>
              ) : (
                <span class="text-xs px-2 py-0.5 rounded bg-green-50 text-green-600">承認済み</span>
              )}
            </div>
          ))}
        </div>
        <p class="text-xs text-gray-400 mt-2">
          ※Phase 1では実際の自動投稿はまだ行われません。承認済みの記事を投稿順に1日1本ずつ投稿した場合の見込みを表示しています。
        </p>
      </div>

      <script src="/static/blog-articles.js"></script>
    </PageLayout>,
    { title: '投稿記事一覧' }
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

  return c.redirect('/blog/articles')
})

blog.post('/api/blog/articles/reset-stuck-jobs', async (c) => {
  const user = c.get('user')
  const count = await resetStuckBlogJobsForUser(c.env, user.id, user.active_salon_id)
  return c.json({ success: true, count })
})

blog.post('/api/blog/articles/toggle-auto-post', async (c) => {
  const user = c.get('user')
  const { articleId, enabled } = await c.req.json<{ articleId: number; enabled: boolean }>()

  await c.env.DB.prepare(
    'UPDATE blog_articles SET auto_post_enabled_flag = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND salon_id = ?'
  )
    .bind(enabled ? 1 : 0, articleId, user.id, user.active_salon_id)
    .run()

  return c.json({ success: true })
})

blog.post('/api/blog/articles/bulk-approve', async (c) => {
  const user = c.get('user')
  const { articleIds } = await c.req.json<{ articleIds: number[] }>()
  let count = 0
  for (const id of articleIds || []) {
    const result = await c.env.DB.prepare(
      `UPDATE blog_articles SET status = 'approved', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, last_error = NULL
       WHERE id = ? AND user_id = ? AND salon_id = ? AND status IN ('unapproved', 'posting_failed')`
    )
      .bind(id, user.id, user.active_salon_id)
      .run()
    if (result.success) count++
  }
  return c.json({ success: true, count })
})

blog.post('/api/blog/articles/bulk-set-coupon', async (c) => {
  const user = c.get('user')
  const { articleIds, couponId } = await c.req.json<{ articleIds: number[]; couponId: number | null }>()
  for (const id of articleIds || []) {
    await c.env.DB.prepare(
      'UPDATE blog_articles SET coupon_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND salon_id = ?'
    )
      .bind(couponId || null, id, user.id, user.active_salon_id)
      .run()
  }
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

blog.post('/api/blog/articles/:id/approve', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const result = await c.env.DB.prepare(
    `UPDATE blog_articles SET status = 'approved', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, last_error = NULL
     WHERE id = ? AND user_id = ? AND salon_id = ? AND status IN ('unapproved', 'posting_failed')`
  )
    .bind(id, user.id, user.active_salon_id)
    .run()
  return c.json({ success: !!result.success })
})

blog.post('/api/blog/articles/:id/unapprove', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare(
    `UPDATE blog_articles SET status = 'unapproved', approved_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND salon_id = ? AND status = 'approved'`
  )
    .bind(id, user.id, user.active_salon_id)
    .run()
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
    'SELECT category_id, image_description, status FROM blog_articles WHERE id = ? AND user_id = ? AND salon_id = ?'
  )
    .bind(id, user.id, user.active_salon_id)
    .first<{ category_id: number | null; image_description: string | null; status: string }>()
  if (!article) return c.json({ error: '記事が見つかりません' }, 404)
  if (article.status === 'approved') return c.json({ error: '承認済みの記事は編集できません' }, 400)
  if (!article.category_id) return c.json({ error: 'カテゴリが設定されていません' }, 400)

  const category = await c.env.DB.prepare(
    'SELECT id, name, key_message, title_prompt, body_prompt, default_stylist_id, style_mode, season_months_json FROM blog_categories WHERE id = ? AND user_id = ? AND salon_id = ?'
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
