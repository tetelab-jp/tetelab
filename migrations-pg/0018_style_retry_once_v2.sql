-- 60分おきの自動巡回で投稿に失敗したスタイルを、次の自動投稿タイミングに
-- 1回だけ再トライするルール(2026-08-14、ユーザー指定・再導入)。
--
-- 0015で導入し0017で撤廃した版との違い: 「次のスタイルの次」ではなく
-- 「次回の自動投稿タイミングに即」再トライする(待ち枠wait_slotsは廃止)。
-- また、手動投稿(テスト実行・個別再実行ボタン)の失敗からは再トライを
-- 予約しない(is_auto_cycleで自動巡回由来のジョブのみに限定する)。
--
-- retry_pending_style_id: 再トライ対象のスタイルID(NULLなら予約なし)
-- is_retry: このジョブが上記の再トライ由来かを記録する列
--   (再トライ由来のジョブがさらに失敗しても、新たな再トライを予約しない
--   ためのガードに使う。3回目の再トライを防ぐ)
-- is_auto_cycle: このジョブが60分おきの自動巡回(runNextStyleForUser)由来かを
--   記録する列。手動投稿の失敗からは再トライを予約しないためのガードに使う
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーション(ALTER TABLE ... ADD
-- COLUMN IF NOT EXISTS)で行われる。このファイルはスキーマ変更の記録用。

ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS retry_pending_style_id INTEGER;
ALTER TABLE style_post_jobs ADD COLUMN IF NOT EXISTS is_retry INTEGER NOT NULL DEFAULT 0;
ALTER TABLE style_post_jobs ADD COLUMN IF NOT EXISTS is_auto_cycle INTEGER NOT NULL DEFAULT 0;
