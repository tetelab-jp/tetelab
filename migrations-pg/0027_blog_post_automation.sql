-- ブログ記事のSALON BOARDへの実自動投稿(Phase 2)。style_post_schedules/
-- style_post_runs/style_post_jobsと同じ設計方針(手動実行/外部Cronからの
-- ジョブ投入→AWS ECS Fargateワーカーが実際にPuppeteerでログイン・投稿→
-- 結果コールバック)。実際のCREATE TABLEはsrc/index.tsxの起動時
-- マイグレーションで実行される。このファイルは記録用。

CREATE TABLE IF NOT EXISTS blog_post_schedules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  next_cursor_article_id INTEGER,
  paused_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(salon_id)
);

CREATE TABLE IF NOT EXISTS blog_post_runs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE,
  scheduled_time TEXT,
  total_articles INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processing',
  error_message TEXT,
  executed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blog_post_jobs (
  id SERIAL PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES blog_articles(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES blog_post_runs(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE,
  job_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',
  ecs_task_arn TEXT,
  result_step TEXT,
  result_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_post_jobs_one_in_flight_per_article
  ON blog_post_jobs (article_id) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_blog_post_jobs_user_id ON blog_post_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_blog_post_jobs_status ON blog_post_jobs(status);

ALTER TABLE users ADD COLUMN IF NOT EXISTS consecutive_blog_failure_count INTEGER NOT NULL DEFAULT 0;
