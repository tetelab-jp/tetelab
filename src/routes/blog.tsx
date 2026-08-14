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

async function getSalonProfile(c: AppContext, userId: number): Promise<SalonProfileRow | null> {
  return c.env.DB.prepare(
    `SELECT concept, target_customer, writing_tone, ng_words, address, nearest_station, walk_minutes,
            business_hours, closing_days, strengths, price_range, reference_text, first_person,
            sentence_ending, footer_separator, footer_keywords_json, salonboard_synced_at
     FROM salon_profiles WHERE user_id = ?`
  )
    .bind(userId)
    .first<SalonProfileRow>()
}

function buildFooterText(salonName: string | null, profile: SalonProfileRow | null): string {
  if (!profile) return ''
  const sep = (profile.footer_separator || '＊').repeat(16)
  const lines = [sep, salonName || '']
  if (profile.address || profile.nearest_station) {
    lines.push('【アクセス】')
    if (profile.address) lines.push(profile.address)
    if (profile.nearest_station) lines.push(`${profile.nearest_station}${profile.walk_minutes ? ` 徒歩${profile.walk_minutes}` : ''}`)
  }
  if (profile.business_hours || profile.closing_days) {
    lines.push('【営業時間】')
    if (profile.business_hours) lines.push(profile.business_hours)
    if (profile.closing_days) lines.push(`※定休：${profile.closing_days}`)
  }
  const keywords: string[] = JSON.parse(profile.footer_keywords_json || '[]')
  if (keywords.length > 0) lines.push(`[${keywords.join('/')}]`)
  return lines.join('\n')
}

async function getSalonProfileForGeneration(c: AppContext, userId: number): Promise<SalonProfileForGeneration> {
  const [profile, salon] = await Promise.all([
    getSalonProfile(c, userId),
    c.env.DB.prepare('SELECT salon_name, middle_area_name, small_area_name FROM salonboard_salons WHERE user_id = ? LIMIT 1')
      .bind(userId)
      .first<{ salon_name: string | null; middle_area_name: string | null; small_area_name: string | null }>()
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
    reference_text: profile.reference_text
  }
}

// ---------- 1. サロン基本情報 ----------

blog.get('/blog/salon', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')
  const profile = await getSalonProfile(c, user.id)
  const footerText = buildFooterText(user.salon_name, profile)
  const footerLines = footerText ? footerText.split('\n').length : 0

  return c.render(
    <PageLayout seoEnabled={user.seo_enabled !== 0} active="blog-salon" salonName={user.salon_name} title="サロン基本情報" styleEnabled={user.style_enabled !== 0}>
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

      <form method="post" action="/blog/salon" class="space-y-6">
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

        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="font-semibold mb-3">
            <i class="fas fa-shoe-prints mr-2 text-pink-500"></i>フッター<span class="text-xs text-gray-400 ml-2">全記事の末尾に付きます</span>
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

      <script src="/static/blog-salon.js"></script>
    </PageLayout>,
    { title: 'サロン基本情報' }
  )
})

blog.post('/blog/salon', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const fields = {
    address: String(body.address || '').trim(),
    nearest_station: String(body.nearest_station || '').trim(),
    walk_minutes: String(body.walk_minutes || '').trim(),
    business_hours: String(body.business_hours || '').trim(),
    closing_days: String(body.closing_days || '').trim(),
    concept: String(body.concept || '').trim(),
    strengths: String(body.strengths || '').trim(),
    target_customer: String(body.target_customer || '').trim(),
    price_range: String(body.price_range || '').trim(),
    reference_text: String(body.reference_text || '').trim(),
    first_person: String(body.first_person || '').trim(),
    sentence_ending: String(body.sentence_ending || '').trim(),
    writing_tone: String(body.writing_tone || '').trim(),
    ng_words: String(body.ng_words || '').trim(),
    footer_separator: String(body.footer_separator || '＊').trim().slice(0, 1) || '＊',
    footer_keywords_json: JSON.stringify(
      String(body.footer_keywords || '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
    )
  }

  const existing = await c.env.DB.prepare('SELECT id FROM salon_profiles WHERE user_id = ?').bind(user.id).first()
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE salon_profiles SET
         address=?, nearest_station=?, walk_minutes=?, business_hours=?, closing_days=?,
         concept=?, strengths=?, target_customer=?, price_range=?, reference_text=?,
         first_person=?, sentence_ending=?, writing_tone=?, ng_words=?,
         footer_separator=?, footer_keywords_json=?, updated_at=CURRENT_TIMESTAMP
       WHERE user_id=?`
    )
      .bind(
        fields.address, fields.nearest_station, fields.walk_minutes, fields.business_hours, fields.closing_days,
        fields.concept, fields.strengths, fields.target_customer, fields.price_range, fields.reference_text,
        fields.first_person, fields.sentence_ending, fields.writing_tone, fields.ng_words,
        fields.footer_separator, fields.footer_keywords_json, user.id
      )
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO salon_profiles (
         user_id, address, nearest_station, walk_minutes, business_hours, closing_days,
         concept, strengths, target_customer, price_range, reference_text,
         first_person, sentence_ending, writing_tone, ng_words, footer_separator, footer_keywords_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        user.id, fields.address, fields.nearest_station, fields.walk_minutes, fields.business_hours, fields.closing_days,
        fields.concept, fields.strengths, fields.target_customer, fields.price_range, fields.reference_text,
        fields.first_person, fields.sentence_ending, fields.writing_tone, fields.ng_words,
        fields.footer_separator, fields.footer_keywords_json
      )
      .run()
  }

  return c.redirect('/blog/salon?saved=1')
})

// サロンボード同期(既存の/api/settings/sync-stylists-coupons、dashboard.tsx参照)を
// 呼び出した後にこの画面から叩く、最終取得日時の記録のみを行う軽量エンドポイント。
// 同期の実処理(ブラウザ起動・ログイン・スクレイピング)自体は既存エンドポイントを再利用し、
// 二重実装を避ける(public/static/blog-salon.js参照)。
blog.post('/blog/salon/mark-synced', async (c) => {
  const user = c.get('user')
  const existing = await c.env.DB.prepare('SELECT id FROM salon_profiles WHERE user_id = ?').bind(user.id).first()
  if (existing) {
    await c.env.DB.prepare('UPDATE salon_profiles SET salonboard_synced_at = CURRENT_TIMESTAMP WHERE user_id = ?').bind(user.id).run()
  } else {
    await c.env.DB.prepare('INSERT INTO salon_profiles (user_id, salonboard_synced_at) VALUES (?, CURRENT_TIMESTAMP)').bind(user.id).run()
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

  const { results: categories } = await c.env.DB.prepare(
    `SELECT id, name, is_active, sort_order, hpb_category_value, default_stylist_id, key_message, title_prompt, body_prompt, style_mode
     FROM blog_categories WHERE user_id = ? ORDER BY sort_order ASC, id ASC`
  )
    .bind(user.id)
    .all<CategoryRow>()

  const catList = categories || []
  const selectedId = Number(c.req.query('category')) || catList[0]?.id || 0
  const selected = catList.find((cat) => cat.id === selectedId) || null

  const { results: stylists } = await c.env.DB.prepare(
    'SELECT id, name FROM stylists WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC'
  )
    .bind(user.id)
    .all<{ id: number; name: string }>()

  let articles: { id: number; image_description: string | null; status: string; title: string | null }[] = []
  let counts = { total: 0, generated: 0 }
  if (selected) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, image_description, status, title FROM blog_articles
       WHERE user_id = ? AND category_id = ? ORDER BY sort_order ASC, id ASC`
    )
      .bind(user.id, selected.id)
      .all<{ id: number; image_description: string | null; status: string; title: string | null }>()
    articles = results || []
    counts = { total: articles.length, generated: articles.filter((a) => a.status !== 'pending_generation').length }
  }

  return c.render(
    <PageLayout seoEnabled={user.seo_enabled !== 0} active="blog-template" salonName={user.salon_name} title="生成テンプレート" styleEnabled={user.style_enabled !== 0}>
      <div class="flex gap-6 flex-col lg:flex-row">
        <div class="bg-white rounded-xl border border-gray-100 lg:w-64 flex-none">
          <div class="p-4 border-b border-gray-100 flex items-center justify-between">
            <p class="font-semibold text-sm">まとまり</p>
            <span class="text-xs text-gray-400">{catList.length}/10</span>
          </div>
          <div class="divide-y divide-gray-50">
            {catList.length === 0 && <p class="text-sm text-gray-400 p-4">まだありません</p>}
            {catList.map((cat) => (
              <a
                href={`/blog/template?category=${cat.id}`}
                class={`block px-4 py-3 text-sm ${cat.id === selectedId ? 'bg-pink-50 text-pink-700 font-semibold' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                {cat.name}
              </a>
            ))}
          </div>
          {catList.length < 10 && (
            <form method="post" action="/blog/template/categories/add" class="p-3 border-t border-gray-100 flex gap-2">
              <input type="text" name="name" required placeholder="新しいまとまり名" class="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-xs" />
              <button type="submit" class="bg-gray-800 hover:bg-gray-900 text-white text-xs font-semibold px-3 py-1.5 rounded-lg">追加</button>
            </form>
          )}
        </div>

        {!selected ? (
          <div class="flex-1 bg-white rounded-xl border border-gray-100 p-6 text-sm text-gray-400">
            左の「まとまりを追加」からカテゴリを作成してください。
          </div>
        ) : (
          <div class="flex-1 space-y-6 min-w-0">
            <div class="bg-white rounded-xl border border-gray-100 p-6">
              <div class="flex items-center justify-between mb-3">
                <p class="font-semibold">
                  <i class="fas fa-tag mr-2 text-pink-500"></i>このまとまりについて
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
                    <input type="text" name="hpb_category_value" value={selected.hpb_category_value || ''} placeholder="例）ヘアケア" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
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

            <div class="bg-white rounded-xl border border-gray-100 p-6">
              <div class="flex items-center justify-between mb-3">
                <p class="font-semibold">
                  <i class="fas fa-images mr-2 text-pink-500"></i>写真<span class="text-xs text-gray-400 ml-2">1枚 = 記事1本</span>
                </p>
                <span class="text-xs text-gray-400">写真 {counts.total} / 記事 {counts.generated}</span>
              </div>

              <form id="blog-image-upload-form" method="post" action={`/blog/template/categories/${selected.id}/images`} enctype="multipart/form-data" class="mb-4">
                <input type="file" name="images" accept="image/*" multiple id="blog-image-input" class="hidden" />
                <label for="blog-image-input" class="block border-2 border-dashed border-gray-200 rounded-lg p-6 text-center text-sm text-gray-400 cursor-pointer hover:border-pink-300">
                  クリックして写真を選択(複数可)、または読み込むと自動で250〜300KBに圧縮します
                </label>
                <p id="blog-image-upload-status" class="text-xs text-gray-500 mt-2"></p>
              </form>

              {articles.length === 0 ? (
                <p class="text-sm text-gray-400">まだ写真がありません</p>
              ) : (
                <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                  {articles.map((a) => (
                    <div class="border border-gray-100 rounded-lg overflow-hidden">
                      <img src={`/blog/article/${a.id}/image`} class="w-full aspect-square object-cover bg-gray-50" />
                      <div class="p-2 space-y-1">
                        <p class="text-xs text-gray-500 truncate">{a.image_description || a.title || '(説明未設定)'}</p>
                        <span
                          class={
                            'text-xs px-1.5 py-0.5 rounded ' +
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
                        <form method="post" action={`/blog/template/articles/${a.id}/delete`}>
                          <button type="submit" class="text-xs text-gray-300 hover:text-red-500">
                            <i class="fas fa-trash"></i>
                          </button>
                        </form>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div class="bg-white rounded-xl border border-gray-100 p-6 flex items-center gap-3 flex-wrap">
              <button type="button" id="generate-preview-btn" data-category-id={selected.id} class="bg-white border border-gray-300 hover:bg-gray-50 text-sm font-semibold px-4 py-2 rounded-lg">
                1本だけ試しに書かせる
              </button>
              <button type="button" id="generate-batch-btn" data-category-id={selected.id} class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-4 py-2 rounded-lg">
                このまとまりの記事を書く（{counts.total - counts.generated}本）
              </button>
              <span class="text-xs text-gray-400">まだ記事になっていない写真だけが対象です</span>
              <p id="generate-status" class="text-sm text-gray-500 w-full"></p>
              <div id="generate-preview-result" class="hidden w-full bg-gray-50 border border-gray-100 rounded-lg p-4 text-sm space-y-2">
                <p class="font-semibold" id="generate-preview-title"></p>
                <p class="whitespace-pre-wrap text-gray-600" id="generate-preview-body"></p>
              </div>
            </div>
          </div>
        )}
      </div>

      <script src="/static/blog-template.js"></script>
    </PageLayout>,
    { title: '生成テンプレート' }
  )
})

blog.post('/blog/template/categories/add', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const name = String(body.name || '').trim()
  if (!name) return c.redirect('/blog/template')

  const countRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM blog_categories WHERE user_id = ?').bind(user.id).first<{ cnt: number }>()
  if ((countRow?.cnt || 0) >= 10) {
    return c.redirect('/blog/template')
  }
  const nextOrder = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM blog_categories WHERE user_id = ?')
    .bind(user.id)
    .first<{ n: number }>()
  const insert = await c.env.DB.prepare('INSERT INTO blog_categories (user_id, name, sort_order) VALUES (?, ?, ?)')
    .bind(user.id, name, nextOrder?.n ?? 0)
    .run()
  return c.redirect(`/blog/template?category=${insert.meta.last_row_id}`)
})

blog.post('/blog/template/categories/:id/delete', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const { results: images } = await c.env.DB.prepare('SELECT image_r2_key FROM blog_articles WHERE user_id = ? AND category_id = ? AND image_r2_key IS NOT NULL')
    .bind(user.id, id)
    .all<{ image_r2_key: string }>()
  for (const img of images || []) {
    await c.env.STYLE_IMAGES.delete(img.image_r2_key).catch(() => {})
  }
  await c.env.DB.prepare('DELETE FROM blog_categories WHERE id = ? AND user_id = ?').bind(id, user.id).run()
  return c.redirect('/blog/template')
})

blog.post('/blog/template/categories/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()

  const styleMode = ['params', 'reference', 'scraped'].includes(String(body.style_mode)) ? String(body.style_mode) : 'params'
  await c.env.DB.prepare(
    `UPDATE blog_categories SET name=?, hpb_category_value=?, default_stylist_id=?, key_message=?, body_prompt=?, style_mode=?
     WHERE id=? AND user_id=?`
  )
    .bind(
      String(body.name || '').trim(),
      String(body.hpb_category_value || '').trim() || null,
      body.default_stylist_id ? Number(body.default_stylist_id) : null,
      String(body.key_message || '').trim() || null,
      String(body.body_prompt || '').trim() || null,
      styleMode,
      id,
      user.id
    )
    .run()
  return c.redirect(`/blog/template?category=${id}`)
})

blog.post('/api/blog/categories/:id/generate-draft', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const category = await c.env.DB.prepare('SELECT name FROM blog_categories WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ name: string }>()
  if (!category) return c.json({ error: 'カテゴリが見つかりません' }, 404)

  try {
    const profile = await getSalonProfileForGeneration(c, user.id)
    const draft = await generateCategoryDraft(c.env, category.name, profile)
    return c.json({ success: true, draft })
  } catch (err: any) {
    return c.json({ error: err.message || 'AI生成に失敗しました' }, 500)
  }
})

blog.post('/blog/template/categories/:id/images', async (c) => {
  const user = c.get('user')
  const categoryId = Number(c.req.param('id'))
  const category = await c.env.DB.prepare('SELECT id FROM blog_categories WHERE id = ? AND user_id = ?').bind(categoryId, user.id).first()
  if (!category) return c.redirect('/blog/template')

  const body = await c.req.parseBody({ all: true })
  const files = Array.isArray(body.images) ? body.images : body.images ? [body.images] : []

  const nextOrderRow = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM blog_articles WHERE user_id = ?')
    .bind(user.id)
    .first<{ n: number }>()
  let nextOrder = nextOrderRow?.n ?? 0

  for (const f of files) {
    if (!(f instanceof File) || f.size === 0) continue
    const arrayBuffer = await f.arrayBuffer()
    const { buffer, contentType } = await processBlogArticleImage(arrayBuffer)
    const key = `blog/${user.id}/${Date.now()}-${crypto.randomUUID()}.jpg`
    const fileName = `${(f.name || 'blog').replace(/\.[^./\\]+$/, '')}.jpg`
    await c.env.STYLE_IMAGES.put(key, buffer, { httpMetadata: { contentType } })
    await c.env.DB.prepare(
      `INSERT INTO blog_articles (user_id, category_id, image_r2_key, image_file_name, sort_order, status)
       VALUES (?, ?, ?, ?, ?, 'pending_generation')`
    )
      .bind(user.id, categoryId, key, fileName, nextOrder)
      .run()
    nextOrder += 1
  }

  return c.redirect(`/blog/template?category=${categoryId}`)
})

blog.post('/blog/template/articles/:id/delete', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const article = await c.env.DB.prepare('SELECT category_id, image_r2_key FROM blog_articles WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ category_id: number | null; image_r2_key: string | null }>()
  if (!article) return c.redirect('/blog/template')

  if (article.image_r2_key) await c.env.STYLE_IMAGES.delete(article.image_r2_key).catch(() => {})
  await c.env.DB.prepare('DELETE FROM blog_articles WHERE id = ? AND user_id = ?').bind(id, user.id).run()
  return c.redirect(`/blog/template?category=${article.category_id || ''}`)
})

blog.get('/blog/article/:id/image', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const owned = await c.env.DB.prepare('SELECT image_r2_key FROM blog_articles WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
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

async function computeBodyMaxChars(c: AppContext, userId: number): Promise<number> {
  const user = await c.env.DB.prepare('SELECT salon_name FROM users WHERE id = ?').bind(userId).first<{ salon_name: string | null }>()
  const profile = await getSalonProfile(c, userId)
  const footerText = buildFooterText(user?.salon_name || null, profile)
  return Math.max(300, 1000 - footerText.length)
}

async function generateOneArticle(
  c: AppContext,
  userId: number,
  category: CategoryRow,
  article: { id: number; image_description: string | null }
): Promise<void> {
  const profile = await getSalonProfileForGeneration(c, userId)
  const bodyMaxChars = await computeBodyMaxChars(c, userId)

  const stylistRow = category.default_stylist_id
    ? await c.env.DB.prepare('SELECT name FROM stylists WHERE id = ?').bind(category.default_stylist_id).first<{ name: string }>()
    : null

  const result = await generateArticleContent(c.env, {
    categoryName: category.name,
    keyMessage: category.key_message,
    bodyPrompt: category.body_prompt,
    imageDescription: article.image_description,
    stylistName: stylistRow?.name || null,
    couponName: null,
    bodyMaxChars,
    profile,
    styleMode: (category.style_mode as any) || 'params'
  })

  await c.env.DB.prepare(
    `UPDATE blog_articles SET title=?, body=?, stylist_id=?, status='unapproved', updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`
  )
    .bind(result.title, result.body, category.default_stylist_id || null, article.id, userId)
    .run()
}

blog.post('/api/blog/categories/:id/generate-preview', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const category = await c.env.DB.prepare(
    'SELECT id, name, key_message, title_prompt, body_prompt, default_stylist_id, style_mode FROM blog_categories WHERE id = ? AND user_id = ?'
  )
    .bind(id, user.id)
    .first<CategoryRow>()
  if (!category) return c.json({ error: 'カテゴリが見つかりません' }, 404)

  try {
    const sampleArticle = await c.env.DB.prepare(
      `SELECT id, image_description FROM blog_articles WHERE user_id = ? AND category_id = ? ORDER BY sort_order ASC LIMIT 1`
    )
      .bind(user.id, id)
      .first<{ id: number; image_description: string | null }>()

    const profile = await getSalonProfileForGeneration(c, user.id)
    const bodyMaxChars = await computeBodyMaxChars(c, user.id)
    const stylistRow = category.default_stylist_id
      ? await c.env.DB.prepare('SELECT name FROM stylists WHERE id = ?').bind(category.default_stylist_id).first<{ name: string }>()
      : null

    const result = await generateArticleContent(c.env, {
      categoryName: category.name,
      keyMessage: category.key_message,
      bodyPrompt: category.body_prompt,
      imageDescription: sampleArticle?.image_description || null,
      stylistName: stylistRow?.name || null,
      couponName: null,
      bodyMaxChars,
      profile,
      styleMode: (category.style_mode as any) || 'params'
    })
    return c.json({ success: true, ...result })
  } catch (err: any) {
    return c.json({ error: err.message || 'AI生成に失敗しました' }, 500)
  }
})

blog.post('/api/blog/categories/:id/generate-batch', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const category = await c.env.DB.prepare(
    'SELECT id, name, key_message, title_prompt, body_prompt, default_stylist_id, style_mode FROM blog_categories WHERE id = ? AND user_id = ?'
  )
    .bind(id, user.id)
    .first<CategoryRow>()
  if (!category) return c.json({ error: 'カテゴリが見つかりません' }, 404)

  const { results: targets } = await c.env.DB.prepare(
    `SELECT id, image_description FROM blog_articles WHERE user_id = ? AND category_id = ? AND status = 'pending_generation' ORDER BY sort_order ASC`
  )
    .bind(user.id, id)
    .all<{ id: number; image_description: string | null }>()

  const list = targets || []
  if (list.length === 0) return c.json({ success: true, count: 0 })

  for (const article of list) {
    await c.env.DB.prepare(`UPDATE blog_articles SET status = 'generating' WHERE id = ? AND user_id = ?`)
      .bind(article.id, user.id)
      .run()
  }

  // ALBのアイドルタイムアウト内にレスポンスを返すため、生成本体はawaitせず
  // バックグラウンドで進める(進捗はクライアント側のポーリングで確認する)。
  void (async () => {
    for (const article of list) {
      // 説明文が未設定の画像は、AI生成前にvisionで説明文を作っておく
      if (!article.image_description) {
        try {
          const row = await c.env.DB.prepare('SELECT image_r2_key FROM blog_articles WHERE id = ?').bind(article.id).first<{ image_r2_key: string | null }>()
          if (row?.image_r2_key) {
            const obj = await c.env.STYLE_IMAGES.get(row.image_r2_key)
            if (obj) {
              const buf = Buffer.from(await obj.arrayBuffer())
              const desc = await generateImageDescription(c.env, buf)
              article.image_description = desc
              await c.env.DB.prepare('UPDATE blog_articles SET image_description = ? WHERE id = ?').bind(desc, article.id).run()
            }
          }
        } catch (err) {
          console.error(`画像説明の生成に失敗しました(article=${article.id}):`, err)
        }
      }

      try {
        await generateOneArticle(c, user.id, category, article)
      } catch (err: any) {
        await c.env.DB.prepare(`UPDATE blog_articles SET status = 'pending_generation', last_error = ? WHERE id = ?`)
          .bind(String(err?.message || err).slice(0, 500), article.id)
          .run()
      }
    }
  })()

  return c.json({ success: true, count: list.length })
})

// 一覧側で進捗をポーリングするための軽量ステータスAPI
blog.get('/api/blog/categories/:id/generation-status', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const { results } = await c.env.DB.prepare(
    `SELECT status, COUNT(*) as cnt FROM blog_articles WHERE user_id = ? AND category_id = ? GROUP BY status`
  )
    .bind(user.id, id)
    .all<{ status: string; cnt: number }>()
  return c.json({ success: true, counts: results || [] })
})

// ---------- 3. 投稿記事一覧 ----------

type ArticleListRow = {
  id: number
  no: number
  title: string | null
  image_r2_key: string | null
  category_name: string | null
  stylist_name: string | null
  coupon_name: string | null
  status: string
  month_tags_json: string
  last_posted_at: string | null
  post_count: number
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000

function jstNow(): Date {
  return new Date(Date.now() + JST_OFFSET_MS)
}

blog.get('/blog/articles', async (c) => {
  const user = c.get('user')

  const { results: couponOptions } = await c.env.DB.prepare(
    'SELECT id, name FROM coupons WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC'
  )
    .bind(user.id)
    .all<{ id: number; name: string }>()

  const { results: rows } = await c.env.DB.prepare(
    `SELECT
       ROW_NUMBER() OVER (ORDER BY a.sort_order ASC, a.id ASC) AS no,
       a.id, a.title, a.image_r2_key, a.status, a.month_tags_json, a.last_posted_at, a.post_count,
       bc.name AS category_name, st.name AS stylist_name, cp.name AS coupon_name
     FROM blog_articles a
     LEFT JOIN blog_categories bc ON bc.id = a.category_id
     LEFT JOIN stylists st ON st.id = a.stylist_id
     LEFT JOIN coupons cp ON cp.id = a.coupon_id
     WHERE a.user_id = ?
     ORDER BY a.sort_order ASC, a.id ASC`
  )
    .bind(user.id)
    .all<ArticleListRow>()

  const articles = rows || []
  const total = articles.length
  const approved = articles.filter((a) => a.status === 'approved').length
  const unapproved = articles.filter((a) => a.status === 'unapproved').length

  const now = jstNow()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const remainingDaysInMonth = daysInMonth - now.getDate() + 1

  // 投稿順(sort_order)を1日1本で巡回した場合の簡易シミュレーション(Phase 2で
  // 実際の自動投稿を実装するまでは、あくまで見込み表示)。承認済みのみ対象。
  const approvedArticles = articles.filter((a) => a.status === 'approved')
  const calendarDays: { dateLabel: string; article: ArticleListRow | null; skipReason: string | null }[] = []
  const previewDays = 14
  for (let i = 0; i < previewDays; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    const dateLabel = `${d.getMonth() + 1}/${d.getDate()}`
    if (articles.length === 0) {
      calendarDays.push({ dateLabel, article: null, skipReason: '記事がありません' })
      continue
    }
    const candidate = articles[i % articles.length]
    const monthTags: number[] = JSON.parse(candidate.month_tags_json || '[]')
    if (candidate.status !== 'approved') {
      calendarDays.push({ dateLabel, article: candidate, skipReason: '未承認のためスキップ' })
    } else if (monthTags.length > 0 && !monthTags.includes(d.getMonth() + 1)) {
      calendarDays.push({ dateLabel, article: candidate, skipReason: '月タグ不一致のためスキップ' })
    } else {
      calendarDays.push({ dateLabel, article: candidate, skipReason: null })
    }
  }

  return c.render(
    <PageLayout seoEnabled={user.seo_enabled !== 0} active="blog-articles" salonName={user.salon_name} title="投稿記事一覧" styleEnabled={user.style_enabled !== 0}>
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

      <div class="flex gap-2 border-b border-gray-100">
        <button type="button" class="blog-tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-pink-500 text-pink-600" data-tab="list">一覧</button>
        <button type="button" class="blog-tab-btn px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-gray-400" data-tab="calendar">投稿カレンダー</button>
      </div>

      <div data-tab-panel="list">
        <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
          <button type="button" id="blog-rearrange-btn" class="bg-white border border-gray-300 hover:bg-gray-50 text-xs font-semibold px-3 py-1.5 rounded-lg text-gray-600">
            <i class="fas fa-shuffle mr-1"></i>まとまりの順番に並び替える
          </button>
          <span class="text-xs text-gray-400">まとまり1→2→3→…の順に1記事ずつ交互に並び替えます</span>
        </div>

        <div id="blog-bulk-bar" class="hidden bg-gray-800 text-white rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap mb-4">
          <span><b id="blog-selected-count">0</b>件を選択中</span>
          <button type="button" id="blog-bulk-approve-btn" class="bg-white/10 hover:bg-white/20 text-xs font-semibold px-3 py-1.5 rounded-lg">まとめて承認する</button>
          <select id="blog-bulk-coupon-select" class="bg-white/10 text-xs px-2 py-1.5 rounded-lg">
            <option value="">クーポンを設定...</option>
            {(couponOptions || []).map((cp) => (
              <option value={cp.id}>{cp.name}</option>
            ))}
          </select>
          <button type="button" id="blog-bulk-coupon-btn" class="bg-white/10 hover:bg-white/20 text-xs font-semibold px-3 py-1.5 rounded-lg">設定</button>
        </div>

        <div class="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
          {articles.length === 0 && <p class="text-sm text-gray-400 p-6">まだ記事がありません。生成テンプレートから写真をアップロードしてください。</p>}
          {articles.map((a) => (
            <div class="flex items-start gap-3 p-4">
              <input type="checkbox" class="blog-article-checkbox mt-1 accent-pink-500" data-article-id={a.id} />
              <input
                type="number"
                class="blog-order-input w-14 rounded border border-gray-200 px-1.5 py-1 text-xs text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                data-article-id={a.id}
                value={a.no}
                min={1}
              />
              {a.image_r2_key ? (
                <img src={`/blog/article/${a.id}/image`} class="w-14 h-14 rounded-lg object-cover bg-gray-50 flex-none" />
              ) : (
                <div class="w-14 h-14 rounded-lg bg-gray-50 flex-none"></div>
              )}
              <div class="flex-1 min-w-0">
                <p class="font-semibold text-sm truncate">{a.title || '(未生成)'}</p>
                <p class="text-xs text-gray-400 flex gap-2 flex-wrap mt-1">
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
              <button type="button" class="blog-open-article-btn text-xs text-pink-600 hover:underline flex-none" data-article-id={a.id}>
                開く
              </button>
            </div>
          ))}
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

      {/* 記事確認モーダル */}
      <div id="blog-reviewer" class="hidden fixed inset-0 bg-black/50 z-50 items-center justify-center p-4">
        <div class="bg-white rounded-xl w-full max-w-3xl max-h-full overflow-auto">
          <div class="flex items-center gap-3 px-5 py-3 border-b border-gray-100">
            <span class="text-xs text-gray-400 font-mono">No.<span id="rv-no"></span></span>
            <span id="rv-status" class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500"></span>
            <button type="button" id="rv-close-btn" class="ml-auto text-gray-400 hover:text-gray-600"><i class="fas fa-xmark"></i></button>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-0">
            <div class="p-5 border-r border-gray-100 bg-gray-50">
              <img id="rv-image" class="w-full aspect-square object-cover rounded-lg bg-white mb-3" />
              <label class="block text-xs font-medium text-gray-500 mb-1">画像の説明</label>
              <input id="rv-description" class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-xs mb-2" />
              <button type="button" id="rv-regen-description-btn" class="text-xs text-pink-600 hover:underline">AIで再生成</button>
            </div>
            <div class="p-5 space-y-3">
              <div>
                <input id="rv-title" class="w-full text-lg font-semibold border-0 border-b border-gray-200 px-0 py-1 focus:outline-none focus:border-pink-400" />
                <p class="text-xs text-gray-400 mt-1"><span id="rv-title-len">0</span>/25文字</p>
              </div>
              <div>
                <textarea id="rv-body" rows={8} class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"></textarea>
                <p class="text-xs text-gray-400 mt-1"><span id="rv-body-len">0</span>/1000文字(フッター込み) / 改行<span id="rv-body-lines">0</span>行</p>
              </div>
              <details>
                <summary class="text-xs text-gray-400 cursor-pointer">フッターを見る</summary>
                <pre id="rv-footer" class="text-xs text-gray-500 bg-gray-50 rounded-lg p-3 mt-2 whitespace-pre-wrap"></pre>
              </details>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-medium text-gray-500 mb-1">カテゴリ</label>
                  <select id="rv-category" class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"></select>
                </div>
                <div>
                  <label class="block text-xs font-medium text-gray-500 mb-1">投稿者</label>
                  <select id="rv-stylist" class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"></select>
                </div>
                <div>
                  <label class="block text-xs font-medium text-gray-500 mb-1">クーポン</label>
                  <select id="rv-coupon" class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"></select>
                </div>
                <div>
                  <label class="block text-xs font-medium text-gray-500 mb-1">月タグ</label>
                  <div id="rv-month-tags" class="flex flex-wrap gap-1"></div>
                </div>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2 px-5 py-3 border-t border-gray-100">
            <button type="button" id="rv-regen-body-btn" class="text-sm px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50">本文を再生成</button>
            <button type="button" id="rv-save-btn" class="text-sm px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50">保存</button>
            <button type="button" id="rv-approve-btn" class="ml-auto text-sm px-5 py-2 rounded-lg bg-pink-500 hover:bg-pink-600 text-white font-semibold">承認する</button>
            <button type="button" id="rv-unapprove-btn" class="hidden text-sm px-4 py-2 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50">承認を解除</button>
          </div>
        </div>
      </div>

      <script src="/static/blog-articles.js"></script>
    </PageLayout>,
    { title: '投稿記事一覧' }
  )
})

blog.post('/api/blog/articles/reorder', async (c) => {
  const user = c.get('user')
  const { articleId, newPosition } = await c.req.json<{ articleId: number; newPosition: number }>()

  const { results } = await c.env.DB.prepare('SELECT id FROM blog_articles WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
    .bind(user.id)
    .all<{ id: number }>()
  const ids = (results || []).map((r) => r.id)
  const currentIndex = ids.indexOf(articleId)
  if (currentIndex === -1) return c.json({ success: false, error: '対象の記事が見つかりません' }, 404)

  ids.splice(currentIndex, 1)
  const targetIndex = Math.min(Math.max(Math.trunc(newPosition) - 1, 0), ids.length)
  ids.splice(targetIndex, 0, articleId)

  for (let i = 0; i < ids.length; i++) {
    await c.env.DB.prepare('UPDATE blog_articles SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .bind(i, ids[i], user.id)
      .run()
  }
  return c.json({ success: true })
})

// 「まとまり」(カテゴリ)を1記事ずつ順番に交互させる並び替え。カテゴリの
// sort_order順にローテーションし、各カテゴリの中では現在のsort_order順を
// キューとして先頭から1件ずつ取り出す。カテゴリ未設定の記事は最後の
// 1グループとしてローテーションに混ぜる。ボタン押下時のみ実行され、
// 記事の生成・承認時に自動では走らない(手動での並び替えを上書きしないため)。
blog.post('/api/blog/articles/rearrange-by-category', async (c) => {
  const user = c.get('user')

  const { results: categories } = await c.env.DB.prepare(
    'SELECT id FROM blog_categories WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
  )
    .bind(user.id)
    .all<{ id: number }>()

  const { results: articles } = await c.env.DB.prepare(
    'SELECT id, category_id FROM blog_articles WHERE user_id = ? ORDER BY sort_order ASC, id ASC'
  )
    .bind(user.id)
    .all<{ id: number; category_id: number | null }>()

  const queues = new Map<number | null, number[]>()
  for (const a of articles || []) {
    const key = a.category_id
    if (!queues.has(key)) queues.set(key, [])
    queues.get(key)!.push(a.id)
  }

  const groupOrder: (number | null)[] = [...(categories || []).map((cat) => cat.id), null]
  const orderedIds: number[] = []
  let remaining = (articles || []).length
  while (remaining > 0) {
    for (const key of groupOrder) {
      const queue = queues.get(key)
      if (queue && queue.length > 0) {
        orderedIds.push(queue.shift()!)
        remaining--
      }
    }
  }

  for (let i = 0; i < orderedIds.length; i++) {
    await c.env.DB.prepare('UPDATE blog_articles SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .bind(i, orderedIds[i], user.id)
      .run()
  }
  return c.json({ success: true })
})

blog.post('/api/blog/articles/bulk-approve', async (c) => {
  const user = c.get('user')
  const { articleIds } = await c.req.json<{ articleIds: number[] }>()
  let count = 0
  for (const id of articleIds || []) {
    const result = await c.env.DB.prepare(
      `UPDATE blog_articles SET status = 'approved', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND status = 'unapproved'`
    )
      .bind(id, user.id)
      .run()
    if (result.success) count++
  }
  return c.json({ success: true, count })
})

blog.post('/api/blog/articles/bulk-set-coupon', async (c) => {
  const user = c.get('user')
  const { articleIds, couponId } = await c.req.json<{ articleIds: number[]; couponId: number | null }>()
  for (const id of articleIds || []) {
    await c.env.DB.prepare('UPDATE blog_articles SET coupon_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
      .bind(couponId || null, id, user.id)
      .run()
  }
  return c.json({ success: true })
})

blog.get('/api/blog/articles/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const [article, categories, stylists, coupons, profile, salonUser] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, category_id, title, body, image_description, coupon_id, stylist_id, month_tags_json, status
       FROM blog_articles WHERE id = ? AND user_id = ?`
    )
      .bind(id, user.id)
      .first<{
        id: number
        category_id: number | null
        title: string | null
        body: string | null
        image_description: string | null
        coupon_id: number | null
        stylist_id: number | null
        month_tags_json: string
        status: string
      }>(),
    c.env.DB.prepare('SELECT id, name FROM blog_categories WHERE user_id = ? ORDER BY sort_order ASC').bind(user.id).all<{ id: number; name: string }>(),
    c.env.DB.prepare('SELECT id, name FROM stylists WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC').bind(user.id).all<{ id: number; name: string }>(),
    c.env.DB.prepare('SELECT id, name FROM coupons WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC').bind(user.id).all<{ id: number; name: string }>(),
    getSalonProfile(c, user.id),
    c.env.DB.prepare('SELECT salon_name FROM users WHERE id = ?').bind(user.id).first<{ salon_name: string | null }>()
  ])

  if (!article) return c.json({ error: '記事が見つかりません' }, 404)

  return c.json({
    success: true,
    article,
    categories: categories.results || [],
    stylists: stylists.results || [],
    coupons: coupons.results || [],
    footer: buildFooterText(salonUser?.salon_name || null, profile)
  })
})

blog.patch('/api/blog/articles/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.json<{
    title?: string
    body?: string
    image_description?: string
    category_id?: number | null
    stylist_id?: number | null
    coupon_id?: number | null
    month_tags?: number[]
  }>()

  const existing = await c.env.DB.prepare('SELECT status FROM blog_articles WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ status: string }>()
  if (!existing) return c.json({ success: false, error: '記事が見つかりません' }, 404)
  if (existing.status === 'approved') {
    return c.json({ success: false, error: '承認済みの記事は編集できません。先に承認を解除してください' }, 400)
  }

  await c.env.DB.prepare(
    `UPDATE blog_articles SET
       title = COALESCE(?, title), body = COALESCE(?, body), image_description = COALESCE(?, image_description),
       category_id = ?, stylist_id = ?, coupon_id = ?, month_tags_json = COALESCE(?, month_tags_json),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(
      body.title ?? null,
      body.body ?? null,
      body.image_description ?? null,
      body.category_id ?? null,
      body.stylist_id ?? null,
      body.coupon_id ?? null,
      body.month_tags ? JSON.stringify(body.month_tags) : null,
      id,
      user.id
    )
    .run()

  return c.json({ success: true })
})

blog.post('/api/blog/articles/:id/approve', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const result = await c.env.DB.prepare(
    `UPDATE blog_articles SET status = 'approved', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'unapproved'`
  )
    .bind(id, user.id)
    .run()
  return c.json({ success: !!result.success })
})

blog.post('/api/blog/articles/:id/unapprove', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare(
    `UPDATE blog_articles SET status = 'unapproved', approved_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND status = 'approved'`
  )
    .bind(id, user.id)
    .run()
  return c.json({ success: true })
})

blog.post('/api/blog/articles/:id/regenerate-description', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const article = await c.env.DB.prepare('SELECT image_r2_key FROM blog_articles WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ image_r2_key: string | null }>()
  if (!article?.image_r2_key) return c.json({ error: '画像が見つかりません' }, 404)

  try {
    const obj = await c.env.STYLE_IMAGES.get(article.image_r2_key)
    if (!obj) return c.json({ error: '画像が見つかりません' }, 404)
    const buf = Buffer.from(await obj.arrayBuffer())
    const description = await generateImageDescription(c.env, buf)
    await c.env.DB.prepare('UPDATE blog_articles SET image_description = ? WHERE id = ? AND user_id = ?').bind(description, id, user.id).run()
    return c.json({ success: true, description })
  } catch (err: any) {
    return c.json({ error: err.message || 'AI生成に失敗しました' }, 500)
  }
})

blog.post('/api/blog/articles/:id/regenerate-body', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const article = await c.env.DB.prepare(
    'SELECT category_id, image_description, status FROM blog_articles WHERE id = ? AND user_id = ?'
  )
    .bind(id, user.id)
    .first<{ category_id: number | null; image_description: string | null; status: string }>()
  if (!article) return c.json({ error: '記事が見つかりません' }, 404)
  if (article.status === 'approved') return c.json({ error: '承認済みの記事は編集できません' }, 400)
  if (!article.category_id) return c.json({ error: 'カテゴリが設定されていません' }, 400)

  const category = await c.env.DB.prepare(
    'SELECT id, name, key_message, title_prompt, body_prompt, default_stylist_id, style_mode FROM blog_categories WHERE id = ? AND user_id = ?'
  )
    .bind(article.category_id, user.id)
    .first<CategoryRow>()
  if (!category) return c.json({ error: 'カテゴリが見つかりません' }, 404)

  try {
    await generateOneArticle(c, user.id, category, { id, image_description: article.image_description })
    const updated = await c.env.DB.prepare('SELECT title, body FROM blog_articles WHERE id = ?').bind(id).first<{ title: string; body: string }>()
    return c.json({ success: true, ...updated })
  } catch (err: any) {
    return c.json({ error: err.message || 'AI生成に失敗しました' }, 500)
  }
})

export default blog
