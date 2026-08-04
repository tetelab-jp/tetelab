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

app.route('/', auth)
app.route('/', dashboard)
app.route('/', style)
app.route('/', blog)
app.route('/', automation)

export default app
