import { Hono } from 'hono'
import { setCookie, deleteCookie } from 'hono/cookie'
import {
  hashPassword,
  verifyPasswordConstantTime,
  generatePasswordResetToken,
  hashPasswordResetToken
} from '../lib/crypto'
import { signJwt } from '../lib/jwt'
import { SESSION_COOKIE_NAME } from '../lib/auth-middleware'
import { sendEmail } from '../lib/ses-email'
import { publishAlert } from '../lib/sns-alert'
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
          <label class="block text-sm font-medium text-gray-700 mb-1">氏名（代表者または管理者）</label>
          <div class="grid grid-cols-2 gap-2">
            <input
              required
              type="text"
              name="last_name"
              placeholder="姓"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
            />
            <input
              required
              type="text"
              name="first_name"
              placeholder="名"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
            />
          </div>
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
  const lastName = String(body.last_name || '').trim()
  const firstName = String(body.first_name || '').trim()
  // 2026-08-14追記(ユーザー指定): 「サロン名」だった項目を「氏名(代表者
  // または管理者)」に変更し、姓・名を分けて入力してもらう。DB上は既存の
  // usersテーブルのsalon_name列に「姓 名」の形で結合して保存する(この列の
  // 用途をサロン名から代表者氏名へ切り替える。実際のサロン名はsalonboard_
  // salons.salon_nameで別管理されているため、ブログ記事フッター等の顧客に
  // 見える箇所はそちらを参照するようblog.tsx側を修正済み)。
  const salonName = lastName && firstName ? `${lastName} ${firstName}` : null

  if (!email || password.length < 8) {
    return c.redirect('/signup?error=' + encodeURIComponent('メールアドレスと8文字以上のパスワードを入力してください'))
  }
  if (!lastName || !firstName) {
    return c.redirect('/signup?error=' + encodeURIComponent('氏名（姓・名）を入力してください'))
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
  const saved = c.req.query('saved')
  return c.render(
    <AuthLayout>
      <h2 class="text-lg font-bold mb-6">ログイン</h2>
      {saved && (
        <div class="mb-4 rounded-lg bg-green-50 border border-green-200 text-green-700 px-4 py-3 text-sm">
          <i class="fas fa-circle-check mr-2"></i>
          パスワードを再設定しました。新しいパスワードでログインしてください。
        </div>
      )}
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
// 2026-08-15追記: SES(メール送信基盤)を導入したため、メールリンク方式の
// 自動再設定フローに変更した(infra/ses.tf、src/lib/ses-email.ts参照)。
// SESのドメイン検証・サンドボックス解除が完了するまでは実際のメール送信は
// 失敗するため、その場合は画面上も送信失敗として案内する。

const PASSWORD_RESET_TOKEN_TTL_MINUTES = 30

auth.get('/forgot-password', (c) => {
  const sent = c.req.query('sent')
  const error = c.req.query('error')
  return c.render(
    <AuthLayout>
      <h2 class="text-lg font-bold mb-4">パスワードをお忘れの方</h2>
      {sent ? (
        <div class="space-y-3">
          <p class="text-sm text-gray-600 leading-relaxed">
            ご入力いただいたメールアドレス宛に、パスワード再設定用のリンクを送信しました
            (該当するアカウントが存在する場合のみ届きます)。メール内のリンクから
            {PASSWORD_RESET_TOKEN_TTL_MINUTES}分以内に新しいパスワードを設定してください。
          </p>
          <p class="text-xs text-gray-500 leading-relaxed bg-gray-50 rounded-lg px-3 py-2.5">
            数分経ってもメールが届かない場合は、迷惑メールフォルダをご確認いただくか、
            お手数ですが運営までお問い合わせください。
          </p>
        </div>
      ) : (
        <>
          <ErrorBanner message={error} />
          <p class="text-sm text-gray-600 leading-relaxed mb-4">
            ご登録のメールアドレスを入力してください。パスワード再設定用のリンクをお送りします。
          </p>
          <form method="post" action="/forgot-password" class="space-y-4">
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
            <button
              type="submit"
              class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition"
            >
              再設定用リンクを送信する
            </button>
          </form>
        </>
      )}
      <p class="text-sm text-gray-500 mt-6 text-center">
        <a href="/login" class="text-pink-600 font-medium hover:underline">
          ログイン画面に戻る
        </a>
      </p>
    </AuthLayout>,
    { title: 'パスワードをお忘れの方' }
  )
})

auth.post('/forgot-password', async (c) => {
  const body = await c.req.parseBody()
  const email = String(body.email || '').trim().toLowerCase()

  // 2026-08-13追記のverifyPasswordConstantTimeと同じ考え方: 登録有無に関わらず
  // 常に同じ「送信しました」画面を返し、メールアドレスの登録有無を推測されないようにする。
  if (email) {
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: number }>()
    if (user) {
      const token = generatePasswordResetToken()
      const tokenHash = await hashPasswordResetToken(token)
      await c.env.DB.prepare(
        `UPDATE users SET password_reset_token_hash = ?,
           password_reset_expires_at = NOW() + (? || ' minutes')::interval WHERE id = ?`
      )
        .bind(tokenHash, PASSWORD_RESET_TOKEN_TTL_MINUTES, user.id)
        .run()

      const baseUrl = c.env.APP_BASE_URL || new URL(c.req.url).origin
      const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`
      const result = await sendEmail(
        c.env,
        email,
        '【SalonMotion】パスワード再設定のご案内',
        `SalonMotionのパスワード再設定用リンクです。\n\n${resetUrl}\n\n` +
          `このリンクの有効期限は${PASSWORD_RESET_TOKEN_TTL_MINUTES}分です。\n` +
          `心当たりがない場合は、このメールを破棄してください。`
      )
      // 画面上は(なりすまし対策のため)常に「送信しました」と表示するため、
      // 送信失敗自体はユーザーには伝わらない。気づけるよう管理者へアラート
      // 通知する(既存のCloudWatchアラームと同じSNSトピック、sns-alert.ts参照)。
      if (!result.success) {
        await publishAlert(
          c.env,
          '[SalonMotion] パスワード再設定メールの送信に失敗',
          `user_id=${user.id} email=${email}\n${result.error || '(詳細不明)'}`
        ).catch(() => {})
      }
    }
  }

  return c.redirect('/forgot-password?sent=1')
})

// ---------- Reset password ----------

auth.get('/reset-password', (c) => {
  const token = c.req.query('token') || ''
  const error = c.req.query('error')
  return c.render(
    <AuthLayout>
      <h2 class="text-lg font-bold mb-6">新しいパスワードの設定</h2>
      <ErrorBanner message={error} />
      {token ? (
        <form method="post" action="/reset-password" class="space-y-4">
          <input type="hidden" name="token" value={token} />
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">新しいパスワード</label>
            <input
              required
              type="password"
              name="new_password"
              autocomplete="new-password"
              placeholder="8文字以上"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
            />
          </div>
          <button
            type="submit"
            class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition"
          >
            パスワードを再設定する
          </button>
        </form>
      ) : (
        <p class="text-sm text-red-600">
          再設定用のリンクが正しくありません。
          <a href="/forgot-password" class="text-pink-600 hover:underline">
            こちら
          </a>
          から再度お試しください。
        </p>
      )}
    </AuthLayout>,
    { title: '新しいパスワードの設定' }
  )
})

auth.post('/reset-password', async (c) => {
  const body = await c.req.parseBody()
  const token = String(body.token || '')
  const newPassword = String(body.new_password || '')

  const redirectError = (message: string) =>
    c.redirect(`/reset-password?token=${encodeURIComponent(token)}&error=${encodeURIComponent(message)}`)

  if (!token) {
    return c.redirect('/forgot-password')
  }
  if (newPassword.length < 8) {
    return redirectError('新しいパスワードは8文字以上で入力してください')
  }

  const tokenHash = await hashPasswordResetToken(token)
  const user = await c.env.DB.prepare(
    `SELECT id FROM users WHERE password_reset_token_hash = ? AND password_reset_expires_at > NOW()`
  )
    .bind(tokenHash)
    .first<{ id: number }>()

  if (!user) {
    return redirectError('リンクの有効期限が切れているか、既に使用されています。お手数ですが再度お試しください')
  }

  const passwordHash = await hashPassword(newPassword)
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_reset_token_hash = NULL, password_reset_expires_at = NULL,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(passwordHash, user.id)
    .run()

  return c.redirect('/login?saved=1')
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
