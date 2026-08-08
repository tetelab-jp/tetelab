import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { renderer } from './renderer'
import auth from './routes/auth'
import dashboard from './routes/dashboard'
import style from './routes/style'
import blog from './routes/blog'
import automation from './routes/automation'
import { SESSION_COOKIE_NAME } from './lib/auth-middleware'
import { verifyJwt } from './lib/jwt'
import type { Bindings } from './types'

const app = new Hono<{ Bindings: Bindings }>()

app.use(renderer)

// トップページ: ログイン状態に応じてリダイレクト
app.get('/', async (c) => {
  const token = getCookie(c, SESSION_COOKIE_NAME)
  const secret = c.env.JWT_SECRET || 'dev-insecure-secret-change-me'
  if (token && (await verifyJwt(token, secret))) {
    return c.redirect('/dashboard')
  }
  return c.redirect('/login')
})

// automationはdashboard/style/blogより先にマウントする。
// dashboard/style/blogは各々 .use('*', requireAuth) でその配下の全パスを
// セッション認証必須にしているが、Honoは app.route('/', subApp) をこの順で
// 試した際、subApp内で該当パスにルートが無くても '*' ミドルウェアが先に
// 401/redirectを返してしまい、後続のsubAppへフォールスルーしない。
// automation.tsxの /api/cron/run-style-posts は外部Cronサービスから
// CRON_SECRET(Bearerトークン)のみで呼ばれる想定のため、セッションCookieが
// 無くても到達できる必要がある。dashboard/style/blogより先にマウントすることで、
// automation自身が明示的にrequireAuthを付けているルート(/style/test-run等)は
// 従来通り認証必須のまま、cron用ルートだけは認証不要で到達できるようにする。
app.route('/', auth)
app.route('/', automation)
app.route('/', dashboard)
app.route('/', style)
app.route('/', blog)

export default app
