-- エラーが出たスタイルを「次のスタイルの次」に1回だけ自動で再トライする
-- ルール(2026-08-14、ユーザー指定):
-- 例) No.1 エラー → No.2 投稿完了 or エラー(通常通り) → No.1 再投稿
-- 3回目の再トライは行わない(1回消費したら通常運転に戻す)。
--
-- retry_pending_style_id: 再トライ対象のスタイルID(NULLなら予約なし)
-- retry_pending_wait_slots: 再トライまでにあと何回、通常の巡回投稿を
--   挟む必要があるか(1=次の巡回を1回挟んでから再トライする)
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーション(ALTER TABLE ... IF NOT
-- EXISTS)で行われる。このファイルはスキーマ変更の記録用。

ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS retry_pending_style_id INTEGER;
ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS retry_pending_wait_slots INTEGER NOT NULL DEFAULT 0;
