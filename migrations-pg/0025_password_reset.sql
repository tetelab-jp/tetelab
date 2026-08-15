-- パスワード再設定(メールリンク方式)用のカラムを追加する。
-- 生トークンはメールにのみ載せ、DBにはSHA-256ハッシュだけを保存する
-- (src/lib/crypto.tsのgeneratePasswordResetToken/hashPasswordResetToken、
-- src/routes/auth.tsxの/forgot-password・/reset-password参照)。
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーションで行われる。このファイルは
-- スキーマ変更の記録用。

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMP;
