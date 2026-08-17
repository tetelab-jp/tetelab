-- 口コミ自動返信機能。blog_post_schedules/blog_post_jobsと同じ設計方針
-- (口コミ1件=1ジョブ、AWS ECS Fargateワーカーが実際にPuppeteerで返信を
-- 投稿→結果コールバック)。実際のCREATE TABLEはsrc/index.tsxの起動時
-- マイグレーションで実行される。このファイルは記録用。
--
-- ルール(ユーザー指定):
--   ・自動返信の対象はHPB公開ページに掲載済み(matched_at IS NOT NULL)かつ
--     星4以上(score_overall >= 4)の口コミのみ。星3以下は対象外(手動または
--     AI生成→手動投稿のみ)。
--   ・詳細/返信ページ(reviewReply/{管理番号})は使わない設計だったreview_sync
--     とは異なり、返信投稿自体はこのページ(reviewReply/{管理番号})を使う
--     (SALON BOARD上、返信の投稿窓口はここにしか無いため)。

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply_content TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reply_method TEXT; -- 'auto' | 'manual'
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ai_reply_draft TEXT; -- 手動返信フロー用のAI生成下書き

CREATE TABLE IF NOT EXISTS review_reply_schedules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  paused_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(salon_id)
);

CREATE TABLE IF NOT EXISTS review_reply_jobs (
  id SERIAL PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE,
  job_token TEXT NOT NULL UNIQUE,
  trigger TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'manual'
  reply_content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  ecs_task_arn TEXT,
  result_step TEXT,
  result_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_reply_jobs_one_in_flight_per_review
  ON review_reply_jobs (review_id) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_review_reply_jobs_user_id ON review_reply_jobs(user_id);

-- 他の自動投稿(スタイル/ブログ)の連続失敗カウントとは独立させ、
-- 口コミ返信側の失敗がスタイル/ブログ側の一時停止に影響しないようにする。
ALTER TABLE users ADD COLUMN IF NOT EXISTS consecutive_review_reply_failure_count INTEGER NOT NULL DEFAULT 0;
