-- ============================================
-- 0002_style_and_blog_master.sql
-- スタイル投稿ライブラリ・ブログマスタ設定
-- （1ユーザー = 1サロン構成。すべて user_id に紐付ける）
-- ============================================

-- スタイル画像ライブラリ（事前に一括登録する画像プール）
CREATE TABLE IF NOT EXISTS style_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  r2_key TEXT NOT NULL,               -- Cloudflare R2 オブジェクトキー
  file_name TEXT,                     -- 元のファイル名
  title TEXT,                         -- スタイル名（サロンボードの「スタイル名」項目）
  category TEXT,                      -- レングス区分など（例: ミディアム）
  is_selected INTEGER NOT NULL DEFAULT 1, -- チェック状態（投稿対象かどうか）
  post_count INTEGER NOT NULL DEFAULT 0,  -- これまでに投稿された回数
  last_posted_at DATETIME,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_style_images_user_id ON style_images(user_id);
CREATE INDEX IF NOT EXISTS idx_style_images_selected ON style_images(user_id, is_selected);

-- スタイル投稿の自動実行スケジュール設定（1日何回・何時に実行するか）
CREATE TABLE IF NOT EXISTS style_post_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  times_per_day INTEGER NOT NULL DEFAULT 1,   -- 1日の実行回数
  run_times TEXT NOT NULL DEFAULT '["10:00"]', -- 実行時刻のJSON配列 例: ["09:00","13:00","18:00"]
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- スタイル投稿の実行履歴（1回の実行 = チェック済み画像すべてを投稿した記録）
CREATE TABLE IF NOT EXISTS style_post_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  scheduled_time TEXT,                -- どの実行時刻分か（例: "09:00"）
  total_images INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending / processing / done / failed
  error_message TEXT,
  executed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ブログマスタ設定：投稿者（スタイリスト）
CREATE TABLE IF NOT EXISTS blog_authors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,                 -- スタイリスト名
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ブログマスタ設定：カテゴリ
CREATE TABLE IF NOT EXISTS blog_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,                 -- 例: おすすめのスタイル
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ブログマスタ設定：クーポン
CREATE TABLE IF NOT EXISTS blog_coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,                 -- クーポン名
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ブログマスタ設定：サロンの基本情報（AI生成のコンテキストとして利用）
CREATE TABLE IF NOT EXISTS salon_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  concept TEXT,                       -- サロンのコンセプト・雰囲気
  target_customer TEXT,               -- ターゲット層
  writing_tone TEXT,                  -- 文体の指定（カジュアル/丁寧語/絵文字多用 等）
  ng_words TEXT,                       -- NGワード・避けたい表現
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- posts テーブルに author_name, category_name, coupon_name, image_r2_key を追加
ALTER TABLE posts ADD COLUMN author_name TEXT;
ALTER TABLE posts ADD COLUMN category_name TEXT;
ALTER TABLE posts ADD COLUMN coupon_name TEXT;
ALTER TABLE posts ADD COLUMN image_r2_key TEXT;
