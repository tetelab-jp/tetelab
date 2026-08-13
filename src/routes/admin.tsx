import { Hono } from 'hono'
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import { hashPassword, verifyPasswordConstantTime } from '../lib/crypto'
import { signJwt, verifyJwt } from '../lib/jwt'
import { ADMIN_SESSION_COOKIE_NAME, requireAdminAuth } from '../lib/admin-auth-middleware'
import { SESSION_COOKIE_NAME } from '../lib/auth-middleware'
import { AdminPageLayout } from '../components/admin-layout'
import type { Bindings, AdminUser } from '../types'

const admin = new Hono<{ Bindings: Bindings; Variables: { admin: AdminUser } }>()

const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 12 // 12時間(サロン側の7日より短く、管理者権限のリスクを踏まえ短めにする)
const IMPERSONATE_SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // サロン側の通常セッションと同じ7日

function AdminAuthLayout({ children }: { children: any }) {
  return (
    <div class="min-h-screen flex items-center justify-center px-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-6">
          <img src="/static/logo-combined.png" alt="SalonMotion" class="inline-block h-14 w-auto" />
          <p class="text-sm text-gray-500 mt-2">管理者サイト</p>
        </div>
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">{children}</div>
      </div>
    </div>
  )
}

function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null
  return (
    <div class="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">
      <i class="fas fa-circle-exclamation mr-2"></i>
      {message}
    </div>
  )
}

async function setAdminSession(c: any, adminId: number, email: string) {
  const secret = c.env.ADMIN_JWT_SECRET
  if (!secret) throw new Error('ADMIN_JWT_SECRETが未設定です')
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS
  const token = await signJwt({ sub: adminId, email, exp }, secret)
  const isHttps = c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://')
  setCookie(c, ADMIN_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
    path: '/',
    maxAge: ADMIN_SESSION_TTL_SECONDS
  })
}

// なりすましログイン用: サロン側auth.tsxのsetSession()と同じ組み立て方で、
// 対象サロンの通常セッションCookie(session)をそのまま発行する(パスワードは一切扱わない)。
async function impersonateSalonSession(c: any, userId: number, email: string) {
  const secret = c.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRETが未設定です')
  const exp = Math.floor(Date.now() / 1000) + IMPERSONATE_SESSION_TTL_SECONDS
  const token = await signJwt({ sub: userId, email, exp }, secret)
  const isHttps = c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://')
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
    path: '/',
    maxAge: IMPERSONATE_SESSION_TTL_SECONDS
  })
}

// ---------- ログイン ----------

admin.get('/admin', async (c) => {
  // 既にログイン中なら一覧へ
  const token = getCookie(c, ADMIN_SESSION_COOKIE_NAME)
  const secret = c.env.ADMIN_JWT_SECRET
  if (token && secret && (await verifyJwt(token, secret))) {
    return c.redirect('/admin/salons')
  }

  const error = c.req.query('error')
  return c.render(
    <AdminAuthLayout>
      <h2 class="text-lg font-bold mb-6">管理者ログイン</h2>
      <ErrorBanner message={error} />
      <form method="post" action="/admin" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">メールアドレス</label>
          <input
            required
            type="email"
            name="email"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">パスワード</label>
          <input
            required
            type="password"
            name="password"
            placeholder="••••••••"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
          />
        </div>
        <button
          type="submit"
          class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition"
        >
          ログイン
        </button>
      </form>
    </AdminAuthLayout>,
    { title: '管理者ログイン' }
  )
})

// 2026-08-13追記(監査指摘の是正): 管理者ログインが破られるとなりすまし
// 機能経由で全サロンを乗っ取れてしまうため、ブルートフォース対策を追加する。
const ADMIN_MAX_FAILED_LOGIN_ATTEMPTS = 10
const ADMIN_LOGIN_LOCKOUT_MINUTES = 15

admin.post('/admin', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const wrongCredsError = () =>
    c.redirect('/admin?error=' + encodeURIComponent('メールアドレスまたはパスワードが正しくありません'))

  const adminRow = await c.env.DB.prepare(
    'SELECT id, email, password_hash, failed_login_count, login_locked_until FROM admin_users WHERE email = ?'
  )
    .bind(email)
    .first<{
      id: number
      email: string
      password_hash: string
      failed_login_count: number
      login_locked_until: string | null
    }>()

  if (adminRow?.login_locked_until) {
    const lockedUntilMs = new Date(adminRow.login_locked_until.replace(' ', 'T') + 'Z').getTime()
    if (lockedUntilMs > Date.now()) {
      return c.redirect(
        '/admin?error=' +
          encodeURIComponent('ログイン試行が続けて失敗したため、しばらく時間をおいてから再度お試しください')
      )
    }
  }

  const valid = await verifyPasswordConstantTime(password, adminRow?.password_hash ?? null)

  if (!adminRow || !valid) {
    if (adminRow) {
      await c.env.DB.prepare(
        `UPDATE admin_users SET failed_login_count = failed_login_count + 1,
           login_locked_until = CASE
             WHEN failed_login_count + 1 >= ? THEN now() + (? || ' minutes')::interval
             ELSE login_locked_until
           END
         WHERE id = ?`
      )
        .bind(ADMIN_MAX_FAILED_LOGIN_ATTEMPTS, ADMIN_LOGIN_LOCKOUT_MINUTES, adminRow.id)
        .run()
    }
    return wrongCredsError()
  }

  if (adminRow.failed_login_count > 0 || adminRow.login_locked_until) {
    await c.env.DB.prepare('UPDATE admin_users SET failed_login_count = 0, login_locked_until = NULL WHERE id = ?')
      .bind(adminRow.id)
      .run()
  }

  await setAdminSession(c, adminRow.id, adminRow.email)
  return c.redirect('/admin/salons')
})

admin.post('/admin/logout', (c) => {
  deleteCookie(c, ADMIN_SESSION_COOKIE_NAME, { path: '/' })
  return c.redirect('/admin')
})

// ---------- /admin配下、ここから先はログイン必須 ----------

admin.use('/admin/salons/*', requireAdminAuth)
admin.use('/admin/salons', requireAdminAuth)
admin.use('/admin/tool/*', requireAdminAuth)
admin.use('/admin/tool', requireAdminAuth)
admin.use('/admin/status/*', requireAdminAuth)
admin.use('/admin/status', requireAdminAuth)

// ---------- 監査ログ ----------

async function logAdminAction(
  c: any,
  adminId: number,
  action: string,
  targetType: string,
  targetId: number,
  detail?: string
) {
  await c.env.DB.prepare(
    'INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(adminId, action, targetType, targetId, detail ?? null)
    .run()
}

// ---------- サロン一覧 ----------

const SALONS_PAGE_SIZE = 20

type SalonRow = {
  id: number
  email: string
  salon_name: string | null
  is_active: number
  created_at: string
  seq: number
}

function buildSalonsListUrl(page: number, q: string) {
  const params = new URLSearchParams()
  if (page > 1) params.set('page', String(page))
  if (q) params.set('q', q)
  const qs = params.toString()
  return '/admin/salons' + (qs ? `?${qs}` : '')
}

admin.get('/admin/salons', async (c) => {
  const adminUser = c.get('admin')
  const q = (c.req.query('q') || '').trim()
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1)
  const offset = (page - 1) * SALONS_PAGE_SIZE
  const likePattern = `%${q}%`

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM users WHERE (? = '' OR salon_name ILIKE ? OR email ILIKE ?)`
  )
    .bind(q, likePattern, likePattern)
    .first<{ cnt: number }>()
  const totalCount = countRow?.cnt ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / SALONS_PAGE_SIZE))

  const { results: salons } = await c.env.DB.prepare(
    `SELECT id, email, salon_name, is_active, created_at,
       ROW_NUMBER() OVER (ORDER BY is_active DESC, created_at ASC) AS seq
     FROM users
     WHERE (? = '' OR salon_name ILIKE ? OR email ILIKE ?)
     ORDER BY is_active DESC, created_at ASC
     LIMIT ? OFFSET ?`
  )
    .bind(q, likePattern, likePattern, SALONS_PAGE_SIZE, offset)
    .all<SalonRow>()

  return c.render(
    <AdminPageLayout active="admin-salons" adminEmail={adminUser.email} title="サロン一覧">
      <form method="get" action="/admin/salons" class="flex gap-2">
        <input
          type="text"
          name="q"
          value={q}
          placeholder="サロン名・メールアドレスで検索"
          class="flex-1 max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
        />
        <button
          type="submit"
          class="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm font-medium text-gray-700 transition"
        >
          検索
        </button>
        {q && (
          <a
            href="/admin/salons"
            class="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-gray-600 transition"
          >
            クリア
          </a>
        )}
      </form>

      <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th class="px-4 py-3 text-left font-medium">No.</th>
                <th class="px-4 py-3 text-left font-medium">サロン名</th>
                <th class="px-4 py-3 text-left font-medium">メールアドレス</th>
                <th class="px-4 py-3 text-left font-medium">登録日</th>
                <th class="px-4 py-3 text-left font-medium">契約状況</th>
                <th class="px-4 py-3 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              {salons.map((salon) => (
                <tr>
                  <td class="px-4 py-3 text-gray-400">{salon.seq}</td>
                  <td class="px-4 py-3 font-medium text-gray-800">{salon.salon_name || '(未設定)'}</td>
                  <td class="px-4 py-3 text-gray-500">{salon.email}</td>
                  <td class="px-4 py-3 text-gray-500">{String(salon.created_at).slice(0, 10)}</td>
                  <td class="px-4 py-3">
                    <form method="post" action={`/admin/salons/${salon.id}/toggle-active`}>
                      <input type="hidden" name="page" value={page} />
                      <input type="hidden" name="q" value={q} />
                      <label class="flex items-center gap-2 cursor-pointer w-fit">
                        <span class="relative inline-flex items-center flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={salon.is_active === 1}
                            onchange="this.form.submit()"
                            class="sr-only peer"
                          />
                          <span class="w-11 h-6 bg-gray-200 rounded-full peer-checked:bg-pink-500 transition-colors"></span>
                          <span class="absolute left-1 top-1 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-5"></span>
                        </span>
                        <span
                          class={
                            'text-xs font-semibold ' + (salon.is_active === 1 ? 'text-pink-600' : 'text-gray-400')
                          }
                        >
                          {salon.is_active === 1 ? '契約中' : '契約外'}
                        </span>
                      </label>
                    </form>
                  </td>
                  <td class="px-4 py-3">
                    <form
                      method="post"
                      action={`/admin/salons/${salon.id}/impersonate`}
                      target="_blank"
                      onsubmit="return confirm('このサロンとして新しいタブでログインします。よろしいですか？')"
                    >
                      <button
                        type="submit"
                        class="px-3 py-1.5 rounded-lg border border-gray-200 text-xs font-medium text-gray-600 hover:bg-gray-50 transition whitespace-nowrap"
                      >
                        <i class="fas fa-right-to-bracket mr-1"></i>なりすましログイン
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {salons.length === 0 && (
                <tr>
                  <td colspan={6} class="px-4 py-8 text-center text-gray-400">
                    該当するサロンがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div class="flex items-center justify-between text-sm text-gray-500">
        <span>
          {totalCount}件中 {totalCount === 0 ? 0 : offset + 1}〜{Math.min(offset + SALONS_PAGE_SIZE, totalCount)}
          件を表示
        </span>
        <div class="flex gap-3">
          {page > 1 && (
            <a href={buildSalonsListUrl(page - 1, q)} class="hover:text-pink-600">
              ← 前へ
            </a>
          )}
          <span class="text-gray-400">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <a href={buildSalonsListUrl(page + 1, q)} class="hover:text-pink-600">
              次へ →
            </a>
          )}
        </div>
      </div>
    </AdminPageLayout>,
    { title: 'サロン一覧' }
  )
})

admin.post('/admin/salons/:id/toggle-active', async (c) => {
  const adminUser = c.get('admin')
  const targetId = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const page = String(body.page || '1')
  const q = String(body.q || '')

  const target = await c.env.DB.prepare('SELECT id, email, is_active FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ id: number; email: string; is_active: number }>()
  if (target) {
    const nextActive = target.is_active === 1 ? 0 : 1
    await c.env.DB.prepare('UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(nextActive, targetId)
      .run()
    await logAdminAction(
      c,
      adminUser.id,
      'toggle_salon_active',
      'user',
      targetId,
      `${target.email}: is_active ${target.is_active} -> ${nextActive}`
    )
  }

  return c.redirect(buildSalonsListUrl(Number(page) || 1, q))
})

admin.post('/admin/salons/:id/impersonate', async (c) => {
  const adminUser = c.get('admin')
  const targetId = Number(c.req.param('id'))

  const target = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ id: number; email: string }>()
  if (!target) {
    return c.redirect('/admin/salons')
  }

  await logAdminAction(c, adminUser.id, 'impersonate_login', 'user', targetId, target.email)
  await impersonateSalonSession(c, target.id, target.email)
  return c.redirect('/dashboard')
})

// ---------- ツール設定(サロンごとのスタイル/ブログ機能オンオフ) ----------
// OFFにすると、salon側のrequireStyleEnabled/requireBlogEnabledミドルウェアに
// より該当ルート・API・バッチ(cronの投稿対象)から完全にブロックされる
// (src/lib/auth-middleware.ts、src/routes/automation.tsxの/api/cron/run-style-posts参照)。

const TOOL_PAGE_SIZE = 20

type ToolSalonRow = {
  id: number
  email: string
  salon_name: string | null
  style_enabled: number
  blog_enabled: number
  seo_enabled: number
  seq: number
}

function buildToolListUrl(page: number, q: string) {
  const params = new URLSearchParams()
  if (page > 1) params.set('page', String(page))
  if (q) params.set('q', q)
  const qs = params.toString()
  return '/admin/tool' + (qs ? `?${qs}` : '')
}

function FeatureToggleForm({
  action,
  page,
  q,
  enabled,
  onLabel,
  offLabel
}: {
  action: string
  page: number
  q: string
  enabled: boolean
  onLabel: string
  offLabel: string
}) {
  return (
    <form method="post" action={action}>
      <input type="hidden" name="page" value={page} />
      <input type="hidden" name="q" value={q} />
      <label class="flex items-center gap-2 cursor-pointer w-fit">
        <span class="relative inline-flex items-center flex-shrink-0">
          <input type="checkbox" checked={enabled} onchange="this.form.submit()" class="sr-only peer" />
          <span class="w-11 h-6 bg-gray-200 rounded-full peer-checked:bg-pink-500 transition-colors"></span>
          <span class="absolute left-1 top-1 w-4 h-4 bg-white rounded-full shadow transition-transform peer-checked:translate-x-5"></span>
        </span>
        <span class={'text-xs font-semibold ' + (enabled ? 'text-pink-600' : 'text-gray-400')}>
          {enabled ? onLabel : offLabel}
        </span>
      </label>
    </form>
  )
}

admin.get('/admin/tool', async (c) => {
  const adminUser = c.get('admin')
  const q = (c.req.query('q') || '').trim()
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1)
  const offset = (page - 1) * TOOL_PAGE_SIZE
  const likePattern = `%${q}%`

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM users WHERE (? = '' OR salon_name ILIKE ? OR email ILIKE ?)`
  )
    .bind(q, likePattern, likePattern)
    .first<{ cnt: number }>()
  const totalCount = countRow?.cnt ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / TOOL_PAGE_SIZE))

  const { results: salons } = await c.env.DB.prepare(
    `SELECT id, email, salon_name, style_enabled, blog_enabled, seo_enabled,
       ROW_NUMBER() OVER (ORDER BY is_active DESC, created_at ASC) AS seq
     FROM users
     WHERE (? = '' OR salon_name ILIKE ? OR email ILIKE ?)
     ORDER BY is_active DESC, created_at ASC
     LIMIT ? OFFSET ?`
  )
    .bind(q, likePattern, likePattern, TOOL_PAGE_SIZE, offset)
    .all<ToolSalonRow>()

  return c.render(
    <AdminPageLayout active="admin-tool" adminEmail={adminUser.email} title="ツール設定">
      <form method="get" action="/admin/tool" class="flex gap-2">
        <input
          type="text"
          name="q"
          value={q}
          placeholder="サロン名・メールアドレスで検索"
          class="flex-1 max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
        />
        <button
          type="submit"
          class="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm font-medium text-gray-700 transition"
        >
          検索
        </button>
        {q && (
          <a
            href="/admin/tool"
            class="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-gray-600 transition"
          >
            クリア
          </a>
        )}
      </form>

      <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th class="px-4 py-3 text-left font-medium">No.</th>
                <th class="px-4 py-3 text-left font-medium">サロン名</th>
                <th class="px-4 py-3 text-left font-medium">メールアドレス</th>
                <th class="px-4 py-3 text-left font-medium">スタイル機能</th>
                <th class="px-4 py-3 text-left font-medium">ブログ機能</th>
                <th class="px-4 py-3 text-left font-medium">SEO機能</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              {salons.map((salon) => (
                <tr>
                  <td class="px-4 py-3 text-gray-400">{salon.seq}</td>
                  <td class="px-4 py-3 font-medium text-gray-800">{salon.salon_name || '(未設定)'}</td>
                  <td class="px-4 py-3 text-gray-500">{salon.email}</td>
                  <td class="px-4 py-3">
                    <FeatureToggleForm
                      action={`/admin/tool/${salon.id}/toggle-style`}
                      page={page}
                      q={q}
                      enabled={salon.style_enabled === 1}
                      onLabel="有効"
                      offLabel="無効"
                    />
                  </td>
                  <td class="px-4 py-3">
                    <FeatureToggleForm
                      action={`/admin/tool/${salon.id}/toggle-blog`}
                      page={page}
                      q={q}
                      enabled={salon.blog_enabled === 1}
                      onLabel="有効"
                      offLabel="無効"
                    />
                  </td>
                  <td class="px-4 py-3">
                    <FeatureToggleForm
                      action={`/admin/tool/${salon.id}/toggle-seo`}
                      page={page}
                      q={q}
                      enabled={salon.seo_enabled === 1}
                      onLabel="有効"
                      offLabel="無効"
                    />
                  </td>
                </tr>
              ))}
              {salons.length === 0 && (
                <tr>
                  <td colspan={6} class="px-4 py-8 text-center text-gray-400">
                    該当するサロンがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div class="flex items-center justify-between text-sm text-gray-500">
        <span>
          {totalCount}件中 {totalCount === 0 ? 0 : offset + 1}〜{Math.min(offset + TOOL_PAGE_SIZE, totalCount)}
          件を表示
        </span>
        <div class="flex gap-3">
          {page > 1 && (
            <a href={buildToolListUrl(page - 1, q)} class="hover:text-pink-600">
              ← 前へ
            </a>
          )}
          <span class="text-gray-400">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <a href={buildToolListUrl(page + 1, q)} class="hover:text-pink-600">
              次へ →
            </a>
          )}
        </div>
      </div>
    </AdminPageLayout>,
    { title: 'ツール設定' }
  )
})

async function toggleSalonFeature(
  c: any,
  column: 'style_enabled' | 'blog_enabled' | 'seo_enabled',
  actionName: string
) {
  const adminUser = c.get('admin')
  const targetId = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const page = String(body.page || '1')
  const q = String(body.q || '')

  const target = (await c.env.DB.prepare(`SELECT id, email, ${column} as current_value FROM users WHERE id = ?`)
    .bind(targetId)
    .first()) as { id: number; email: string; current_value: number } | null
  if (target) {
    const nextValue = target.current_value === 1 ? 0 : 1
    await c.env.DB.prepare(`UPDATE users SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(nextValue, targetId)
      .run()
    await logAdminAction(
      c,
      adminUser.id,
      actionName,
      'user',
      targetId,
      `${target.email}: ${column} ${target.current_value} -> ${nextValue}`
    )
  }

  return c.redirect(buildToolListUrl(Number(page) || 1, q))
}

admin.post('/admin/tool/:id/toggle-style', (c) => toggleSalonFeature(c, 'style_enabled', 'toggle_salon_style_enabled'))
admin.post('/admin/tool/:id/toggle-blog', (c) => toggleSalonFeature(c, 'blog_enabled', 'toggle_salon_blog_enabled'))
admin.post('/admin/tool/:id/toggle-seo', (c) => toggleSalonFeature(c, 'seo_enabled', 'toggle_salon_seo_enabled'))

// ---------- 稼働状況 ----------
// スタイル自動投稿の連続失敗回数(users.consecutive_failure_count、
// automation.tsxのジョブ結果コールバックで更新)を一覧表示する。
// 5回以上連続失敗した/そこから復旧した瞬間はSNS経由でメール通知される
// (src/lib/sns-alert.ts、automation.tsxのupdateConsecutiveFailureAndNotify)。
// ブログは自動投稿機能が未実装のため対象外(実装後に別途追加する)。

const STATUS_PAGE_SIZE = 20
const CONSECUTIVE_FAILURE_ALERT_THRESHOLD = 5

type StatusSalonRow = {
  id: number
  email: string
  salon_name: string | null
  consecutive_failure_count: number
  is_active: number
  style_enabled: number
  seq: number
}

function buildStatusListUrl(page: number, q: string) {
  const params = new URLSearchParams()
  if (page > 1) params.set('page', String(page))
  if (q) params.set('q', q)
  const qs = params.toString()
  return '/admin/status' + (qs ? `?${qs}` : '')
}

admin.get('/admin/status', async (c) => {
  const adminUser = c.get('admin')
  const q = (c.req.query('q') || '').trim()
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1)
  const offset = (page - 1) * STATUS_PAGE_SIZE
  const likePattern = `%${q}%`

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM users WHERE (? = '' OR salon_name ILIKE ? OR email ILIKE ?)`
  )
    .bind(q, likePattern, likePattern)
    .first<{ cnt: number }>()
  const totalCount = countRow?.cnt ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / STATUS_PAGE_SIZE))

  // サロン一覧(/admin/salons)と同じ並び順(契約中を上位・契約外を最後尾)にする。
  const { results: salons } = await c.env.DB.prepare(
    `SELECT id, email, salon_name, consecutive_failure_count, is_active, style_enabled,
       ROW_NUMBER() OVER (ORDER BY is_active DESC, created_at ASC) AS seq
     FROM users
     WHERE (? = '' OR salon_name ILIKE ? OR email ILIKE ?)
     ORDER BY is_active DESC, created_at ASC
     LIMIT ? OFFSET ?`
  )
    .bind(q, likePattern, likePattern, STATUS_PAGE_SIZE, offset)
    .all<StatusSalonRow>()

  const alertingCount = salons.filter((s) => s.consecutive_failure_count >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD).length

  return c.render(
    <AdminPageLayout active="admin-status" adminEmail={adminUser.email} title="稼働状況">
      {alertingCount > 0 && (
        <div class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-triangle-exclamation mr-2"></i>
          このページ内に{CONSECUTIVE_FAILURE_ALERT_THRESHOLD}回以上連続で失敗しているサロンが{alertingCount}件あります
        </div>
      )}

      <form method="get" action="/admin/status" class="flex gap-2">
        <input
          type="text"
          name="q"
          value={q}
          placeholder="サロン名・メールアドレスで検索"
          class="flex-1 max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
        />
        <button
          type="submit"
          class="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-sm font-medium text-gray-700 transition"
        >
          検索
        </button>
        {q && (
          <a
            href="/admin/status"
            class="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-gray-600 transition"
          >
            クリア
          </a>
        )}
      </form>

      <div class="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th class="px-4 py-3 text-left font-medium">No.</th>
                <th class="px-4 py-3 text-left font-medium">サロン名</th>
                <th class="px-4 py-3 text-left font-medium">メールアドレス</th>
                <th class="px-4 py-3 text-left font-medium">スタイル連続失敗</th>
                <th class="px-4 py-3 text-left font-medium">状態</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              {salons.map((salon) => {
                const isAlerting = salon.consecutive_failure_count >= CONSECUTIVE_FAILURE_ALERT_THRESHOLD
                const isInactive = salon.is_active === 0 || salon.style_enabled === 0
                return (
                  <tr>
                    <td class="px-4 py-3 text-gray-400">{salon.seq}</td>
                    <td class="px-4 py-3 font-medium text-gray-800">{salon.salon_name || '(未設定)'}</td>
                    <td class="px-4 py-3 text-gray-500">{salon.email}</td>
                    <td class="px-4 py-3 text-gray-700">{salon.consecutive_failure_count}回</td>
                    <td class="px-4 py-3">
                      {isInactive ? (
                        <span class="text-xs px-2 py-0.5 rounded font-semibold bg-gray-100 text-gray-400">
                          対象外(契約OFF/機能OFF)
                        </span>
                      ) : isAlerting ? (
                        <span class="text-xs px-2 py-0.5 rounded font-semibold bg-red-50 text-red-600">
                          異常({CONSECUTIVE_FAILURE_ALERT_THRESHOLD}回以上連続失敗)
                        </span>
                      ) : (
                        <span class="text-xs px-2 py-0.5 rounded font-semibold bg-green-50 text-green-600">正常</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {salons.length === 0 && (
                <tr>
                  <td colspan={5} class="px-4 py-8 text-center text-gray-400">
                    該当するサロンがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div class="flex items-center justify-between text-sm text-gray-500">
        <span>
          {totalCount}件中 {totalCount === 0 ? 0 : offset + 1}〜{Math.min(offset + STATUS_PAGE_SIZE, totalCount)}
          件を表示
        </span>
        <div class="flex gap-3">
          {page > 1 && (
            <a href={buildStatusListUrl(page - 1, q)} class="hover:text-pink-600">
              ← 前へ
            </a>
          )}
          <span class="text-gray-400">
            {page} / {totalPages}
          </span>
          {page < totalPages && (
            <a href={buildStatusListUrl(page + 1, q)} class="hover:text-pink-600">
              次へ →
            </a>
          )}
        </div>
      </div>
    </AdminPageLayout>,
    { title: '稼働状況' }
  )
})

export default admin
