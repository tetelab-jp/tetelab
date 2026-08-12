-- 管理者サイト(/admin)用のテーブル・列。実際のマイグレーション(および
-- 初期管理者アカウントのシード)はsrc/index.tsxの起動時IIFEで冪等に適用される。

-- サロン側のusers/認証とは完全に分離した管理者アカウントテーブル。
CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 管理者操作(契約状況・機能オンオフの変更、なりすましログイン等)の履歴。
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  detail TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- サロン(users)側: 契約状況・機能オンオフ・稼働状況判定用の連続失敗回数。
-- 既存サロンは全て既定値(有効)になる。
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS style_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blog_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS consecutive_failure_count INTEGER NOT NULL DEFAULT 0;
