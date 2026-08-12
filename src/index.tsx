import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { renderer } from './renderer'
import auth from './routes/auth'
import dashboard from './routes/dashboard'
import style from './routes/style'
import blog from './routes/blog'
import automation from './routes/automation'
import ranking from './routes/ranking'
import admin from './routes/admin'
import { SESSION_COOKIE_NAME } from './lib/auth-middleware'
import { verifyJwt } from './lib/jwt'
import { hashPassword } from './lib/crypto'
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
  RANKING_PROXY_URL: process.env.RANKING_PROXY_URL,
  APP_BASE_URL: process.env.APP_BASE_URL,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION,
  ECS_CLUSTER: process.env.ECS_CLUSTER,
  ECS_TASK_DEFINITION: process.env.ECS_TASK_DEFINITION,
  ECS_CONTAINER_NAME: process.env.ECS_CONTAINER_NAME,
  ECS_SUBNET_IDS: process.env.ECS_SUBNET_IDS,
  ECS_SECURITY_GROUP_IDS: process.env.ECS_SECURITY_GROUP_IDS,
  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
  ADMIN_INITIAL_PASSWORD: process.env.ADMIN_INITIAL_PASSWORD
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
  try {
    // 個別実行ログのNo.表示を、実行時点の登録スタイル一覧の並び順で
    // スナップショットしておくための拡張列(詳細はmigrations-pg/0004_*.sql参照)。
    await bindings.DB.prepare(`ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS style_no INTEGER`).run()
  } catch (err) {
    console.error('起動時マイグレーション(execution_logs.style_no)に失敗しました:', err)
  }
  try {
    // 検索順位計測の新規テーブル群。専用ランナーが無いため起動時に冪等作成する。
    // スキーマの正本は migrations-pg/0005_ranking.sql。
    const rankingDdl = [
      `CREATE TABLE IF NOT EXISTS salonboard_salons (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, salon_key TEXT, salon_name TEXT NOT NULL, hpb_sln_id TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS idx_salonboard_salons_user_id ON salonboard_salons(user_id)`,
      `CREATE TABLE IF NOT EXISTS ranking_areas (id SERIAL PRIMARY KEY, level INTEGER NOT NULL, service_area_cd TEXT NOT NULL, middle_area_cd TEXT, small_area_cd TEXT, name TEXT NOT NULL, url TEXT, parent_id INTEGER REFERENCES ranking_areas(id) ON DELETE CASCADE, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS idx_ranking_areas_parent ON ranking_areas(parent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ranking_areas_level ON ranking_areas(level)`,
      `CREATE TABLE IF NOT EXISTS ranking_queries (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT, salon_name TEXT NOT NULL, service_area_cd TEXT NOT NULL, middle_area_cd TEXT, small_area_cd TEXT, area_label TEXT, is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS idx_ranking_queries_user_id ON ranking_queries(user_id)`,
      `CREATE TABLE IF NOT EXISTS ranking_query_keywords (id SERIAL PRIMARY KEY, query_id INTEGER NOT NULL REFERENCES ranking_queries(id) ON DELETE CASCADE, keyword TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS idx_ranking_query_keywords_query_id ON ranking_query_keywords(query_id)`,
      `CREATE TABLE IF NOT EXISTS ranking_runs (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, trigger TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'running', started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS idx_ranking_runs_user_id ON ranking_runs(user_id)`,
      `CREATE TABLE IF NOT EXISTS ranking_results (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, run_id INTEGER REFERENCES ranking_runs(id) ON DELETE CASCADE, query_id INTEGER REFERENCES ranking_queries(id) ON DELETE SET NULL, salon_name TEXT NOT NULL, area_label TEXT, service_area_cd TEXT NOT NULL, middle_area_cd TEXT, small_area_cd TEXT, keyword TEXT NOT NULL, rank INTEGER, result_count INTEGER, pages_scanned INTEGER, matched_sln_id TEXT, status TEXT NOT NULL DEFAULT 'ok', error_message TEXT, measured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS idx_ranking_results_user_id ON ranking_results(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ranking_results_query_id ON ranking_results(query_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ranking_results_user_measured ON ranking_results(user_id, measured_at)`,
      `CREATE TABLE IF NOT EXISTS ranking_schedules (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0, frequency TEXT NOT NULL DEFAULT 'daily', run_time TEXT, last_run_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`
    ]
    for (const ddl of rankingDdl) {
      await bindings.DB.prepare(ddl).run()
    }
  } catch (err) {
    console.error('起動時マイグレーション(検索順位計測テーブル)に失敗しました:', err)
  }
  try {
    // 2026-08-12追記: プロキシが少数(実測5個)の専用固定IPプールであることが
    // 判明したため、単一の「直近成功セッション」だけを覚える方式(0005)から、
    // プール内の各セッションIDごとに連続障害回数を記録し、その時点で最も
    // 調子の良いものを選ぶ方式に変更した(詳細はmigrations-pg/0006_*.sql参照)。
    await bindings.DB.prepare(
      `CREATE TABLE IF NOT EXISTS proxy_session_pool_stats (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL,
         session_id TEXT NOT NULL,
         consecutive_fail_count INTEGER NOT NULL DEFAULT 0,
         last_result TEXT,
         last_used_at TIMESTAMP,
         UNIQUE(user_id, session_id)
       )`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(proxy_session_pool_stats)に失敗しました:', err)
  }
  try {
    // テンプレート作成・適用画面にも担当スタイリスト欄を追加するための拡張列
    // (詳細はmigrations-pg/0007_*.sql参照)。
    await bindings.DB.prepare(
      `ALTER TABLE templates ADD COLUMN IF NOT EXISTS stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(templates.stylist_id)に失敗しました:', err)
  }
  try {
    // 管理者サイト(/admin)用: サロン側のusers/認証とは完全に分離した
    // 管理者アカウントテーブル、および操作ログテーブル(詳細はmigrations-pg/0008_*.sql参照)。
    await bindings.DB.prepare(
      `CREATE TABLE IF NOT EXISTS admin_users (
         id SERIAL PRIMARY KEY,
         email TEXT UNIQUE NOT NULL,
         password_hash TEXT NOT NULL,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    ).run()
    await bindings.DB.prepare(
      `CREATE TABLE IF NOT EXISTS admin_audit_logs (
         id SERIAL PRIMARY KEY,
         admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
         action TEXT NOT NULL,
         target_type TEXT,
         target_id INTEGER,
         detail TEXT,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(admin_users/admin_audit_logs)に失敗しました:', err)
  }
  try {
    // 管理者サイトの契約状況・機能オンオフ制御用の列(詳細はmigrations-pg/0008_*.sql参照)。
    await bindings.DB.prepare(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1`).run()
    await bindings.DB.prepare(`ALTER TABLE users ADD COLUMN IF NOT EXISTS style_enabled INTEGER NOT NULL DEFAULT 1`).run()
    await bindings.DB.prepare(`ALTER TABLE users ADD COLUMN IF NOT EXISTS blog_enabled INTEGER NOT NULL DEFAULT 1`).run()
    await bindings.DB.prepare(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS consecutive_failure_count INTEGER NOT NULL DEFAULT 0`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(users.is_active等)に失敗しました:', err)
  }
  try {
    // 初期管理者アカウントのシード。admin_usersが空の場合のみ、
    // ADMIN_INITIAL_PASSWORD(環境変数)をハッシュ化して1件だけ投入する。
    // コード内に平文パスワードをハードコードしないための仕組み。
    const existingAdminCount = await bindings.DB.prepare('SELECT COUNT(*) as cnt FROM admin_users').first<{
      cnt: number
    }>()
    if ((existingAdminCount?.cnt ?? 0) === 0) {
      if (!bindings.ADMIN_INITIAL_PASSWORD) {
        console.error(
          '初期管理者アカウントを作成できません: ADMIN_INITIAL_PASSWORDが未設定です。設定後に再起動してください。'
        )
      } else {
        const passwordHash = await hashPassword(bindings.ADMIN_INITIAL_PASSWORD)
        await bindings.DB.prepare('INSERT INTO admin_users (email, password_hash) VALUES (?, ?)')
          .bind('inc.tete@gmail.com', passwordHash)
          .run()
      }
    }
  } catch (err) {
    console.error('起動時シード(初期管理者アカウント)に失敗しました:', err)
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
// rankingもdashboard/style/blogより先にマウントする。
// ranking内の /api/cron/run-ranking は外部Cronから CRON_SECRET のみで
// 呼ばれる想定でセッションCookieを持たないため、dashboard/style/blogの
// .use('*', requireAuth) に先に捕まらないよう、それらより前に置く
// (automationと同じ理由。ranking自体はブランケットの'*'を持たず、認証が
// 必要なページは各ルートで requireAuth を付けている)。
app.route('/', ranking)
app.route('/', dashboard)
app.route('/', style)
app.route('/', blog)
// adminはサロン側('*')ミドルウェアを持つdashboard/style/blogとパスが
// 重ならない(/admin配下のみ)ため、マウント順は問題にならない。
app.route('/', admin)

export default app
