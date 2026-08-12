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
    'SELECT id, email, salon_name, is_active FROM users WHERE id = ?'
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

function redirectOrUnauthorized(c: Context, message?: string) {
  const isApi = c.req.path.startsWith('/api/')
  if (isApi) {
    return c.json({ error: message || 'ログインが必要です' }, 401)
  }
  return c.redirect('/login' + (message ? '?error=' + encodeURIComponent(message) : ''))
}
