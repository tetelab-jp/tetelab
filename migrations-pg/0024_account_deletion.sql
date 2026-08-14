-- 管理者サイトからのアカウント/サロン削除は即時実行ではなく、3日間の猶予期間を
-- 置く(deletion_requested_at)。猶予経過後の実削除はsrc/lib/account-deletion.tsの
-- sweepPendingDeletions()が、src/index.tsxのアプリ内タイマー(1時間毎)から実行する。
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーションで行われる。このファイルは
-- スキーマ変更の記録用。

ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_by_admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMP;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS deletion_requested_by_admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL;
