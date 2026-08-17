import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { verifyJwt } from './jwt'
import type { Bindings, AdminUser } from '../types'

// サロン側のセッション(SESSION_COOKIE_NAME='session')とは完全に別のCookie名・
// 別の秘密鍵(ADMIN_JWT_SECRET)を使う。サロン側のJWTが誤って管理者として
// 通ってしまうことを構造的に防ぐため。
export const ADMIN_SESSION_COOKIE_NAME = 'admin_session'

/**
 * /admin配下のログイン必須ルート用ミドルウェア。requireAuth(サロン側)と
 * 同じ形だが、admin_usersテーブル・admin_session Cookie・ADMIN_JWT_SECRETを
 * 参照する点が異なる。
 */
export async function requireAdminAuth(
  c: Context<{ Bindings: Bindings; Variables: { admin: AdminUser } }>,
  next: Next
) {
  const token = getCookie(c, ADMIN_SESSION_COOKIE_NAME)
  const secret = c.env.ADMIN_JWT_SECRET
  if (!secret) {
    // JWT_SECRET同様の「未設定時は固定文字列にフォールバック」は管理者認証では
    // 行わない(セキュリティ上のフォールバック回避)。未設定は設定不備として
    // 明確にエラーにする。
    return c.text('管理者認証の設定が不足しています(ADMIN_JWT_SECRET未設定)', 500)
  }

  if (!token) {
    return redirectOrUnauthorized(c)
  }

  const payload = await verifyJwt(token, secret)
  if (!payload) {
    return redirectOrUnauthorized(c)
  }

  const admin = await c.env.DB.prepare('SELECT id, email FROM admin_users WHERE id = ?')
    .bind(payload.sub)
    .first<AdminUser>()

  if (!admin) {
    return redirectOrUnauthorized(c)
  }

  c.set('admin', admin)
  await next()
}

function redirectOrUnauthorized(c: Context) {
  const isApi = c.req.path.startsWith('/api/')
  if (isApi) {
    return c.json({ error: '管理者ログインが必要です' }, 401)
  }
  return c.redirect('/admin')
}

// 2026-08-17追記(ユーザー指定): 複数端末で管理者サイトを操作した際、片方の
// 端末でのサロン一覧・機能設定の変更が、もう片方の端末に反映されないという
// 報告があった。DB書き込み自体はUPDATE→リダイレクトの同期処理で完結しており
// 不整合の余地は無いため、原因はブラウザ側のキャッシュ(戻る/進む操作や
// 再訪問時にサーバーへ再取得せず古い描画結果をそのまま表示してしまうこと)と
// 見て、/admin配下の全レスポンスに明示的なキャッシュ禁止ヘッダーを付与する。
export async function noCacheHeaders(c: Context, next: Next) {
  await next()
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate')
  c.header('Pragma', 'no-cache')
}
