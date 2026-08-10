-- ============================================
-- 0001_init.sql (PostgreSQL版)
--
-- Cloudflare D1(SQLite)から実際に取得した最終スキーマ(migrations/0001〜0007
-- 適用後の状態)を、PostgreSQLの最終形として直接作成する。D1の増分マイグレ
-- ーション(RENAME/DROP等)は再現せず、最終的なテーブル定義のみを持つ。
--
-- 型の対応方針:
--   INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
--   DATETIME                          → TIMESTAMP (アプリ側はUTCの
--                                        "YYYY-MM-DD HH:MM:SS"文字列を前提に
--                                        しているため、接続時にセッション
--                                        タイムゾーンをUTCへ固定している
--                                        (src/lib/db.ts)。TIMESTAMPTZは使わない)
--   INTEGER(真偽値フラグ)              → INTEGER のまま(0/1)。アプリコードが
--                                        `=== 1` / `? 1 : 0` で扱っているため
--                                        BOOLEAN化はしない
--   TEXT(JSON文字列カラム)             → TEXT のまま。アプリ側でJSON.stringify/
--                                        parseするのみでJSON1拡張関数は未使用
-- ============================================

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salon_name TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_users_email ON users(email);

CREATE TABLE salon_credentials (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  salonboard_login_id_enc TEXT NOT NULL,
  salonboard_password_enc TEXT NOT NULL,
  consent_given INTEGER NOT NULL DEFAULT 0,
  consent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  connection_status TEXT NOT NULL DEFAULT 'not_started',
  sync_paused_flag INTEGER NOT NULL DEFAULT 0,
  last_stylist_synced_at TIMESTAMP,
  last_coupon_synced_at TIMESTAMP,
  last_style_imported_at TIMESTAMP,
  last_error TEXT
);

CREATE TABLE blog_categories (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE coupons (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  salonboard_coupon_key TEXT
);

CREATE TABLE salon_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  concept TEXT,
  target_customer TEXT,
  writing_tone TEXT,
  ng_words TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE stylists (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  salonboard_stylist_key TEXT
);

CREATE TABLE templates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_name TEXT NOT NULL,
  title_template TEXT,
  comment_template TEXT,
  category_value TEXT,
  length_value TEXT,
  menu_values_json TEXT DEFAULT '[]',
  coupon_id INTEGER REFERENCES coupons(id) ON DELETE SET NULL,
  hashtags_json TEXT DEFAULT '[]',
  model_attributes_json TEXT DEFAULT '{}',
  active_flag INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  menu_detail_text TEXT
);
CREATE INDEX idx_templates_user_id ON templates(user_id);

CREATE TABLE styles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL,
  coupon_id INTEGER REFERENCES coupons(id) ON DELETE SET NULL,
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL DEFAULT 'manual',
  source_salonboard_style_key TEXT,
  title TEXT,
  comment TEXT,
  category_value TEXT,
  length_value TEXT,
  menu_values_json TEXT DEFAULT '[]',
  menu_detail_text TEXT,
  hashtags_json TEXT DEFAULT '[]',
  model_attributes_json TEXT DEFAULT '{}',
  auto_post_enabled_flag INTEGER NOT NULL DEFAULT 1,
  internal_save_status TEXT NOT NULL DEFAULT 'draft',
  salonboard_register_status TEXT NOT NULL DEFAULT 'not_started',
  reflection_request_status TEXT NOT NULL DEFAULT 'not_started',
  last_error TEXT,
  last_executed_at TIMESTAMP,
  sort_order INTEGER NOT NULL DEFAULT 0,
  pickup_flag INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_styles_user_id ON styles(user_id);
CREATE INDEX idx_styles_auto_post ON styles(user_id, auto_post_enabled_flag);

CREATE TABLE style_images (
  id SERIAL PRIMARY KEY,
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  image_role TEXT NOT NULL DEFAULT 'FRONT',
  r2_key TEXT NOT NULL,
  file_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_style_images_style_id ON style_images(style_id);

CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_type TEXT NOT NULL DEFAULT 'blog',
  title TEXT,
  content TEXT,
  image_keys TEXT,
  scheduled_at TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  executed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  author_name TEXT,
  category_name TEXT,
  coupon_name TEXT,
  image_r2_key TEXT
);
CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_status_scheduled ON posts(status, scheduled_at);

CREATE TABLE execution_logs (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  style_id INTEGER REFERENCES styles(id) ON DELETE CASCADE,
  execution_type TEXT,
  raw_response_text TEXT
);

CREATE TABLE batch_template_apply_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  applied_count INTEGER NOT NULL DEFAULT 0,
  target_style_ids_json TEXT NOT NULL,
  result_status TEXT NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE style_post_schedules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE style_post_runs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_time TEXT,
  total_images INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  executed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE style_post_jobs (
  id SERIAL PRIMARY KEY,
  style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  ecs_task_arn TEXT,
  result_step TEXT,
  result_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);
CREATE INDEX idx_style_post_jobs_user_id ON style_post_jobs(user_id);
CREATE INDEX idx_style_post_jobs_style_id ON style_post_jobs(style_id);
CREATE INDEX idx_style_post_jobs_status ON style_post_jobs(status);
