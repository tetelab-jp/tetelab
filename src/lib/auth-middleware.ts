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
    'SELECT id, email, salon_name FROM users WHERE id = ?'
  )
    .bind(payload.sub)
    .first<AppUser>()

  if (!user) {
    return redirectOrUnauthorized(c)
  }

  c.set('user', user)
  await next()
}

function redirectOrUnauthorized(c: Context) {
  const isApi = c.req.path.startsWith('/api/')
  if (isApi) {
    return c.json({ error: 'ログインが必要です' }, 401)
  }
  return c.redirect('/login')
}
