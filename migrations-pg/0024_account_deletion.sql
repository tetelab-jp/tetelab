-- 管理者サイトからのサロン削除は即時実行ではなく、3日間の猶予期間を
-- 置く(deletion_requested_at)。猶予経過後の実削除はsrc/lib/account-deletion.tsの
-- sweepPendingDeletions()が、src/index.tsxのアプリ内タイマー(1時間毎)から実行する。
--
-- 2026-08-14追記(ユーザー指定): 削除操作はサロン単位に一本化した(アカウント
-- 単位の削除は撤廃)。一時的に追加していたusers側の同名カラムは削除する。
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーションで行われる。このファイルは
-- スキーマ変更の記録用。

ALTER TABLE users DROP COLUMN IF EXISTS deletion_requested_at;
ALTER TABLE users DROP COLUMN IF EXISTS deletion_requested_by_admin_id;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMP;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS deletion_requested_by_admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL;
