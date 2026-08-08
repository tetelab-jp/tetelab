import { Hono } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import { generateBlogContent } from '../lib/ai-generate'
import type { Bindings, AppUser } from '../types'

const blog = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

blog.use('*', requireAuth)

type MasterRow = { id: number; name: string; is_active: number }

// ---------- ブログ基本設定（マスタ管理） ----------

blog.get('/blog/master', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')

  const [authors, categories, coupons, profile] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, is_active FROM stylists WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
      .bind(user.id)
      .all<MasterRow>(),
    c.env.DB.prepare('SELECT id, name, is_active FROM blog_categories WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
      .bind(user.id)
      .all<MasterRow>(),
    c.env.DB.prepare('SELECT id, name, is_active FROM coupons WHERE user_id = ? ORDER BY sort_order ASC, id ASC')
      .bind(user.id)
      .all<MasterRow>(),
    c.env.DB.prepare(
      'SELECT concept, target_customer, writing_tone, ng_words FROM salon_profiles WHERE user_id = ?'
    )
      .bind(user.id)
      .first<{ concept: string; target_customer: string; writing_tone: string; ng_words: string }>()
  ])

  return c.render(
    <PageLayout active="blog-master" salonName={user.salon_name} title="ブログ基本設定">
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>保存しました
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-3">
          <i class="fas fa-store mr-2 text-pink-500"></i>サロン情報（AI生成に利用されます）
        </p>
        <form method="post" action="/blog/master/profile" class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">サロンのコンセプト・雰囲気</label>
            <textarea
              name="concept"
              rows={2}
              placeholder="例）落ち着いた大人の女性向けの隠れ家サロン。ナチュラルなスタイルが得意です。"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >{profile?.concept || ''}</textarea>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">ターゲット層</label>
            <input
              type="text"
              name="target_customer"
              value={profile?.target_customer || ''}
              placeholder="例）20代後半〜40代の働く女性"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">文体・トーン</label>
            <select name="writing_tone" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {['丁寧語（フォーマル）', 'カジュアル・親しみやすい', '絵文字を多用した明るい文体', 'クールで簡潔'].map(
                (tone) => (
                  <option value={tone} selected={profile?.writing_tone === tone}>
                    {tone}
                  </option>
                )
              )}
            </select>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">NGワード・避けたい表現（任意）</label>
            <input
              type="text"
              name="ng_words"
              value={profile?.ng_words || ''}
              placeholder="例）安い、格安（高級感を損なう表現は避ける）"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <button type="submit" class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-5 py-2.5 rounded-lg text-sm">
            サロン情報を保存
          </button>
        </form>
      </div>

      <MasterListCard title="投稿者（スタイリスト）" icon="fa-user" endpoint="/blog/master/authors" items={authors.results || []} />
      <MasterListCard title="カテゴリ" icon="fa-tag" endpoint="/blog/master/categories" items={categories.results || []} />
      <MasterListCard title="クーポン" icon="fa-ticket" endpoint="/blog/master/coupons" items={coupons.results || []} />
    </PageLayout>,
    { title: 'ブログ基本設定' }
  )
})

function MasterListCard({
  title,
  icon,
  endpoint,
  items
}: {
  title: string
  icon: string
  endpoint: string
  items: MasterRow[]
}) {
  return (
    <div class="bg-white rounded-xl border border-gray-100 p-6">
      <p class="font-semibold mb-3">
        <i class={`fas ${icon} mr-2 text-pink-500`}></i>
        {title}
      </p>
      <div class="space-y-2 mb-4">
        {items.length === 0 && <p class="text-sm text-gray-400">まだ登録されていません</p>}
        {items.map((item) => (
          <div class="flex items-center justify-between border border-gray-100 rounded-lg px-3 py-2">
            <span class="text-sm text-gray-700">{item.name}</span>
            <form method="post" action={`${endpoint}/${item.id}/delete`}>
              <button type="submit" class="text-xs text-gray-400 hover:text-red-500">
                <i class="fas fa-trash"></i>
              </button>
            </form>
          </div>
        ))}
      </div>
      <form method="post" action={`${endpoint}/add`} class="flex gap-2">
        <input
          type="text"
          name="name"
          required
          placeholder={`${title}を追加`}
          class="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <button type="submit" class="bg-gray-800 hover:bg-gray-900 text-white text-sm font-semibold px-4 py-2 rounded-lg">
          追加
        </button>
      </form>
    </div>
  )
}

blog.post('/blog/master/profile', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const concept = String(body.concept || '').trim()
  const targetCustomer = String(body.target_customer || '').trim()
  const writingTone = String(body.writing_tone || '').trim()
  const ngWords = String(body.ng_words || '').trim()

  const existing = await c.env.DB.prepare('SELECT id FROM salon_profiles WHERE user_id = ?').bind(user.id).first()

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE salon_profiles SET concept=?, target_customer=?, writing_tone=?, ng_words=?, updated_at=CURRENT_TIMESTAMP WHERE user_id=?`
    )
      .bind(concept, targetCustomer, writingTone, ngWords, user.id)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO salon_profiles (user_id, concept, target_customer, writing_tone, ng_words) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(user.id, concept, targetCustomer, writingTone, ngWords)
      .run()
  }

  return c.redirect('/blog/master?saved=1')
})

// ---------- マスタ（投稿者/カテゴリ/クーポン）のCRUD ----------

const MASTER_TABLES: Record<string, string> = {
  authors: 'stylists',
  categories: 'blog_categories',
  coupons: 'coupons'
}

for (const key of Object.keys(MASTER_TABLES)) {
  const table = MASTER_TABLES[key]

  blog.post(`/blog/master/${key}/add`, async (c) => {
    const user = c.get('user')
    const body = await c.req.parseBody()
    const name = String(body.name || '').trim()
    if (name) {
      await c.env.DB.prepare(`INSERT INTO ${table} (user_id, name) VALUES (?, ?)`).bind(user.id, name).run()
    }
    return c.redirect('/blog/master?saved=1')
  })

  blog.post(`/blog/master/${key}/:id/delete`, async (c) => {
    const user = c.get('user')
    const id = Number(c.req.param('id'))
    await c.env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).bind(id, user.id).run()
    return c.redirect('/blog/master?saved=1')
  })
}

// ---------- ブログ投稿作成 ----------

blog.get('/blog/posts', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')

  const [authors, categories, coupons, posts] = await Promise.all([
    c.env.DB.prepare('SELECT id, name FROM stylists WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC')
      .bind(user.id)
      .all<{ id: number; name: string }>(),
    c.env.DB.prepare('SELECT id, name FROM blog_categories WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC')
      .bind(user.id)
      .all<{ id: number; name: string }>(),
    c.env.DB.prepare('SELECT id, name FROM coupons WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC')
      .bind(user.id)
      .all<{ id: number; name: string }>(),
    c.env.DB.prepare(
      `SELECT id, title, status, scheduled_at, author_name, category_name FROM posts
       WHERE user_id = ? AND post_type = 'blog' ORDER BY created_at DESC LIMIT 20`
    )
      .bind(user.id)
      .all<{ id: number; title: string; status: string; scheduled_at: string; author_name: string; category_name: string }>()
  ])

  const hasMaster = (authors.results?.length || 0) > 0 && (categories.results?.length || 0) > 0

  return c.render(
    <PageLayout active="blog-posts" salonName={user.salon_name} title="ブログ投稿作成">
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>投稿予約を保存しました
        </div>
      )}

      {!hasMaster && (
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
          <i class="fas fa-triangle-exclamation mr-2"></i>
          投稿者・カテゴリが未登録です。先に
          <a href="/blog/master" class="font-semibold underline">
            ブログ基本設定
          </a>
          で登録してください。
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <form id="blog-post-form" method="post" action="/blog/posts" class="space-y-4">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">投稿者</label>
              <select name="author_name" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">選択してください</option>
                {(authors.results || []).map((a) => (
                  <option value={a.name}>{a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">カテゴリ</label>
              <select name="category_name" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">選択してください</option>
                {(categories.results || []).map((cat) => (
                  <option value={cat.name}>{cat.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">クーポン（任意）</label>
            <select name="coupon_name" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="">選択しない</option>
              {(coupons.results || []).map((cp) => (
                <option value={cp.name}>{cp.name}</option>
              ))}
            </select>
          </div>

          <hr class="border-gray-100" />

          <div class="bg-pink-50 border border-pink-200 rounded-lg p-4 space-y-2">
            <label class="block text-sm font-semibold text-pink-700 mb-1">
              <i class="fas fa-wand-magic-sparkles mr-1"></i>AIでブログ本文を生成
            </label>
            <div class="flex gap-2">
              <input
                id="ai-keywords"
                type="text"
                placeholder="キーワードを入力（例: 梅雨 くせ毛 縮毛矯正 ダメージレス）"
                class="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <button
                id="ai-generate-btn"
                type="button"
                class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-4 py-2 rounded-lg text-sm whitespace-nowrap"
              >
                <i class="fas fa-wand-magic-sparkles mr-1"></i>AIで生成
              </button>
            </div>
            <p id="ai-status" class="text-xs text-pink-600 hidden"></p>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">タイトル</label>
            <input
              id="title-input"
              type="text"
              name="title"
              required
              placeholder="ブログのタイトル"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">本文</label>
            <textarea
              id="content-textarea"
              name="content"
              required
              rows={10}
              placeholder="ブログ本文（AIで生成するか、直接入力してください）"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            ></textarea>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">投稿希望日時</label>
            <input
              type="datetime-local"
              name="scheduled_at"
              class="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
            <p class="text-xs text-gray-400 mt-1">未入力の場合はすぐに投稿予約として保存されます（Phase3で自動投稿対応）</p>
          </div>

          <button
            type="submit"
            class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition"
          >
            投稿予約として保存
          </button>
        </form>
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-3">
          <i class="fas fa-clock-rotate-left mr-2 text-pink-500"></i>最近の投稿予約
        </p>
        {(posts.results || []).length === 0 ? (
          <p class="text-sm text-gray-400">まだ投稿予約がありません</p>
        ) : (
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-400 border-b border-gray-100">
                <th class="py-2">タイトル</th>
                <th class="py-2">投稿者</th>
                <th class="py-2">カテゴリ</th>
                <th class="py-2">予約日時</th>
                <th class="py-2">状態</th>
              </tr>
            </thead>
            <tbody>
              {(posts.results || []).map((p) => (
                <tr class="border-b border-gray-50">
                  <td class="py-2">{p.title}</td>
                  <td class="py-2">{p.author_name || '-'}</td>
                  <td class="py-2">{p.category_name || '-'}</td>
                  <td class="py-2">{p.scheduled_at || '-'}</td>
                  <td class="py-2">
                    <span
                      class={
                        'text-xs px-2 py-0.5 rounded ' +
                        (p.status === 'done'
                          ? 'bg-green-100 text-green-700'
                          : p.status === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-gray-100 text-gray-600')
                      }
                    >
                      {p.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <script src="/static/blog-post.js"></script>
    </PageLayout>,
    { title: 'ブログ投稿作成' }
  )
})

blog.post('/blog/posts', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const title = String(body.title || '').trim()
  const content = String(body.content || '').trim()
  const authorName = String(body.author_name || '').trim() || null
  const categoryName = String(body.category_name || '').trim() || null
  const couponName = String(body.coupon_name || '').trim() || null
  const scheduledAt = String(body.scheduled_at || '').trim() || null

  if (!title || !content) {
    return c.redirect('/blog/posts?error=' + encodeURIComponent('タイトルと本文は必須です'))
  }

  await c.env.DB.prepare(
    `INSERT INTO posts (user_id, post_type, title, content, scheduled_at, status, author_name, category_name, coupon_name)
     VALUES (?, 'blog', ?, ?, ?, 'pending', ?, ?, ?)`
  )
    .bind(user.id, title, content, scheduledAt, authorName, categoryName, couponName)
    .run()

  return c.redirect('/blog/posts?saved=1')
})

// ---------- AI生成API ----------

blog.post('/api/blog/generate', async (c) => {
  const user = c.get('user')
  const { keywords } = await c.req.json<{ keywords: string }>()

  if (!keywords || !keywords.trim()) {
    return c.json({ error: 'キーワードを入力してください' }, 400)
  }

  const profile = await c.env.DB.prepare(
    'SELECT concept, target_customer, writing_tone, ng_words FROM salon_profiles WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{ concept: string; target_customer: string; writing_tone: string; ng_words: string }>()

  try {
    const result = await generateBlogContent(c.env, keywords, profile || null)
    return c.json({ success: true, ...result })
  } catch (err: any) {
    return c.json({ error: err.message || 'AI生成に失敗しました' }, 500)
  }
})

export default blog
