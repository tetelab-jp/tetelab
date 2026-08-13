-- [2026-08-14: このルールはユーザー指示により撤廃された。関連列の削除は
-- 0017_remove_style_retry_once.sqlを参照。このファイルは撤廃前の記録として残す]
--
-- エラーが出たスタイルを「次のスタイルの次」に1回だけ自動で再トライする
-- ルール(2026-08-14、ユーザー指定・現在は撤廃済み):
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

-- このジョブが上記の「1回だけの自動再トライ」由来かを記録する列。
-- 再トライ由来のジョブが失敗しても、さらに新たな再トライを予約しない
-- ようにするためのガードに使う(そうしないと無限ループになる)。
ALTER TABLE style_post_jobs ADD COLUMN IF NOT EXISTS is_retry INTEGER NOT NULL DEFAULT 0;

-- コードレビューで検出(2026-08-14): 「1スタイルにつき進行中ジョブは
-- 同時に1件まで」という制約がアプリ側のチェックのみに依存しており、
-- 手動実行・自動巡回・再実行ボタンがほぼ同時に走った場合にすり抜けて
-- 二重投稿になりうる不具合があった。DB側にも制約を持たせる。
CREATE UNIQUE INDEX IF NOT EXISTS idx_style_post_jobs_one_in_flight_per_style
  ON style_post_jobs (style_id) WHERE status IN ('pending', 'running');
