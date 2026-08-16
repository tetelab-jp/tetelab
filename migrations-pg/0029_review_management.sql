-- 口コミ管理ツール。サロンボード口コミ一覧(担当スタイリスト・投稿日時)と
-- HPB公開口コミ一覧(評点・本文全文)を投稿日+本文冒頭で突合して蓄積する。
-- 詳細/返信ページ(reviewReply/)は使用しない。実際のCREATE TABLEは
-- src/index.tsxの起動時マイグレーションで実行される。このファイルは記録用。

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id INTEGER NOT NULL REFERENCES salonboard_salons(id) ON DELETE CASCADE,
  salonboard_review_key TEXT NOT NULL,
  posted_at TIMESTAMP,
  visited_at DATE,
  reservation_name TEXT,
  stylist_name_raw TEXT,
  stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL,
  reply_status TEXT,
  hpb_nickname TEXT,
  gender TEXT,
  age_group TEXT,
  attribute TEXT,
  menu_used TEXT,
  coupon_used TEXT,
  content TEXT,
  salon_reply_content TEXT,
  score_atmosphere SMALLINT,
  score_service SMALLINT,
  score_technique SMALLINT,
  score_menu_price SMALLINT,
  score_overall SMALLINT,
  matched_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(salon_id, salonboard_review_key)
);
CREATE INDEX IF NOT EXISTS idx_reviews_salon_posted ON reviews(salon_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_reviews_stylist_id ON reviews(stylist_id);
CREATE INDEX IF NOT EXISTS idx_reviews_unmatched ON reviews(salon_id) WHERE matched_at IS NULL;

CREATE TABLE IF NOT EXISTS review_sync_state (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id INTEGER NOT NULL REFERENCES salonboard_salons(id) ON DELETE CASCADE,
  backfill_completed_at TIMESTAMP,
  last_synced_review_key TEXT,
  last_incremental_sync_month TEXT,
  last_sync_run_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(salon_id)
);

CREATE TABLE IF NOT EXISTS review_sync_jobs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id INTEGER NOT NULL REFERENCES salonboard_salons(id) ON DELETE CASCADE,
  job_token TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'incremental',
  status TEXT NOT NULL DEFAULT 'pending',
  matched_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  ecs_task_arn TEXT,
  result_step TEXT,
  result_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_sync_jobs_one_in_flight_per_salon
  ON review_sync_jobs (salon_id) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_review_sync_jobs_user_id ON review_sync_jobs(user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS review_enabled INTEGER NOT NULL DEFAULT 0;
