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
import { backfillCompressStyleImages } from './lib/style-image-backfill'
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
  AWS_REGION: process.env.AWS_REGION,
  ECS_CLUSTER: process.env.ECS_CLUSTER,
  ECS_TASK_DEFINITION: process.env.ECS_TASK_DEFINITION,
  ECS_CONTAINER_NAME: process.env.ECS_CONTAINER_NAME,
  ECS_SUBNET_IDS: process.env.ECS_SUBNET_IDS,
  ECS_SECURITY_GROUP_IDS: process.env.ECS_SECURITY_GROUP_IDS,
  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
  ADMIN_INITIAL_PASSWORD: process.env.ADMIN_INITIAL_PASSWORD,
  SNS_ALERT_TOPIC_ARN: process.env.SNS_ALERT_TOPIC_ARN
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
    // 2026-08-13追記(監査指摘の是正): 管理者ログインが破られると、なりすまし
    // 機能(admin.tsx)経由で全サロンを乗っ取れてしまうため、サロン側同様
    // ブルートフォース対策を追加する。
    await bindings.DB.prepare(
      `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0`
    ).run()
    await bindings.DB.prepare(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS login_locked_until TIMESTAMP`).run()
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
    // 2026-08-13追記(監査指摘の是正): /login・/adminにブルートフォース対策
    // (レート制限・アカウントロック)が一切無かったため追加する。
    await bindings.DB.prepare(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER NOT NULL DEFAULT 0`
    ).run()
    await bindings.DB.prepare(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_locked_until TIMESTAMP`).run()
    // 2026-08-12追記: 新規登録時、スタイル/ブログの自動投稿機能は管理者サイト
    // (/admin/tool)で有効化するまで使わせない運用に変更したため、列自体の既定値も
    // OFFへ変更する(新規登録時のINSERT文でも明示的に0を指定済みだが、念のため
    // 列のDEFAULTもここで揃えておく。既存行の値は変更しない)。
    await bindings.DB.prepare(`ALTER TABLE users ALTER COLUMN style_enabled SET DEFAULT 0`).run()
    await bindings.DB.prepare(`ALTER TABLE users ALTER COLUMN blog_enabled SET DEFAULT 0`).run()
    // SEO機能(/seo、フリーワード対策)用。新規登録サロンはstyle_enabled/blog_enabledと
    // 同様に管理者サイト(/admin/tool)で有効化するまで使わせない運用のためDEFAULT 0。
    // ただし、この列を追加する時点で既にフリーワード対策機能は全サロンへ提供済み
    // (docs/freeword-seo-handoff.md参照)だったため、列追加(=既存行が一律DEFAULT値で
    // 埋まる)によって既存サロン全員が意図せずOFFになってしまう。そのため列追加直後
    // (一度限り)だけ、既存行を一括で有効化する補正を行う。
    //
    // 2026-08-13追記(重大バグ修正): 当初は「1件も有効なサロンがいない」ことを
    // 条件にしていたが、これだと将来管理者が全サロンを意図的にOFFにした場合、
    // 次回デプロイ・再起動のたびにこの条件が再び成立し、全サロンのSEO機能が
    // 意図せず再ONになってしまう。実施済みかどうかを専用フラグテーブルで
    // 記録し、二度と再実行されないようにする。
    await bindings.DB.prepare(
      `CREATE TABLE IF NOT EXISTS schema_migration_flags (
         flag_key TEXT PRIMARY KEY,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    ).run()
    await bindings.DB.prepare(`ALTER TABLE users ADD COLUMN IF NOT EXISTS seo_enabled INTEGER NOT NULL DEFAULT 0`).run()
    const seoBackfillDone = await bindings.DB.prepare(
      `SELECT 1 FROM schema_migration_flags WHERE flag_key = 'seo_enabled_backfill'`
    ).first()
    if (!seoBackfillDone) {
      const totalUsersRow = await bindings.DB.prepare('SELECT COUNT(*) as cnt FROM users').first<{ cnt: number }>()
      if ((totalUsersRow?.cnt ?? 0) > 0) {
        await bindings.DB.prepare('UPDATE users SET seo_enabled = 1').run()
      }
      await bindings.DB.prepare(
        `INSERT INTO schema_migration_flags (flag_key) VALUES ('seo_enabled_backfill') ON CONFLICT (flag_key) DO NOTHING`
      ).run()
    }
  } catch (err) {
    console.error('起動時マイグレーション(users.is_active等)に失敗しました:', err)
  }
  try {
    // フリーワード対策のエリア(中/小)は手動選択ではなく、サロン自身のHPB公開
    // ページを読み取って自動検出する方式に変更(詳細はmigrations-pg/0011_*.sql参照)。
    // 全国エリアを一括クロールしていたエリアマスター(ranking_areas)は不要になった。
    await bindings.DB.prepare(`ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS service_area_cd TEXT`).run()
    await bindings.DB.prepare(`ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS middle_area_cd TEXT`).run()
    await bindings.DB.prepare(`ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS middle_area_name TEXT`).run()
    await bindings.DB.prepare(`ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS small_area_cd TEXT`).run()
    await bindings.DB.prepare(`ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS small_area_name TEXT`).run()
    await bindings.DB.prepare(`ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS area_synced_at TIMESTAMP`).run()
    await bindings.DB.prepare(`DROP TABLE IF EXISTS ranking_areas`).run()
  } catch (err) {
    console.error('起動時マイグレーション(salonboard_salonsエリア列)に失敗しました:', err)
  }
  try {
    // 順位測定は毎回、中エリア(絞り込み無し)と小エリア(絞り込み有り)の両方を
    // 別々に計測するようにしたため、どちらの計測かを区別する列を追加する
    // (詳細はmigrations-pg/0012_*.sql参照)。既存行は旧仕様(小エリアありきの
    // 単一計測)だったため既定値'small'とする。
    await bindings.DB.prepare(
      `ALTER TABLE ranking_results ADD COLUMN IF NOT EXISTS area_scope TEXT NOT NULL DEFAULT 'small'`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(ranking_results.area_scope)に失敗しました:', err)
  }
  try {
    // スタイル画像の保存前圧縮(image-process.ts)導入に伴い、既に圧縮済みかを
    // 記録する列を追加する。NULLの行は起動完了後にbackfillCompressStyleImages()
    // が一度だけ再圧縮する(詳細はmigrations-pg/0013_*.sql参照)。
    await bindings.DB.prepare(`ALTER TABLE style_images ADD COLUMN IF NOT EXISTS compressed_at TIMESTAMP`).run()
  } catch (err) {
    console.error('起動時マイグレーション(style_images.compressed_at)に失敗しました:', err)
  }
  try {
    // 自動投稿ルールの全面刷新(ユーザー指定、詳細はmigrations-pg/0014_*.sql参照):
    // ・burst_remaining: OFF→ON直後、動作確認のため先頭3件を連続投稿する
    //   「初回バースト」の残り件数
    // ・next_cursor_style_id: 通常運転(60分おきに1件)で、登録順に巡回する
    //   ための「最後にこの次から投稿した」位置
    // ・paused_until: 5件連続失敗時、自動投稿を一時停止する解除予定時刻
    await bindings.DB.prepare(
      `ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS burst_remaining INTEGER NOT NULL DEFAULT 0`
    ).run()
    await bindings.DB.prepare(
      `ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS next_cursor_style_id INTEGER`
    ).run()
    await bindings.DB.prepare(`ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS paused_until TIMESTAMP`).run()
  } catch (err) {
    console.error('起動時マイグレーション(style_post_schedules拡張列)に失敗しました:', err)
  }
  try {
    // 2026-08-14追記: 「エラーが出たスタイルを次のスタイルの次に1回だけ
    // 自動で再トライする」ルールはユーザー指示により撤廃した。運用中の
    // 環境に残っている旧列(retry_pending_style_id/retry_pending_wait_slots/
    // is_retry)を削除する(詳細はmigrations-pg/0017_*.sql参照)。
    await bindings.DB.prepare(`ALTER TABLE style_post_schedules DROP COLUMN IF EXISTS retry_pending_style_id`).run()
    await bindings.DB.prepare(`ALTER TABLE style_post_schedules DROP COLUMN IF EXISTS retry_pending_wait_slots`).run()
    await bindings.DB.prepare(`ALTER TABLE style_post_jobs DROP COLUMN IF EXISTS is_retry`).run()
  } catch (err) {
    console.error('起動時マイグレーション(再トライルール撤廃・旧列削除)に失敗しました:', err)
  }
  try {
    // 2026-08-14再追記(ユーザー指定ルール、詳細はmigrations-pg/0018_*.sql参照):
    // 60分おきの自動巡回で投稿に失敗したスタイルを、次の自動投稿タイミングに
    // 1回だけ再トライする機能を再導入する(前回の「次のスタイルの次に再トライ」
    // 版より単純化し、待ち枠(wait_slots)は廃止して即・次回に再トライする)。
    // is_auto_cycleは60分おきの自動巡回由来のジョブかを記録し、手動投稿
    // (テスト実行・個別再実行)の失敗からは再トライを予約しないようにする。
    await bindings.DB.prepare(
      `ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS retry_pending_style_id INTEGER`
    ).run()
    await bindings.DB.prepare(`ALTER TABLE style_post_jobs ADD COLUMN IF NOT EXISTS is_retry INTEGER NOT NULL DEFAULT 0`).run()
    await bindings.DB.prepare(
      `ALTER TABLE style_post_jobs ADD COLUMN IF NOT EXISTS is_auto_cycle INTEGER NOT NULL DEFAULT 0`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(自動巡回の再トライ機能再導入)に失敗しました:', err)
  }
  try {
    // 2026-08-14追記(重大バグ修正、詳細はmigrations-pg/0015_*.sql参照): 「1つの
    // スタイルに進行中(pending/running)ジョブは同時に1件まで」という制約は
    // これまでアプリ側のSELECT→INSERTという非アトミックなチェックのみに
    // 依存しており、DB側の裏付けが無かった。手動実行・自動巡回・再実行
    // ボタンが同じスタイルへほぼ同時にジョブを投入した場合、この制約を
    // すり抜けて二重投稿になりうる。部分ユニークインデックスでDB側にも
    // 制約を持たせ、最終防衛線とする。
    await bindings.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_style_post_jobs_one_in_flight_per_style
       ON style_post_jobs (style_id) WHERE status IN ('pending', 'running')`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(style_post_jobs一意インデックス)に失敗しました:', err)
  }
  try {
    // 2026-08-14追記: ブログ自動投稿機能の大幅リニューアル(Phase 1、詳細は
    // migrations-pg/0016_*.sql参照)。サロン基本情報(フッター差し込み用)・
    // 人格・書き方・フッター設定をsalon_profilesに追加する。
    const salonProfileColumns = [
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS address TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS nearest_station TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS walk_minutes TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS business_hours TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS closing_days TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS strengths TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS price_range TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS first_person TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS sentence_ending TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS emoji_style TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS footer_separator TEXT`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS footer_keywords_json TEXT DEFAULT '[]'`,
      `ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS salonboard_synced_at TIMESTAMP`
    ]
    for (const ddl of salonProfileColumns) {
      await bindings.DB.prepare(ddl).run()
    }
  } catch (err) {
    console.error('起動時マイグレーション(salon_profilesブログ拡張列)に失敗しました:', err)
  }
  try {
    // blog_categories: HPBカテゴリ・デフォルト投稿者・伝えたいこと・生成プロンプトを追加
    const blogCategoryColumns = [
      `ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS hpb_category_value TEXT`,
      `ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS default_stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL`,
      `ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS key_message TEXT`,
      `ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS title_prompt TEXT`,
      `ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS body_prompt TEXT`
    ]
    for (const ddl of blogCategoryColumns) {
      await bindings.DB.prepare(ddl).run()
    }
  } catch (err) {
    console.error('起動時マイグレーション(blog_categoriesブログ拡張列)に失敗しました:', err)
  }
  try {
    // 2026-08-14再追記(ユーザー指定): 「これまでのブログの書き方に寄せる」
    // チェックボックス(mimic_past_tone)は、実際には何も参照していなかったため
    // 撤廃する。代わりに、カテゴリ単位で「文章スタイル」(過去記事参照=未実装/
    // 参考文章参照/パラメータのみ)を選べるようにし、参考文章参照の材料として
    // salon_profiles.reference_textを追加する(詳細はmigrations-pg/0019_*.sql参照)。
    await bindings.DB.prepare(`ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS reference_text TEXT`).run()
    await bindings.DB.prepare(`ALTER TABLE salon_profiles DROP COLUMN IF EXISTS mimic_past_tone`).run()
    await bindings.DB.prepare(
      `ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS style_mode TEXT NOT NULL DEFAULT 'params'`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(ブログ文章スタイル選択機能)に失敗しました:', err)
  }
  try {
    // blog_articles: 新設。汎用のpostsテーブルは画像・承認・カテゴリ関連のFKが無く
    // 後付けするより新設した方が素直なため、styles/style_imagesと同じ設計方針で作る。
    await bindings.DB.prepare(
      `CREATE TABLE IF NOT EXISTS blog_articles (
         id SERIAL PRIMARY KEY,
         user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         category_id INTEGER REFERENCES blog_categories(id) ON DELETE SET NULL,
         image_r2_key TEXT,
         image_file_name TEXT,
         image_description TEXT,
         title TEXT,
         body TEXT,
         coupon_id INTEGER REFERENCES coupons(id) ON DELETE SET NULL,
         stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL,
         month_tags_json TEXT DEFAULT '[]',
         sort_order INTEGER NOT NULL DEFAULT 0,
         status TEXT NOT NULL DEFAULT 'pending_generation',
         last_error TEXT,
         approved_at TIMESTAMP,
         last_posted_at TIMESTAMP,
         post_count INTEGER NOT NULL DEFAULT 0,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    ).run()
    await bindings.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_blog_articles_user_id ON blog_articles(user_id)`).run()
    await bindings.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_blog_articles_category_id ON blog_articles(category_id)`).run()
    await bindings.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_blog_articles_user_status ON blog_articles(user_id, status)`).run()
  } catch (err) {
    console.error('起動時マイグレーション(blog_articles)に失敗しました:', err)
  }
  try {
    // 2026-08-14再追記(ユーザー指定): スタイルのauto_post_enabled_flagと同様、
    // 記事単位で自動投稿の対象/対象外を切り替えられるようにする。
    await bindings.DB.prepare(
      `ALTER TABLE blog_articles ADD COLUMN IF NOT EXISTS auto_post_enabled_flag INTEGER NOT NULL DEFAULT 1`
    ).run()
  } catch (err) {
    console.error('起動時マイグレーション(blog_articles.auto_post_enabled_flag)に失敗しました:', err)
  }
  try {
    // 2026-08-14(ユーザー指定): サロンボードの1ログインに複数サロン(ヘア/キレイ)が
    // 紐づくアカウント対応。ユーザーが選択した(または単一サロンのため自動確定した)
    // STORE_IDと、サロン種別(ヘア/キレイ)を保持する。
    await bindings.DB.prepare(`ALTER TABLE salon_credentials ADD COLUMN IF NOT EXISTS target_store_id TEXT`).run()
    await bindings.DB.prepare(`ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS salon_type TEXT`).run()
  } catch (err) {
    console.error('起動時マイグレーション(salon_credentials.target_store_id等)に失敗しました:', err)
  }
  try {
    // 2026-08-14再追記(ユーザー指定・複数サロンワークスペース対応 フェーズ0):
    // 「追加契約すれば複数サロンをこのアプリで使え、サロン切り替えボタンで
    // スタイル・クーポン・スタイリスト・ブログ・順位測定等のデータを完全に
    // 別々に切り替えられる」機能の土台。salonboard_salons(既存の複数サロン
    // 一覧テーブル)を「サロンワークスペース」の主エンティティに昇格させ、
    // 業務データ全テーブルにsalon_idを追加する。この時点ではまだ挙動を
    // 一切変えない(salon_idは書き込まれるが、クエリはまだuser_idのみで
    // 動作し続ける。読み取りへの適用は後続の各ルート改修フェーズで行う)。
    await bindings.DB.prepare(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS salon_slot_limit INTEGER NOT NULL DEFAULT 1`
    ).run()
    await bindings.DB.prepare(
      `ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS is_active_workspace INTEGER NOT NULL DEFAULT 0`
    ).run()
    await bindings.DB.prepare(`ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP`).run()
    // active_salon_idはsalonboard_salons.idを参照するため、salonboard_salons側の
    // 列追加より後に実行する必要がある(参照先テーブルの列が先に存在すること自体は
    // 元々満たしているが、依存関係を明示するためこの位置に置く)。
    await bindings.DB.prepare(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS active_salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE SET NULL`
    ).run()

    const salonIdTables = [
      'styles',
      'stylists',
      'coupons',
      'templates',
      'posts',
      'execution_logs',
      'batch_template_apply_logs',
      'salon_profiles',
      'style_post_schedules',
      'style_post_runs',
      'style_post_jobs',
      'blog_categories',
      'blog_articles',
      'ranking_queries',
      'ranking_runs',
      'ranking_results',
      'ranking_schedules'
    ]
    for (const table of salonIdTables) {
      await bindings.DB.prepare(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE`
      ).run()
      await bindings.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_${table}_salon_id ON ${table}(salon_id)`).run()
    }
  } catch (err) {
    console.error('起動時マイグレーション(複数サロンワークスペース フェーズ0: salon_id列追加)に失敗しました:', err)
  }
  try {
    // 複数サロンワークスペース対応 フェーズ0: 既存データのバックフィル。
    // 既存ユーザーは全員「実質1サロンだけ使っている」状態なので機械的に
    // 決定できる。一度きりの実行をschema_migration_flagsで保証する
    // (seo_enabled_backfillと同じパターン)。
    const workspaceBackfillDone = await bindings.DB.prepare(
      `SELECT 1 FROM schema_migration_flags WHERE flag_key = 'salon_workspace_backfill_v1'`
    ).first()
    if (!workspaceBackfillDone) {
      // 1. まだsalonboard_salonsに1行も持たない(一度も同期していない)ユーザーに
      //    プレースホルダー行を作成する。salon_key=NULLなので、後日実際に同期
      //    すると upsertSalonInfo() の「salon_key一致→無ければsalon_name一致」
      //    フォールバックでこの行にUPDATEされる(新規行は増えない)。
      await bindings.DB.prepare(
        `INSERT INTO salonboard_salons (user_id, salon_key, salon_name, is_active_workspace, activated_at)
         SELECT u.id, NULL, COALESCE(u.salon_name, '(未設定)'), 1, CURRENT_TIMESTAMP
         FROM users u
         WHERE NOT EXISTS (SELECT 1 FROM salonboard_salons s WHERE s.user_id = u.id)`
      ).run()

      // 2. salonboard_salonsが1行だけのユーザーは、その行を有効なワークスペースにする。
      await bindings.DB.prepare(
        `UPDATE salonboard_salons s SET is_active_workspace = 1, activated_at = COALESCE(s.activated_at, CURRENT_TIMESTAMP)
         WHERE s.is_active_workspace = 0
           AND (SELECT COUNT(*) FROM salonboard_salons s2 WHERE s2.user_id = s.user_id) = 1`
      ).run()

      // 3. 既に複数行ある(複数サロン選択機能を経験済みの)ユーザーは、
      //    salon_credentials.target_store_idと一致する行を有効なワークスペースにする。
      await bindings.DB.prepare(
        `UPDATE salonboard_salons s SET is_active_workspace = 1, activated_at = COALESCE(s.activated_at, CURRENT_TIMESTAMP)
         FROM salon_credentials c
         WHERE c.user_id = s.user_id AND c.target_store_id IS NOT NULL AND c.target_store_id = s.salon_key
           AND s.is_active_workspace = 0`
      ).run()

      // 4. users.active_salon_idを、有効化されたワークスペースのidに確定する。
      //    (中間ページでの選択が未完了のまま複数行だけ持つ極めて稀なケースは、
      //    有効な行が無いためactive_salon_idはNULLのまま=このユーザーは元々
      //    同期も自動投稿も出来ていなかったはずなので、既存動作に対する後退はない)
      await bindings.DB.prepare(
        `UPDATE users u SET active_salon_id = s.id
         FROM salonboard_salons s
         WHERE s.user_id = u.id AND s.is_active_workspace = 1 AND u.active_salon_id IS NULL`
      ).run()

      // 5. 業務データ全テーブルへsalon_idをバックフィルする。この時点で各ユーザーの
      //    active_salon_idは高々1つなので紐付けに曖昧さはない。
      const backfillTables = [
        'styles',
        'stylists',
        'coupons',
        'templates',
        'posts',
        'execution_logs',
        'batch_template_apply_logs',
        'salon_profiles',
        'style_post_schedules',
        'style_post_runs',
        'style_post_jobs',
        'blog_categories',
        'blog_articles',
        'ranking_queries',
        'ranking_runs',
        'ranking_results',
        'ranking_schedules'
      ]
      for (const table of backfillTables) {
        await bindings.DB.prepare(
          `UPDATE ${table} t SET salon_id = u.active_salon_id
           FROM users u
           WHERE t.user_id = u.id AND t.salon_id IS NULL AND u.active_salon_id IS NOT NULL`
        ).run()
      }

      await bindings.DB.prepare(
        `INSERT INTO schema_migration_flags (flag_key) VALUES ('salon_workspace_backfill_v1') ON CONFLICT (flag_key) DO NOTHING`
      ).run()
    }
  } catch (err) {
    console.error('起動時マイグレーション(複数サロンワークスペース フェーズ0: バックフィル)に失敗しました:', err)
  }
  try {
    // 複数サロンワークスペース対応 フェーズ5仕上げ: salon_profiles / style_post_schedules /
    // ranking_schedules は元々「1 user_id = 1行」前提のUNIQUE(user_id)制約を持っていた。
    // 2サロン目を有効化しても、アプリ側の(user_id, salon_id)存在チェック後のINSERTが
    // この制約に阻まれて失敗する(2サロン目のプロフィール/スケジュール保存が常に
    // 失敗するバグ)ため、バックフィル完了後の今、UNIQUE(user_id)をUNIQUE(salon_id)へ
    // 差し替える(1物理サロンにつき1行、という制約に置き換わるだけで意味は保たれる)。
    const uniqueSalonIdTables = ['salon_profiles', 'style_post_schedules', 'ranking_schedules']
    for (const table of uniqueSalonIdTables) {
      await bindings.DB.prepare(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_user_id_key`).run()
      await bindings.DB.prepare(
        `DO $$ BEGIN
           ALTER TABLE ${table} ADD CONSTRAINT ${table}_salon_id_key UNIQUE (salon_id);
         EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
         END $$;`
      ).run()
    }
  } catch (err) {
    console.error('起動時マイグレーション(複数サロンワークスペース: user_id→salon_id UNIQUE制約差替)に失敗しました:', err)
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
})().then(() => {
  // 起動時マイグレーション(compressed_at列の追加を含む)完了後、非同期・
  // 非ブロッキングで未圧縮の既存スタイル画像を一度だけ再圧縮する。
  // サーバー起動(ヘルスチェック応答)はこの完了を待たない。
  void backfillCompressStyleImages(bindings).catch((err) => {
    console.error('起動時バックフィル(style_images圧縮)に失敗しました:', err)
  })
})

app.use('*', async (c, next) => {
  c.env = bindings
  await next()
})

app.use(renderer)

// トップページ: ログイン状態に応じてリダイレクト
app.get('/', async (c) => {
  const token = getCookie(c, SESSION_COOKIE_NAME)
  const secret = c.env.JWT_SECRET
  if (token && secret && (await verifyJwt(token, secret))) {
    return c.redirect('/dashboard')
  }
  return c.redirect('/login')
})

// 2026-08-12追記(重大バグ修正の経緯): 全サブアプリが同じベースパス('/')に
// app.route()マウントされているため、あるサブアプリがミドルウェアを'*'で
// 登録すると、そのサブアプリに存在しないパスに対してもミドルウェアが先に
// 反応し、後続にマウントされる別のサブアプリへのリクエストを乗っ取って
// しまう(subApp内で該当パスにルートが無くても'*'ミドルウェアが先に
// 401/redirectを返してしまい、後続のsubAppへフォールスルーしない)。
// 実機で「/admin配下が、無関係なはずのdashboard/style/blog側の認証/機能
// チェックに巻き込まれて意図せずリダイレクトされる」不具合として発現した。
// 対策は二重にしている:
//   (1) dashboard/style/blog側のミドルウェアを'*'ではなく自分の実際のパス
//       パターン(/style/*, /blog/*, /settings/*等)だけに限定した(各routes
//       ファイル側で対応済み、根本的な対策)。
//   (2) 念のための保険として、adminをdashboard/style/blogより先にマウントする。
//       admin配下(/admin/*)へのリクエストは、dashboard/style/blogの
//       ミドルウェアが評価される前にadmin自身のルーターで先に処理される
//       ため、(1)の対応に将来漏れがあっても admin 側が巻き込まれない。
// automationも同じ理由でdashboard/style/blogより先にマウントする
// (/api/cron/run-style-posts は外部Cronから CRON_SECRET のみで呼ばれる
// ため、セッションCookie無しでも到達できる必要がある)。
app.route('/', auth)
app.route('/', admin)
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

export default app
