-- ============================================
-- 0007_style_post_jobs.sql
-- AWS ECS/Fargateワーカーへのジョブ発行・追跡用テーブル。
--
-- 背景: Cloudflare Browser Rendering(@cloudflare/puppeteer)には
-- ファイルシステムが無く、標準的なファイルアップロードAPIが使えないため、
-- SALON BOARD投稿の実行部分をAWS ECS+Fargate(Docker/Node Puppeteer)に
-- 切り出す。Cloudflare側は「ジョブを1件発行し、ECS RunTaskでタスクを
-- 起動し、タスクからの結果コールバックを待つ」役割に変わる。
-- job_token はタスク起動時にcontainerOverrides.environmentで渡す
-- 使い捨てのBearerトークンで、GET /api/automation/jobs/:id と
-- POST /api/automation/jobs/:id/result の両方の認証に使う。
-- ============================================

CREATE TABLE style_post_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  style_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  job_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | success | failed | blocked | timeout
  ecs_task_arn TEXT,
  result_step TEXT,       -- login | navigate | draft_register | image_upload | reflect | done
  result_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (style_id) REFERENCES styles(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_style_post_jobs_user_id ON style_post_jobs(user_id);
CREATE INDEX idx_style_post_jobs_style_id ON style_post_jobs(style_id);
CREATE INDEX idx_style_post_jobs_status ON style_post_jobs(status);
