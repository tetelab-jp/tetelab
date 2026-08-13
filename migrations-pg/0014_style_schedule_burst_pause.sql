-- 自動投稿ルールの全面刷新(2026-08-13、ユーザー指定):
-- ・深夜2:00〜7:00は投稿しない
-- ・OFF→ONにした瞬間、動作確認のため登録順の先頭3件を連続投稿する
--   「初回バースト」を行う(burst_remaining)。ON→OFF→ONで再度ONに
--   した場合も先頭3件から再度バーストする。
-- ・初回バースト後は60分おきに1件、登録順に巡回して投稿する
--   (next_cursor_style_id。最後まで行ったら先頭に戻る)
-- ・5件連続で投稿が失敗した場合、5時間は投稿を停止する(paused_until)
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーション(ALTER TABLE ... IF NOT
-- EXISTS)で行われる。このファイルはスキーマ変更の記録用。

ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS burst_remaining INTEGER NOT NULL DEFAULT 0;
ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS next_cursor_style_id INTEGER;
ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS paused_until TIMESTAMP;
