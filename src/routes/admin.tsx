import { Hono } from 'hono'
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import { hashPassword, verifyPassword } from '../lib/crypto'
import { signJwt, verifyJwt } from '../lib/jwt'
import { ADMIN_SESSION_COOKIE_NAME, requireAdminAuth } from '../lib/admin-auth-middleware'
import { AdminPageLayout } from '../components/admin-layout'
import type { Bindings, AdminUser } from '../types'

const admin = new Hono<{ Bindings: Bindings; Variables: { admin: AdminUser } }>()

const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 12 // 12時間(サロン側の7日より短く、管理者権限のリスクを踏まえ短めにする)

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

admin.post('/admin', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')

  const adminRow = await c.env.DB.prepare('SELECT id, email, password_hash FROM admin_users WHERE email = ?')
    .bind(email)
    .first<{ id: number; email: string; password_hash: string }>()

  if (!adminRow) {
    return c.redirect('/admin?error=' + encodeURIComponent('メールアドレスまたはパスワードが正しくありません'))
  }

  const valid = await verifyPassword(password, adminRow.password_hash)
  if (!valid) {
    return c.redirect('/admin?error=' + encodeURIComponent('メールアドレスまたはパスワードが正しくありません'))
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

// 2026-08-12追記: サロン一覧・ツール設定・稼働状況の各画面は次のステップで
// 実装する(実装指示書6章の段階的な進め方に沿って、まずはログイン導線・
// 認証ガードのみをここで確認できるようにする)。
admin.get('/admin/salons', (c) => {
  const adminUser = c.get('admin')
  return c.render(
    <AdminPageLayout active="admin-salons" adminEmail={adminUser.email} title="サロン一覧">
      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="text-sm text-gray-500">
          管理者ログインに成功しました（{adminUser.email}）。サロン一覧はこの後の実装ステップで追加します。
        </p>
      </div>
    </AdminPageLayout>,
    { title: 'サロン一覧' }
  )
})

export default admin
