import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import { hashPassword, verifyPasswordConstantTime } from '../lib/crypto'
import { signJwt } from '../lib/jwt'
import { SESSION_COOKIE_NAME } from '../lib/auth-middleware'
import type { Bindings } from '../types'

const auth = new Hono<{ Bindings: Bindings }>()

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7 // 7日間

function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null
  return (
    <div class="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">
      <i class="fas fa-circle-exclamation mr-2"></i>
      {message}
    </div>
  )
}

function AuthLayout({ children }: { children: any }) {
  return (
    <div class="min-h-screen flex items-center justify-center px-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-6">
          <img src="/static/logo-combined.png" alt="SalonMotion" class="inline-block h-14 w-auto" />
          <p class="text-sm text-gray-500 mt-2">ホットペッパービューティー連携SaaS</p>
        </div>
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-8">{children}</div>
      </div>
    </div>
  )
}

// ---------- Signup ----------

auth.get('/signup', (c) => {
  const error = c.req.query('error')
  return c.render(
    <AuthLayout>
      <h2 class="text-lg font-bold mb-6">新規登録</h2>
      <ErrorBanner message={error} />
      <form method="post" action="/signup" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">サロン名</label>
          <input
            type="text"
            name="salon_name"
            placeholder="例）サロンパラダイス渋谷店"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">メールアドレス</label>
          <input
            required
            type="email"
            name="email"
            placeholder="owner@example.com"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">パスワード（8文字以上）</label>
          <input
            required
            minlength={8}
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
          登録する
        </button>
      </form>
      <p class="text-sm text-gray-500 mt-6 text-center">
        すでにアカウントをお持ちの方は{' '}
        <a href="/login" class="text-pink-600 font-medium hover:underline">
          ログイン
        </a>
      </p>
    </AuthLayout>,
    { title: '新規登録' }
  )
})

auth.post('/signup', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const salonName = String(body.salon_name || '').trim() || null

  if (!email || password.length < 8) {
    return c.redirect('/signup?error=' + encodeURIComponent('メールアドレスと8文字以上のパスワードを入力してください'))
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) {
    return c.redirect('/signup?error=' + encodeURIComponent('このメールアドレスは既に登録されています'))
  }

  const passwordHash = await hashPassword(password)
  // 契約状況(is_active)は既定のDEFAULT 1(契約中)のままでよいが、スタイル/
  // ブログ/SEOの各機能は、管理者サイト(/admin/tool)で有効化するまでは
  // 使わせない運用のため、新規登録時は明示的にOFFで作成する。
  const result = await c.env.DB.prepare(
    'INSERT INTO users (email, password_hash, salon_name, style_enabled, blog_enabled, seo_enabled) VALUES (?, ?, ?, 0, 0, 0)'
  )
    .bind(email, passwordHash, salonName)
    .run()

  const userId = result.meta.last_row_id as number

  // 複数サロンワークスペース対応 フェーズ1: 新規登録時点で「1つ目のサロン
  // ワークスペース」をプレースホルダーとして作成し、active_salon_idを確定
  // させる。salon_key=NULLのため、後日サロンボード連携を実際に同期すると
  // upsertSalonInfo()の「salon_key一致→無ければsalon_name一致」フォール
  // バックでこの行にUPDATEされる(新規行は増えない、既存のsrc/index.tsx
  // フェーズ0バックフィルと同じロジック)。
  const placeholderSalon = await c.env.DB.prepare(
    `INSERT INTO salonboard_salons (user_id, salon_key, salon_name, is_active_workspace, activated_at)
     VALUES (?, NULL, ?, 1, CURRENT_TIMESTAMP)`
  )
    .bind(userId, salonName || '(未設定)')
    .run()
  const placeholderSalonId = placeholderSalon.meta.last_row_id as number
  await c.env.DB.prepare('UPDATE users SET active_salon_id = ? WHERE id = ?')
    .bind(placeholderSalonId, userId)
    .run()

  await setSession(c, userId, email)
  // 複数サロン対応: 登録直後はサロンボード連携ウィザード(/settings/salonboard)へ
  // 進んでもらう(そのままダッシュボードに出しても未連携バナーから同じ場所へ
  // 誘導されるだけなので、最初から一体化した導線にする)。
  return c.redirect('/settings/salonboard')
})

// ---------- Login ----------

auth.get('/login', (c) => {
  const error = c.req.query('error')
  return c.render(
    <AuthLayout>
      <h2 class="text-lg font-bold mb-6">ログイン</h2>
      <ErrorBanner message={error} />
      <form method="post" action="/login" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">メールアドレス</label>
          <input
            required
            type="email"
            name="email"
            placeholder="owner@example.com"
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
      <p class="text-sm text-gray-500 mt-4 text-center">
        <a href="/forgot-password" class="text-gray-400 hover:text-gray-600 hover:underline">
          パスワードをお忘れの方はこちら
        </a>
      </p>
      <p class="text-sm text-gray-500 mt-2 text-center">
        アカウントをお持ちでない方は{' '}
        <a href="/signup" class="text-pink-600 font-medium hover:underline">
          新規登録
        </a>
      </p>
    </AuthLayout>,
    { title: 'ログイン' }
  )
})

// ---------- Forgot password ----------
// 2026-08-14追記: メール送信基盤(SES等)を持たないため、本格的な自動リセット
// フローではなく、サポート窓口への問い合わせ案内のみを表示する簡易ページ。
auth.get('/forgot-password', (c) => {
  return c.render(
    <AuthLayout>
      <h2 class="text-lg font-bold mb-4">パスワードをお忘れの方</h2>
      <p class="text-sm text-gray-600 leading-relaxed">
        大変お手数ですが、現在パスワードの自動再設定には対応しておりません。
        <br />
        ご登録のメールアドレスを添えて、サポート窓口までお問い合わせください。
        パスワードの再設定を代行いたします。
      </p>
      <p class="text-sm text-gray-500 mt-6 text-center">
        <a href="/login" class="text-pink-600 font-medium hover:underline">
          ログイン画面に戻る
        </a>
      </p>
    </AuthLayout>,
    { title: 'パスワードをお忘れの方' }
  )
})

// 2026-08-13追記(監査指摘の是正): ブルートフォース対策が皆無だったため追加。
// 同一アカウントへの失敗が一定回数溜まったら一時的にロックする。
const MAX_FAILED_LOGIN_ATTEMPTS = 10
const LOGIN_LOCKOUT_MINUTES = 15

auth.post('/login', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').trim().toLowerCase()
  const password = String(body.password || '')
  const wrongCredsError = () =>
    c.redirect('/login?error=' + encodeURIComponent('メールアドレスまたはパスワードが正しくありません'))

  const user = await c.env.DB.prepare(
    'SELECT id, email, password_hash, failed_login_count, login_locked_until FROM users WHERE email = ?'
  )
    .bind(email)
    .first<{
      id: number
      email: string
      password_hash: string
      failed_login_count: number
      login_locked_until: string | null
    }>()

  if (user?.login_locked_until) {
    const lockedUntilMs = new Date(user.login_locked_until.replace(' ', 'T') + 'Z').getTime()
    if (lockedUntilMs > Date.now()) {
      return c.redirect(
        '/login?error=' +
          encodeURIComponent('ログイン試行が続けて失敗したため、しばらく時間をおいてから再度お試しください')
      )
    }
  }

  // 未登録メールでもPBKDF2検証の計算コストを払い、応答時間差での
  // メールアドレス在不在の推測(ユーザー列挙)を避ける。
  const valid = await verifyPasswordConstantTime(password, user?.password_hash ?? null)

  if (!user || !valid) {
    if (user) {
      await c.env.DB.prepare(
        `UPDATE users SET failed_login_count = failed_login_count + 1,
           login_locked_until = CASE
             WHEN failed_login_count + 1 >= ? THEN now() + (? || ' minutes')::interval
             ELSE login_locked_until
           END
         WHERE id = ?`
      )
        .bind(MAX_FAILED_LOGIN_ATTEMPTS, LOGIN_LOCKOUT_MINUTES, user.id)
        .run()
    }
    return wrongCredsError()
  }

  if (user.failed_login_count > 0 || user.login_locked_until) {
    await c.env.DB.prepare('UPDATE users SET failed_login_count = 0, login_locked_until = NULL WHERE id = ?')
      .bind(user.id)
      .run()
  }

  await setSession(c, user.id, user.email)
  return c.redirect('/dashboard')
})

// ---------- Logout ----------

auth.post('/logout', (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' })
  return c.redirect('/login')
})

async function setSession(c: any, userId: number, email: string) {
  const secret = c.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRETが未設定です')
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  const token = await signJwt({ sub: userId, email, exp }, secret)
  // ALB配下ではTLSがALBで終端され、コンテナへは平文HTTPで届くため
  // c.req.url は常に http:// になる。ALBが付与するX-Forwarded-Protoで判定する。
  const isHttps = c.req.header('x-forwarded-proto') === 'https' || c.req.url.startsWith('https://')
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS
  })
}

export default auth
