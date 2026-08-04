-- ============================================
-- 0001_initial_schema.sql
-- サロンオーナー向け ホットペッパー自動化SaaS 初期スキーマ
-- ============================================

-- ユーザー（サロンオーナー）テーブル
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,      -- PBKDF2ハッシュ（salt含む "salt:hash" 形式）
  salon_name TEXT,                  -- サロン名（任意）
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- サロンボード（ホットペッパービューティー管理画面）ログイン情報
-- ID/Passは平文保存せず、AES-GCMで暗号化して保存する
CREATE TABLE IF NOT EXISTS salon_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  salonboard_login_id_enc TEXT NOT NULL,   -- 暗号化済みログインID (base64: iv+ciphertext)
  salonboard_password_enc TEXT NOT NULL,   -- 暗号化済みパスワード (base64: iv+ciphertext)
  consent_given INTEGER NOT NULL DEFAULT 0, -- 利用規約・ID/Pass委任への同意フラグ
  consent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 投稿予約（ブログ / スタイル投稿）
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  post_type TEXT NOT NULL DEFAULT 'blog',   -- 'blog' | 'style'
  title TEXT,
  content TEXT,
  image_keys TEXT,                          -- R2オブジェクトキーのJSON配列（スタイル写真用）
  scheduled_at DATETIME,                     -- 投稿予約日時
  status TEXT NOT NULL DEFAULT 'pending',    -- pending / processing / done / failed
  error_message TEXT,
  executed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_status_scheduled ON posts(status, scheduled_at);

-- 実行ログ（自動投稿ロボの実行結果）
CREATE TABLE IF NOT EXISTS execution_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,             -- success / failure
  message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
