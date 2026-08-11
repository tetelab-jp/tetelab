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
import { createDb } from './lib/db'
import { createStorage } from './lib/storage'
import type { Bindings } from './types'

const app = new Hono<{ Bindings: Bindings }>()

// Cloudflare Workers環境ではc.envはランタイムが自動注入していたが、
// Node常駐サーバーではその仕組みが無いため、起動時に一度だけ組み立てた
// Bindings相当のオブジェクトを、最初のミドルウェアでc.envへ手動で
// セットする。DB/STYLE_IMAGESはD1/R2互換シム(db.ts/storage.ts)なので、
// これ以降の約130箇所のc.env.DB / c.env.STYLE_IMAGES呼び出しは無改修で動く。
function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`環境変数 ${name} が設定されていません`)
  return v
}

const bindings: Bindings = {
  DB: createDb(requireEnv('DATABASE_URL')),
  STYLE_IMAGES: createStorage(requireEnv('STYLE_IMAGES_BUCKET'), requireEnv('AWS_REGION')),
  JWT_SECRET: process.env.JWT_SECRET,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  CRON_SECRET: process.env.CRON_SECRET,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION,
  ECS_CLUSTER: process.env.ECS_CLUSTER,
  ECS_TASK_DEFINITION: process.env.ECS_TASK_DEFINITION,
  ECS_CONTAINER_NAME: process.env.ECS_CONTAINER_NAME,
  ECS_SUBNET_IDS: process.env.ECS_SUBNET_IDS,
  ECS_SECURITY_GROUP_IDS: process.env.ECS_SECURITY_GROUP_IDS
}

// 2026-08-11追記: マイグレーション専用のランナーが無いため、追加列のような
// 後方互換な(既存データを壊さない)スキーマ変更はアプリ起動時に冪等
// (IF NOT EXISTS)に自動適用する。詳細はmigrations-pg/0002_*.sql参照。
;(async () => {
  try {
    await bindings.DB.prepare(
      `ALTER TABLE salon_credentials ADD COLUMN IF NOT EXISTS last_successful_proxy_session_id TEXT`
    ).run()
    await bindings.DB.prepare(
      `ALTER TABLE salon_credentials ADD COLUMN IF NOT EXISTS last_successful_proxy_session_at TIMESTAMP`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(salon_credentials拡張列)に失敗しました:', err)
  }
  try {
    // 実行履歴(style_post_runs)の一覧ステータスが常に'processing'のまま
    // 更新されない不具合の修正用: どのジョブがどの実行(run)に属するかを
    // 記録できるようにする(詳細はmigrations-pg/0003_*.sql参照)。
    await bindings.DB.prepare(
      `ALTER TABLE style_post_jobs ADD COLUMN IF NOT EXISTS run_id INTEGER REFERENCES style_post_runs(id) ON DELETE SET NULL`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(style_post_jobs.run_id)に失敗しました:', err)
  }
})()

app.use('*', async (c, next) => {
  c.env = bindings
  await next()
})

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
