-- Bright Dataのプロキシが少数(実測5個)の専用固定IPプールであることが
-- 判明したため、単一の「直近成功セッション」だけを覚える方式(0005)から、
-- プール内の各セッションIDごとに連続障害回数を記録し、その時点で最も
-- 調子の良いもの(連続障害回数が最小のもの)を選ぶ方式に変更した。
-- 実際のマイグレーションはsrc/index.tsxの起動時IIFEで冪等に適用される。

CREATE TABLE IF NOT EXISTS proxy_session_pool_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  consecutive_fail_count INTEGER NOT NULL DEFAULT 0,
  last_result TEXT,
  last_used_at TIMESTAMP,
  UNIQUE(user_id, session_id)
);
