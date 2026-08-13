-- 2026-08-14: 「エラーが出たスタイルを次のスタイルの次に1回だけ自動で
-- 再トライする」ルール(0015_style_retry_once.sqlで導入)をユーザー指示に
-- より撤廃する。関連する列を削除する。
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーション(ALTER TABLE ... DROP
-- COLUMN IF EXISTS)で行われる。このファイルはスキーマ変更の記録用。
--
-- なお、0015で追加したidx_style_post_jobs_one_in_flight_per_style(1スタイル
-- につき進行中ジョブは同時に1件までの制約)は再トライルールとは無関係の
-- 独立したバグ修正のため、撤廃対象に含めない。

ALTER TABLE style_post_schedules DROP COLUMN IF EXISTS retry_pending_style_id;
ALTER TABLE style_post_schedules DROP COLUMN IF EXISTS retry_pending_wait_slots;
ALTER TABLE style_post_jobs DROP COLUMN IF EXISTS is_retry;
