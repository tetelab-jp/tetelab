import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { verifyJwt } from './jwt'
import type { Bindings, AppUser } from '../types'

export const SESSION_COOKIE_NAME = 'session'

/**
 * ログイン必須ルート用ミドルウェア。
 * Cookieのセッションを検証し、有効ならc.set('user', ...)して次へ。
 * 無効ならログイン画面へリダイレクト（ページ）または401（API）を返す。
 */
export async function requireAuth(
  c: Context<{ Bindings: Bindings; Variables: { user: AppUser } }>,
  next: Next
) {
  const token = getCookie(c, SESSION_COOKIE_NAME)
  const secret = c.env.JWT_SECRET || 'dev-insecure-secret-change-me'

  if (!token) {
    return redirectOrUnauthorized(c)
  }

  const payload = await verifyJwt(token, secret)
  if (!payload) {
    return redirectOrUnauthorized(c)
  }

  // DBから最新のユーザー情報を取得(削除済みでないか等の確認も兼ねる)
  const user = await c.env.DB.prepare(
    'SELECT id, email, salon_name, is_active, style_enabled, blog_enabled, seo_enabled FROM users WHERE id = ?'
  )
    .bind(payload.sub)
    .first<AppUser>()

  if (!user) {
    return redirectOrUnauthorized(c)
  }

  // 管理者サイト(/admin/salons)で契約OFFにされたサロンはログイン状態でも締め出す。
  if (user.is_active === 0) {
    return redirectOrUnauthorized(c, '現在このアカウントはご利用いただけません。詳しくは運営までお問い合わせください。')
  }

  c.set('user', user)
  await next()
}

/**
 * 管理者サイト(/admin/tool)でスタイル機能をOFFにされたサロンを、
 * スタイル関連の全ルート・APIから締め出すミドルウェア。requireAuthの後に使う。
 */
export async function requireStyleEnabled(
  c: Context<{ Bindings: Bindings; Variables: { user: AppUser } }>,
  next: Next
) {
  const user = c.get('user')
  if (user.style_enabled === 0) {
    return redirectOrUnauthorized(c, 'スタイル自動投稿機能は現在ご利用いただけません。詳しくは運営までお問い合わせください。', '/dashboard')
  }
  await next()
}

/** requireStyleEnabledのブログ版。 */
export async function requireBlogEnabled(
  c: Context<{ Bindings: Bindings; Variables: { user: AppUser } }>,
  next: Next
) {
  const user = c.get('user')
  if (user.blog_enabled === 0) {
    return redirectOrUnauthorized(c, 'ブログ自動投稿機能は現在ご利用いただけません。詳しくは運営までお問い合わせください。', '/dashboard')
  }
  await next()
}

/** requireStyleEnabledのSEO版。/seo/*・/api/seo/* ルートで使う想定。 */
export async function requireSeoEnabled(
  c: Context<{ Bindings: Bindings; Variables: { user: AppUser } }>,
  next: Next
) {
  const user = c.get('user')
  if (user.seo_enabled === 0) {
    return redirectOrUnauthorized(c, 'SEO機能は現在ご利用いただけません。詳しくは運営までお問い合わせください。', '/dashboard')
  }
  await next()
}

function redirectOrUnauthorized(c: Context, message?: string, redirectTo = '/login') {
  const isApi = c.req.path.startsWith('/api/')
  if (isApi) {
    return c.json({ error: message || 'ログインが必要です' }, isApi && redirectTo !== '/login' ? 403 : 401)
  }
  return c.redirect(redirectTo + (message ? '?error=' + encodeURIComponent(message) : ''))
}
